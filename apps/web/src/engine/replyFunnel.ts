/**
 * The reply funnel in the browser (plan 29 §B2.3): the class table from core, run on what the reply check found.
 *
 * Local mode reads this browser's own mail: each chat's newest reply is classified and the table says what follows.
 * A question raises a Needs you card with its words and nothing is drafted; a decline or an unsubscribe closes the
 * chat, marks the person do not contact, tells the student and trips the breaker (the goal's auto sends pause in
 * `settings.autopilotPausedGoals`); a scheduling reply that names a time the student offered books the call through
 * the local calendar invite path, raises the prep card and leaves the confirmation as a draft (or, when the student
 * handed scheduling replies to Orbit, sends it in the recipient's morning); the other classes the brief's rules
 * already cover.
 *
 * Account mode reads the server's replies and status: the server's funnel did the work, so this side raises the same
 * cards here, books a named slot the server has not booked yet (the server's `/calendar/book` is idempotent) and
 * trips the breaker when the server has not. Every reply is handled once, by its id, in db.kv.
 */
import type { CoffeeChat, EmailMessage, ReplyClass, ReplyItem, Suggestion, User } from '@orbit/core';
import { classifyReply, extractProposedTimes, newId, REPLY_NEXT_ACTION } from '@orbit/core';
import { db } from '../db/schema';
import { isServerUser } from '../integrations/orbitApi';
import { autopilotStatus } from './autopilotMode';
import { calendarInvitesAvailable, sendCalendarInvite } from './calendarInvite';
import { latestReply } from './conversation';
import { listGoals, refreshGoals } from './goals';
import { bookCall, listReplies } from './replies';
import { applyStage } from './stages';
import { personZone } from './trust';

/** A named time within this many minutes of an offered slot is that slot. */
export const SLOT_MATCH_MIN = 15;
/** How long the breaker's pause holds when the browser trips it for an account (the server's holds until lifted). */
export const BREAKER_DAYS = 30;
const HANDLED_KV = 'funnel:handled:';

export interface FunnelSummary {
  handled: number;
  needsYou: number;
  closed: number;
  booked: number;
  breakers: number;
}

async function handled(userId: string): Promise<Record<string, string>> {
  return ((await db.kv.get(`${HANDLED_KV}${userId}`))?.value as Record<string, string> | undefined) ?? {};
}

async function markHandled(userId: string, ids: Record<string, string>) {
  await db.kv.put({ key: `${HANDLED_KV}${userId}`, value: ids });
}

async function upsertCard(
  userId: string,
  c: Omit<Suggestion, 'id' | 'userId' | 'status' | 'carriedOver' | 'expiresAt' | 'createdAt'>,
  now: Date,
): Promise<Suggestion> {
  const had = await db.suggestions.where('dedupeKey').equals(c.dedupeKey).first();
  if (had) return had;
  const s: Suggestion = {
    id: newId('s'),
    userId,
    status: 'pending',
    carriedOver: 0,
    expiresAt: new Date(now.getTime() + 14 * 86_400_000).toISOString(),
    createdAt: now.toISOString(),
    ...c,
  };
  await db.suggestions.add(s);
  return s;
}

async function notify(userId: string, title: string, body: string | undefined, link: string, now: Date) {
  await db.notifications.add({
    id: newId('nt'),
    userId,
    kind: 'reply_received',
    title,
    body,
    link,
    createdAt: now.toISOString(),
  });
}

/** The question a reply asked: the first sentence ending in a question mark, else the first 200 characters. */
export function questionIn(text: string): string {
  const sentence = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .find((s) => s.endsWith('?'));
  return (sentence ?? text.trim().slice(0, 200)).replace(/\s+/g, ' ');
}

/** The offered slot a reply names, when one does. */
export function matchOfferedSlot(
  text: string,
  offered: string[],
  reference: Date,
  tz?: string,
): string | undefined {
  for (const p of extractProposedTimes(text, reference, tz)) {
    const t = Date.parse(p.startIso);
    const hit = offered.find((o) => Math.abs(Date.parse(o) - t) <= SLOT_MATCH_MIN * 60_000);
    if (hit) return hit;
  }
  return undefined;
}

/** The goal a breaker pauses for this person: the chat's, else the student's first active goal. */
async function goalFor(
  userId: string,
  chat: CoffeeChat | undefined,
): Promise<{ id: string; title: string } | undefined> {
  if (chat?.goalId) {
    const g = await db.userGoals.get(chat.goalId);
    if (g) return { id: g.id, title: g.title };
  }
  let goals = await listGoals(userId);
  // an account whose goals have not been pulled yet: the server's list
  if (!goals.length && isServerUser(userId)) {
    await refreshGoals(userId).catch(() => undefined);
    goals = await listGoals(userId);
  }
  const first = goals.find((g) => g.status === 'active') ?? goals[0];
  return first ? { id: first.id, title: first.title } : undefined;
}

/**
 * The breaker (plan 29 §B2.7) in this browser: the goal's auto sends pause in the settings row (for an account also
 * on the server, through `pauseAutopilot`), the queued autopilot sends of that goal go back to drafts, and a card
 * tells the student in one sentence.
 */
export async function tripBreaker(
  user: Pick<User, 'id'>,
  p: {
    reason: 'unsubscribe' | 'declines' | 'bounce' | 'send_error';
    personId: string | null;
    personName: string;
    company?: string | null;
    goal: { id: string; title: string } | undefined;
    messageId: string;
    now: Date;
    /** the server already paused this goal: only the card is raised here */
    serverPaused?: boolean;
  },
): Promise<boolean> {
  const what = {
    unsubscribe: 'asked to stop',
    declines: 'declined, the second today',
    bounce: 'bounced',
    send_error: 'could not be sent to',
  }[p.reason];
  const where = p.company?.trim() || p.goal?.title || 'first messages';
  const text = `${p.personName} ${what}. Paused ${where}${p.company?.trim() || p.goal ? ' first messages' : ''}.`;
  const settings = await db.settings.get(user.id);
  const goals = { ...(settings?.autopilotPausedGoals ?? {}) };
  if (p.goal && !goals[p.goal.id] && !p.serverPaused) {
    const until = isServerUser(user.id)
      ? new Date(p.now.getTime() + BREAKER_DAYS * 86_400_000).toISOString()
      : null;
    goals[p.goal.id] = { reason: p.reason, text, until, at: p.now.toISOString() };
    await db.settings.update(user.id, { autopilotPausedGoals: goals });
    const { cancelScheduled } = await import('./autopilot');
    const queued = await db.outbound
      .where('userId')
      .equals(user.id)
      .filter((o) => o.status === 'queued' && !!o.autopilot && o.goalId === p.goal!.id)
      .toArray();
    for (const q of queued) await cancelScheduled(user.id, q.id);
    if (isServerUser(user.id)) {
      const { pauseAutopilot } = await import('./autopilotMode');
      await pauseAutopilot(user, { until, goalId: p.goal.id }, p.now).catch(() => undefined);
    }
  }
  await upsertCard(
    user.id,
    {
      kind: 'breaker',
      dedupeKey: `breaker:${p.goal?.id ?? 'account'}:${p.messageId}`,
      personId: p.personId ?? undefined,
      priorityScore: 0.9,
      reasonText: `${text} Read it?`,
      signals: { reason: p.reason, goalId: p.goal?.id ?? null },
      payload: {
        goalId: p.goal?.id ?? null,
        title: p.goal?.title,
        reason: p.reason,
        personName: p.personName,
        company: p.company ?? null,
        text,
      },
    },
    p.now,
  );
  await notify(user.id, text, undefined, p.personId ? `/people/${p.personId}` : '/inbox', p.now);
  return true;
}

/** Declines handled today for this goal (the second trips the breaker). */
async function declinesToday(userId: string, goalId: string | undefined, now: Date): Promise<number> {
  const day = now.toDateString();
  return db.suggestions
    .where('userId')
    .equals(userId)
    .filter(
      (s) =>
        s.kind === 'needs_you' &&
        s.payload.closed === true &&
        s.payload.replyClass === 'decline' &&
        new Date(s.createdAt).toDateString() === day &&
        (!goalId || s.payload.goalId === goalId),
    )
    .count();
}

/** A decline or an unsubscribe (plan 29 §B2.3): close, do not contact, tell, and the breaker. */
async function closeOnReply(
  user: Pick<User, 'id'>,
  p: {
    cls: 'decline' | 'unsubscribe';
    personId: string;
    personName: string;
    company: string | null;
    chat: CoffeeChat | undefined;
    messageId: string;
    now: Date;
    serverPaused?: boolean;
  },
): Promise<void> {
  const person = await db.people.get(p.personId);
  if (person && !person.doNotContact) await db.people.update(person.id, { doNotContact: true });
  if (p.chat && p.chat.stage !== 'declined' && p.chat.stage !== 'archived')
    await applyStage(
      p.chat,
      'declined',
      'system',
      p.cls === 'unsubscribe' ? 'asked not to be contacted' : 'declined',
      {
        evidenceTable: 'messages',
        evidenceId: p.messageId,
      },
    ).catch(() => undefined);
  const { cancelScheduled } = await import('./autopilot');
  const queued = await db.outbound
    .where('personId')
    .equals(p.personId)
    .filter((o) => o.userId === user.id && (o.status === 'queued' || o.status === 'draft'))
    .toArray();
  for (const q of queued)
    if (q.status === 'queued') await cancelScheduled(user.id, q.id);
    else await db.outbound.update(q.id, { status: 'cancelled', error: p.cls });
  const goal = await goalFor(user.id, p.chat);
  await upsertCard(
    user.id,
    {
      kind: 'needs_you',
      dedupeKey: `closed:${p.messageId}`,
      personId: p.personId,
      chatId: p.chat?.id,
      priorityScore: 0.6,
      reasonText: `${p.personName} ${p.cls === 'unsubscribe' ? 'asked to stop' : 'declined'}. Orbit closed the thread and will not write to them again.`,
      signals: { replyClass: p.cls, closed: true },
      payload: {
        replyClass: p.cls,
        closed: true,
        personName: p.personName,
        company: p.company,
        messageId: p.messageId,
        goalId: goal?.id ?? null,
      },
    },
    p.now,
  );
  const trips = p.cls === 'unsubscribe' || (await declinesToday(user.id, goal?.id, p.now)) >= 2;
  if (trips)
    await tripBreaker(user, {
      reason: p.cls === 'unsubscribe' ? 'unsubscribe' : 'declines',
      personId: p.personId,
      personName: p.personName,
      company: p.company,
      goal,
      messageId: p.messageId,
      now: p.now,
      serverPaused: p.serverPaused,
    });
}

/** Needs you (plan 29 §B2.3): the card with the question, and a notification. */
async function raiseNeedsYou(
  user: Pick<User, 'id'>,
  p: {
    personId: string;
    personName: string;
    company: string | null;
    chat?: CoffeeChat;
    messageId: string;
    draftId?: string;
    question: string;
    now: Date;
  },
): Promise<void> {
  await upsertCard(
    user.id,
    {
      kind: 'needs_you',
      dedupeKey: `needs_you:${p.messageId}`,
      personId: p.personId,
      chatId: p.chat?.id,
      priorityScore: 0.85,
      reasonText: `${p.personName} asked: "${p.question}" What should I say?`,
      signals: { replyClass: 'question' },
      payload: {
        question: p.question,
        personName: p.personName,
        company: p.company,
        messageId: p.messageId,
        draftId: p.draftId,
        replyClass: 'question',
      },
    },
    p.now,
  );
  await notify(
    user.id,
    `${p.personName.split(' ')[0]} asked one thing`,
    'Answer it in one line and Orbit drafts the reply.',
    '/inbox',
    p.now,
  );
}

/** The prep card for a call just booked, the way plan 22 raises it: from the chat's event, at once. */
async function raisePrepCard(user: User, chat: CoffeeChat, eventId: string, startAt: string, now: Date) {
  const person = await db.people.get(chat.personId);
  await upsertCard(
    user.id,
    {
      kind: 'prep_brief',
      dedupeKey: `prep:${eventId}`,
      personId: chat.personId,
      chatId: chat.id,
      priorityScore: 0.9,
      reasonText: `Chat with ${person?.firstName ?? 'them'} is booked for ${new Date(startAt).toLocaleString(
        'en-US',
        {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
          timeZone: user.timezone || undefined,
        },
      )}. Prep takes two minutes.`,
      signals: { startAt },
      payload: { eventId },
    },
    now,
  );
}

/** The times the student offered this person: what their last outbound message in the thread proposed. */
async function offeredSlotsLocal(chat: CoffeeChat, user: User): Promise<string[]> {
  if (!chat.threadId) return [];
  const msgs = await db.messages.where('threadId').equals(chat.threadId).sortBy('sentAt');
  const mine = [...msgs].reverse().find((m) => m.direction === 'outbound');
  if (!mine) return [];
  return extractProposedTimes(mine.bodyText, new Date(mine.sentAt), user.timezone || undefined).map(
    (t) => t.startIso,
  );
}

/** Local mode: a scheduling reply that names an offered slot books the call here and leaves the confirmation. */
async function bookLocal(
  user: User,
  chat: CoffeeChat,
  reply: EmailMessage,
  slotStart: string,
  now: Date,
): Promise<boolean> {
  if (!calendarInvitesAvailable(user)) return false;
  const r = await sendCalendarInvite(user, chat, { at: new Date(slotStart), now });
  if (!r.ok) return false;
  await raisePrepCard(user, chat, r.event.id, r.event.startAt, now);
  const person = await db.people.get(chat.personId);
  const label = new Date(slotStart).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: (person && personZone(person)) || user.timezone || undefined,
  });
  const draft = {
    id: newId('out'),
    userId: user.id,
    personId: chat.personId,
    chatId: chat.id,
    goalId: chat.goalId,
    channel: 'gmail' as const,
    kind: 'schedule' as const,
    externalThreadId: chat.threadId ? (await db.threads.get(chat.threadId))?.externalThreadId : undefined,
    inReplyToMessageId: reply.externalMessageId,
    toEmail: person?.primaryEmail,
    bodyDraft:
      `Hi ${person?.firstName ?? 'there'},\n\n${label} works for me, and the calendar invite is on its way. Looking forward to it.\n\nBest,\n${user.firstName ?? ''}`.trim(),
    status: 'draft' as const,
    generatedBy: 'template' as const,
    draftedAt: now.toISOString(),
    createdAt: now.toISOString(),
  };
  await db.outbound.add(draft);
  const card = await upsertCard(
    user.id,
    {
      kind: 'schedule_confirm',
      dedupeKey: `confirm:${reply.id}`,
      personId: chat.personId,
      chatId: chat.id,
      outboundMessageId: draft.id,
      priorityScore: 0.8,
      reasonText: `${person?.firstName ?? 'They'} picked ${label}. The call is booked; this confirms it.`,
      signals: { startAt: slotStart },
      payload: { time: { startIso: slotStart }, messageId: reply.id },
    },
    now,
  );
  await db.outbound.update(draft.id, { suggestionId: card.id });
  // the ladder (plan 23 §4.9): a scheduling reply the student handed over goes on its own in their morning
  const { maybeAutoSend } = await import('./trust');
  await maybeAutoSend(user, card, now, draft.id).catch(() => undefined);
  return true;
}

/** Local mode: every chat whose newest reply has not been handled yet, through the table. */
export async function runLocalFunnel(user: User, now = new Date()): Promise<FunnelSummary> {
  const out: FunnelSummary = { handled: 0, needsYou: 0, closed: 0, booked: 0, breakers: 0 };
  const done = await handled(user.id);
  const chats = await db.chats
    .where('userId')
    .equals(user.id)
    .filter((c) => !!c.lastInboundAt && !c.archivedAt && c.stage !== 'declined' && c.stage !== 'archived')
    .toArray();
  for (const chat of chats) {
    const reply = await latestReply(chat);
    if (!reply || done[reply.id] || reply.direction !== 'inbound') continue;
    const person = await db.people.get(chat.personId);
    if (!person) continue;
    const cls: ReplyClass =
      (reply.replyClass as ReplyClass | undefined) ??
      classifyReply(reply.bodyText, { now: new Date(reply.sentAt), timeZone: user.timezone || undefined })
        .class;
    const step = REPLY_NEXT_ACTION[cls];
    done[reply.id] = now.toISOString();
    out.handled++;
    const company = person.currentOrganizationRaw ?? null;
    if (cls === 'decline' || cls === 'unsubscribe') {
      const before = Object.keys((await db.settings.get(user.id))?.autopilotPausedGoals ?? {}).length;
      await closeOnReply(user, {
        cls,
        personId: person.id,
        personName: person.displayName,
        company,
        chat,
        messageId: reply.id,
        now,
      });
      out.closed++;
      if (Object.keys((await db.settings.get(user.id))?.autopilotPausedGoals ?? {}).length > before)
        out.breakers++;
      continue;
    }
    if (step.action === 'needs_you') {
      await raiseNeedsYou(user, {
        personId: person.id,
        personName: person.displayName,
        company,
        chat,
        messageId: reply.id,
        question: questionIn(reply.bodyText),
        now,
      });
      out.needsYou++;
      continue;
    }
    if (cls === 'scheduling') {
      const offered = await offeredSlotsLocal(chat, user);
      const slot = offered.length
        ? matchOfferedSlot(
            reply.bodyText,
            offered,
            new Date(reply.sentAt),
            personZone(person) ?? user.timezone,
          )
        : undefined;
      if (slot && Date.parse(slot) > now.getTime() && (await bookLocal(user, chat, reply, slot, now)))
        out.booked++;
    }
  }
  await markHandled(user.id, done);
  return out;
}

/** Account mode: the server's replies and status, mirrored as cards here; a named slot booked when the server has not. */
export async function runAccountFunnel(user: User, now = new Date()): Promise<FunnelSummary> {
  const out: FunnelSummary = { handled: 0, needsYou: 0, closed: 0, booked: 0, breakers: 0 };
  const [replies, status] = await Promise.all([listReplies(user), autopilotStatus(user, now)]);
  if (!replies.ok) return out;
  const done = await handled(user.id);
  const pausedGoals = new Set(status.ok ? status.status.pausedGoals.map((g) => g.goalId) : []);
  for (const r of replies.replies as ReplyItem[]) {
    if (done[r.messageId]) continue;
    done[r.messageId] = now.toISOString();
    out.handled++;
    const chat = r.personId
      ? (await db.chats.where('personId').equals(r.personId).toArray()).find((c) => !c.archivedAt)
      : undefined;
    if (r.replyClass === 'question') {
      if (r.answer) continue;
      await raiseNeedsYou(user, {
        personId: r.personId ?? '',
        personName: r.personName,
        company: r.company ?? null,
        chat,
        messageId: r.messageId,
        draftId: r.draftId ?? undefined,
        question: r.question ?? questionIn(r.snippet),
        now,
      });
      out.needsYou++;
      continue;
    }
    if (r.replyClass === 'decline' || r.replyClass === 'unsubscribe') {
      const goal = await goalFor(user.id, chat);
      await closeOnReply(user, {
        cls: r.replyClass,
        personId: r.personId ?? '',
        personName: r.personName,
        company: r.company ?? null,
        chat,
        messageId: r.messageId,
        now,
        serverPaused: !!goal && pausedGoals.has(goal.id),
      });
      out.closed++;
      continue;
    }
    if (r.replyClass === 'scheduling' && r.offered?.slots.length && r.outcome !== 'booked') {
      const slot = matchOfferedSlot(
        r.snippet,
        r.offered.slots,
        new Date(r.receivedAt),
        user.timezone || undefined,
      );
      if (slot && Date.parse(slot) > now.getTime()) {
        const b = await bookCall(user, r.offered.draftId, slot);
        if (b.ok && b.eventId) {
          out.booked++;
          // the event is here at once (the next pull brings the same row), so the prep rule (plan 22) keeps the card
          // it raises from it; the card's key is the rule's own
          const evId = `ev_${b.eventId}`;
          const person = r.personId ? await db.people.get(r.personId) : undefined;
          if (!(await db.events.get(evId)))
            await db.events.put({
              id: evId,
              userId: user.id,
              externalEventId: b.eventId,
              title: `Coffee chat with ${r.personName}`,
              startAt: new Date(slot).toISOString(),
              endAt: new Date(Date.parse(slot) + 30 * 60_000).toISOString(),
              status: 'confirmed',
              attendees: person?.primaryEmail
                ? [{ email: person.primaryEmail, displayName: r.personName }]
                : [],
              attendeePersonIds: r.personId ? [r.personId] : [],
              inviteSentAt: now.toISOString(),
              isCoffeeChat: true,
              coffeeChatConfidence: 0.95,
              chatId: chat?.id,
            });
          if (chat) await raisePrepCard(user, chat, evId, slot, now);
          else
            await upsertCard(
              user.id,
              {
                kind: 'prep_brief',
                dedupeKey: `prep:${evId}`,
                personId: r.personId ?? undefined,
                priorityScore: 0.9,
                reasonText: `Chat with ${r.personName.split(' ')[0]} is booked for ${new Date(slot).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: user.timezone || undefined })}. Prep takes two minutes.`,
                signals: { startAt: new Date(slot).toISOString() },
                payload: { eventId: evId, personName: r.personName },
              },
              now,
            );
        }
      }
    }
  }
  await markHandled(user.id, done);
  return out;
}

/** The funnel for this student, by mode. Never throws. */
export async function runReplyFunnel(user: User, now = new Date()): Promise<FunnelSummary> {
  try {
    return isServerUser(user.id) ? await runAccountFunnel(user, now) : await runLocalFunnel(user, now);
  } catch {
    return { handled: 0, needsYou: 0, closed: 0, booked: 0, breakers: 0 };
  }
}
