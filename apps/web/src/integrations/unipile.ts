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
    connected_at?: string;
    member_id?: string;
  }[];
  cursor?: string | null;
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
    const r = await call<RelationsResponse>('/relations', { accountId, cursor }, opts);
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
        connectedOn: it.connected_at ? it.connected_at.slice(0, 10) : undefined,
        memberId: it.member_id,
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
  const r = await call<MutualResponse>('/mutuals', { accountId, targetMemberId }, opts);
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
  const r = await call<{ ok?: boolean }>('/disconnect', { accountId }, opts);
  if (!r.ok) return r;
  return { ok: true, value: { disconnected: r.value.ok !== false } };
}
