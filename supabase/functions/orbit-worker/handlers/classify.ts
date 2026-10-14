/**
 * classify.message {messageId} — or {provider, messageId: <provider's id>} from older webhook payloads — runs the
 * reply classifier of ingest/classify.ts on one stored inbound message (§8.3). A message that is not stored (yet)
 * or not an inbound human message ends the job quietly.
 */
import { isUuid } from '../../_shared/crypto.ts';
import { classifyMessage } from '../../_shared/ingest/classify.ts';
import type { JobHandler } from '../worker.ts';
import { type HandlerDeps, JobSkipped } from './deps.ts';

export function classifyHandlers(deps: HandlerDeps): Record<string, JobHandler> {
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
      await classifyMessage(ctx.db, userId, id, { now: ctx.now(), claude: deps.claude });
    },
  };
}
