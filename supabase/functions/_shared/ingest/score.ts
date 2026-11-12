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
 *   warmth        note extractions' warmth
 *   rapport       how warm their replies read (extraction.rapport, plan 27), unless the student turned it off
 *   structural    the previous scores of P's routable contacts
 *   label         the user's closeness rating, shown as its band midpoint until new contact
 * Family and partners are floored at 80 (§3.7). score.user also fits the per-user calibration from ≥ 8 labels.
 * Beside the score, share_score (plan 29 §A2.2): the same history scored with every Google-derived feature zeroed,
 * the number a friend's closeness word is cut from. It never carries the family floor: a friend sees signal, not who
 * the student's family is.
 */
import { ROUTABLE_TIE_KINDS } from '@orbit/core/graph/ties';
import {
  CALIBRATION_MIN_LABELS,
  fitCalibration,
  gatherRapport,
  scoreTie,
  sharedContext,
  shareScore,
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
import { NO_SOURCES, type SourcesInUse } from '../sources/states.ts';
import { chunks, day, iso, PERSON_COLUMNS, toPerson } from './util.ts';

const HOUR = 3_600_000;
const FLOOR_TYPES = new Set(['family', 'partner']);

export interface ScoreRunResult {
  scored: number;
  calibration?: TieCalibration;
}

type MsgRow = {
  /** a chat day from orbit.text_days (plan 43 §6): channel text, one message per day each way */
  text?: boolean;
  from_person_id: string | null;
  to_person_ids: string[];
  direction: 'in' | 'out';
  sent_at: unknown;
  provider: string;
  thread_id: string;
  automated: boolean;
  from_addr: string | null;
  participant_count: number;
  /** extraction.rapport: how warm their reply reads (plan 27) */
  rapport: unknown;
  /** Instagram and X: false when nothing was written (a reaction, a shared post); null on mail */
  has_words?: boolean | null;
};

/** The channel of a stored message (plan 43 §3.8): Instagram, X and texts are chat; mail and LinkedIn keep theirs. */
const channelOf = (m: Pick<MsgRow, 'provider' | 'text'>): TieMessage['channel'] =>
  m.text
    ? 'text'
    : m.provider === 'linkedin'
      ? 'linkedin'
      : m.provider === 'instagram'
        ? 'instagram'
        : m.provider === 'x'
          ? 'x'
          : 'email';

export function readCalibration(settings: Record<string, unknown>): TieCalibration | undefined {
  const c = settings.tie_calibration as { a?: unknown; c?: unknown } | undefined;
  if (!c || typeof c.a !== 'number' || typeof c.c !== 'number') return undefined;
  if (!Number.isFinite(c.a) || !Number.isFinite(c.c)) return undefined;
  return { a: c.a, c: c.c };
}

/**
 * Builds every target's TieHistory in a handful of queries. `src` says which optional sources count (plan 43 §3.2):
 * people known only from a source out of use are not scored, and its messages, text days, follows and ties are left
 * out; with no optional source in use every history is what it was before plan 43.
 */
export async function loadHistories(
  db: Db,
  userId: string,
  now: Date,
  personIds?: string[],
  src: SourcesInUse = NO_SOURCES,
): Promise<{
  people: Person[];
  histories: Map<string, TieHistory>;
  relationship: Map<string, string | null>;
}> {
  const people = (
    await db.query<Record<string, unknown>>(
      `select ${PERSON_COLUMNS} from orbit.people p
        where p.user_id = $1::uuid and not p.is_self and p.deleted_at is null and p.merged_into is null
          and ($2::uuid[] is null or p.id = any($2::uuid[]))
          and orbit.person_in_use(p.sources, p.source_account, $3::text[])`,
      [userId, personIds ?? null, src.hidden],
    )
  ).map((r) => ({ row: r, person: toPerson(r) }));
  const ids = people.map((p) => p.person.id);
  const histories = new Map<string, TieHistory>();
  const relationship = new Map<string, string | null>();
  if (!ids.length) return { people: [], histories, relationship };

  const [user] = await db.sql<{
    school: string | null;
    current_city: string | null;
    tone: boolean | null;
    timezone: string | null;
  }>`
    select school, current_city, (settings ->> 'read_reply_tone')::boolean as tone, timezone
      from orbit.users where id = ${userId}::uuid`;
  // the student can turn the tone of replies off (plan 27): then f16 stays 0
  const readTone = user?.tone !== false;
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
           m.extraction -> 'rapport' as rapport, m.has_words
      from orbit.messages m join orbit.threads t on t.id = m.thread_id
     where m.user_id = ${userId}::uuid and m.provider <> all(${src.excluded.providers}::text[])
       and ((m.direction = 'in' and m.from_person_id = any(${ids}::uuid[]))
         or (m.direction = 'out' and m.to_person_ids && ${ids}::uuid[]))`;
  // texts, for a signed-in student whose browser sent them (plan 43 §6): one message a day each way, never the words
  if (src.inUse.has('imessage')) {
    const days = await db.sql<{
      person_id: string;
      day: unknown;
      in_count: number;
      out_count: number;
      group_size: number;
      words: boolean;
    }>`
      select person_id, day, in_count, out_count, group_size, words from orbit.text_days
       where user_id = ${userId}::uuid and person_id = any(${ids}::uuid[]) and (in_count > 0 or out_count > 0)`;
    for (const d of days) {
      // the student's local day as the browser counted it; noon UTC keeps it on that calendar day
      const at = `${day(d.day)}T12:00:00.000Z`;
      for (const [direction, n] of [
        ['in', d.in_count],
        ['out', d.out_count],
      ] as const)
        if (n > 0)
          msgs.push({
            text: true,
            from_person_id: direction === 'in' ? d.person_id : null,
            to_person_ids: direction === 'out' ? [d.person_id] : [],
            direction,
            sent_at: at,
            provider: 'imessage',
            thread_id: `text:${d.person_id}`,
            automated: false,
            from_addr: null,
            // a thread's participant count leaves the student out; the row counts everyone in the chat
            participant_count: Math.max(1, Number(d.group_size) - 1),
            rapport: null,
            has_words: d.words,
          });
    }
  }
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
               and kind <> all(${src.excluded.tieKinds}::text[])
            union
            select b_person_id, a_person_id from orbit.ties
             where user_id = ${userId}::uuid and kind = any(${routable}::text[]) and b_person_id = any(${ids}::uuid[])
               and kind <> all(${src.excluded.tieKinds}::text[])) x
      join orbit.people o on o.id = x.other and o.merged_into is null and o.deleted_at is null
       and orbit.person_in_use(o.sources, o.source_account, ${src.hidden}::text[])
      left join orbit.tie_scores s on s.user_id = ${userId}::uuid and s.person_id = x.other`;
  const mutualBy = new Map<string, { score: number; name: string }[]>();
  for (const m of mutualRows)
    if (m.score != null) push(mutualBy, m.person, { score: Number(m.score), name: m.name ?? '' });

  // following each other on Instagram or X (plan 43 §3.8), for the platforms in use: the person's attached account and
  // the student's own account follow each other in the student's own lists
  const platforms = (['instagram', 'x'] as const).filter((s) => src.inUse.has(s));
  const followsBy = new Map<string, { instagram?: boolean; x?: boolean }>();
  if (platforms.length)
    for (const f of await db.sql<{ person_id: string; platform: 'instagram' | 'x' }>`
      select distinct l.person_id, l.platform from orbit.social_links l
        join orbit.integration_accounts i
          on i.user_id = l.user_id and i.provider = l.platform and i.social_account_id is not null
       where l.user_id = ${userId}::uuid and l.platform = any(${platforms}::text[]) and l.person_id = any(${ids}::uuid[])
         and exists (select 1 from orbit.social_follows f
                      where f.platform = l.platform and f.owner_user_id = l.user_id
                        and f.follower_id = i.social_account_id and f.followed_id = l.account_id)
         and exists (select 1 from orbit.social_follows f
                      where f.platform = l.platform and f.owner_user_id = l.user_id
                        and f.follower_id = l.account_id and f.followed_id = i.social_account_id)`)
      followsBy.set(f.person_id, { ...followsBy.get(f.person_id), [f.platform]: true });
  // chat days are counted in the student's own time zone, once a chat source is in use
  const timeZone = src.inUse.size && user?.timezone ? user.timezone : undefined;

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
    // f13 is the student's notes only; their replies' tone is f16, read the same way as in the browser
    const warmth = warmthBy.get(person.id) ?? [];
    // replies' tone is read from mail and LinkedIn only: chat is personal and never classified (plan 43 §3.9)
    const toned = (msgsBy.get(person.id) ?? []).filter(
      (m) => m.provider === 'gmail' || m.provider === 'linkedin',
    );
    const rapport = readTone
      ? gatherRapport(
          toned.map((m) => ({
            at: iso(m.sent_at)!,
            inbound: m.direction === 'in',
            automated: !!m.automated,
            participants: Math.max(2, Number(m.participant_count ?? 1) + 1),
            channel: m.provider === 'linkedin' ? ('linkedin' as const) : ('email' as const),
            reading: m.rapport,
            fromEmail: m.from_addr ?? undefined,
          })),
        )
      : [];
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
      ...(rapport.length ? { rapport } : {}),
      ...(followsBy.has(person.id) ? { follows: followsBy.get(person.id) } : {}),
      ...(timeZone ? { timeZone } : {}),
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
      channel: channelOf(m),
      threadParticipants: Math.max(2, Number(m.participant_count ?? 1) + 1),
      threadId: m.thread_id,
      automated: !!m.automated || (m.direction === 'in' && !!m.from_addr && isAtsSender(m.from_addr)),
      // a chat message with nothing written counts as light engagement (plan 43 §3.8)
      ...(m.has_words === false ? { words: false } : {}),
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
  opts: { now: Date; personIds?: string[]; fit?: boolean; sources?: SourcesInUse },
): Promise<ScoreRunResult> {
  const { now } = opts;
  const src = opts.sources ?? NO_SOURCES;
  const [u] = await db.sql<{ settings: Record<string, unknown> | null }>`
    select settings from orbit.users where id = ${userId}::uuid`;
  let calibration = readCalibration(u?.settings ?? {});
  const { people, histories, relationship } = await loadHistories(db, userId, now, opts.personIds, src);

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
    const share = shareScore(h, now, TIE_WEIGHTS, calibration);
    // following each other makes a tie exist, as a LinkedIn connection does (plan 43 §3.3)
    const exists =
      !tie.facts.never || h.linkedinConnected || h.intros > 0 || !!h.follows?.instagram || !!h.follows?.x;
    const lastAt = [
      ...h.messages.filter((m) => !m.automated && m.threadParticipants <= 9).map((m) => m.at),
      ...h.meetings.map((m) => m.at),
    ]
      .sort()
      .pop();
    return {
      id: p.id,
      score,
      share,
      band: tieBand(score),
      features: tie.features,
      contributions: tie.contributions,
      explanation: tie.explanation,
      model: tie.modelVersion,
      strength: exists ? score / 100 : 0,
      last: lastAt ?? null,
      hiddenLast: null as string | null,
    };
  });
  // plan 43 §3.2: a last contact that came from a source now out of use goes with it (the person's newest contact in
  // use, or none). Only when the owner offers a source, so nothing changes before plan 43 is switched on.
  if (src.offered.length && rows.length) {
    const ids = rows.map((r) => r.id);
    const hiddenLast = new Map(
      (
        await db.sql<{ person_id: string; at: unknown }>`
          select x.person_id, max(x.at) as at from (
            select m.from_person_id as person_id, m.sent_at as at from orbit.messages m
             where m.user_id = ${userId}::uuid and m.provider = any(${src.hidden}::text[])
               and m.from_person_id = any(${ids}::uuid[])
            union all
            select unnest(m.to_person_ids), m.sent_at from orbit.messages m
             where m.user_id = ${userId}::uuid and m.provider = any(${src.hidden}::text[])
               and m.to_person_ids && ${ids}::uuid[]
            union all
            select d.person_id, (d.day + 1)::timestamptz from orbit.text_days d
             where d.user_id = ${userId}::uuid and 'imessage' = any(${src.hidden}::text[])
               and d.person_id = any(${ids}::uuid[])) x
           group by x.person_id`
      ).map((r) => [r.person_id, iso(r.at)!]),
    );
    for (const r of rows) r.hiddenLast = hiddenLast.get(r.id) ?? null;
  }
  for (const part of chunks(rows, 500)) {
    const json = JSON.stringify(part);
    await db.sql`
      insert into orbit.tie_scores (user_id, person_id, score, share_score, band, features, contributions,
                                    explanation, model_version, computed_at)
      select ${userId}::uuid, (r ->> 'id')::uuid, (r ->> 'score')::smallint, (r ->> 'share')::smallint, r ->> 'band',
             r -> 'features', r -> 'contributions', array(select jsonb_array_elements_text(r -> 'explanation')),
             r ->> 'model', ${now}::timestamptz
        from jsonb_array_elements(${json}::jsonb) r
      on conflict (user_id, person_id) do update set
        score = excluded.score, share_score = excluded.share_score, band = excluded.band, features = excluded.features,
        contributions = excluded.contributions, explanation = excluded.explanation,
        model_version = excluded.model_version, computed_at = excluded.computed_at
      where (orbit.tie_scores.score, orbit.tie_scores.share_score, orbit.tie_scores.band, orbit.tie_scores.features,
             orbit.tie_scores.contributions, orbit.tie_scores.explanation, orbit.tie_scores.model_version)
            is distinct from (excluded.score, excluded.share_score, excluded.band, excluded.features,
                              excluded.contributions, excluded.explanation, excluded.model_version)`;
    // scored_at marks the run for delta scoring (plan 35 B1); on its own it does not bump updated_at (B2's trigger),
    // so a person whose strength did not move is not sent to the browser again
    await db.sql`
      update orbit.people p set strength = (r ->> 'strength')::real,
             last_interaction_at = case
               when r ->> 'last' is not null then (r ->> 'last')::timestamptz
               when r ->> 'hiddenLast' is not null
                    and p.last_interaction_at <= (r ->> 'hiddenLast')::timestamptz + interval '1 day' then null
               else p.last_interaction_at end,
             scored_at = now()
        from jsonb_array_elements(${json}::jsonb) r
       where p.id = (r ->> 'id')::uuid and p.user_id = ${userId}::uuid`;
  }
  return { scored: rows.length, calibration };
}

/** Scores older than this are rebuilt for everyone (plan 35 B1): recency decay and neighbours' scores move them. */
export const FULL_RESCORE_DAYS = 7;

/**
 * Whether tonight's run rescores everyone: someone's last score is a week old (delta runs leave unchanged people at
 * their old scored_at, so this comes round weekly).
 */
export async function fullRescoreDue(db: Db, userId: string): Promise<boolean> {
  // the database's clock, as scored_at is
  const [r] = await db.sql<{ due: boolean | null }>`
    select min(scored_at) < now() - make_interval(days => ${FULL_RESCORE_DAYS}) as due from orbit.people
     where user_id = ${userId}::uuid and not is_self and deleted_at is null and merged_into is null`;
  return r?.due === true;
}

/**
 * The people whose score can have moved since their last one (plan 35 B1): never scored, their own row changed, or
 * one of the inputs loadHistories reads is newer than their scored_at: a message from or to them, a meeting they are
 * on (edited, or now in the past), a tie, an affiliation, a label, a note, a LinkedIn identity. Removed ties and the
 * passing of time are left to the weekly full rescore.
 */
export async function changedPeople(db: Db, userId: string): Promise<string[]> {
  const rows = await db.sql<{ id: string }>`
    with live as (
      select id, scored_at, updated_at from orbit.people
       where user_id = ${userId}::uuid and not is_self and deleted_at is null and merged_into is null),
    since as (select coalesce(min(scored_at), '-infinity'::timestamptz) as t from live),
    touched as (
      select m.from_person_id as id, m.updated_at as at from orbit.messages m, since
       where m.user_id = ${userId}::uuid and m.updated_at > since.t and m.from_person_id is not null
      union all
      select unnest(m.to_person_ids), m.updated_at from orbit.messages m, since
       where m.user_id = ${userId}::uuid and m.updated_at > since.t
      union all
      select unnest(e.attendee_person_ids),
             case when e.start_at <= now() then greatest(e.updated_at, e.start_at) else e.updated_at end
        from orbit.calendar_events e, since
       where e.user_id = ${userId}::uuid and (e.updated_at > since.t or e.start_at between since.t and now())
      union all
      select t.a_person_id, t.updated_at from orbit.ties t, since
       where t.user_id = ${userId}::uuid and t.updated_at > since.t
      union all
      select t.b_person_id, t.updated_at from orbit.ties t, since
       where t.user_id = ${userId}::uuid and t.updated_at > since.t
      union all
      select a.person_id, a.updated_at from orbit.affiliations a, since
       where a.user_id = ${userId}::uuid and a.updated_at > since.t
      union all
      select l.person_id, l.updated_at from orbit.tie_labels l, since
       where l.user_id = ${userId}::uuid and l.updated_at > since.t
      union all
      select unnest(n.person_ids), n.updated_at from orbit.notes n, since
       where n.user_id = ${userId}::uuid and n.updated_at > since.t
      union all
      select i.person_id, i.created_at from orbit.person_identities i, since
       where i.user_id = ${userId}::uuid and i.created_at > since.t
      -- plan 43: texts a signed-in student's browser sent, and accounts attached to people
      union all
      select d.person_id, d.updated_at from orbit.text_days d, since
       where d.user_id = ${userId}::uuid and d.updated_at > since.t
      union all
      select l.person_id, l.updated_at from orbit.social_links l, since
       where l.user_id = ${userId}::uuid and l.updated_at > since.t)
    select l.id from live l
     where l.scored_at is null or l.updated_at > l.scored_at
        or exists (select 1 from touched x where x.id = l.id and x.at > l.scored_at)
     order by l.id`;
  return rows.map((r) => r.id);
}
