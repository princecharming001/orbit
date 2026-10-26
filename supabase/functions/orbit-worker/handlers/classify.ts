/**
 * classify.message {messageId} — or {provider, messageId: <provider's id>} from older webhook payloads — runs the
 * reply classifier of ingest/classify.ts on one stored inbound message (§8.3), then the reply's next step
 * (replies.ts `maybeAutoReply`, §8.4): unsubscribe closes the person's chats and cancels their drafts, a class that
 * needs an answer gets a draft, and at autonomy level 2 a scheduling answer that meets every condition is approved and
 * queued to send. A message that is not stored (yet) or not an inbound human message ends the job quietly. Then how
 * warm the reply reads (plan 27, ingest/rapport.ts), and the sender rescored with it: after the reading, so the score
 * never runs ahead of the reply it should count.
 *
 * rapport.backfill {} — a year of the user's stored replies without a reading get one, then everyone is rescored.
 */
import { isUuid } from '../../_shared/crypto.ts';
import { classifyMessage } from '../../_shared/ingest/classify.ts';
import { backfillRapport, readRapport } from '../../_shared/ingest/rapport.ts';
import { maybeAutoReply } from '../../_shared/replies/replies.ts';
import { type AgentConfig, makeServices } from '../../_shared/services.ts';
import type { JobHandler } from '../worker.ts';
import { type HandlerDeps, JobSkipped } from './deps.ts';

export function classifyHandlers(
  deps: HandlerDeps,
  agents: AgentConfig = { env: {} },
): Record<string, JobHandler> {
  return {
    'classify.message': async (job, ctx) => {
      const userId = job.userId;
      if (!userId) throw new JobSkipped('no_user');
      const p = job.payload;
      let id = isUuid(p.messageRowId) ? p.messageRowId : isUuid(p.messageId) ? p.messageId : undefined;
      if (!id && typeof p.messageId === 'string' && (p.provider === 'linkedin' || p.provider === 'gmail')) {
        const [row] = await ctx.db.sql<{ id: string }>`
          select id from orbit.messages
           where user_id = ${userId}::uuid and provider = ${p.provider} and external_id = ${p.messageId}`;
        id = row?.id;
      }
      if (!id) return;
      const r = await classifyMessage(ctx.db, userId, id, { now: ctx.now(), claude: deps.claude });
      if (!r.replyClass) return;
      const { personId } = await readRapport(ctx.db, userId, id, { claude: deps.claude });
      if (personId)
        await ctx.queue.enqueue({
          kind: 'score.person',
          userId,
          payload: { personIds: [personId] },
          dedupeKey: `score.person:${userId}:rapport:${id}`,
        });
      // idempotent per message, so a retry after a failure here classifies again and picks up where it stopped
      await maybeAutoReply(ctx.db, userId, id, {
        services: makeServices(agents, { db: ctx.db, now: ctx.now, queue: ctx.queue }),
      });
    },
    'rapport.backfill': async (job, ctx) => {
      const userId = job.userId;
      if (!userId) throw new JobSkipped('no_user');
      await ctx.queue.setVt(job.queue, job.msgId, 600);
      const n = await backfillRapport(ctx.db, userId, { claude: deps.claude, now: ctx.now() });
      if (n)
        await ctx.queue.enqueue({
          kind: 'score.user',
          userId,
          payload: { reason: 'rapport_backfill' },
          dedupeKey: `score.user:${userId}:rapport_backfill`,
        });
    },
  };
}
