/**
 * The student's pick after a 409 `pick_person` (plan 43 §3.4): both the account's own person and the person the
 * student named have things of their own, so the student picks which one stays (`keep`), and that cannot be undone.
 *
 * The account is attached to the kept person first (what the account brought moves with it), then the other person is
 * merged into the kept one the way Orbit merges two people (`mergePeople`), with everything they have: notes, chats,
 * drafts, mail, the closeness rating, and what the account layer holds of them.
 *
 * Who the other person is: the person the account was being attached to (`personId`) when the student keeps the
 * account's own person; the account's own person when the student keeps `personId`. A browser that sends the pick as
 * both `personId` and `keep` (the question card does) is read the same way: the other person is the one the open
 * question about this account names.
 */
import type { SocialPlatform } from '@orbit/core/entity/social';
import type { Db } from '../db.ts';
import { mergePeople } from '../ingest/people.ts';
import { sqlQueue } from '../queue.ts';
import { type AttachInput, accountPeople, attachAccount } from './links.ts';
import { rebuildAccountTies } from './ties.ts';

export type KeepResult =
  | { status: 'attached'; linkId: string; kept: string; merged: string[] }
  | { status: 'no_person' }
  | { status: 'linked_elsewhere'; personId: string }
  /** `keep` is neither the account's own person nor the person it is being attached to */
  | { status: 'bad_keep' }
  /** the account has open questions about more than one person: the browser must say which one */
  | { status: 'ambiguous' };

/** What the response says about the pick (no em dashes, no exclamation marks). */
export const KEEP_CANNOT_BE_UNDONE = 'Merged into the one you kept. This cannot be undone.';

export async function attachKeeping(
  db: Db,
  userId: string,
  a: Omit<AttachInput, 'ownPerson'>,
  keep: string,
): Promise<KeepResult> {
  const [link] = await db.sql<{ id: string; person_id: string }>`
    select id, person_id from orbit.social_links
     where user_id = ${userId}::uuid and platform = ${a.platform} and account_id = ${a.accountId}`;
  if (link && link.person_id !== keep) return { status: 'linked_elsewhere', personId: link.person_id };
  const own = await accountPeople(db, userId, a.platform, a.accountId);
  let losers: string[];
  if (own.includes(keep)) {
    // the account stays on its own person: the person it was being attached to is merged in
    let other: string | undefined = a.personId !== keep ? a.personId : undefined;
    if (!other) {
      const asked = await openAskPeople(db, userId, a.platform, a.accountId, [...own]);
      if (asked.length > 1) return { status: 'ambiguous' };
      other = asked[0];
    }
    losers = [...own.filter((id) => id !== keep), ...(other ? [other] : [])];
  } else if (keep === a.personId) {
    losers = own;
  } else return { status: 'bad_keep' };
  const people = await db.sql<{ id: string }>`
    select id from orbit.people
     where user_id = ${userId}::uuid and id = any(${[keep, ...losers]}::uuid[])
       and deleted_at is null and merged_into is null and not is_self`;
  if (!people.some((p) => p.id === keep)) return { status: 'no_person' };
  losers = [...new Set(losers)].filter((id) => id !== keep && people.some((p) => p.id === id));

  return db.begin(async (tx) => {
    // 1. the account goes on the kept person; what it brought moves there, nothing else yet
    const r = await attachAccount(tx, userId, { ...a, personId: keep, ownPerson: 'leave' });
    if (r.status === 'no_person') return r;
    if (r.status === 'linked_elsewhere') return r;
    if (r.status === 'conflict') throw new Error('attachKeeping: unexpected conflict');
    // 2. the other person is merged into the kept one, with everything they have
    const merged: string[] = [];
    for (const loser of losers)
      if (await mergePeople(tx, userId, keep, loser, { pickedByStudent: true })) merged.push(loser);
    // 3. the follow ties of every account now on the kept person, rebuilt for them (the merge dropped the loser's)
    const links = await tx.sql<{ platform: SocialPlatform; account_id: string }>`
      select platform, account_id from orbit.social_links where user_id = ${userId}::uuid and person_id = ${keep}::uuid`;
    for (const l of links) await rebuildAccountTies(tx, userId, l.platform, l.account_id, keep, a.now);
    await tx.sql`
      update orbit.social_match_asks set status = 'yes', decided_at = ${a.now}::timestamptz
       where user_id = ${userId}::uuid and platform = ${a.platform} and account_id = ${a.accountId}
         and person_id = ${keep}::uuid and status in ('open', 'stale')`;
    await tx.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${userId}::uuid, 'user', 'social.keep', 'social_links', ${r.linkId},
              ${{ platform: a.platform, accountId: a.accountId, kept: keep, merged, undoable: false }}::jsonb)`;
    if (merged.length) {
      const q = sqlQueue(tx);
      await q.enqueue({
        kind: 'score.person',
        userId,
        payload: { personIds: [keep] },
        dedupeKey: `score.person:${userId}:social:keep:${r.linkId}`,
      });
      await q.enqueue({
        kind: 'friend_shares_refresh',
        userId,
        payload: {},
        dedupeKey: `friend_shares_refresh:${userId}:social:keep:${r.linkId}`,
      });
    }
    return { status: 'attached' as const, linkId: r.linkId, kept: keep, merged };
  });
}

/** The people open questions about this account name, apart from `except`. */
async function openAskPeople(
  db: Db,
  userId: string,
  platform: SocialPlatform,
  accountId: string,
  except: string[],
): Promise<string[]> {
  const rows = await db.sql<{ person_id: string }>`
    select distinct k.person_id from orbit.social_match_asks k
      join orbit.people p on p.id = k.person_id and p.deleted_at is null and p.merged_into is null
     where k.user_id = ${userId}::uuid and k.platform = ${platform} and k.account_id = ${accountId}
       and k.status = 'open' and not (k.person_id = any(${except}::uuid[]))`;
  return rows.map((r) => r.person_id);
}
