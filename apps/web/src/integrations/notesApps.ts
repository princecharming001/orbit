/**
 * The student's own meeting-notes and scheduling apps (Fathom, Granola, Wispr Flow, Cal.com), reached through
 * Orbit's orbit-notes server function because their APIs are not meant to be called from a browser. The student's
 * key or sign-in travels with each call and is never kept on the server. The function's address is the shared
 * Claude proxy's, with orbit-notes in place of orbit-claude, so no extra build setting is needed. Off in automated
 * browsers unless a test chooses otherwise.
 *
 * Every call returns a typed outcome instead of throwing, like the LinkedIn connector.
 */
import { automationOverride, type ConnectorOutcome, connectorFailure } from './connectorOutcome';

let override: string | null | undefined;

/** Test hook: a proxy URL to use, null for none, or undefined to restore the build-time setting. */
export function setNotesProxyUrlForTests(url: string | null | undefined): void {
  override = url;
}

export function notesProxyUrl(): string | undefined {
  if (override !== undefined) return override ?? undefined;
  if (automationOverride() !== 'live') return undefined;
  const claude = (import.meta.env.VITE_ORBIT_CLAUDE_PROXY as string | undefined)?.trim();
  if (!claude || !/\/orbit-claude\/?$/.test(claude)) return undefined;
  return claude.replace(/\/orbit-claude\/?$/, '/orbit-notes');
}

export function notesAppsAvailable(): boolean {
  return !!notesProxyUrl();
}

export const NOTES_TIMEOUT_MS = 25_000;

/** A Fathom meeting, as the server trims it. */
export interface FathomMeeting {
  id: string;
  title: string;
  url?: string;
  startAt?: string;
  invitees: { name?: string; email?: string; external?: boolean }[];
  recordedBy?: string;
  summary?: string;
  actionItems: { text: string; done: boolean; assignee?: string }[];
}

export interface CalEventType {
  id: number | string;
  title: string;
  slug: string;
  minutes?: number;
  hidden: boolean;
  url: string;
}

/** Why an app said no, in the words the page shows; `bad_key` lets the page ask for the key again. */
export type NotesFailure = {
  ok: false;
  reason: 'bad_key' | 'unconfigured' | 'timeout' | 'error';
  message: string;
};

async function call<T>(
  path: string,
  body: Record<string, unknown>,
  opts: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ConnectorOutcome<T> | NotesFailure> {
  const base = notesProxyUrl();
  if (!base) return connectorFailure('unconfigured', 'This copy of Orbit cannot reach other apps yet.');
  const doFetch = opts.fetch ?? fetch;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, NOTES_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (res.status === 429)
      return connectorFailure('error', 'Too many requests right now. Try again in a minute.');
    if (!res.ok) return connectorFailure('error', `The app did not answer (${res.status}).`, res.status);
    const j = (await res.json()) as { ok?: boolean; reason?: string; message?: string } & T;
    if (j.ok === false)
      return {
        ok: false,
        reason: j.reason === 'bad_key' ? 'bad_key' : 'error',
        message: j.message ?? 'The app said no.',
      };
    return { ok: true, value: j };
  } catch (e) {
    if (timedOut) return connectorFailure('timeout', 'The app took too long to answer. Try again.');
    if (opts.signal?.aborted) return connectorFailure('error', 'Stopped.');
    return connectorFailure('error', e instanceof Error ? e.message : 'Could not reach the app.');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** How a call reaches the app: a pasted key (a plain string), or the access token from signing in. */
export type AppAuth = string | { accessToken: string };
const authBody = (auth: AppAuth) =>
  typeof auth === 'string' ? { apiKey: auth } : { accessToken: auth.accessToken };

/** Which apps Orbit can sign in to (its OAuth client ids); null where only a pasted key works. */
export function oauthClients(): Promise<
  ConnectorOutcome<{ calcom: string | null; fathom: string | null }> | NotesFailure
> {
  return call('/oauth/config', {});
}

/**
 * Trade the code from the app's sign-in for tokens, or refresh them. For Cal.com and Fathom the server adds the
 * secret; Granola and Wispr Flow use Orbit's registration (client id) and the PKCE verifier, no secret.
 */
export function oauthTokens(
  body:
    | { provider: 'calcom' | 'fathom'; grant: 'code'; code: string; redirectUri: string }
    | { provider: 'calcom' | 'fathom'; grant: 'refresh'; refreshToken: string }
    | {
        provider: 'granola' | 'wispr';
        grant: 'code';
        clientId: string;
        code: string;
        redirectUri: string;
        codeVerifier: string;
      }
    | { provider: 'granola' | 'wispr'; grant: 'refresh'; clientId: string; refreshToken: string },
): Promise<
  ConnectorOutcome<{ accessToken: string; refreshToken?: string; expiresIn?: number }> | NotesFailure
> {
  return call('/oauth/token', body);
}

/**
 * Register Orbit with Granola's or Wispr Flow's sign-in server for this return address. Done by the server: their
 * sign-in servers leave the CORS header off the answer, so a browser cannot read the client id it is given.
 */
export function oauthRegister(body: {
  server: 'granola' | 'wispr';
  redirectUri: string;
  scope: string;
}): Promise<ConnectorOutcome<{ clientId: string }> | NotesFailure> {
  return call('/oauth/register', body);
}

/** One page of the student's Fathom meetings, newest first. */
export function fathomMeetingsPage(
  auth: AppAuth,
  q: { createdAfter?: string; cursor?: string },
  opts: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ConnectorOutcome<{ meetings: FathomMeeting[]; nextCursor: string | null }> | NotesFailure> {
  return call(
    '/fathom/meetings',
    { ...authBody(auth), createdAfter: q.createdAfter, cursor: q.cursor },
    opts,
  );
}

/** The student's Cal.com username and event types, each with its booking link. */
export function calEventTypes(
  auth: AppAuth,
  opts: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ConnectorOutcome<{ username?: string; eventTypes: CalEventType[] }> | NotesFailure> {
  return call('/calcom/event-types', authBody(auth), opts);
}

/** What one tool call on a meeting app's MCP server answered: its text, and its structured result when it has one. */
export interface McpResult {
  ok: boolean;
  text?: string;
  structured?: unknown;
}

/**
 * Up to ten read-only tool calls on Granola's or Wispr Flow's meeting server, in one session, with the token from
 * signing in. `list` also returns the names of the tools the server offers.
 */
export function mcpCall(
  server: 'granola' | 'wispr',
  accessToken: string,
  calls: { name: string; arguments?: Record<string, unknown> }[],
  opts: { list?: boolean; fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ConnectorOutcome<{ tools?: string[]; results: McpResult[] }> | NotesFailure> {
  return call('/mcp/call', { server, accessToken, calls, list: opts.list }, opts);
}
