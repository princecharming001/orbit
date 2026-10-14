/**
 * orbit.ties from the stored mail, meetings and affiliations (§2.3), with core `inferTies` doing the inference.
 *
 *   refreshTies(db, user, now)                 the nightly rebuild (score.user): every kind Orbit infers itself —
 *                                              email_exchange, email_cc, email_cothread, meeting_coattendee,
 *                                              co_tenure, same_school_cohort, same_current_company, same_city —
 *                                              with interaction kinds decayed (w·0.5^(years/2)) and rows whose
 *                                              evidence is gone deleted
 *   refreshTies(db, user, now, {personIds})    the incremental pass after new mail or events: the interaction kinds
 *                                              for pairs that include one of these people
 *
 * linkedin_mutual, village_path and introduced_by rows come from elsewhere (mutual search, Village, introduction
 * detection at ingest) and are never touched here. Threads with more than 8 people and events with more than 8
 * attendees carry no tie (core). The stored weight is the decayed w; first/last seen are the evidence's dates.
 */
import { decayedTieWeight, inferTies, type Tie, type TieKind } from '@orbit/core/graph/ties';
import { affiliationFromRow, type Row } from '@orbit/core/server/mappers';
import type { CalendarEvent, EmailMessage, EmailThread, Organization } from '@orbit/core/types';
import type { Db } from '../db.ts';
import { day, iso, PERSON_COLUMNS, toPerson } from './util.ts';

export const INTERACTION_KINDS: TieKind[] = [
  'email_exchange',
  'email_cc',
  'email_cothread',
  'meeting_coattendee',
];
const AFFILIATION_KINDS = ['co_tenure', 'same_school_cohort', 'same_current_company', 'same_city'];
/** what refreshTies owns; the other kinds are written by their own sources */
export const INFERRED_KINDS = [...INTERACTION_KINDS, ...AFFILIATION_KINDS];

const GROUP_MAX = 8;

export interface TieRow {
  a: string;
  b: string;
  kind: string;
  weight: number;
  confidence: number;
  evidence: Record<string, unknown>;
  firstSeenAt?: string;
  lastSeenAt?: string;
}

/** `same_city` (§2.3): both currently in one normalized city, w 0.05, c 0.1; never routable on its own. */
export function sameCityTies(people: { id: string; location?: string }[]): TieRow[] {
  const byCity = new Map<string, string[]>();
  for (const p of people) {
    const city = (p.location ?? '').toLowerCase().split(',')[0]!.replace(/\s+/g, ' ').trim();
    if (!city || city.length < 2) continue;
    const arr = byCity.get(city) ?? [];
    arr.push(p.id);
    byCity.set(city, arr);
  }
  const out: TieRow[] = [];
  for (const [city, ids] of byCity) {
    // a whole metro of contacts is no evidence of anything: cap the pairs one city can produce
    if (ids.length > 200) continue;
    const sorted = [...ids].sort();
    for (let i = 0; i < sorted.length; i++)
      for (let j = i + 1; j < sorted.length; j++)
        out.push({
          a: sorted[i]!,
          b: sorted[j]!,
          kind: 'same_city',
          weight: 0.05,
          confidence: 0.1,
          evidence: { city, text: 'Live in the same city' },
        });
  }
  return out;
}

export async function refreshTies(
  db: Db,
  userId: string,
  now: Date,
  scope: { personIds?: string[] } = {},
): Promise<{ upserted: number; deleted: number }> {
  const scoped = !!scope.personIds;
  const focus = scope.personIds ?? [];
  if (scoped && !focus.length) return { upserted: 0, deleted: 0 };

  // people (all: inferTies needs the address book to read who wrote to whom)
  const rows = await db.query<Record<string, unknown>>(
    `select ${PERSON_COLUMNS} from orbit.people p
      where p.user_id = $1::uuid and p.deleted_at is null and p.merged_into is null and not p.is_self`,
    [userId],
  );
  const idRows = await db.sql<{ person_id: string; kind: string; value_norm: string }>`
    select pi.person_id, pi.kind, pi.value_norm from orbit.person_identities pi
      join orbit.people p on p.id = pi.person_id
     where pi.user_id = ${userId}::uuid and pi.kind = 'email' and not p.is_self`;
  const idsBy = new Map<string, { kind: string; value_norm: string }[]>();
  for (const r of idRows) {
    const arr = idsBy.get(r.person_id) ?? [];
    arr.push(r);
    idsBy.set(r.person_id, arr);
  }
  const people = rows.map((r) => toPerson(r, idsBy.get(r.id as string)));

  // threads (small ones only) and their messages
  const threadRows = await db.sql<{
    id: string;
    participant_person_ids: string[];
    last_at: unknown;
    first_at: unknown;
  }>`
    select id, participant_person_ids, last_at, first_at from orbit.threads
     where user_id = ${userId}::uuid and cardinality(participant_person_ids) between 2 and ${GROUP_MAX}::int
       and (not ${scoped}::boolean or participant_person_ids && ${focus}::uuid[])`;
  const threads: EmailThread[] = threadRows.map((t) => ({
    id: t.id,
    userId,
    externalThreadId: t.id,
    messageCount: 0,
    participantEmails: [],
    participantPersonIds: t.participant_person_ids,
    isNetworking: false,
    lastMessageAt: iso(t.last_at) ?? undefined,
    firstMessageAt: iso(t.first_at) ?? undefined,
  }));
  const threadIds = threads.map((t) => t.id);
  const msgRows = threadIds.length
    ? await db.sql<{
        id: string;
        thread_id: string;
        direction: string;
        from_person_id: string | null;
        from_addr: string | null;
        to_addrs: string[];
        cc_addrs: string[];
        sent_at: unknown;
        is_automated: boolean;
      }>`
        select id, thread_id, direction, from_person_id, from_addr, to_addrs, cc_addrs, sent_at,
               is_automated or list_unsubscribe as is_automated
          from orbit.messages where user_id = ${userId}::uuid and thread_id = any(${threadIds}::uuid[])`
    : [];
  const messages: EmailMessage[] = msgRows.map((m) => ({
    id: m.id,
    userId,
    threadId: m.thread_id,
    externalMessageId: m.id,
    direction: m.direction === 'out' ? 'outbound' : 'inbound',
    fromEmail: m.from_addr ?? '',
    fromPersonId: m.from_person_id ?? undefined,
    toEmails: m.to_addrs ?? [],
    ccEmails: m.cc_addrs ?? [],
    sentAt: iso(m.sent_at)!,
    bodyText: '',
    headers: {},
    isAutomated: m.is_automated,
  }));

  // meetings in the past (a future invite is not yet a meeting)
  const eventRows = await db.sql<{
    id: string;
    start_at: unknown;
    end_at: unknown;
    status: string | null;
    attendees: { email?: string; responseStatus?: string; self?: boolean }[];
    attendee_person_ids: string[];
  }>`
    select id, start_at, end_at, status, attendees, attendee_person_ids from orbit.calendar_events
     where user_id = ${userId}::uuid and start_at <= ${now}::timestamptz
       and cardinality(attendee_person_ids) >= 2 and attendee_count <= ${GROUP_MAX}::int
       and (not ${scoped}::boolean or attendee_person_ids && ${focus}::uuid[])`;
  const events: CalendarEvent[] = eventRows.map((e) => ({
    id: e.id,
    userId,
    externalEventId: e.id,
    startAt: iso(e.start_at)!,
    endAt: iso(e.end_at) ?? iso(e.start_at)!,
    status: (e.status === 'cancelled' ? 'cancelled' : e.status === 'tentative' ? 'tentative' : 'confirmed') as
      | 'cancelled'
      | 'tentative'
      | 'confirmed',
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.email ?? '',
      responseStatus: a.responseStatus,
      self: a.self,
    })),
    attendeePersonIds: e.attendee_person_ids,
  }));

  // affiliations and organizations (the nightly rebuild only)
  const affiliations = scoped
    ? []
    : (
        await db.sql<Record<string, unknown>>`
          select a.* from orbit.affiliations a join orbit.people p on p.id = a.person_id
           where a.user_id = ${userId}::uuid and p.merged_into is null and p.deleted_at is null and not p.is_self`
      ).map((a) =>
        affiliationFromRow({
          ...a,
          start_date: day(a.start_date),
          end_date: day(a.end_date),
        } as unknown as Row.Affiliations),
      );
  const organizations = new Map<string, Organization>();
  if (!scoped)
    for (const o of await db.sql<{
      id: string;
      name: string;
      name_norm: string;
      domains: string[];
      size_bucket: string | null;
    }>`
      select id, name, name_norm, domains, size_bucket from orbit.organizations where user_id = ${userId}::uuid`)
      organizations.set(o.id, {
        id: o.id,
        name: o.name,
        nameNormalized: o.name_norm,
        domains: o.domains,
        sizeBucket: o.size_bucket ?? undefined,
      });

  const inferred = inferTies({
    userId,
    people,
    affiliations,
    organizations,
    threads,
    events,
    messages,
    now,
  });
  const keep = new Set<string>(scoped ? INTERACTION_KINDS : INFERRED_KINDS);
  const inFocus = (t: { a: string; b: string }) => !scoped || focus.includes(t.a) || focus.includes(t.b);
  const out: TieRow[] = inferred
    .filter((t: Tie) => keep.has(t.kind) && inFocus({ a: t.aId, b: t.bId }))
    .map((t: Tie) => ({
      a: t.aId,
      b: t.bId,
      kind: t.kind,
      weight: decayedTieWeight(t, now),
      confidence: t.confidence,
      evidence: { ...t.evidence, source: 'orbit' },
      firstSeenAt: t.firstSeenAt,
      lastSeenAt: t.lastSeenAt,
    }));
  if (!scoped) out.push(...sameCityTies(people.filter((p) => !p.hiddenAt)));

  let upserted = 0;
  for (const t of out) {
    await upsertTie(db, userId, t, now);
    upserted++;
  }
  // evidence that no longer exists (a deleted message, a declined meeting, a job change) loses its row
  const kinds = [...keep];
  const live = out.map((t) => `${t.a}|${t.b}|${t.kind}`);
  const gone = await db.sql<{ id: string }>`
    delete from orbit.ties t
     where t.user_id = ${userId}::uuid and t.kind = any(${kinds}::text[])
       and (not ${scoped}::boolean or t.a_person_id = any(${focus}::uuid[]) or t.b_person_id = any(${focus}::uuid[]))
       and not (t.a_person_id::text || '|' || t.b_person_id::text || '|' || t.kind = any(${live}::text[]))
    returning t.id`;
  return { upserted, deleted: gone.length };
}

/** One (pair, kind) row; a < b is enforced here. Unchanged rows are left alone so pulls stay small. */
export async function upsertTie(db: Db, userId: string, t: TieRow, now: Date): Promise<void> {
  const [a, b] = t.a < t.b ? [t.a, t.b] : [t.b, t.a];
  if (a === b) return;
  const w = Math.min(1, Math.max(0, t.weight));
  const c = Math.min(1, Math.max(0, t.confidence));
  await db.sql`
    insert into orbit.ties (user_id, a_person_id, b_person_id, kind, weight, confidence, evidence, first_seen_at,
                            last_seen_at)
    values (${userId}::uuid, ${a}::uuid, ${b}::uuid, ${t.kind}, ${w}::real, ${c}::real, ${t.evidence}::jsonb,
            coalesce(${t.firstSeenAt ?? null}::timestamptz, ${now}::timestamptz),
            coalesce(${t.lastSeenAt ?? null}::timestamptz, ${now}::timestamptz))
    on conflict (user_id, a_person_id, b_person_id, kind) do update set
      weight = excluded.weight, confidence = excluded.confidence, evidence = excluded.evidence,
      first_seen_at = least(orbit.ties.first_seen_at, excluded.first_seen_at),
      last_seen_at = excluded.last_seen_at
    where orbit.ties.weight is distinct from excluded.weight
       or orbit.ties.confidence is distinct from excluded.confidence
       or orbit.ties.evidence is distinct from excluded.evidence
       or orbit.ties.last_seen_at is distinct from excluded.last_seen_at`;
}

/** An introduction found in a thread (§2.3 introduced_by: w 0.85, c 0.95), kept until the people are merged. */
export async function upsertIntroTie(
  db: Db,
  userId: string,
  i: { introducerId: string; introducedId: string; threadId: string; messageId: string; at: string },
  now: Date,
): Promise<void> {
  await upsertTie(
    db,
    userId,
    {
      a: i.introducerId,
      b: i.introducedId,
      kind: 'introduced_by',
      weight: 0.85,
      confidence: 0.95,
      evidence: {
        introducerId: i.introducerId,
        threadIds: [i.threadId],
        messageId: i.messageId,
        at: i.at,
        source: 'gmail',
        text: 'Introduced you',
      },
      firstSeenAt: i.at,
      lastSeenAt: i.at,
    },
    now,
  );
}
