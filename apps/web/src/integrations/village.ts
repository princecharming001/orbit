/**
 * Village (warm intros): an optional source of real intro paths to a person or company, with a warmth score and the
 * person who could make the introduction. It is reached through Orbit's own server function (supabase/functions/
 * orbit-connectors), which holds the Village API key; the browser never sees it. Off unless the build sets
 * VITE_ORBIT_VILLAGE_PROXY. When it has nothing, is not configured, or answers that its key is not pasted yet, Orbit's
 * own graph answers instead, so the route finder always works. The sample student's paths come from
 * integrations/connectorsMock.ts (see engine/warmIntros.ts).
 *
 * The request and response are mapped here behind one adapter, so when the founder adds a real Village key and we
 * test live, any shape difference is a change in this file alone.
 *
 * What the proxy last said is kept (`villageHealth`), so Settings can say "Village isn't set up" when the server has
 * no Village key instead of showing warm intros as on while every lookup quietly comes back empty.
 */
import {
  automationOverride,
  type ConnectorOutcome,
  connectorFailure,
  isUnconfigured,
} from './connectorOutcome';
import { UNCONFIGURED_PROXY } from './unipile';

let override: string | null | undefined;

/** Test hook: a proxy URL to use, null for none, or undefined to restore the build-time setting. */
export function setVillageUrlForTests(url: string | null | undefined): void {
  override = url;
  health = undefined;
  checked = undefined;
}

/**
 * What Orbit's server last said about Village: `ready` (it answered), `unconfigured` (no Village key, or no
 * VILLAGE_USER_EMAIL, on the server), `error` (it did not answer). Undefined until something asked.
 */
export type VillageHealth = 'ready' | 'unconfigured' | 'error';

let health: VillageHealth | undefined;
/** Village refused Orbit's key: nothing is asked of it again until then (a day), on any page. */
let refusedUntil = 0;
const REFUSED_PAUSE_MS = 24 * 60 * 60_000;
export function villageRefused(now = Date.now()): boolean {
  return refusedUntil > now;
}
export function setVillageRefusedForTests(until: number | undefined): void {
  refusedUntil = until ?? 0;
}
let checked: { at: number; p: Promise<VillageHealth> } | undefined;
const listeners = new Set<() => void>();

function setHealth(h: VillageHealth): void {
  if (h === health) return;
  health = h;
  for (const fn of listeners) fn();
}

export function villageHealth(): VillageHealth | undefined {
  return health;
}

export function subscribeVillageHealth(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const HEALTH_TTL_MS = 10 * 60_000;

/**
 * Ask the proxy whether Village is set up, without looking anyone up: an empty `/paths` request is answered
 * `unconfigured` when the server has no Village key, and with no paths (and no Village credits spent) when it has one.
 * Remembered for ten minutes.
 */
export function checkVillage(
  opts: { fetch?: typeof fetch; force?: boolean; now?: number } = {},
): Promise<VillageHealth> {
  const now = opts.now ?? Date.now();
  if (!opts.force && checked && now - checked.at < HEALTH_TTL_MS) return checked.p;
  const p = (async (): Promise<VillageHealth> => {
    const base = villageUrl();
    if (!base || base === UNCONFIGURED_PROXY) {
      setHealth('unconfigured');
      return 'unconfigured';
    }
    try {
      const res = await (opts.fetch ?? fetch)(`${base}/paths`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const h: VillageHealth = isUnconfigured(res) ? 'unconfigured' : res.ok ? 'ready' : 'error';
      setHealth(h);
      return h;
    } catch {
      setHealth('error');
      return 'error';
    }
  })();
  checked = { at: now, p };
  return p;
}

export function villageUrl(): string | undefined {
  if (override !== undefined) return override ?? undefined;
  const mode = automationOverride();
  if (mode === 'unconfigured') return UNCONFIGURED_PROXY;
  if (mode !== 'live') return undefined;
  const url = (import.meta.env.VITE_ORBIT_VILLAGE_PROXY as string | undefined)?.trim();
  return url ? url.replace(/\/+$/, '') : undefined;
}

export function villageConfigured(): boolean {
  return !!villageUrl();
}

/** What the app says when Orbit's server answers that Village has no key (or no account email) yet. */
export const VILLAGE_NOT_SET_UP =
  "Village isn't set up on Orbit's server yet, so there are no warm intro paths from it.";

/** Who to reach. A person (by name, and company or LinkedIn URL when known) or a company. */
export interface VillageTarget {
  name?: string;
  company?: string;
  linkedinUrl?: string;
}

/** One warm path Village knows: who introduces, how warm, and the hops in words. */
export interface VillagePath {
  /** the person in the student's network who could introduce them */
  introducer: { name: string; headline?: string; linkedinUrl?: string };
  /** 0 to 1, higher is warmer */
  warmth: number;
  /** the chain in words, e.g. ["You", "Mia Chen", "Daniel Okafor"] */
  hops: string[];
  /** Village's own note on the path, when it gives one */
  note?: string;
}

interface VillageResponse {
  /** the server's word for a refusal ('unauthorized': Village refused the key) or a failure ('error') */
  reason?: string;
  message?: string;
  paths?: {
    introducer?: { name?: string; headline?: string; linkedin_url?: string };
    warmth?: number;
    hops?: string[];
    note?: string;
  }[];
}

/**
 * Ask Village for warm paths to a target, as a typed outcome: `unconfigured` when the proxy says the key is not
 * pasted yet, `timeout` past the deadline, `error` for anything else. A short timeout keeps the chat responsive.
 */
export async function villageLookup(
  target: VillageTarget,
  opts: { signal?: AbortSignal; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<ConnectorOutcome<VillagePath[]>> {
  const base = villageUrl();
  if (!base) return connectorFailure('unconfigured', 'Warm intros are not set up in this copy of Orbit.');
  if (base === UNCONFIGURED_PROXY) {
    setHealth('unconfigured');
    return connectorFailure('unconfigured', VILLAGE_NOT_SET_UP, 503);
  }
  if (!target.name && !target.company) return { ok: true, value: [] };
  if (villageRefused()) return { ok: true, value: [] };
  const doFetch = opts.fetch ?? fetch;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs ?? 8000);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await doFetch(`${base}/paths`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: target.name,
        company: target.company,
        linkedin_url: target.linkedinUrl,
      }),
      signal: ctrl.signal,
    });
    if (isUnconfigured(res)) {
      setHealth('unconfigured');
      return connectorFailure('unconfigured', VILLAGE_NOT_SET_UP, res.status);
    }
    if (!res.ok) {
      setHealth('error');
      return connectorFailure('error', `Village did not answer (${res.status}).`, res.status);
    }
    const body = (await res.json()) as VillageResponse;
    if (body.reason === 'unauthorized') {
      refusedUntil = Date.now() + REFUSED_PAUSE_MS;
      setHealth('error');
      return connectorFailure('error', "Village isn't accepting Orbit's key right now.", 401);
    }
    if (body.reason === 'error') {
      setHealth('error');
      return connectorFailure('error', body.message ?? 'Village could not answer.', 502);
    }
    setHealth('ready');
    const paths = (body.paths ?? [])
      .filter((p) => p.introducer?.name)
      .map((p) => ({
        introducer: {
          name: p.introducer!.name!,
          headline: p.introducer!.headline,
          linkedinUrl: p.introducer!.linkedin_url,
        },
        warmth: typeof p.warmth === 'number' ? Math.max(0, Math.min(1, p.warmth)) : 0,
        hops: Array.isArray(p.hops) ? p.hops.filter((h): h is string => typeof h === 'string') : [],
        note: p.note,
      }))
      .sort((a, b) => b.warmth - a.warmth);
    return { ok: true, value: paths };
  } catch (e) {
    if (timedOut) return connectorFailure('timeout', 'Village took too long to answer.');
    if (!opts.signal?.aborted) setHealth('error');
    return connectorFailure('error', e instanceof Error ? e.message : 'Could not reach Village.');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Warm paths to a target, or an empty array when Village is not configured, not switched on, has nothing, or errors,
 * so a caller can always fall back to the local graph.
 */
export async function villagePaths(
  target: VillageTarget,
  opts: { signal?: AbortSignal; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<VillagePath[]> {
  const r = await villageLookup(target, opts);
  return r.ok ? r.value : [];
}
