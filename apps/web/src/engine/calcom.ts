/**
 * Cal.com: the student's booking page. Connected with their Cal.com API key (kept in this browser only, on the
 * `calcom` integration row), Orbit lists their event types so the scheduling link drafts offer is picked from a
 * list in Settings instead of typed in. The chosen link is still stored as `settings.schedulingLink`, which the drafts
 * that propose times already use. The sample student gets two made-up event types.
 */
import type { User } from '@orbit/core';
import { newId } from '@orbit/core';
import { db, type IntegrationAccount } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { type CalEventType, calEventTypes, notesAppsAvailable } from '../integrations/notesApps';
import { appAuth, signInToApp } from './appSignIn';
import { setSchedulingLink } from './settings';

export type { CalEventType };

export type CalResult =
  | { ok: true; eventTypes: CalEventType[]; username?: string }
  | { ok: false; reason: 'bad_key' | 'unavailable' | 'not_connected' | 'error'; message: string };

export async function calAccount(userId: string): Promise<IntegrationAccount | undefined> {
  return db.integrations
    .where('userId')
    .equals(userId)
    .filter((i) => i.provider === 'calcom')
    .first();
}

const connected = (row: IntegrationAccount | undefined): row is IntegrationAccount =>
  !!row && row.status !== 'revoked' && (!!row.accessToken || row.externalAccountId === 'demo');

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

function demoTypes(user: Pick<User, 'firstName' | 'lastName'>): {
  username: string;
  eventTypes: CalEventType[];
} {
  const username =
    `${user.firstName ?? 'alex'}-${user.lastName ?? 'rivera'}`.toLowerCase().replace(/[^a-z0-9-]/g, '') ||
    'alex';
  return {
    username,
    eventTypes: [
      {
        id: 'demo-15',
        title: '15 min chat',
        slug: '15min',
        minutes: 15,
        hidden: false,
        url: `https://cal.com/${username}/15min`,
      },
      {
        id: 'demo-30',
        title: '30 min coffee chat',
        slug: '30min',
        minutes: 30,
        hidden: false,
        url: `https://cal.com/${username}/30min`,
      },
    ],
  };
}

async function saveRow(
  user: User,
  patch: Partial<IntegrationAccount>,
  now: Date,
): Promise<IntegrationAccount> {
  const existing = await calAccount(user.id);
  const row: IntegrationAccount = {
    scopes: [],
    syncState: {},
    ...existing,
    id: existing?.id ?? newId('int'),
    userId: user.id,
    provider: 'calcom',
    status: 'active',
    connectedAt: existing && existing.status !== 'revoked' ? existing.connectedAt : now.toISOString(),
    ...patch,
  };
  await db.integrations.put(row);
  return row;
}

/** With no scheduling link set yet, the first visible event type becomes it. */
async function fillLinkIfEmpty(userId: string, types: CalEventType[]): Promise<void> {
  const current = (await db.settings.get(userId))?.schedulingLink;
  const first = offeredEventTypes(types).find((t) => !t.hidden);
  if (!current && first) await setSchedulingLink(userId, first.url);
}

/** Save the key (checked by fetching the event types) and keep the list. */
export async function connectCalcom(user: User, apiKey: string, now = new Date()): Promise<CalResult> {
  if (usesMockConnectors(user.id)) {
    const d = demoTypes(user);
    await saveRow(
      user,
      { externalAccountId: 'demo', accessToken: undefined, lastSyncedAt: now.toISOString(), syncState: d },
      now,
    );
    await fillLinkIfEmpty(user.id, d.eventTypes);
    return { ok: true, ...d };
  }
  const key = apiKey.trim();
  if (!key) return { ok: false, reason: 'bad_key', message: 'Paste your Cal.com API key first.' };
  if (!notesAppsAvailable())
    return { ok: false, reason: 'unavailable', message: 'This copy of Orbit cannot reach Cal.com yet.' };
  const r = await calEventTypes(key);
  if (!r.ok) return { ok: false, reason: r.reason === 'bad_key' ? 'bad_key' : 'error', message: r.message };
  await saveRow(
    user,
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

/** Connect by signing in to Cal.com: its own window, then the event types as with a key. */
export async function connectCalcomSignedIn(user: User, now = new Date()): Promise<CalResult> {
  if (usesMockConnectors(user.id)) return connectCalcom(user, '', now);
  const s = await signInToApp('calcom');
  if (!s.ok) return { ok: false, reason: 'error', message: s.message };
  const r = await calEventTypes({ accessToken: s.accessToken });
  if (!r.ok) return { ok: false, reason: 'error', message: r.message };
  await saveRow(
    user,
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

/** Fetch the event types again (a new one made on Cal.com shows up in the list). */
export async function refreshCalcom(user: User, now = new Date()): Promise<CalResult> {
  const row = await calAccount(user.id);
  if (!connected(row)) return { ok: false, reason: 'not_connected', message: 'Cal.com is not connected.' };
  if (row.externalAccountId === 'demo') return { ok: true, eventTypes: storedEventTypes(row) };
  const auth = await appAuth('calcom', row);
  if (!auth) return { ok: false, reason: 'bad_key', message: 'Cal.com needs you to connect again.' };
  const r = await calEventTypes(auth);
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
    syncState: { username: r.value.username, eventTypes: r.value.eventTypes },
  });
  return { ok: true, eventTypes: r.value.eventTypes, username: r.value.username };
}

/** Forget the key. The scheduling link already chosen stays, as a plain link. */
export async function disconnectCalcom(user: Pick<User, 'id'>): Promise<void> {
  const row = await calAccount(user.id);
  if (!row) return;
  await db.integrations.update(row.id, {
    status: 'revoked',
    accessToken: undefined,
    oauth: undefined,
    lastError: undefined,
  });
}

export interface CalStatus {
  available: boolean;
  connected: boolean;
  username?: string;
  eventTypes: CalEventType[];
  error?: string;
  needsKey: boolean;
}

export async function calStatus(user: Pick<User, 'id'>): Promise<CalStatus> {
  const row = await calAccount(user.id);
  const on = connected(row);
  return {
    available: calAvailable(user),
    connected: on,
    username: on ? ((row.syncState as { username?: string }).username ?? row.externalAccountId) : undefined,
    eventTypes: on ? offeredEventTypes(storedEventTypes(row)) : [],
    error: on ? row.lastError : undefined,
    needsKey: !!row && row.status === 'needs_reauth',
  };
}
