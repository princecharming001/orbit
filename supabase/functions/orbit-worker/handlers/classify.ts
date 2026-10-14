/**
 * classify.message {messageId} — or {provider, messageId: <provider's id>} from older webhook payloads — runs the
 * reply classifier of ingest/classify.ts on one stored inbound message (§8.3), then the reply's next step
 * (replies.ts `maybeAutoReply`, §8.4): unsubscribe closes the person's chats and cancels their drafts, a class that
 * needs an answer gets a draft, and at autonomy level 2 a scheduling answer that meets every condition is approved and
 * queued to send. A message that is not stored (yet) or not an inbound human message ends the job quietly.
 */
import { isUuid } from '../../_shared/crypto.ts';
import { classifyMessage } from '../../_shared/ingest/classify.ts';
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
      // idempotent per message, so a retry after a failure here classifies again and picks up where it stopped
      await maybeAutoReply(ctx.db, userId, id, {
        services: makeServices(agents, { db: ctx.db, now: ctx.now, queue: ctx.queue }),
      });
    },
  };
}
