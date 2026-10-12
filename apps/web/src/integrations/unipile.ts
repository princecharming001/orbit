/**
 * Unipile (live LinkedIn): an optional way to connect a student's own LinkedIn account through Unipile's hosted
 * login and pull their connections live, instead of uploading the Connections.csv export, plus "who do I know who
 * knows X" (mutual connections) for real second-degree routes. It is reached through Orbit's own server function
 * (supabase/functions/orbit-linkedin), which holds the Unipile API key and the per-student account id; the browser
 * never sees them. Off unless the build sets VITE_ORBIT_LINKEDIN_PROXY and the student opted in. The CSV import
 * stays as the always-available fallback.
 *
 * All request and response shapes are mapped here behind one adapter, so a real Unipile key and a live test only
 * ever need changes in this file. Connections come back in the same shape the CSV parser produces, so they feed the
 * existing import path unchanged.
 */

let override: string | null | undefined;

/** Test hook: a proxy URL to use, null for none, or undefined to restore the build-time setting. */
export function setUnipileUrlForTests(url: string | null | undefined): void {
  override = url;
}

export function unipileUrl(): string | undefined {
  if (override !== undefined) return override ?? undefined;
  if (typeof navigator !== 'undefined' && navigator.webdriver) return undefined;
  const url = (import.meta.env.VITE_ORBIT_LINKEDIN_PROXY as string | undefined)?.trim();
  return url ? url.replace(/\/+$/, '') : undefined;
}

export function unipileConfigured(): boolean {
  return !!unipileUrl();
}

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

function base(): string {
  const b = unipileUrl();
  if (!b) throw new Error('Live LinkedIn is not set up.');
  return b;
}

async function post<T>(path: string, body: unknown, doFetch: typeof fetch, signal?: AbortSignal): Promise<T> {
  const res = await doFetch(`${base()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!res.ok) throw new Error(`live LinkedIn ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Begin connecting a LinkedIn account: the server asks Unipile for a hosted-auth link the student opens to sign in.
 * Returns the URL to open and an opaque reference the caller polls or waits on for the account to become ready.
 */
export async function startLinkedInConnect(
  doFetch: typeof fetch = fetch,
): Promise<{ url: string; ref: string }> {
  const r = await post<{ url?: string; ref?: string }>('/connect/start', {}, doFetch);
  if (!r.url || !r.ref) throw new Error('Could not start the LinkedIn connection.');
  return { url: r.url, ref: r.ref };
}

/** Whether a started connection has finished signing in, and the account id once it has. */
export async function linkedInConnectStatus(
  ref: string,
  doFetch: typeof fetch = fetch,
): Promise<{ status: 'pending' | 'connected' | 'error'; accountId?: string; message?: string }> {
  return post('/connect/status', { ref }, doFetch);
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

/** Pull every connection for a connected account, mapped to the CSV import shape. Pages until done. */
export async function linkedInConnections(
  accountId: string,
  opts: { fetch?: typeof fetch; signal?: AbortSignal; onProgress?: (count: number) => void } = {},
): Promise<LiveConnection[]> {
  const doFetch = opts.fetch ?? fetch;
  const out: LiveConnection[] = [];
  let cursor: string | null | undefined;
  do {
    const page = await post<RelationsResponse>('/relations', { accountId, cursor }, doFetch, opts.signal);
    for (const it of page.items ?? []) {
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
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return out;
}

interface MutualResponse {
  mutuals?: { name?: string; headline?: string; url?: string; member_id?: string }[];
  count?: number;
}

/**
 * Who the student knows who is connected to a target LinkedIn member. Returns an empty list when live LinkedIn is
 * off or Unipile has nothing, so a caller can fall back to the local graph.
 */
export async function mutualConnections(
  accountId: string,
  targetMemberId: string,
  doFetch: typeof fetch = fetch,
): Promise<Mutual[]> {
  if (!unipileUrl()) return [];
  try {
    const r = await post<MutualResponse>('/mutuals', { accountId, targetMemberId }, doFetch);
    return (r.mutuals ?? [])
      .filter((m) => m.name)
      .map((m) => ({ name: m.name!, headline: m.headline, url: m.url, memberId: m.member_id }));
  } catch {
    return [];
  }
}
