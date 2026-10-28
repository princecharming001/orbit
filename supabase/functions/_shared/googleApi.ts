/**
 * Google REST calls for the sync jobs (§12.3, §16.3), on top of the access tokens of google.ts.
 *
 * Pacing: one budget per user of 90 quota units in any rolling second (Gmail allows 6,000 a minute; Orbit keeps
 * ≤ 5,400) and at most 5 requests in flight. Each request names its cost in units (messages.list 5, messages.get 20,
 * threads.get 40, history.list 2, watch 100, the rest 1) and waits until the last second's spend leaves room for it.
 * Retries: 429, 5xx and Gmail's rate-limit 403s up to 3 times, honouring Retry-After or waiting 1, 2, 4 s with
 * jitter. A 401 drops the cached token and tries once more with a fresh one; a second 401 marks the account
 * needs_reauth and throws NeedsReauth. Any other failure is a GoogleApiError with the status and Google's reason.
 * fetch, the clock, sleep and randomness are injected, so tests run on virtual time.
 */
import type { Db } from './db.ts';
import { NeedsReauth, type TokenSource } from './google.ts';
import { backoffMs, retryAfterMs } from './providers/request.ts';

export const UNITS_PER_SECOND = 90;
export const MAX_IN_FLIGHT = 5;
export const MAX_RETRIES = 3;

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`google ${status} ${reason}`);
    this.name = 'GoogleApiError';
  }
}

export interface PacerOptions {
  unitsPerSecond?: number;
  maxInFlight?: number;
  /** milliseconds */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A rolling one-second quota window plus an in-flight limit. `run(units, fn)` waits for a free slot and for room in
 * the window, records the spend when the request starts, then runs it.
 */
export class QuotaPacer {
  private readonly rate: number;
  private readonly max: number;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private spent: { t: number; u: number }[] = [];
  private inFlight = 0;
  private waiting: (() => void)[] = [];

  constructor(o: PacerOptions = {}) {
    this.rate = o.unitsPerSecond ?? UNITS_PER_SECOND;
    this.max = o.maxInFlight ?? MAX_IN_FLIGHT;
    this.clock = o.clock ?? Date.now;
    this.sleep = o.sleep ?? realSleep;
  }

  async run<T>(units: number, fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await this.spend(units, fn);
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.max) {
      this.inFlight++;
      return Promise.resolve();
    }
    // the releasing request hands its slot straight to the next one in line
    return new Promise<void>((r) => this.waiting.push(r));
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.inFlight--;
  }

  /** Records the spend and starts the request in one synchronous step, so the recorded time is the start time. */
  private async spend<T>(units: number, fn: () => Promise<T>): Promise<T> {
    // one request costing more than a second's budget (watch: 100) still goes, alone in its second
    const u = Math.min(Math.max(0, units), this.rate);
    for (;;) {
      const now = this.clock();
      this.spent = this.spent.filter((e) => e.t > now - 1000);
      const used = this.spent.reduce((s, e) => s + e.u, 0);
      if (used + u <= this.rate) {
        this.spent.push({ t: now, u });
        return fn();
      }
      // wait until enough of the oldest spend has left the window
      let over = used + u - this.rate;
      let wait = 1;
      for (const e of this.spent) {
        over -= e.u;
        wait = e.t + 1000 - now;
        if (over <= 0) break;
      }
      await this.sleep(Math.max(1, wait));
    }
  }
}

export interface GoogleRequest {
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  /** quota units this call costs */
  units: number;
}

export interface GoogleClient {
  request<T>(userId: string, r: GoogleRequest): Promise<T>;
}

export interface GoogleClientDeps {
  tokens: TokenSource;
  /** for marking the account needs_reauth after a second 401 */
  db?: Db;
  fetch?: typeof fetch;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** pacers per user, shared across the jobs of one worker instance */
  pacers?: Map<string, QuotaPacer>;
}

async function reason(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: { status?: string; errors?: { reason?: string }[]; message?: string } | string;
    };
    if (typeof body.error === 'string') return body.error;
    return body.error?.errors?.[0]?.reason ?? body.error?.status ?? 'error';
  } catch {
    return 'error';
  }
}

const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'RESOURCE_EXHAUSTED']);

export function googleClient(deps: GoogleClientDeps): GoogleClient {
  const doFetch = deps.fetch ?? fetch;
  const clock = deps.clock ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  const pacers = deps.pacers ?? new Map<string, QuotaPacer>();
  const pacer = (userId: string) => {
    let p = pacers.get(userId);
    if (!p) {
      p = new QuotaPacer({ clock, sleep });
      pacers.set(userId, p);
    }
    return p;
  };

  return {
    async request<T>(userId: string, r: GoogleRequest): Promise<T> {
      let refreshed = false;
      let attempt = 0;
      for (;;) {
        const token = await deps.tokens.accessToken(userId);
        const res = await pacer(userId).run(r.units, () =>
          doFetch(r.url, {
            method: r.method ?? (r.body === undefined ? 'GET' : 'POST'),
            headers: {
              authorization: `Bearer ${token}`,
              accept: 'application/json',
              ...(r.body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            body: r.body === undefined ? undefined : JSON.stringify(r.body),
            // a call Google never answers fails the job (which is retried) instead of holding the worker
            signal: AbortSignal.timeout(30_000),
          }),
        );
        if (res.status === 401) {
          await res.body?.cancel();
          if (!refreshed) {
            deps.tokens.invalidate(userId);
            refreshed = true;
            continue;
          }
          if (deps.db)
            await deps.db.sql`
              update orbit.integration_accounts set status = 'needs_reauth', last_error = 'unauthorized'
               where user_id = ${userId}::uuid and provider = 'google'`;
          throw new NeedsReauth();
        }
        if (res.ok) return (await res.json()) as T;
        const why = res.status === 429 || res.status >= 500 ? 'retry' : await reason(res);
        const retryable = why === 'retry' || (res.status === 403 && RATE_REASONS.has(why));
        if (retryable && attempt < MAX_RETRIES) {
          const wait = retryAfterMs(res.headers.get('retry-after'), clock()) ?? backoffMs(attempt, random);
          if (why === 'retry') await res.body?.cancel();
          attempt++;
          await sleep(wait);
          continue;
        }
        if (why === 'retry') await res.body?.cancel();
        throw new GoogleApiError(res.status, why === 'retry' ? `http_${res.status}` : why);
      }
    },
  };
}

/** Query string from a flat record; arrays repeat the key, undefined and null are skipped. */
export function qs(params: Record<string, string | number | boolean | string[] | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) q.append(k, x);
    else q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}
