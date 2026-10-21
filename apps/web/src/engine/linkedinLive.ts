/**
 * Live LinkedIn: the student's own LinkedIn account connected through Unipile (integrations/unipile.ts), synced into
 * Orbit through the same path as the Connections.csv export. The account is one integration row (provider
 * `linkedin_live`) holding Unipile's account id in `externalAccountId`, a status and `syncState {rows, lastSyncedAt}`.
 * The sample student uses the mock connector (integrations/connectorsMock.ts): connect succeeds at once with no popup.
 *
 * Until the Unipile key is pasted the proxy answers "unconfigured", and every function here says so in a typed
 * result, so the UI can offer the export instead.
 */
import type { Person, User } from '@orbit/core';
import { linkedInSlug, newId, normalizeLinkedInUrl } from '@orbit/core';
import { db, type IntegrationAccount } from '../db/schema';
import {
  MOCK_ACCOUNT_ID,
  mockLinkedInConnections,
  mockMutuals,
  usesMockConnectors,
} from '../integrations/connectorsMock';
import { callApi, isServerUser } from '../integrations/orbitApi';
import {
  disconnectLinkedInAccount,
  type LiveConnection,
  linkedInConnections,
  linkedInConnectStatus,
  type Mutual,
  mutualConnections,
  sendLinkedInMessage,
  startLinkedInConnect,
  unipileConfigured,
} from '../integrations/unipile';
import { generateBrief, recommendationsRefresh } from './brief';
import { importLiveConnections } from './linkedin';

export type LiveConnectResult =
  | { ok: true; rows: number; added: number }
  | { ok: false; reason: 'unconfigured' | 'cancelled' | 'error'; message: string };

export type LiveSyncResult =
  | { ok: true; rows: number; added: number; updated: number; recommended: number }
  | { ok: false; reason: 'not_connected' | 'unconfigured' | 'error'; message: string };

/** What the UI says while the Unipile key is not pasted yet. */
export const LIVE_SOON = 'Live sync is switching on soon. Upload your export for now.';

/** A sync older than this is redone when the app opens. */
export const AUTO_SYNC_AFTER_MS = 24 * 60 * 60 * 1000;

/** Live connect is offered: the build has the proxy, or this is the sample student (mock connector). */
export function liveLinkedInAvailable(user: User): boolean {
  // account mode: orbit-api links LinkedIn (POST /linkedin/connect/start) and syncs it on the server
  return usesMockConnectors(user.id) || unipileConfigured() || isServerUser(user.id);
}

/** The live LinkedIn row for a user, if any (a disconnected one is kept as `revoked`). */
export async function liveLinkedInAccount(userId: string): Promise<IntegrationAccount | undefined> {
  return db.integrations
    .where('userId')
    .equals(userId)
    .filter((i) => i.provider === 'linkedin_live')
    .first();
}

const isConnected = (row: IntegrationAccount | undefined): row is IntegrationAccount =>
  !!row && row.status !== 'revoked' && !!row.externalAccountId;

async function saveAccount(
  userId: string,
  patch: Partial<IntegrationAccount>,
  now = new Date(),
): Promise<IntegrationAccount> {
  const existing = await liveLinkedInAccount(userId);
  const row: IntegrationAccount = {
    scopes: [],
    syncState: {},
    ...existing,
    id: existing?.id ?? newId('int'),
    userId,
    provider: 'linkedin_live',
    status: 'active',
    // a reconnect after a disconnect is a new connection
    connectedAt: existing && existing.status !== 'revoked' ? existing.connectedAt : now.toISOString(),
    ...patch,
  };
  await db.integrations.put(row);
  return row;
}

// how the hosted sign-in is waited on; tests shorten it
let poll = { everyMs: 2000, tries: 150 };
export function setLivePollForTests(p: { everyMs: number; tries: number } | undefined): void {
  poll = p ?? { everyMs: 2000, tries: 150 };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Connect the student's LinkedIn live and bring their connections in. Opens Unipile's hosted sign-in in a popup and
 * waits for it to finish (the sample student skips the popup), records the account, then runs the first sync.
 */
export async function connectLinkedInLive(
  user: User,
  opts: { onProgress?: (count: number) => void; signal?: AbortSignal } = {},
): Promise<LiveConnectResult> {
  if (isServerUser(user.id)) return connectViaServer(user, opts);
  let accountId: string | undefined;
  let accessToken: string | undefined;
  if (usesMockConnectors(user.id)) accountId = MOCK_ACCOUNT_ID;
  else {
    if (!unipileConfigured()) return { ok: false, reason: 'unconfigured', message: LIVE_SOON };
    const start = await startLinkedInConnect({ signal: opts.signal });
    if (!start.ok)
      return start.reason === 'unconfigured'
        ? { ok: false, reason: 'unconfigured', message: LIVE_SOON }
        : { ok: false, reason: 'error', message: start.message };
    const win =
      typeof window !== 'undefined'
        ? window.open(start.value.url, 'orbit-linkedin', 'width=520,height=680')
        : null;
    if (!win)
      return {
        ok: false,
        reason: 'error',
        message: 'Your browser blocked the LinkedIn window. Allow pop-ups for Orbit and try again.',
      };
    let closedChecks = 0;
    for (let i = 0; i < poll.tries && !accountId; i++) {
      await sleep(poll.everyMs, opts.signal);
      if (opts.signal?.aborted) break;
      const st = await linkedInConnectStatus(start.value.ref, { signal: opts.signal });
      if (st.ok && st.value.status === 'connected' && st.value.accountId) {
        accountId = st.value.accountId;
        accessToken = st.value.token;
      } else if (st.ok && st.value.status === 'error') {
        closeQuietly(win);
        return {
          ok: false,
          reason: 'error',
          message: st.value.message ?? 'LinkedIn sign-in did not finish.',
        };
      } else if (!st.ok && st.reason === 'unconfigured') {
        closeQuietly(win);
        return { ok: false, reason: 'unconfigured', message: LIVE_SOON };
      }
      // the student closed the window without finishing: give Unipile two more looks, then stop
      if (!accountId && win.closed && ++closedChecks > 2)
        return {
          ok: false,
          reason: 'cancelled',
          message: 'The LinkedIn window was closed before sign-in finished.',
        };
    }
    closeQuietly(win);
    if (opts.signal?.aborted)
      return { ok: false, reason: 'cancelled', message: 'Stopped connecting LinkedIn.' };
    if (!accountId) return { ok: false, reason: 'error', message: 'LinkedIn sign-in timed out. Try again.' };
  }
  await saveAccount(user.id, {
    externalAccountId: accountId,
    accessToken,
    status: 'active',
    lastError: undefined,
  });
  const r = await syncLinkedInLive(user, opts);
  if (r.ok) return { ok: true, rows: r.rows, added: r.added };
  return {
    ok: false,
    reason: r.reason === 'unconfigured' ? 'unconfigured' : 'error',
    message: r.reason === 'unconfigured' ? LIVE_SOON : r.message,
  };
}

/**
 * Account mode: orbit-api opens Unipile's hosted sign-in (the webhook finishes the link on the server), Orbit waits
 * for /linkedin/status to say it is active, and the connections arrive with the next pull.
 */
async function connectViaServer(
  user: User,
  opts: { onProgress?: (count: number) => void; signal?: AbortSignal },
): Promise<LiveConnectResult> {
  const start = await callApi('/linkedin/connect/start', {}, { signal: opts.signal });
  if (!start.ok)
    return start.reason === 'unconfigured'
      ? {
          ok: false,
          reason: 'unconfigured',
          message: "Live LinkedIn isn't set up on Orbit's server yet. Upload your export for now.",
        }
      : { ok: false, reason: 'error', message: start.message };
  const win =
    typeof window !== 'undefined'
      ? window.open(start.value.url, 'orbit-linkedin', 'width=520,height=680')
      : null;
  if (!win)
    return {
      ok: false,
      reason: 'error',
      message: 'Your browser blocked the LinkedIn window. Allow pop-ups for Orbit and try again.',
    };
  let closedChecks = 0;
  for (let i = 0; i < poll.tries; i++) {
    await sleep(poll.everyMs, opts.signal);
    if (opts.signal?.aborted)
      return { ok: false, reason: 'cancelled', message: 'Stopped connecting LinkedIn.' };
    const st = await callApi('/linkedin/status', {}, { signal: opts.signal });
    if (st.ok && st.value.status === 'active') {
      closeQuietly(win);
      await saveAccount(user.id, {
        externalAccountId: st.value.accountId ?? 'orbit-api',
        status: 'active',
        lastError: undefined,
        lastSyncedAt: st.value.lastSyncedAt ?? undefined,
        syncState: { rows: st.value.relations, server: true },
      });
      opts.onProgress?.(st.value.relations);
      return { ok: true, rows: st.value.relations, added: st.value.relations };
    }
    if (st.ok && (st.value.status === 'error' || st.value.status === 'needs_reauth')) {
      closeQuietly(win);
      return { ok: false, reason: 'error', message: 'LinkedIn sign-in did not finish. Try again.' };
    }
    if (win.closed && ++closedChecks > 2)
      return {
        ok: false,
        reason: 'cancelled',
        message: 'The LinkedIn window was closed before sign-in finished.',
      };
  }
  closeQuietly(win);
  return { ok: false, reason: 'error', message: 'LinkedIn sign-in timed out. Try again.' };
}

function closeQuietly(win: Window | null) {
  try {
    win?.close();
  } catch {
    // the popup may already be closed
  }
}

/**
 * Pull the student's connections again and upsert them (nobody is doubled; job changes are noticed). Writes the
 * row's status and syncState, and refreshes recommendations and the brief, like an export upload does.
 */
export async function syncLinkedInLive(
  user: User,
  opts: { onProgress?: (count: number) => void; signal?: AbortSignal; now?: Date } = {},
): Promise<LiveSyncResult> {
  const row = await liveLinkedInAccount(user.id);
  if (!isConnected(row))
    return { ok: false, reason: 'not_connected', message: 'LinkedIn is not connected live yet.' };
  if (isServerUser(user.id)) {
    // account mode: the server syncs; new people arrive with the next pull
    const r = await callApi('/linkedin/sync', {}, { signal: opts.signal });
    if (!r.ok)
      return {
        ok: false,
        reason: r.reason === 'unconfigured' ? 'unconfigured' : 'error',
        message: r.message,
      };
    const rows = Number((row.syncState as { rows?: number }).rows ?? 0);
    return { ok: true, rows, added: 0, updated: 0, recommended: 0 };
  }
  let conns: LiveConnection[];
  if (usesMockConnectors(user.id)) {
    conns = await mockLinkedInConnections(user.id, opts.now);
    opts.onProgress?.(conns.length);
  } else {
    const pulled = await linkedInConnections(row.externalAccountId!, {
      token: row.accessToken,
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
    if (!pulled.ok) {
      if (pulled.reason === 'unconfigured') return { ok: false, reason: 'unconfigured', message: LIVE_SOON };
      await db.integrations.update(row.id, { status: 'error', lastError: pulled.message });
      return { ok: false, reason: 'error', message: pulled.message };
    }
    conns = pulled.value;
  }
  const r = await importLiveConnections(user, conns, (done) => opts.onProgress?.(done));
  const at = (opts.now ?? new Date()).toISOString();
  await db.integrations.update(row.id, {
    status: 'active',
    lastError: undefined,
    lastSyncedAt: at,
    // the reply reader keeps its checkpoint on this row too
    syncState: { ...row.syncState, rows: conns.length, lastSyncedAt: at },
  });
  let recommended = 0;
  if (r.imported + r.updated > 0) {
    const fresh = (await db.users.get(user.id)) ?? user;
    await recommendationsRefresh(fresh);
    recommended = await db.recommendations
      .where('userId')
      .equals(user.id)
      .filter((x) => x.status === 'new' || x.status === 'saved')
      .count();
    if (fresh.onboardingCompletedAt) await generateBrief(fresh, 'daily');
  }
  return { ok: true, rows: conns.length, added: r.imported, updated: r.updated, recommended };
}

/** Unlink LinkedIn: Unipile drops the account and Orbit stops syncing. Everyone already imported stays. */
export async function disconnectLinkedInLive(
  user: User,
): Promise<
  { ok: true; unlinkedAtUnipile: boolean } | { ok: false; reason: 'not_connected'; message: string }
> {
  const row = await liveLinkedInAccount(user.id);
  if (!isConnected(row))
    return { ok: false, reason: 'not_connected', message: 'LinkedIn is not connected live.' };
  let unlinked = true;
  if (!usesMockConnectors(user.id)) {
    const r = await disconnectLinkedInAccount(row.externalAccountId!, { token: row.accessToken });
    unlinked = r.ok;
  }
  await db.integrations.update(row.id, {
    status: 'revoked',
    externalAccountId: undefined,
    lastError: undefined,
  });
  return { ok: true, unlinkedAtUnipile: unlinked };
}

export interface LinkedInLiveStatus {
  /** live connect can be offered here */
  available: boolean;
  connected: boolean;
  status?: IntegrationAccount['status'];
  lastSyncedAt?: string;
  rows?: number;
  error?: string;
  /** the sample student's mock connector */
  demo: boolean;
  /** connected and the last sync is more than a day old */
  stale: boolean;
}

export async function linkedInLiveStatus(user: User, now = new Date()): Promise<LinkedInLiveStatus> {
  const row = await liveLinkedInAccount(user.id);
  const connected = isConnected(row);
  const rows = (row?.syncState as { rows?: unknown } | undefined)?.rows;
  const last = connected ? row.lastSyncedAt : undefined;
  return {
    available: liveLinkedInAvailable(user),
    connected,
    status: connected ? row.status : undefined,
    lastSyncedAt: last,
    rows: connected && typeof rows === 'number' ? rows : undefined,
    error: connected ? row.lastError : undefined,
    demo: usesMockConnectors(user.id),
    stale: connected && (!last || now.getTime() - Date.parse(last) > AUTO_SYNC_AFTER_MS),
  };
}

/** On app open: sync again when the last live sync is more than a day old. Does nothing otherwise. */
export async function autoSyncLinkedInLive(
  user: User,
  now = new Date(),
): Promise<LiveSyncResult | undefined> {
  const st = await linkedInLiveStatus(user, now);
  if (!st.connected || !st.stale) return undefined;
  return syncLinkedInLive(user, { now });
}

/** A mutual connection, with the Orbit person it is when Orbit knows them. */
export interface MutualView extends Mutual {
  personId?: string;
}

export type MutualsResult =
  | { ok: true; source: 'linkedin' | 'demo'; mutuals: MutualView[] }
  | {
      ok: false;
      reason: 'not_connected' | 'no_member_id' | 'unconfigured' | 'error';
      message: string;
      mutuals: [];
    };

/**
 * Who the student knows who also knows this person, from LinkedIn (live, through Unipile) or, for the sample
 * student, from the demo's own people.
 */
export async function mutualsFor(
  user: User,
  person: Person,
  opts: { signal?: AbortSignal } = {},
): Promise<MutualsResult> {
  const people = await db.people.where('userId').equals(user.id).toArray();
  const resolve = (m: Mutual): MutualView => {
    const slug = linkedInSlug(normalizeLinkedInUrl(m.url));
    const name = m.name.trim().toLowerCase();
    const byMember = m.memberId ? people.find((p) => p.linkedinMemberId === m.memberId) : undefined;
    const bySlug = slug ? people.find((p) => p.linkedinSlug === slug) : undefined;
    const byName = people.filter((p) => p.nameNormalized === name);
    const match = byMember ?? bySlug ?? (byName.length === 1 ? byName[0] : undefined);
    return { ...m, personId: match && match.id !== person.id ? match.id : undefined };
  };
  if (usesMockConnectors(user.id))
    return { ok: true, source: 'demo', mutuals: (await mockMutuals(user.id, person)).map(resolve) };
  const row = await liveLinkedInAccount(user.id);
  if (!isConnected(row))
    return {
      ok: false,
      reason: 'not_connected',
      message: 'Connect LinkedIn live to see mutual connections.',
      mutuals: [],
    };
  if (!person.linkedinMemberId)
    return {
      ok: false,
      reason: 'no_member_id',
      message: `${person.firstName} did not come from your live LinkedIn sync, so LinkedIn cannot look up mutual connections.`,
      mutuals: [],
    };
  const r = await mutualConnections(row.externalAccountId!, person.linkedinMemberId, {
    token: row.accessToken,
    signal: opts.signal,
  });
  if (!r.ok)
    return {
      ok: false,
      reason: r.reason === 'unconfigured' ? 'unconfigured' : 'error',
      message: r.reason === 'unconfigured' ? LIVE_SOON : r.message,
      mutuals: [],
    };
  return { ok: true, source: 'linkedin', mutuals: r.value.map(resolve) };
}

/**
 * Approved LinkedIn messages go out from Orbit itself: LinkedIn is connected live in this browser (or this is the
 * sample student), and Orbit knows who on LinkedIn the person is. Otherwise the student sends them on LinkedIn.
 */
export async function linkedInSendActive(
  user: User,
  person?: Pick<Person, 'linkedinMemberId' | 'linkedinSlug'>,
): Promise<boolean> {
  if (isServerUser(user.id)) return false;
  if (person && !person.linkedinMemberId && !person.linkedinSlug) return false;
  const row = await liveLinkedInAccount(user.id);
  if (!isConnected(row)) return false;
  return usesMockConnectors(user.id) || (unipileConfigured() && !!row.accessToken);
}

export type LinkedInSendResult =
  | { ok: true; invited: boolean; messageId?: string; chatId?: string }
  | { ok: false; error: string };

/**
 * Send one approved LinkedIn message from the student's own account: a message when they are connected, a
 * connection request with the text as its note otherwise. The sample student's sends go nowhere: they are recorded
 * as sent, like everything else in the demo.
 */
export async function sendLinkedInLive(
  user: User,
  person: Person,
  text: string,
  invite: boolean,
): Promise<LinkedInSendResult> {
  if (usesMockConnectors(user.id))
    return { ok: true, invited: invite, messageId: `demo-li-${Date.now().toString(36)}` };
  const row = await liveLinkedInAccount(user.id);
  if (!isConnected(row)) return { ok: false, error: 'LinkedIn is not connected. Connect it in Settings.' };
  const r = await sendLinkedInMessage(
    row.externalAccountId!,
    { memberId: person.linkedinMemberId, slug: person.linkedinSlug },
    text,
    invite,
    { token: row.accessToken },
  );
  if (!r.ok) return { ok: false, error: r.reason === 'unconfigured' ? LIVE_SOON : r.message };
  // keep the member id LinkedIn resolved, so the next message and mutual connections need no lookup
  if (r.value.memberId && !person.linkedinMemberId)
    await db.people.update(person.id, { linkedinMemberId: r.value.memberId });
  return { ok: true, invited: r.value.invited, messageId: r.value.messageId, chatId: r.value.chatId };
}
