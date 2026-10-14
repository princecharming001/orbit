/**
 * The HTTP core every provider adapter shares: a timeout per attempt (AbortController), up to three retries on 429,
 * 5xx and network failures (Retry-After when the provider sends one, otherwise 1 s, 2 s, 4 s with jitter), and a Zod
 * check of the body. Failures come back as a typed result, never as a throw, so callers can mark a dossier partial or
 * a provider unconfigured and carry on. Pure: fetch, sleep, the clock and randomness are all injected.
 */
import type { z } from './zod';

/** Milliseconds since the epoch. */
export type Clock = () => number;

export interface ProviderOptions {
  fetch: typeof fetch;
  apiKey?: string;
  baseUrl?: string;
  clock?: Clock;
  /** waits between retries; tests pass an instant one */
  sleep?: (ms: number) => Promise<void>;
  /** jitter source in [0, 1) */
  random?: () => number;
  /** per-attempt timeout, default 15 s */
  timeoutMs?: number;
  /** retries after the first attempt, default 3 (capped at 3) */
  maxRetries?: number;
}

export type ProviderErrorKind =
  | 'unconfigured'
  | 'http'
  | 'timeout'
  | 'network'
  | 'invalid'
  | 'budget_exceeded';

export interface ProviderError {
  ok: false;
  kind: ProviderErrorKind;
  provider: string;
  status?: number;
  message: string;
}

export type ProviderResult<T> = { ok: true; value: T } | ProviderError;

export function unconfigured(provider: string, what = 'API key'): ProviderError {
  return { ok: false, kind: 'unconfigured', provider, message: `${provider}: no ${what} configured` };
}

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry-After as milliseconds: delta-seconds or an HTTP date; capped at 30 s so one call never stalls a job. */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(30_000, secs * 1000);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.min(30_000, Math.max(0, at - now));
  return undefined;
}

/** 1 s, 2 s, 4 s, each with up to 25% added jitter. */
export function backoffMs(attempt: number, random: () => number): number {
  const base = 1000 * 2 ** Math.min(attempt, 2);
  return Math.round(base * (1 + 0.25 * random()));
}

export interface RequestSpec<S extends z.ZodType> {
  provider: string;
  url: string;
  method?: 'GET' | 'POST' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  schema: S;
  /** statuses that are not errors but an empty answer (e.g. Village 404 = no paths); the value is `onEmpty()` */
  emptyOn?: number[];
  onEmpty?: () => z.output<S>;
}

/** Call a JSON endpoint with timeouts, retries and validation. */
export async function requestJson<S extends z.ZodType>(
  opts: ProviderOptions,
  spec: RequestSpec<S>,
): Promise<ProviderResult<z.output<S>>> {
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const clock = opts.clock ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRetries = Math.min(3, Math.max(0, opts.maxRetries ?? 3));
  const headers: Record<string, string> = { accept: 'application/json', ...(spec.headers ?? {}) };
  if (spec.body !== undefined) headers['content-type'] = 'application/json';

  let last: ProviderError = { ok: false, kind: 'network', provider: spec.provider, message: 'not attempted' };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    let res: Response;
    try {
      res = await opts.fetch(spec.url, {
        method: spec.method ?? (spec.body === undefined ? 'GET' : 'POST'),
        headers,
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      last = timedOut
        ? { ok: false, kind: 'timeout', provider: spec.provider, message: `${spec.provider}: timed out` }
        : {
            ok: false,
            kind: 'network',
            provider: spec.provider,
            message: `${spec.provider}: ${e instanceof Error ? e.message : 'network error'}`,
          };
      if (attempt < maxRetries) await sleep(backoffMs(attempt, random));
      continue;
    }
    clearTimeout(timer);

    if (spec.emptyOn?.includes(res.status) && spec.onEmpty) return { ok: true, value: spec.onEmpty() };
    if (res.status === 429 || res.status >= 500) {
      last = {
        ok: false,
        kind: 'http',
        provider: spec.provider,
        status: res.status,
        message: `${spec.provider} ${res.status}`,
      };
      if (attempt < maxRetries)
        await sleep(retryAfterMs(res.headers.get('retry-after'), clock()) ?? backoffMs(attempt, random));
      continue;
    }
    if (!res.ok)
      return {
        ok: false,
        kind: 'http',
        provider: spec.provider,
        status: res.status,
        message: `${spec.provider} ${res.status}`,
      };
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, kind: 'invalid', provider: spec.provider, message: `${spec.provider}: not JSON` };
    }
    const parsed = spec.schema.safeParse(json);
    if (!parsed.success)
      return {
        ok: false,
        kind: 'invalid',
        provider: spec.provider,
        message: `${spec.provider}: unexpected response (${parsed.error.issues[0]?.path.join('.') ?? '?'})`,
      };
    return { ok: true, value: parsed.data };
  }
  return last;
}

/** Query string from a flat record; arrays repeat the key (`a[]=1&a[]=2` when `bracket`), undefined is skipped. */
export function query(params: Record<string, unknown>, bracketArrays = false): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const x of v)
        parts.push(`${encodeURIComponent(bracketArrays ? `${k}[]` : k)}=${encodeURIComponent(String(x))}`);
    } else parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

/** Hex SHA-256 (Web Crypto, present in Deno and Node). */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');
}

/** JSON with sorted object keys, so equal requests hash equally whatever order their fields were built in. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The research-cache key for a provider request: sha-256 of provider + request JSON (§5.2 step 7). */
export function cacheKey(provider: string, request: unknown): Promise<string> {
  return sha256Hex(`${provider}:${stableJson(request)}`);
}
