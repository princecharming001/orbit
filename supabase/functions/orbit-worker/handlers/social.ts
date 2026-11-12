/**
 * Plan 43, Instagram and X on the server. Every job does nothing while the source is not offered by the owner
 * (`offeredNow`: ORBIT_EXTRA_SOURCES with the launch switches) or is off for the student (`sourceIsOn`), and every call
 * it makes is paid for first: Instagram from the account's rolling budget (_shared/social/budget.ts), X from the
 * student's money budget (_shared/social/x/spend.ts).
 *
 *   sync.instagram {}                  the first days (profile and chats, who the student follows, who follows
 *                                      them), then a page of their lists at uneven hours (_shared/social/firstDays.ts).
 *                                      Each run makes a few calls and queues the next at an uneven interval, or when
 *                                      the budget says room opens.
 *   social.match {platform, accountIds}  accounts offered to matching: chat partners and accounts the student follows
 *                                      back. A profile is read only when someone in People could be the account.
 *   social.words {platform, personId}  a person entered the pipeline: their one-to-one chats are read again and the
 *                                      words of messages stored without them filled in.
 *   social.lookup {lookupId}           who could introduce the student to a target (_shared/social/lookup.ts),
 *                                      resumed until it ends. An X lookup is a check the student confirmed at a price
 *                                      (_shared/social/x/lookup.ts): run under that price, lists to the end or not
 *                                      at all.
 */
import { type SocialPlatform, socialBlock } from '@orbit/core/entity/social';
import { SocialBudgetSpent } from '../../_shared/social/adapter.ts';
import { unevenMs } from '../../_shared/social/budget.ts';
import { storeSocialChat } from '../../_shared/social/chats.ts';
import { adapterFor, connectedAccount, socialAdapterFor } from '../../_shared/social/factory.ts';
import { runSocialSync } from '../../_shared/social/firstDays.ts';
import { accountOfRow, loadAccounts, upsertAccounts } from '../../_shared/social/graph.ts';
import { runLookup } from '../../_shared/social/lookup.ts';
import { matchAccount, socialCandidates } from '../../_shared/social/people.ts';
import { upsertXAccount } from '../../_shared/social/x/lists.ts';
import { runXLookup } from '../../_shared/social/x/lookup.ts';
import { sourceIsOn } from '../../_shared/sources/states.ts';
import type { Job, JobContext, JobHandler } from '../worker.ts';
import { type HandlerDeps, JobSkipped } from './deps.ts';

const MIN = 60_000;
/** The wait between runs in the first days, and between refreshes after them (each made uneven). */
export const SYNC_SOON_MS = 8 * MIN;
export const SYNC_LATER_MS = 6 * 60 * MIN;
export const LOOKUP_SOON_MS = 2 * MIN;

const isPlatform = (v: unknown): v is SocialPlatform => v === 'instagram' || v === 'x';

export function socialHandlers(deps: HandlerDeps): Record<string, JobHandler> {
  const random = deps.random ?? Math.random;
  const offered = deps.offered ?? [];
  const env = (ctx: JobContext) => ({
    fetch: deps.fetch ?? fetch,
    unipile: deps.unipile,
    now: ctx.now,
    ...(deps.x ? { x: deps.x } : {}),
  });

  async function ready(job: Job, ctx: JobContext, platform: SocialPlatform) {
    const userId = job.userId;
    if (!userId) throw new JobSkipped('no_user');
    if (!(await sourceIsOn(ctx.db, userId, platform, offered))) throw new JobSkipped('source_off');
    const account = await connectedAccount(ctx.db, userId, platform);
    if (!account) throw new JobSkipped('not_connected');
    return { userId, account };
  }

  const later = async (ctx: JobContext, job: Job, ms: number, tag: string) => {
    const at = new Date(ctx.now().getTime() + ms);
    await ctx.queue.enqueue(
      {
        kind: job.kind,
        userId: job.userId,
        payload: job.payload,
        dedupeKey: `${job.kind}:${job.userId}:${tag}:${job.msgId}:${at.toISOString()}`,
      },
      { delaySec: Math.max(1, Math.ceil(ms / 1000)) },
    );
  };

  return {
    'sync.instagram': async (job, ctx) => {
      const { userId, account } = await ready(job, ctx, 'instagram');
      if (account.status !== 'active' && account.status !== 'connecting')
        throw new JobSkipped(account.status);
      const background = adapterFor(ctx.db, env(ctx), 'instagram', account, 'background');
      if (!background) throw new JobSkipped('unconfigured');
      const targets = adapterFor(ctx.db, env(ctx), 'instagram', account, 'targets');
      const out = await runSocialSync(ctx.db, ctx.queue, { background, targets }, userId, { now: ctx.now() });
      if (out.next === 'soon') await later(ctx, job, unevenMs(SYNC_SOON_MS, random), 'soon');
      else if (out.next === 'later') await later(ctx, job, unevenMs(SYNC_LATER_MS, random), 'later');
      else if (out.next === 'retry')
        await later(
          ctx,
          job,
          Math.max(MIN, out.retryAt.getTime() - ctx.now().getTime()) + unevenMs(5 * MIN, random),
          'retry',
        );
      else if (out.reason === 'sign_in')
        await ctx.db.sql`
          insert into orbit.notifications (user_id, kind, title, body, link)
          select ${userId}::uuid, 'instagram_sign_in', 'Sign in to Instagram again',
                 'Instagram asked to confirm it is you. Orbit carries on with everything else meanwhile.', '/settings'
           where not exists (select 1 from orbit.notifications where user_id = ${userId}::uuid
                               and kind = 'instagram_sign_in' and read_at is null)`;
    },

    'social.match': async (job, ctx) => {
      const platform = job.payload.platform;
      if (!isPlatform(platform)) throw new JobSkipped('bad_platform');
      const { userId, account } = await ready(job, ctx, platform);
      const ids = (Array.isArray(job.payload.accountIds) ? job.payload.accountIds : []).filter(
        (x): x is string => typeof x === 'string' && !!x,
      );
      if (!ids.length) return;
      const adapter = await socialAdapterFor(ctx.db, env(ctx), platform, account, 'background');
      const pool = await socialCandidates(ctx.db, userId, platform);
      const stored = await loadAccounts(ctx.db, platform, ids);
      const left: string[] = [];
      for (const [i, id] of ids.entries()) {
        let row = stored.get(id);
        let acct = row ? accountOfRow(platform, row) : undefined;
        // a profile is read only for an account someone in People could be (or one Orbit knows nothing about)
        const worth = !acct || socialBlock(acct, pool).length > 0;
        if (worth && adapter && !row?.bio) {
          try {
            const read = await adapter.profile(id);
            // X rows keep X's 30 days (x/lists.ts); a protected X account is dropped, not stored
            if (platform === 'x') await upsertXAccount(ctx.db, read.account, ctx.now());
            else await upsertAccounts(ctx.db, [read.account], { full: true, now: ctx.now() });
            acct = read.account;
            row = (await loadAccounts(ctx.db, platform, [id])).get(id);
          } catch (e) {
            if (!(e instanceof SocialBudgetSpent)) throw e;
            left.push(...ids.slice(i));
            break;
          }
        }
        if (!acct || !row) continue;
        await matchAccount(ctx.db, userId, acct, { now: ctx.now(), candidates: pool });
      }
      if (left.length)
        await ctx.queue.enqueue(
          {
            kind: 'social.match',
            userId,
            payload: { platform, accountIds: left },
            dedupeKey: `social.match:${userId}:${platform}:left:${ctx.now().toISOString()}`,
          },
          { delaySec: Math.ceil(unevenMs(60 * MIN, random) / 1000) },
        );
    },

    'social.words': async (job, ctx) => {
      const platform = job.payload.platform;
      const personId = job.payload.personId;
      if (!isPlatform(platform) || typeof personId !== 'string') throw new JobSkipped('bad_payload');
      const { userId, account } = await ready(job, ctx, platform);
      const adapter = await socialAdapterFor(ctx.db, env(ctx), platform, account, 'student');
      if (!adapter) throw new JobSkipped('unconfigured');
      const threads = await ctx.db.sql<{
        external_id: string;
        social_account_id: string | null;
        participant_count: number;
      }>`
        select external_id, social_account_id, participant_count from orbit.threads
         where user_id = ${userId}::uuid and provider = ${platform} and participant_count <= 1
           and ${personId}::uuid = any(participant_person_ids) and social_account_id is not null`;
      try {
        for (const t of threads) {
          const page = await adapter.messages(t.external_id);
          await storeSocialChat(
            ctx.db,
            userId,
            platform,
            { chatId: t.external_id, participants: 2, others: [{ accountId: t.social_account_id! }] },
            page.items,
            { now: ctx.now() },
          );
        }
      } catch (e) {
        if (!(e instanceof SocialBudgetSpent)) throw e;
        await later(ctx, job, Math.max(MIN, (e.retryAt?.getTime() ?? 0) - ctx.now().getTime()), 'retry');
      }
    },

    'social.lookup': async (job, ctx) => {
      const lookupId = job.payload.lookupId;
      if (typeof lookupId !== 'string') throw new JobSkipped('bad_payload');
      const [l] = await ctx.db.sql<{ user_id: string; platform: SocialPlatform }>`
        select user_id, platform from orbit.social_lookups where id = ${lookupId}::uuid`;
      if (!l) return;
      if (l.platform === 'x') {
        if (!deps.x) throw new JobSkipped('unconfigured');
        const out = await runXLookup(ctx.db, lookupId, {
          ...deps.x,
          fetch: deps.x.fetch ?? deps.fetch,
          now: ctx.now,
          offered,
        });
        if (out.status === 'waiting')
          await later(ctx, job, Math.max(MIN, (out.retryAt?.getTime() ?? 0) - ctx.now().getTime()), 'resume');
        return;
      }
      if (!(await sourceIsOn(ctx.db, l.user_id, l.platform, offered))) {
        await ctx.db.sql`
          update orbit.social_lookups set status = 'failed', result = ${{ bridges: [], oneWay: [], partial: true, reason: 'source_off' }}::jsonb
           where id = ${lookupId}::uuid and status not in ('done', 'failed')`;
        return;
      }
      const account = await connectedAccount(ctx.db, l.user_id, l.platform);
      const adapter = account ? adapterFor(ctx.db, env(ctx), l.platform, account, 'student') : undefined;
      if (!adapter) {
        await ctx.db.sql`
          update orbit.social_lookups set status = 'failed', result = ${{ bridges: [], oneWay: [], partial: true, reason: 'sign_in' }}::jsonb
           where id = ${lookupId}::uuid and status not in ('done', 'failed')`;
        return;
      }
      const out = await runLookup(ctx.db, adapter, lookupId, { now: ctx.now(), offered });
      if (out.status !== 'waiting') return;
      const ms = out.retryAt
        ? Math.max(MIN, out.retryAt.getTime() - ctx.now().getTime()) + unevenMs(2 * MIN, random)
        : unevenMs(LOOKUP_SOON_MS, random);
      await later(ctx, job, ms, 'resume');
    },
  };
}
