/**
 * Free times for a call (§8.3): Google free/busy over the next ten business days starting 18 hours out, cut into
 * 30-minute slots between 9:00 and 17:30 in the user's time, never on a weekend or US federal holiday and never
 * touching another event, three on three different days, each labelled in the recipient's zone when known. When
 * Google cannot be asked, the calendar events Orbit has synced stand in for free/busy.
 *
 * Booking (§8.3, §14.6 rule 4) creates the event only on the user's request, with sendUpdates=all, and asks for the
 * calendar.events scope incrementally the first time.
 */
import type { BookResponse, Slot, SlotsResponse } from '@orbit/core/server/api';
import { addBusinessDays, usHolidays } from '@orbit/core/suggestions/calendar';
import { randomToken } from '../crypto.ts';
import type { Db } from '../db.ts';
import { authUrl, CALENDAR_EVENTS_SCOPE, NeedsReauth, pkcePair } from '../google.ts';
import { HttpError } from '../http.ts';
import { iso } from '../rows.ts';
import type { Services } from '../services.ts';
import { addDaysKey, localParts, validZone, weekdayOfKey, zoneAbbrev, zonedTime } from '../zones.ts';

export const SLOT_MINUTES = 30;
export const DAY_START = { hour: 9, minute: 0 };
/** the last slot ends at 17:30 */
export const DAY_END = { hour: 17, minute: 30 };
/** a slot must leave this much room before and after another event */
export const BUFFER_MIN = 15;
export const LEAD_HOURS = 18;
export const HORIZON_BUSINESS_DAYS = 10;

export const FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';
export const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export interface Busy {
  start: number;
  end: number;
}

/** "Tue, Oct 21, 10:00 to 10:30 ET" in `tz`: written out, since a dash reads as machine-written in a draft. */
export function slotLabel(start: Date, end: Date, tz: string): string {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(start);
  const hm = (d: Date) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(d);
  return `${day}, ${hm(start)} to ${hm(end)} ${zoneAbbrev(start, tz)}`;
}

/** The slots themselves, pure: the first free slot of each working day, until `count` days have one. */
export function pickSlots(
  busy: Busy[],
  opts: { now: Date; userTz: string; labelTz: string; count?: number; until?: Date },
): Slot[] {
  const count = opts.count ?? 3;
  const from = opts.now.getTime() + LEAD_HOURS * 3_600_000;
  const until = (opts.until ?? addBusinessDays(opts.now, HORIZON_BUSINESS_DAYS, opts.userTz)).getTime();
  const out: Slot[] = [];
  const buffer = BUFFER_MIN * 60_000;
  let key = localParts(new Date(from), opts.userTz).key;
  for (let i = 0; i < 31 && out.length < count; i++, key = addDaysKey(key, 1)) {
    const dow = weekdayOfKey(key);
    if (dow === 0 || dow === 6 || usHolidays(Number(key.slice(0, 4))).has(key)) continue;
    const dayStart = zonedTime(key, DAY_START.hour, DAY_START.minute, opts.userTz).getTime();
    const dayEnd = zonedTime(key, DAY_END.hour, DAY_END.minute, opts.userTz).getTime();
    if (dayStart > until) break;
    for (let s = dayStart; s + SLOT_MINUTES * 60_000 <= dayEnd; s += SLOT_MINUTES * 60_000) {
      const e = s + SLOT_MINUTES * 60_000;
      if (s < from || e > until) continue;
      if (busy.some((b) => s < b.end + buffer && e > b.start - buffer)) continue;
      out.push({
        start: new Date(s).toISOString(),
        end: new Date(e).toISOString(),
        label: slotLabel(new Date(s), new Date(e), opts.labelTz),
      });
      break;
    }
  }
  return out;
}

async function googleCall(
  s: Services,
  userId: string,
  url: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  if (!s.tokens) throw new HttpError(503, 'unconfigured', 'Google is not configured');
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await s.tokens.accessToken(userId);
    const res = await s.fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401 && attempt === 0) {
      s.tokens.invalidate(userId);
      await res.body?.cancel();
      continue;
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: res.status, json };
  }
  return { status: 401, json: {} };
}

/** Busy blocks from Google free/busy; throws when Google cannot be asked. */
export async function freeBusy(
  s: Services,
  userId: string,
  timeMin: Date,
  timeMax: Date,
  tz: string,
): Promise<Busy[]> {
  const r = await googleCall(s, userId, FREEBUSY_URL, {
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    timeZone: tz,
    items: [{ id: 'primary' }],
  });
  if (r.status !== 200) throw new HttpError(502, 'upstream', `calendar ${r.status}`);
  const cal = (r.json.calendars as Record<string, { busy?: { start: string; end: string }[] }> | undefined)
    ?.primary;
  return (cal?.busy ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
}

/** Busy blocks from the synced calendar (the fallback when Google cannot be asked). */
export async function storedBusy(db: Db, userId: string, from: Date, to: Date): Promise<Busy[]> {
  const rows = await db.sql<{ start_at: Date; end_at: Date | null }>`
    select start_at, end_at from orbit.calendar_events
     where user_id = ${userId}::uuid and coalesce(status, 'confirmed') <> 'cancelled'
       and start_at < ${to}::timestamptz and coalesce(end_at, start_at + interval '30 minutes') > ${from}::timestamptz`;
  return rows.map((r) => {
    const start = new Date(r.start_at).getTime();
    return { start, end: r.end_at ? new Date(r.end_at).getTime() : start + 30 * 60_000 };
  });
}

/** Three free slots, labelled in `tz` (else the person's zone, else the user's). */
export async function slotsFor(
  s: Services,
  userId: string,
  opts: { personId?: string; tz?: string; count?: number } = {},
): Promise<SlotsResponse & { source: 'google' | 'stored' }> {
  const [u] = await s.db.sql<{
    timezone: string;
  }>`select timezone from orbit.users where id = ${userId}::uuid`;
  const userTz = validZone(u?.timezone) ?? 'America/New_York';
  let personTz: string | undefined;
  if (opts.personId) {
    const [p] = await s.db.sql<{ timezone: string | null }>`
      select timezone from orbit.people where id = ${opts.personId}::uuid and user_id = ${userId}::uuid`;
    personTz = validZone(p?.timezone);
  }
  const labelTz = validZone(opts.tz) ?? personTz ?? userTz;
  const now = s.now();
  const timeMin = new Date(now.getTime() + LEAD_HOURS * 3_600_000);
  const timeMax = addBusinessDays(now, HORIZON_BUSINESS_DAYS, userTz);
  let busy: Busy[];
  let source: 'google' | 'stored' = 'google';
  try {
    busy = await freeBusy(s, userId, timeMin, timeMax, userTz);
  } catch (e) {
    if (!(e instanceof NeedsReauth) && !(e instanceof HttpError)) throw e;
    busy = await storedBusy(s.db, userId, timeMin, timeMax);
    source = 'stored';
  }
  const count = Math.max(1, Math.min(5, opts.count ?? 3));
  return { slots: pickSlots(busy, { now, userTz, labelTz, count, until: timeMax }), tz: labelTz, source };
}

// ---- booking ---------------------------------------------------------------------------------------------------

const STATE_TTL_MS = 10 * 60_000;

/** The incremental-consent URL for calendar.events, with an oauth_states row that names the user. */
export async function calendarConsentUrl(s: Services, userId: string, appUrl: string): Promise<string> {
  if (!s.google) throw new HttpError(503, 'unconfigured', 'Google is not configured');
  const [u] = await s.db.sql<{ email: string }>`select email from orbit.users where id = ${userId}::uuid`;
  const state = randomToken(32);
  const { verifier, challenge } = await pkcePair();
  const now = s.now();
  const scopes = ['openid', 'email', CALENDAR_EVENTS_SCOPE];
  await s.db.sql`
    insert into orbit.oauth_states (state, code_verifier, redirect_to, user_id, scopes, created_at, expires_at)
    values (${state}, ${verifier}, ${appUrl}, ${userId}::uuid, ${scopes}::text[], ${now}::timestamptz,
            ${new Date(now.getTime() + STATE_TTL_MS)}::timestamptz)`;
  return authUrl(s.google, { state, challenge, scopes, loginHint: u?.email });
}

export async function bookSlot(
  s: Services,
  userId: string,
  req: { draftId: string; slotStart: string },
  appUrl: string,
): Promise<BookResponse> {
  const [d] = await s.db.sql<{ id: string; person_id: string; chat_id: string | null }>`
    select id, person_id, chat_id from orbit.drafts where id = ${req.draftId}::uuid and user_id = ${userId}::uuid`;
  if (!d) throw new HttpError(404, 'not_found', 'no such draft');
  const start = new Date(req.slotStart);
  if (Number.isNaN(start.getTime())) throw new HttpError(400, 'bad_request', 'slotStart must be an ISO time');
  if (start.getTime() <= s.now().getTime()) throw new HttpError(409, 'slot_past', 'that time has passed');
  const end = new Date(start.getTime() + SLOT_MINUTES * 60_000);

  const [acct] = await s.db.sql<{ scopes: string[]; status: string }>`
    select scopes, status from orbit.integration_accounts where user_id = ${userId}::uuid and provider = 'google'`;
  if (!acct?.scopes.some((x) => x.endsWith('calendar.events')))
    return { needsConsent: { url: await calendarConsentUrl(s, userId, appUrl) } };

  const [p] = await s.db.sql<{
    display_name: string;
    first_name: string | null;
    primary_email: string | null;
  }>`
    select display_name, first_name, primary_email from orbit.people where id = ${d.person_id}::uuid`;
  const [u] = await s.db.sql<{ first_name: string | null; full_name: string | null; timezone: string }>`
    select first_name, full_name, timezone from orbit.users where id = ${userId}::uuid`;
  if (!p?.primary_email) throw new HttpError(409, 'no_email', 'this person has no email address to invite');
  const tz = validZone(u?.timezone) ?? 'America/New_York';
  const mine = u?.first_name ?? u?.full_name?.split(/\s+/)[0] ?? 'Me';
  const theirs = p.first_name ?? p.display_name.split(/\s+/)[0];
  const title = `${mine} / ${theirs}`;
  let r: { status: number; json: Record<string, unknown> };
  try {
    r = await googleCall(s, userId, `${EVENTS_URL}?sendUpdates=all`, {
      summary: title,
      start: { dateTime: start.toISOString(), timeZone: tz },
      end: { dateTime: end.toISOString(), timeZone: tz },
      attendees: [{ email: p.primary_email }],
    });
  } catch (e) {
    if (e instanceof NeedsReauth) throw new HttpError(409, 'needs_reauth', 'reconnect Google to book');
    throw e;
  }
  if (r.status === 403) return { needsConsent: { url: await calendarConsentUrl(s, userId, appUrl) } };
  if (r.status !== 200 || typeof r.json.id !== 'string')
    throw new HttpError(502, 'upstream', `calendar ${r.status}`);
  const eventId = r.json.id;
  await s.db.sql`
    insert into orbit.calendar_events (user_id, external_id, title, start_at, end_at, status, attendees,
                                       attendee_person_ids, attendee_count, is_one_on_one, chat_id)
    values (${userId}::uuid, ${eventId}, ${title}, ${start}::timestamptz, ${end}::timestamptz, 'confirmed',
            ${JSON.stringify([{ email: p.primary_email }])}::jsonb, ${[d.person_id]}::uuid[], 2, true,
            ${d.chat_id}::uuid)
    on conflict (user_id, external_id) do nothing`;
  await s.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'user', 'calendar.book', 'drafts', ${d.id}, ${{ start: iso(start) }}::jsonb)`;
  if (d.chat_id) await moveChat(s.db, userId, d.chat_id, 'scheduled', 'call booked', s.now());
  return { eventId };
}

/** Moves a chat to `to` with an applied stage event (no-op when it is already there). */
export async function moveChat(
  db: Db,
  userId: string,
  chatId: string,
  to: string,
  reason: string,
  now: Date,
  actor: 'user' | 'system' = 'system',
): Promise<void> {
  const [c] = await db.sql<{ stage: string }>`
    select stage from orbit.chats where id = ${chatId}::uuid and user_id = ${userId}::uuid`;
  if (!c || c.stage === to) return;
  await db.sql`
    update orbit.chats set stage = ${to}, stage_entered_at = ${now}::timestamptz
     where id = ${chatId}::uuid and user_id = ${userId}::uuid`;
  await db.sql`
    insert into orbit.stage_events (user_id, chat_id, from_stage, to_stage, status, actor, reason, decided_at)
    values (${userId}::uuid, ${chatId}::uuid, ${c.stage}, ${to}, 'applied', ${actor}, ${reason}, ${now}::timestamptz)`;
}
