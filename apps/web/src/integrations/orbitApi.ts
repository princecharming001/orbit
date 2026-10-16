/**
 * Account mode's client for orbit-api (plan 16 §11.3, §12.3): a typed call per route over the contract in
 * `@orbit/core` (server/api.ts), the Orbit session, and Google sign-in from the app's side.
 *
 * Account mode is on only when the build sets `VITE_ORBIT_API`. Without it, `isAccountMode()` is false and nothing in
 * this file runs: local mode, the demo and every existing test behave as before.
 *
 * End-to-end tests turn account mode on without a second build: a browser under automation (navigator.webdriver) that
 * sets `window.__ORBIT_API__` before the app loads uses that base instead, and the test answers every request with
 * `page.route` (see e2e/account.spec.ts). A normal browser never has navigator.webdriver, so the switch cannot be used
 * to point a person's app at another server.
 *
 * Sessions: the access token (1 hour) stays in memory; the refresh token sits in the `orbit-local` IndexedDB (the
 * prefs database, never part of the data export). A call refreshes 5 minutes before expiry and retries once after a
 * 401. Refresh tokens rotate on every use, so tabs refresh one at a time (a Web Lock where there is one) and tell
 * each other the new pair on a BroadcastChannel.
 */
import type {
  AutonomyRequest,
  BookRequest,
  BookResponse,
  DraftApproveRequest,
  DraftComposeRequest,
  DraftIdRequest,
  DraftResponse,
  DueResponse,
  GoalsInferRequest,
  GoalsInferResponse,
  GoalsListResponse,
  GoalUpsertRequest,
  GoalUpsertResponse,
  GoogleSyncRequest,
  IdRequest,
  IntroAskRequest,
  IntroAskResponse,
  LinkedinConnectStartResponse,
  LinkedinStatusResponse,
  MemoryAddRequest,
  MemoryAddResponse,
  MemoryExtractRequest,
  MemoryExtractResponse,
  MemoryListResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  PathsFindRequest,
  PathsFindResponse,
  PauseRequest,
  ProfileSettingsRequest,
  ProfileSettingsResponse,
  QueuedResponse,
  RepliesListResponse,
  ReplyDraftRequest,
  ResearchChooseRequest,
  ResearchGetRequest,
  ResearchGetResponse,
  ResearchPersonRequest,
  ResearchPersonResponse,
  ScoreExplainRequest,
  ScoreExplainResponse,
  ScoreLabelRequest,
  SlotsRequest,
  SlotsResponse,
  SourceAddRequest,
  SourceAddResponse,
  SourceSearchRequest,
  SourceSearchResponse,
} from '@orbit/core';
import { readLocalRow, writeLocalRow } from './prefs';

// ---- the account the server knows ----------------------------------------------------------------------------------

/** The signed-in user as orbit-api returns it (/auth/session, /auth/me). */
export interface AccountUser {
  id: string;
  email: string;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  school: string | null;
  gradYear: number | null;
  timezone: string;
  autonomyLevel: number;
  settings: Record<string, unknown>;
  onboarding: Record<string, unknown>;
  createdAt: string;
}

export interface SessionResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  user: AccountUser;
}

/** One integration as /sync/status reports it. */
export interface SyncIntegration {
  provider: string;
  status: string;
  email: string | null;
  scopes: string[];
  linked: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  watchExpiresAt: string | null;
  backfill: { phase: string | null; done: number; total: number | null } | null;
}

/** POST /sync/status */
export interface SyncStatus {
  counts: Partial<
    Record<
      'people' | 'organizations' | 'threads' | 'messages' | 'events' | 'ties' | 'goals' | 'chats' | 'drafts',
      number
    >
  >;
  integrations: SyncIntegration[];
  jobs: { pending: number };
}

/** POST /sync/pull */
export interface SyncPullRequest {
  cursor?: string;
  tables?: string[];
  limit?: number;
}
export interface SyncPullResponse {
  changes: Record<string, Record<string, unknown>[]>;
  deleted: Record<string, string[]>;
  cursor: string;
  hasMore: boolean;
}

/** One change for POST /sync/push */
export interface PushChange {
  table: string;
  op: 'upsert' | 'delete';
  id: string;
  row?: Record<string, unknown>;
}
export interface PushResult {
  table: string | null;
  id: string | null;
  ok: boolean;
  row?: Record<string, unknown>;
  error?: { code: string; message: string };
}

/** Every route the client calls: [request body, response body]. */
export interface ApiRoutes {
  '/auth/logout': [{ refreshToken?: string }, { ok: boolean }];
  '/auth/me': [Record<string, never>, { user: AccountUser }];
  '/sync/status': [Record<string, never>, SyncStatus];
  '/sync/pull': [SyncPullRequest, SyncPullResponse];
  '/sync/push': [{ changes: PushChange[] }, { results: PushResult[] }];
  '/account/export': [Record<string, never>, { exportedAt: string; format: string; data: unknown }];
  '/account/delete': [{ confirm: 'DELETE' }, { deleted: boolean }];
  '/google/sync': [GoogleSyncRequest, QueuedResponse];
  '/linkedin/connect/start': [Record<string, never>, LinkedinConnectStartResponse];
  '/linkedin/status': [Record<string, never>, LinkedinStatusResponse];
  '/linkedin/sync': [Record<string, never>, QueuedResponse];
  '/goals/list': [Record<string, never>, GoalsListResponse];
  '/goals/upsert': [GoalUpsertRequest, GoalUpsertResponse];
  '/goals/archive': [IdRequest, unknown];
  '/goals/infer': [GoalsInferRequest, GoalsInferResponse];
  '/scores/explain': [ScoreExplainRequest, ScoreExplainResponse];
  '/scores/label': [ScoreLabelRequest, unknown];
  '/research/person': [ResearchPersonRequest, ResearchPersonResponse];
  '/research/get': [ResearchGetRequest, ResearchGetResponse];
  '/research/choose': [ResearchChooseRequest, ResearchPersonResponse];
  '/source/search': [SourceSearchRequest, SourceSearchResponse];
  '/source/add': [SourceAddRequest, SourceAddResponse];
  '/paths/find': [PathsFindRequest, PathsFindResponse];
  '/intros/ask': [IntroAskRequest, IntroAskResponse];
  '/drafts/compose': [DraftComposeRequest, DraftResponse];
  '/drafts/approve': [DraftApproveRequest, DraftResponse];
  '/drafts/cancel': [DraftIdRequest, DraftResponse];
  '/drafts/discard': [DraftIdRequest, DraftResponse];
  '/replies/list': [Record<string, never>, RepliesListResponse];
  '/replies/draft': [ReplyDraftRequest, DraftResponse];
  '/calendar/slots': [SlotsRequest, SlotsResponse];
  '/calendar/book': [BookRequest, BookResponse];
  '/memory/search': [MemorySearchRequest, MemorySearchResponse];
  '/memory/add': [MemoryAddRequest, MemoryAddResponse];
  '/memory/list': [Record<string, never>, MemoryListResponse];
  '/memory/forget': [IdRequest, unknown];
  '/memory/extract': [MemoryExtractRequest, MemoryExtractResponse];
  '/settings/autonomy': [AutonomyRequest, unknown];
  '/settings/pause': [PauseRequest, unknown];
  '/settings/profile': [ProfileSettingsRequest, ProfileSettingsResponse];
  '/cadence/due': [Record<string, never>, DueResponse];
}
export type ClientRoute = keyof ApiRoutes;

// ---- results ------------------------------------------------------------------------------------------------------

/**
 * Why a call has no value:
 * - `off`: this build has no Orbit server (local mode)
 * - `signed_out`: no session, or it ended; sign in with Google again
 * - `unconfigured`: the server is missing a key for this (503, `x-orbit-connector: unconfigured`)
 * - `rate_limited`: too many requests (429)
 * - `network`: the server could not be reached
 * - `error`: any other refusal, with the server's plain message
 */
export type ApiFailureReason = 'off' | 'signed_out' | 'unconfigured' | 'rate_limited' | 'network' | 'error';

export interface ApiFailure {
  ok: false;
  reason: ApiFailureReason;
  /** plain words for the student; never a code */
  message: string;
  status?: number;
  /** the server's error code, for callers that branch on it (never shown) */
  code?: string;
  /** for `unconfigured`: what the server is missing */
  missing?: string[];
}
export type ApiResult<T> = { ok: true; value: T } | ApiFailure;

export const SIGN_IN_FIRST =
  'That needs an Orbit account. Sign in with Google first (Settings, Account), then ask again.';
export const NO_SERVER =
  'That needs an Orbit account, and this copy of Orbit runs only on your device, so it is not available here.';

function failure(
  reason: ApiFailureReason,
  message: string,
  extra: Partial<Omit<ApiFailure, 'ok' | 'reason' | 'message'>> = {},
): ApiFailure {
  return { ok: false, reason, message, ...extra };
}

// ---- the server's address -----------------------------------------------------------------------------------------

let baseOverride: string | null | undefined;

/** Unit-test hook: the base to use (null = off); undefined restores the build's. */
export function setOrbitApiBaseForTests(base: string | null | undefined): void {
  baseOverride = base;
}

const trimBase = (s: string | undefined) => s?.trim().replace(/\/+$/, '') || undefined;

/** orbit-api's base URL, or undefined in local mode. */
export function orbitApiBase(): string | undefined {
  if (baseOverride !== undefined) return baseOverride ?? undefined;
  const env = trimBase(import.meta.env.VITE_ORBIT_API as string | undefined);
  if (env) return env;
  if (typeof navigator !== 'undefined' && navigator.webdriver) {
    const g = globalThis as { __ORBIT_API__?: unknown };
    if (typeof g.__ORBIT_API__ === 'string') return trimBase(g.__ORBIT_API__);
  }
  return undefined;
}

/** Account mode: this build talks to an Orbit server. Off unless VITE_ORBIT_API is set. */
export function isAccountMode(): boolean {
  return !!orbitApiBase();
}

/** Where the app lives, as the sign-in redirect wants it (origin + base path, no trailing slash). */
export function appBaseUrl(): string {
  const base = (import.meta.env.BASE_URL as string | undefined) ?? '/';
  return `${window.location.origin}${base}`.replace(/\/+$/, '');
}

// ---- transport ----------------------------------------------------------------------------------------------------

let fetchImpl: typeof fetch | undefined;

/** Unit-test hook: the fetch every call goes through; undefined restores the global one. */
export function setOrbitApiFetchForTests(f: typeof fetch | undefined): void {
  fetchImpl = f;
}

const doFetch: typeof fetch = (input, init) => (fetchImpl ?? globalThis.fetch)(input, init);

const REQUEST_TIMEOUT_MS = 25_000;
/** refresh this long before the access token expires */
export const REFRESH_BEFORE_MS = 5 * 60_000;

async function rawCall(
  route: string,
  body: unknown,
  opts: { token?: string; method?: 'GET' | 'POST'; signal?: AbortSignal } = {},
): Promise<Response | ApiFailure> {
  const base = orbitApiBase();
  if (!base) return failure('off', NO_SERVER);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const method = opts.method ?? 'POST';
  if (method === 'POST') headers['content-type'] = 'application/json';
  const timeout =
    typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
      ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      : undefined;
  const signal =
    opts.signal && timeout && 'any' in AbortSignal
      ? AbortSignal.any([opts.signal, timeout])
      : (opts.signal ?? timeout);
  try {
    return await doFetch(`${base}${route}`, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) return failure('network', 'Stopped.');
    void e;
    return failure('network', "Orbit's server could not be reached. Check your connection and try again.");
  }
}

async function readBody(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/** The server's message when it reads as plain words; a code or a stack never reaches the screen. */
function plainServerMessage(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t || t.length > 200 || /[_{}<>]|\b[a-z]+\.[a-z]+\(/.test(t)) return undefined;
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.?]$/.test(t) ? '' : '.'}`;
}

async function interpret<T>(res: Response): Promise<ApiResult<T>> {
  const body = (await readBody(res)) as { error?: { code?: string; message?: string; missing?: string[] } };
  if (res.ok) return { ok: true, value: body as T };
  const code = body?.error?.code;
  if (res.status === 503 && res.headers.get('x-orbit-connector') === 'unconfigured')
    return failure('unconfigured', "That part of Orbit's server is not set up yet.", {
      status: 503,
      code: 'unconfigured',
      missing: body?.error?.missing,
    });
  if (res.status === 401)
    return failure('signed_out', 'Your Orbit session ended. Sign in with Google again.', {
      status: 401,
      code,
    });
  if (res.status === 429)
    return failure(
      'rate_limited',
      res.headers.get('x-orbit-limit') === 'day'
        ? "You've hit today's limit for that. It resets tomorrow."
        : 'Orbit is getting a lot of requests. Try again in a minute.',
      { status: 429, code },
    );
  const said = plainServerMessage(body?.error?.message);
  return failure(
    'error',
    said ??
      (res.status >= 500
        ? "Orbit's server had a problem. Try again in a moment."
        : 'Orbit could not do that.'),
    { status: res.status, code },
  );
}

// ---- the session ---------------------------------------------------------------------------------------------------

const SESSION_ROW = 'orbit-session';
const CHANNEL = 'orbit-session';

interface StoredSession {
  refreshToken: string;
  user: AccountUser;
}

interface Tokens {
  accessToken?: string;
  expiresAt?: string;
  refreshToken?: string;
}

let tokens: Tokens = {};
let account: AccountUser | undefined;
let loaded: Promise<void> | undefined;
let refreshing: Promise<boolean> | undefined;
let channel: BroadcastChannel | undefined;
const listeners = new Set<() => void>();

type SessionMessage =
  | { type: 'tokens'; accessToken: string; expiresAt: string; refreshToken: string; user?: AccountUser }
  | { type: 'signed_out' };

function emit(): void {
  for (const l of listeners) l();
}

function ensureChannel(): void {
  if (channel || typeof BroadcastChannel === 'undefined') return;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e: MessageEvent<SessionMessage>) => {
      const m = e.data;
      if (m?.type === 'tokens') {
        tokens = { accessToken: m.accessToken, expiresAt: m.expiresAt, refreshToken: m.refreshToken };
        if (m.user) account = m.user;
        emit();
      } else if (m?.type === 'signed_out') {
        tokens = {};
        account = undefined;
        emit();
      }
    };
    (channel as unknown as { unref?: () => void }).unref?.();
  } catch {
    channel = undefined;
  }
}

function announce(m: SessionMessage): void {
  try {
    channel?.postMessage(m);
  } catch {}
}

/** Read the stored session (refresh token and user) once. Safe to call repeatedly. */
export function loadSession(): Promise<void> {
  ensureChannel();
  loaded ??= (async () => {
    if (!isAccountMode()) return;
    const stored = await readLocalRow<StoredSession>(SESSION_ROW);
    if (stored?.refreshToken && !tokens.refreshToken) {
      tokens = { ...tokens, refreshToken: stored.refreshToken };
      account = stored.user;
      emit();
    }
  })();
  return loaded;
}

/** Signed in to Orbit in this browser (a refresh token is held). Synchronous: `loadSession()` runs at startup. */
/** The current access token, when signed in and not yet expired; the chat's shared access counts spend by it. */
export function currentAccessToken(): string | undefined {
  return isAccountMode() &&
    tokens.accessToken &&
    tokens.expiresAt &&
    Date.parse(tokens.expiresAt) > Date.now()
    ? tokens.accessToken
    : undefined;
}

export function isSignedIn(): boolean {
  return isAccountMode() && !!(tokens.refreshToken || tokens.accessToken);
}

/** The signed-in Orbit user, if any. */
export function accountUser(): AccountUser | undefined {
  return isSignedIn() ? account : undefined;
}

/** Called whenever the session changes in this tab or another. Returns an unsubscribe. */
export function subscribeSession(listener: () => void): () => void {
  ensureChannel();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function adopt(
  s: { accessToken: string; refreshToken: string; expiresAt: string },
  user?: AccountUser,
) {
  tokens = { accessToken: s.accessToken, refreshToken: s.refreshToken, expiresAt: s.expiresAt };
  if (user) account = user;
  if (account)
    await writeLocalRow(SESSION_ROW, { refreshToken: s.refreshToken, user: account } satisfies StoredSession);
  announce({ type: 'tokens', ...s, user: account });
  emit();
}

/** Forget the session in this tab, the stored copy and every other tab. */
export async function clearSession(): Promise<void> {
  tokens = {};
  account = undefined;
  await writeLocalRow(SESSION_ROW, undefined);
  announce({ type: 'signed_out' });
  emit();
}

/** Run `fn` while holding the cross-tab refresh lock (a Web Lock where the browser has them). */
function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (typeof navigator !== 'undefined' ? navigator.locks : undefined) as LockManager | undefined;
  if (locks?.request) return locks.request('orbit-session-refresh', fn) as Promise<T>;
  return fn();
}

function fresh(t: Tokens, now = Date.now()): boolean {
  return !!t.accessToken && !!t.expiresAt && Date.parse(t.expiresAt) - now > REFRESH_BEFORE_MS;
}

/**
 * Get a new access token with the refresh token. One refresh at a time per tab, and one at a time across tabs: the
 * refresh token rotates on every use, so the tab that waited reads the stored token again and, if another tab already
 * refreshed (its new pair arrived on the channel), uses that instead of refreshing a spent token.
 */
export function refreshSession(opts: { force?: boolean } = {}): Promise<boolean> {
  const before = tokens.accessToken;
  refreshing ??= withRefreshLock(async () => {
    const stored = await readLocalRow<StoredSession>(SESSION_ROW);
    // another tab refreshed while this one waited for the lock
    if (tokens.accessToken && tokens.accessToken !== before && fresh(tokens)) return true;
    if (!opts.force && fresh(tokens)) return true;
    const refreshToken = stored?.refreshToken ?? tokens.refreshToken;
    if (!refreshToken) return false;
    if (stored?.user) account = stored.user;
    const res = await rawCall('/auth/refresh', { refreshToken });
    if (!(res instanceof Response)) return false;
    if (res.status === 401) {
      // spent or revoked; unless another tab stored a newer one meanwhile, the session is over
      const now = await readLocalRow<StoredSession>(SESSION_ROW);
      if (now?.refreshToken && now.refreshToken !== refreshToken) {
        tokens = { refreshToken: now.refreshToken };
        return false;
      }
      await clearSession();
      return false;
    }
    const r = await interpret<{ accessToken: string; refreshToken: string; expiresAt: string }>(res);
    if (!r.ok) return false;
    await adopt(r.value);
    return true;
  }).finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

/**
 * Call an orbit-api route with the session: a token about to expire is refreshed first, and a 401 refreshes once and
 * retries. Never throws; the failure says why in plain words.
 */
export async function callApi<R extends ClientRoute>(
  route: R,
  body: ApiRoutes[R][0],
  opts: { signal?: AbortSignal } = {},
): Promise<ApiResult<ApiRoutes[R][1]>> {
  if (!isAccountMode()) return failure('off', NO_SERVER);
  await loadSession();
  if (!isSignedIn()) return failure('signed_out', SIGN_IN_FIRST);
  if (!fresh(tokens)) {
    const ok = await refreshSession();
    if (!ok && !isSignedIn())
      return failure('signed_out', 'Your Orbit session ended. Sign in with Google again.');
    if (!ok) return failure('network', "Orbit's server could not be reached. Try again in a moment.");
  }
  const method = route === '/auth/me' ? 'GET' : 'POST';
  let res = await rawCall(route, body, { token: tokens.accessToken, method, signal: opts.signal });
  if (!(res instanceof Response)) return res;
  if (res.status === 401) {
    await res.body?.cancel().catch(() => undefined);
    const ok = await refreshSession({ force: true });
    if (!ok)
      return failure('signed_out', 'Your Orbit session ended. Sign in with Google again.', { status: 401 });
    res = await rawCall(route, body, { token: tokens.accessToken, method, signal: opts.signal });
    if (!(res instanceof Response)) return res;
    if (res.status === 401) {
      await clearSession();
      return failure('signed_out', 'Your Orbit session ended. Sign in with Google again.', { status: 401 });
    }
  }
  return interpret<ApiRoutes[R][1]>(res);
}

// ---- Google sign-in -------------------------------------------------------------------------------------------------

/** Where "Continue with Google" goes: orbit-api starts Google's consent screen and comes back to /auth/done. */
export function googleSignInUrl(appUrl = appBaseUrl()): string | undefined {
  const base = orbitApiBase();
  if (!base) return undefined;
  return `${base}/auth/google/start?redirect=${encodeURIComponent(appUrl)}`;
}

/** Leave for Google. The page unloads; the sign-in finishes at /auth/done. */
export function startGoogleSignIn(): void {
  const url = googleSignInUrl();
  if (url) window.location.assign(url);
}

/** Plain words for each way a sign-in can come back without a session. */
export function signInErrorText(error: string): string {
  switch (error) {
    case 'access_denied':
      return "Google didn't let you in. Access is invite-only during the pilot, so if you're not on the list yet, you can use Orbit without Google for now.";
    case 'email_unverified':
      return "Google says that email address isn't verified yet. Verify it with Google, then try again.";
    case 'account_deleted':
      return 'That Orbit account is being deleted. You can use Orbit without Google for now.';
    case 'invalid_state':
    case 'no_code':
    case 'bad_redirect':
    case 'expired':
      return 'That sign-in took too long or was interrupted. Try again.';
    case 'unconfigured':
      return "Google sign-in isn't set up on Orbit's server yet. You can use Orbit without Google for now.";
    case 'network':
      return "Orbit's server could not be reached. Check your connection and try again.";
    default:
      return "Google sign-in didn't finish. Try again in a moment.";
  }
}

export type SignInOutcome = { ok: true; user: AccountUser } | { ok: false; error: string; message: string };

/** Read `#code=…` or `#error=…` from the /auth/done address. */
export function parseAuthFragment(hash: string): { code?: string; error?: string } {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const code = p.get('code') ?? undefined;
  const error = p.get('error') ?? undefined;
  if (code) return { code };
  return { error: error ?? 'no_code' };
}

/** Finish a sign-in: trade the one-time code from the fragment for a session and keep it. */
export async function completeSignIn(hash: string): Promise<SignInOutcome> {
  const { code, error } = parseAuthFragment(hash);
  if (!code) {
    const e = error ?? 'no_code';
    return { ok: false, error: e, message: signInErrorText(e) };
  }
  const res = await rawCall('/auth/session', { code });
  if (!(res instanceof Response)) {
    const e = res.reason === 'off' ? 'unconfigured' : 'network';
    return { ok: false, error: e, message: signInErrorText(e) };
  }
  const r = await interpret<SessionResponse>(res);
  if (!r.ok) {
    const e = r.reason === 'unconfigured' ? 'unconfigured' : r.status === 401 ? 'expired' : 'sign_in_failed';
    return { ok: false, error: e, message: signInErrorText(e) };
  }
  await adopt(r.value, r.value.user);
  return { ok: true, user: r.value.user };
}

/** Sign out: the server revokes this session, then this browser forgets it. Local data stays. */
export async function signOutAccount(): Promise<void> {
  if (isSignedIn() && tokens.accessToken) {
    await rawCall('/auth/logout', { refreshToken: tokens.refreshToken }, { token: tokens.accessToken }).catch(
      () => undefined,
    );
  }
  await clearSession();
}

/** Test hook: forget everything in memory (the stored row stays). */
export function resetSessionForTests(): void {
  tokens = {};
  account = undefined;
  loaded = undefined;
  refreshing = undefined;
  listeners.clear();
}

/** Test hook: what the session holds in memory. */
export function sessionTokensForTests(): Readonly<Tokens> {
  return { ...tokens };
}

/** This local user is the signed-in Orbit account: its data comes from the server, which also scores it. */
export function isServerUser(userId: string | undefined): boolean {
  return !!userId && isSignedIn() && accountUser()?.id === userId;
}
