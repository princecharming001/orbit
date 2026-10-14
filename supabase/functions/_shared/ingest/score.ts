/**
 * Tie scores from orbit rows (§3): each person's TieHistory is built with set-based queries, scored by core
 * `scoreTie` with the user's calibration, and written to orbit.tie_scores, people.strength (score / 100, or 0 for
 * someone with no tie at all, as in local mode) and people.last_interaction_at.
 *
 * History, per person P:
 *   messages      inbound from P and the user's outbound with P on To, with the thread's size (≤ 8 counted);
 *                 automated and list mail flagged; reply latency read within each thread; LinkedIn as its channel
 *   meetings      past, not cancelled, P attending and not declined, sized by the attendees who did not decline
 *   intros        introduced_by ties P is on (P introduced the user, or was introduced to them)
 *   shared        same school, overlapping employer (the self person's employment), same city
 *   linkedin      a LinkedIn relation identity (its creation time is the connection date)
 *   warmth        note extractions' warmth and inbound messages' sentiment
 *   structural    the previous scores of P's routable contacts
 *   label         the user's closeness rating, shown as its band midpoint until new contact
 * Family and partners are floored at 80 (§3.7). score.user also fits the per-user calibration from ≥ 8 labels.
 */
import { ROUTABLE_TIE_KINDS } from '@orbit/core/graph/ties';
import {
  CALIBRATION_MIN_LABELS,
  fitCalibration,
  scoreTie,
  sharedContext,
  TIE_WEIGHTS,
  type TieCalibration,
  type TieHistory,
  type TieMessage,
  tieBand,
  warmthValue,
} from '@orbit/core/scoring/tieScore';
import { affiliationFromRow, type Row } from '@orbit/core/server/mappers';
import { isAtsSender } from '@orbit/core/text/email';
import type { Affiliation, Person } from '@orbit/core/types';
import type { Db } from '../db.ts';
import { chunks, day, iso, PERSON_COLUMNS, toPerson } from './util.ts';

const HOUR = 3_600_000;
const FLOOR_TYPES = new Set(['family', 'partner']);

export interface ScoreRunResult {
  scored: number;
  calibration?: TieCalibration;
}

type MsgRow = {
  from_person_id: string | null;
  to_person_ids: string[];
  direction: 'in' | 'out';
  sent_at: unknown;
  provider: string;
  thread_id: string;
  automated: boolean;
  from_addr: string | null;
  participant_count: number;
  sentiment: string | null;
};

export function readCalibration(settings: Record<string, unknown>): TieCalibration | undefined {
  const c = settings.tie_calibration as { a?: unknown; c?: unknown } | undefined;
  if (!c || typeof c.a !== 'number' || typeof c.c !== 'number') return undefined;
  if (!Number.isFinite(c.a) || !Number.isFinite(c.c)) return undefined;
  return { a: c.a, c: c.c };
}

/** Builds every target's TieHistory in a handful of queries. */
export async function loadHistories(
  db: Db,
  userId: string,
  now: Date,
  personIds?: string[],
): Promise<{
  people: Person[];
  histories: Map<string, TieHistory>;
  relationship: Map<string, string | null>;
}> {
  const people = (
    await db.query<Record<string, unknown>>(
      `select ${PERSON_COLUMNS} from orbit.people p
        where p.user_id = $1::uuid and not p.is_self and p.deleted_at is null and p.merged_into is null
          and ($2::uuid[] is null or p.id = any($2::uuid[]))`,
      [userId, personIds ?? null],
    )
  ).map((r) => ({ row: r, person: toPerson(r) }));
  const ids = people.map((p) => p.person.id);
  const histories = new Map<string, TieHistory>();
  const relationship = new Map<string, string | null>();
  if (!ids.length) return { people: [], histories, relationship };

  const [user] = await db.sql<{ school: string | null; current_city: string | null }>`
    select school, current_city from orbit.users where id = ${userId}::uuid`;
  const affRows = await db.sql<Record<string, unknown>>`
    select a.*, p.is_self from orbit.affiliations a join orbit.people p on p.id = a.person_id
     where a.user_id = ${userId}::uuid and (p.is_self or a.person_id = any(${ids}::uuid[]))`;
  const affs = new Map<string, Affiliation[]>();
  const userEmployers: { name: string; startDate?: string; endDate?: string }[] = [];
  for (const a of affRows) {
    const aff = affiliationFromRow({
      ...a,
      start_date: day(a.start_date),
      end_date: day(a.end_date),
    } as unknown as Row.Affiliations);
    if (a.is_self) {
      if (aff.kind === 'employment' && aff.nameRaw)
        userEmployers.push({ name: aff.nameRaw, startDate: aff.startDate, endDate: aff.endDate });
      continue;
    }
    const arr = affs.get(aff.personId) ?? [];
    arr.push(aff);
    affs.set(aff.personId, arr);
  }

  const msgs = await db.sql<MsgRow>`
    select m.from_person_id, m.to_person_ids, m.direction, m.sent_at, m.provider, m.thread_id,
           m.is_automated or m.list_unsubscribe as automated, m.from_addr, t.participant_count,
           m.extraction ->> 'sentiment' as sentiment
      from orbit.messages m join orbit.threads t on t.id = m.thread_id
     where m.user_id = ${userId}::uuid
       and ((m.direction = 'in' and m.from_person_id = any(${ids}::uuid[]))
         or (m.direction = 'out' and m.to_person_ids && ${ids}::uuid[]))`;
  const msgsBy = new Map<string, MsgRow[]>();
  const push = <T>(map: Map<string, T[]>, k: string, v: T) => {
    const arr = map.get(k) ?? [];
    arr.push(v);
    map.set(k, arr);
  };
  const idSet = new Set(ids);
  for (const m of msgs) {
    if (m.direction === 'in' && m.from_person_id) push(msgsBy, m.from_person_id, m);
    else for (const p of m.to_person_ids ?? []) if (idSet.has(p)) push(msgsBy, p, m);
  }

  const events = await db.sql<{
    start_at: unknown;
    attendees: { responseStatus?: string | null }[];
    attendee_person_ids: string[];
  }>`
    select start_at, attendees, attendee_person_ids from orbit.calendar_events
     where user_id = ${userId}::uuid and status is distinct from 'cancelled' and start_at <= ${now}::timestamptz
       and attendee_person_ids && ${ids}::uuid[]`;
  const meetingsBy = new Map<string, { at: string; attendees: number }[]>();
  for (const e of events) {
    const going = (e.attendees ?? []).filter((a) => a.responseStatus !== 'declined').length;
    const attendees = Math.max(2, going || e.attendee_person_ids.length + 1);
    for (const p of e.attendee_person_ids)
      if (idSet.has(p)) push(meetingsBy, p, { at: iso(e.start_at)!, attendees });
  }

  const intros = await db.sql<{ a_person_id: string; b_person_id: string; introducer: string | null }>`
    select a_person_id, b_person_id, evidence ->> 'introducerId' as introducer from orbit.ties
     where user_id = ${userId}::uuid and kind = 'introduced_by'
       and (a_person_id = any(${ids}::uuid[]) or b_person_id = any(${ids}::uuid[]))`;
  const introsBy = new Map<string, TieHistory['introRole'][]>();
  for (const t of intros)
    for (const p of [t.a_person_id, t.b_person_id])
      if (idSet.has(p)) push(introsBy, p, t.introducer === p ? 'they_introduced_you' : 'introduced_to_you');

  const connected = new Map(
    (
      await db.sql<{ person_id: string; at: unknown }>`
        select person_id, min(created_at) as at from orbit.person_identities
         where user_id = ${userId}::uuid and kind = 'linkedin_member' and source = 'linkedin_relation'
           and person_id = any(${ids}::uuid[])
         group by person_id`
    ).map((r) => [r.person_id, iso(r.at)!]),
  );

  const notes = await db.sql<{ person_ids: string[]; warmth: string | null }>`
    select person_ids, extraction ->> 'warmth' as warmth from orbit.notes
     where user_id = ${userId}::uuid and person_ids && ${ids}::uuid[] and extraction ? 'warmth'`;
  const warmthBy = new Map<string, number[]>();
  for (const n of notes)
    for (const p of n.person_ids)
      if (idSet.has(p)) push(warmthBy, p, warmthValue(n.warmth as 'warm' | 'neutral' | 'cool' | undefined));

  // structural: the previous run's scores of contacts P knows (routable kinds only)
  const routable = [...ROUTABLE_TIE_KINDS];
  const mutualRows = await db.sql<{
    person: string;
    other: string;
    score: number | null;
    name: string | null;
  }>`
    select x.person, x.other, s.score, coalesce(o.first_name, o.display_name) as name
      from (select a_person_id as person, b_person_id as other from orbit.ties
             where user_id = ${userId}::uuid and kind = any(${routable}::text[]) and a_person_id = any(${ids}::uuid[])
            union
            select b_person_id, a_person_id from orbit.ties
             where user_id = ${userId}::uuid and kind = any(${routable}::text[]) and b_person_id = any(${ids}::uuid[])) x
      join orbit.people o on o.id = x.other and o.merged_into is null and o.deleted_at is null
      left join orbit.tie_scores s on s.user_id = ${userId}::uuid and s.person_id = x.other`;
  const mutualBy = new Map<string, { score: number; name: string }[]>();
  for (const m of mutualRows)
    if (m.score != null) push(mutualBy, m.person, { score: Number(m.score), name: m.name ?? '' });

  const labels = new Map(
    (
      await db.sql<{ person_id: string; closeness: number; updated_at: unknown }>`
        select person_id, closeness, updated_at from orbit.tie_labels
         where user_id = ${userId}::uuid and person_id = any(${ids}::uuid[])`
    ).map((l) => [l.person_id, { closeness: Number(l.closeness), at: iso(l.updated_at)! }]),
  );

  for (const { row, person } of people) {
    relationship.set(person.id, (row.relationship_type as string | null) ?? null);
    const messages = toTieMessages(msgsBy.get(person.id) ?? []);
    const intro = introsBy.get(person.id) ?? [];
    const mutual = mutualBy.get(person.id) ?? [];
    const warmth = [
      ...(warmthBy.get(person.id) ?? []),
      ...(msgsBy.get(person.id) ?? [])
        .filter((m) => m.direction === 'in' && m.sentiment)
        .map((m) => warmthValue(m.sentiment as 'warm' | 'neutral' | 'cool')),
    ];
    histories.set(person.id, {
      name: person.firstName || undefined,
      messages,
      meetings: meetingsBy.get(person.id) ?? [],
      intros: intro.length,
      introRole: intro.includes('they_introduced_you') ? 'they_introduced_you' : intro[0],
      shared: sharedContext({
        person,
        user: { school: user?.school ?? undefined, currentCity: user?.current_city ?? undefined },
        userEmployers,
        affiliations: affs.get(person.id) ?? [],
      }),
      linkedinConnected: connected.has(person.id),
      connectedAt: connected.get(person.id),
      noteWarmth: warmth,
      mutualScores: mutual.map((m) => m.score),
      mutualNames: mutual.map((m) => m.name),
      label: labels.get(person.id),
    });
  }
  return { people: people.map((p) => p.person), histories, relationship };
}

/** Messages of one person as TieMessages, with the reply latency read within each thread. */
export function toTieMessages(rows: MsgRow[]): TieMessage[] {
  const out: TieMessage[] = rows
    .map((m) => ({
      at: iso(m.sent_at)!,
      direction: m.direction,
      channel: m.provider === 'linkedin' ? ('linkedin' as const) : ('email' as const),
      threadParticipants: Math.max(2, Number(m.participant_count ?? 1) + 1),
      threadId: m.thread_id,
      automated: !!m.automated || (m.direction === 'in' && !!m.from_addr && isAtsSender(m.from_addr)),
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const lastOut = new Map<string, number>();
  const prevDir = new Map<string, 'in' | 'out'>();
  for (const m of out) {
    const t = new Date(m.at).getTime();
    if (m.direction === 'in' && !m.automated && prevDir.get(m.threadId) === 'out') {
      const hrs = (t - lastOut.get(m.threadId)!) / HOUR;
      if (hrs >= 0) (m as TieMessage).isReplyLatencyHours = hrs;
    }
    if (m.direction === 'out') lastOut.set(m.threadId, t);
    prevDir.set(m.threadId, m.direction);
  }
  return out;
}

/**
 * Scores the given people (or everyone). `fit` also refits the user's calibration from their labels first (score.user).
 */
export async function scorePeople(
  db: Db,
  userId: string,
  opts: { now: Date; personIds?: string[]; fit?: boolean },
): Promise<ScoreRunResult> {
  const { now } = opts;
  const [u] = await db.sql<{ settings: Record<string, unknown> | null }>`
    select settings from orbit.users where id = ${userId}::uuid`;
  let calibration = readCalibration(u?.settings ?? {});
  const { people, histories, relationship } = await loadHistories(db, userId, now, opts.personIds);

  if (opts.fit) {
    const labelled = [...histories.entries()].filter(([, h]) => h.label);
    if (labelled.length >= CALIBRATION_MIN_LABELS) {
      const fitted = fitCalibration(
        labelled.map(([, h]) => ({
          z: scoreTie({ ...h, label: undefined }, now).z,
          closeness: h.label!.closeness,
        })),
      );
      if (fitted) {
        calibration = fitted;
        await db.sql`
          update orbit.users set settings = settings || jsonb_build_object('tie_calibration',
            ${{ a: fitted.a, c: fitted.c, n: labelled.length, fittedAt: now.toISOString() }}::jsonb)
           where id = ${userId}::uuid`;
      }
    }
  }

  const rows = people.map((p) => {
    const h = histories.get(p.id)!;
    const tie = scoreTie(h, now, TIE_WEIGHTS, calibration);
    const score = FLOOR_TYPES.has(relationship.get(p.id) ?? '') ? Math.max(80, tie.score) : tie.score;
    const exists = !tie.facts.never || h.linkedinConnected || h.intros > 0;
    const lastAt = [
      ...h.messages.filter((m) => !m.automated && m.threadParticipants <= 9).map((m) => m.at),
      ...h.meetings.map((m) => m.at),
    ]
      .sort()
      .pop();
    return {
      id: p.id,
      score,
      band: tieBand(score),
      features: tie.features,
      contributions: tie.contributions,
      explanation: tie.explanation,
      model: tie.modelVersion,
      strength: exists ? score / 100 : 0,
      last: lastAt ?? null,
    };
  });
  for (const part of chunks(rows, 500)) {
    const json = JSON.stringify(part);
    await db.sql`
      insert into orbit.tie_scores (user_id, person_id, score, band, features, contributions, explanation,
                                    model_version, computed_at)
      select ${userId}::uuid, (r ->> 'id')::uuid, (r ->> 'score')::smallint, r ->> 'band', r -> 'features',
             r -> 'contributions', array(select jsonb_array_elements_text(r -> 'explanation')), r ->> 'model',
             ${now}::timestamptz
        from jsonb_array_elements(${json}::jsonb) r
      on conflict (user_id, person_id) do update set
        score = excluded.score, band = excluded.band, features = excluded.features,
        contributions = excluded.contributions, explanation = excluded.explanation,
        model_version = excluded.model_version, computed_at = excluded.computed_at`;
    await db.sql`
      update orbit.people p set strength = (r ->> 'strength')::real,
             last_interaction_at = coalesce((r ->> 'last')::timestamptz, p.last_interaction_at)
        from jsonb_array_elements(${json}::jsonb) r
       where p.id = (r ->> 'id')::uuid and p.user_id = ${userId}::uuid
         and (p.strength is distinct from (r ->> 'strength')::real
           or p.last_interaction_at is distinct from coalesce((r ->> 'last')::timestamptz, p.last_interaction_at))`;
  }
  return { scored: rows.length, calibration };
}
