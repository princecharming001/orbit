/**
 * Plan 44 §4.3: how every roles reader asks a job board for something. Orbit's posting user agent, a timeout, a cap on
 * the bytes read, and a short backoff on 429 and 5xx (Retry-After when the site gives one). Never throws: every way
 * a request can go wrong comes back as a typed failure the caller can record.
 */
import type { JobListing } from '../../../../../packages/core/src/roles/types.ts';
import { POSTING_USER_AGENT } from '../../postings.ts';
import type { RoleNet } from '../contracts.ts';

export interface ReaderNet extends RoleNet {
  /** waits between retries and pages; tests pass one that returns at once */
  sleep?: (ms: number) => Promise<void>;
  /** per request; 15 s unless set */
  timeoutMs?: number;
}

export type FailReason =
  | 'not_found'
  | 'refused'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'too_large'
  | 'bad_shape';

export interface ReadFailure {
  ok: false;
  reason: FailReason;
  status?: number;
  message: string;
  /** what was read, or what the site said it would send, when it was too large */
  bytes?: number;
}

export type Got<T> = { ok: true; value: T; bytes: number } | ReadFailure;

/** A board's roles as one reader read them. */
export type BoardRead =
  | {
      ok: true;
      listings: JobListing[];
      bytes: number;
      /** false when the reader stopped at its page cap: roles it did not reach are not closed */
      complete: boolean;
      /** the company's name as the board says it (Greenhouse) */
      companyName?: string;
      requests: number;
    }
  | (ReadFailure & { requests?: number });

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 8_000_000;
const MAX_WAIT_MS = 20_000;

export const sleepFor = (net: ReaderNet) =>
  net.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

export const fail = (reason: FailReason, message: string, status?: number, bytes?: number): ReadFailure => ({
  ok: false,
  reason,
  message,
  status,
  bytes,
});

async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number } | number> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (declared && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return declared;
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    const bytes = new TextEncoder().encode(text).length;
    return bytes > maxBytes ? bytes : { text, bytes };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return size;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return { text: new TextDecoder().decode(all), bytes: size };
}

export interface AskOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  maxBytes?: number;
  /** retries after a 429, a 5xx or a network failure (2 unless set) */
  retries?: number;
  accept?: string;
  headers?: Record<string, string>;
}

/** One request, read as text. */
export async function askText(net: ReaderNet, url: string, o: AskOptions = {}): Promise<Got<string>> {
  const retries = o.retries ?? 2;
  const sleep = sleepFor(net);
  let last: ReadFailure = fail('network', 'not asked');
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await net.fetch(url, {
        method: o.method ?? 'GET',
        headers: {
          'user-agent': POSTING_USER_AGENT,
          accept: o.accept ?? 'application/json',
          ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...o.headers,
        },
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
        signal: AbortSignal.timeout(net.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (e) {
      last = fail('network', e instanceof Error ? e.message.slice(0, 200) : 'fetch failed');
      if (attempt < retries) await sleep(1000 * 3 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel().catch(() => undefined);
      last = fail(res.status === 429 ? 'rate_limited' : 'server', `HTTP ${res.status}`, res.status);
      if (attempt < retries) {
        const after = Number(res.headers.get('retry-after') ?? '');
        await sleep(Math.min(MAX_WAIT_MS, after > 0 ? after * 1000 : 1000 * 3 ** attempt));
      }
      continue;
    }
    if (res.status === 404 || res.status === 410) {
      await res.body?.cancel().catch(() => undefined);
      return fail('not_found', `HTTP ${res.status}`, res.status);
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      return fail('refused', `HTTP ${res.status}`, res.status);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return fail('bad_shape', `HTTP ${res.status}`, res.status);
    }
    try {
      const got = await readCapped(res, o.maxBytes ?? DEFAULT_MAX_BYTES);
      if (typeof got === 'number')
        return fail('too_large', `larger than ${o.maxBytes ?? DEFAULT_MAX_BYTES} bytes`, 200, got);
      return { ok: true, value: got.text, bytes: got.bytes };
    } catch (e) {
      last = fail('network', e instanceof Error ? e.message.slice(0, 200) : 'read failed');
    }
  }
  return last;
}

/** One request, read as JSON. */
export async function askJson(net: ReaderNet, url: string, o: AskOptions = {}): Promise<Got<unknown>> {
  const got = await askText(net, url, o);
  if (!got.ok) return got;
  try {
    return { ok: true, value: JSON.parse(got.value), bytes: got.bytes };
  } catch {
    return fail('bad_shape', 'not JSON', 200, got.bytes);
  }
}

// ---- small readers of loose JSON -------------------------------------------------------------------------------------

export type Obj = Record<string, unknown>;
export const obj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim()
    ? v.trim().replace(/\s+/g, ' ')
    : typeof v === 'number'
      ? String(v)
      : undefined;
export const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};
/** An ISO time from a date string or epoch milliseconds, or undefined. */
export const isoOf = (v: unknown): string | undefined => {
  if (v == null || v === '') return undefined;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v).replace(' UTC', 'Z').replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};
