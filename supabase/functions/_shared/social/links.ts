/**
 * Attach and detach (plan 43 §3.4 "Attach and detach"). Attaching an account to a person is a link, never a merge:
 * every message, touch, tie, identity and fact that came from the account carries the account's id, so a wrong match
 * can be taken back whole with "Not their account".
 *
 * Attach. When the account already has a person of its own (made when it became a chat partner or a bridge), that
 * person's stamped rows move to the person it is attached to and the empty person is deleted. If that person has
 * gained anything unstamped (a note, a chat in the pipeline, a draft, mail, the student's closeness rating), nothing
 * is folded: the caller gets both people and the student picks.
 *
 * Detach, row by row as the plan's table: messages, touches and thread membership from the account move to a new
 * unlisted person for it; its follow ties are deleted and rebuilt for that person; facts read from its bio are
 * deleted; an email or phone it added is taken off the person, and a match that contact proved is offered for review;
 * drafts queued to it are paused with a note; a chat that moved to "replied" on its message gets a proposal to move
 * back; the student's closeness rating stays; open questions about it close; both people are rescored and the friend
 * projection rebuilt; and the answer is remembered as "not the same", never proposed again.
 *
 * A person who owns an attached account is never merged the old way (`refuseSocialMerge`).
 */
import type { SocialAccount, SocialPlatform, SocialProof } from '@orbit/core/entity/social';
import type { Db } from '../db.ts';
import { sqlQueue } from '../queue.ts';
import { loadAccounts } from './graph.ts';
import { factSource, identityKind, platformName, sourceAccount } from './keys.ts';
import { deleteAccountTies, rebuildAccountTies } from './ties.ts';

export type AttachResult =
  | { status: 'attached'; linkId: string; folded?: string }
  | { status: 'exists'; linkId: string }
  | { status: 'no_person' }
  | { status: 'linked_elsewhere'; personId: string }
  | { status: 'conflict'; accountPersonId: string; personId: string };

export interface AttachInput {
  platform: SocialPlatform;
  accountId: string;
  personId: string;
  via: 'proof' | 'score' | 'student';
  proof?: SocialProof;
  score?: number;
  now: Date;
  /** the account as read, when the caller has it (its email, phone and bio) */
  account?: SocialAccount;
}

/** Thrown by the old merge path for a person who owns an attached account. */
export class SocialMergeRefused extends Error {
  constructor(readonly personId: string) {
    super(
      'This person has an Instagram or X account attached, so they are not merged. Attach the account to the other person instead.',
    );
    this.name = 'SocialMergeRefused';
  }
}

/** Throws SocialMergeRefused when either person owns an attached account (or was made from one). */
export async function refuseSocialMerge(db: Db, userId: string, personIds: string[]): Promise<void> {
  const [r] = await db.sql<{ id: string }>`
    select l.person_id::text as id from orbit.social_links l
     where l.user_id = ${userId}::uuid and l.person_id = any(${personIds}::uuid[])
    union all
    select p.id::text from orbit.people p
     where p.user_id = ${userId}::uuid and p.id = any(${personIds}::uuid[]) and p.source_account is not null
    limit 1`;
  if (r) throw new SocialMergeRefused(r.id);
}

/** Anything a person has that did not come from the account: what makes folding them a decision for the student. */
async function hasUnstamped(db: Db, userId: string, personId: string, accountId: string): Promise<boolean> {
  const [r] = await db.sql<{ any: boolean }>`
    select exists (select 1 from orbit.notes where user_id = ${userId}::uuid and ${personId}::uuid = any(person_ids))
        or exists (select 1 from orbit.chats where user_id = ${userId}::uuid and person_id = ${personId}::uuid)
        or exists (select 1 from orbit.drafts where user_id = ${userId}::uuid and person_id = ${personId}::uuid)
        or exists (select 1 from orbit.tie_labels where user_id = ${userId}::uuid and person_id = ${personId}::uuid)
        or exists (select 1 from orbit.messages m where m.user_id = ${userId}::uuid
                     and (m.from_person_id = ${personId}::uuid or ${personId}::uuid = any(m.to_person_ids))
                     and coalesce(m.social_account_id, '') <> ${accountId}) as any`;
  return !!r?.any;
}

/**
 * Moves what an account brought from one person to another: its messages (from, to, and the threads they are on),
 * the identities it added, the facts read from it, lookups about it. Follow ties are taken off `from`; the caller
 * rebuilds them for `to`.
 */
async function moveStamped(
  db: Db,
  userId: string,
  platform: SocialPlatform,
  accountId: string,
  from: string,
  to: string,
  o: { facts: 'move' | 'delete'; contacts: 'move' | 'drop' },
): Promise<{ droppedContacts: { kind: string; value: string }[] }> {
  await db.sql`
    update orbit.messages set from_person_id = ${to}::uuid
     where user_id = ${userId}::uuid and social_account_id = ${accountId} and from_person_id = ${from}::uuid`;
  await db.sql`
    update orbit.messages
       set to_person_ids = array(select distinct x from unnest(array_replace(to_person_ids, ${from}::uuid, ${to}::uuid)) x)
     where user_id = ${userId}::uuid and social_account_id = ${accountId} and ${from}::uuid = any(to_person_ids)`;
  await db.sql`
    update orbit.threads t
       set participant_person_ids = array(select distinct x from unnest(array_replace(t.participant_person_ids, ${from}::uuid, ${to}::uuid)) x)
     where t.user_id = ${userId}::uuid and ${from}::uuid = any(t.participant_person_ids)
       and (t.social_account_id = ${accountId}
         or exists (select 1 from orbit.messages m where m.thread_id = t.id and m.social_account_id = ${accountId}))
       and not exists (select 1 from orbit.messages m where m.thread_id = t.id
                         and (m.from_person_id = ${from}::uuid or ${from}::uuid = any(m.to_person_ids)))`;
  // the account's id identity always goes with it; an email or phone it added goes with it or is dropped
  await db.sql`
    update orbit.person_identities set person_id = ${to}::uuid
     where user_id = ${userId}::uuid and person_id = ${from}::uuid and social_account_id = ${accountId}
       and kind = ${identityKind(platform)}`;
  let dropped: { kind: string; value: string }[] = [];
  if (o.contacts === 'move')
    await db.sql`
      update orbit.person_identities set person_id = ${to}::uuid
       where user_id = ${userId}::uuid and person_id = ${from}::uuid and social_account_id = ${accountId}`;
  else
    dropped = (
      await db.sql<{ kind: string; value_norm: string }>`
        delete from orbit.person_identities
         where user_id = ${userId}::uuid and person_id = ${from}::uuid and social_account_id = ${accountId}
        returning kind, value_norm`
    ).map((r) => ({ kind: r.kind, value: r.value_norm }));
  if (o.facts === 'move')
    await db.sql`
      update orbit.facts set person_id = ${to}::uuid
       where user_id = ${userId}::uuid and person_id = ${from}::uuid and source_table = ${factSource(platform, accountId)}`;
  else
    await db.sql`
      delete from orbit.facts
       where user_id = ${userId}::uuid and person_id = ${from}::uuid and source_table = ${factSource(platform, accountId)}`;
  await db.sql`
    update orbit.social_lookups set target_person_id = ${to}::uuid
     where user_id = ${userId}::uuid and target_person_id = ${from}::uuid and target_account_id = ${accountId}`;
  await deleteAccountTies(db, userId, platform, from, accountId);
  return { droppedContacts: dropped };
}

async function audit(
  db: Db,
  userId: string,
  action: string,
  targetId: string,
  details: Record<string, unknown>,
) {
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'system', ${action}, 'social_links', ${targetId}, ${details}::jsonb)`;
}

async function rescore(db: Db, userId: string, personIds: string[], key: string) {
  const q = sqlQueue(db);
  await q.enqueue({
    kind: 'score.person',
    userId,
    payload: { personIds },
    dedupeKey: `score.person:${userId}:social:${key}`,
  });
  await q.enqueue({
    kind: 'friend_shares_refresh',
    userId,
    payload: {},
    dedupeKey: `friend_shares_refresh:${userId}:social:${key}`,
  });
}

export async function attachAccount(db: Db, userId: string, a: AttachInput): Promise<AttachResult> {
  const [person] = await db.sql<{ id: string }>`
    select id from orbit.people
     where id = ${a.personId}::uuid and user_id = ${userId}::uuid and deleted_at is null and merged_into is null
       and not is_self`;
  if (!person) return { status: 'no_person' };
  const [link] = await db.sql<{ id: string; person_id: string }>`
    select id, person_id from orbit.social_links
     where user_id = ${userId}::uuid and platform = ${a.platform} and account_id = ${a.accountId}`;
  if (link?.person_id === a.personId) return { status: 'exists', linkId: link.id };
  if (link) return { status: 'linked_elsewhere', personId: link.person_id };

  // the account's own person (made from it, or holding its id identity)
  const own = await db.sql<{ id: string }>`
    select p.id from orbit.people p
     where p.user_id = ${userId}::uuid and p.deleted_at is null and p.merged_into is null and p.id <> ${a.personId}::uuid
       and (p.source_account = ${sourceAccount(a.platform, a.accountId)}
         or exists (select 1 from orbit.person_identities i where i.person_id = p.id
                      and i.kind = ${identityKind(a.platform)} and i.value_norm = ${a.accountId}))`;
  for (const o of own)
    if (await hasUnstamped(db, userId, o.id, a.accountId))
      return { status: 'conflict', accountPersonId: o.id, personId: a.personId };

  return db.begin(async (tx) => {
    let folded: string | undefined;
    for (const o of own) {
      await moveStamped(tx, userId, a.platform, a.accountId, o.id, a.personId, {
        facts: 'move',
        contacts: 'move',
      });
      await tx.sql`
        update orbit.social_match_asks set person_id = ${a.personId}::uuid
         where user_id = ${userId}::uuid and person_id = ${o.id}::uuid
           and not exists (select 1 from orbit.social_match_asks x where x.user_id = ${userId}::uuid
                             and x.platform = orbit.social_match_asks.platform
                             and x.account_id = orbit.social_match_asks.account_id and x.person_id = ${a.personId}::uuid)`;
      await tx.sql`delete from orbit.people where id = ${o.id}::uuid and user_id = ${userId}::uuid`;
      folded = o.id;
    }
    const [row] = await tx.sql<{ id: string }>`
      insert into orbit.social_links (user_id, platform, account_id, person_id, via, proof, score)
      values (${userId}::uuid, ${a.platform}, ${a.accountId}, ${a.personId}::uuid, ${a.via}, ${a.proof ?? null},
              ${a.score ?? null}::real)
      returning id`;
    const accounts = a.account ? undefined : await loadAccounts(tx, a.platform, [a.accountId]);
    const acct = a.account;
    const stored = accounts?.get(a.accountId);
    const username = acct?.username ?? stored?.username ?? a.accountId;
    await tx.sql`
      insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source, social_account_id)
      values (${userId}::uuid, ${a.personId}::uuid, ${identityKind(a.platform)}, ${a.accountId}, ${username},
              ${a.platform}, ${a.accountId})
      on conflict (user_id, kind, value_norm) do update set person_id = excluded.person_id,
        social_account_id = excluded.social_account_id`;
    // an email or phone the account shows, stamped with it so a detach can take it back
    const email = (acct?.email ?? stored?.email ?? '').trim().toLowerCase();
    const phone = (acct?.phone ?? stored?.phone ?? '').replace(/[^\d+]/g, '');
    if (email.includes('@'))
      await tx.sql`
        insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source, social_account_id)
        values (${userId}::uuid, ${a.personId}::uuid, 'email', ${email}, ${email}, ${a.platform}, ${a.accountId})
        on conflict (user_id, kind, value_norm) do nothing`;
    if (phone.replace(/\D/g, '').length >= 10)
      await tx.sql`
        insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source, social_account_id)
        values (${userId}::uuid, ${a.personId}::uuid, 'phone', ${phone}, ${phone}, ${a.platform}, ${a.accountId})
        on conflict (user_id, kind, value_norm) do nothing`;
    // what came from the account before it had a person
    await tx.sql`
      update orbit.messages set from_person_id = ${a.personId}::uuid
       where user_id = ${userId}::uuid and social_account_id = ${a.accountId} and direction = 'in'
         and from_person_id is null`;
    await tx.sql`
      update orbit.messages set to_person_ids = array[${a.personId}::uuid]
       where user_id = ${userId}::uuid and social_account_id = ${a.accountId} and direction = 'out'
         and cardinality(to_person_ids) = 0`;
    await tx.sql`
      update orbit.threads
         set participant_person_ids = array(select distinct x from unnest(participant_person_ids || array[${a.personId}::uuid]) x)
       where user_id = ${userId}::uuid and social_account_id = ${a.accountId}
         and not (${a.personId}::uuid = any(participant_person_ids))`;
    const bio = acct?.bio ?? stored?.bio;
    if (bio?.trim())
      await tx.sql`
        insert into orbit.facts (user_id, person_id, type, text, source_table, occurred_at, confidence)
        select ${userId}::uuid, ${a.personId}::uuid, 'social_bio', ${`${platformName(a.platform)} bio: ${bio.trim().slice(0, 400)}`},
               ${factSource(a.platform, a.accountId)}, ${a.now}::timestamptz, 0.7
         where not exists (select 1 from orbit.facts where user_id = ${userId}::uuid and person_id = ${a.personId}::uuid
                             and source_table = ${factSource(a.platform, a.accountId)} and deleted_at is null)`;
    await tx.sql`
      update orbit.social_match_asks
         set status = case when person_id = ${a.personId}::uuid then 'yes' else 'stale' end, decided_at = ${a.now}::timestamptz
       where user_id = ${userId}::uuid and platform = ${a.platform} and account_id = ${a.accountId} and status = 'open'`;
    if (a.via === 'student')
      await tx.sql`
        delete from orbit.social_not_same
         where user_id = ${userId}::uuid and platform = ${a.platform} and account_id = ${a.accountId}
           and person_id = ${a.personId}::uuid`;
    await rebuildAccountTies(tx, userId, a.platform, a.accountId, a.personId, a.now);
    await audit(tx, userId, 'social.attach', row!.id, {
      platform: a.platform,
      accountId: a.accountId,
      personId: a.personId,
      via: a.via,
      ...(a.proof ? { proof: a.proof } : {}),
      ...(folded ? { folded } : {}),
    });
    await rescore(tx, userId, [a.personId], `attach:${row!.id}`);
    return { status: 'attached' as const, linkId: row!.id, ...(folded ? { folded } : {}) };
  });
}

export interface DetachResult {
  personId: string;
  accountPersonId: string;
  movedMessages: number;
  pausedDrafts: number;
  proposals: number;
  reviews: number;
}

/** "Not their account": undoes an attach row by row (plan 43 §3.4, the detach table). */
export async function detachLink(
  db: Db,
  userId: string,
  linkId: string,
  now: Date,
): Promise<DetachResult | undefined> {
  const [link] = await db.sql<{ platform: SocialPlatform; account_id: string; person_id: string }>`
    select platform, account_id, person_id from orbit.social_links where id = ${linkId}::uuid and user_id = ${userId}::uuid`;
  if (!link) return undefined;
  const platform = link.platform;
  const acct = link.account_id;
  const old = link.person_id;
  return db.begin(async (tx) => {
    await tx.sql`delete from orbit.social_links where id = ${linkId}::uuid`;
    const stored = (await loadAccounts(tx, platform, [acct])).get(acct);
    const name = stored?.name?.trim() || stored?.username || acct;
    const parts = name.split(/\s+/);
    const [np] = await tx.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, first_name, last_name, name_norm, sources, first_seen_at, listed,
                                source_account)
      values (${userId}::uuid, ${name}, ${parts[0] ?? null}, ${parts.slice(1).join(' ') || null}, ${name.toLowerCase()},
              ${[platform]}::text[], ${now}::timestamptz, false, ${sourceAccount(platform, acct)})
      returning id`;
    const fresh = np!.id;
    const [moved] = await tx.sql<{ n: number }>`
      select count(*)::int as n from orbit.messages
       where user_id = ${userId}::uuid and social_account_id = ${acct}
         and (from_person_id = ${old}::uuid or ${old}::uuid = any(to_person_ids))`;
    const { droppedContacts } = await moveStamped(tx, userId, platform, acct, old, fresh, {
      facts: 'delete',
      contacts: 'drop',
    });
    // the id identity stayed with the account (moved); make sure the new person holds it
    await tx.sql`
      insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source, social_account_id)
      values (${userId}::uuid, ${fresh}::uuid, ${identityKind(platform)}, ${acct}, ${stored?.username ?? acct}, ${platform}, ${acct})
      on conflict (user_id, kind, value_norm) do update set person_id = excluded.person_id`;
    await rebuildAccountTies(tx, userId, platform, acct, fresh, now);

    // a match the dropped contact proved is offered for review instead of standing
    let reviews = 0;
    const emails = droppedContacts.filter((c) => c.kind === 'email').map((c) => c.value);
    const phones = droppedContacts
      .filter((c) => c.kind === 'phone')
      .map((c) => c.value.replace(/\D/g, '').slice(-10));
    if (emails.length || phones.length) {
      const proved = await tx.sql<{ id: string; platform: string; account_id: string }>`
        select l.id, l.platform, l.account_id from orbit.social_links l
          join orbit.social_accounts a on a.platform = l.platform and a.account_id = l.account_id
         where l.user_id = ${userId}::uuid and l.person_id = ${old}::uuid and l.via = 'proof' and l.proof = 'contact'
           and (lower(coalesce(a.email, '')) = any(${emails}::text[])
             or right(regexp_replace(coalesce(a.phone, ''), '\\D', '', 'g'), 10) = any(${phones}::text[]))`;
      for (const p of proved) {
        await tx.sql`delete from orbit.social_links where id = ${p.id}::uuid`;
        await tx.sql`
          insert into orbit.social_match_asks (user_id, platform, account_id, person_id, score, signals, status)
          values (${userId}::uuid, ${p.platform}, ${p.account_id}, ${old}::uuid, 0.6, ${{ review: 'contact_detached' }}::jsonb, 'open')
          on conflict (user_id, platform, account_id, person_id) do update set status = 'open', signals = excluded.signals`;
        reviews++;
      }
    }

    // drafts queued to the account: paused, with a note
    const paused = await tx.sql<{ id: string }>`
      update orbit.drafts set status = 'draft', error = 'account_detached'
       where user_id = ${userId}::uuid and person_id = ${old}::uuid and channel = ${platform}
         and status in ('approved', 'scheduled')
      returning id`;
    // a chat that moved to "replied" on a message from the account: Orbit proposes moving it back
    const replied = await tx.sql<{ chat_id: string; from_stage: string | null }>`
      select e.chat_id, e.from_stage from orbit.stage_events e
        join orbit.chats c on c.id = e.chat_id
       where e.user_id = ${userId}::uuid and c.person_id = ${old}::uuid and e.to_stage = 'replied'
         and e.status = 'applied' and e.reason like ${`${platform}_reply:%`}
         and exists (select 1 from orbit.messages m where m.user_id = ${userId}::uuid and m.social_account_id = ${acct}
                       and e.reason = ${`${platform}_reply:`}::text || m.id::text)`;
    for (const r of replied)
      await tx.sql`
        insert into orbit.stage_events (user_id, chat_id, from_stage, to_stage, status, actor, reason, evidence)
        values (${userId}::uuid, ${r.chat_id}::uuid, 'replied', ${r.from_stage ?? 'outreach_sent'}, 'proposed', 'system',
                'account_detached', ${{ platform, accountId: acct }}::jsonb)`;
    // open questions about the account close; the answer is remembered
    await tx.sql`
      update orbit.social_match_asks set status = 'stale', decided_at = ${now}::timestamptz
       where user_id = ${userId}::uuid and platform = ${platform} and account_id = ${acct} and status = 'open'
         and not (signals ? 'review')`;
    await tx.sql`
      insert into orbit.social_not_same (user_id, platform, account_id, person_id)
      values (${userId}::uuid, ${platform}, ${acct}, ${old}::uuid) on conflict do nothing`;
    await audit(tx, userId, 'social.detach', linkId, {
      platform,
      accountId: acct,
      personId: old,
      accountPersonId: fresh,
    });
    await rescore(tx, userId, [old, fresh], `detach:${linkId}`);
    return {
      personId: old,
      accountPersonId: fresh,
      movedMessages: moved?.n ?? 0,
      pausedDrafts: paused.length,
      proposals: replied.length,
      reviews,
    };
  });
}

/** The student's answer to "is this account the person you know". */
export async function answerAsk(
  db: Db,
  userId: string,
  askId: string,
  answer: 'yes' | 'no',
  now: Date,
): Promise<{ status: 'yes' | 'no' } | { status: 'not_found' } | AttachResult> {
  const [ask] = await db.sql<{
    platform: SocialPlatform;
    account_id: string;
    person_id: string;
    status: string;
  }>`
    select platform, account_id, person_id, status from orbit.social_match_asks
     where id = ${askId}::uuid and user_id = ${userId}::uuid`;
  if (!ask) return { status: 'not_found' };
  if (answer === 'no') {
    await db.sql`
      update orbit.social_match_asks set status = 'no', decided_at = ${now}::timestamptz where id = ${askId}::uuid`;
    await db.sql`
      insert into orbit.social_not_same (user_id, platform, account_id, person_id)
      values (${userId}::uuid, ${ask.platform}, ${ask.account_id}, ${ask.person_id}::uuid) on conflict do nothing`;
    return { status: 'no' };
  }
  const r = await attachAccount(db, userId, {
    platform: ask.platform,
    accountId: ask.account_id,
    personId: ask.person_id,
    via: 'student',
    now,
  });
  if (r.status === 'attached' || r.status === 'exists') {
    await db.sql`
      update orbit.social_match_asks set status = 'yes', decided_at = ${now}::timestamptz where id = ${askId}::uuid`;
    return { status: 'yes' };
  }
  return r;
}
