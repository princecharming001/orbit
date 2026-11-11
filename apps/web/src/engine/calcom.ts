/**
 * Cal.com and Calendly: the student's booking page. Orbit lists its event types so the scheduling link drafts offer
 * is picked from a list in Settings instead of typed in. The chosen link is still stored as `settings.schedulingLink`,
 * which the drafts that propose times already use.
 *
 * Three ways in, easiest first:
 * - the booking link or username alone: both apps show a page's public event types to anyone, so Orbit reads them
 *   with no key and no sign-in (`syncState.public`);
 * - signing in to the app, once Orbit's OAuth client for it is set: hidden event types come too;
 * - Cal.com only: the student's own API key.
 * The sample student gets two made-up event types.
 */
import type { User } from '@orbit/core';
import { newId } from '@orbit/core';
import { db, type IntegrationAccount } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import {
  type CalEventType,
  calEventTypes,
  calendlyEventTypes,
  notesAppsAvailable,
  publicEventTypes,
} from '../integrations/notesApps';
import { appAuth, signInToApp } from './appSignIn';
import { setSchedulingLink } from './settings';

export type { CalEventType };

export type SchedApp = 'calcom' | 'calendly';
export const SCHED_NAME: Record<SchedApp, string> = { calcom: 'Cal.com', calendly: 'Calendly' };
const HOST: Record<SchedApp, string> = { calcom: 'cal.com', calendly: 'calendly.com' };

export type CalResult =
  | { ok: true; eventTypes: CalEventType[]; username?: string }
  | { ok: false; reason: 'bad_key' | 'unavailable' | 'not_connected' | 'error'; message: string };

export async function schedAccount(userId: string, app: SchedApp): Promise<IntegrationAccount | undefined> {
  return db.integrations
    .where('userId')
    .equals(userId)
    .filter((i) => i.provider === app)
    .first();
}
export const calAccount = (userId: string) => schedAccount(userId, 'calcom');

const isPublic = (row: IntegrationAccount) => (row.syncState as { public?: unknown }).public === true;

const connected = (row: IntegrationAccount | undefined): row is IntegrationAccount =>
  !!row &&
  row.status !== 'revoked' &&
  (!!row.accessToken || row.externalAccountId === 'demo' || isPublic(row));

export function calAvailable(user: Pick<User, 'id'>): boolean {
  return usesMockConnectors(user.id) || notesAppsAvailable();
}

/** "30 min coffee chat · cal.com/alex/30min": how an event type reads in the list. */
export function eventTypeLabel(e: CalEventType): string {
  return `${e.title} · ${e.url.replace(/^https?:\/\//, '')}`;
}

/** The event types worth offering: visible ones first, shortest first among equals. */
export function offeredEventTypes(types: CalEventType[]): CalEventType[] {
  return [...types].sort(
    (a, b) => Number(a.hidden) - Number(b.hidden) || (a.minutes ?? 0) - (b.minutes ?? 0),
  );
}

/** The connected account's event types, as last fetched. */
export function storedEventTypes(row: IntegrationAccount | undefined): CalEventType[] {
  const list = (row?.syncState as { eventTypes?: CalEventType[] } | undefined)?.eventTypes;
  return Array.isArray(list) ? list : [];
}

/**
 * What the student typed, read as a booking page: "cal.com/alex", "https://calendly.com/alex/30min" or just "alex".
 * A link to the other app, or to a team page, is named back so the row can say what to do instead.
 */
export function parseBookingPage(
  app: SchedApp,
  input: string,
): { ok: true; username: string; slug?: string } | { ok: false; message: string } {
  const raw = input.trim().replace(/^@/, '');
  if (!raw) return { ok: false, message: `Type your ${SCHED_NAME[app]} link first.` };
  const other: SchedApp = app === 'calcom' ? 'calendly' : 'calcom';
  if (new RegExp(`(^|[/.])${HOST[other].replace('.', '\\.')}(/|$)`, 'i').test(raw))
    return {
      ok: false,
      message: `That is a ${SCHED_NAME[other]} link. Add it in the ${SCHED_NAME[other]} row.`,
    };
  let path = raw;
  const m = raw.match(/^(?:https?:\/\/)?(?:www\.|app\.)?([a-z0-9.-]+\.[a-z]{2,})(\/[^?#]*)?/i);
  if (m && m[1]!.includes('.')) {
    if (m[1]!.toLowerCase() !== HOST[app])
      return { ok: false, message: `Paste a ${HOST[app]} link, or just your username.` };
    path = (m[2] ?? '').replace(/^\/+/, '');
  }
  const [username, slug] = path.split('/').filter(Boolean);
  if (!username || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(username))
    return { ok: false, message: `That does not look like a ${SCHED_NAME[app]} username.` };
  if (app === 'calcom' && (username === 'team' || username === 'org'))
    return { ok: false, message: 'That is a team page. Paste your own cal.com link.' };
  return { ok: true, username, slug: slug && /^[A-Za-z0-9._-]+$/.test(slug) ? slug : undefined };
}

function demoTypes(
  app: SchedApp,
  user: Pick<User, 'firstName' | 'lastName'>,
): { username: string; eventTypes: CalEventType[] } {
  const username =
    `${user.firstName ?? 'alex'}-${user.lastName ?? 'rivera'}`.toLowerCase().replace(/[^a-z0-9-]/g, '') ||
    'alex';
  const base = `https://${HOST[app]}/${username}`;
  return {
    username,
    eventTypes: [
      {
        id: `demo-${app}-15`,
        title: '15 min chat',
        slug: '15min',
        minutes: 15,
        hidden: false,
        url: `${base}/15min`,
      },
      {
        id: `demo-${app}-30`,
        title: '30 min coffee chat',
        slug: '30min',
        minutes: 30,
        hidden: false,
        url: `${base}/30min`,
      },
    ],
  };
}

async function saveRow(
  user: User,
  app: SchedApp,
  patch: Partial<IntegrationAccount>,
  now: Date,
): Promise<IntegrationAccount> {
  const existing = await schedAccount(user.id, app);
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

/** With no scheduling link set yet, the one the student pasted, else the first visible event type, becomes it. */
async function fillLinkIfEmpty(userId: string, types: CalEventType[], preferred?: string): Promise<void> {
  const current = (await db.settings.get(userId))?.schedulingLink;
  if (current) return;
  const first = preferred ?? offeredEventTypes(types).find((t) => !t.hidden)?.url;
  if (first) await setSchedulingLink(userId, first);
}

async function connectDemo(user: User, app: SchedApp, now: Date): Promise<CalResult> {
  const d = demoTypes(app, user);
  await saveRow(
    user,
    app,
    { externalAccountId: 'demo', accessToken: undefined, lastSyncedAt: now.toISOString(), syncState: d },
    now,
  );
  await fillLinkIfEmpty(user.id, d.eventTypes);
  return { ok: true, ...d };
}

/**
 * Connect with the booking link (or username) alone: the page's public event types, read with no key. A link to
 * one event type becomes the scheduling link when none is set; a Calendly page with no public types still connects,
 * offering the page itself.
 */
export async function connectSchedulingLink(
  user: User,
  app: SchedApp,
  input: string,
  now = new Date(),
): Promise<CalResult> {
  if (usesMockConnectors(user.id)) return connectDemo(user, app, now);
  const page = parseBookingPage(app, input);
  if (!page.ok) return { ok: false, reason: 'error', message: page.message };
  if (!notesAppsAvailable())
    return {
      ok: false,
      reason: 'unavailable',
      message: `This copy of Orbit cannot reach ${SCHED_NAME[app]} yet.`,
    };
  const r = await publicEventTypes(app, page.username);
  if (!r.ok) return { ok: false, reason: 'error', message: r.message };
  const pageUrl = `https://${HOST[app]}/${r.value.username}`;
  const picked = page.slug ? r.value.eventTypes.find((t) => t.slug === page.slug)?.url : undefined;
  await saveRow(
    user,
    app,
    {
      accessToken: undefined,
      oauth: undefined,
      externalAccountId: r.value.username,
      lastError: undefined,
      lastSyncedAt: now.toISOString(),
      syncState: { username: r.value.username, eventTypes: r.value.eventTypes, public: true },
    },
    now,
  );
  await fillLinkIfEmpty(
    user.id,
    r.value.eventTypes,
    picked ?? (r.value.eventTypes.length ? undefined : pageUrl),
  );
  return { ok: true, eventTypes: r.value.eventTypes, username: r.value.username };
}

/** Save the Cal.com key (checked by fetching the event types) and keep the list. */
export async function connectCalcom(user: User, apiKey: string, now = new Date()): Promise<CalResult> {
  if (usesMockConnectors(user.id)) return connectDemo(user, 'calcom', now);
  const key = apiKey.trim();
  if (!key) return { ok: false, reason: 'bad_key', message: 'Paste your Cal.com API key first.' };
  if (!notesAppsAvailable())
    return { ok: false, reason: 'unavailable', message: 'This copy of Orbit cannot reach Cal.com yet.' };
  const r = await calEventTypes(key);
  if (!r.ok) return { ok: false, reason: r.reason === 'bad_key' ? 'bad_key' : 'error', message: r.message };
  await saveRow(
    user,
    'calcom',
    {
      accessToken: key,
      oauth: undefined,
      externalAccountId: r.value.username,
      lastError: undefined,
      lastSyncedAt: now.toISOString(),
      syncState: { username: r.value.username, eventTypes: r.value.eventTypes },
    },
    now,
  );
  await fillLinkIfEmpty(user.id, r.value.eventTypes);
  return { ok: true, eventTypes: r.value.eventTypes, username: r.value.username };
}

const fetchTypes = (app: SchedApp, auth: Awaited<ReturnType<typeof appAuth>> & {}) =>
  app === 'calcom'
    ? calEventTypes(auth)
    : calendlyEventTypes(typeof auth === 'string' ? auth : auth.accessToken);

/** Connect by signing in to the app: its own window, then the event types as with a key. */
export async function connectSchedSignedIn(user: User, app: SchedApp, now = new Date()): Promise<CalResult> {
  if (usesMockConnectors(user.id)) return connectDemo(user, app, now);
  const s = await signInToApp(app);
  if (!s.ok) return { ok: false, reason: 'error', message: s.message };
  const r = await fetchTypes(app, { accessToken: s.accessToken });
  if (!r.ok) return { ok: false, reason: 'error', message: r.message };
  await saveRow(
    user,
    app,
    {
      accessToken: s.accessToken,
      oauth: { refreshToken: s.refreshToken, expiresAt: s.expiresAt },
      externalAccountId: r.value.username,
      lastError: undefined,
      lastSyncedAt: now.toISOString(),
      syncState: { username: r.value.username, eventTypes: r.value.eventTypes },
    },
    now,
  );
  await fillLinkIfEmpty(user.id, r.value.eventTypes);
  return { ok: true, eventTypes: r.value.eventTypes, username: r.value.username };
}
export const connectCalcomSignedIn = (user: User, now = new Date()) =>
  connectSchedSignedIn(user, 'calcom', now);

/** Fetch the event types again (a new one made on the app shows up in the list). */
export async function refreshScheduling(user: User, app: SchedApp, now = new Date()): Promise<CalResult> {
  const row = await schedAccount(user.id, app);
  const name = SCHED_NAME[app];
  if (!connected(row)) return { ok: false, reason: 'not_connected', message: `${name} is not connected.` };
  if (row.externalAccountId === 'demo') return { ok: true, eventTypes: storedEventTypes(row) };
  const r = isPublic(row)
    ? await publicEventTypes(app, row.externalAccountId ?? '')
    : await (async () => {
        const auth = await appAuth(app, row);
        return auth ? fetchTypes(app, auth) : undefined;
      })();
  if (!r) return { ok: false, reason: 'bad_key', message: `${name} needs you to connect again.` };
  if (!r.ok) {
    await db.integrations.update(row.id, {
      status: r.reason === 'bad_key' ? 'needs_reauth' : 'error',
      lastError: r.message,
    });
    return { ok: false, reason: r.reason === 'bad_key' ? 'bad_key' : 'error', message: r.message };
  }
  await db.integrations.update(row.id, {
    status: 'active',
    lastError: undefined,
    lastSyncedAt: now.toISOString(),
    syncState: { ...row.syncState, username: r.value.username, eventTypes: r.value.eventTypes },
  });
  return { ok: true, eventTypes: r.value.eventTypes, username: r.value.username };
}
export const refreshCalcom = (user: User, now = new Date()) => refreshScheduling(user, 'calcom', now);

/** Forget the key or sign-in. The scheduling link already chosen stays, as a plain link. */
export async function disconnectScheduling(user: Pick<User, 'id'>, app: SchedApp): Promise<void> {
  const row = await schedAccount(user.id, app);
  if (!row) return;
  await db.integrations.update(row.id, {
    status: 'revoked',
    accessToken: undefined,
    oauth: undefined,
    lastError: undefined,
    syncState: { ...row.syncState, public: false },
  });
}
export const disconnectCalcom = (user: Pick<User, 'id'>) => disconnectScheduling(user, 'calcom');

export interface CalStatus {
  available: boolean;
  connected: boolean;
  username?: string;
  /** connected with the booking link alone, no key or sign-in */
  viaLink: boolean;
  eventTypes: CalEventType[];
  error?: string;
  needsKey: boolean;
}

export async function schedStatus(user: Pick<User, 'id'>, app: SchedApp): Promise<CalStatus> {
  const row = await schedAccount(user.id, app);
  const on = connected(row);
  return {
    available: calAvailable(user),
    connected: on,
    username: on ? ((row.syncState as { username?: string }).username ?? row.externalAccountId) : undefined,
    viaLink: on && isPublic(row),
    eventTypes: on ? offeredEventTypes(storedEventTypes(row)) : [],
    error: on ? row.lastError : undefined,
    needsKey: !!row && row.status === 'needs_reauth',
  };
}
export const calStatus = (user: Pick<User, 'id'>) => schedStatus(user, 'calcom');

/** Every connected booking app's event types, Cal.com's first: what the scheduling link is picked from. */
export async function allEventTypes(user: Pick<User, 'id'>): Promise<CalEventType[]> {
  const [cal, cly] = await Promise.all([schedStatus(user, 'calcom'), schedStatus(user, 'calendly')]);
  return [...cal.eventTypes, ...cly.eventTypes];
}
