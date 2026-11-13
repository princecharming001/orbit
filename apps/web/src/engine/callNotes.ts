/**
 * Zoom and Google Meet as a source of notes (and, for Zoom, of meeting links): the call's own transcript, read after
 * a coffee chat held on it, filed by the same pipeline as a notetaker's meeting (fathom.ts importMeetings: facts,
 * promises, the chat completed, the thank-you), so the Chats row updates.
 *
 * They sit beside the notetakers, not instead of one: a chat that already has notes (from Fathom, Granola, Fireflies,
 * Wispr Flow, or typed) never gets a second note from its call, and while a notetaker is on, the call is asked only
 * after the notetaker had its turn (CALL_AFTER_NOTETAKER_MIN).
 *
 * Both need an Orbit account: Zoom's tokens and the Google permission live on Orbit's server, which reads the
 * transcript (orbit-api /zoom/notes, /meet/notes). This browser keeps a copy of where each stands on an integration
 * row (provider zoom or google_meet), so the notes check and the Chats page can tell at once. The sample student uses
 * the demo's made-up calls (integrations/callAppsMock.ts).
 */
import type { CalendarEvent, CallApp, CallNote, NoteSource, User } from '@orbit/core';
import { callAppOfUrl, newId, normalizeEmail } from '@orbit/core';
import { db, type IntegrationAccount } from '../db/schema';
import { mockCallNotes, mockZoomJoinUrl } from '../integrations/callAppsMock';
import { usesMockConnectors } from '../integrations/connectorsMock';
import type { FathomMeeting } from '../integrations/notesApps';
import { callApi, isServerUser } from '../integrations/orbitApi';
import { endActivity, startActivity } from './activity';
import { importMeetings } from './fathom';

export const CALL_APPS: readonly CallApp[] = ['zoom', 'google_meet'];

export const CALL_APP_META: Record<CallApp, { name: string; logo: string; source: NoteSource }> = {
  zoom: { name: 'Zoom', logo: 'zoom.us', source: 'zoom' },
  google_meet: { name: 'Google Meet', logo: 'meet.google.com', source: 'google_meet' },
};

/** While a notetaker is on, a call's transcript is asked for only this long after the chat ended. */
export const CALL_AFTER_NOTETAKER_MIN = 30;
/** Connecting looks this far back for chats held on the call with no notes yet. */
export const CALL_FIRST_LOOK_DAYS = 14;
/** Events one call to the server asks about. */
const BATCH = 10;

export const ZOOM_ROW_LINE = 'Notes come in when Zoom records the call to the cloud.';
export const MEET_ROW_LINE = 'Notes come in when your Google account records a transcript.';

/** Zoom and Meet need an Orbit account, or the sample student's made-up ones. */
export function callAppsSupported(userId: string | undefined): boolean {
  return !!userId && (isServerUser(userId) || usesMockConnectors(userId));
}

interface CallSyncState {
  /** Orbit's Zoom app keys are stored (always true for Meet) */
  configured?: boolean;
  /** Meet is on but Google has not given the transcript permission yet */
  needsConsent?: boolean;
  /** notes filed from this app */
  meetings?: number;
}

export async function callAppRow(userId: string, app: CallApp): Promise<IntegrationAccount | undefined> {
  return db.integrations
    .where('userId')
    .equals(userId)
    .filter((i) => i.provider === app)
    .first();
}

const stateOf = (row: IntegrationAccount | undefined) => (row?.syncState ?? {}) as CallSyncState;

/** On and able to read: connected, not waiting on a sign-in or a permission. */
export const isCallAppOn = (row: IntegrationAccount | undefined): row is IntegrationAccount =>
  !!row &&
  (row.status === 'active' || row.status === 'error') &&
  !stateOf(row).needsConsent &&
  stateOf(row).configured !== false;

async function saveRow(userId: string, app: CallApp, patch: Partial<IntegrationAccount>, now = new Date()) {
  const existing = await callAppRow(userId, app);
  const row: IntegrationAccount = {
    scopes: [],
    syncState: {},
    status: 'revoked',
    connectedAt: now.toISOString(),
    ...existing,
    id: existing?.id ?? newId('int'),
    userId,
    provider: app,
    ...patch,
  };
  await db.integrations.put(row);
  return row;
}

export interface CallAppStatus {
  /** this student can use it at all (an Orbit account, or the demo) */
  supported: boolean;
  /** Orbit's own keys are in place (Zoom's app keys; Meet needs none) */
  configured: boolean;
  connected: boolean;
  needsReauth: boolean;
  needsConsent: boolean;
  email?: string;
  meetings: number;
  lastSyncedAt?: string;
  error?: string;
  demo: boolean;
}

export async function callAppStatus(user: Pick<User, 'id'>, app: CallApp): Promise<CallAppStatus> {
  const row = await callAppRow(user.id, app);
  const s = stateOf(row);
  const live = !!row && row.status !== 'revoked';
  return {
    supported: callAppsSupported(user.id),
    configured: s.configured !== false,
    connected: live && row.status !== 'needs_reauth' && !s.needsConsent,
    needsReauth: live && row.status === 'needs_reauth',
    needsConsent: live && !!s.needsConsent,
    email: live && row.externalAccountId !== 'demo' ? row.externalAccountId : undefined,
    meetings: Number(s.meetings ?? 0),
    lastSyncedAt: live ? row.lastSyncedAt : undefined,
    error: live ? row.lastError : undefined,
    demo: row?.externalAccountId === 'demo',
  };
}

type Fail = { ok: false; message: string };

/** Ask the server where Zoom or Meet stands, and keep it on this browser's row. The demo's row is its own answer. */
export async function refreshCallApp(user: Pick<User, 'id'>, app: CallApp): Promise<void> {
  if (usesMockConnectors(user.id) || !isServerUser(user.id)) return;
  const prev = stateOf(await callAppRow(user.id, app));
  if (app === 'zoom') {
    const r = await callApi('/zoom/status', {});
    if (!r.ok) return;
    await saveRow(user.id, app, {
      status: r.value.status === 'not_connected' ? 'revoked' : r.value.status,
      externalAccountId: r.value.email,
      lastSyncedAt: r.value.lastSyncedAt,
      syncState: { ...prev, configured: r.value.configured, needsConsent: false },
    });
    return;
  }
  const r = await callApi('/meet/status', {});
  if (!r.ok) return;
  await saveRow(user.id, app, {
    status:
      r.value.status === 'not_connected'
        ? 'revoked'
        : r.value.status === 'needs_reauth'
          ? 'needs_reauth'
          : 'active',
    externalAccountId: r.value.email,
    lastSyncedAt: r.value.lastSyncedAt,
    syncState: { ...prev, configured: true, needsConsent: r.value.status === 'needs_consent' },
  });
}

export type CallConnectResult =
  | { ok: true; imported: number; leaving?: boolean }
  | { ok: false; reason: 'unavailable' | 'not_set_up' | 'error'; message: string };

/**
 * Turn Zoom or Meet on. Zoom opens Zoom's own sign-in (the page leaves and comes back to Settings); Meet asks Google
 * for the transcript permission the first time. The sample student connects at once. Then the chats of the last two
 * weeks held on that app with no notes yet are looked at once.
 */
export async function connectCallApp(user: User, app: CallApp, now = new Date()): Promise<CallConnectResult> {
  const name = CALL_APP_META[app].name;
  if (usesMockConnectors(user.id)) {
    await saveRow(
      user.id,
      app,
      {
        status: 'active',
        externalAccountId: 'demo',
        lastError: undefined,
        connectedAt: now.toISOString(),
        syncState: { configured: true, meetings: stateOf(await callAppRow(user.id, app)).meetings ?? 0 },
      },
      now,
    );
    const r = await pullCallNotes(user, { now, apps: [app], firstLook: true });
    return { ok: true, imported: r.imported };
  }
  if (!isServerUser(user.id))
    return {
      ok: false,
      reason: 'unavailable',
      message: `${name} needs an Orbit account. Sign in with Google first.`,
    };
  if (app === 'zoom') {
    const r = await callApi('/zoom/connect/start', {});
    if (!r.ok)
      return r.reason === 'unconfigured'
        ? { ok: false, reason: 'not_set_up', message: 'Zoom is not set up on Orbit yet.' }
        : { ok: false, reason: 'error', message: r.message };
    window.location.assign(r.value.url);
    return { ok: true, imported: 0, leaving: true };
  }
  const r = await callApi('/meet/connect/start', {});
  if (!r.ok) return { ok: false, reason: 'error', message: r.message };
  if (r.value.url) {
    window.location.assign(r.value.url);
    return { ok: true, imported: 0, leaving: true };
  }
  await refreshCallApp(user, app);
  const pulled = await pullCallNotes(user, { now, apps: [app], firstLook: true });
  return { ok: true, imported: pulled.imported };
}

/** Turn Zoom or Meet off. Zoom's sign-in is revoked at Zoom; notes already filed stay on people's pages. */
export async function disconnectCallApp(user: Pick<User, 'id'>, app: CallApp): Promise<{ ok: true } | Fail> {
  if (!usesMockConnectors(user.id) && isServerUser(user.id)) {
    const r = await callApi(app === 'zoom' ? '/zoom/disconnect' : '/meet/disconnect', {});
    if (!r.ok) return { ok: false, message: r.message };
  }
  const row = await callAppRow(user.id, app);
  if (row) await db.integrations.update(row.id, { status: 'revoked', lastError: undefined });
  return { ok: true };
}

/** The call apps that are on for this student, by key. */
export async function connectedCallApps(userId: string): Promise<CallApp[]> {
  if (!callAppsSupported(userId)) return [];
  const out: CallApp[] = [];
  for (const app of CALL_APPS) if (isCallAppOn(await callAppRow(userId, app))) out.push(app);
  return out;
}

/** Which app recorded this chat's call, by its join link, among those that are on. */
export function callAppForEvent(
  ev: Pick<CalendarEvent, 'conferenceUrl'>,
  on: CallApp[],
): CallApp | undefined {
  const app = callAppOfUrl(ev.conferenceUrl);
  return app && on.includes(app) ? app : undefined;
}

/** A chat already has notes: from a notetaker, typed, or an earlier call transcript. */
export async function eventHasNote(userId: string, ev: CalendarEvent): Promise<boolean> {
  const notes = await db.notes.where('userId').equals(userId).toArray();
  return notes.some(
    (n) =>
      n.matchStatus !== 'rejected' &&
      (n.calendarEventId === ev.id ||
        (!!ev.chatId && n.chatId === ev.chatId) ||
        (n.personIds.some((id) => ev.attendeePersonIds.includes(id)) &&
          Math.abs(Date.parse(n.occurredAt) - Date.parse(ev.startAt)) <= 3 * 3_600_000)),
  );
}

/** The call's notes as the meeting the notetaker pipeline files: the people on the invite, the summary, the transcript. */
async function asMeeting(
  user: Pick<User, 'email' | 'fullName'>,
  ev: CalendarEvent,
  n: CallNote,
): Promise<FathomMeeting> {
  const invitees: FathomMeeting['invitees'] = [{ name: user.fullName, email: user.email }];
  const seen = new Set([normalizeEmail(user.email ?? '')]);
  for (const id of ev.attendeePersonIds) {
    const p = await db.people.get(id);
    const email = p?.primaryEmail ?? p?.emails?.[0];
    if (!p || (email && seen.has(normalizeEmail(email)))) continue;
    if (email) seen.add(normalizeEmail(email));
    invitees.push({ name: p.displayName, email, external: true });
  }
  for (const a of ev.attendees) {
    if (a.self || !a.email || seen.has(normalizeEmail(a.email))) continue;
    seen.add(normalizeEmail(a.email));
    invitees.push({ name: a.displayName, email: a.email, external: true });
  }
  const summary = [n.summary && `Summary:\n${n.summary}`, n.transcript && `Transcript:\n${n.transcript}`]
    .filter(Boolean)
    .join('\n\n');
  return {
    id: n.meetingId,
    title: n.title,
    url: n.url,
    startAt: n.startAt ?? ev.startAt,
    invitees,
    recordedBy: user.email,
    summary: summary || undefined,
    actionItems: [],
  };
}

export interface CallPullResult {
  imported: number;
  /** events asked about with nothing recorded yet */
  none: string[];
  /** apps that said the student must sign in or allow access again */
  needs: CallApp[];
}

/** Coffee chats on the calendar that ended in the last `days`, not cancelled. */
async function endedChats(userId: string, now: Date, days: number): Promise<CalendarEvent[]> {
  return db.events
    .where('userId')
    .equals(userId)
    .filter(
      (e) =>
        (!!e.isCoffeeChat || !!e.chatId) &&
        e.status !== 'cancelled' &&
        Date.parse(e.endAt) <= now.getTime() &&
        now.getTime() - Date.parse(e.endAt) <= days * 86_400_000,
    )
    .toArray();
}

/**
 * Ask Zoom and Meet for the notes of these chats (or, on `firstLook`, of every chat of the last two weeks), each
 * chat to the app its join link belongs to, and file what came back. A chat with notes already is never asked, and
 * is checked again just before filing, so a notetaker's notes that landed meanwhile win. Never throws.
 */
export async function pullCallNotes(
  user: User,
  opts: { now?: Date; events?: CalendarEvent[]; apps?: CallApp[]; firstLook?: boolean } = {},
): Promise<CallPullResult> {
  const now = opts.now ?? new Date();
  const out: CallPullResult = { imported: 0, none: [], needs: [] };
  const on = (await connectedCallApps(user.id)).filter((a) => !opts.apps || opts.apps.includes(a));
  if (!on.length) return out;
  const pool = opts.events ?? (opts.firstLook ? await endedChats(user.id, now, CALL_FIRST_LOOK_DAYS) : []);
  for (const app of on) {
    const asked: CalendarEvent[] = [];
    for (const ev of pool)
      if (callAppForEvent(ev, [app]) && !(await eventHasNote(user.id, ev))) asked.push(ev);
    if (!asked.length) continue;
    startActivity(`notes:${app}`, `Checking ${CALL_APP_META[app].name} for notes`);
    try {
      for (let i = 0; i < asked.length; i += BATCH) {
        const batch = asked.slice(i, i + BATCH);
        const got = await askApp(user, app, batch, now);
        if (!got.ok) {
          if (got.needs) out.needs.push(app);
          break;
        }
        out.none.push(...got.none);
        for (const n of got.notes) {
          const ev = batch.find((e) => e.id === n.eventId);
          if (!ev || (await eventHasNote(user.id, ev))) continue;
          const { imported } = await importMeetings(
            user,
            [await asMeeting(user, ev, n)],
            now,
            CALL_APP_META[app].source,
          );
          out.imported += imported;
        }
      }
      const row = await callAppRow(user.id, app);
      if (row)
        await db.integrations.update(row.id, {
          lastSyncedAt: now.toISOString(),
          lastError: undefined,
          syncState: { ...stateOf(row), meetings: (stateOf(row).meetings ?? 0) + out.imported },
        });
    } catch {
      // a call that failed is asked again at the next check
    } finally {
      endActivity(`notes:${app}`);
    }
  }
  return out;
}

async function askApp(
  user: User,
  app: CallApp,
  events: CalendarEvent[],
  now: Date,
): Promise<{ ok: true; notes: CallNote[]; none: string[] } | { ok: false; needs: boolean }> {
  if (usesMockConnectors(user.id)) return { ok: true, ...(await mockCallNotes(user, app, events, now)) };
  const people = new Map<string, { name?: string; email?: string }>();
  for (const ev of events)
    for (const id of ev.attendeePersonIds) {
      const p = await db.people.get(id);
      if (p) people.set(id, { name: p.displayName, email: p.primaryEmail });
    }
  const body = {
    events: events.map((ev) => ({
      id: ev.id,
      startAt: ev.startAt,
      endAt: ev.endAt,
      title: ev.title,
      conferenceUrl: ev.conferenceUrl,
      attendees: ev.attendeePersonIds
        .map((id) => people.get(id))
        .filter((a): a is { name?: string; email?: string } => !!a)
        .slice(0, 10),
    })),
  };
  const r = await callApi(app === 'zoom' ? '/zoom/notes' : '/meet/notes', body);
  if (r.ok) return { ok: true, notes: r.value.notes, none: r.value.none };
  const row = await callAppRow(user.id, app);
  const needs = r.status === 409 && ['needs_reauth', 'needs_consent', 'not_connected'].includes(r.code ?? '');
  if (row)
    await db.integrations.update(row.id, {
      ...(r.code === 'needs_reauth' ? { status: 'needs_reauth' as const } : {}),
      ...(r.code === 'not_connected' ? { status: 'revoked' as const } : {}),
      ...(r.code === 'needs_consent' ? { syncState: { ...stateOf(row), needsConsent: true } } : {}),
      ...(r.reason === 'unconfigured' ? { syncState: { ...stateOf(row), configured: false } } : {}),
      lastError: needs || r.reason === 'unconfigured' ? undefined : r.message,
    });
  return { ok: false, needs };
}

/**
 * A Zoom meeting for a booked chat, its join link for the invite. The demo's is made up. Undefined when Zoom cannot
 * make one (not connected, not set up, or it said no); the caller then uses Google Meet.
 */
export async function createZoomMeeting(
  user: Pick<User, 'id' | 'timezone'>,
  m: { eventId: string; topic: string; startAt: string; minutes: number },
): Promise<string | undefined> {
  if (usesMockConnectors(user.id)) return mockZoomJoinUrl(m.eventId);
  if (!isServerUser(user.id) || !isCallAppOn(await callAppRow(user.id, 'zoom'))) return undefined;
  const r = await callApi('/zoom/meetings', {
    topic: m.topic,
    startAt: m.startAt,
    minutes: m.minutes,
    timezone: user.timezone || undefined,
  });
  return r.ok ? r.value.joinUrl : undefined;
}
