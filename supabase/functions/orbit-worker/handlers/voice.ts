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
 *
 * voice.distill {reason?}
 *   The edits since the last distillation read into notes (Claude, or the plain observations without it), merged so
 *   a forgotten note never comes back. Nightly for everyone with a new edit (orbit.enqueue_voice_distill), through
 *   Message Batches when it can (plan 35 C2); on relearn the last thirty, at once.
 */
import { type AgentConfig, makeServices } from '../../_shared/services.ts';
import { offeredOf, sourcesFor } from '../../_shared/sources/states.ts';
import { distillVoice, EMBED_SENT_LIMIT, embedSent, relearnCard } from '../../_shared/voice/voice.ts';
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
      // plan 43 §3.2: never learned from a source the student switched off
      const src = await sourcesFor(ctx.db, job.userId, offeredOf(config.env));
      await relearnCard(ctx.db, job.userId, ctx.now(), src.excluded.providers);
    },
    'voice.distill': async (job, ctx) => {
      if (!job.userId) throw new JobSkipped('no_user');
      // a relearn reads the last thirty edits again; the nightly job reads only the new ones, through a batch
      const relearn = job.payload.reason === 'relearn';
      await distillVoice(makeServices(config, { db: ctx.db, now: ctx.now, queue: ctx.queue }), job.userId, {
        full: relearn,
        batch: !relearn,
      });
    },
  };
}
