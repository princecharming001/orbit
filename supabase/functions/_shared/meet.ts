/**
 * Google Meet transcripts (Meet REST API v2), read with Orbit's own Google sign-in: no new keys. The permission
 * (meetings.space.readonly) is asked incrementally, only when the student turns Meet on, the way calendar.events is
 * asked the first time they book a call.
 *
 * For a coffee chat with a Meet link: the conference records of that meeting code around the chat's time, then the
 * record's transcripts and their entries, with each participant's name. A transcript exists only when the student's
 * Google Workspace plan allows transcription and it was turned on in the call; a personal Gmail account never has
 * one. "Nothing recorded" is an ordinary answer, never an error.
 */
import {
  type CallEventRef,
  type CallNote,
  type MeetEntry,
  matchCallToEvent,
  meetCodeFromUrl,
  meetEntriesToText,
  meetParticipantName,
} from '@orbit/core/notes/callNotes';
import { randomToken } from './crypto.ts';
import type { Db } from './db.ts';
import { authUrl, type GoogleConfig, pkcePair, type TokenSource } from './google.ts';

export const MEET_API = 'https://meet.googleapis.com/v2';
/** Asked incrementally when the student turns Google Meet on. */
export const MEET_SCOPE = 'https://www.googleapis.com/auth/meetings.space.readonly';

const STATE_TTL_MS = 10 * 60_000;
/** Pages of transcript entries read for one call (100 entries a page). */
const MAX_ENTRY_PAGES = 10;

/** Google said the permission is missing (403): Meet must be allowed again. */
export class MeetNeedsConsent extends Error {
  constructor() {
    super('meet_needs_consent');
  }
}

export const hasMeetScope = (scopes: string[] | null | undefined) => !!scopes?.includes(MEET_SCOPE);

/** Google's consent screen for the Meet permission only, on top of what the student already allowed. */
export async function meetConsentUrl(
  db: Db,
  google: Pick<GoogleConfig, 'clientId' | 'redirectUri'>,
  userId: string,
  appUrl: string,
  now: Date,
): Promise<string> {
  const [u] = await db.sql<{ email: string }>`select email from orbit.users where id = ${userId}::uuid`;
  const state = randomToken(32);
  const { verifier, challenge } = await pkcePair();
  const scopes = ['openid', 'email', MEET_SCOPE];
  await db.sql`
    insert into orbit.oauth_states (state, code_verifier, redirect_to, user_id, scopes, created_at, expires_at)
    values (${state}, ${verifier}, ${appUrl}, ${userId}::uuid, ${scopes}::text[], ${now}::timestamptz,
            ${new Date(now.getTime() + STATE_TTL_MS)}::timestamptz)`;
  return authUrl(google, { state, challenge, scopes, loginHint: u?.email });
}

async function meetGet(
  tokens: TokenSource,
  userId: string,
  url: string,
  f: typeof fetch,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await tokens.accessToken(userId);
    const res = await f(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 && attempt === 0) {
      tokens.invalidate(userId);
      await res.body?.cancel();
      continue;
    }
    if (res.status === 403) {
      await res.body?.cancel();
      throw new MeetNeedsConsent();
    }
    // a record or transcript that is gone, or nothing to list: an empty answer
    if (res.status === 404) {
      await res.body?.cancel();
      return {};
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`meet ${res.status}`);
    }
    return ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  }
  throw new Error('meet 401');
}

interface ConferenceRecord {
  name?: string;
  startTime?: string;
  endTime?: string;
}

interface Transcript {
  name?: string;
  state?: string;
  docsDestination?: { document?: string; exportUri?: string };
}

const iso = (t: number) => new Date(t).toISOString();

/**
 * Notes from Google Meet for these coffee chats: the conference record of the event's meeting code (or, with no code,
 * the one held at that time), its transcript as speaker-labelled text and a link to the transcript document. An event
 * with no transcript is in `none`.
 */
export async function meetNotesFor(
  tokens: TokenSource,
  userId: string,
  events: CallEventRef[],
  f: typeof fetch = fetch,
): Promise<{ notes: CallNote[]; none: string[] }> {
  const notes: CallNote[] = [];
  const none: string[] = [];
  for (const ev of events) {
    const code = meetCodeFromUrl(ev.conferenceUrl);
    const start = Date.parse(ev.startAt);
    const end = Date.parse(ev.endAt);
    const window = [
      `start_time>="${iso(start - 2 * 3_600_000)}"`,
      `start_time<="${iso(Math.max(end, start) + 2 * 3_600_000)}"`,
    ];
    const filter = [...(code ? [`space.meeting_code="${code}"`] : []), ...window].join(' AND ');
    const listed = await meetGet(
      tokens,
      userId,
      `${MEET_API}/conferenceRecords?${new URLSearchParams({ filter, pageSize: '25' })}`,
      f,
    );
    const records = ((listed.conferenceRecords as ConferenceRecord[] | undefined) ?? []).map((r) => ({
      ...r,
      joinId: code,
      startAt: r.startTime,
    }));
    const rec = matchCallToEvent(records, ev, 'google_meet');
    if (!rec?.name) {
      none.push(ev.id);
      continue;
    }
    const t = await meetGet(tokens, userId, `${MEET_API}/${rec.name}/transcripts`, f);
    const transcript = ((t.transcripts as Transcript[] | undefined) ?? []).find(
      (x) => x.name && x.state !== 'STARTED',
    );
    if (!transcript?.name) {
      none.push(ev.id);
      continue;
    }
    const entries: MeetEntry[] = [];
    let pageToken = '';
    for (let page = 0; page < MAX_ENTRY_PAGES; page++) {
      const q = new URLSearchParams({ pageSize: '100' });
      if (pageToken) q.set('pageToken', pageToken);
      const r = await meetGet(tokens, userId, `${MEET_API}/${transcript.name}/entries?${q}`, f);
      entries.push(...((r.transcriptEntries as MeetEntry[] | undefined) ?? []));
      pageToken = typeof r.nextPageToken === 'string' ? r.nextPageToken : '';
      if (!pageToken) break;
    }
    const names: Record<string, string> = {};
    let pToken = '';
    for (let page = 0; page < 3; page++) {
      const q = new URLSearchParams({ pageSize: '100' });
      if (pToken) q.set('pageToken', pToken);
      const r = await meetGet(tokens, userId, `${MEET_API}/${rec.name}/participants?${q}`, f);
      for (const p of (r.participants as Record<string, unknown>[] | undefined) ?? []) {
        const name = meetParticipantName(p);
        if (typeof p.name === 'string' && name) names[p.name] = name;
      }
      pToken = typeof r.nextPageToken === 'string' ? r.nextPageToken : '';
      if (!pToken) break;
    }
    const text = meetEntriesToText(entries, names);
    if (!text) {
      none.push(ev.id);
      continue;
    }
    notes.push({
      app: 'google_meet',
      eventId: ev.id,
      meetingId: rec.name,
      title: ev.title || 'Google Meet call',
      startAt: rec.startTime ?? ev.startAt,
      url: transcript.docsDestination?.exportUri,
      transcript: text,
    });
  }
  return { notes, none };
}
