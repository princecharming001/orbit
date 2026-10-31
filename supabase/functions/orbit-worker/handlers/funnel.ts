/**
 * funnel.reply {messageId} (plan 29 §B2.3): classify.message queues this for an interested or scheduling reply. The
 * funnel offers slots, books a named one when the calendar is free, drafts the confirmation and lets the rules say
 * whether it goes on its own. Idempotent per message.
 *
 * outcomes.roll {} (plan 29 §B2.5): once an hour, for every user, a sent message with no reply after QUIET_DAYS is
 * marked `silent`; the weekly review reads the outcomes by kind.
 */
import { QUIET_DAYS } from '@orbit/core/pipeline/cadence';
import { isUuid } from '../../_shared/crypto.ts';
import type { Db } from '../../_shared/db.ts';
import { runReplyFunnel } from '../../_shared/replies/funnel.ts';
import { type AgentConfig, makeServices } from '../../_shared/services.ts';
import type { JobHandler } from '../worker.ts';
import { JobSkipped } from './deps.ts';

export function funnelReplyHandler(config: AgentConfig): JobHandler {
  return async (job, ctx) => {
    if (!job.userId) throw new JobSkipped('no_user');
    const id = job.payload.messageId;
    if (!isUuid(id)) throw new JobSkipped('no_message');
    await runReplyFunnel(
      makeServices(config, { db: ctx.db, now: ctx.now, queue: ctx.queue }),
      job.userId,
      id,
    );
  };
}

/** Sent drafts with no reply after QUIET_DAYS become `silent`; returns how many changed. */
export async function rollOutcomes(db: Db, now: Date, userId?: string): Promise<number> {
  const before = new Date(now.getTime() - QUIET_DAYS * 86_400_000);
  const rows = await db.sql<{ id: string }>`
    update orbit.drafts set outcome = 'silent'
     where status = 'sent' and outcome is null and replied_at is null and sent_at <= ${before}::timestamptz
       and kind <> 'forwardable_blurb'
       and (${userId ?? null}::uuid is null or user_id = ${userId ?? null}::uuid)
    returning id`;
  return rows.length;
}

export function outcomesRollHandler(): JobHandler {
  return async (job, ctx) => {
    await rollOutcomes(ctx.db, ctx.now(), job.userId ?? undefined);
  };
}
