/**
 * Tie scores (§2.3, §3):
 *   score.person {personIds | personId}   after new mail, meetings or LinkedIn activity: the interaction ties of
 *                                         those people are recounted, then they are re-scored
 *   score.user                            nightly and after a backfill: the user's calibration is refit when they
 *                                         have ≥ 8 labels, then everyone is re-scored a page at a time (score.page:
 *                                         every inferred tie kind rebuilt with decay for the page, then its scores);
 *                                         the last page of a user with a friend rebuilds their friend projection,
 *                                         so a fresh backfill reaches friends the same day
 */

import { isUuid } from '../../_shared/crypto.ts';
import { hasActiveFriend, shareRefreshKey } from '../../_shared/friends/shares.ts';
import { scorePeople } from '../../_shared/ingest/score.ts';
import { refreshTies } from '../../_shared/ingest/ties.ts';
import { chunks } from '../../_shared/ingest/util.ts';
import type { JobHandler } from '../worker.ts';
import { type HandlerDeps, JobSkipped, LONG_VT_SEC } from './deps.ts';

/**
 * People scored per nightly page: a page's ties and scores are one short job, under the isolate's CPU allowance.
 * 300 a page often did not finish inside 2 s of CPU (plan 34 A7), so a page is 100.
 */
export const SCORE_PAGE = 100;

export function scoreHandlers(_deps: HandlerDeps): Record<string, JobHandler> {
  return {
    'score.person': async (job, ctx) => {
      if (!job.userId) throw new JobSkipped('no_user');
      const raw = Array.isArray(job.payload.personIds) ? job.payload.personIds : [job.payload.personId];
      const ids = [...new Set(raw.filter(isUuid))];
      if (!ids.length) return;
      // a long list (a backfill's touched people) goes a page at a time, the rest as its own job
      const [now_, rest] = [ids.slice(0, SCORE_PAGE), ids.slice(SCORE_PAGE)];
      if (rest.length)
        await ctx.queue.enqueue({ kind: 'score.person', userId: job.userId, payload: { personIds: rest } });
      const now = ctx.now();
      await refreshTies(ctx.db, job.userId, now, { personIds: now_ });
      await scorePeople(ctx.db, job.userId, { now, personIds: now_ });
    },
    /**
     * The nightly rebuild, paged (the whole of it in one isolate exceeded the CPU allowance and died every night):
     * the calibration is refit first from the labelled people, then every page of people gets its own score.page
     * job, which rebuilds that page's ties of every kind and scores them.
     */
    'score.user': async (job, ctx) => {
      if (!job.userId) throw new JobSkipped('no_user');
      await ctx.queue.setVt(job.queue, job.msgId, LONG_VT_SEC);
      const now = ctx.now();
      const ids = (
        await ctx.db.sql<{ id: string }>`
          select id from orbit.people
           where user_id = ${job.userId}::uuid and deleted_at is null and merged_into is null and not is_self
           order by id`
      ).map((r) => r.id);
      const labelled = (
        await ctx.db.sql<{ person_id: string }>`
          select person_id from orbit.tie_labels where user_id = ${job.userId}::uuid`
      ).map((r) => r.person_id);
      if (labelled.length) await scorePeople(ctx.db, job.userId, { now, personIds: labelled, fit: true });
      const pages = chunks(ids, SCORE_PAGE);
      const runKey = job.dedupeKey ?? `score.user:${job.userId}:${now.toISOString()}`;
      for (const [i, personIds] of pages.entries())
        await ctx.queue.enqueue({
          kind: 'score.page',
          userId: job.userId,
          payload: { personIds, page: i, pages: pages.length },
          dedupeKey: `${runKey}:page:${i}`,
        });
      if (!pages.length) await refreshTies(ctx.db, job.userId, now);
    },
    'score.page': async (job, ctx) => {
      if (!job.userId) throw new JobSkipped('no_user');
      const raw = Array.isArray(job.payload.personIds) ? job.payload.personIds : [];
      const ids = [...new Set(raw.filter(isUuid))];
      const now = ctx.now();
      if (ids.length) {
        await refreshTies(ctx.db, job.userId, now, { personIds: ids, allKinds: true });
        await scorePeople(ctx.db, job.userId, { now, personIds: ids });
      }
      // the last page: a user with a friend has their friend projection rebuilt, so a fresh backfill reaches friends
      // the same day
      const page = Number(job.payload.page);
      const pages = Number(job.payload.pages);
      if (
        Number.isFinite(page) &&
        Number.isFinite(pages) &&
        page === pages - 1 &&
        (await hasActiveFriend(ctx.db, job.userId))
      )
        await ctx.queue.enqueue({
          kind: 'friend_shares_refresh',
          userId: job.userId,
          payload: {},
          dedupeKey: shareRefreshKey(job.userId, now, 'score'),
        });
    },
  };
}
