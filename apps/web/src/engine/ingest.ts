import type { CalendarEvent, CoffeeChat, EmailMessage, EmailThread, Person, User } from '@orbit/core';
import {
  addBusinessDays,
  detectOutOfOffice,
  emailDomain,
  heuristicSignal,
  heuristicTriage,
  isAutomatedSender,
  isAutoReply,
  isAutoReplyBody,
  isCalendarNotice,
  isRoleName,
  newId,
  normalizeEmail,
  parseAddress,
  parseName,
  parseReturnDate,
  splitSignature,
  stripDiacritics,
  stripQuotedReply,
} from '@orbit/core';
import { addTouchpoint, notify, recomputePersonStrength } from '../db/repo';
import { db } from '../db/schema';
import { llmEnabled, llmSignal, llmTriage } from '../integrations/anthropic';
import { evaluateImmediateSuggestions, refreshPendingDrafts, surfaceLlmFailure } from './brief';
import { processIntroductions } from './introductions';
import { loadPeopleCache, suggestDuplicateMerges, upsertPerson } from './people';
import { evaluateTrigger } from './stages';

/** Threads with more people than this are group mail (clubs, lists, class threads) and carry no tie. */
const GROUP_THREAD_MAX_PEOPLE = 8;

export interface RawEmail {
  externalMessageId: string;
  externalThreadId: string;
  from: string; // "Name <email>" or email
  to: string[];
  cc: string[];
  subject?: string;
  sentAt: string;
  bodyText: string;
  headers: Record<string, string>;
  labels?: string[];
}

const splitAddress = parseAddress;

/** "Alex Rivera", "Rivera, Alex" and "alex rivera" are the same name. */
function sameName(a: string, b: string): boolean {
  const n = (x: string) =>
    stripDiacritics(x)
      .toLowerCase()
      .replace(/[^a-z ,]/g, '')
      .split(/[\s,]+/)
      .filter(Boolean)
      .sort()
      .join(' ');
  return Boolean(n(a)) && n(a) === n(b);
}

/**
 * Every address the student sends from: the primary address, any From on a message Gmail labelled SENT (send-as
 * aliases), any From the student used on earlier outbound mail, and a From at the student's school domain whose
 * display name is the student's own name (netid@school.edu next to first.last@school.edu).
 */
export async function collectUserEmails(user: User, raws: RawEmail[]): Promise<Set<string>> {
  const out = new Set([normalizeEmail(user.email)]);
  const earlier = await db.messages
    .where('userId')
    .equals(user.id)
    .filter((m) => m.direction === 'outbound')
    .toArray();
  for (const m of earlier) out.add(normalizeEmail(m.fromEmail));
  for (const r of raws) {
    const from = splitAddress(r.from);
    if (!from.email.includes('@')) continue;
    const sentLabel = r.labels?.includes('SENT');
    const schoolAlias =
      Boolean(user.schoolDomain) &&
      emailDomain(from.email) === user.schoolDomain &&
      Boolean(from.name) &&
      sameName(from.name!, user.fullName);
    if (sentLabel || schoolAlias) out.add(from.email);
  }
  return out;
}

/** Heuristic triage at or above this confidence is kept as is; only less certain threads go to Claude. */
const HEURISTIC_CONFIDENT = 0.8;

/**
 * The Orbit outbound row an email came from: Orbit puts X-Orbit-Message-Id on every Gmail API send, and the Gmail id
 * of the sent message is stored as providerMessageId. Such an email is already counted (touchpoint, stage change).
 */
async function orbitOutboundId(
  userId: string,
  m: { externalMessageId: string; headers: Record<string, string> },
): Promise<string | undefined> {
  const id = m.headers['x-orbit-message-id']?.trim();
  if (id) {
    const o = await db.outbound.get(id);
    if (o && o.userId === userId) return o.id;
  }
  const byProvider = await db.outbound
    .where('userId')
    .equals(userId)
    .filter((o) => o.providerMessageId === m.externalMessageId)
    .first();
  return byProvider?.id;
}

export interface IngestStats {
  threads: number;
  messages: number;
  people: number;
  networking: number;
  skipped: number;
}

/**
 * Ingest raw emails: people, threads, messages, triage, signals, touchpoints, chats, stage transitions. Idempotent on externalMessageId.
 * Email bodies go to Anthropic only when the student turned on "Use Claude to read synced email"
 * (`llmEnabled('emailTriage')`, off by default); `opts.useLlm: false` turns it off for one run.
 */
export async function ingestEmails(
  user: User,
  raws: RawEmail[],
  opts: { useLlm?: boolean; now?: Date; onProgress?: (done: number, total: number) => void } = {},
): Promise<IngestStats> {
  const now = opts.now ?? new Date();
  const stats: IngestStats = { threads: 0, messages: 0, people: 0, networking: 0, skipped: 0 };
  const userEmails = await collectUserEmails(user, raws);
  const useLlm = (opts.useLlm ?? true) && llmEnabled('emailTriage');
  const byThread = new Map<string, RawEmail[]>();
  for (const r of raws) {
    const arr = byThread.get(r.externalThreadId) ?? [];
    arr.push(r);
    byThread.set(r.externalThreadId, arr);
  }
  let done = 0;
  const cache = await loadPeopleCache(user.id);
  /** calendar invitations seen in this batch: the people on them and when they were sent */
  const invites: { emails: string[]; sentAt: string }[] = [];
  for (const [extThreadId, list] of byThread) {
    list.sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    let thread = await db.threads.where('externalThreadId').equals(extThreadId).first();
    const isNewThread = !thread;
    if (!thread) {
      thread = {
        id: newId('th'),
        userId: user.id,
        externalThreadId: extThreadId,
        subject: list[0]!.subject,
        messageCount: 0,
        participantEmails: [],
        participantPersonIds: [],
        isNetworking: false,
      };
      await db.threads.add(thread);
      stats.threads++;
    }
    const newMessages: EmailMessage[] = [];
    for (const r of list) {
      const exists = await db.messages.where('externalMessageId').equals(r.externalMessageId).first();
      if (exists) {
        // a message Orbit recorded when it sent it learns its real Message-ID here, for later replies
        if (!exists.headers['message-id'] && r.headers['message-id'])
          await db.messages.update(exists.id, { headers: { ...r.headers, ...exists.headers } });
        stats.skipped++;
        continue;
      }
      const from = splitAddress(r.from);
      const direction: EmailMessage['direction'] = userEmails.has(from.email) ? 'outbound' : 'inbound';
      // machine mail: bulk/notification senders, vacation auto-replies, calendar invitations (the calendar sync owns those)
      const stripped = stripQuotedReply(r.bodyText);
      // a vacation responder without auto-reply headers still reads like one ("Thank you for your email. I am
      // traveling with limited access to email"); it is not a reply from the person
      const automated =
        direction === 'inbound' &&
        (isAutomatedSender(from.email, r.headers, r.labels, from.name) ||
          isAutoReply(r.headers, r.subject) ||
          isAutoReplyBody(stripped) ||
          isCalendarNotice(r.subject, r.bodyText, r.headers));
      const sig = splitSignature(stripped, { name: from.name });
      const msg: EmailMessage = {
        id: newId('m'),
        userId: user.id,
        threadId: thread.id,
        externalMessageId: r.externalMessageId,
        direction,
        fromEmail: from.email,
        fromName: from.name,
        toEmails: r.to.map((t) => splitAddress(t).email),
        ccEmails: r.cc.map((t) => splitAddress(t).email),
        sentAt: r.sentAt,
        subject: r.subject,
        bodyText: sig.body || stripped,
        headers: r.headers,
        isAutomated: automated,
      };
      // people
      const counterparts =
        direction === 'inbound'
          ? [{ email: from.email, name: from.name, isSender: true }]
          : r.to.map((t) => ({ ...splitAddress(t), isSender: false }));
      const ccs = [
        ...r.cc.map((t) => ({ ...splitAddress(t), isSender: false })),
        ...(direction === 'inbound' ? r.to.map((t) => ({ ...splitAddress(t), isSender: false })) : []),
      ].filter((x) => !userEmails.has(x.email));
      if (!automated) {
        // a fragment without an address is never a person
        for (const c of counterparts.filter((x) => x.email.includes('@') && !userEmails.has(x.email))) {
          // shared inboxes and team names (campusrecruiting@, "Stripe Careers") are not people to network with
          const auto = isAutomatedSender(c.email, {}, [], c.name) || isRoleName(c.name);
          const { person, created } = await upsertPerson(
            {
              userId: user.id,
              email: c.email,
              displayName: c.name,
              title: c.isSender ? sig.title : undefined,
              companyRaw: c.isSender ? sig.company : undefined,
              linkedinUrl: c.isSender ? sig.linkedinUrl : undefined,
              source: 'gmail',
              userSchool: user.school,
              firstSeenAt: r.sentAt,
              school: emailDomain(c.email) === user.schoolDomain ? user.school : undefined,
            },
            cache,
          );
          if (created) {
            stats.people++;
            if (auto) await db.people.update(person.id, { isHuman: false });
          }
          if (c.isSender) msg.fromPersonId = person.id;
          if (!thread.participantPersonIds.includes(person.id)) thread.participantPersonIds.push(person.id);
        }
        for (const c of ccs) {
          if (!c.email.includes('@')) continue;
          const { person, created } = await upsertPerson(
            {
              userId: user.id,
              email: c.email,
              displayName: c.name,
              source: 'gmail',
              userSchool: user.school,
              firstSeenAt: r.sentAt,
            },
            cache,
          );
          if (created && (isAutomatedSender(c.email, {}, [], c.name) || isRoleName(c.name)))
            await db.people.update(person.id, { isHuman: false });
          if (!thread.participantPersonIds.includes(person.id)) thread.participantPersonIds.push(person.id);
        }
      }
      for (const e of [from.email, ...msg.toEmails, ...msg.ccEmails])
        if (!thread.participantEmails.includes(e)) thread.participantEmails.push(e);
      await db.messages.add(msg);
      if (
        automated &&
        BOOKED_NOTICE.test(r.subject ?? '') &&
        isCalendarNotice(r.subject, r.bodyText, r.headers)
      )
        invites.push({ emails: [from.email, ...msg.toEmails, ...msg.ccEmails], sentAt: r.sentAt });
      newMessages.push(msg);
      stats.messages++;
    }
    if (newMessages.length) {
      const all = await db.messages.where('threadId').equals(thread.id).sortBy('sentAt');
      thread.messageCount = all.length;
      thread.firstMessageAt = all[0]?.sentAt;
      thread.lastMessageAt = all[all.length - 1]?.sentAt;
      thread.snippet = all[all.length - 1]?.bodyText.slice(0, 140);
      // triage (new thread, or thread not yet networking and got a human message)
      if (
        isNewThread ||
        !thread.classifiedAt ||
        (!thread.isNetworking && newMessages.some((m) => !m.isAutomated))
      ) {
        const humanAll = all.filter((m) => !m.isAutomated);
        const heuristic = heuristicTriage({
          subject: thread.subject,
          messages: all.map((m) => ({
            fromEmail: m.fromEmail,
            direction: m.direction,
            body: m.bodyText,
            isAutomated: m.isAutomated,
          })),
          userEmails: [...userEmails],
        });
        // Only threads the rules cannot call with confidence are sent to Claude.
        const llmTri =
          useLlm && humanAll.length && heuristic.confidence < HEURISTIC_CONFIDENT
            ? await llmTriage(
                thread.subject,
                humanAll
                  .slice(0, 3)
                  .map((m) => ({ fromEmail: m.fromEmail, direction: m.direction, body: m.bodyText })),
                user.email,
              ).catch((e) => surfaceLlmFailure(user.id, e))
            : undefined;
        const tri = llmTri ?? heuristic;
        thread.category = tri.category;
        thread.categoryConfidence = tri.confidence;
        // a thread that introduced the student to someone stays a networking thread: the answers come in it
        thread.isNetworking = tri.isNetworking || !!thread.introduction;
        thread.classifiedAt = now.toISOString();
        thread.classifiedBy = llmTri ? 'llm' : 'heuristic';
        if (tri.isNetworking) stats.networking++;
      }
      await db.threads.put(thread);
      // touchpoints for every human message
      for (const m of newMessages) {
        if (m.isAutomated) continue;
        // Mailing lists and big group threads are not relationships: no touchpoints there at all. Elsewhere a CC
        // adds at most one touchpoint per thread (and computeStrength caps the CC total).
        if (thread.participantPersonIds.length > GROUP_THREAD_MAX_PEOPLE) continue;
        const direct =
          m.direction === 'inbound'
            ? m.fromPersonId
              ? [m.fromPersonId]
              : []
            : thread.participantPersonIds.filter((pid) => true);
        for (const pid of thread.participantPersonIds) {
          const p = await db.people.get(pid);
          if (!p || !p.isHuman) continue;
          const isDirect =
            direct.includes(pid) &&
            (m.direction === 'inbound' || m.toEmails.some((e) => p.emails.includes(e)));
          const kind = isDirect ? (m.direction === 'inbound' ? 'email_in' : 'email_out') : 'email_cc';
          const weight =
            thread.isNetworking || isDirect
              ? kind === 'email_in'
                ? 0.7
                : kind === 'email_out'
                  ? 0.6
                  : 0.1
              : 0.1;
          // an email Orbit sent already has its touchpoint, keyed to the outbound row: key this one the same way
          const sentByOrbit =
            isDirect && m.direction === 'outbound' ? await orbitOutboundId(user.id, m) : undefined;
          await addTouchpoint({
            userId: user.id,
            personId: pid,
            kind,
            occurredAt: m.sentAt,
            refTable: sentByOrbit ? 'outbound' : kind === 'email_cc' ? 'threads' : 'messages',
            refId: sentByOrbit ?? (kind === 'email_cc' ? thread.id : m.id),
            summary:
              `${m.direction === 'inbound' ? 'Email from' : 'Email to'} ${p.firstName}: ${m.subject ?? ''}`.trim(),
            weight,
          });
        }
      }
      // networking: chats + signals + stages. 1:1 threads and small threads (an intro with one or two people on CC)
      // are read; larger group threads only count as touchpoints and co-thread edges.
      if (
        thread.isNetworking &&
        thread.participantPersonIds.length >= 1 &&
        thread.participantPersonIds.length <= 3
      )
        await processNetworkingThread(user, thread, newMessages, all, useLlm, now);
      // a group email that introduces the student to someone opens a card for that person (a small intro thread
      // read above may already have opened it; this records the intro and fills in only what is missing)
      if (thread.participantPersonIds.length > 1)
        await processIntroductions(user, thread, newMessages, [...userEmails], now);
      for (const pid of thread.participantPersonIds) await recomputePersonStrength(pid, now);
    }
    done++;
    opts.onProgress?.(done, byThread.size);
  }
  for (const inv of invites) await retireSchedulingCards(user.id, inv.emails, inv.sentAt, userEmails, now);
  await suggestDuplicateMerges(user.id, now);
  return stats;
}

/** A calendar notice that means a meeting is on the calendar (not a decline or a cancellation). */
const BOOKED_NOTICE = /^\s*(updated invitation|invitation|new event|accepted)\b/i;

/**
 * A calendar invitation is mail the calendar sync owns, so it is not read as a reply. It still answers the open
 * "propose times" or "confirm it" card for the people on it: the meeting is booked. Cards raised by a message sent
 * after the invitation (a later reschedule) are kept.
 */
async function retireSchedulingCards(
  userId: string,
  emails: string[],
  sentAt: string,
  userEmails: Set<string>,
  now: Date,
): Promise<void> {
  const others = new Set(emails.map((e) => e.toLowerCase()).filter((e) => !userEmails.has(e)));
  if (!others.size) return;
  const people = await db.people
    .where('userId')
    .equals(userId)
    .filter((p) => p.emails.some((e) => others.has(e.toLowerCase())))
    .toArray();
  for (const p of people) {
    const open = await db.suggestions
      .where('personId')
      .equals(p.id)
      .filter(
        (s) =>
          (s.kind === 'schedule_confirm' || s.kind === 'schedule_propose') &&
          (s.status === 'pending' || s.status === 'snoozed'),
      )
      .toArray();
    for (const s of open) {
      const trigger =
        typeof s.payload.inReplyTo === 'string' ? await db.messages.get(s.payload.inReplyTo) : undefined;
      if (trigger && trigger.sentAt > sentAt) continue;
      await db.suggestions.update(s.id, { status: 'expired', decidedAt: now.toISOString() });
    }
  }
}

const ACTIVE = (c: CoffeeChat) => !['declined', 'no_response', 'archived'].includes(c.stage);
/** An intro older than this is history, not a to-do: no new chat is created for the person introduced. */
const INTRO_CHAT_WINDOW_MS = 30 * 86_400_000;

async function processNetworkingThread(
  user: User,
  thread: EmailThread,
  newMessages: EmailMessage[],
  all: EmailMessage[],
  useLlm: boolean,
  now: Date,
): Promise<void> {
  const participants = (await db.people.bulkGet(thread.participantPersonIds)).filter((p): p is Person =>
    Boolean(p),
  );
  const byEmail = (e: string) => participants.find((p) => p.emails.includes(e));
  const humanAll = all.filter((m) => !m.isAutomated);
  const first = humanAll[0] ?? all[0]!;
  // the counterpart: the person of the thread's chat, else whom the student first wrote to, else the first sender
  let chat: CoffeeChat | undefined = thread.chatId ? await db.chats.get(thread.chatId) : undefined;
  let counterpartId =
    chat && thread.participantPersonIds.includes(chat.personId)
      ? chat.personId
      : first.direction === 'outbound'
        ? first.toEmails.map(byEmail).find(Boolean)?.id
        : first.fromPersonId;
  counterpartId ??= thread.participantPersonIds.find((pid) => all.some((m) => m.fromPersonId === pid));
  counterpartId ??= thread.participantPersonIds[0];
  if (!counterpartId) return;
  const person = participants.find((p) => p.id === counterpartId);
  if (!person || !person.isHuman) return;
  // a thread that began 1:1 belongs to the counterpart's chat (and may create it); a thread that began as a group
  // only moves a chat already bound to it
  const othersOnFirst = [...first.toEmails, ...first.ccEmails, first.fromEmail].filter(
    (e) => byEmail(e) && byEmail(e)!.id !== counterpartId,
  );
  const beganOneToOne = othersOnFirst.length === 0;
  if (!chat || chat.personId !== counterpartId)
    chat = beganOneToOne
      ? await db.chats.where('personId').equals(counterpartId).filter(ACTIVE).first()
      : undefined;
  if (!chat && beganOneToOne) {
    const firstOut = all.find((m) => m.direction === 'outbound');
    chat = {
      id: newId('c'),
      userId: user.id,
      personId: counterpartId,
      organizationId: person.currentOrganizationId,
      stage: 'identified',
      stageEnteredAt: all[0]!.sentAt,
      source: 'detected',
      goalTags: [],
      outreachChannel: 'gmail',
      bumpCount: 0,
      priority: 2,
      threadId: thread.id,
      firstOutreachAt: firstOut?.sentAt,
      createdAt: all[0]!.sentAt,
      updatedAt: now.toISOString(),
    };
    await db.chats.add(chat);
  }
  if (chat && !thread.chatId) await db.threads.update(thread.id, { chatId: chat.id });
  // chats this thread can move: the counterpart's and those of people introduced on it
  const chats = new Map<string, CoffeeChat>();
  if (chat) chats.set(counterpartId, chat);
  for (const p of participants) {
    if (p.id === counterpartId || !p.isHuman) continue;
    const c = await db.chats
      .where('personId')
      .equals(p.id)
      .filter((x) => ACTIVE(x) && x.threadId === thread.id)
      .first();
    if (c) chats.set(p.id, c);
  }
  // a chat Orbit started (or found by person) learns its thread so follow-ups reply in it
  if (chat && !chat.threadId) {
    await db.chats.update(chat.id, { threadId: thread.id });
    chat.threadId = thread.id;
  }
  const touched = new Set<string>();
  for (const m of newMessages.sort((a, b) => a.sentAt.localeCompare(b.sentAt))) {
    if (m.isAutomated) {
      // a vacation auto-reply from the counterpart: record it and hold bumps until the return date
      const c = chats.get(counterpartId);
      if (m.direction !== 'inbound' || !c || !person.emails.includes(m.fromEmail)) continue;
      const ooo = detectOutOfOffice(m.bodyText, new Date(m.sentAt), { timeZone: user.timezone });
      if (!ooo.isOutOfOffice) continue;
      await db.messages.update(m.id, {
        signal: 'out_of_office',
        signalConfidence: 0.9,
        extraction: {
          proposedTimes: [],
          asksOfUser: [],
          offers: [],
          factsAboutSender: [],
          sentiment: 'neutral',
          ...(ooo.returnDate ? { returnDate: ooo.returnDate } : {}),
        },
        processedAt: now.toISOString(),
      });
      if (ooo.returnDate && (!c.outOfOfficeUntil || ooo.returnDate > c.outOfOfficeUntil)) {
        c.outOfOfficeUntil = ooo.returnDate;
        await db.chats.update(c.id, { outOfOfficeUntil: ooo.returnDate, updatedAt: now.toISOString() });
      }
      await holdBumpForOutOfOffice(c, m, user.timezone, now, ooo.returnDate);
      touched.add(counterpartId);
      continue;
    }
    const context = all
      .filter((x) => x.sentAt < m.sentAt)
      .slice(-3)
      .map((x) => `[${x.direction}] ${x.bodyText.slice(0, 600)}`)
      .join('\n---\n');
    const sig = useLlm
      ? await llmSignal(
          m.bodyText,
          m.direction,
          context,
          user.timezone,
          new Date(m.sentAt).toISOString(),
        ).catch((e) => surfaceLlmFailure(user.id, e))
      : undefined;
    const h = heuristicSignal(m.bodyText, m.direction, new Date(m.sentAt), { timeZone: user.timezone });
    const signal = sig?.signal ?? h.signal;
    const confidence = sig?.confidence ?? h.confidence;
    const extraction = sig
      ? {
          proposedTimes: sig.proposedTimes,
          asksOfUser: sig.asksOfUser,
          offers: sig.offers,
          factsAboutSender: sig.facts.map((f) => ({ type: f.type as never, text: f.text })),
          sentiment: sig.sentiment,
          // what only the heuristic reads (return date, "try me in January", "email is easier") when both agree
          ...(sig.signal === h.signal
            ? {
                ...(h.extraction.returnDate ? { returnDate: h.extraction.returnDate } : {}),
                ...(h.extraction.followUpAfter ? { followUpAfter: h.extraction.followUpAfter } : {}),
                ...(h.extraction.prefersEmail ? { prefersEmail: true } : {}),
                ...(h.extraction.handoff ? { handoff: true } : {}),
              }
            : {}),
        }
      : h.extraction;
    await db.messages.update(m.id, {
      signal,
      signalConfidence: confidence,
      extraction,
      processedAt: now.toISOString(),
    });
    m.signal = signal;
    m.extraction = extraction;
    if (m.direction === 'inbound' && signal === 'out_of_office') {
      // "I'm traveling this week, back Monday": not an answer. It does not count as a reply (the bump still comes,
      // after the return date) and never moves the chat.
      const c = m.fromPersonId ? chats.get(m.fromPersonId) : undefined;
      const back =
        extraction.returnDate ??
        detectOutOfOffice(m.bodyText, new Date(m.sentAt), { timeZone: user.timezone }).returnDate;
      if (c && back && (!c.outOfOfficeUntil || back > c.outOfOfficeUntil)) {
        c.outOfOfficeUntil = back;
        await db.chats.update(c.id, { outOfOfficeUntil: back, updatedAt: now.toISOString() });
      }
      // not a reply: the thread is still waiting on them, and the bump waits until they are back
      if (c) await holdBumpForOutOfOffice(c, m, user.timezone, now, back);
      if (m.fromPersonId) touched.add(m.fromPersonId);
      continue;
    }
    if (m.direction === 'inbound') {
      const senderId = m.fromPersonId;
      const c = senderId ? chats.get(senderId) : undefined;
      const sender = participants.find((p) => p.id === senderId);
      if (!c || !sender) continue;
      for (const f of extraction.factsAboutSender)
        await db.facts.add({
          id: newId('f'),
          userId: user.id,
          personId: sender.id,
          type: f.type,
          text: f.text,
          sourceTable: 'messages',
          sourceId: m.id,
          occurredAt: m.sentAt,
          confidence: 0.7,
          createdAt: now.toISOString(),
        });
      for (const o of extraction.offers)
        await db.facts.add({
          id: newId('f'),
          userId: user.id,
          personId: sender.id,
          type: 'offer',
          text: o,
          sourceTable: 'messages',
          sourceId: m.id,
          occurredAt: m.sentAt,
          confidence: 0.75,
          createdAt: now.toISOString(),
        });
      await db.chats.update(c.id, { lastInboundAt: m.sentAt, updatedAt: now.toISOString() });
      c.lastInboundAt = m.sentAt;
      await evaluateTrigger(
        c,
        { type: 'inbound_signal', signal, confidence },
        { table: 'messages', id: m.id, at: m.sentAt },
        now,
        new Date(m.sentAt),
      );
      touched.add(sender.id);
      // an intro: the people the sender put on the thread become chats the student can open, credited to the sender
      if (
        signal === 'intro_offer' &&
        sender.id === counterpartId &&
        now.getTime() - new Date(m.sentAt).getTime() < INTRO_CHAT_WINDOW_MS
      ) {
        for (const e of [...m.toEmails, ...m.ccEmails]) {
          const target = byEmail(e);
          if (!target || target.id === counterpartId || !target.isHuman || chats.has(target.id)) continue;
          let tc = await db.chats.where('personId').equals(target.id).filter(ACTIVE).first();
          if (!tc) {
            tc = {
              id: newId('c'),
              userId: user.id,
              personId: target.id,
              organizationId: target.currentOrganizationId,
              stage: 'identified',
              stageEnteredAt: m.sentAt,
              source: 'detected',
              goalTags: [],
              outreachChannel: 'gmail',
              bumpCount: 0,
              priority: 2,
              threadId: thread.id,
              referrerPersonId: sender.id,
              referrerName: sender.displayName,
              introducedAt: m.sentAt,
              createdAt: m.sentAt,
              updatedAt: now.toISOString(),
            };
            await db.chats.add(tc);
          }
          chats.set(target.id, tc);
          touched.add(target.id);
        }
      }
      if (now.getTime() - new Date(m.sentAt).getTime() < 3 * 86_400_000)
        await notify(
          user.id,
          'reply_received',
          `${sender.firstName} replied`,
          m.bodyText.slice(0, 120),
          `/people/${sender.id}`,
        );
    } else {
      // the student's message moves the chats of the people it was addressed to; a message Orbit sent itself
      // already moved its chat (and counted the bump) in the send path
      const sentByOrbit =
        Object.keys(m.headers ?? {}).some((k) => k.toLowerCase() === 'x-orbit-message-id') ||
        !!(await orbitOutboundId(user.id, m));
      const targets = [...chats.entries()].filter(
        ([pid]) => chats.size === 1 || m.toEmails.some((e) => byEmail(e)?.id === pid),
      );
      for (const [pid, c] of targets) {
        // anything sent after the conversation is the thank-you, whatever the wording
        const kind = outboundKind(c, signal);
        const changes: Partial<CoffeeChat> = {
          lastOutboundAt: c.lastOutboundAt && c.lastOutboundAt > m.sentAt ? c.lastOutboundAt : m.sentAt,
          firstOutreachAt: c.firstOutreachAt ?? m.sentAt,
          updatedAt: now.toISOString(),
        };
        // a follow-up the student sent from their own mail still counts toward the bump limit
        if (kind === 'bump' && !sentByOrbit) changes.bumpCount = c.bumpCount + 1;
        await db.chats.update(c.id, changes);
        Object.assign(c, changes);
        if (!sentByOrbit)
          await evaluateTrigger(
            c,
            { type: 'outbound_sent', kind },
            { table: 'messages', id: m.id, at: m.sentAt },
            now,
          );
        touched.add(pid);
      }
    }
  }
  if (chat) touched.add(counterpartId);
  for (const pid of touched) {
    const c = chats.get(pid);
    if (c) await evaluateImmediateSuggestions(user.id, { chatId: c.id, personId: pid }, now);
  }
}

/**
 * An out-of-office reply holds the next bump until two business days after the return date it names, or five
 * business days after the reply when it names none. `returnDate` (YYYY-MM-DD) is the date the email reader already
 * found, when it found one.
 */
async function holdBumpForOutOfOffice(
  chat: CoffeeChat,
  m: EmailMessage,
  tz: string | undefined,
  now: Date,
  returnDate?: string,
): Promise<void> {
  const sent = new Date(m.sentAt);
  const back = returnDate ? new Date(`${returnDate}T12:00:00Z`) : parseReturnDate(m.bodyText, sent, tz);
  const notBefore = (back ? addBusinessDays(back, 2, tz) : addBusinessDays(sent, 5, tz)).toISOString();
  if (chat.bumpNotBefore && chat.bumpNotBefore >= notBefore) return;
  await db.chats.update(chat.id, { bumpNotBefore: notBefore, updatedAt: now.toISOString() });
  chat.bumpNotBefore = notBefore;
}

/**
 * What an outbound message in a networking thread is, from where the chat stands: anything sent after the
 * conversation is the thank-you (whatever the wording), and a second message into silence is a bump.
 */
export function outboundKind(
  chat: Pick<CoffeeChat, 'stage' | 'lastOutboundAt' | 'lastInboundAt'>,
  signal: string | undefined,
): 'outreach' | 'bump' | 'schedule' | 'thank_you' | 'other' {
  if (chat.stage === 'completed') return 'thank_you';
  if (signal === 'thank_you') return 'thank_you';
  if (signal === 'scheduling_proposal') return 'schedule';
  if (chat.stage === 'identified' || chat.stage === 'warming') return 'outreach';
  if (
    chat.stage === 'outreach_sent' &&
    chat.lastOutboundAt &&
    (!chat.lastInboundAt || chat.lastInboundAt < chat.lastOutboundAt)
  )
    return 'bump';
  return 'other';
}

export interface RawEvent {
  externalEventId: string;
  iCalUID?: string;
  title?: string;
  description?: string;
  startAt: string;
  endAt: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  attendees: { email: string; displayName?: string; responseStatus?: string; self?: boolean }[];
  conferenceUrl?: string;
  /** When the invite was created; a future chat counts as scheduled from then. */
  createdAt?: string;
}

const NOT_CHAT =
  /\b(standup|stand-up|class|lecture|section|office hours|interview|exam|midterm|final|study|club|meeting of|all[- ]hands|sync|1:1 with manager|dentist|doctor|flight)\b/i;

export async function ingestEvents(
  user: User,
  raws: RawEvent[],
  now = new Date(),
): Promise<{ events: number; chats: number }> {
  const userEmail = normalizeEmail(user.email);
  let count = 0;
  let chatCount = 0;
  const cache = await loadPeopleCache(user.id);
  for (const r of raws) {
    const existing = await db.events.where('externalEventId').equals(r.externalEventId).first();
    const others = r.attendees.filter((a) => !a.self && normalizeEmail(a.email) !== userEmail);
    const attendeePersonIds: string[] = [];
    for (const a of others.slice(0, 8)) {
      if (isAutomatedSender(a.email, {}, [], a.displayName) || isRoleName(a.displayName)) continue;
      const { person } = await upsertPerson(
        {
          userId: user.id,
          email: a.email,
          displayName: a.displayName,
          source: 'calendar',
          userSchool: user.school,
          firstSeenAt: r.startAt,
          school: emailDomain(a.email) === user.schoolDomain ? user.school : undefined,
        },
        cache,
      );
      attendeePersonIds.push(person.id);
    }
    const durationMin = (new Date(r.endAt).getTime() - new Date(r.startAt).getTime()) / 60_000;
    let isCoffeeChat = false;
    let confidence = 0;
    if (
      others.length >= 1 &&
      others.length <= 3 &&
      durationMin >= 15 &&
      durationMin <= 60 &&
      !NOT_CHAT.test(r.title ?? '')
    ) {
      const activeChat = await db.chats
        .where('userId')
        .equals(user.id)
        .filter(
          (c) =>
            attendeePersonIds.includes(c.personId) &&
            !['declined', 'no_response', 'archived'].includes(c.stage),
        )
        .first();
      const external = others.some((a) => emailDomain(a.email) !== user.schoolDomain);
      if (activeChat) {
        isCoffeeChat = true;
        confidence = 0.9;
      } else if (external) {
        isCoffeeChat = true;
        confidence = 0.7;
      }
    }
    const ev: CalendarEvent = {
      id: existing?.id ?? newId('ev'),
      userId: user.id,
      externalEventId: r.externalEventId,
      title: r.title,
      description: r.description,
      startAt: r.startAt,
      endAt: r.endAt,
      status: r.status,
      attendees: r.attendees,
      attendeePersonIds,
      conferenceUrl: r.conferenceUrl,
      isCoffeeChat,
      coffeeChatConfidence: confidence,
      chatId: existing?.chatId,
    };
    await db.events.put(ev);
    count++;
    if (!isCoffeeChat || !attendeePersonIds.length) continue;
    const pid = attendeePersonIds[0]!;
    const person = await db.people.get(pid);
    if (!person) continue;
    let chat = ev.chatId ? await db.chats.get(ev.chatId) : undefined;
    if (!chat)
      chat = await db.chats
        .where('personId')
        .equals(pid)
        .filter((c) => !['declined', 'no_response', 'archived'].includes(c.stage))
        .first();
    if (!chat) {
      if (confidence < 0.8) continue; // ambiguous calendar-only matches do not create chats on their own
      chat = {
        id: newId('c'),
        userId: user.id,
        personId: pid,
        organizationId: person.currentOrganizationId,
        stage: 'identified',
        stageEnteredAt: r.startAt,
        source: 'detected',
        goalTags: [],
        bumpCount: 0,
        priority: 2,
        createdAt: r.startAt,
        updatedAt: now.toISOString(),
      };
      await db.chats.add(chat);
      chatCount++;
    }
    if (ev.chatId !== chat.id) await db.events.update(ev.id, { chatId: chat.id });
    const ended = new Date(r.endAt).getTime() + 15 * 60_000 < now.getTime();
    if (r.status === 'cancelled') {
      await evaluateTrigger(chat, { type: 'event_cancelled' }, { table: 'events', id: ev.id }, now);
      continue;
    }
    if (!chat.scheduledEventId) await db.chats.update(chat.id, { scheduledEventId: ev.id });
    if (ended) {
      await addTouchpoint({
        userId: user.id,
        personId: pid,
        kind: 'meeting',
        occurredAt: r.startAt,
        refTable: 'events',
        refId: ev.id,
        summary: `Meeting: ${r.title ?? 'Coffee chat'}`,
        weight: 1,
      });
      if (
        chat.stage !== 'scheduled' &&
        ['identified', 'warming', 'outreach_sent', 'replied', 'scheduling'].includes(chat.stage)
      )
        await evaluateTrigger(
          chat,
          { type: 'event_scheduled', confidence },
          { table: 'events', id: ev.id, at: r.startAt },
          now,
          new Date(r.startAt),
        );
      // the chat was completed when the meeting ended, not when Orbit read the calendar (a meeting from August is not
      // "just now", and gets no thank-you card seven weeks late)
      await evaluateTrigger(
        chat,
        { type: 'event_ended', confidence: confidence >= 0.9 ? 0.95 : 0.7 },
        { table: 'events', id: ev.id, at: r.endAt },
        now,
        new Date(r.endAt),
      );
      await db.chats.update(chat.id, { completedAt: chat.completedAt ?? r.endAt });
      chat.completedAt = chat.completedAt ?? r.endAt;
      // mail is often read before the calendar: a thank-you already sent after the meeting moves the chat on, with
      // that message as the evidence; any other message sent after the meeting is the thank-you too
      if (chat.stage === 'completed' && chat.threadId) {
        const thanks = (await db.messages.where('threadId').equals(chat.threadId).sortBy('sentAt')).find(
          (m) => m.direction === 'outbound' && m.signal === 'thank_you' && m.sentAt >= r.endAt,
        );
        if (thanks)
          await evaluateTrigger(
            chat,
            { type: 'outbound_sent', kind: 'thank_you' },
            { table: 'messages', id: thanks.id, at: thanks.sentAt },
            now,
          );
      }
      if (chat.stage === 'completed' && chat.lastOutboundAt && chat.lastOutboundAt > r.endAt)
        await evaluateTrigger(
          chat,
          { type: 'outbound_sent', kind: 'thank_you' },
          { table: 'events', id: ev.id },
          now,
          new Date(chat.lastOutboundAt),
        );
      await recomputePersonStrength(pid, now);
    } else {
      // the invite's creation time when the calendar gives it; otherwise the last message in the thread is the
      // closest evidence of when the time was agreed
      const agreedAt = [chat.lastInboundAt, chat.lastOutboundAt]
        .filter((x): x is string => !!x)
        .sort()
        .pop();
      const scheduledAt = r.createdAt ?? agreedAt;
      await evaluateTrigger(
        chat,
        { type: 'event_scheduled', confidence },
        { table: 'events', id: ev.id, at: r.createdAt },
        now,
        scheduledAt ? new Date(scheduledAt) : undefined,
      );
    }
    await evaluateImmediateSuggestions(user.id, { chatId: chat.id, personId: pid }, now);
  }
  // proposed windows were drafted against the old calendar
  if (count) await refreshPendingDrafts(user, { kinds: ['schedule', 'reply'] });
  return { events: count, chats: chatCount };
}

export function personDisplay(p: Person): string {
  return p.displayName || parseName(p.primaryEmail ?? '').full || 'Unknown';
}
