/**
 * Unipile (live LinkedIn): an optional way to connect a student's own LinkedIn account through Unipile's hosted
 * login and pull their connections live, instead of uploading the Connections.csv export, plus "who do I know who
 * knows X" (mutual connections) for real second-degree routes. It is reached through Orbit's own server function
 * (supabase/functions/orbit-connectors), which holds the Unipile API key; the browser never sees it. Off unless the
 * build sets VITE_ORBIT_LINKEDIN_PROXY. The CSV import stays as the always-available fallback.
 *
 * Every call returns a typed outcome instead of throwing: `unconfigured` when the proxy answers 503 with
 * x-orbit-connector: unconfigured (the key is not pasted yet), `timeout` when Unipile is slow, `error` otherwise. The
 * sample student never reaches this file: engine/linkedinLive.ts answers it from integrations/connectorsMock.ts.
 *
 * All request and response shapes are mapped here behind one adapter, so a real Unipile key and a live test only
 * ever need changes in this file. Connections come back in the same shape the CSV parser produces.
 */
import {
  automationOverride,
  type ConnectorOutcome,
  connectorFailure,
  isUnconfigured,
} from './connectorOutcome';

let override: string | null | undefined;

/** Test hook: a proxy URL to use, null for none, or undefined to restore the build-time setting. */
export function setUnipileUrlForTests(url: string | null | undefined): void {
  override = url;
}

/** Stands in for the proxy when a test asks for the "key not pasted yet" answer; never fetched. */
export const UNCONFIGURED_PROXY = 'unconfigured:';

export function unipileUrl(): string | undefined {
  if (override !== undefined) return override ?? undefined;
  const mode = automationOverride();
  if (mode === 'unconfigured') return UNCONFIGURED_PROXY;
  if (mode !== 'live') return undefined;
  const url = (import.meta.env.VITE_ORBIT_LINKEDIN_PROXY as string | undefined)?.trim();
  return url ? url.replace(/\/+$/, '') : undefined;
}

export function unipileConfigured(): boolean {
  return !!unipileUrl();
}

/** How long one Unipile call may take before Orbit gives up on it. */
export const UNIPILE_TIMEOUT_MS = 20_000;

/** A connection as Unipile returns it, mapped to the fields the CSV import uses. */
export interface LiveConnection {
  firstName: string;
  lastName: string;
  position?: string;
  company?: string;
  url?: string;
  /** YYYY-MM-DD, when Unipile gives the connected date */
  connectedOn?: string;
  /** Unipile's member id, kept so mutual-connection lookups can reference this person */
  memberId?: string;
  /** their LinkedIn photo (a link that expires after a few weeks) */
  photoUrl?: string;
}

/** One mutual connection: someone in the student's network who is connected to the target. */
export interface Mutual {
  name: string;
  headline?: string;
  url?: string;
  memberId?: string;
}

export interface CallOpts {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** the account token /connect/status gave this browser; the server refuses account calls without it */
  token?: string;
}

/** One POST to the proxy, as an outcome: never throws. */
async function call<T>(path: string, body: unknown, opts: CallOpts = {}): Promise<ConnectorOutcome<T>> {
  const base = unipileUrl();
  if (!base) return connectorFailure('unconfigured', 'Live LinkedIn is not set up in this copy of Orbit.');
  if (base === UNCONFIGURED_PROXY)
    return connectorFailure('unconfigured', 'Live LinkedIn is not switched on yet.', 503);
  const doFetch = opts.fetch ?? fetch;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs ?? UNIPILE_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    if (isUnconfigured(res))
      return connectorFailure('unconfigured', 'Live LinkedIn is not switched on yet.', res.status);
    if (!res.ok) return connectorFailure('error', `LinkedIn did not answer (${res.status}).`, res.status);
    return { ok: true, value: (await res.json()) as T };
  } catch (e) {
    if (timedOut) return connectorFailure('timeout', 'LinkedIn took too long to answer. Try again.');
    if (opts.signal?.aborted) return connectorFailure('error', 'Stopped.');
    return connectorFailure('error', e instanceof Error ? e.message : 'Could not reach LinkedIn.');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Begin connecting a LinkedIn account: the server asks Unipile for a hosted-auth link the student opens to sign in.
 * Gives the URL to open and an opaque reference to poll for the account to become ready.
 */
export async function startLinkedInConnect(
  opts: CallOpts = {},
): Promise<ConnectorOutcome<{ url: string; ref: string }>> {
  const r = await call<{ url?: string; ref?: string }>('/connect/start', {}, opts);
  if (!r.ok) return r;
  if (!r.value.url || !r.value.ref)
    return connectorFailure('error', 'Could not start the LinkedIn connection.');
  return { ok: true, value: { url: r.value.url, ref: r.value.ref } };
}

export interface ConnectStatus {
  status: 'pending' | 'connected' | 'error';
  accountId?: string;
  /** proof this browser finished the sign-in: sent with every later call about the account */
  token?: string;
  message?: string;
}

/** Whether a started connection has finished signing in, and the account id once it has. */
export async function linkedInConnectStatus(
  ref: string,
  opts: CallOpts = {},
): Promise<ConnectorOutcome<ConnectStatus>> {
  const r = await call<ConnectStatus>('/connect/status', { ref }, opts);
  if (!r.ok) return r;
  const status = r.value.status;
  return {
    ok: true,
    value: {
      status: status === 'connected' || status === 'error' ? status : 'pending',
      accountId: r.value.accountId,
      token: r.value.token,
      message: r.value.message,
    },
  };
}

interface RelationsResponse {
  items?: {
    first_name?: string;
    last_name?: string;
    headline?: string;
    position?: string;
    company?: string;
    public_profile_url?: string;
    profile_url?: string;
    /** ISO text from Orbit's server (older servers passed Unipile's value through, sometimes a number) */
    connected_at?: string | number;
    picture_url?: string;
    member_id?: string;
  }[];
  cursor?: string | null;
}

/** "2026-03-27" from an ISO date, or from epoch milliseconds or seconds. */
export function connectedDay(v: string | number | undefined): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : /^\d+$/.test(v) ? Number(v) : Number.NaN;
  const t = Number.isFinite(n) ? (n > 1e12 ? n : n * 1000) : Date.parse(String(v));
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

/** At most this many pages (200 connections each) per sync: a runaway cursor never loops for ever. */
const MAX_PAGES = 200;

/** Pull every connection for a connected account, mapped to the CSV import shape. Pages until done. */
export async function linkedInConnections(
  accountId: string,
  opts: CallOpts & { onProgress?: (count: number) => void } = {},
): Promise<ConnectorOutcome<LiveConnection[]>> {
  const out: LiveConnection[] = [];
  let cursor: string | null | undefined;
  let pages = 0;
  do {
    const r = await call<RelationsResponse>('/relations', { accountId, token: opts.token, cursor }, opts);
    if (!r.ok) return r;
    for (const it of r.value.items ?? []) {
      const name = `${it.first_name ?? ''} ${it.last_name ?? ''}`.trim();
      if (!name) continue;
      out.push({
        firstName: it.first_name ?? name.split(' ')[0] ?? '',
        lastName: it.last_name ?? name.split(' ').slice(1).join(' '),
        position: it.position ?? it.headline,
        company: it.company,
        url: it.public_profile_url ?? it.profile_url,
        connectedOn: connectedDay(it.connected_at),
        memberId: it.member_id,
        photoUrl: it.picture_url,
      });
    }
    opts.onProgress?.(out.length);
    cursor = r.value.cursor ?? undefined;
    pages++;
  } while (cursor && pages < MAX_PAGES);
  return { ok: true, value: out };
}

interface MutualResponse {
  mutuals?: { name?: string; headline?: string; url?: string; member_id?: string }[];
  count?: number;
}

/** Who the student knows who is connected to a target LinkedIn member. */
export async function mutualConnections(
  accountId: string,
  targetMemberId: string,
  opts: CallOpts = {},
): Promise<ConnectorOutcome<Mutual[]>> {
  const r = await call<MutualResponse>('/mutuals', { accountId, token: opts.token, targetMemberId }, opts);
  if (!r.ok) return r;
  return {
    ok: true,
    value: (r.value.mutuals ?? [])
      .filter((m) => m.name)
      .map((m) => ({ name: m.name!, headline: m.headline, url: m.url, memberId: m.member_id })),
  };
}

/** Unlink the account at Unipile. People already imported stay in Orbit. */
export async function disconnectLinkedInAccount(
  accountId: string,
  opts: CallOpts = {},
): Promise<ConnectorOutcome<{ disconnected: boolean }>> {
  const r = await call<{ ok?: boolean }>('/disconnect', { accountId, token: opts.token }, opts);
  if (!r.ok) return r;
  return { ok: true, value: { disconnected: r.value.ok !== false } };
}

export interface LinkedInSent {
  /** a connection request went out with the text as its note, rather than a message */
  invited: boolean;
  messageId?: string;
  chatId?: string;
  /** their LinkedIn member id, as Unipile resolved it */
  memberId?: string;
}

/**
 * Send one approved message from the student's own LinkedIn: a message to a connection, or, with `invite`, a
 * connection request carrying the text as its note. Who it goes to is their member id when Orbit has it, else their
 * public profile name.
 */
export async function sendLinkedInMessage(
  accountId: string,
  to: { memberId?: string; slug?: string },
  text: string,
  invite: boolean,
  opts: CallOpts = {},
): Promise<ConnectorOutcome<LinkedInSent>> {
  const r = await call<{
    ok?: boolean;
    message?: string;
    invited?: boolean;
    messageId?: string;
    chatId?: string;
    memberId?: string;
  }>('/send', { accountId, token: opts.token, memberId: to.memberId, slug: to.slug, text, invite }, opts);
  if (!r.ok) return r;
  if (r.value.ok === false) return connectorFailure('error', r.value.message ?? 'LinkedIn did not send it.');
  return {
    ok: true,
    value: {
      invited: !!r.value.invited,
      messageId: r.value.messageId,
      chatId: r.value.chatId,
      memberId: r.value.memberId,
    },
  };
}

/** One message in the student's 1:1 LinkedIn chats, and who the other person is. */
export interface LinkedInInboxMessage {
  id: string;
  chatId: string;
  text: string;
  at?: string;
  /** the student wrote it */
  fromMe: boolean;
  counterpart: { providerId?: string; name?: string };
}

interface InboxResponse {
  messages?: Partial<LinkedInInboxMessage>[];
  latest?: string | null;
}

/**
 * The student's LinkedIn messages since `after`, both ways, from 1:1 chats only (groups are not one person's reply).
 * `latest` is the newest message time LinkedIn returned, the checkpoint for the next read.
 */
export async function linkedInInbox(
  accountId: string,
  after: Date,
  opts: CallOpts = {},
): Promise<ConnectorOutcome<{ messages: LinkedInInboxMessage[]; latest?: string }>> {
  const r = await call<InboxResponse>(
    '/inbox',
    { accountId, token: opts.token, after: after.toISOString() },
    { timeoutMs: 45_000, ...opts },
  );
  if (!r.ok) return r;
  return {
    ok: true,
    value: {
      messages: (r.value.messages ?? [])
        .filter((m) => typeof m.text === 'string' && m.text.trim() && m.id && m.chatId)
        .map((m) => ({
          id: String(m.id),
          chatId: String(m.chatId),
          text: m.text!.trim(),
          at: m.at,
          fromMe: !!m.fromMe,
          counterpart: { providerId: m.counterpart?.providerId, name: m.counterpart?.name },
        })),
      latest: r.value.latest ?? undefined,
    },
  };
}

/**
 * The messages the student sent on LinkedIn since `after` (1:1 chats only): what Orbit learns the student's own
 * voice from. Only the text and time come back; who they were to is not needed here.
 */
export async function linkedInSentMessages(
  accountId: string,
  after: Date,
  opts: CallOpts = {},
): Promise<ConnectorOutcome<{ text: string; at?: string }[]>> {
  const r = await linkedInInbox(accountId, after, opts);
  if (!r.ok) return r;
  return {
    ok: true,
    value: r.value.messages.filter((m) => m.fromMe).map((m) => ({ text: m.text, at: m.at })),
  };
}

/** One person a LinkedIn search found. */
export interface LinkedInFound {
  memberId: string;
  name: string;
  headline?: string;
  location?: string;
  profileUrl?: string;
  /** 1 = a connection, 2 = a friend of a friend, 3 = further out */
  distance?: number;
  /** their LinkedIn photo (a link that expires after a few weeks) */
  pictureUrl?: string;
}

export interface LinkedInSearchQuery {
  keywords?: string;
  title?: string;
  company?: string;
  school?: string;
  location?: string;
  /** which degrees to search; second and third by default, so the results are people the student does not know */
  distance?: (1 | 2 | 3)[];
  cursor?: string;
}

/** Search LinkedIn people from the student's own account, beyond their connections. */
export async function searchLinkedIn(
  accountId: string,
  q: LinkedInSearchQuery,
  opts: CallOpts = {},
): Promise<ConnectorOutcome<{ people: LinkedInFound[]; cursor?: string; total?: number }>> {
  const r = await call<{
    ok?: boolean;
    message?: string;
    people?: LinkedInFound[];
    cursor?: string | null;
    total?: number;
  }>('/search', { accountId, token: opts.token, ...q }, { timeoutMs: 30_000, ...opts });
  if (!r.ok) return r;
  if (r.value.ok === false) return connectorFailure('error', r.value.message ?? 'LinkedIn did not search.');
  return {
    ok: true,
    value: { people: r.value.people ?? [], cursor: r.value.cursor ?? undefined, total: r.value.total },
  };
}

/** The student's own LinkedIn profile; `picture` is the photo itself (a data: URL), since LinkedIn's links expire. */
export interface LinkedInMe {
  firstName?: string;
  lastName?: string;
  headline?: string;
  publicIdentifier?: string;
  picture?: string;
}

export function linkedInMe(accountId: string, opts: CallOpts = {}): Promise<ConnectorOutcome<LinkedInMe>> {
  return call<LinkedInMe>('/me', { accountId, token: opts.token }, opts);
}
