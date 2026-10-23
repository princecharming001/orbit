/**
 * Orbit's deep research function (supabase/functions/orbit-research, docs/plan/20) from the browser: the quick brief,
 * Go deeper, this month's allowance, and the public "remove me" request. It lives next to orbit-connectors, so its
 * address is VITE_ORBIT_RESEARCH_PROXY, or the LinkedIn proxy's with orbit-connectors swapped for orbit-research.
 *
 * Every call returns a typed outcome instead of throwing. A quick brief that times out or meets a server error is
 * tried once more: the server caches the public search results for a week, so the retry costs almost nothing.
 * The sample student never reaches this file (engine/deepResearch.ts answers it with sample briefs).
 */
import { automationOverride } from './connectorOutcome';

let override: string | null | undefined;

/** Test hook: a research URL to use, null for none, or undefined to restore the build-time setting. */
export function setResearchUrlForTests(url: string | null | undefined): void {
  override = url;
}

export function researchUrl(): string | undefined {
  if (override !== undefined) return override ?? undefined;
  if (automationOverride() !== 'live') return undefined;
  const env = import.meta.env as Record<string, string | undefined>;
  const own = env.VITE_ORBIT_RESEARCH_PROXY?.trim();
  if (own) return own.replace(/\/+$/, '');
  const li = env.VITE_ORBIT_LINKEDIN_PROXY?.trim();
  if (!li || !/\/orbit-connectors\/?$/.test(li)) return undefined;
  return li.replace(/\/orbit-connectors\/?$/, '/orbit-research');
}

export interface Allowance {
  used: number;
  limit: number;
  left: number;
  /** YYYY-MM */
  month: string;
}

export interface ServerBrief {
  kind: 'quick' | 'deeper';
  content: Record<string, unknown>;
  sources: { id: string; kind?: string; url?: string; title?: string; published?: string | null }[];
  model: string | null;
  promptVersion: string;
  notes: string[];
  checked: boolean;
  strongPages: number;
  provider?: 'exa' | 'claude';
  costUsd: number;
}

export type ResearchAnswer =
  | {
      ok: true;
      status: 'ready' | 'partial';
      brief: ServerBrief;
      allowance: Allowance;
      costUsd: number;
    }
  | {
      ok: true;
      status: 'needs_disambiguation';
      candidates: { name: string; org?: string; title?: string; url: string; snippet?: string }[];
      allowance?: Allowance;
      costUsd: number;
    }
  | { ok: true; status: 'needs_anchor' | 'failed'; message: string; allowance?: Allowance; costUsd?: number };

export type ResearchFailureReason =
  | 'unconfigured'
  | 'not_linked'
  | 'limit'
  | 'busy'
  | 'suppressed'
  | 'do_not_contact'
  | 'needs_quick'
  | 'bad_request'
  | 'timeout'
  | 'error'
  | 'unavailable';

export type ResearchOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ResearchFailureReason; message: string; allowance?: Allowance };

export const QUICK_TIMEOUT_MS = 100_000;
export const DEEPER_TIMEOUT_MS = 135_000;

async function post<T>(
  path: string,
  body: unknown,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<ResearchOutcome<T>> {
  const base = researchUrl();
  if (!base)
    return {
      ok: false,
      reason: 'unconfigured',
      message: 'Deep research is not set up in this copy of Orbit.',
    };
  const doFetch = opts.fetch ?? fetch;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs ?? 20_000);
  try {
    const res = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // an empty or non-JSON body is read by its status below
    }
    if (res.status === 503 && res.headers.get('x-orbit-connector') === 'unconfigured')
      return { ok: false, reason: 'unconfigured', message: 'Deep research is not switched on yet.' };
    if (json.ok === false) {
      const reason = String(json.reason ?? 'error') as ResearchFailureReason;
      return {
        ok: false,
        reason,
        message: typeof json.message === 'string' ? json.message : 'Research did not work this time.',
        allowance: json.allowance as Allowance | undefined,
      };
    }
    if (!res.ok)
      return {
        ok: false,
        reason: res.status === 429 ? 'busy' : 'error',
        message:
          res.status === 429
            ? 'Research is busy. Try again in a moment.'
            : `Research did not answer (${res.status}).`,
      };
    return { ok: true, value: json as T };
  } catch (e) {
    if (timedOut) return { ok: false, reason: 'timeout', message: 'Research took too long. Try again.' };
    return {
      ok: false,
      reason: 'error',
      message: e instanceof Error ? e.message : 'Could not reach research.',
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface BriefBody {
  accountId: string;
  token?: string;
  person: Record<string, unknown>;
  profile?: Record<string, unknown> | null;
  posts?: { text: string; date?: string; url?: string }[];
  history?: string;
  student: Record<string, unknown>;
  chosen?: { org?: string; url?: string };
  doNotContact?: boolean;
}

const retryable = (r: ResearchOutcome<unknown>) => !r.ok && (r.reason === 'timeout' || r.reason === 'error');

/** The quick brief; a timeout or a server error is tried once more (the server's search cache makes it cheap). */
export async function quickBrief(body: BriefBody, opts: { fetch?: typeof fetch } = {}) {
  const first = await post<ResearchAnswer>('/quick', body, { ...opts, timeoutMs: QUICK_TIMEOUT_MS });
  if (!retryable(first)) return first;
  return post<ResearchAnswer>('/quick', body, { ...opts, timeoutMs: QUICK_TIMEOUT_MS });
}

/** Go deeper on a brief the quick call wrote. */
export function deeperBrief(body: BriefBody, opts: { fetch?: typeof fetch } = {}) {
  return post<ResearchAnswer>('/deeper', body, { ...opts, timeoutMs: DEEPER_TIMEOUT_MS });
}

export function researchStatus(
  accountId: string,
  token: string | undefined,
  opts: { fetch?: typeof fetch } = {},
) {
  return post<{ ok: true; allowance: Allowance; providers: { exa: boolean; claude: boolean } }>(
    '/status',
    { accountId, token },
    opts,
  );
}

/** The public "remove me" page's request. */
export function removeMe(
  body: { name: string; linkedinUrl?: string; email?: string; company?: string },
  opts: { fetch?: typeof fetch } = {},
) {
  return post<{ ok: true; message: string }>('/remove', body, opts);
}
