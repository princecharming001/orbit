/**
 * Calendar events into orbit.calendar_events (§12.3), mirroring the browser's ingestEvents with SQL writes. Rooms
 * (resource attendees) are dropped; attendees of events with at most 8 people become people (resolved in one batch);
 * on bigger events only people already known are linked. Declined attendees are kept in `attendees` but not in
 * `attendee_person_ids`, and an organizer who is not an attendee (an assistant scheduling for someone) is never
 * linked. A cancelled event keeps its row with status cancelled. A booked meeting with the target of an open intro
 * request moves the request to `meeting` (§4.3). Rows are only rewritten when something changed.
 */
import { normalizeEmail } from '@orbit/core/text/normalize';
import type { CalendarApiEvent } from '../calendar.ts';
import type { Db } from '../db.ts';
import type { Queue } from '../queue.ts';
import { type Incoming, resolvePeople } from './people.ts';
import { loadSelf } from './util.ts';

export const MEETING_MAX = 8;

export interface EventIngestDeps {
  db: Db;
  queue: Queue;
  userId: string;
  now: Date;
  jobKey: string;
}

function when(t: { dateTime?: string; date?: string } | undefined): string | undefined {
  if (!t) return undefined;
  const raw = t.dateTime ?? (t.date ? `${t.date}T00:00:00Z` : undefined);
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function conference(e: CalendarApiEvent): string | null {
  if (e.hangoutLink) return e.hangoutLink;
  return e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ?? null;
}

export async function ingestEvents(
  d: EventIngestDeps,
  events: CalendarApiEvent[],
): Promise<{ stored: number; cancelled: number; people: number }> {
  const { db, userId } = d;
  const out = { stored: 0, cancelled: 0, people: 0 };
  if (!events.length) return out;
  const self = await loadSelf(db, userId);
  const isSelf = (a: { email?: string; self?: boolean }) =>
    !!a.self || (!!a.email && self.emails.has(normalizeEmail(a.email)));

  const live: (CalendarApiEvent & { startAt: string; endAt: string })[] = [];
  for (const e of events) {
    if (e.status === 'cancelled') {
      const rows = await db.sql`
        update orbit.calendar_events set status = 'cancelled'
         where user_id = ${userId}::uuid and external_id = ${e.id} and status is distinct from 'cancelled'
        returning id`;
      out.cancelled += rows.length;
      continue;
    }
    const startAt = when(e.start);
    if (!startAt) continue;
    live.push({ ...e, startAt, endAt: when(e.end) ?? startAt });
  }

  const items: Incoming[] = [];
  const lookupOnly: Incoming[] = [];
  for (const e of live) {
    const people = (e.attendees ?? []).filter((a) => !a.resource && a.email);
    const small = people.length <= MEETING_MAX;
    for (const a of people) {
      if (isSelf(a)) continue;
      const item: Incoming = {
        key: normalizeEmail(a.email!),
        email: a.email,
        name: a.displayName,
        source: 'calendar',
        seenAt: e.startAt,
      };
      (small ? items : lookupOnly).push(item);
    }
  }
  const created = await resolvePeople(db, userId, items, { now: d.now });
  const known = await resolvePeople(db, userId, lookupOnly, { now: d.now, create: false });
  out.people = created.created.size;
  const personOf = (email: string) => created.byKey.get(email) ?? known.byKey.get(email);

  const touched = new Set<string>();
  for (const e of live) {
    const attendees = (e.attendees ?? [])
      .filter((a) => !a.resource && a.email)
      .map((a) => ({
        email: normalizeEmail(a.email!),
        displayName: a.displayName ?? null,
        responseStatus: a.responseStatus ?? null,
        self: isSelf(a),
      }));
    const going = attendees.filter((a) => a.responseStatus !== 'declined');
    const pids = [
      ...new Set(
        going
          .filter((a) => !a.self)
          .map((a) => personOf(a.email))
          .filter((x): x is string => !!x),
      ),
    ];
    const status = e.status === 'tentative' ? 'tentative' : 'confirmed';
    const [row] = await db.sql<{ id: string }>`
      insert into orbit.calendar_events (user_id, external_id, title, description, start_at, end_at, status,
                                         organizer_email, attendees, attendee_person_ids, attendee_count,
                                         conference_url, is_one_on_one)
      values (${userId}::uuid, ${e.id}, ${e.summary ?? null}, ${e.description ?? null}, ${e.startAt}::timestamptz,
              ${e.endAt}::timestamptz, ${status}, ${e.organizer?.email ? normalizeEmail(e.organizer.email) : null},
              ${attendees}::jsonb, ${pids}::uuid[], ${attendees.length}::int, ${conference(e)},
              ${going.length === 2 && going.some((a) => a.self)})
      on conflict (user_id, external_id) do update set
        title = excluded.title, description = excluded.description, start_at = excluded.start_at,
        end_at = excluded.end_at, status = excluded.status, organizer_email = excluded.organizer_email,
        attendees = excluded.attendees, attendee_person_ids = excluded.attendee_person_ids,
        attendee_count = excluded.attendee_count, conference_url = excluded.conference_url,
        is_one_on_one = excluded.is_one_on_one
      where (orbit.calendar_events.title, orbit.calendar_events.description, orbit.calendar_events.start_at,
             orbit.calendar_events.end_at, orbit.calendar_events.status, orbit.calendar_events.attendees,
             orbit.calendar_events.attendee_person_ids, orbit.calendar_events.conference_url)
        is distinct from
            (excluded.title, excluded.description, excluded.start_at, excluded.end_at, excluded.status,
             excluded.attendees, excluded.attendee_person_ids, excluded.conference_url)
      returning id`;
    if (!row) continue;
    out.stored++;
    for (const p of pids) touched.add(p);
    if (pids.length)
      await db.sql`
        update orbit.intro_requests set status = 'meeting', outcome_at = ${e.startAt}::timestamptz
         where user_id = ${userId}::uuid and target_person_id = any(${pids}::uuid[])
           and status in ('asked', 'agreed', 'intro_made') and asked_at <= ${e.startAt}::timestamptz`;
  }
  if (touched.size)
    await d.queue.enqueue({
      kind: 'score.person',
      userId,
      payload: { personIds: [...touched] },
      dedupeKey: `score.person:${userId}:${d.jobKey}`,
    });
  return out;
}
