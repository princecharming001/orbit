/**
 * sync.calendar {reason?, resync?} (§12.3): the first run (or `resync`, or an expired token) reads the primary
 * calendar from 2 years back to 90 days ahead, single events, 2,500 a page, and saves nextSyncToken in
 * sync_state.calendar; later runs read with the sync token only. A 410 Gone starts a full resync. Events go through
 * ingest/calendar.ts (people from attendees, one-on-ones, then score.person, which refreshes co-attendance ties).
 */

import { type CalendarPage, calendarApi } from '../../_shared/calendar.ts';
import { NeedsReauth } from '../../_shared/google.ts';
import { GoogleApiError } from '../../_shared/googleApi.ts';
import { ingestEvents } from '../../_shared/ingest/calendar.ts';
import { loadAccount, patchSyncState } from '../../_shared/ingest/util.ts';
import type { JobHandler } from '../worker.ts';
import { googleFor, type HandlerDeps, JobSkipped, LONG_VT_SEC } from './deps.ts';

const DAY = 86_400_000;
const PAGES_MAX = 20;

export function calendarHandlers(deps: HandlerDeps): Record<string, JobHandler> {
  const google = googleFor(deps);
  return {
    'sync.calendar': async (job, ctx) => {
      const userId = job.userId;
      if (!userId) throw new JobSkipped('no_user');
      const acct = await loadAccount(ctx.db, userId, 'google');
      if (!acct) throw new JobSkipped('not_connected');
      if (acct.status !== 'active') throw new JobSkipped(acct.status);
      if (!acct.scopes.some((s) => /calendar\.(readonly|events)$/.test(s)))
        throw new JobSkipped('missing_scope');
      const api = calendarApi(google(ctx.db), userId);
      await ctx.queue.setVt(job.queue, job.msgId, LONG_VT_SEC);
      const now = ctx.now();
      const saved = acct.syncState.calendar?.syncToken;
      let syncToken = typeof saved === 'string' && !job.payload.resync ? saved : undefined;
      let pageToken: string | undefined;
      let nextSyncToken: string | undefined;
      let full = !syncToken;
      let events = 0;
      try {
        for (let i = 0; i < PAGES_MAX; i++) {
          let page: CalendarPage;
          try {
            page = await api.events(
              syncToken
                ? { syncToken, pageToken }
                : {
                    timeMin: new Date(now.getTime() - 730 * DAY).toISOString(),
                    timeMax: new Date(now.getTime() + 90 * DAY).toISOString(),
                    pageToken,
                  },
            );
          } catch (e) {
            // the sync token expired: list the whole window again
            if (e instanceof GoogleApiError && e.status === 410 && syncToken) {
              syncToken = undefined;
              pageToken = undefined;
              full = true;
              continue;
            }
            throw e;
          }
          const r = await ingestEvents(
            { db: ctx.db, queue: ctx.queue, userId, now, jobKey: `calendar:${job.msgId}:${i}` },
            page.items ?? [],
          );
          events += r.stored + r.cancelled;
          pageToken = page.nextPageToken;
          if (!pageToken) {
            nextSyncToken = page.nextSyncToken;
            break;
          }
        }
      } catch (e) {
        if (e instanceof NeedsReauth) throw new JobSkipped('needs_reauth');
        throw e;
      }
      await patchSyncState(
        ctx.db,
        userId,
        'google',
        'calendar',
        {
          ...(nextSyncToken ? { syncToken: nextSyncToken } : {}),
          ...(full ? { fullSyncAt: now.toISOString() } : {}),
          lastEvents: events,
        },
        { lastSyncedAt: now, lastError: null },
      );
      // past PAGES_MAX pages (50,000 events) the rest of the window is left unread and no sync token is saved,
      // so the next run reads the window again from the start
    },
  };
}
