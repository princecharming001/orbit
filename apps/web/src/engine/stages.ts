import type { Actor, ChatStage, CoffeeChat, StageTrigger, Suggestion } from '@orbit/core';
import {
  addBusinessDays,
  businessDaysBetween,
  canTransition,
  decideTransition,
  kindAllowedInStage,
  maxBumpsFor,
  NO_RESPONSE_AFTER_BUMPS_BUSINESS_DAYS,
  NO_RESPONSE_SILENT_BUSINESS_DAYS,
  newId,
  PROPOSE_THRESHOLD,
  sectorOf,
} from '@orbit/core';
import { addTouchpoint, feedback } from '../db/repo';
import { db } from '../db/schema';

/**
 * Retire suggestions the system no longer stands behind (status `expired` with a reason). This is not a user
 * decision: the same dedupeKey may come back as pending when its trigger becomes true again. An untouched draft
 * attached to it is cancelled so it cannot be sent by accident.
 */
export async function retireSuggestions(rows: Suggestion[], reason: string, now = new Date()): Promise<void> {
  for (const s of rows) {
    if (s.status !== 'pending' && s.status !== 'snoozed') continue;
    await db.suggestions.update(s.id, {
      status: 'expired',
      expiredReason: reason,
      decidedAt: now.toISOString(),
    });
    s.status = 'expired';
    s.expiredReason = reason;
    if (s.outboundMessageId) {
      const out = await db.outbound.get(s.outboundMessageId);
      if (out?.status === 'draft') await db.outbound.update(out.id, { status: 'cancelled' });
    }
    await feedback(s.userId, 'expire', { suggestionId: s.id, reason });
  }
}

/** After a chat changes stage: older proposals for it are moot, and so are cards that only made sense before. */
async function settleAfterStageChange(chat: CoffeeChat, to: ChatStage, now: Date): Promise<void> {
  const stale = await db.stageEvents
    .where('chatId')
    .equals(chat.id)
    .filter((e) => e.status === 'proposed')
    .toArray();
  for (const e of stale) {
    await db.stageEvents.update(e.id, {
      status: 'rejected',
      reason: `${e.reason}|superseded:${to}`,
      decidedAt: now.toISOString(),
    });
    const cards = await db.suggestions.where('dedupeKey').equals(`stage:${e.id}`).toArray();
    await retireSuggestions(cards, `superseded:${to}`, now);
  }
  const open = await db.suggestions
    .where('chatId')
    .equals(chat.id)
    .filter(
      (s) =>
        (s.status === 'pending' || s.status === 'snoozed') &&
        s.kind !== 'confirm_stage' &&
        !kindAllowedInStage(s.kind, to),
    )
    .toArray();
  await retireSuggestions(open, `stage:${to}`, now);
}

export async function applyStage(
  chat: CoffeeChat,
  to: ChatStage,
  actor: Actor,
  reason: string,
  opts: {
    confidence?: number;
    evidenceTable?: string;
    evidenceId?: string;
    now?: Date;
    /** when the evidence happened (message sent, meeting ended, note taken); defaults to `now` */
    at?: Date;
  } = {},
): Promise<'applied' | 'proposed' | 'rejected'> {
  const now = opts.now ?? new Date();
  // stage dates follow the evidence, never the sync clock, and never lie in the future
  const evidenceMs = Math.min(now.getTime(), opts.at?.getTime() ?? now.getTime());
  const at = new Date(evidenceMs).toISOString();
  // days-in-stage cannot run backwards past the previous stage change
  const floor = new Date(chat.stageEnteredAt).getTime();
  const enteredAt = new Date(Math.max(evidenceMs, Number.isNaN(floor) ? 0 : floor)).toISOString();
  if (chat.stage === to) return 'rejected';
  if (!canTransition(chat.stage, to, actor)) return 'rejected';
  const confidence = opts.confidence ?? 1;
  const status = actor === 'user' || confidence >= PROPOSE_THRESHOLD ? 'applied' : 'proposed';
  if (status === 'proposed') {
    const dup = await db.stageEvents
      .where('chatId')
      .equals(chat.id)
      .filter((e) => e.status === 'proposed' && e.toStage === to)
      .first();
    if (dup) return 'proposed';
  }
  await db.stageEvents.add({
    id: newId('se'),
    userId: chat.userId,
    chatId: chat.id,
    fromStage: chat.stage,
    toStage: to,
    status,
    actor,
    reason,
    evidenceRefTable: opts.evidenceTable,
    evidenceRefId: opts.evidenceId,
    confidence,
    createdAt: now.toISOString(),
    decidedAt: status === 'applied' ? now.toISOString() : undefined,
  });
  if (status === 'applied') {
    const changes: Partial<CoffeeChat> = {
      stage: to,
      stageEnteredAt: enteredAt,
      updatedAt: now.toISOString(),
    };
    if (to === 'completed' && !chat.completedAt) changes.completedAt = at;
    if (to === 'followed_up' && !chat.followedUpAt) changes.followedUpAt = at;
    if (to === 'archived') changes.archivedAt = at;
    await db.chats.update(chat.id, changes);
    Object.assign(chat, changes);
    await settleAfterStageChange(chat, to, now);
  }
  return status;
}

export async function evaluateTrigger(
  chat: CoffeeChat,
  trig: StageTrigger,
  evidence?: { table: string; id: string },
  now = new Date(),
  at?: Date,
): Promise<'applied' | 'proposed' | 'rejected' | 'none'> {
  const d = decideTransition(chat.stage, trig);
  if (!d) return 'none';
  return applyStage(chat, d.to, 'system', d.reason, {
    confidence: d.confidence,
    evidenceTable: evidence?.table,
    evidenceId: evidence?.id,
    now,
    at,
  });
}

export async function decideProposedStage(
  eventId: string,
  accept: boolean,
  correction?: ChatStage,
): Promise<'applied' | 'rejected' | 'moved_on' | 'none'> {
  const ev = await db.stageEvents.get(eventId);
  if (!ev || ev.status !== 'proposed') return 'none';
  const chat = await db.chats.get(ev.chatId);
  const now = new Date();
  if (!chat) return 'none';
  if (accept && ev.fromStage && chat.stage !== ev.fromStage) {
    // the chat moved on since this was proposed: applying it now would overwrite newer, better evidence
    await db.stageEvents.update(eventId, {
      status: 'rejected',
      reason: `${ev.reason}|superseded:${chat.stage}`,
      decidedAt: now.toISOString(),
    });
    const cards = await db.suggestions.where('dedupeKey').equals(`stage:${eventId}`).toArray();
    await retireSuggestions(cards, `superseded:${chat.stage}`, now);
    return 'moved_on';
  }
  if (accept) {
    await db.stageEvents.update(eventId, { status: 'confirmed', decidedAt: now.toISOString() });
    await applyStage(chat, ev.toStage, 'user', `confirmed:${ev.reason}`, { now });
    await feedback(chat.userId, 'stage_confirm', { refTable: 'stageEvents', refId: eventId });
  } else {
    await db.stageEvents.update(eventId, { status: 'rejected', decidedAt: now.toISOString() });
    if (correction) await applyStage(chat, correction, 'user', `corrected:${ev.reason}`, { now });
    await feedback(chat.userId, 'stage_correct', {
      refTable: 'stageEvents',
      refId: eventId,
      reason: correction,
    });
  }
  await db.suggestions
    .where('dedupeKey')
    .equals(`stage:${eventId}`)
    .modify({ status: 'done', decidedAt: now.toISOString() });
  return accept ? 'applied' : 'rejected';
}

/**
 * The student says they already did what a card suggested (sent the bump or the thank-you from their own mail).
 * Record it as done so the pipeline moves on: a bump counts toward the bump limit, a thank-you closes the chat as
 * followed up, sent times move the chat to scheduling.
 */
export async function recordAlreadyDone(s: Suggestion, now = new Date()): Promise<void> {
  if (!s.chatId) return;
  const chat = await db.chats.get(s.chatId);
  if (!chat) return;
  const iso = now.toISOString();
  const log = async (summary: string) =>
    addTouchpoint({
      userId: chat.userId,
      personId: chat.personId,
      kind: 'manual_log',
      occurredAt: iso,
      refTable: 'suggestions',
      refId: s.id,
      summary,
      weight: 0.3,
    });
  if (s.kind === 'follow_up_bump' && chat.stage === 'outreach_sent') {
    const changes = { bumpCount: chat.bumpCount + 1, lastOutboundAt: iso, updatedAt: iso };
    await db.chats.update(chat.id, changes);
    Object.assign(chat, changes);
    await log('Follow-up sent outside Orbit');
  } else if (s.kind === 'thank_you') {
    await db.chats.update(chat.id, { lastOutboundAt: iso, updatedAt: iso });
    chat.lastOutboundAt = iso;
    await log('Thank-you sent outside Orbit');
    await applyStage(chat, 'followed_up', 'user', 'user:already_did:thank_you', { now });
  } else if (s.kind === 'schedule_propose' || s.kind === 'schedule_confirm') {
    await db.chats.update(chat.id, { lastOutboundAt: iso, updatedAt: iso });
    chat.lastOutboundAt = iso;
    await log('Replied about times outside Orbit');
    await evaluateTrigger(chat, { type: 'outbound_sent', kind: 'schedule' }, undefined, now);
  }
}

/**
 * Timed rules: followed_up → nurturing after 14 days; completed → nurturing 14 days after a chat whose thank-you
 * never got recorded; outreach_sent → no_response after max bumps + 10 business days of silence, or 15 business
 * days (three weeks; holidays and the winter freeze do not count) of silence however many bumps went out. A thread with a reply after the last message is not silent, and an
 * out-of-office return date restarts the clock. The new stage is dated when the timer ran out, not when Orbit
 * noticed.
 */
export async function runTimedStageRules(
  userId: string,
  settingsMaxBumps: number,
  now = new Date(),
): Promise<void> {
  const chats = await db.chats.where('userId').equals(userId).toArray();
  const tz = (await db.users.get(userId))?.timezone;
  for (const c of chats) {
    const person = await db.people.get(c.personId);
    const maxBumps = maxBumpsFor(
      sectorOf({ title: person?.currentTitle, org: person?.currentOrganizationRaw }),
      settingsMaxBumps,
    );
    if (
      c.stage === 'followed_up' &&
      c.followedUpAt &&
      now.getTime() - new Date(c.followedUpAt).getTime() >= 14 * 86_400_000
    )
      await evaluateTrigger(
        c,
        { type: 'timer_followed_up_14d' },
        undefined,
        now,
        new Date(new Date(c.followedUpAt).getTime() + 14 * 86_400_000),
      );
    if (
      c.stage === 'completed' &&
      c.completedAt &&
      now.getTime() - new Date(c.completedAt).getTime() >= 14 * 86_400_000
    )
      await evaluateTrigger(
        c,
        { type: 'timer_completed_14d' },
        undefined,
        now,
        new Date(new Date(c.completedAt).getTime() + 14 * 86_400_000),
      );
    if (
      c.stage === 'outreach_sent' &&
      c.lastOutboundAt &&
      !(c.lastInboundAt && c.lastInboundAt > c.lastOutboundAt)
    ) {
      // silence counts from the last message, or from when an out-of-office person is back
      const fromIso =
        c.bumpNotBefore && c.bumpNotBefore > c.lastOutboundAt ? c.bumpNotBefore : c.lastOutboundAt;
      const from = new Date(fromIso);
      if (from.getTime() > now.getTime()) continue;
      const daysSilent = (now.getTime() - from.getTime()) / 86_400_000;
      const businessDaysSilent = businessDaysBetween(from, now, tz);
      const exhausted = c.bumpCount >= maxBumps;
      const silentAt = addBusinessDays(from, NO_RESPONSE_SILENT_BUSINESS_DAYS, tz);
      const doneAt = exhausted
        ? new Date(
            Math.min(
              silentAt.getTime(),
              addBusinessDays(from, NO_RESPONSE_AFTER_BUMPS_BUSINESS_DAYS, tz).getTime(),
            ),
          )
        : silentAt;
      await evaluateTrigger(
        c,
        { type: 'timer_no_response', bumps: c.bumpCount, maxBumps, daysSilent, businessDaysSilent },
        undefined,
        now,
        doneAt,
      );
    }
  }
}
