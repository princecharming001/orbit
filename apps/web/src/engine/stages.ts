import type { Actor, ChatStage, CoffeeChat, StageTrigger } from '@orbit/core';
import {
  canTransition,
  decideTransition,
  maxBumpsFor,
  newId,
  PROPOSE_THRESHOLD,
  sectorOf,
} from '@orbit/core';
import { feedback } from '../db/repo';
import { db } from '../db/schema';

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
    /** When the evidence happened (a message's sentAt, an event's end). The stage is entered then, not at ingest. */
    at?: string;
  } = {},
): Promise<'applied' | 'proposed' | 'rejected'> {
  const now = opts.now ?? new Date();
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
    const enteredAt = evidenceTime(opts.at, now);
    const changes: Partial<CoffeeChat> = {
      stage: to,
      stageEnteredAt: enteredAt,
      updatedAt: now.toISOString(),
    };
    if (to === 'completed' && !chat.completedAt) changes.completedAt = enteredAt;
    if (to === 'followed_up' && !chat.followedUpAt) changes.followedUpAt = enteredAt;
    if (to === 'archived') changes.archivedAt = now.toISOString();
    await db.chats.update(chat.id, changes);
    Object.assign(chat, changes);
  }
  return status;
}

/** The evidence timestamp when it is valid and not in the future, else now. */
function evidenceTime(at: string | undefined, now: Date): string {
  const t = at ? new Date(at).getTime() : Number.NaN;
  return Number.isFinite(t) && t <= now.getTime() ? new Date(t).toISOString() : now.toISOString();
}

export async function evaluateTrigger(
  chat: CoffeeChat,
  trig: StageTrigger,
  evidence?: { table: string; id: string; at?: string },
  now = new Date(),
): Promise<'applied' | 'proposed' | 'rejected' | 'none'> {
  const d = decideTransition(chat.stage, trig);
  if (!d) return 'none';
  return applyStage(chat, d.to, 'system', d.reason, {
    confidence: d.confidence,
    evidenceTable: evidence?.table,
    evidenceId: evidence?.id,
    now,
    at: evidence?.at,
  });
}

export async function decideProposedStage(
  eventId: string,
  accept: boolean,
  correction?: ChatStage,
): Promise<void> {
  const ev = await db.stageEvents.get(eventId);
  if (!ev || ev.status !== 'proposed') return;
  const chat = await db.chats.get(ev.chatId);
  const now = new Date();
  if (!chat) return;
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
}

/** Timed rules: followed_up → nurturing after 14 days; outreach_sent → no_response after max bumps + 14 days. */
export async function runTimedStageRules(
  userId: string,
  settingsMaxBumps: number,
  now = new Date(),
): Promise<void> {
  const chats = await db.chats.where('userId').equals(userId).toArray();
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
      await evaluateTrigger(c, { type: 'timer_followed_up_14d' }, undefined, now);
    if (c.stage === 'outreach_sent' && c.lastOutboundAt) {
      const daysSilent = (now.getTime() - new Date(c.lastOutboundAt).getTime()) / 86_400_000;
      await evaluateTrigger(
        c,
        { type: 'timer_no_response', bumps: c.bumpCount, maxBumps, daysSilent },
        undefined,
        now,
      );
    }
  }
}
