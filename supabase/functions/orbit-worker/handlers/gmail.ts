/**
 * Gmail jobs (§12.3):
 *
 * sync.gmail.backfill {phase?, restart?}
 *   Chained jobs over messages.list: phase `recent` (newer_than:90d), then `deep` (after 2 years ago, before 90 days
 *   ago, stopped at 50,000 messages), then `complete`. Each job reads one page of up to 250 ids, ingests the new
 *   ones (metadata first, full threads for networking candidates), then saves {phase, pageToken, done, total} in
 *   sync_state.gmail.backfill and queues the next page 5 s later. State is saved only after the page is stored, so a
 *   job that dies mid-page is simply run again from the same pageToken. The first job also saves the starting
 *   historyId, attaches the send-as aliases to the self person, registers the Gmail watch (when GMAIL_PUBSUB_TOPIC is
 *   set) and queues the first calendar and contacts syncs. The end of the backfill queues score.user.
 *
 * sync.gmail.incremental {historyId?, reason?, renewWatch?}
 *   history.list from the stored historyId (messageAdded), then the backfill's per-message path; more than 250 new
 *   messages are taken 250 per job. A 404 (history too old) runs a 30-day `recent` backfill and resets historyId from
 *   users.getProfile. `renewWatch` renews the watch first (skipped quietly without a topic).
 */

import { normalizeEmail } from '@orbit/core/text/normalize';
import { type GmailApi, gmailApi } from '../../_shared/gmail.ts';
import { NeedsReauth } from '../../_shared/google.ts';
import { GoogleApiError } from '../../_shared/googleApi.ts';
import { ingestGmail } from '../../_shared/ingest/gmail.ts';
import { type Account, loadAccount, loadSelf, patchSyncState } from '../../_shared/ingest/util.ts';
import type { Job, JobContext, JobHandler } from '../worker.ts';
import { googleFor, type HandlerDeps, JobSkipped, LONG_VT_SEC } from './deps.ts';

export const PAGE_SIZE = 250;
export const DEEP_CAP = 50_000;
export const CHAIN_DELAY_SEC = 5;
export const RECOVERY_DAYS = 30;
const HISTORY_PAGES_MAX = 20;
const DAY = 86_400_000;

export interface BackfillState {
  phase: 'recent' | 'deep' | 'complete';
  pageToken: string | null;
  done: number;
  total: number | null;
  /** a recent pass narrower than 90 days (the 404 recovery) */
  days?: number;
  recovery?: boolean;
  /** an unfinished backfill to resume after a recovery pass */
  then?: BackfillState;
  capped?: boolean;
}

const GMAIL_SCOPE = /gmail\.readonly$/;

async function account(job: Job, ctx: JobContext): Promise<{ userId: string; acct: Account }> {
  const userId = job.userId;
  if (!userId) throw new JobSkipped('no_user');
  const acct = await loadAccount(ctx.db, userId, 'google');
  if (!acct) throw new JobSkipped('not_connected');
  if (acct.status !== 'active') throw new JobSkipped(acct.status);
  if (!acct.scopes.some((s) => GMAIL_SCOPE.test(s))) throw new JobSkipped('missing_scope');
  return { userId, acct };
}

/** A query for one phase; Gmail takes epoch seconds in after:/before:. */
export function phaseQuery(bf: BackfillState, now: Date): string {
  if (bf.phase === 'recent') return `newer_than:${bf.days ?? 90}d -in:chats`;
  const sec = (ms: number) => Math.floor(ms / 1000);
  const t = now.getTime();
  return `after:${sec(t - 730 * DAY)} before:${sec(t - 90 * DAY)} -in:chats`;
}

const reauth = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof NeedsReauth) throw new JobSkipped('needs_reauth');
    throw e;
  }
};

export function gmailHandlers(deps: HandlerDeps): Record<string, JobHandler> {
  const google = googleFor(deps);

  async function firstRun(api: GmailApi, userId: string, ctx: JobContext) {
    const self = await loadSelf(ctx.db, userId);
    // send-as aliases are the user too (§1.3)
    const aliases = await api.sendAs().catch((e) => {
      // an account without access to its settings still syncs; its aliases are just not known
      if (e instanceof GoogleApiError && e.status === 403) return [];
      throw e;
    });
    for (const s of aliases) {
      if (!s.sendAsEmail || !(s.isPrimary || s.verificationStatus === 'accepted')) continue;
      await ctx.db.sql`
        insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source)
        values (${userId}::uuid, ${self.selfId}::uuid, 'email', ${normalizeEmail(s.sendAsEmail)}, ${s.sendAsEmail},
                'gmail_send_as')
        on conflict (user_id, kind, value_norm) do nothing`;
    }
    await renewWatch(api, userId, ctx);
    const scopes = (await loadAccount(ctx.db, userId, 'google'))?.scopes ?? [];
    if (scopes.some((s) => /calendar\.(readonly|events)$/.test(s)))
      await ctx.queue.enqueue({
        kind: 'sync.calendar',
        userId,
        payload: { reason: 'connect' },
        dedupeKey: `calendar-connect:${userId}`,
      });
    if (scopes.some((s) => /contacts/.test(s)))
      await ctx.queue.enqueue({
        kind: 'sync.contacts',
        userId,
        payload: { reason: 'connect' },
        dedupeKey: `contacts-connect:${userId}`,
      });
  }

  async function renewWatch(api: GmailApi, userId: string, ctx: JobContext) {
    if (!deps.gmailTopic) return;
    try {
      const w = await api.watch(deps.gmailTopic);
      const exp = Number(w.expiration);
      await ctx.db.sql`
        update orbit.integration_accounts
           set watch_expires_at = ${Number.isFinite(exp) && exp > 0 ? new Date(exp) : null}::timestamptz
         where user_id = ${userId}::uuid and provider = 'google'`;
    } catch (e) {
      // a topic Google refuses (Pub/Sub not set up): the 10-minute poll still covers it (§12.7)
      if (e instanceof GoogleApiError && e.status < 500 && e.status !== 429) return;
      throw e;
    }
  }

  async function backfill(job: Job, ctx: JobContext) {
    const { userId, acct } = await account(job, ctx);
    const api = gmailApi(google(ctx.db), userId);
    await ctx.queue.setVt(job.queue, job.msgId, LONG_VT_SEC);
    const now = ctx.now();
    const gm = acct.syncState.gmail ?? {};
    let bf = gm.backfill as BackfillState | undefined;
    if (bf?.phase === 'complete' && !job.payload.restart) return;
    const first = !bf && !gm.historyId;
    if (!bf || job.payload.restart)
      bf = {
        phase: job.payload.phase === 'deep' ? 'deep' : 'recent',
        pageToken: null,
        done: 0,
        total: null,
      };
    if (!gm.historyId) {
      const profile = await api.profile();
      await patchSyncState(ctx.db, userId, 'google', 'gmail', { historyId: profile.historyId });
    }
    if (first) await firstRun(api, userId, ctx);

    const page = await api.list(phaseQuery(bf, now), {
      pageToken: bf.pageToken ?? undefined,
      maxResults: PAGE_SIZE,
    });
    const refs = page.messages ?? [];
    await ingestGmail({ db: ctx.db, queue: ctx.queue, api, userId, now, jobKey: `gmail:${job.msgId}` }, refs);
    const done = bf.done + refs.length;
    const estimate = page.resultSizeEstimate ?? null;
    const total =
      bf.total ?? (estimate === null ? null : bf.phase === 'deep' ? Math.min(estimate, DEEP_CAP) : estimate);
    let next: BackfillState;
    const more = !!page.nextPageToken && !(bf.phase === 'deep' && done >= DEEP_CAP);
    if (more) next = { ...bf, pageToken: page.nextPageToken!, done, total };
    else if (bf.phase === 'recent' && !bf.recovery)
      next = { phase: 'deep', pageToken: null, done: 0, total: null };
    else if (bf.recovery && bf.then) next = bf.then;
    else
      next = {
        phase: 'complete',
        pageToken: null,
        done,
        total: total === null ? done : Math.max(total, done),
        ...(bf.phase === 'deep' && page.nextPageToken ? { capped: true } : {}),
      };
    await patchSyncState(
      ctx.db,
      userId,
      'google',
      'gmail',
      { backfill: next },
      { lastSyncedAt: now, lastError: null },
    );
    if (next.phase !== 'complete')
      await ctx.queue.enqueue(
        {
          kind: 'sync.gmail.backfill',
          userId,
          payload: { phase: next.phase },
          dedupeKey: `gmail-backfill:${userId}:${next.phase}:${next.done}:${job.msgId}`,
        },
        { delaySec: CHAIN_DELAY_SEC },
      );
    else
      await ctx.queue.enqueue({
        kind: 'score.user',
        userId,
        payload: { reason: 'backfill' },
        dedupeKey: `score.user:${userId}:backfill:${now.toISOString().slice(0, 13)}`,
      });
  }

  async function recover(api: GmailApi, userId: string, acct: Account, job: Job, ctx: JobContext) {
    const profile = await api.profile();
    const prev = acct.syncState.gmail?.backfill as BackfillState | undefined;
    const then = prev && prev.phase !== 'complete' && !prev.recovery ? prev : undefined;
    await patchSyncState(ctx.db, userId, 'google', 'gmail', {
      historyId: profile.historyId,
      backfill: {
        phase: 'recent',
        days: RECOVERY_DAYS,
        recovery: true,
        pageToken: null,
        done: 0,
        total: null,
        ...(then ? { then } : {}),
      } satisfies BackfillState,
    });
    await ctx.queue.enqueue({
      kind: 'sync.gmail.backfill',
      userId,
      payload: { phase: 'recent', recovery: true },
      dedupeKey: `gmail-recovery:${userId}:${profile.historyId}:${job.msgId}`,
    });
  }

  async function incremental(job: Job, ctx: JobContext) {
    const { userId, acct } = await account(job, ctx);
    const api = gmailApi(google(ctx.db), userId);
    await ctx.queue.setVt(job.queue, job.msgId, LONG_VT_SEC);
    const now = ctx.now();
    if (job.payload.renewWatch) await renewWatch(api, userId, ctx);
    const gm = acct.syncState.gmail ?? {};
    const start = typeof gm.historyId === 'string' ? gm.historyId : undefined;
    if (!start) {
      // never backfilled: the backfill sets the starting point
      if (!gm.backfill)
        await ctx.queue.enqueue({
          kind: 'sync.gmail.backfill',
          userId,
          payload: { phase: 'recent' },
          dedupeKey: `gmail-backfill:${userId}:recent`,
        });
      return;
    }
    const refs: { id: string; threadId: string }[] = [];
    let latest = start;
    let lastRecord: string | undefined;
    let pageToken: string | undefined;
    for (let i = 0; i < HISTORY_PAGES_MAX; i++) {
      let page: Awaited<ReturnType<GmailApi['history']>>;
      try {
        page = await api.history(start, pageToken);
      } catch (e) {
        if (e instanceof GoogleApiError && e.status === 404) return recover(api, userId, acct, job, ctx);
        throw e;
      }
      for (const h of page.history ?? []) {
        lastRecord = h.id;
        for (const a of h.messagesAdded ?? []) {
          if ((a.message.labelIds ?? []).some((l) => ['DRAFT', 'SPAM', 'TRASH', 'CHAT'].includes(l)))
            continue;
          refs.push({ id: a.message.id, threadId: a.message.threadId });
        }
      }
      if (page.historyId) latest = page.historyId;
      pageToken = page.nextPageToken;
      if (!pageToken) break;
    }
    const ids = [...new Set(refs.map((r) => r.id))];
    const stored = new Set(
      (
        await ctx.db.sql<{ external_id: string }>`
          select external_id from orbit.messages
           where user_id = ${userId}::uuid and provider = 'gmail' and external_id = any(${ids}::text[])`
      ).map((r) => r.external_id),
    );
    const fresh = ids.filter((id) => !stored.has(id));
    const batch = fresh.slice(0, PAGE_SIZE);
    await ingestGmail(
      { db: ctx.db, queue: ctx.queue, api, userId, now, jobKey: `gmail:${job.msgId}` },
      batch.map((id) => ({ id })),
    );
    // all new messages stored: move on to the newest history (or, past the page cap, to the last record read)
    const allStored = fresh.length <= PAGE_SIZE;
    const finished = allStored && !pageToken;
    const nextStart = allStored ? (pageToken ? lastRecord : latest) : undefined;
    await patchSyncState(ctx.db, userId, 'google', 'gmail', nextStart ? { historyId: nextStart } : {}, {
      lastSyncedAt: now,
      lastError: null,
    });
    if (!finished)
      await ctx.queue.enqueue(
        {
          kind: 'sync.gmail.incremental',
          userId,
          payload: { reason: 'more' },
          dedupeKey: `gmail-more:${userId}:${job.msgId}`,
        },
        { delaySec: CHAIN_DELAY_SEC },
      );
  }

  return {
    'sync.gmail.backfill': (job, ctx) => reauth(() => backfill(job, ctx)),
    'sync.gmail.incremental': (job, ctx) => reauth(() => incremental(job, ctx)),
  };
}
