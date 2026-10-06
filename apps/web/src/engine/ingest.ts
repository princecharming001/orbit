import type { CalendarEvent, CoffeeChat, EmailMessage, EmailThread, Person, User } from '@orbit/core';
import {
  emailDomain,
  heuristicSignal,
  heuristicTriage,
  isAutomatedSender,
  newId,
  normalizeEmail,
  parseName,
  splitSignature,
  stripQuotedReply,
} from '@orbit/core';
import { addTouchpoint, notify, recomputePersonStrength } from '../db/repo';
import { db } from '../db/schema';
import { hasLlm, llmSignal, llmTriage } from '../integrations/anthropic';
import { evaluateImmediateSuggestions } from './brief';
import { loadPeopleCache, upsertPerson } from './people';
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

function splitAddress(raw: string): { email: string; name?: string } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { email: normalizeEmail(m[2]!), name: m[1]?.trim() || undefined };
  return { email: normalizeEmail(raw) };
}

export interface IngestStats {
  threads: number;
  messages: number;
  people: number;
  networking: number;
  skipped: number;
}

/** Ingest raw emails: people, threads, messages, triage, signals, touchpoints, chats, stage transitions. Idempotent on externalMessageId. */
export async function ingestEmails(
  user: User,
  raws: RawEmail[],
  opts: { useLlm?: boolean; now?: Date; onProgress?: (done: number, total: number) => void } = {},
): Promise<IngestStats> {
  const now = opts.now ?? new Date();
  const stats: IngestStats = { threads: 0, messages: 0, people: 0, networking: 0, skipped: 0 };
  const userEmails = new Set([normalizeEmail(user.email)]);
  const useLlm = (opts.useLlm ?? true) && hasLlm();
  const byThread = new Map<string, RawEmail[]>();
  for (const r of raws) {
    const arr = byThread.get(r.externalThreadId) ?? [];
    arr.push(r);
    byThread.set(r.externalThreadId, arr);
  }
  let done = 0;
  const cache = await loadPeopleCache(user.id);
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
        stats.skipped++;
        continue;
      }
      const from = splitAddress(r.from);
      const direction: EmailMessage['direction'] = userEmails.has(from.email) ? 'outbound' : 'inbound';
      const automated = direction === 'inbound' && isAutomatedSender(from.email, r.headers, r.labels);
      const stripped = stripQuotedReply(r.bodyText);
      const sig = splitSignature(stripped);
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
        for (const c of counterparts.filter((x) => !userEmails.has(x.email))) {
          const auto = isAutomatedSender(c.email, {}, []);
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
          const { person } = await upsertPerson(
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
          if (!thread.participantPersonIds.includes(person.id)) thread.participantPersonIds.push(person.id);
        }
      }
      for (const e of [from.email, ...msg.toEmails, ...msg.ccEmails])
        if (!thread.participantEmails.includes(e)) thread.participantEmails.push(e);
      await db.messages.add(msg);
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
        const tri =
          (useLlm && humanAll.length
            ? await llmTriage(
                thread.subject,
                humanAll
                  .slice(0, 3)
                  .map((m) => ({ fromEmail: m.fromEmail, direction: m.direction, body: m.bodyText })),
                user.email,
              ).catch(() => undefined)
            : undefined) ??
          heuristicTriage({
            subject: thread.subject,
            messages: all.map((m) => ({
              fromEmail: m.fromEmail,
              direction: m.direction,
              body: m.bodyText,
              isAutomated: m.isAutomated,
            })),
            userEmails: [...userEmails],
          });
        thread.category = tri.category;
        thread.categoryConfidence = tri.confidence;
        thread.isNetworking = tri.isNetworking;
        thread.classifiedAt = now.toISOString();
        thread.classifiedBy = useLlm ? 'llm' : 'heuristic';
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
          await addTouchpoint({
            userId: user.id,
            personId: pid,
            kind,
            occurredAt: m.sentAt,
            refTable: kind === 'email_cc' ? 'threads' : 'messages',
            refId: kind === 'email_cc' ? thread.id : m.id,
            summary:
              `${m.direction === 'inbound' ? 'Email from' : 'Email to'} ${p.firstName}: ${m.subject ?? ''}`.trim(),
            weight,
          });
        }
      }
      // networking: chats + signals + stages
      // only 1:1 threads create or advance chats; group threads still count as touchpoints and co-thread edges
      if (thread.isNetworking && thread.participantPersonIds.length === 1)
        await processNetworkingThread(user, thread, newMessages, all, useLlm, now);
      for (const pid of thread.participantPersonIds) await recomputePersonStrength(pid, now);
    }
    done++;
    opts.onProgress?.(done, byThread.size);
  }
  return stats;
}

async function processNetworkingThread(
  user: User,
  thread: EmailThread,
  newMessages: EmailMessage[],
  all: EmailMessage[],
  useLlm: boolean,
  now: Date,
): Promise<void> {
  const counterpartId =
    thread.participantPersonIds.find((pid) => all.some((m) => m.fromPersonId === pid)) ??
    thread.participantPersonIds[0];
  if (!counterpartId) return;
  const person = await db.people.get(counterpartId);
  if (!person || !person.isHuman) return;
  let chat: CoffeeChat | undefined = thread.chatId ? await db.chats.get(thread.chatId) : undefined;
  if (!chat)
    chat = await db.chats
      .where('personId')
      .equals(counterpartId)
      .filter((c) => !['declined', 'no_response', 'archived'].includes(c.stage))
      .first();
  if (!chat) {
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
  if (!thread.chatId) await db.threads.update(thread.id, { chatId: chat.id });
  for (const m of newMessages.sort((a, b) => a.sentAt.localeCompare(b.sentAt))) {
    if (m.isAutomated) continue;
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
        ).catch(() => undefined)
      : undefined;
    const h = heuristicSignal(m.bodyText, m.direction, new Date(m.sentAt));
    const signal = sig?.signal ?? h.signal;
    const confidence = sig?.confidence ?? h.confidence;
    const extraction = sig
      ? {
          proposedTimes: sig.proposedTimes,
          asksOfUser: sig.asksOfUser,
          offers: sig.offers,
          factsAboutSender: sig.facts.map((f) => ({ type: f.type as never, text: f.text })),
          sentiment: sig.sentiment,
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
    if (m.direction === 'inbound' && m.fromPersonId === counterpartId) {
      for (const f of extraction.factsAboutSender)
        await db.facts.add({
          id: newId('f'),
          userId: user.id,
          personId: counterpartId,
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
          personId: counterpartId,
          type: 'offer',
          text: o,
          sourceTable: 'messages',
          sourceId: m.id,
          occurredAt: m.sentAt,
          confidence: 0.75,
          createdAt: now.toISOString(),
        });
      await db.chats.update(chat.id, { lastInboundAt: m.sentAt, updatedAt: now.toISOString() });
      chat.lastInboundAt = m.sentAt;
      await evaluateTrigger(
        chat,
        { type: 'inbound_signal', signal, confidence },
        { table: 'messages', id: m.id },
        now,
      );
      if (now.getTime() - new Date(m.sentAt).getTime() < 3 * 86_400_000)
        await notify(
          user.id,
          'reply_received',
          `${person.firstName} replied`,
          m.bodyText.slice(0, 120),
          `/people/${person.id}`,
        );
    } else if (m.direction === 'outbound') {
      const kind =
        signal === 'thank_you'
          ? 'thank_you'
          : signal === 'scheduling_proposal'
            ? 'schedule'
            : chat.stage === 'identified' || chat.stage === 'warming'
              ? 'outreach'
              : 'other';
      await db.chats.update(chat.id, {
        lastOutboundAt: m.sentAt,
        firstOutreachAt: chat.firstOutreachAt ?? m.sentAt,
        updatedAt: now.toISOString(),
      });
      chat.lastOutboundAt = m.sentAt;
      chat.firstOutreachAt = chat.firstOutreachAt ?? m.sentAt;
      await evaluateTrigger(chat, { type: 'outbound_sent', kind }, { table: 'messages', id: m.id }, now);
    }
  }
  await evaluateImmediateSuggestions(user.id, { chatId: chat.id, personId: counterpartId }, now);
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
      if (isAutomatedSender(a.email)) continue;
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
          { table: 'events', id: ev.id },
          new Date(r.startAt),
        );
      await evaluateTrigger(
        chat,
        { type: 'event_ended', confidence: confidence >= 0.9 ? 0.95 : 0.7 },
        { table: 'events', id: ev.id },
        now,
      );
      await db.chats.update(chat.id, { completedAt: chat.completedAt ?? r.endAt });
      await recomputePersonStrength(pid, now);
    } else {
      await evaluateTrigger(
        chat,
        { type: 'event_scheduled', confidence },
        { table: 'events', id: ev.id },
        now,
      );
    }
    await evaluateImmediateSuggestions(user.id, { chatId: chat.id, personId: pid }, now);
  }
  return { events: count, chats: chatCount };
}

export function personDisplay(p: Person): string {
  return p.displayName || parseName(p.primaryEmail ?? '').full || 'Unknown';
}
