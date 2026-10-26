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
import {
  differentLinkedInProfiles,
  linkedInSlug,
  newId,
  normalizeLinkedInUrl,
  peopleNamed,
} from '@orbit/core';
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
  type LinkedInAccountHealth,
  type LiveConnection,
  linkedInAccountHealth,
  linkedInConnections,
  linkedInConnectStatus,
  linkedInMe,
  type Mutual,
  mutualConnections,
  sendLinkedInMessage,
  startLinkedInConnect,
  unipileConfigured,
} from '../integrations/unipile';
import { endActivity, progressActivity, startActivity } from './activity';
import { generateBrief, recommendationsRefresh } from './brief';
import { importLiveConnections } from './linkedin';
// (a cycle: linkedinActivity reads the account row from here; neither uses the other while loading)
import { syncLinkedInActivity } from './linkedinActivity';

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

// how the hosted sign-in is waited on; tests shorten it. LinkedIn may ask the student to approve the sign-in in its
// app, and Unipile reports the new account a while after its window closes, so Orbit keeps waiting for 15 minutes.
let poll = { everyMs: 2000, tries: 450 };
export function setLivePollForTests(p: { everyMs: number; tries: number } | undefined): void {
  poll = p ?? { everyMs: 2000, tries: 450 };
}

/** Where connecting and reading LinkedIn stands, for the banner every page shows while it runs. */
export interface LinkedInProgress {
  phase: 'signin' | 'finishing' | 'reading' | 'analyzing' | 'done' | 'failed';
  /** connections read so far, or people added */
  count?: number;
  /** while analyzing: LinkedIn messages read so far (the 1:1 chat history, for closeness) */
  messages?: number;
  message?: string;
  at: number;
}
let progress: LinkedInProgress | undefined;
const progressListeners = new Set<() => void>();
export function linkedInProgress(): LinkedInProgress | undefined {
  return progress;
}
export function subscribeLinkedInProgress(fn: () => void): () => void {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}
function setProgress(p: Omit<LinkedInProgress, 'at'> | undefined): void {
  progress = p && { ...p, at: Date.now() };
  for (const fn of progressListeners) fn();
}
export function clearLinkedInProgress(): void {
  setProgress(undefined);
}

/** A sign-in that was started and not finished, kept so a reload picks the wait back up. */
const PENDING_KEY = 'orbit.linkedin.pending';
const PENDING_MAX_MS = 15 * 60_000;
function savePending(userId: string, ref: string | undefined): void {
  try {
    if (ref) localStorage.setItem(PENDING_KEY, JSON.stringify({ userId, ref, at: Date.now() }));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    // storage may be off; the wait then only lasts this visit
  }
}
function readPending(userId: string): string | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null') as {
      userId?: string;
      ref?: string;
      at?: number;
    } | null;
    if (!v?.ref || v.userId !== userId || !v.at || Date.now() - v.at > PENDING_MAX_MS) return undefined;
    return v.ref;
  } catch {
    return undefined;
  }
}

/**
 * A sign-in started before a reload: wait for Unipile's report of the account in the background, then finish
 * connecting and read the connections. Does nothing when no sign-in is pending.
 */
export async function resumeLinkedInConnect(user: User): Promise<LiveConnectResult | undefined> {
  if (isServerUser(user.id) || usesMockConnectors(user.id) || !unipileConfigured()) return undefined;
  const ref = readPending(user.id);
  if (!ref) return undefined;
  if (isConnected(await liveLinkedInAccount(user.id))) {
    savePending(user.id, undefined);
    return undefined;
  }
  setProgress({ phase: 'finishing' });
  for (let i = 0; i < poll.tries; i++) {
    const st = await linkedInConnectStatus(ref);
    if (st.ok && st.value.status === 'connected' && st.value.accountId) {
      savePending(user.id, undefined);
      return finishConnect(user, st.value.accountId, st.value.token, {});
    }
    if (st.ok && st.value.status === 'error') break;
    if (!readPending(user.id)) break;
    await sleep(poll.everyMs);
  }
  savePending(user.id, undefined);
  setProgress({
    phase: 'failed',
    message: 'LinkedIn sign-in did not finish. Turn LinkedIn on again in Settings.',
  });
  return undefined;
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
    savePending(user.id, start.value.ref);
    setProgress({ phase: 'signin' });
    for (let i = 0; i < poll.tries && !accountId; i++) {
      await sleep(poll.everyMs, opts.signal);
      if (opts.signal?.aborted) break;
      // the window closed: LinkedIn may still be waiting on the student's approval in its app, and Unipile reports
      // the new account a little after its success page closes, so Orbit keeps waiting
      if (win.closed && progress?.phase === 'signin') setProgress({ phase: 'finishing' });
      const st = await linkedInConnectStatus(start.value.ref, { signal: opts.signal });
      if (st.ok && st.value.status === 'connected' && st.value.accountId) {
        accountId = st.value.accountId;
        accessToken = st.value.token;
      } else if (st.ok && st.value.status === 'error') {
        closeQuietly(win);
        return failed(user.id, st.value.message ?? 'LinkedIn sign-in did not finish.');
      } else if (!st.ok && st.reason === 'unconfigured') {
        closeQuietly(win);
        savePending(user.id, undefined);
        setProgress(undefined);
        return { ok: false, reason: 'unconfigured', message: LIVE_SOON };
      }
    }
    closeQuietly(win);
    if (opts.signal?.aborted) {
      savePending(user.id, undefined);
      setProgress(undefined);
      return { ok: false, reason: 'cancelled', message: 'Stopped connecting LinkedIn.' };
    }
    if (!accountId)
      return failed(
        user.id,
        win.closed
          ? 'LinkedIn sign-in did not finish. If LinkedIn asked you to approve the sign-in in its app, do that, then turn LinkedIn on again.'
          : 'LinkedIn sign-in timed out. Try again.',
      );
    savePending(user.id, undefined);
  }
  if (!accountId) return failed(user.id, 'LinkedIn sign-in did not finish. Try again.');
  return finishConnect(user, accountId, accessToken, opts);
}

function failed(userId: string, message: string): LiveConnectResult {
  savePending(userId, undefined);
  setProgress({ phase: 'failed', message });
  return { ok: false, reason: 'error', message };
}

/** The account is linked: save it, take the student's photo, read their connections, then look for who to meet. */
async function finishConnect(
  user: User,
  accountId: string,
  accessToken: string | undefined,
  opts: { onProgress?: (count: number) => void; signal?: AbortSignal },
): Promise<LiveConnectResult> {
  await saveAccount(user.id, {
    externalAccountId: accountId,
    accessToken,
    status: 'active',
    lastError: undefined,
  });
  // the student's LinkedIn photo becomes their picture in Orbit straight away, before the connections import
  if (!usesMockConnectors(user.id))
    await adoptLinkedInPhoto(user.id, accountId, accessToken, { replace: true });
  // (a finished sync starts the enrichment waterfall in the background: see syncLinkedInLive)
  const r = await syncLinkedInLive(user, opts);
  if (r.ok) return { ok: true, rows: r.rows, added: r.added };
  setProgress({ phase: 'failed', message: r.message });
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
  startActivity('linkedin-sync', 'Reading your LinkedIn');
  try {
    const r = await syncLinkedInLiveOnce(user, {
      ...opts,
      onProgress: (count) => {
        progressActivity('linkedin-sync', count, { text: 'Reading your LinkedIn connections' });
        opts.onProgress?.(count);
      },
    });
    // then, in the background: profiles, logos and schools for the people the student knows, and LinkedIn for the
    // ones known only from mail and texts (engine/enrichment)
    if (r.ok) void import('./enrichment').then((m) => m.scheduleEnrichment(user)).catch(() => undefined);
    return r;
  } catch (e) {
    // something LinkedIn sent that Orbit could not read: say so on the row instead of failing silently
    const message = `The sync stopped partway (${e instanceof Error ? e.message : 'unexpected answer'}). Try Sync now.`;
    setProgress({ phase: 'failed', message });
    const row = await liveLinkedInAccount(user.id);
    if (row) await db.integrations.update(row.id, { lastError: message });
    return { ok: false, reason: 'error', message };
  } finally {
    endActivity('linkedin-sync');
  }
}

async function syncLinkedInLiveOnce(
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
  setProgress({ phase: 'reading', count: 0 });
  const reading = (n: number) => {
    setProgress({ phase: 'reading', count: n });
    opts.onProgress?.(n);
  };
  if (usesMockConnectors(user.id)) {
    conns = await mockLinkedInConnections(user.id, opts.now);
    reading(conns.length);
  } else {
    const pulled = await linkedInConnections(row.externalAccountId!, {
      token: row.accessToken,
      signal: opts.signal,
      onProgress: reading,
    });
    // a student who connected before photos were kept gets theirs now
    // (in the background: the sync does not wait on it)
    if (pulled.ok)
      void adoptLinkedInPhoto(user.id, row.externalAccountId!, row.accessToken).catch(() => false);
    if (!pulled.ok) {
      if (pulled.reason === 'unconfigured') return { ok: false, reason: 'unconfigured', message: LIVE_SOON };
      await db.integrations.update(row.id, { status: 'error', lastError: pulled.message });
      setProgress({ phase: 'failed', message: pulled.message });
      return { ok: false, reason: 'error', message: pulled.message };
    }
    conns = pulled.value;
  }
  setProgress({ phase: 'analyzing', count: conns.length });
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
  // then the student's LinkedIn messages and post engagement, for closeness (a failure there never fails the sync)
  let messages = 0;
  if (!usesMockConnectors(user.id)) {
    const a = await syncLinkedInActivity(user, {
      now: opts.now,
      onProgress: (n) => setProgress({ phase: 'analyzing', count: conns.length, messages: n }),
    }).catch(() => undefined);
    if (a?.ok) messages = a.messages;
  }
  setProgress({
    phase: 'done',
    count: conns.length,
    message: `${conns.length} connections read${r.imported ? `, ${r.imported} new` : ''}${messages ? `, ${messages.toLocaleString('en-US')} messages` : ''}${recommended ? `, ${recommended} people worth meeting` : ''}.`,
  });
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
  // plan 21 §7: other people's LinkedIn activity read to weigh routes goes with the connection
  await db.engagement.where('userId').equals(user.id).delete();
  return { ok: true, unlinkedAtUnipile: unlinked };
}

/** What Settings says when LinkedIn signed the account out and Orbit can no longer read or send with it. */
export const LINKEDIN_SIGNED_OUT = 'LinkedIn signed Orbit out. Sign in again to keep it current.';

/**
 * Ask Unipile whether the connected account still works, so the switch in Settings tells the truth: signed out by
 * LinkedIn marks the row with LINKEDIN_SIGNED_OUT (the switch stays on, with Sign in again), an account Unipile no
 * longer has turns the switch off, and a working one clears an earlier signed-out mark. A failed check changes
 * nothing. The demo and an Orbit account (whose server holds the account) are not checked from here.
 */
export async function checkLinkedInAccount(user: User): Promise<LinkedInAccountHealth | undefined> {
  if (isServerUser(user.id) || usesMockConnectors(user.id) || !unipileConfigured()) return undefined;
  const row = await liveLinkedInAccount(user.id);
  if (!isConnected(row) || !row.accessToken) return undefined;
  const r = await linkedInAccountHealth(row.externalAccountId!, { token: row.accessToken });
  if (!r.ok) return undefined;
  if (r.value === 'signin')
    await db.integrations.update(row.id, { status: 'error', lastError: LINKEDIN_SIGNED_OUT });
  else if (r.value === 'gone') {
    await db.integrations.update(row.id, {
      status: 'revoked',
      externalAccountId: undefined,
      lastError: undefined,
    });
    await db.engagement.where('userId').equals(user.id).delete();
  } else if (r.value === 'connected' && row.lastError === LINKEDIN_SIGNED_OUT)
    await db.integrations.update(row.id, { status: 'active', lastError: undefined });
  return r.value;
}

export interface LinkedInLiveStatus {
  /** live connect can be offered here */
  available: boolean;
  connected: boolean;
  status?: IntegrationAccount['status'];
  lastSyncedAt?: string;
  rows?: number;
  error?: string;
  /** LinkedIn signed the account out (checkLinkedInAccount): Settings offers Sign in again */
  signedOut?: boolean;
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
    signedOut: connected && row.lastError === LINKEDIN_SIGNED_OUT,
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

/** LinkedIn's answer for a target, kept a day in db.kv under this prefix (plus user and person ids). */
// v3: answers saved before 2026-10-25 were never checked against LinkedIn's shared-connections count
export const MUTUALS_KV = 'mutuals3:';

/**
 * How long Orbit waits for LinkedIn's mutuals answer. It is several reads in a row on the server (their profile for
 * the shared count, then a page or more of "connections of" search), so it can take well over the 20 seconds a single
 * read is given; the server finishes either way, and a browser that gave up early only threw the answer away.
 */
export const MUTUALS_TIMEOUT_MS = 90_000;
let mutualsTimeoutMs = MUTUALS_TIMEOUT_MS;
export function setMutualsTimeoutForTests(ms: number | undefined): void {
  mutualsTimeoutMs = ms ?? MUTUALS_TIMEOUT_MS;
}

/** The same target asked for twice at once (the Map and the Person page): one LinkedIn read, shared. */
const mutualsInFlight = new Map<string, ReturnType<typeof mutualConnections>>();

/** LinkedIn's mutuals for a target: one read in flight per target, waited for long enough, retried once on a timeout. */
async function askMutualsOnce(
  accountId: string,
  memberId: string,
  token: string | undefined,
): ReturnType<typeof mutualConnections> {
  const key = `${accountId}|${memberId}`;
  const running = mutualsInFlight.get(key);
  if (running) return running;
  const job = (async () => {
    const ask = () => mutualConnections(accountId, memberId, { token, timeoutMs: mutualsTimeoutMs });
    const first = await ask();
    // a slow LinkedIn is usually quick the second time (its own cache is warm): one quiet retry before saying so
    return !first.ok && first.reason === 'timeout' ? ask() : first;
  })();
  mutualsInFlight.set(key, job);
  try {
    return await job;
  } finally {
    mutualsInFlight.delete(key);
  }
}

/**
 * Who the student knows who also knows this person, from LinkedIn (live, through Unipile) or, for the sample
 * student, from the demo's own people. LinkedIn's answer is kept for the day per target (and member id), so the Map,
 * the Person page and the chat ask once; who each mutual is in Orbit is matched again on every read.
 */
export async function mutualsFor(
  user: User,
  person: Person,
  opts: { signal?: AbortSignal; now?: Date } = {},
): Promise<MutualsResult> {
  const people = await db.people.where('userId').equals(user.id).toArray();
  const resolve = (m: Mutual): MutualView => {
    const slug = linkedInSlug(normalizeLinkedInUrl(m.url));
    const byMember = m.memberId ? people.find((p) => p.linkedinMemberId === m.memberId) : undefined;
    const bySlug = slug ? people.find((p) => p.linkedinSlug === slug) : undefined;
    // the shared name matcher; someone with another LinkedIn profile is someone else
    const byName = peopleNamed(people, m.name).filter(
      (p) => !differentLinkedInProfiles({ linkedinSlug: slug, linkedinMemberId: m.memberId }, p),
    );
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
  const day = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const key = `${MUTUALS_KV}${user.id}:${person.id}`;
  const kept = (await db.kv.get(key))?.value as
    | { day?: string; memberId?: string; mutuals?: Mutual[] }
    | undefined;
  if (kept?.day === day && kept.memberId === person.linkedinMemberId && kept.mutuals)
    return { ok: true, source: 'linkedin', mutuals: kept.mutuals.map(resolve) };
  // not tied to this caller's signal: another panel may be waiting on the same read, and the answer is kept a day
  const r = await askMutualsOnce(row.externalAccountId!, person.linkedinMemberId, row.accessToken);
  if (!r.ok)
    return {
      ok: false,
      reason: r.reason === 'unconfigured' ? 'unconfigured' : 'error',
      message: r.reason === 'unconfigured' ? LIVE_SOON : r.message,
      mutuals: [],
    };
  await db.kv.put({ key, value: { day, memberId: person.linkedinMemberId, mutuals: r.value } });
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

/**
 * Make the student's LinkedIn photo their picture in Orbit. On connecting it always does; on a later sync it only
 * fills a missing picture or refreshes one that came from LinkedIn (a kept image, `data:`), never a picture the
 * student got elsewhere. Quiet when LinkedIn has no photo or does not answer: the initials stay.
 */
export async function adoptLinkedInPhoto(
  userId: string,
  accountId: string,
  token: string | undefined,
  opts: { replace?: boolean; signal?: AbortSignal } = {},
): Promise<boolean> {
  const current = (await db.users.get(userId))?.avatarUrl;
  if (!opts.replace && current && !current.startsWith('data:')) return false;
  const me = await linkedInMe(accountId, { token, signal: opts.signal }).catch(() => undefined);
  if (me?.ok) await adoptLinkedInProfile(userId, me.value);
  const picture = me?.ok ? me.value.picture : undefined;
  if (!picture?.startsWith('data:image/') || picture === current) return false;
  await db.users.update(userId, { avatarUrl: picture });
  return true;
}

/** The student's own profile link, filled in from LinkedIn where they have not typed one. */
export async function adoptLinkedInProfile(userId: string, me: { publicIdentifier?: string }): Promise<void> {
  const u = await db.users.get(userId);
  if (!u || u.linkedinUrl || !me.publicIdentifier) return;
  await db.users.update(userId, { linkedinUrl: `https://www.linkedin.com/in/${me.publicIdentifier}` });
}
