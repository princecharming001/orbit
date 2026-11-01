/**
 * The voice jobs (plan 29 §B2.4, §B4):
 *
 * voice.embed_sent {limit?}
 *   The newest sent messages (200 by default) that have no embedding yet are embedded through the same adapter the
 *   memories use, so the drafts' exemplars have the student's own mail to choose from. /voice/relearn queues it; a
 *   missing model ends it quietly.
 *
 * voice.card {}
 *   The style card learned again from the sent mail the server holds and laid over the stored one (what the student
 *   set by hand wins); /voice/relearn queues it after the embeddings.
 */
import { type AgentConfig, makeServices } from '../../_shared/services.ts';
import { EMBED_SENT_LIMIT, embedSent, relearnCard } from '../../_shared/voice/voice.ts';
import type { JobHandler } from '../worker.ts';
import { JobSkipped } from './deps.ts';

export function voiceHandlers(config: AgentConfig): Record<string, JobHandler> {
  return {
    'voice.embed_sent': async (job, ctx) => {
      if (!job.userId) throw new JobSkipped('no_user');
      const s = makeServices(config, { db: ctx.db, now: ctx.now, queue: ctx.queue });
      const asked = Number(job.payload.limit);
      const limit =
        Number.isInteger(asked) && asked > 0 ? Math.min(asked, EMBED_SENT_LIMIT) : EMBED_SENT_LIMIT;
      await embedSent(ctx.db, s.embed, job.userId, limit);
    },
    'voice.card': async (job, ctx) => {
      if (!job.userId) throw new JobSkipped('no_user');
      await relearnCard(ctx.db, job.userId, ctx.now());
    },
  };
}
