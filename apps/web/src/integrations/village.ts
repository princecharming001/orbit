/**
 * Village (warm intros): an optional source of real intro paths to a person or company, with a warmth score and the
 * person who could make the introduction. It is reached through Orbit's own server function (supabase/functions/
 * orbit-village), which holds the Village API key; the browser never sees it. Off unless the build sets
 * VITE_ORBIT_VILLAGE_PROXY and the student opted in. When it has nothing, or is not configured, Orbit's own graph
 * answers instead, so the route finder always works.
 *
 * The request and response are mapped here behind one adapter, so when the founder adds a real Village key and we
 * test live, any shape difference is a change in this file alone.
 */

let override: string | null | undefined;

/** Test hook: a proxy URL to use, null for none, or undefined to restore the build-time setting. */
export function setVillageUrlForTests(url: string | null | undefined): void {
  override = url;
}

export function villageUrl(): string | undefined {
  if (override !== undefined) return override ?? undefined;
  if (typeof navigator !== 'undefined' && navigator.webdriver) return undefined;
  const url = (import.meta.env.VITE_ORBIT_VILLAGE_PROXY as string | undefined)?.trim();
  return url ? url.replace(/\/+$/, '') : undefined;
}

export function villageConfigured(): boolean {
  return !!villageUrl();
}

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
  paths?: {
    introducer?: { name?: string; headline?: string; linkedin_url?: string };
    warmth?: number;
    hops?: string[];
    note?: string;
  }[];
}

/**
 * Ask Village for warm paths to a target. Returns an empty array when Village is not configured, has nothing, or
 * errors, so a caller can always fall back to the local graph. A short timeout keeps the chat responsive.
 */
export async function villagePaths(
  target: VillageTarget,
  opts: { signal?: AbortSignal; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<VillagePath[]> {
  const base = villageUrl();
  if (!base) return [];
  if (!target.name && !target.company) return [];
  const doFetch = opts.fetch ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  if (opts.signal) opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
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
    if (!res.ok) return [];
    const body = (await res.json()) as VillageResponse;
    return (body.paths ?? [])
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
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
