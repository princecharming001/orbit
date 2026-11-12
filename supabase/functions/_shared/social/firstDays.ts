/**
 * The first days of a connected account, and the reads that keep it current (plan 43 §4), inside the budget:
 *
 *   1. profile    the student's own account (and the "different account" check against the one connected before)
 *   2. chats      the newest chats and their messages, into the personal lane: closeness starts here
 *   3. following  who the student follows, a page at a time, with the cursor saved
 *   4. followers  who follows them, 25 at a time
 *   then refresh  one page of one of their lists at a time, at uneven hours, and once a day a look for the accounts of
 *                 the people they are going after (hard proof only)
 *
 * Each run makes a few calls and hands on; the caller schedules the next run at an uneven interval, or when the
 * budget says room opens. The student's own lists go into social_follows with the student as owner. Chat partners
 * and accounts they follow each other with are offered to matching (`social.match`).
 */
import { handleFromLink, handlesIn, normalizeHandle, type SocialPlatform } from '@orbit/core/entity/social';
import type { Db } from '../db.ts';
import type { Queue } from '../queue.ts';
import { type SocialAdapter, SocialBudgetSpent, type SocialChat, SocialSignInNeeded } from './adapter.ts';
import { GROUP_MAX, storeSocialChat } from './chats.ts';
import { readListPage, upsertAccounts } from './graph.ts';
import { listAfterExchange, matchAccount, socialCandidates } from './people.ts';
import { removeSocialRows } from './remove.ts';

/** Calls one sync run makes at most before it hands on. */
export const SYNC_CALLS_PER_RUN = 3;
/** Chats read in the first days (the newest first). */
export const FIRST_CHATS = 60;
const DAY = 86_400_000;

export type SyncStage = 'profile' | 'chats' | 'following' | 'followers' | 'refresh';

export interface SocialSyncState {
  stage?: SyncStage;
  chatQueue?: SocialChat[];
  chatsCursor?: string | null;
  chatsListed?: boolean;
  chatsRead?: number;
  refreshList?: 'following' | 'followers';
  /** the student said to replace the account connected before (POST /instagram/connect/start {replace: true}) */
  replace?: boolean;
  /** a different account signed in without `replace`: held until the student says */
  pending?: { socialAccountId: string; username: string } | null;
  syncedAt?: string;
  targetsAt?: string;
}

export type SyncOutcome =
  | { next: 'soon' }
  | { next: 'later' }
  | { next: 'retry'; retryAt: Date }
  | { next: 'stop'; reason: 'different_account' | 'sign_in' | 'not_connected' };

export async function patchSocialState(
  db: Db,
  userId: string,
  platform: SocialPlatform,
  patch: Partial<SocialSyncState> & Record<string, unknown>,
): Promise<void> {
  await db.sql`
    update orbit.integration_accounts
       set sync_state = coalesce(sync_state, '{}'::jsonb)
             || jsonb_build_object(${platform}::text,
                  coalesce(sync_state -> ${platform}::text, '{}'::jsonb) || ${JSON.parse(JSON.stringify(patch))}::jsonb)
     where user_id = ${userId}::uuid and provider = ${platform}`;
}

export interface SyncAdapters {
  /** background reads: 60 percent of each window */
  background: SocialAdapter;
  /** looking for targets' accounts: a small daily share */
  targets?: SocialAdapter;
}

export async function runSocialSync(
  db: Db,
  queue: Queue,
  adapters: SyncAdapters,
  userId: string,
  o: { now: Date; callsPerRun?: number },
): Promise<SyncOutcome> {
  const a = adapters.background;
  const platform = a.platform;
  const [row] = await db.sql<{
    social_account_id: string | null;
    status: string;
    sync_state: Record<string, SocialSyncState> | null;
  }>`
    select social_account_id, status, sync_state from orbit.integration_accounts
     where user_id = ${userId}::uuid and provider = ${platform}`;
  if (!row) return { next: 'stop', reason: 'not_connected' };
  let state: SocialSyncState = { ...(row.sync_state?.[platform] ?? {}) };
  const save = async (patch: Partial<SocialSyncState>) => {
    state = { ...state, ...patch };
    await patchSocialState(db, userId, platform, patch);
  };
  const allowance = o.callsPerRun ?? SYNC_CALLS_PER_RUN;
  let calls = 0;
  let me = row.social_account_id;
  try {
    while (calls < allowance) {
      const stage = state.stage ?? 'profile';
      if (stage === 'profile') {
        calls++;
        const read = await a.me();
        const id = read.account.id;
        if (me && me !== id) {
          if (!state.replace) {
            await save({ pending: { socialAccountId: id, username: read.account.username } });
            await db.sql`
              update orbit.integration_accounts set status = 'error', last_error = 'different_account'
               where user_id = ${userId}::uuid and provider = ${platform}`;
            return { next: 'stop', reason: 'different_account' };
          }
          await removeSocialRows(db, userId, platform, { ownAccountId: me });
        }
        await upsertAccounts(db, [read.account], { full: true, now: o.now });
        await db.sql`
          update orbit.integration_accounts
             set social_account_id = ${id}, status = 'active', last_error = null
           where user_id = ${userId}::uuid and provider = ${platform}`;
        me = id;
        await save({
          stage: 'chats',
          replace: false,
          pending: null,
          chatsCursor: null,
          chatQueue: [],
          chatsRead: 0,
        });
        continue;
      }
      if (!me) {
        await save({ stage: 'profile' });
        continue;
      }
      if (stage === 'chats') {
        const queued = state.chatQueue ?? [];
        if (!queued.length) {
          if (state.chatsListed || (state.chatsRead ?? 0) >= FIRST_CHATS) {
            await save({ stage: 'following', chatQueue: [] });
            continue;
          }
          calls++;
          const page = await a.chats(state.chatsCursor ?? undefined);
          await save({
            chatQueue: page.items.filter((c) => c.participants <= GROUP_MAX),
            chatsCursor: page.cursor ?? null,
            chatsListed: !page.cursor,
          });
          continue;
        }
        const chat = queued[0]!;
        calls++;
        const msgs = await a.messages(chat.chatId);
        const stored = await storeSocialChat(db, userId, platform, chat, msgs.items, { now: o.now });
        if (stored.partner) await offerToMatching(queue, userId, platform, [stored.partner.accountId]);
        if (stored.personIds.length)
          await queue.enqueue({
            kind: 'score.person',
            userId,
            payload: { personIds: stored.personIds },
            dedupeKey: `score.person:${userId}:${platform}:chat:${chat.chatId}`,
          });
        await save({ chatQueue: queued.slice(1), chatsRead: (state.chatsRead ?? 0) + 1 });
        continue;
      }
      if (stage === 'following' || stage === 'followers') {
        calls++;
        const page = await readListPage(db, a, {
          accountId: me,
          list: stage,
          owner: userId,
          readBy: userId,
          now: o.now,
          keepAccounts: true,
        });
        if (!page.ended) continue;
        if (stage === 'following') {
          await save({ stage: 'followers' });
          continue;
        }
        await offerFollowBacks(db, queue, userId, platform, me);
        await save({ stage: 'refresh', syncedAt: o.now.toISOString(), refreshList: 'following' });
        return { next: 'later' };
      }
      // refresh: one page of one list, then the people the student is going after once a day
      const list = state.refreshList ?? 'following';
      calls++;
      const page = await readListPage(db, a, {
        accountId: me,
        list,
        owner: userId,
        readBy: userId,
        now: o.now,
        keepAccounts: true,
      });
      if (page.ended) {
        await save({ refreshList: list === 'following' ? 'followers' : 'following' });
        await offerFollowBacks(db, queue, userId, platform, me);
      }
      await listAfterExchange(db, userId);
      if (adapters.targets && (!state.targetsAt || o.now.getTime() - Date.parse(state.targetsAt) >= DAY)) {
        await save({ targetsAt: o.now.toISOString() });
        await matchTargets(db, adapters.targets, userId, { now: o.now });
      }
      return { next: 'later' };
    }
    return { next: 'soon' };
  } catch (e) {
    if (e instanceof SocialBudgetSpent)
      return { next: 'retry', retryAt: e.retryAt ?? new Date(o.now.getTime() + 3_600_000) };
    if (e instanceof SocialSignInNeeded) {
      await db.sql`
        update orbit.integration_accounts set status = 'needs_reauth', last_error = 'sign_in'
         where user_id = ${userId}::uuid and provider = ${platform} and status <> 'needs_reauth'`;
      return { next: 'stop', reason: 'sign_in' };
    }
    throw e;
  }
}

async function offerToMatching(queue: Queue, userId: string, platform: SocialPlatform, accountIds: string[]) {
  if (!accountIds.length) return;
  await queue.enqueue({
    kind: 'social.match',
    userId,
    payload: { platform, accountIds },
    dedupeKey: `social.match:${userId}:${platform}:${[...accountIds].sort().join(',').slice(0, 400)}`,
  });
}

/** Accounts the student and they follow each other, sorted as a person and not yet matched: offered to matching. */
async function offerFollowBacks(db: Db, queue: Queue, userId: string, platform: SocialPlatform, me: string) {
  const rows = await db.sql<{ id: string }>`
    select f.follower_id as id from orbit.social_follows f
      join orbit.social_accounts a on a.platform = f.platform and a.account_id = f.follower_id and a.kind = 'person'
     where f.platform = ${platform} and f.owner_user_id = ${userId}::uuid and f.followed_id = ${me}
       and exists (select 1 from orbit.social_follows g where g.platform = f.platform and g.owner_user_id = ${userId}::uuid
                     and g.follower_id = ${me} and g.followed_id = f.follower_id)
       and not exists (select 1 from orbit.social_links l where l.user_id = ${userId}::uuid and l.platform = f.platform
                         and l.account_id = f.follower_id)`;
  for (let i = 0; i < rows.length; i += 50)
    await offerToMatching(
      queue,
      userId,
      platform,
      rows.slice(i, i + 50).map((r) => r.id),
    );
}

/** People the student is going after: an open chat in an early stage, with no account attached on the platform. */
async function targetsOf(db: Db, userId: string, platform: SocialPlatform) {
  return db.sql<{ id: string }>`
    select distinct c.person_id as id from orbit.chats c
     where c.user_id = ${userId}::uuid and c.archived_at is null
       and c.stage in ('identified', 'warming', 'outreach_sent', 'no_response')
       and not exists (select 1 from orbit.social_links l where l.user_id = ${userId}::uuid and l.platform = ${platform}
                         and l.person_id = c.person_id)
     limit 20`;
}

/**
 * For each person the student is going after: the handles their own pages name (LinkedIn websites, pages research
 * confirmed) are read and attached only on hard proof (core `matchTargetAccount`); a platform with a name search is
 * asked too. Stops when the targets' share of the budget is spent.
 */
export async function matchTargets(
  db: Db,
  adapter: SocialAdapter,
  userId: string,
  o: { now: Date },
): Promise<number> {
  const platform = adapter.platform;
  const people = await targetsOf(db, userId, platform);
  if (!people.length) return 0;
  const candidates = await socialCandidates(db, userId, platform, { ids: people.map((p) => p.id) });
  let attached = 0;
  try {
    for (const c of candidates) {
      const handles = new Set<string>();
      for (const l of c.links ?? []) {
        const h = handleFromLink(l, platform);
        if (h) handles.add(normalizeHandle(h));
        for (const x of handlesIn(l, platform)) handles.add(x);
      }
      const found = [];
      for (const h of handles) found.push((await adapter.profile(h)).account);
      if (!found.length && adapter.search) found.push(...(await adapter.search(c.person.displayName)));
      for (const account of found) {
        await upsertAccounts(db, [account], { full: true, now: o.now });
        const r = await matchAccount(db, userId, account, { now: o.now, target: c });
        if (r.kind === 'attached') {
          attached++;
          break;
        }
      }
    }
  } catch (e) {
    if (!(e instanceof SocialBudgetSpent)) throw e;
  }
  return attached;
}
