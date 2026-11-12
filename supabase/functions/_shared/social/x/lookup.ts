/**
 * Who could introduce the student to a target on X (plan 43 §5 "Check X for Priya", §3.6 without the count), with the
 * price first.
 *
 * 1. `quoteXLookup`: the target's X account must be attached to the person (public proof only, match.ts); the price is
 *    `quoteXCheck` (one paid profile read). The quote is written to the audit log (`x.quote`) so the confirm that
 *    follows runs under what the student was shown.
 * 2. `confirmXLookup`: the student said yes to that price within QUOTE_FRESH_MS. A lookup row is made with the quote as
 *    `quoted_usd` and queued (`social.lookup`).
 * 3. `runXLookup` (the job): every read goes through the student's X budget with a ceiling of the quote less what the
 *    lookup has already cost, so the check is never charged more than was quoted. Lists are read to the end or not at
 *    all (`readXListToEnd`): the target's shorter list first, then the other direction from whichever side is cheaper
 *    (the target's other list, or each candidate's own list of the same name). Nothing partial is stored, and the
 *    student's own list is never read for anyone else: X lists are never shared with friends.
 */

import type { OptionalSource } from '@orbit/core/sources';
import type { Db } from '../../db.ts';
import { HttpError } from '../../http.ts';
import type { Queue } from '../../queue.ts';
import { sourceIsOn } from '../../sources/states.ts';
import type { SocialList } from '../adapter.ts';
import { loadAccounts, suppressedOf } from '../graph.ts';
import { attachedAccount, type LookupResult, notifyLookup } from '../lookup.ts';
import { ensureAccountPerson, personForAccount } from '../people.ts';
import { type FollowPair, rewriteFollowTies } from '../ties.ts';
import { type XDeps, xAdapterFor } from './client.ts';
import { roundUsd } from './config.ts';
import { heldXList, readXListToEnd, type XListResult } from './lists.ts';
import { quoteXCheck, type XQuote, xCircle, xListUnits, xPrice } from './spend.ts';

/** How long a quote stays good for the confirm that follows it. */
export const QUOTE_FRESH_MS = 15 * 60_000;

export interface XQuoteResponse {
  status: 'quote';
  quoteUsd: number;
  list: SocialList | null;
  size: number;
  reason?: XQuote['reason'];
}

/** Quote reasons that leave nothing to run: the confirm is refused with the words for each. */
const CANNOT_RUN: Partial<Record<NonNullable<XQuote['reason']>, string>> = {
  protected: 'Their X account is protected, so Orbit cannot see who they follow.',
  gone: 'That X account is no longer there.',
  too_big: 'Their X lists are too long to check within the limit.',
  limit: 'Orbit has reached its X spending limit for this month.',
  rate_limited: 'X asked Orbit to slow down. Try again in a few minutes.',
  not_connected: 'X is not connected. Sign in with X in Settings first.',
};

async function targetAccount(db: Db, userId: string, personId: string): Promise<string> {
  const account = await attachedAccount(db, userId, 'x', personId);
  if (!account)
    throw new HttpError(409, 'no_account', 'Orbit does not know their X account for sure, so it cannot look');
  return account;
}

/** The price of checking a person on X, before anything is read beyond their profile. */
export async function quoteXLookup(
  db: Db,
  userId: string,
  personId: string,
  deps: XDeps,
): Promise<XQuoteResponse> {
  const account = await targetAccount(db, userId, personId);
  const q = await quoteXCheck(db, userId, account, deps);
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'user', 'x.quote', 'people', ${personId},
            ${{ accountId: q.targetAccountId ?? account, quoteUsd: q.quoteUsd, list: q.list, size: q.size, reason: q.reason ?? null }}::jsonb)`;
  return {
    status: 'quote',
    quoteUsd: q.quoteUsd,
    list: q.list,
    size: q.size,
    ...(q.reason ? { reason: q.reason } : {}),
  };
}

/**
 * The student agreed to the price: the check is queued with the quote as its ceiling. A price the student passes back
 * can only lower the ceiling. Without a fresh quote for this person, nothing runs.
 */
export async function confirmXLookup(
  db: Db,
  queue: Queue,
  userId: string,
  personId: string,
  o: { now: Date; quoteUsd?: number },
): Promise<{ lookupId: string; status: 'queued' | 'running' | 'waiting'; quoteUsd: number }> {
  const [open] = await db.sql<{
    id: string;
    status: 'queued' | 'running' | 'waiting';
    quoted_usd: string | null;
  }>`
    select id, status, quoted_usd::text from orbit.social_lookups
     where user_id = ${userId}::uuid and platform = 'x' and target_person_id = ${personId}::uuid
       and status in ('queued', 'running', 'waiting')
     order by created_at desc limit 1`;
  if (open) return { lookupId: open.id, status: open.status, quoteUsd: Number(open.quoted_usd ?? 0) };
  const [q] = await db.sql<{
    details: {
      accountId?: string;
      quoteUsd?: number;
      list?: SocialList | null;
      size?: number;
      reason?: string | null;
    };
  }>`
    select details from orbit.audit_log
     where user_id = ${userId}::uuid and action = 'x.quote' and target_table = 'people' and target_id = ${personId}
       and created_at >= ${new Date(o.now.getTime() - QUOTE_FRESH_MS)}::timestamptz
     order by id desc limit 1`;
  const d = q?.details;
  if (!d || typeof d.quoteUsd !== 'number' || !d.accountId)
    throw new HttpError(409, 'quote_first', 'Ask for the price first, then confirm it.');
  const why = d.reason ? CANNOT_RUN[d.reason as NonNullable<XQuote['reason']>] : undefined;
  if (why) throw new HttpError(409, d.reason!, why);
  const shown =
    typeof o.quoteUsd === 'number' && Number.isFinite(o.quoteUsd) ? Math.max(0, o.quoteUsd) : undefined;
  const ceiling = roundUsd(shown === undefined ? d.quoteUsd : Math.min(shown, d.quoteUsd));
  const [row] = await db.sql<{ id: string }>`
    insert into orbit.social_lookups (user_id, platform, target_person_id, target_account_id, status, state,
                                      quoted_usd)
    values (${userId}::uuid, 'x', ${personId}::uuid, ${d.accountId}, 'queued',
            ${{ list: d.list ?? null, size: d.size ?? 0 }}::jsonb, ${ceiling}::numeric)
    returning id`;
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'user', 'x.check_confirmed', 'social_lookups', ${row!.id},
            ${{ quoteUsd: ceiling }}::jsonb)`;
  await queue.enqueue({
    kind: 'social.lookup',
    userId,
    payload: { lookupId: row!.id },
    dedupeKey: `social.lookup:${row!.id}:start`,
  });
  return { lookupId: row!.id, status: 'queued', quoteUsd: ceiling };
}

export type XLookupResult = Omit<LookupResult, 'reason'> & {
  reason?: LookupResult['reason'] | 'over_quote' | 'too_big' | 'gone' | 'limit' | 'not_connected';
};

export interface XRunOutcome {
  status: 'done' | 'failed' | 'waiting';
  retryAt?: Date;
  costUsd: number;
}

type Dir = 'yes' | 'no' | 'unknown';

/** Runs an X check under its quote (job kind `social.lookup` for an X lookup). */
export async function runXLookup(
  db: Db,
  lookupId: string,
  deps: XDeps & { offered?: readonly OptionalSource[] },
): Promise<XRunOutcome> {
  const now = deps.now ?? (() => new Date());
  const [l] = await db.sql<{
    user_id: string;
    target_person_id: string;
    target_account_id: string;
    status: string;
    state: { list?: SocialList | null; size?: number };
    quoted_usd: string | null;
    cost_usd: string;
  }>`
    select user_id, target_person_id, target_account_id, status, state, quoted_usd::text, cost_usd::text
      from orbit.social_lookups where id = ${lookupId}::uuid and platform = 'x'`;
  if (!l) return { status: 'failed', costUsd: 0 };
  const spent = Number(l.cost_usd ?? 0);
  if (l.status === 'done' || l.status === 'failed')
    return { status: l.status as 'done' | 'failed', costUsd: spent };
  const userId = l.user_id;
  const target = l.target_account_id;
  const quote = Number(l.quoted_usd ?? 0);
  const end = async (status: 'done' | 'failed', result: XLookupResult, cost: number) => {
    await db.sql`
      update orbit.social_lookups set status = ${status}, result = ${JSON.parse(JSON.stringify(result))}::jsonb,
             cost_usd = ${roundUsd(spent + cost)}::numeric
       where id = ${lookupId}::uuid`;
    if (status === 'done')
      await notifyLookup(db, userId, l.target_person_id, 'x', result as LookupResult, lookupId);
    return { status, costUsd: roundUsd(spent + cost) };
  };
  const none = (reason: XLookupResult['reason'], partial = true): XLookupResult => ({
    bridges: [],
    oneWay: [],
    partial,
    reason,
  });
  if (!(await sourceIsOn(db, userId, 'x', deps.offered ?? (deps.cfg.offered ? ['x'] : []))))
    return end('failed', none('source_off'), 0);
  if ((await suppressedOf(db, 'x', [target])).size) return end('failed', none('suppressed'), 0);
  const client = await xAdapterFor(db, userId, deps, {
    caller: 'check',
    ceilingUsd: Math.max(0, roundUsd(quote - spent)),
  });
  if (!client) return end('failed', none('not_connected'), 0);
  await db.sql`update orbit.social_lookups set status = 'running' where id = ${lookupId}::uuid`;
  const cost = () => client.spend.chargedUsd();
  const limit = deps.cfg.listLimit;
  const circle = (await xCircle(db, userId, client.meId)).filter((id) => id !== target);
  if (!circle.length) return end('done', none('no_circle', false), 0);

  const list: SocialList = l.state?.list ?? 'following';
  const other: SocialList = list === 'following' ? 'followers' : 'following';
  const read = (accountId: string, which: SocialList, size?: number) =>
    readXListToEnd(db, client.adapter, {
      accountId,
      list: which,
      limit,
      ...(size !== undefined ? { size } : {}),
      readBy: userId,
      now,
    });
  // a read the check could not finish ends it: what was stopped is said, and nothing partial was kept
  const stopped = async (r: Extract<XListResult, { ok: false }>) => {
    if (r.reason === 'rate_limited') {
      await db.sql`
        update orbit.social_lookups set status = 'waiting', cost_usd = ${roundUsd(spent + cost())}::numeric
         where id = ${lookupId}::uuid`;
      return {
        status: 'waiting' as const,
        retryAt: new Date(now().getTime() + 15 * 60_000),
        costUsd: spent + cost(),
      };
    }
    const reason: XLookupResult['reason'] =
      r.reason === 'budget'
        ? 'over_quote'
        : r.reason === 'protected'
          ? 'private'
          : r.reason === 'suppressed'
            ? 'suppressed'
            : r.reason;
    return end('done', none(reason), cost());
  };

  const first = await read(target, list, l.state?.size);
  if (!first.ok) return stopped(first);
  const onFirst = new Set(first.ids);
  // list 'following': the target follows them; 'followers': they follow the target
  const candidates = circle.filter((id) => onFirst.has(id));

  // the other direction, for the candidates only, from the cheaper side
  const confirmed = new Map<string, Dir>();
  if (candidates.length) {
    const targetOther = await heldXList(db, target, other, userId, now());
    const [t] = (await loadAccounts(db, 'x', [target])).values();
    const otherSize = other === 'following' ? t?.following : t?.followers;
    const viaTarget =
      targetOther || (typeof otherSize === 'number' && otherSize <= limit)
        ? targetOther
          ? 0
          : xPrice('list', xListUnits(otherSize ?? 0))
        : Number.POSITIVE_INFINITY;
    const sizes = await loadAccounts(db, 'x', candidates);
    let viaCandidates = 0;
    for (const c of candidates) {
      if (await heldXList(db, c, list, userId, now())) continue;
      const k = sizes.get(c);
      const n = list === 'following' ? k?.following : k?.followers;
      viaCandidates = roundUsd(viaCandidates + xPrice('list', xListUnits(typeof n === 'number' ? n : limit)));
    }
    if (viaTarget <= viaCandidates) {
      const r = await read(target, other, targetOther ? undefined : (otherSize ?? undefined));
      if (!r.ok) return stopped(r);
      const ids = new Set(r.ids);
      for (const c of candidates) confirmed.set(c, ids.has(c) ? 'yes' : 'no');
    } else
      for (const c of candidates) {
        const k = sizes.get(c);
        const n = list === 'following' ? k?.following : k?.followers;
        const r = await read(c, list, typeof n === 'number' ? n : undefined);
        if (!r.ok) {
          if (r.reason === 'budget' || r.reason === 'rate_limited') return stopped(r);
          // a candidate whose list cannot be read (protected, too long) stays unknown
          confirmed.set(c, 'unknown');
          continue;
        }
        confirmed.set(c, r.ids.includes(target) ? 'yes' : 'no');
      }
  }

  // the people, the ties and the answer
  const targetPerson = l.target_person_id;
  const accounts = await loadAccounts(db, 'x', circle);
  const result: XLookupResult = { bridges: [], oneWay: [], partial: false };
  const pairs: FollowPair[] = [];
  for (const c of circle) {
    const on = onFirst.has(c);
    const back: Dir = on ? (confirmed.get(c) ?? 'unknown') : 'unknown';
    if (on && back === 'unknown') result.partial = true;
    // aFollowsB: the circle account follows the target; bFollowsA: the target follows them
    const targetFollows: Dir = list === 'following' ? (on ? 'yes' : 'no') : back;
    const followsTarget: Dir = list === 'followers' ? (on ? 'yes' : 'no') : back;
    const bridge = targetFollows === 'yes' && followsTarget === 'yes';
    const oneWay = !bridge && (targetFollows === 'yes' || followsTarget === 'yes');
    let personId = (await personForAccount(db, userId, 'x', c))?.personId;
    if (!personId && (bridge || oneWay)) {
      const a = accounts.get(c);
      personId = (
        await ensureAccountPerson(
          db,
          userId,
          { platform: 'x', id: c, username: a?.username ?? c, name: a?.name ?? undefined },
          now(),
        )
      ).personId;
    }
    if (!personId || personId === targetPerson) continue;
    pairs.push({
      aPerson: personId,
      aAccount: c,
      bPerson: targetPerson,
      bAccount: target,
      aFollowsB: followsTarget,
      bFollowsA: targetFollows,
      aFollowing: accounts.get(c)?.following ?? undefined,
    });
    const name = accounts.get(c)?.name ?? accounts.get(c)?.username ?? c;
    if (bridge) result.bridges.push({ personId, accountId: c, name });
    else if (oneWay && back !== 'unknown')
      result.oneWay.push({
        personId,
        accountId: c,
        followerId: followsTarget === 'yes' ? personId : targetPerson,
      });
  }
  await rewriteFollowTies(db, userId, 'x', pairs, { now: now(), lookupId });
  if (!result.bridges.length && !result.oneWay.length && !result.partial) result.reason = 'none';
  if (result.bridges.length || result.oneWay.length)
    await db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${userId}::uuid, 'system', 'social.lookup', 'social_lookups', ${lookupId},
              ${{ platform: 'x', bridges: result.bridges.length, oneWay: result.oneWay.length, costUsd: cost() }}::jsonb)`;
  return end('done', result, cost());
}
