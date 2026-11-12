/**
 * Follow ties (plan 43 §3.6, §3.7): `<platform>_mutual` between two people who follow each other, with core's
 * `socialFollowWeight` (a follow back from someone selective weighs more), and `<platform>_follow` for a one-way
 * follow, with `evidence.followerId` naming who follows. They are rewritten from the graph every time, never kept at
 * the higher of an old and a new weight (the tie writer for other kinds only ever raises one), and removed when the
 * follow is gone or the list behind it expired. Evidence records which account stood for each person, so a detach
 * can take back exactly the ties an account made.
 */
import type { SocialPlatform } from '@orbit/core/entity/social';
import type { Direction } from '@orbit/core/graph/socialLookup';
import { socialFollowWeight, TIE_CONFIDENCE, type TieKind } from '@orbit/core/graph/ties';
import type { Db } from '../db.ts';

export const mutualKind = (p: SocialPlatform) => `${p}_mutual` as TieKind;
export const followKind = (p: SocialPlatform) => `${p}_follow` as TieKind;

export interface FollowPair {
  aPerson: string;
  aAccount: string;
  bPerson: string;
  bAccount: string;
  /** a follows b */
  aFollowsB: Direction;
  /** b follows a */
  bFollowsA: Direction;
  /** how many accounts each follows, when known: a selective follower's follow weighs more */
  aFollowing?: number;
  bFollowing?: number;
}

export type TieWritten = 'mutual' | 'follow' | 'none';

/** Writes what the graph says about each pair, and removes what it no longer says. */
export async function rewriteFollowTies(
  db: Db,
  userId: string,
  platform: SocialPlatform,
  pairs: FollowPair[],
  o: { now: Date; lookupId?: string },
): Promise<Map<string, TieWritten>> {
  const out = new Map<string, TieWritten>();
  for (const p of pairs) {
    if (p.aPerson === p.bPerson) continue;
    const [aId, bId] = p.aPerson < p.bPerson ? [p.aPerson, p.bPerson] : [p.bPerson, p.aPerson];
    const accounts = { [p.aPerson]: p.aAccount, [p.bPerson]: p.bAccount };
    const mutual = p.aFollowsB === 'yes' && p.bFollowsA === 'yes';
    const oneWay =
      !mutual &&
      ((p.aFollowsB === 'yes' && p.bFollowsA === 'no') || (p.bFollowsA === 'yes' && p.aFollowsB === 'no'));
    const keep: TieKind | null = mutual ? mutualKind(platform) : oneWay ? followKind(platform) : null;
    for (const kind of [mutualKind(platform), followKind(platform)])
      if (kind !== keep)
        await db.sql`
          delete from orbit.ties
           where user_id = ${userId}::uuid and a_person_id = ${aId}::uuid and b_person_id = ${bId}::uuid
             and kind = ${kind}`;
    if (!keep) {
      out.set(`${p.aPerson}|${p.bPerson}`, 'none');
      continue;
    }
    const weight = mutual
      ? socialFollowWeight(p.aFollowing, p.bFollowing)
      : // a one-way follow: support only (core HOP_WEIGHTS.socialFollow)
        0.1;
    const evidence = {
      platform,
      accounts,
      ...(oneWay ? { followerId: p.aFollowsB === 'yes' ? p.aPerson : p.bPerson } : {}),
      ...(o.lookupId ? { lookupId: o.lookupId } : {}),
    };
    await db.sql`
      insert into orbit.ties (user_id, a_person_id, b_person_id, kind, weight, confidence, evidence, first_seen_at,
                              last_seen_at)
      values (${userId}::uuid, ${aId}::uuid, ${bId}::uuid, ${keep}, ${weight}::real, ${TIE_CONFIDENCE[keep]}::real,
              ${evidence}::jsonb, ${o.now}::timestamptz, ${o.now}::timestamptz)
      on conflict (user_id, a_person_id, b_person_id, kind) do update set
        weight = excluded.weight, confidence = excluded.confidence, evidence = excluded.evidence,
        last_seen_at = excluded.last_seen_at`;
    out.set(`${p.aPerson}|${p.bPerson}`, mutual ? 'mutual' : 'follow');
  }
  return out;
}

/** The follow ties an account stood for on a person's side. */
export async function deleteAccountTies(
  db: Db,
  userId: string,
  platform: SocialPlatform,
  personId: string,
  accountId: string,
): Promise<number> {
  const rows = await db.sql<{ id: string }>`
    delete from orbit.ties
     where user_id = ${userId}::uuid and kind in (${mutualKind(platform)}, ${followKind(platform)})
       and (a_person_id = ${personId}::uuid or b_person_id = ${personId}::uuid)
       and evidence -> 'accounts' ->> ${personId}::text = ${accountId}
    returning id`;
  return rows.length;
}

/**
 * Rebuilds the follow ties of one account (after an attach or a detach) from the follows Orbit holds, with every
 * other account that stands for a person: following each other where both rows are there, nothing where they are not.
 */
export async function rebuildAccountTies(
  db: Db,
  userId: string,
  platform: SocialPlatform,
  accountId: string,
  personId: string,
  now: Date,
): Promise<void> {
  const others = await db.sql<{ account_id: string; person_id: string; out: boolean; back: boolean }>`
    with accts as (
      select l.account_id, l.person_id from orbit.social_links l
       where l.user_id = ${userId}::uuid and l.platform = ${platform}
      union
      select split_part(p.source_account, ':', 2), p.id from orbit.people p
       where p.user_id = ${userId}::uuid and p.deleted_at is null and p.source_account like ${`${platform}:%`}
    )
    select a.account_id, a.person_id,
           exists (select 1 from orbit.social_follows f where f.platform = ${platform} and f.follower_id = ${accountId}
                     and f.followed_id = a.account_id and f.expires_at > now()
                     and (f.owner_user_id is null or f.owner_user_id = ${userId}::uuid)) as out,
           exists (select 1 from orbit.social_follows f where f.platform = ${platform} and f.follower_id = a.account_id
                     and f.followed_id = ${accountId} and f.expires_at > now()
                     and (f.owner_user_id is null or f.owner_user_id = ${userId}::uuid)) as back
      from accts a
     where a.account_id <> ${accountId} and a.person_id <> ${personId}::uuid`;
  const counts = await db.sql<{ account_id: string; following: number | null }>`
    select account_id, following from orbit.social_accounts
     where platform = ${platform} and account_id = any(${[accountId, ...others.map((o) => o.account_id)]}::text[])`;
  const following = new Map(counts.map((c) => [c.account_id, c.following ?? undefined]));
  await rewriteFollowTies(
    db,
    userId,
    platform,
    others
      .filter((o) => o.out && o.back)
      .map((o) => ({
        aPerson: personId,
        aAccount: accountId,
        bPerson: o.person_id,
        bAccount: o.account_id,
        aFollowsB: 'yes' as const,
        bFollowsA: 'yes' as const,
        aFollowing: following.get(accountId),
        bFollowing: following.get(o.account_id),
      })),
    { now },
  );
}
