/**
 * Tie scores (§2.3, §3):
 *   score.person {personIds | personId}   after new mail, meetings or LinkedIn activity: the interaction ties of
 *                                         those people are recounted, then they are re-scored
 *   score.user {full?}                    nightly and after a backfill: the user's calibration is refit when they
 *                                         have ≥ 8 labels, then the ties are inferred once for the whole network,
 *                                         one tie group a job (score.ties, plan 35 B1: the whole inference in one
 *                                         isolate does not fit its CPU allowance on a big network), and the last of
 *                                         those queues score.page jobs for the people whose score can have moved
 *                                         (delta scoring: never scored, or an input newer than their scored_at), or
 *                                         for everyone when `full` is asked, the calibration moved, or someone's
 *                                         score is a week old
 *   score.page {personIds}                scores one page from the stored ties, no inference; the last page of a
 *                                         user with a friend rebuilds their friend projection, so a fresh backfill
 *                                         reaches friends the same day
 */

import { isUuid } from '../../_shared/crypto.ts';
import { hasActiveFriend, shareRefreshKey } from '../../_shared/friends/shares.ts';
import { changedPeople, fullRescoreDue, readCalibration, scorePeople } from '../../_shared/ingest/score.ts';
import { refreshTies, TIE_GROUPS } from '../../_shared/ingest/ties.ts';
import { chunks } from '../../_shared/ingest/util.ts';
import type { JobHandler } from '../worker.ts';
import { type HandlerDeps, JobSkipped, LONG_VT_SEC } from './deps.ts';

/**
 * People scored per nightly page: a page's scores are one short job, under the isolate's CPU allowance. 300 a page
 * often did not finish inside 2 s of CPU while each page also inferred ties (plan 34 A7), so a page is 100.
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
     * The nightly rebuild: the calibration is refit first from the labelled people, then the tie inference starts
     * (score.ties, one group a job), whose last job queues the pages.
     */
    'score.user': async (job, ctx) => {
      if (!job.userId) throw new JobSkipped('no_user');
      await ctx.queue.setVt(job.queue, job.msgId, LONG_VT_SEC);
      const now = ctx.now();
      const labelled = (
        await ctx.db.sql<{ person_id: string }>`
          select person_id from orbit.tie_labels where user_id = ${job.userId}::uuid`
      ).map((r) => r.person_id);
      let refit = false;
      if (labelled.length) {
        const [u] = await ctx.db.sql<{ settings: Record<string, unknown> | null }>`
          select settings from orbit.users where id = ${job.userId}::uuid`;
        const before = readCalibration(u?.settings ?? {});
        const r = await scorePeople(ctx.db, job.userId, { now, personIds: labelled, fit: true });
        refit = r.calibration?.a !== before?.a || r.calibration?.c !== before?.c;
      }
      const full = job.payload.full === true || refit || (await fullRescoreDue(ctx.db, job.userId));
      const runKey = job.dedupeKey ?? `score.user:${job.userId}:${now.toISOString()}`;
      await ctx.queue.enqueue({
        kind: 'score.ties',
        userId: job.userId,
        payload: { step: 0, full, runKey },
        dedupeKey: `${runKey}:ties:0`,
      });
    },
    /** One TIE_GROUPS entry of the night's inference; the last one queues the pages. */
    'score.ties': async (job, ctx) => {
      if (!job.userId) throw new JobSkipped('no_user');
      const step = Number(job.payload.step ?? 0);
      const group = TIE_GROUPS[step];
      if (!Number.isInteger(step) || !group) return;
      const full = job.payload.full === true;
      const runKey = typeof job.payload.runKey === 'string' ? job.payload.runKey : `score.ties:${job.msgId}`;
      const now = ctx.now();
      await refreshTies(ctx.db, job.userId, now, { kinds: group.kinds });
      if (step + 1 < TIE_GROUPS.length) {
        await ctx.queue.enqueue({
          kind: 'score.ties',
          userId: job.userId,
          payload: { step: step + 1, full, runKey },
          dedupeKey: `${runKey}:ties:${step + 1}`,
        });
        return;
      }
      const ids = full
        ? (
            await ctx.db.sql<{ id: string }>`
              select id from orbit.people
               where user_id = ${job.userId}::uuid and deleted_at is null and merged_into is null and not is_self
               order by id`
          ).map((r) => r.id)
        : await changedPeople(ctx.db, job.userId);
      const pages = chunks(ids, SCORE_PAGE);
      for (const [i, personIds] of pages.entries())
        await ctx.queue.enqueue({
          kind: 'score.page',
          userId: job.userId,
          payload: { personIds, page: i, pages: pages.length },
          dedupeKey: `${runKey}:page:${i}`,
        });
    },
    'score.page': async (job, ctx) => {
      if (!job.userId) throw new JobSkipped('no_user');
      const raw = Array.isArray(job.payload.personIds) ? job.payload.personIds : [];
      const ids = [...new Set(raw.filter(isUuid))];
      const now = ctx.now();
      // the ties were inferred once for the night (score.ties): a page only scores
      if (ids.length) await scorePeople(ctx.db, job.userId, { now, personIds: ids });
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
