/**
 * sources.switch {source, state, pass?, page?, by?} (plan 43 §3.2 item 3): after a student switched an optional source
 * on, off or removed it, or the owner launched or stopped offering it (`by: 'owner'`, one job per student who has it
 * on). No row changed, so the delta rescore would do nothing; this job does all of it:
 *
 *   1. a full rescore of the student's people with a refit, twice: a person's score reads the neighbours' previous
 *      scores, so the first pass scores without them (scores from before the switch, made with the source in or out,
 *      count for nothing) and the second reads the first's. The student then has exactly the scores of a student who
 *      never had the rows of a source now off (the removal test holds this). Each pass goes a page of people at a
 *      time (score.page's size), each page its own run of this job, so a big network stays inside an isolate's CPU
 *      allowance.
 *   2. the friend projection, rebuilt for a student who has a friend (what friends see follows the switch at once)
 *   3. the graph mark: user_marks.graph_version moves, /sync/status reports it as marks.graph, and the browser drops
 *      its cached graph and pulls again from the start
 *
 * Discover's reach is read live from people and tie scores (orbit-api routes/friendsDiscover.ts), so the rescore is
 * all it needs.
 */
import { isUuid } from '../../_shared/crypto.ts';
import { hasActiveFriend, refreshFriendShares } from '../../_shared/friends/shares.ts';
import { scorePeople } from '../../_shared/ingest/score.ts';
import { chunks } from '../../_shared/ingest/util.ts';
import { forgetOffered, sourcesFor } from '../../_shared/sources/states.ts';
import type { JobHandler } from '../worker.ts';
import { type HandlerDeps, JobSkipped, LONG_VT_SEC } from './deps.ts';
import { SCORE_PAGE } from './score.ts';

/** Two passes: the second reads the neighbours' scores the first wrote. */
export const SWITCH_PASSES = 2;

export function sourceHandlers(deps: Pick<HandlerDeps, 'offered'> = {}): Record<string, JobHandler> {
  const offered = deps.offered ?? [];
  return {
    'sources.switch': async (job, ctx) => {
      const userId = job.userId;
      if (!userId || !isUuid(userId)) throw new JobSkipped('no_user');
      await ctx.queue.setVt(job.queue, job.msgId, LONG_VT_SEC);
      const now = ctx.now();
      const pass = Math.max(1, Math.min(SWITCH_PASSES, Number(job.payload.pass ?? 1) || 1));
      const page = Math.max(0, Number(job.payload.page ?? 0) || 0);
      // a later switch supersedes this one: its own job does both passes from the start
      if (typeof job.payload.runKey === 'string') {
        const [mark] = await ctx.db.sql<{ switch_run: string | null }>`
          select switch_run from orbit.user_marks where user_id = ${userId}::uuid`;
        if (mark?.switch_run && mark.switch_run !== job.payload.runKey) return;
      }
      // the owner's launch switch moved (PUT /admin/sources/:source): read it fresh, not from this isolate's minute
      if (job.payload.by === 'owner' && page === 0 && pass === 1) forgetOffered(ctx.db);
      const src = await sourcesFor(ctx.db, userId, offered);
      // the people in use, in a fixed order, so every page of a pass sees the same list
      const ids = (
        await ctx.db.sql<{ id: string }>`
          select p.id from orbit.people p
           where p.user_id = ${userId}::uuid and not p.is_self and p.deleted_at is null and p.merged_into is null
             and orbit.person_in_use(p.sources, p.source_account, ${src.hidden}::text[])
           order by p.id`
      ).map((r) => r.id);
      const pages = chunks(ids, SCORE_PAGE);
      if (page === 0) {
        // the refit first, from the labelled people, as score.user does
        const labelled = (
          await ctx.db.sql<{ person_id: string }>`
            select l.person_id from orbit.tie_labels l where l.user_id = ${userId}::uuid
               and l.person_id = any(${ids}::uuid[])`
        ).map((r) => r.person_id);
        if (labelled.length)
          await scorePeople(ctx.db, userId, {
            now,
            personIds: labelled,
            fit: true,
            sources: src,
            structural: pass > 1,
          });
      }
      const part = pages[page];
      if (part?.length)
        await scorePeople(ctx.db, userId, { now, personIds: part, sources: src, structural: pass > 1 });
      const next =
        page + 1 < pages.length
          ? { pass, page: page + 1 }
          : pass < SWITCH_PASSES
            ? { pass: pass + 1, page: 0 }
            : null;
      if (next) {
        const runKey =
          typeof job.payload.runKey === 'string'
            ? job.payload.runKey
            : (job.dedupeKey ?? `sources.switch:${userId}:${job.msgId}`);
        await ctx.queue.enqueue({
          kind: 'sources.switch',
          userId,
          payload: { ...job.payload, ...next, runKey },
          dedupeKey: `${runKey}:${next.pass}:${next.page}`,
        });
        return;
      }
      if (await hasActiveFriend(ctx.db, userId)) await refreshFriendShares(ctx.db, userId, now, src);
      await ctx.db.sql`select orbit.bump_graph_version(${userId}::uuid)`;
    },
  };
}
