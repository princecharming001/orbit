/**
 * Removing what one platform brought for one student (plan 43 §3.1, "Removed", and "a different account"): the
 * messages and threads, follow ties, id identities and the contacts accounts added, attachments, questions and
 * lookups, the student's own follow lists and list reads, and the student's own account in the shared graph. People
 * known only from the platform are deleted unless the student has a chat or a note with them; then they stay, without
 * the account. Drafts waiting to go out on the platform become unsent drafts. The student's "not the same" answers
 * are kept, so they are not asked again.
 *
 * TODO(plan 43): the server-base builder's Off/Removed per artifact may take this over; keep one removal.
 */
import type { SocialPlatform } from '@orbit/core/entity/social';
import type { Db } from '../db.ts';
import { identityKind } from './keys.ts';
import { followKind, mutualKind } from './ties.ts';

export interface Removed {
  messages: number;
  people: number;
  ties: number;
}

export async function removeSocialRows(
  db: Db,
  userId: string,
  platform: SocialPlatform,
  o: { ownAccountId?: string | null } = {},
): Promise<Removed> {
  return db.begin(async (tx) => {
    const msgs = await tx.sql<{ id: string }>`
      delete from orbit.messages where user_id = ${userId}::uuid and provider = ${platform} returning id`;
    await tx.sql`delete from orbit.threads where user_id = ${userId}::uuid and provider = ${platform}`;
    const ties = await tx.sql<{ id: string }>`
      delete from orbit.ties where user_id = ${userId}::uuid
         and kind in (${mutualKind(platform)}, ${followKind(platform)}) returning id`;
    await tx.sql`
      delete from orbit.person_identities
       where user_id = ${userId}::uuid and (kind = ${identityKind(platform)} or source = ${platform})`;
    await tx.sql`
      delete from orbit.facts where user_id = ${userId}::uuid and source_table like ${`social:${platform}:%`}`;
    await tx.sql`delete from orbit.social_links where user_id = ${userId}::uuid and platform = ${platform}`;
    await tx.sql`delete from orbit.social_match_asks where user_id = ${userId}::uuid and platform = ${platform}`;
    await tx.sql`delete from orbit.social_lookups where user_id = ${userId}::uuid and platform = ${platform}`;
    await tx.sql`delete from orbit.social_follows where owner_user_id = ${userId}::uuid and platform = ${platform}`;
    await tx.sql`delete from orbit.social_list_reads where owner_user_id = ${userId}::uuid and platform = ${platform}`;
    if (o.ownAccountId) {
      // the student's own account leaves the shared graph too, as on account deletion
      await tx.sql`
        delete from orbit.social_follows where platform = ${platform}
           and (follower_id = ${o.ownAccountId} or followed_id = ${o.ownAccountId})`;
      await tx.sql`
        delete from orbit.social_list_reads where platform = ${platform} and account_id = ${o.ownAccountId}`;
    }
    // people only this platform knew: gone, unless the student has a chat or a note with them
    const people = await tx.sql<{ id: string }>`
      delete from orbit.people p
       where p.user_id = ${userId}::uuid and p.source_account like ${`${platform}:%`}
         and not exists (select 1 from orbit.chats c where c.user_id = p.user_id and c.person_id = p.id)
         and not exists (select 1 from orbit.notes n where n.user_id = p.user_id and p.id = any(n.person_ids))
      returning p.id`;
    await tx.sql`
      update orbit.people set source_account = null, listed = true
       where user_id = ${userId}::uuid and source_account like ${`${platform}:%`}`;
    await tx.sql`
      update orbit.drafts set status = 'draft', error = 'source_removed'
       where user_id = ${userId}::uuid and channel = ${platform} and status in ('approved', 'scheduled', 'failed')`;
    await tx.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, details)
      values (${userId}::uuid, 'system', 'social.removed', 'social_links',
              ${{ platform, messages: msgs.length, people: people.length, ties: ties.length }}::jsonb)`;
    return { messages: msgs.length, people: people.length, ties: ties.length };
  });
}
