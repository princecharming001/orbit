/**
 * Accounts and people (plan 43 §3.3, §3.4), for any platform.
 *
 * - `personForAccount`: the person an account belongs to: attached (social_links), the person made from it
 *   (people.source_account), or its id identity.
 * - `ensureAccountPerson`: the person an account becomes when it has to take part in paths or closeness (messages
 *   both ways, or a bridge a lookup found). Made unlisted: in paths and closeness, not in People, until a real
 *   exchange (`listAfterExchange`).
 * - `knownPeople`: who has a two-way tie with the student (messages both ways on any channel, a meeting, a LinkedIn
 *   connection, following each other), the people the student can be asked about.
 * - `socialCandidates`: the student's people as core `SocialCandidate`s, with what a profile could echo (emails,
 *   phones, LinkedIn, pages research found) and `knownToStudent`.
 * - `matchAccount`: core `socialBlock` + `matchSocialAccount` (or `matchTargetAccount` for a target), then attach,
 *   ask (only about people the student knows) or nothing. An X account goes through `matchXAccount` /
 *   `matchXTarget` instead (x/match.ts): public proof only, and the student is never asked about it.
 */
import {
  matchSocialAccount,
  matchTargetAccount,
  type SocialAccount,
  type SocialCandidate,
  type SocialMatch,
  type SocialPlatform,
  socialBlock,
} from '@orbit/core/entity/social';
import type { Db } from '../db.ts';
import { PERSON_COLUMNS, toPerson } from '../ingest/util.ts';
import { identityKind, sourceAccount } from './keys.ts';
import { attachAccount } from './links.ts';
import { matchXAccount, matchXTarget } from './x/match.ts';

export { identityKind, sourceAccount };

/** The student's own account id on a platform, from their connected account. */
export async function ownAccountId(db: Db, userId: string, platform: SocialPlatform): Promise<string | null> {
  const [r] = await db.sql<{ social_account_id: string | null }>`
    select social_account_id from orbit.integration_accounts where user_id = ${userId}::uuid and provider = ${platform}`;
  return r?.social_account_id ?? null;
}

export async function personForAccount(
  db: Db,
  userId: string,
  platform: SocialPlatform,
  accountId: string,
): Promise<{ personId: string; via: 'link' | 'own' | 'identity' } | undefined> {
  const [l] = await db.sql<{ person_id: string }>`
    select l.person_id from orbit.social_links l join orbit.people p on p.id = l.person_id
     where l.user_id = ${userId}::uuid and l.platform = ${platform} and l.account_id = ${accountId}
       and p.deleted_at is null`;
  if (l) return { personId: l.person_id, via: 'link' };
  const [o] = await db.sql<{ id: string }>`
    select id from orbit.people
     where user_id = ${userId}::uuid and source_account = ${sourceAccount(platform, accountId)}
       and deleted_at is null and merged_into is null
     order by created_at limit 1`;
  if (o) return { personId: o.id, via: 'own' };
  const [i] = await db.sql<{ person_id: string }>`
    select pi.person_id from orbit.person_identities pi join orbit.people p on p.id = pi.person_id
     where pi.user_id = ${userId}::uuid and pi.kind = ${identityKind(platform)} and pi.value_norm = ${accountId}
       and p.deleted_at is null and p.merged_into is null`;
  if (i) return { personId: i.person_id, via: 'identity' };
  return undefined;
}

/** The person for an account, made unlisted when there is none (plan 43 §3.3 "When an account becomes a person"). */
export async function ensureAccountPerson(
  db: Db,
  userId: string,
  a: Pick<SocialAccount, 'platform' | 'id' | 'username' | 'name'>,
  now: Date,
): Promise<{ personId: string; created: boolean }> {
  const found = await personForAccount(db, userId, a.platform, a.id);
  if (found) return { personId: found.personId, created: false };
  const name = (a.name ?? '').trim() || a.username || a.id;
  const parts = name.split(/\s+/);
  const [row] = await db.sql<{ id: string }>`
    insert into orbit.people (user_id, display_name, first_name, last_name, name_norm, sources, first_seen_at, listed,
                              source_account)
    values (${userId}::uuid, ${name}, ${parts[0] ?? null}, ${parts.slice(1).join(' ') || null}, ${name.toLowerCase()},
            ${[a.platform]}::text[], ${now}::timestamptz, false, ${sourceAccount(a.platform, a.id)})
    returning id`;
  await db.sql`
    insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source, social_account_id)
    values (${userId}::uuid, ${row!.id}::uuid, ${identityKind(a.platform)}, ${a.id}, ${a.username}, ${a.platform}, ${a.id})
    on conflict (user_id, kind, value_norm) do nothing`;
  return { personId: row!.id, created: true };
}

/** The SQL condition "this person has a two-way tie with the student", over `p` and the user in $1. */
const KNOWN = `(
  p.linkedin_connected_on is not null
  or (exists (select 1 from orbit.messages m where m.user_id = $1::uuid and m.direction = 'in' and m.from_person_id = p.id)
      and exists (select 1 from orbit.messages m where m.user_id = $1::uuid and m.direction = 'out'
                    and p.id = any(m.to_person_ids)))
  or exists (select 1 from orbit.calendar_events e where e.user_id = $1::uuid and p.id = any(e.attendee_person_ids))
  or exists (
    select 1 from (
      select l.platform, l.account_id from orbit.social_links l where l.user_id = $1::uuid and l.person_id = p.id
      union all
      select split_part(p.source_account, ':', 1), split_part(p.source_account, ':', 2) where p.source_account is not null
    ) acc
    join orbit.integration_accounts i on i.user_id = $1::uuid and i.provider = acc.platform and i.social_account_id is not null
    where exists (select 1 from orbit.social_follows f where f.platform = acc.platform and f.owner_user_id = $1::uuid
                    and f.follower_id = i.social_account_id and f.followed_id = acc.account_id)
      and exists (select 1 from orbit.social_follows f where f.platform = acc.platform and f.owner_user_id = $1::uuid
                    and f.follower_id = acc.account_id and f.followed_id = i.social_account_id)))`;

/** The people (of `ids`, or all) the student has a two-way tie with. */
export async function knownPeople(db: Db, userId: string, ids?: string[]): Promise<Set<string>> {
  const rows = await db.query<{ id: string }>(
    `select p.id from orbit.people p
      where p.user_id = $1::uuid and p.deleted_at is null and p.merged_into is null and not p.is_self
        and ($2::uuid[] is null or p.id = any($2::uuid[])) and ${KNOWN}`,
    [userId, ids ?? null],
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * Unlisted people become listed after a real exchange (plan 43 §3.3): messages both ways on any channel, a meeting,
 * or the student adding them to a chat or a note. Returns the people listed now.
 */
export async function listAfterExchange(db: Db, userId: string, ids?: string[]): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `update orbit.people p set listed = true
      where p.user_id = $1::uuid and not p.listed and p.deleted_at is null
        and ($2::uuid[] is null or p.id = any($2::uuid[]))
        and ((exists (select 1 from orbit.messages m where m.user_id = $1::uuid and m.direction = 'in' and m.from_person_id = p.id)
              and exists (select 1 from orbit.messages m where m.user_id = $1::uuid and m.direction = 'out'
                            and p.id = any(m.to_person_ids)))
          or exists (select 1 from orbit.calendar_events e where e.user_id = $1::uuid and p.id = any(e.attendee_person_ids))
          or exists (select 1 from orbit.chats c where c.user_id = $1::uuid and c.person_id = p.id)
          or exists (select 1 from orbit.notes n where n.user_id = $1::uuid and p.id = any(n.person_ids)))
      returning p.id`,
    [userId, ids ?? null],
  );
  return rows.map((r) => r.id);
}

/** Pages Orbit's research found for a person (dossier sources), as links. */
function researchLinks(sources: unknown): string[] {
  if (!Array.isArray(sources)) return [];
  const out: string[] = [];
  for (const s of sources) {
    const url = (s as { url?: unknown })?.url;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) out.push(url);
  }
  return out;
}

/**
 * The student's people as match candidates. People made from an account of this platform are left out (they are
 * the accounts themselves), and so is the self.
 */
export async function socialCandidates(
  db: Db,
  userId: string,
  platform: SocialPlatform,
  o: { ids?: string[] } = {},
): Promise<SocialCandidate[]> {
  const rows = await db.query<Record<string, unknown>>(
    `select ${PERSON_COLUMNS}, d.sources as research
       from orbit.people p
       left join orbit.dossiers d on d.user_id = p.user_id and d.person_id = p.id and d.status in ('ready', 'partial')
      where p.user_id = $1::uuid and p.deleted_at is null and p.merged_into is null and not p.is_self
        and coalesce(p.source_account, '') not like $2 and ($3::uuid[] is null or p.id = any($3::uuid[]))
      limit 50000`,
    [userId, `${platform}:%`, o.ids ?? null],
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id as string);
  const idRows = await db.sql<{
    person_id: string;
    kind: string;
    value_norm: string;
    value_raw: string | null;
  }>`
    select person_id, kind, value_norm, value_raw from orbit.person_identities
     where user_id = ${userId}::uuid and person_id = any(${ids}::uuid[])`;
  const byPerson = new Map<string, typeof idRows>();
  for (const r of idRows) byPerson.set(r.person_id, [...(byPerson.get(r.person_id) ?? []), r]);
  const handles = await db.sql<{ person_id: string; username: string | null }>`
    select l.person_id, a.username from orbit.social_links l
      left join orbit.social_accounts a on a.platform = l.platform and a.account_id = l.account_id
     where l.user_id = ${userId}::uuid and l.platform = ${platform}`;
  const known = await knownPeople(db, userId);
  return rows.map((r) => {
    const own = byPerson.get(r.id as string) ?? [];
    const person = toPerson(r, own);
    const phones = own.filter((i) => i.kind === 'phone').map((i) => i.value_raw ?? i.value_norm);
    return {
      person: { ...person, phones: [...new Set([...(person.phones ?? []), ...phones])] },
      links: researchLinks(r.research),
      knownToStudent: known.has(person.id),
      otherHandles: handles.filter((h) => h.person_id === person.id && h.username).map((h) => h.username!),
    } satisfies SocialCandidate;
  });
}

/** The people the student said an account is not. */
export async function rejectedFor(
  db: Db,
  userId: string,
  platform: SocialPlatform,
  accountId: string,
): Promise<Set<string>> {
  const rows = await db.sql<{ person_id: string }>`
    select person_id from orbit.social_not_same
     where user_id = ${userId}::uuid and platform = ${platform} and account_id = ${accountId}
    union
    select person_id from orbit.social_match_asks
     where user_id = ${userId}::uuid and platform = ${platform} and account_id = ${accountId} and status = 'no'`;
  return new Set(rows.map((r) => r.person_id));
}

export type MatchOutcome =
  | { kind: 'attached'; personId: string; match: SocialMatch }
  | { kind: 'asked'; personId: string; match: SocialMatch }
  | { kind: 'none'; match: SocialMatch; conflict?: boolean };

/**
 * Decides one account against the student's people and acts on it: hard proof or a sure score attaches, a middle
 * score about someone the student knows becomes a question, anything else is left apart. A target (someone the
 * student is going after) takes hard proof only. `candidates` can be passed when many accounts are decided at once.
 */
export async function matchAccount(
  db: Db,
  userId: string,
  account: SocialAccount,
  o: { now: Date; candidates?: SocialCandidate[]; target?: SocialCandidate },
): Promise<MatchOutcome> {
  const linked = await personForAccount(db, userId, account.platform, account.id);
  if (linked?.via === 'link') return { kind: 'none', match: { kind: 'none', reason: 'no_candidate' } };
  const rejected = await rejectedFor(db, userId, account.platform, account.id);
  const x = account.platform === 'x';
  let match: SocialMatch;
  if (o.target) {
    match = rejected.has(o.target.person.id)
      ? { kind: 'none', reason: 'no_candidate' }
      : x
        ? matchXTarget(account, o.target)
        : matchTargetAccount(account, o.target);
  } else if (x) {
    // public proof is exact, so the whole pool is checked, not only the people a name block finds
    const pool = o.candidates ?? (await socialCandidates(db, userId, account.platform));
    match = matchXAccount(account, pool, { rejected });
  } else {
    const pool = o.candidates ?? (await socialCandidates(db, userId, account.platform));
    match = matchSocialAccount(account, socialBlock(account, pool), { rejected });
  }
  if (match.kind === 'attach') {
    const r = await attachAccount(db, userId, {
      platform: account.platform,
      accountId: account.id,
      personId: match.personId,
      via: match.via,
      proof: match.via === 'proof' ? match.proof : undefined,
      score: match.via === 'score' ? match.score : undefined,
      now: o.now,
      account,
    });
    if (r.status === 'attached' || r.status === 'exists')
      return { kind: 'attached', personId: match.personId, match };
    // the account's own person has things of its own: the student is asked instead, if they know the person (never
    // on X, where the student's say-so is not proof)
    const known = await knownPeople(db, userId, [match.personId]);
    if (x || !known.has(match.personId)) return { kind: 'none', match, conflict: true };
    await askAbout(db, userId, account, match.personId, match.via === 'score' ? match.score : 0.94, {
      proof: match.via === 'proof' ? match.proof : undefined,
    });
    return { kind: 'asked', personId: match.personId, match };
  }
  if (match.kind === 'ask' && !x) {
    await askAbout(db, userId, account, match.personId, match.score, match.signals);
    return { kind: 'asked', personId: match.personId, match };
  }
  return { kind: 'none', match };
}

/** An open question "is this account that person", unless the student already answered it. */
export async function askAbout(
  db: Db,
  userId: string,
  account: Pick<SocialAccount, 'platform' | 'id'>,
  personId: string,
  score: number,
  signals: Record<string, unknown>,
): Promise<void> {
  await db.sql`
    insert into orbit.social_match_asks (user_id, platform, account_id, person_id, score, signals)
    values (${userId}::uuid, ${account.platform}, ${account.id}, ${personId}::uuid, ${score}::real, ${signals}::jsonb)
    on conflict (user_id, platform, account_id, person_id) do nothing`;
}
