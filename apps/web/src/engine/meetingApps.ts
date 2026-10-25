/**
 * Granola, Fireflies and Wispr Flow: the student's meeting notetaker, if it is not Fathom. Each recorded meeting is
 * filed as a note on the people who were in it, the same way Fathom's are (see fathom.ts), so what they said, offered
 * and asked lands on their page.
 *
 * - Granola and Wispr Flow connect by signing in: their meeting servers (MCP) let Orbit register itself, so nothing
 *   has to be set up first and every plan works (Granola's free plan reaches the last 30 days). Calls go through
 *   Orbit's orbit-notes function, which only reads meetings.
 * - Fireflies connects with the student's API key, called straight from this browser.
 *
 * The student picks one meeting app: turning one on turns the others off (meetingAppSwitch.ts). Tokens and keys stay
 * in this browser on the app's integration row. The sample student gets the demo's made-up meetings instead.
 */
import type { NoteSource, User } from '@orbit/core';
import { newId } from '@orbit/core';
import { db, type IntegrationAccount } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { type FathomMeeting, mcpCall, notesAppsAvailable } from '../integrations/notesApps';
import { endActivity, startActivity } from './activity';
import { appAuth, signInToApp } from './appSignIn';
import { demoMeetings, importMeetings, meetingSeen } from './fathom';
import { isMeetingAppOn, keepOnlyMeetingApp } from './meetingAppSwitch';

export type MeetingApp = 'granola' | 'fireflies' | 'wispr';

export const MEETING_APP_META: Record<
  MeetingApp,
  { name: string; source: NoteSource; logo: string; connect: 'sign_in' | 'key'; backfillDays: number }
> = {
  // Granola's free plan only reaches back 30 days
  granola: {
    name: 'Granola',
    source: 'granola_api',
    logo: 'granola.ai',
    connect: 'sign_in',
    backfillDays: 30,
  },
  fireflies: {
    name: 'Fireflies',
    source: 'fireflies',
    logo: 'fireflies.ai',
    connect: 'key',
    backfillDays: 60,
  },
  wispr: {
    name: 'Wispr Flow',
    source: 'wispr_notetaker',
    logo: 'wisprflow.ai',
    connect: 'sign_in',
    backfillDays: 60,
  },
};

export const FIREFLIES_URL = 'https://api.fireflies.ai/graphql';
export const FIREFLIES_KEY_URL = 'https://app.fireflies.ai/settings#DeveloperSettings';
/** At most this many meetings per import, so a long history never runs away. */
const MAX_MEETINGS = 100;
/** A sync older than this is redone when the app opens. */
export const MEETING_AUTO_SYNC_MS = 12 * 60 * 60 * 1000;

export type MeetingAppResult =
  | { ok: true; imported: number; skipped: number; switchedOff?: string[] }
  | { ok: false; reason: 'bad_key' | 'unavailable' | 'not_connected' | 'error'; message: string };

type Fetched = { ok: true; meetings: FathomMeeting[] } | { ok: false; badKey: boolean; message: string };

export async function meetingAppAccount(
  userId: string,
  app: MeetingApp,
): Promise<IntegrationAccount | undefined> {
  return db.integrations
    .where('userId')
    .equals(userId)
    .filter((i) => i.provider === app)
    .first();
}

export function meetingAppAvailable(user: Pick<User, 'id'>): boolean {
  return usesMockConnectors(user.id) || notesAppsAvailable();
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined;

const isoOf = (v: unknown): string | undefined => {
  if (typeof v === 'number') return new Date(v).toISOString();
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};

// ---------------------------------------------------------------- Granola

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** "John Doe (note creator) from Acme <john@acme.com>": the name, the address, and whether they took the notes. */
export function parseGranolaParticipant(
  line: string,
): { name?: string; email?: string; creator: boolean } | undefined {
  const t = decode(line).trim();
  if (!t) return undefined;
  const email = t.match(/<([^<>\s]+@[^<>\s]+)>\s*$/)?.[1];
  const rest = t.replace(/<[^<>]*>\s*$/, '').trim();
  const creator = /\(note creator\)/i.test(rest);
  const name = rest
    .replace(/\(note creator\)/i, '')
    .replace(/\s+from\s+.+$/, '')
    .trim();
  return name || email ? { name: name || undefined, email, creator } : undefined;
}

/**
 * Granola's meeting server answers in tagged text: `<meeting id title date>` with its `<known_participants>`, and
 * (from get_meetings) its `<summary>` and the student's own notes.
 */
export function parseGranolaMeetings(text: string | undefined): FathomMeeting[] {
  if (!text) return [];
  const out: FathomMeeting[] = [];
  for (const m of text.matchAll(/<meeting\b([^>]*)>([\s\S]*?)<\/meeting>/g)) {
    const attrs = Object.fromEntries(
      [...m[1]!.matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], decode(a[2]!)]),
    );
    const body = m[2] ?? '';
    const id = attrs.id;
    if (!id) continue;
    const tag = (name: string) => body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();
    const people = (tag('known_participants') ?? '')
      .split('\n')
      .map(parseGranolaParticipant)
      .filter((p): p is NonNullable<typeof p> => !!p);
    const summary = tag('summary') ?? tag('enhanced_notes') ?? tag('notes');
    const mine = tag('private_notes');
    out.push({
      id,
      title: attrs.title || 'Meeting',
      url: `https://notes.granola.ai/d/${encodeURIComponent(id)}`,
      startAt: isoOf(attrs.date),
      invitees: people.map((p) => ({ name: p.name, email: p.email })),
      recordedBy: people.find((p) => p.creator)?.email,
      summary:
        [summary && decode(summary), mine && `My notes:\n${decode(mine)}`].filter(Boolean).join('\n\n') ||
        undefined,
      actionItems: [],
    });
  }
  return out;
}

async function granolaMeetings(
  token: string,
  since: Date,
  now: Date,
  source: NoteSource,
  signal?: AbortSignal,
): Promise<Fetched> {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const listArgs = [
    { time_range: 'custom', custom_start: day(since), custom_end: day(new Date(now.getTime() + 86_400_000)) },
    // a free plan that will not take a custom range still answers for the last 30 days
    { time_range: 'last_30_days' },
  ];
  let listed: FathomMeeting[] | undefined;
  for (const args of listArgs) {
    const r = await mcpCall('granola', token, [{ name: 'list_meetings', arguments: args }], { signal });
    if (!r.ok) return { ok: false, badKey: r.reason === 'bad_key', message: r.message };
    const res = r.value.results[0];
    if (res?.ok) {
      listed = parseGranolaMeetings(res.text);
      break;
    }
  }
  if (!listed) return { ok: false, badKey: false, message: 'Granola would not list your meetings.' };
  const fresh: FathomMeeting[] = [];
  for (const m of listed) if (!(await meetingSeen(source, m))) fresh.push(m);
  const ids = fresh.slice(0, MAX_MEETINGS).map((m) => m.id);
  if (!ids.length) return { ok: true, meetings: [] };
  // ten meetings a call, ten calls a trip
  const calls = [];
  for (let i = 0; i < ids.length; i += 10)
    calls.push({ name: 'get_meetings', arguments: { meeting_ids: ids.slice(i, i + 10) } });
  const d = await mcpCall('granola', token, calls, { signal });
  if (!d.ok) return { ok: false, badKey: d.reason === 'bad_key', message: d.message };
  const details = new Map(d.value.results.flatMap((x) => parseGranolaMeetings(x.text)).map((m) => [m.id, m]));
  return {
    ok: true,
    meetings: fresh
      .filter((m) => ids.includes(m.id))
      .map((m) => {
        const full = details.get(m.id);
        return full ? { ...m, ...full, invitees: full.invitees.length ? full.invitees : m.invitees } : m;
      }),
  };
}

// ---------------------------------------------------------------- Wispr Flow

/** A tool's answer as data: its structured result, else its text read as JSON. */
function asData(r: { text?: string; structured?: unknown } | undefined): unknown {
  if (!r) return undefined;
  if (r.structured !== undefined) return r.structured;
  if (!r.text) return undefined;
  try {
    return JSON.parse(r.text) as unknown;
  } catch {
    return undefined;
  }
}

const listIn = (d: unknown): Record<string, unknown>[] => {
  const o = d as Record<string, unknown> | undefined;
  const arr = Array.isArray(d)
    ? d
    : [o?.meetings, o?.results, o?.items, o?.data].find((x): x is unknown[] => Array.isArray(x));
  return (arr ?? []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
};

const peopleIn = (v: unknown): { name?: string; email?: string }[] =>
  (Array.isArray(v) ? v : [])
    .map((a) =>
      typeof a === 'string'
        ? a.includes('@')
          ? { email: a }
          : { name: a }
        : a && typeof a === 'object'
          ? {
              name:
                str((a as Record<string, unknown>).name) ?? str((a as Record<string, unknown>).display_name),
              email:
                str((a as Record<string, unknown>).email) ??
                (Array.isArray((a as Record<string, unknown>).emails)
                  ? str(((a as Record<string, unknown>).emails as unknown[])[0])
                  : undefined),
            }
          : {},
    )
    .filter((a) => a.name || a.email);

/** One meeting from Wispr Flow's meeting server, from a search result or a full read. */
export function mapWisprMeeting(o: Record<string, unknown>): FathomMeeting | undefined {
  const id = str(o.meeting_id) ?? str(o.id);
  if (!id) return undefined;
  const summary = str(o.summary) ?? str((o.summary as { markdown?: unknown } | undefined)?.markdown);
  const notes = str(o.content) ?? str(o.notes);
  return {
    id,
    title: str(o.title) ?? str(o.name) ?? 'Meeting',
    url: str(o.share_link) ?? str(o.url),
    startAt: isoOf(o.start_time ?? o.started_at ?? o.start ?? o.startTime ?? o.created_at),
    invitees: peopleIn(o.attendees ?? o.participants),
    summary:
      [summary, notes && notes !== summary ? `Notes:\n${notes}` : undefined].filter(Boolean).join('\n\n') ||
      undefined,
    actionItems: [],
  };
}

async function wisprMeetings(
  token: string,
  since: Date,
  source: NoteSource,
  signal?: AbortSignal,
): Promise<Fetched> {
  const listed: FathomMeeting[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5 && listed.length < MAX_MEETINGS; page++) {
    const args: Record<string, unknown> = { since: since.toISOString() };
    if (cursor) args.cursor = cursor;
    const r = await mcpCall('wispr', token, [{ name: 'search_meetings', arguments: args }], { signal });
    if (!r.ok) return { ok: false, badKey: r.reason === 'bad_key', message: r.message };
    const res = r.value.results[0];
    if (!res?.ok) return { ok: false, badKey: false, message: 'Wispr Flow would not list your meetings.' };
    const data = asData(res);
    listed.push(
      ...listIn(data)
        .map(mapWisprMeeting)
        .filter((m): m is FathomMeeting => !!m),
    );
    const o = data as { has_more?: unknown; next_cursor?: unknown } | undefined;
    cursor = o?.has_more === true ? str(o.next_cursor) : undefined;
    if (!cursor) break;
  }
  const fresh: FathomMeeting[] = [];
  for (const m of listed) if (!(await meetingSeen(source, m))) fresh.push(m);
  const pick = fresh.slice(0, MAX_MEETINGS);
  const out: FathomMeeting[] = [];
  for (let i = 0; i < pick.length; i += 10) {
    const batch = pick.slice(i, i + 10);
    const d = await mcpCall(
      'wispr',
      token,
      batch.map((m) => ({ name: 'get_meeting', arguments: { meeting_id: m.id } })),
      { signal },
    );
    if (!d.ok) return { ok: false, badKey: d.reason === 'bad_key', message: d.message };
    batch.forEach((m, j) => {
      const res = d.value.results[j];
      const data = asData(res);
      const full =
        data && typeof data === 'object' && !Array.isArray(data)
          ? mapWisprMeeting({ meeting_id: m.id, ...(data as Record<string, unknown>) })
          : undefined;
      out.push({
        ...m,
        ...(full ?? {}),
        // the full read lists names only; the search result can carry addresses, which match people best
        invitees: m.invitees.some((a) => a.email) || !full?.invitees.length ? m.invitees : full.invitees,
        summary: full?.summary ?? (res?.ok && !data ? res.text : undefined) ?? m.summary,
      });
    });
  }
  return { ok: true, meetings: out };
}

// ---------------------------------------------------------------- Fireflies

/** Fireflies' action items: lines, grouped under the bolded name of whoever owns them. */
export function parseFirefliesActions(text: string | undefined): FathomMeeting['actionItems'] {
  const out: FathomMeeting['actionItems'] = [];
  let owner: string | undefined;
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const head = line.match(/^\*\*(.+?)\*\*:?$/);
    if (head) {
      owner = head[1]!.trim();
      continue;
    }
    const t = line
      .replace(/^[-*•]\s*/, '')
      .replace(/\s*\(\d{1,2}:\d{2}(?::\d{2})?\)\s*$/, '')
      .trim();
    if (t) out.push({ text: t, done: false, assignee: owner });
  }
  return out;
}

/** One Fireflies transcript as a meeting. */
export function mapFirefliesTranscript(t: Record<string, unknown>): FathomMeeting | undefined {
  const id = str(t.id);
  if (!id) return undefined;
  const s = (t.summary ?? {}) as { overview?: unknown; shorthand_bullet?: unknown; action_items?: unknown };
  const attendees = peopleIn(
    (Array.isArray(t.meeting_attendees) ? t.meeting_attendees : []).map((a) => ({
      name: str((a as Record<string, unknown>)?.displayName) ?? str((a as Record<string, unknown>)?.name),
      email: str((a as Record<string, unknown>)?.email),
    })),
  );
  // guests without a calendar entry are only listed by address
  for (const e of Array.isArray(t.participants) ? t.participants : [])
    for (const addr of String(e).split(/[,\s]+/))
      if (addr.includes('@') && !attendees.some((a) => a.email?.toLowerCase() === addr.toLowerCase()))
        attendees.push({ email: addr });
  return {
    id,
    title: str(t.title) ?? 'Meeting',
    url: str(t.transcript_url),
    startAt: isoOf(t.date),
    invitees: attendees,
    recordedBy: str(t.organizer_email),
    summary: [str(s.overview), str(s.shorthand_bullet)].filter(Boolean).join('\n\n') || undefined,
    actionItems: parseFirefliesActions(str(s.action_items)),
  };
}

async function firefliesMeetings(
  key: string,
  since: Date,
  source: NoteSource,
  opts: { signal?: AbortSignal; limit?: number } = {},
): Promise<Fetched> {
  const out: FathomMeeting[] = [];
  const pageSize = Math.min(50, opts.limit ?? 50);
  for (let skip = 0; skip < MAX_MEETINGS; skip += pageSize) {
    // the date and numbers are written into the query, so no variable types have to match Fireflies' schema
    const query = `{ transcripts(fromDate: "${since.toISOString()}", limit: ${pageSize}, skip: ${skip}) { id title date transcript_url organizer_email participants meeting_attendees { displayName email name } summary { overview shorthand_bullet action_items } } }`;
    let res: Response;
    try {
      res = await fetch(FIREFLIES_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ query }),
        signal: opts.signal,
      });
    } catch {
      return { ok: false, badKey: false, message: 'Could not reach Fireflies. Try again.' };
    }
    const j = (await res.json().catch(() => ({}))) as {
      data?: { transcripts?: unknown[] };
      errors?: { code?: string; message?: string; extensions?: { code?: string } }[];
    };
    const err = j.errors?.[0];
    if (
      res.status === 401 ||
      res.status === 403 ||
      err?.code === 'auth_failed' ||
      err?.extensions?.code === 'auth_failed'
    )
      return { ok: false, badKey: true, message: 'Fireflies did not accept that API key.' };
    if (err || !res.ok)
      return {
        ok: false,
        badKey: false,
        message: `Fireflies said no: ${err?.message ?? `error ${res.status}`}`.slice(0, 200),
      };
    const page = (j.data?.transcripts ?? [])
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
      .map(mapFirefliesTranscript)
      .filter((m): m is FathomMeeting => !!m);
    for (const m of page) if (!(await meetingSeen(source, m))) out.push(m);
    if (page.length < pageSize || opts.limit) break;
  }
  return { ok: true, meetings: out };
}

// ---------------------------------------------------------------- connecting and importing

async function saveRow(
  user: User,
  app: MeetingApp,
  patch: Partial<IntegrationAccount>,
  now: Date,
): Promise<IntegrationAccount> {
  const existing = await meetingAppAccount(user.id, app);
  const row: IntegrationAccount = {
    scopes: [],
    syncState: {},
    ...existing,
    id: existing?.id ?? newId('int'),
    userId: user.id,
    provider: app,
    status: 'active',
    connectedAt: existing && existing.status !== 'revoked' ? existing.connectedAt : now.toISOString(),
    ...patch,
  };
  await db.integrations.put(row);
  return row;
}

/** Bring in recorded meetings since the last import (the first time, the last month or two). */
export async function syncMeetingApp(
  user: User,
  app: MeetingApp,
  opts: { now?: Date; signal?: AbortSignal; since?: string } = {},
): Promise<MeetingAppResult> {
  startActivity(`notes:${app}`, `Checking ${MEETING_APP_META[app].name} for notes`);
  try {
    return await syncMeetingAppOnce(user, app, opts);
  } finally {
    endActivity(`notes:${app}`);
  }
}

async function syncMeetingAppOnce(
  user: User,
  app: MeetingApp,
  opts: { now?: Date; signal?: AbortSignal; since?: string },
): Promise<MeetingAppResult> {
  const now = opts.now ?? new Date();
  const meta = MEETING_APP_META[app];
  const row = await meetingAppAccount(user.id, app);
  if (!isMeetingAppOn(row))
    return { ok: false, reason: 'not_connected', message: `${meta.name} is not connected.` };
  const state = row.syncState as { since?: string; meetings?: number };
  let meetings: FathomMeeting[];
  if (row.externalAccountId === 'demo') meetings = await demoMeetings(user);
  else {
    // the notes check after a chat asks from the meeting's start only
    const since = new Date(opts.since ?? state.since ?? now.getTime() - meta.backfillDays * 86_400_000);
    // a pasted key is used as it is; a sign-in is renewed when it is about to run out
    const auth = app === 'fireflies' ? row.accessToken : await appAuth(app, row).catch(() => undefined);
    const token = typeof auth === 'string' ? auth : auth?.accessToken;
    if (!token) return { ok: false, reason: 'bad_key', message: `${meta.name} needs you to connect again.` };
    const got =
      app === 'granola'
        ? await granolaMeetings(token, since, now, meta.source, opts.signal)
        : app === 'wispr'
          ? await wisprMeetings(token, since, meta.source, opts.signal)
          : await firefliesMeetings(token, since, meta.source, { signal: opts.signal });
    if (!got.ok) {
      await db.integrations.update(row.id, {
        status: got.badKey ? 'needs_reauth' : 'error',
        lastError: got.message,
      });
      return { ok: false, reason: got.badKey ? 'bad_key' : 'error', message: got.message };
    }
    meetings = got.meetings;
  }
  const { imported, skipped } = await importMeetings(user, meetings, now, meta.source);
  const newest = meetings
    .map((m) => m.startAt)
    .filter((s): s is string => !!s)
    .sort()
    .at(-1);
  await db.integrations.update(row.id, {
    status: 'active',
    lastError: undefined,
    lastSyncedAt: now.toISOString(),
    // the next import starts a little before the newest meeting, so one finished late is not missed
    syncState: {
      since: opts.since
        ? state.since
        : newest
          ? new Date(Date.parse(newest) - 86_400_000).toISOString()
          : state.since,
      meetings: (state.meetings ?? 0) + imported,
    },
  });
  return { ok: true, imported, skipped };
}

/** Just connected: the other meeting apps go off, then the first import. */
async function firstSync(user: User, app: MeetingApp, now: Date): Promise<MeetingAppResult> {
  const switchedOff = await keepOnlyMeetingApp(user.id, app);
  const r = await syncMeetingApp(user, app, { now });
  return r.ok ? { ...r, switchedOff } : r;
}

/**
 * Connect a meeting app: Granola and Wispr Flow open their own sign-in, Fireflies takes the student's API key
 * (checked first). The sample student connects straight away with the demo's meetings.
 */
export async function connectMeetingApp(
  user: User,
  app: MeetingApp,
  apiKey = '',
  now = new Date(),
): Promise<MeetingAppResult> {
  const meta = MEETING_APP_META[app];
  if (usesMockConnectors(user.id)) {
    await saveRow(
      user,
      app,
      { externalAccountId: 'demo', accessToken: undefined, lastError: undefined },
      now,
    );
    return firstSync(user, app, now);
  }
  // Fireflies answers the browser directly (its API allows any origin, checked live 2026-10-25), so a pasted key needs
  // no Orbit server; the apps that sign in go through orbit-notes
  if (meta.connect !== 'key' && !notesAppsAvailable())
    return { ok: false, reason: 'unavailable', message: `This copy of Orbit cannot reach ${meta.name} yet.` };
  if (meta.connect === 'key') {
    const key = apiKey.trim();
    if (!key) return { ok: false, reason: 'bad_key', message: `Paste your ${meta.name} API key first.` };
    const probe = await firefliesMeetings(key, new Date(now.getTime() - 86_400_000), meta.source, {
      limit: 1,
    });
    if (!probe.ok) return { ok: false, reason: probe.badKey ? 'bad_key' : 'error', message: probe.message };
    await saveRow(
      user,
      app,
      {
        accessToken: key,
        oauth: undefined,
        externalAccountId: undefined,
        lastError: undefined,
        syncState: {},
      },
      now,
    );
    return firstSync(user, app, now);
  }
  const s = await signInToApp(app as 'granola' | 'wispr');
  if (!s.ok) return { ok: false, reason: 'error', message: s.message };
  await saveRow(
    user,
    app,
    {
      accessToken: s.accessToken,
      oauth: { refreshToken: s.refreshToken, expiresAt: s.expiresAt, clientId: s.clientId },
      externalAccountId: undefined,
      lastError: undefined,
      syncState: {},
    },
    now,
  );
  return firstSync(user, app, now);
}

/** Stop importing. The sign-in or key is forgotten here; notes already imported stay on people's pages. */
export async function disconnectMeetingApp(user: Pick<User, 'id'>, app: MeetingApp): Promise<void> {
  const row = await meetingAppAccount(user.id, app);
  if (!row) return;
  await db.integrations.update(row.id, {
    status: 'revoked',
    accessToken: undefined,
    oauth: undefined,
    externalAccountId: undefined,
    lastError: undefined,
  });
}

export interface MeetingAppStatus {
  available: boolean;
  connected: boolean;
  needsKey: boolean;
  meetings: number;
  lastSyncedAt?: string;
  error?: string;
}

export async function meetingAppStatus(user: Pick<User, 'id'>, app: MeetingApp): Promise<MeetingAppStatus> {
  const row = await meetingAppAccount(user.id, app);
  const on = isMeetingAppOn(row);
  return {
    // a pasted key (Fireflies) reaches the app straight from the browser; sign-ins need orbit-notes
    available: MEETING_APP_META[app].connect === 'key' || meetingAppAvailable(user),
    connected: on,
    needsKey: !!row && row.status === 'needs_reauth',
    meetings: Number((row?.syncState as { meetings?: number } | undefined)?.meetings ?? 0),
    lastSyncedAt: on ? row.lastSyncedAt : undefined,
    error: on ? row.lastError : undefined,
  };
}

/** On app open: import again from whichever app is on, when its last import is more than half a day old. */
export async function autoSyncMeetingApps(user: User, now = new Date()): Promise<void> {
  for (const app of Object.keys(MEETING_APP_META) as MeetingApp[]) {
    const row = await meetingAppAccount(user.id, app);
    if (!isMeetingAppOn(row) || row.status === 'needs_reauth') continue;
    const last = row.lastSyncedAt ? Date.parse(row.lastSyncedAt) : 0;
    if (now.getTime() - last >= MEETING_AUTO_SYNC_MS) await syncMeetingApp(user, app, { now });
  }
}
