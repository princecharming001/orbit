import type {
  Candidate,
  CoffeeChat,
  EmailMessage,
  EmailThread,
  Introduction,
  IntroductionReading,
  Person,
  PossibleIntroduction,
  Touchpoint,
  User,
} from '@orbit/core';
import { newId, possibleIntroduction, readIntroduction } from '@orbit/core';
import { addTouchpoint, feedback } from '../db/repo';
import { db } from '../db/schema';
import { evaluateImmediateSuggestions, upsertSuggestions } from './brief';
import { upsertPerson } from './people';
import { readSuggestedNames, type SuggestedName } from './suggested-names';

const ENDED: CoffeeChat['stage'][] = ['declined', 'no_response', 'archived'];

/**
 * An inbound group email that introduces the student to someone ("Alex, meet Sana", Sana on CC): record the intro on
 * the thread (the graph turns it into an `introduced_by` edge), open a pipeline card for the person introduced with
 * the introducer as referrer, and let the rules suggest a reply while the intro is fresh. If the student already
 * answered in the thread, the card starts at outreach_sent.
 *
 * Answers inside an intro thread ("Thanks for the intro, Lena", "moving Lena to bcc") are never read as new
 * introductions. When the intro itself is older than the sync and only the answer arrives, the answer still names
 * who made it ("Thanks for the warm intro, Lena"): the intro is recorded from it, so the person who answered gets
 * their card.
 *
 * A group email the cues cannot call but that looks like an introduction (from someone the student knows, with a
 * new person on it, see `possibleIntroduction`) is not lost: Orbit asks "Did Lena introduce you to Sam?". Yes records
 * it exactly as above (`confirmPossibleIntroduction`); no is remembered for the thread.
 *
 * `repliesReadLater`: the networking pass runs right after this on the same new messages (a small thread), so the
 * answers among them are left to it. Applying them here too would count the student's reply twice (once as the
 * card's start, once as a bump) and would lose the person's answer, which only the networking pass reads.
 */
export async function processIntroductions(
  user: User,
  thread: EmailThread,
  newMessages: EmailMessage[],
  userEmails: string[],
  now: Date,
  opts: { repliesReadLater?: boolean } = {},
): Promise<number> {
  if (thread.participantPersonIds.length < 2) return 0;
  const people = (await db.people.bulkGet(thread.participantPersonIds)).filter((p): p is Person => !!p);
  const studentNames = [user.firstName, user.fullName].filter((n): n is string => !!n?.trim());
  const fresh = new Set(newMessages.map((m) => m.id));
  let opened = 0;
  let question: PossibleIntroduction | undefined;
  let answeredByStudent = false;
  for (const m of [...newMessages].sort((a, b) => a.sentAt.localeCompare(b.sentAt))) {
    const reading = readIntroduction(m, people, userEmails, { studentNames, prior: thread.introduction });
    let intro: Introduction | undefined;
    if (reading.kind === 'introduction' && m.fromPersonId)
      intro = {
        introducerId: m.fromPersonId,
        introducedIds: reading.introducedIds,
        messageId: m.id,
        at: m.sentAt,
      };
    else if (
      reading.kind === 'intro_reply' &&
      !thread.introduction &&
      m.direction === 'inbound' &&
      m.fromPersonId &&
      reading.introThankedIds.length === 1 &&
      reading.introThankedIds[0] !== m.fromPersonId
    )
      // "Thanks for the warm intro, Lena. Alex, happy to chat": the intro predates what was synced
      intro = {
        introducerId: reading.introThankedIds[0]!,
        introducedIds: [m.fromPersonId],
        messageId: m.id,
        at: m.sentAt,
      };
    else if (reading.kind === 'none' && !question && !thread.introduction && !thread.possibleIntroduction)
      question = await possibleIntroductionIn(user.id, thread, people, m, reading);
    else if (reading.kind === 'intro_reply' && !thread.introduction && m.direction === 'outbound') {
      // "Thanks for the intro, Lena (moving you to bcc). Sam, great to meet you": the student's own answer to the
      // person asked about settles the question
      const asked =
        question ??
        (thread.possibleIntroduction?.status === 'open' ? thread.possibleIntroduction : undefined);
      const to = [...m.toEmails, ...m.ccEmails].map((e) => e.toLowerCase());
      if (
        asked &&
        people.some(
          (p) => asked.personIds.includes(p.id) && p.emails.some((e) => to.includes(e.toLowerCase())),
        )
      ) {
        intro = {
          introducerId: asked.introducerId,
          introducedIds: asked.personIds,
          messageId: asked.messageId,
          at: asked.at,
        };
        answeredByStudent = true;
      }
    }
    if (!intro) continue;
    // settled before the introduction is applied, so the validity pass it triggers does not retire the card as stale
    if (answeredByStudent) await settleIntroductionQuestion(thread, 'confirmed', now, question);
    opened += await applyIntroduction(user, thread, people, intro, now, {
      skip: opts.repliesReadLater ? fresh : undefined,
    });
  }
  if (thread.introduction && !answeredByStudent)
    await retireIntroductionQuestion(thread, 'introduction_recorded', now);
  else if (question) await askAboutIntroduction(user.id, thread, question, now);
  return opened;
}

/**
 * Record an introduction on its thread and open (or credit) the card of each person introduced: the touchpoint, the
 * chat with the introducer as referrer, its first stage, and the "reply while it is fresh" rules. `skip`: messages
 * the networking pass reads right after, left out of the card's start.
 */
async function applyIntroduction(
  user: User,
  thread: EmailThread,
  people: Person[],
  intro: Introduction,
  now: Date,
  opts: { skip?: Set<string> } = {},
): Promise<number> {
  if (!thread.introduction) {
    thread.introduction = intro;
    await db.threads.update(thread.id, { introduction: intro });
  }
  const introducer = people.find((p) => p.id === intro.introducerId);
  if (!introducer) return 0;
  let opened = 0;
  const at = intro.at;
  const later = (await db.messages.where('threadId').equals(thread.id).sortBy('sentAt')).filter(
    (x) => x.sentAt > at && !x.isAutomated && !opts.skip?.has(x.id),
  );
  const answered = later.find((x) => x.direction === 'outbound');
  for (const pid of intro.introducedIds) {
    const person = people.find((p) => p.id === pid);
    if (!person) continue;
    await addTouchpoint({
      userId: user.id,
      personId: pid,
      kind: 'intro_observed',
      occurredAt: intro.at,
      refTable: 'messages',
      refId: intro.messageId,
      summary: `${introducer.firstName} introduced you to ${person.firstName}`,
      weight: 0.3,
    });
    const open = await db.chats
      .where('personId')
      .equals(pid)
      .filter((c) => !ENDED.includes(c.stage))
      .first();
    if (open) {
      // a card already exists: just remember who made the intro, for the opener and the report-back
      if (!open.referrerPersonId)
        await db.chats.update(open.id, {
          referrerPersonId: introducer.id,
          referrerName: introducer.firstName,
          introducedAt: intro.at,
          updatedAt: now.toISOString(),
        });
      else if (open.referrerPersonId === introducer.id && !open.introducedAt)
        await db.chats.update(open.id, { introducedAt: intro.at, updatedAt: now.toISOString() });
      // a card with no thread yet learns the intro thread, so the replies in it reach the card
      if (!open.threadId) await db.chats.update(open.id, { threadId: thread.id });
      continue;
    }
    const chat: CoffeeChat = {
      id: newId('c'),
      userId: user.id,
      personId: pid,
      organizationId: person.currentOrganizationId,
      stage: answered ? 'outreach_sent' : 'identified',
      stageEnteredAt: answered?.sentAt ?? intro.at,
      source: 'reach',
      goalTags: [],
      outreachChannel: 'gmail',
      // the intro thread is where the student answers ("moving Lena to bcc") and where the person replies: the
      // networking pass reads later messages in it into this chat
      threadId: thread.id,
      firstOutreachAt: answered?.sentAt,
      lastOutboundAt: later.filter((x) => x.direction === 'outbound').pop()?.sentAt,
      lastInboundAt: later.filter((x) => x.direction === 'inbound' && x.fromPersonId === pid).pop()?.sentAt,
      bumpCount: 0,
      priority: 2,
      referrerPersonId: introducer.id,
      referrerName: introducer.firstName,
      introducedAt: intro.at,
      createdAt: intro.at,
      updatedAt: now.toISOString(),
    };
    await db.chats.add(chat);
    await db.stageEvents.add({
      id: newId('se'),
      userId: user.id,
      chatId: chat.id,
      toStage: chat.stage,
      status: 'applied',
      actor: 'system',
      reason: answered ? 'intro:answered' : 'intro:received',
      evidenceRefTable: 'messages',
      evidenceRefId: intro.messageId,
      createdAt: chat.stageEnteredAt,
      decidedAt: now.toISOString(),
    });
    await db.recommendations.where('personId').equals(pid).modify({ status: 'converted' });
    opened++;
    await evaluateImmediateSuggestions(user.id, { chatId: chat.id, personId: pid }, now);
  }
  return opened;
}

// ---- the fallback question: "Did Lena introduce you to Sam?" ----------------------------------------------------

/** What makes a touchpoint mean the student knows someone: they wrote, met, took notes, or logged it. */
const KNOWING: ReadonlySet<Touchpoint['kind']> = new Set([
  'email_in',
  'email_out',
  'meeting',
  'linkedin_in',
  'linkedin_out',
  'note',
  'manual_log',
  'intro_observed',
]);

/**
 * Whom the student knew before message `m`: anyone they exchanged email with, met, took notes on or have a card for.
 * Someone already on an earlier message of this same thread is not known, but is not new to the thread either (the
 * introduction, if any, came earlier), so they are returned too. A LinkedIn connection alone is not knowing.
 */
async function knownBefore(
  userId: string,
  thread: EmailThread,
  people: Person[],
  m: EmailMessage,
  personIds: string[],
): Promise<Set<string>> {
  const known = new Set<string>();
  const earlier = (await db.messages.where('threadId').equals(thread.id).toArray()).filter(
    (x) => x.sentAt < m.sentAt,
  );
  for (const pid of personIds) {
    const emails = new Set((people.find((p) => p.id === pid)?.emails ?? []).map((e) => e.toLowerCase()));
    const onEarlier = earlier.some(
      (x) =>
        x.fromPersonId === pid || [...x.toEmails, ...x.ccEmails].some((e) => emails.has(e.toLowerCase())),
    );
    const touches = await db.touchpoints.where('personId').equals(pid).toArray();
    if (
      onEarlier ||
      touches.some((t) => t.occurredAt < m.sentAt && KNOWING.has(t.kind)) ||
      (await db.chats
        .where('personId')
        .equals(pid)
        .filter((c) => c.userId === userId && c.createdAt < m.sentAt)
        .count()) > 0
    )
      known.add(pid);
  }
  return known;
}

/** The question for message `m`, when the fallback asks one (see `possibleIntroduction`). */
async function possibleIntroductionIn(
  userId: string,
  thread: EmailThread,
  people: Person[],
  m: EmailMessage,
  reading: IntroductionReading,
): Promise<PossibleIntroduction | undefined> {
  if (!m.fromPersonId || !reading.possible.length) return undefined;
  const ids = [m.fromPersonId, ...reading.possible.map((p) => p.personId)];
  const known = await knownBefore(userId, thread, people, m, ids);
  return possibleIntroduction(m, reading, {
    senderKnown: known.has(m.fromPersonId),
    knownIds: known,
  });
}

async function askAboutIntroduction(
  userId: string,
  thread: EmailThread,
  q: PossibleIntroduction,
  now: Date,
): Promise<void> {
  thread.possibleIntroduction = {
    introducerId: q.introducerId,
    personIds: q.personIds,
    messageId: q.messageId,
    at: q.at,
    status: 'open',
  };
  await db.threads.update(thread.id, { possibleIntroduction: thread.possibleIntroduction });
  const c = await introductionQuestionCandidate(thread);
  if (c) await upsertSuggestions(userId, [c], now);
}

/** The card for a thread's open question, or undefined when there is none to ask. */
export async function introductionQuestionCandidate(
  thread: EmailThread,
): Promise<(Candidate & { priorityScore: number }) | undefined> {
  const q = thread.possibleIntroduction;
  if (q?.status !== 'open') return undefined;
  const [introducer, ...introduced] = await db.people.bulkGet([q.introducerId, ...q.personIds]);
  const named = introduced.filter((p): p is Person => !!p && !p.hiddenAt);
  if (!introducer || !named.length) return undefined;
  const names =
    named.length === 1
      ? named[0]!.firstName
      : `${named
          .slice(0, -1)
          .map((p) => p.firstName)
          .join(', ')} and ${named[named.length - 1]!.firstName}`;
  return {
    kind: 'confirm_intro',
    personId: named[0]!.id,
    dedupeKey: `introq:${thread.id}`,
    reasonText: `Did ${introducer.firstName} introduce you to ${names}?`,
    signals: {},
    payload: {
      threadId: thread.id,
      messageId: q.messageId,
      introducerId: q.introducerId,
      personIds: q.personIds,
    },
    urgency: 0.3,
    goalRelevance: 0.3,
    confidence: 0.5,
    // low-key: below every card with a message to send
    priorityScore: 0.15,
  };
}

/**
 * Whether a thread's open question is still true: not once an introduction is recorded on the thread, and not once
 * the student has a card for everyone it asks about (they found their own way to the person).
 */
export async function staleIntroductionQuestion(thread: EmailThread): Promise<string | undefined> {
  const q = thread.possibleIntroduction;
  if (q?.status !== 'open') return undefined;
  if (thread.introduction) return 'introduction_recorded';
  let carded = 0;
  for (const pid of q.personIds)
    if (
      await db.chats
        .where('personId')
        .equals(pid)
        .filter((c) => !ENDED.includes(c.stage))
        .first()
    )
      carded++;
  return carded === q.personIds.length ? 'already_in_pipeline' : undefined;
}

/** Retire a thread's open question (its card goes too) because it stopped being true. */
export async function retireIntroductionQuestion(
  thread: EmailThread,
  reason: string,
  now: Date,
): Promise<void> {
  if (thread.possibleIntroduction?.status !== 'open') return;
  await settleIntroductionQuestion(thread, 'retired', now, undefined, reason);
}

/**
 * Close a thread's question: `confirmed` when the student's own reply answered it (raised in this sync or before),
 * `retired` when it stopped being true. A pending card is closed with it.
 */
async function settleIntroductionQuestion(
  thread: EmailThread,
  status: 'confirmed' | 'retired',
  now: Date,
  raised?: PossibleIntroduction,
  reason = 'answered_in_thread',
): Promise<void> {
  const base = thread.possibleIntroduction?.status === 'open' ? thread.possibleIntroduction : raised;
  if (!base) return;
  thread.possibleIntroduction = {
    introducerId: base.introducerId,
    personIds: base.personIds,
    messageId: base.messageId,
    at: base.at,
    status,
    decidedAt: now.toISOString(),
  };
  await db.threads.update(thread.id, { possibleIntroduction: thread.possibleIntroduction });
  await db.suggestions
    .where('dedupeKey')
    .equals(`introq:${thread.id}`)
    .filter((s) => s.status === 'pending' || s.status === 'snoozed')
    .modify(
      status === 'confirmed'
        ? { status: 'done', decidedAt: now.toISOString() }
        : { status: 'expired', expiredReason: reason, decidedAt: now.toISOString() },
    );
}

/**
 * The student's answer to "Did Lena introduce you to Sam?". Yes records the introduction exactly as one read from
 * the email: the thread's introduction (the graph's `introduced_by` edge), a card for each person with the introducer
 * as referrer, and the reply-while-fresh suggestion. No is remembered for the thread, so Orbit never asks again.
 */
export async function answerIntroductionQuestion(
  user: User,
  threadId: string,
  yes: boolean,
  now = new Date(),
): Promise<number> {
  const thread = await db.threads.get(threadId);
  const q = thread?.possibleIntroduction;
  if (!thread || !q) return 0;
  const decided = {
    status: yes ? ('confirmed' as const) : ('dismissed' as const),
    decidedAt: now.toISOString(),
  };
  let opened = 0;
  if (yes && !thread.introduction) {
    const people = (await db.people.bulkGet([q.introducerId, ...q.personIds])).filter(
      (p): p is Person => !!p,
    );
    opened = await applyIntroduction(
      user,
      thread,
      people,
      { introducerId: q.introducerId, introducedIds: q.personIds, messageId: q.messageId, at: q.at },
      now,
    );
    // the answers to an introduction come in its thread
    if (!thread.isNetworking) await db.threads.update(thread.id, { isNetworking: true });
  }
  await db.threads.update(thread.id, { possibleIntroduction: { ...q, ...decided } });
  const cards = await db.suggestions.where('dedupeKey').equals(`introq:${thread.id}`).toArray();
  for (const s of cards)
    await db.suggestions.update(s.id, {
      status: yes ? 'done' : 'dismissed',
      decidedAt: now.toISOString(),
    });
  await feedback(user.id, yes ? 'intro_confirm' : 'intro_reject', {
    suggestionId: cards[0]?.id,
    refTable: 'threads',
    refId: thread.id,
  });
  return opened;
}

export type { SuggestedName, SuggestedNames } from './suggested-names';
export { readSuggestedNames };

/**
 * The names read with confidence from the prep tab's "anyone else I should talk to?" answer ("Priya Shah at Stripe,
 * Tom Lee"). Names the reader is unsure of ("will park", "Dr. Patel") are not here: the prep tab asks the student to
 * confirm them first, then saves them with saveSuggestedContacts.
 */
export function parseSuggestedNames(text: string): SuggestedName[] {
  return readSuggestedNames(text).names;
}

/**
 * The organisations the student already has in Orbit: their contacts' companies, their target companies and their
 * school. The name reader treats a phrase that is one of them as a company, never a person.
 */
export async function knownOrganisations(userId: string): Promise<string[]> {
  const [orgs, targets, user] = await Promise.all([
    db.organizations.toArray(),
    db.targetCompanies.where('userId').equals(userId).toArray(),
    db.users.get(userId),
  ]);
  const names = [...orgs.map((o) => o.name), ...targets.map((t) => t.nameRaw), user?.school ?? ''];
  return [...new Set(names.map((n) => n.trim()).filter(Boolean))];
}

/** Saves the names read with confidence from a typed answer; see saveSuggestedContacts. */
export async function addSuggestedContacts(
  userId: string,
  fromPersonId: string,
  text: string,
  now = new Date(),
): Promise<Person[]> {
  const knownOrgs = await knownOrganisations(userId);
  return saveSuggestedContacts(userId, fromPersonId, readSuggestedNames(text, { knownOrgs }).names, now);
}

/**
 * People the person suggested the student talk to. Each becomes a person (matched by name when already known) with
 * a saved recommendation "Suggested by {first}" and a connection fact the outreach draft opens with; the chat that
 * follows records the suggester as referrer, so the report-back closes the loop.
 */
export async function saveSuggestedContacts(
  userId: string,
  fromPersonId: string,
  suggested: SuggestedName[],
  now = new Date(),
): Promise<Person[]> {
  const from = await db.people.get(fromPersonId);
  if (!from) return [];
  const out: Person[] = [];
  const people = await db.people.where('userId').equals(userId).toArray();
  for (const s of suggested) {
    const known = people.find(
      (p) =>
        p.id !== from.id &&
        !p.hiddenAt &&
        p.displayName.toLowerCase() === s.name.toLowerCase() &&
        (!s.org ||
          !p.currentOrganizationRaw ||
          p.currentOrganizationRaw.toLowerCase() === s.org.toLowerCase()),
    );
    const person =
      known ??
      (await upsertPerson({ userId, displayName: s.name, companyRaw: s.org, source: 'manual' })).person;
    if (person.id === from.id) continue;
    const already = await db.facts
      .where('personId')
      .equals(person.id)
      .filter((f) => f.type === 'connection' && f.sourceTable === 'suggested_by' && f.sourceId === from.id)
      .first();
    if (!already)
      await db.facts.add({
        id: newId('f'),
        userId,
        personId: person.id,
        type: 'connection',
        text: `${from.displayName} suggested I talk with you`,
        sourceTable: 'suggested_by',
        sourceId: from.id,
        occurredAt: now.toISOString(),
        confidence: 1,
        createdAt: now.toISOString(),
      });
    const hasChat = await db.chats
      .where('personId')
      .equals(person.id)
      .filter((c) => c.stage !== 'archived')
      .first();
    if (!hasChat) {
      await db.recommendations
        .where('personId')
        .equals(person.id)
        .filter((r) => r.status === 'new' || r.status === 'saved')
        .delete();
      await db.recommendations.put({
        id: newId('r'),
        userId,
        personId: person.id,
        score: 0.9,
        fitScore: 0.8,
        reachScore: Math.max(0.5, from.strength),
        responsePrior: 0.6,
        reasons: [{ code: 'suggested_by', text: `Suggested by ${from.firstName}` }],
        status: 'saved',
        batchDate: now.toISOString(),
      });
    }
    out.push(person);
  }
  return out;
}
