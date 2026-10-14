/**
 * Entity resolution in batches (§1.3, §12.3). One page of addresses and profiles is resolved together:
 *   1. person_identities by value_norm (email, LinkedIn member id, LinkedIn slug), and people by the same columns;
 *   2. for the rest, candidates by blocking keys: name_norm, last name (for first-name variants), and the address
 *      domain (for bare addresses at a company);
 *   3. core `resolveIdentity` on each, with the user's do_not_merge pairs:
 *        match / ≥ 0.92  → the identity is added to that person (and the same-mailbox proof merges a LinkedIn-only
 *                          namesake into it),
 *        0.6–0.92        → a new person plus an open merge_suggestions row,
 *        below           → a new person.
 * Role inboxes, applicant-tracking and other automated senders never become people (§1.7). The self person is
 * found through its identities only. Identities are inserted with on conflict do nothing.
 */
import {
  doNotMergeKey,
  type IncomingIdentity,
  isPlaceholderName,
  isRoleAddress,
  PERSONAL_EMAIL_DOMAINS,
  resolveIdentity,
} from '@orbit/core/entity/resolve';
import { isAtsSender, isAutomatedSender, isRoleName } from '@orbit/core/text/email';
import {
  emailDomain,
  emailLocalPart,
  linkedInSlug,
  nameFromParts,
  normalizeCompany,
  normalizeEmail,
  normalizeLinkedInUrl,
  parseName,
} from '@orbit/core/text/normalize';
import type { Person, PersonSource } from '@orbit/core/types';
import type { Db } from '../db.ts';
import { PERSON_COLUMNS, toPerson } from './util.ts';

export type IngestSource = 'gmail' | 'calendar' | 'contacts' | 'linkedin';

export interface Incoming {
  /** the caller's key for this item; the result maps it to a person id */
  key: string;
  email?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  linkedinMemberId?: string;
  linkedinUrl?: string;
  /** LinkedIn public identifier */
  linkedinSlug?: string;
  unipileAttendeeId?: string;
  companyRaw?: string;
  title?: string;
  headline?: string;
  location?: string;
  photoUrl?: string;
  source: IngestSource;
  /** when the source first saw them */
  seenAt?: string;
  /** the identity rows' source (default: the item's source) and creation time (a LinkedIn connection date) */
  identitySource?: string;
  identityAt?: string;
}

export interface ResolveResult {
  /** item key → person id (absent: not a person, or not created) */
  byKey: Map<string, string>;
  /** people created by this call */
  created: Set<string>;
  /** people merged away by this call (loser → survivor) */
  merged: Map<string, string>;
}

const CORE_SOURCE: Record<IngestSource, PersonSource> = {
  gmail: 'gmail',
  calendar: 'calendar',
  contacts: 'gmail',
  linkedin: 'linkedin_csv',
};

/** "priya.patel", "erodriguez" for erodriguez@x: a header name that is only the address handle is no name. */
export function isHandle(name: string | undefined, email: string | undefined): boolean {
  const t = (name ?? '').trim();
  if (!t || /\s/.test(t)) return false;
  if (t.includes('@')) return true;
  if (/^[\p{L}\d]+(?:[._][\p{L}\d]+)+$/u.test(t)) return true;
  if (!email) return false;
  const squash = (x: string) => x.toLowerCase().replace(/[._+-]/g, '');
  return squash(t) === squash(emailLocalPart(email.toLowerCase()).replace(/\+.*$/, ''));
}

/** An address that is not a person: role inboxes, ATS and no-reply senders, notification and team addresses. */
export function notAPerson(email: string | undefined, name?: string): boolean {
  if (!email?.includes('@')) return false;
  return (
    isRoleAddress(email) ||
    isAtsSender(email) ||
    isAutomatedSender(email, {}, [], name) ||
    (!!name && isRoleName(name))
  );
}

function slugOf(i: Incoming): string | undefined {
  if (i.linkedinSlug) return i.linkedinSlug.toLowerCase();
  return linkedInSlug(i.linkedinUrl) ?? undefined;
}

function urlOf(i: Incoming): string | undefined {
  const slug = slugOf(i);
  return normalizeLinkedInUrl(i.linkedinUrl) ?? (slug ? `https://www.linkedin.com/in/${slug}` : undefined);
}

/** The item's real name, if it has one. */
function nameOf(i: Incoming) {
  if (i.firstName || i.lastName) return nameFromParts(i.firstName, i.lastName);
  if (!i.name || isHandle(i.name, i.email)) return parseName('');
  return parseName(i.name);
}

export async function upsertOrganization(
  db: Db,
  userId: string,
  name: string | undefined,
): Promise<string | null> {
  const norm = normalizeCompany(name);
  if (!name || !norm) return null;
  const [row] = await db.sql<{ id: string }>`
    insert into orbit.organizations (user_id, name, name_norm) values (${userId}::uuid, ${name.trim()}, ${norm})
    on conflict (user_id, name_norm) do update set name = orbit.organizations.name
    returning id`;
  return row?.id ?? null;
}

interface Ctx {
  db: Db;
  userId: string;
  now: Date;
  people: Person[];
  doNotMerge: Set<string>;
  orgDomains: Map<string, string[]>;
  result: ResolveResult;
}

export async function resolvePeople(
  db: Db,
  userId: string,
  input: Incoming[],
  opts: { now: Date; create?: boolean },
): Promise<ResolveResult> {
  const result: ResolveResult = { byKey: new Map(), created: new Set(), merged: new Map() };
  const create = opts.create ?? true;
  const items: Incoming[] = [];
  const seenKey = new Set<string>();
  for (const raw of input) {
    if (seenKey.has(raw.key)) continue;
    seenKey.add(raw.key);
    items.push(raw);
  }
  if (!items.length) return result;

  // 1. exact identities
  const emails = [...new Set(items.filter((i) => i.email).map((i) => normalizeEmail(i.email!)))];
  const members = [...new Set(items.map((i) => i.linkedinMemberId).filter((x): x is string => !!x))];
  const slugs = [...new Set(items.map(slugOf).filter((x): x is string => !!x))];
  const hits = await db.sql<{ kind: string; value: string; person_id: string }>`
    select pi.kind, pi.value_norm as value, coalesce(p.merged_into, p.id) as person_id
      from orbit.person_identities pi join orbit.people p on p.id = pi.person_id
     where pi.user_id = ${userId}::uuid and p.deleted_at is null
       and ((pi.kind = 'email' and pi.value_norm = any(${emails}::text[]))
         or (pi.kind = 'linkedin_member' and pi.value_norm = any(${members}::text[]))
         or (pi.kind = 'linkedin_slug' and pi.value_norm = any(${slugs}::text[])))
    union all
    select 'email', p.primary_email, coalesce(p.merged_into, p.id) from orbit.people p
     where p.user_id = ${userId}::uuid and p.deleted_at is null and p.primary_email = any(${emails}::text[])
    union all
    select 'linkedin_member', p.linkedin_member_id, coalesce(p.merged_into, p.id) from orbit.people p
     where p.user_id = ${userId}::uuid and p.deleted_at is null and p.linkedin_member_id = any(${members}::text[])
    union all
    select 'linkedin_slug', p.linkedin_slug, coalesce(p.merged_into, p.id) from orbit.people p
     where p.user_id = ${userId}::uuid and p.deleted_at is null and p.linkedin_slug = any(${slugs}::text[])`;
  const byIdentity = new Map(hits.map((h) => [`${h.kind}:${h.value}`, h.person_id]));
  const found = (i: Incoming): string | undefined =>
    (i.linkedinMemberId && byIdentity.get(`linkedin_member:${i.linkedinMemberId}`)) ||
    (i.email && byIdentity.get(`email:${normalizeEmail(i.email)}`)) ||
    (slugOf(i) && byIdentity.get(`linkedin_slug:${slugOf(i)}`)) ||
    undefined;

  const misses: Incoming[] = [];
  const known: { item: Incoming; personId: string }[] = [];
  for (const i of items) {
    const pid = found(i);
    if (pid) known.push({ item: i, personId: pid });
    else if (!(i.email && notAPerson(i.email, i.name) && !i.linkedinMemberId && !slugOf(i))) misses.push(i);
  }

  // 2. candidates for the rest, by blocking keys
  const names = new Set<string>();
  const lasts = new Set<string>();
  const domains = new Set<string>();
  // blocking keys for the misses, and for known addresses that arrive under a name (a same-mailbox proof may merge
  // a LinkedIn-only namesake into the owner)
  for (const i of [...misses, ...known.filter((k) => k.item.email).map((k) => k.item)]) {
    const n = nameOf(i);
    if (n.normalized) names.add(n.normalized);
    if (n.last) lasts.add(n.last.toLowerCase());
    if (i.email) {
      const d = emailDomain(normalizeEmail(i.email));
      if (d && !PERSONAL_EMAIL_DOMAINS.has(d)) domains.add(d);
    }
  }
  const knownIds = [...new Set(known.map((k) => k.personId))];
  const rows =
    misses.length || knownIds.length
      ? await db.query<Record<string, unknown>>(
          `select ${PERSON_COLUMNS} from orbit.people p
          where p.user_id = $1::uuid and p.deleted_at is null and p.merged_into is null and not p.is_self
            and (p.name_norm = any($2::text[]) or lower(p.last_name) = any($3::text[]) or p.id = any($5::uuid[])
              or exists (select 1 from orbit.person_identities pi where pi.person_id = p.id and pi.kind = 'email'
                           and split_part(pi.value_norm, '@', 2) = any($4::text[])))
          limit 5000`,
          [userId, [...names], [...lasts], [...domains], knownIds],
        )
      : [];
  const ids = rows.map((r) => r.id as string);
  const idRows = ids.length
    ? await db.sql<{ person_id: string; kind: string; value_norm: string }>`
        select person_id, kind, value_norm from orbit.person_identities
         where user_id = ${userId}::uuid and person_id = any(${ids}::uuid[])`
    : [];
  const idsBy = new Map<string, { kind: string; value_norm: string }[]>();
  for (const r of idRows) {
    const arr = idsBy.get(r.person_id) ?? [];
    arr.push(r);
    idsBy.set(r.person_id, arr);
  }
  const people = rows.map((r) => toPerson(r, idsBy.get(r.id as string)));
  const dnm = await db.sql<{ person_a: string; person_b: string }>`
    select person_a, person_b from orbit.do_not_merge where user_id = ${userId}::uuid`;
  const orgs = await db.sql<{ id: string; domains: string[] }>`
    select id, domains from orbit.organizations
     where user_id = ${userId}::uuid and cardinality(domains) > 0`;
  const ctx: Ctx = {
    db,
    userId,
    now: opts.now,
    people,
    doNotMerge: new Set(dnm.map((d) => doNotMergeKey(d.person_a, d.person_b))),
    orgDomains: new Map(orgs.map((o) => [o.id, o.domains])),
    result,
  };

  for (const k of known) {
    result.byKey.set(k.item.key, k.personId);
    await attach(ctx, k.personId, k.item);
    const n = nameOf(k.item);
    if (!k.item.email || !n.full) continue;
    const d = resolveIdentity(
      { email: k.item.email, displayName: n.full, source: CORE_SOURCE[k.item.source] },
      { people: ctx.people, doNotMerge: ctx.doNotMerge, orgDomains: ctx.orgDomains },
    );
    if (d.kind === 'match' && d.personId === k.personId)
      for (const other of d.mergeWith ?? []) await absorb(ctx, k.personId, other);
  }

  // 3. resolveIdentity, one at a time, so later items see the people earlier ones created
  for (const i of misses) {
    // an earlier item of this batch may have added the same address or profile
    const again = ctx.people.find(
      (p) =>
        (i.email && p.emails.includes(normalizeEmail(i.email))) ||
        (i.linkedinMemberId && p.linkedinMemberId === i.linkedinMemberId),
    );
    if (again) {
      result.byKey.set(i.key, again.id);
      await attach(ctx, again.id, i);
      continue;
    }
    const n = nameOf(i);
    const inc: IncomingIdentity = {
      email: i.email,
      linkedinUrl: urlOf(i),
      displayName: n.full || undefined,
      firstName: i.firstName,
      lastName: i.lastName,
      companyRaw: i.companyRaw,
      title: i.title,
      source: CORE_SOURCE[i.source],
    };
    const d = resolveIdentity(inc, {
      people: ctx.people,
      doNotMerge: ctx.doNotMerge,
      orgDomains: ctx.orgDomains,
    });
    if (d.kind === 'role') continue;
    if (d.kind === 'match' || d.kind === 'probable') {
      result.byKey.set(i.key, d.personId);
      await attach(ctx, d.personId, i);
      if (d.kind === 'match') for (const other of d.mergeWith ?? []) await absorb(ctx, d.personId, other);
      continue;
    }
    if (!create) continue;
    const pid = await createPerson(ctx, i);
    result.byKey.set(i.key, pid);
    if (d.kind === 'suggest') await suggestMerge(db, userId, d.personId, pid, d.score, d.features);
  }
  return result;
}

/** The same-mailbox proof (core `mergeWith`): the LinkedIn-only namesake becomes the address's owner. */
async function absorb(ctx: Ctx, survivor: string, loser: string) {
  if (!(await mergePeople(ctx.db, ctx.userId, survivor, loser))) return;
  ctx.result.merged.set(loser, survivor);
  const gone = ctx.people.find((p) => p.id === loser);
  const kept = ctx.people.find((p) => p.id === survivor);
  if (gone && kept) {
    kept.linkedinMemberId ??= gone.linkedinMemberId;
    kept.linkedinSlug ??= gone.linkedinSlug;
    kept.linkedinUrl ??= gone.linkedinUrl;
    kept.currentOrganizationRaw ??= gone.currentOrganizationRaw;
  }
  ctx.people = ctx.people.filter((p) => p.id !== loser);
  for (const [k, v] of ctx.result.byKey) if (v === loser) ctx.result.byKey.set(k, survivor);
}

async function insertIdentities(ctx: Ctx, personId: string, i: Incoming) {
  const src = i.identitySource ?? i.source;
  const at = i.identityAt ?? ctx.now.toISOString();
  const rows: [string, string, string][] = [];
  if (i.email?.includes('@')) rows.push(['email', normalizeEmail(i.email), i.email.trim()]);
  if (i.linkedinMemberId) rows.push(['linkedin_member', i.linkedinMemberId, i.linkedinMemberId]);
  const slug = slugOf(i);
  if (slug) rows.push(['linkedin_slug', slug, urlOf(i) ?? slug]);
  if (i.unipileAttendeeId) rows.push(['unipile_attendee', i.unipileAttendeeId, i.unipileAttendeeId]);
  for (const [kind, norm, raw] of rows)
    await ctx.db.sql`
      insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source, created_at)
      values (${ctx.userId}::uuid, ${personId}::uuid, ${kind}, ${norm}, ${raw}, ${src}, ${at}::timestamptz)
      on conflict (user_id, kind, value_norm) do nothing`;
}

/** Adds the item's identities to a known person and fills what the person lacks (a real name for a stand-in). */
async function attach(ctx: Ctx, personId: string, i: Incoming) {
  await insertIdentities(ctx, personId, i);
  const p = ctx.people.find((x) => x.id === personId);
  const n = nameOf(i);
  const rename = !!p && !!n.full && isPlaceholderName(p);
  const orgId = i.companyRaw ? await upsertOrganization(ctx.db, ctx.userId, i.companyRaw) : null;
  const slug = slugOf(i) ?? null;
  await ctx.db.sql`
    update orbit.people set
      display_name = case when ${rename}::boolean then ${n.full} else display_name end,
      first_name = case when ${rename}::boolean then ${n.first || null} else first_name end,
      last_name = case when ${rename}::boolean then ${n.last || null} else last_name end,
      name_norm = case when ${rename}::boolean then ${n.normalized || null} else name_norm end,
      primary_email = coalesce(primary_email, ${i.email ? normalizeEmail(i.email) : null}),
      linkedin_member_id = coalesce(linkedin_member_id, ${i.linkedinMemberId ?? null}),
      linkedin_slug = coalesce(linkedin_slug, ${slug}),
      linkedin_url = coalesce(linkedin_url, ${urlOf(i) ?? null}),
      headline = coalesce(headline, ${i.headline ?? null}),
      title = coalesce(title, ${i.title ?? null}),
      org_id = coalesce(org_id, ${orgId}::uuid),
      org_raw = coalesce(org_raw, ${orgId ? i.companyRaw!.trim() : null}),
      location = coalesce(location, ${i.location ?? null}),
      photo_url = coalesce(photo_url, ${i.photoUrl ?? null}),
      sources = case when ${i.source} = any(sources) then sources else sources || ${[i.source]}::text[] end,
      first_seen_at = least(first_seen_at, ${i.seenAt ?? null}::timestamptz)
    where id = ${personId}::uuid and user_id = ${ctx.userId}::uuid and not is_self`;
  if (p) {
    if (i.email && !p.emails.includes(normalizeEmail(i.email))) p.emails.push(normalizeEmail(i.email));
    if (rename) {
      p.displayName = n.full;
      p.firstName = n.first;
      p.lastName = n.last;
      p.nameNormalized = n.normalized;
    }
    p.linkedinMemberId ??= i.linkedinMemberId;
    p.linkedinSlug ??= slug ?? undefined;
  }
}

async function createPerson(ctx: Ctx, i: Incoming): Promise<string> {
  const n = nameOf(i);
  const email = i.email ? normalizeEmail(i.email) : undefined;
  // a stand-in name: the address handle as written, which isPlaceholderName recognizes until a real name arrives
  const handle = i.email
    ? emailLocalPart(i.email.trim().toLowerCase().replace(/^.*</, '').replace(/>.*$/, '')).replace(
        /\+.*$/,
        '',
      )
    : '';
  const display = n.full || handle || slugOf(i) || 'Unknown';
  const orgId = i.companyRaw ? await upsertOrganization(ctx.db, ctx.userId, i.companyRaw) : null;
  const slug = slugOf(i) ?? null;
  const [row] = await ctx.db.sql<Record<string, unknown>>`
    insert into orbit.people (user_id, display_name, first_name, last_name, name_norm, primary_email, headline, title,
                              org_id, org_raw, location, photo_url, linkedin_url, linkedin_slug, linkedin_member_id,
                              relationship_type, sources, first_seen_at)
    values (${ctx.userId}::uuid, ${display}, ${n.first || null}, ${n.last || null},
            ${n.normalized || display.toLowerCase()}, ${email ?? null}, ${i.headline ?? null}, ${i.title ?? null},
            ${orgId}::uuid, ${orgId ? i.companyRaw!.trim() : null}, ${i.location ?? null}, ${i.photoUrl ?? null},
            ${urlOf(i) ?? null}, ${slug}, ${i.linkedinMemberId ?? null},
            ${/recruit/i.test(i.title ?? '') ? 'recruiter' : null}, ${[i.source]}::text[],
            ${i.seenAt ?? ctx.now.toISOString()}::timestamptz)
    returning *`;
  const id = row!.id as string;
  await insertIdentities(ctx, id, i);
  ctx.people.push(toPerson({ ...row!, id }, email ? [{ kind: 'email', value_norm: email }] : []));
  ctx.result.created.add(id);
  return id;
}

async function suggestMerge(
  db: Db,
  userId: string,
  a: string,
  b: string,
  score: number,
  features: object,
): Promise<void> {
  const open = await db.sql`
    select 1 from orbit.merge_suggestions
     where user_id = ${userId}::uuid and status = 'open'
       and ((person_a = ${a}::uuid and person_b = ${b}::uuid) or (person_a = ${b}::uuid and person_b = ${a}::uuid))`;
  if (open.length) return;
  await db.sql`
    insert into orbit.merge_suggestions (user_id, person_a, person_b, score, features)
    values (${userId}::uuid, ${a}::uuid, ${b}::uuid, ${score}::real, ${features}::jsonb)`;
}

const dedupeArray = (col: string) =>
  `array(select distinct x from unnest(array_replace(${col}, $2::uuid, $3::uuid)) x)`;

/**
 * Folds `loser` into `survivor`: identities, messages, threads, events, affiliations, pipeline rows and notes point
 * at the survivor; ties and the tie score of the loser are dropped (the next score run rebuilds them); the survivor
 * keeps its own fields and takes the loser's where it has none; the loser keeps `merged_into`. Never across a
 * do_not_merge pair.
 */
export async function mergePeople(db: Db, userId: string, survivor: string, loser: string): Promise<boolean> {
  if (survivor === loser) return false;
  const [a, b] = survivor < loser ? [survivor, loser] : [loser, survivor];
  const blocked = await db.sql`
    select 1 from orbit.do_not_merge where user_id = ${userId}::uuid
       and ((person_a = ${a}::uuid and person_b = ${b}::uuid) or (person_a = ${b}::uuid and person_b = ${a}::uuid))`;
  if (blocked.length) return false;
  return db.begin(async (tx) => {
    const p = [userId, loser, survivor];
    await tx.query(
      `update orbit.person_identities set person_id = $3::uuid where user_id = $1::uuid and person_id = $2::uuid`,
      p,
    );
    await tx.query(
      `update orbit.people s set
         primary_email = coalesce(s.primary_email, l.primary_email), headline = coalesce(s.headline, l.headline),
         title = coalesce(s.title, l.title), org_id = coalesce(s.org_id, l.org_id), org_raw = coalesce(s.org_raw, l.org_raw),
         location = coalesce(s.location, l.location), school = coalesce(s.school, l.school),
         photo_url = coalesce(s.photo_url, l.photo_url), linkedin_url = coalesce(s.linkedin_url, l.linkedin_url),
         linkedin_slug = coalesce(s.linkedin_slug, l.linkedin_slug),
         linkedin_member_id = coalesce(s.linkedin_member_id, l.linkedin_member_id),
         sources = array(select distinct x from unnest(s.sources || l.sources) x),
         first_seen_at = least(s.first_seen_at, l.first_seen_at),
         last_interaction_at = greatest(s.last_interaction_at, l.last_interaction_at),
         do_not_contact = s.do_not_contact or l.do_not_contact
        from orbit.people l
       where s.id = $3::uuid and l.id = $2::uuid and s.user_id = $1::uuid and l.user_id = $1::uuid`,
      p,
    );
    await tx.query(
      `update orbit.people set merged_into = $3::uuid, primary_email = null, linkedin_member_id = null,
         linkedin_slug = null where id = $2::uuid and user_id = $1::uuid`,
      p,
    );
    await tx.query(
      `update orbit.messages set from_person_id = $3::uuid where user_id = $1::uuid and from_person_id = $2::uuid`,
      p,
    );
    await tx.query(
      `update orbit.messages set to_person_ids = ${dedupeArray('to_person_ids')},
         cc_person_ids = ${dedupeArray('cc_person_ids')}
       where user_id = $1::uuid and ($2::uuid = any(to_person_ids) or $2::uuid = any(cc_person_ids))`,
      p,
    );
    await tx.query(
      `update orbit.threads set participant_person_ids = ${dedupeArray('participant_person_ids')}
        where user_id = $1::uuid and $2::uuid = any(participant_person_ids)`,
      p,
    );
    await tx.query(
      `update orbit.calendar_events set attendee_person_ids = ${dedupeArray('attendee_person_ids')}
        where user_id = $1::uuid and $2::uuid = any(attendee_person_ids)`,
      p,
    );
    await tx.query(
      `update orbit.notes set person_ids = ${dedupeArray('person_ids')}
        where user_id = $1::uuid and $2::uuid = any(person_ids)`,
      p,
    );
    for (const table of ['affiliations', 'chats', 'drafts', 'facts', 'recommendations', 'memories'])
      await tx.query(
        `update orbit.${table} set person_id = $3::uuid where user_id = $1::uuid and person_id = $2::uuid`,
        p,
      );
    await tx.query(
      `delete from orbit.dossiers d where d.user_id = $1::uuid and d.person_id = $2::uuid
         and exists (select 1 from orbit.dossiers s where s.user_id = $1::uuid and s.person_id = $3::uuid)`,
      p,
    );
    await tx.query(
      `update orbit.dossiers set person_id = $3::uuid where user_id = $1::uuid and person_id = $2::uuid`,
      p,
    );
    await tx.query(
      `update orbit.intro_requests set target_person_id = case when target_person_id = $2::uuid then $3::uuid else target_person_id end,
         introducer_person_id = case when introducer_person_id = $2::uuid then $3::uuid else introducer_person_id end
       where user_id = $1::uuid and $2::uuid in (target_person_id, introducer_person_id)`,
      p,
    );
    await tx.query(
      `insert into orbit.tie_labels (user_id, person_id, closeness, created_at)
       select user_id, $3::uuid, closeness, created_at from orbit.tie_labels where user_id = $1::uuid and person_id = $2::uuid
       on conflict (user_id, person_id) do nothing`,
      p,
    );
    await tx.query(
      `delete from orbit.tie_labels where user_id = $1::uuid and person_id = $2::uuid`,
      p.slice(0, 2),
    );
    await tx.query(
      `delete from orbit.tie_scores where user_id = $1::uuid and person_id = $2::uuid`,
      p.slice(0, 2),
    );
    await tx.query(
      `delete from orbit.ties where user_id = $1::uuid and (a_person_id = $2::uuid or b_person_id = $2::uuid)`,
      p.slice(0, 2),
    );
    await tx.query(
      `update orbit.merge_suggestions set status = 'merged', decided_at = now()
        where user_id = $1::uuid and status = 'open'
          and ((person_a = $2::uuid and person_b = $3::uuid) or (person_a = $3::uuid and person_b = $2::uuid))`,
      p,
    );
    await tx.query(
      `delete from orbit.merge_suggestions where user_id = $1::uuid and status = 'open'
          and (person_a = $2::uuid or person_b = $2::uuid)`,
      p.slice(0, 2),
    );
    await tx.query(
      `insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
       values ($1::uuid, 'system', 'people.merge', 'people', $3::text, jsonb_build_object('merged', $2::text))`,
      p,
    );
    return true;
  });
}
