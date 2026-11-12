/**
 * funnel.reply {messageId} (plan 29 §B2.3): classify.message queues this for an interested or scheduling reply. The
 * funnel offers slots, books a named one when the calendar is free, drafts the confirmation and lets the rules say
 * whether it goes on its own. Idempotent per message.
 *
 * outcomes.roll {} (plan 29 §B2.5): once an hour, for every user, a sent message with no reply after QUIET_DAYS is
 * marked `silent`; the weekly review reads the outcomes by kind.
 */
import { QUIET_DAYS } from '@orbit/core/pipeline/cadence';
import { sourceOfProvider } from '@orbit/core/sources';
import { isUuid } from '../../_shared/crypto.ts';
import type { Db } from '../../_shared/db.ts';
import { runReplyFunnel } from '../../_shared/replies/funnel.ts';
import { type AgentConfig, makeServices } from '../../_shared/services.ts';
import { offeredOf, sourcesFor } from '../../_shared/sources/states.ts';
import type { JobHandler } from '../worker.ts';
import { JobSkipped } from './deps.ts';

export function funnelReplyHandler(config: AgentConfig): JobHandler {
  return async (job, ctx) => {
    if (!job.userId) throw new JobSkipped('no_user');
    const id = job.payload.messageId;
    if (!isUuid(id)) throw new JobSkipped('no_message');
    // plan 43 §3.2: a reply that came on an optional source out of use moves nothing and drafts nothing
    const [m] = await ctx.db.sql<{ provider: string }>`
      select provider from orbit.messages where id = ${id}::uuid and user_id = ${job.userId}::uuid`;
    const source = sourceOfProvider(m?.provider);
    if (source && !(await sourcesFor(ctx.db, job.userId, offeredOf(config.env))).inUse.has(source))
      throw new JobSkipped('source_off');
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
