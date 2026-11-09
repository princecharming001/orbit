/**
 * Orbit's shared Claude access: a thin proxy in front of the Messages API so visitors without their own key can use
 * the chat. The key stays on the server (a function secret, or the project's private schema). Every request is
 * checked before it is forwarded:
 *
 * - only POST /v1/messages, from Orbit's own origins
 * - only Orbit's chat model (and its refusal fallback), only Orbit's betas, max_tokens capped
 * - only client tools (deferred or not) plus Claude's own web search (at most five searches a request) and the BM25
 *   tool search that loads deferred tools; no other server tools, MCP servers or containers
 * - a body size cap, and request counters per visitor (hashed IP) per minute and per day, plus a global daily cap
 * - a dollar cap per user per day (ORBIT_USER_CAP_USD, $3 by default, the UTC day): each answer's tokens are priced as
 *   they stream past and added to the user's total for the day; once it reaches the cap the proxy answers 429
 *   `x-orbit-limit: budget` until the next day. A signed-in user's spend is also added to their lifetime total
 *   (`user:<uuid>`), the one the server's own caps read.
 *   The user is the signed-in account when the browser sends a valid Orbit session (`x-orbit-session`), else the
 *   browser's own id (`x-orbit-client`), else the hashed IP.
 * - a switch: when the `anthropic` row of orbit_private.provider_switches is off the proxy answers 503
 *   `x-orbit-limit: unconfigured` until it is on again (read every five minutes)
 * - one usage row per answer (tokens, cache reads and writes, web searches, the turn's iteration from
 *   `x-orbit-iterations`) in orbit_private.claude_usage, so the cache hit rate and the shape of a turn are measured
 *
 * - a call type in `x-orbit-call`: the chat (no header, or `chat`) as above; `memory` (reading what the student said
 *   after a chat turn) and `resume` (reading their resume) are structured-output calls with one message, no tools, no
 *   thinking, a small max_tokens and body, counted in the same minute, day and global counters as the chat and in a
 *   daily counter of their own (resumes 5 a day, memory reads 200, until raised); over that one the proxy answers 429
 *   `x-orbit-limit: call`, which leaves the chat alone
 *
 * Responses, including the SSE stream, pass through unchanged. Kept free of Deno APIs so it runs under Node tests.
 */

import { clientIp, defaultOrigins } from '../_shared/origins.ts';
import { costUsd, PRICES, type Usage, WEB_SEARCH_USD } from '../_shared/prices.ts';

export { clientIp, defaultOrigins };

export const UPSTREAM = 'https://api.anthropic.com/v1/messages';
export const ALLOWED_MODELS = new Set(['claude-opus-5-5']);
/** The light model the background reads (memory, resume) may use; the chat itself never does. */
export const LIGHT_MODELS = new Set(['claude-haiku-5-5']);
export const ALLOWED_FALLBACKS = new Set(['claude-opus-5']);
export const ALLOWED_BETAS = new Set([
  'compact-2026-01-12',
  'server-side-fallback-2026-06-01',
  'thinking-display-updates-2026-08-18',
  'thinking-binding-controls-2026-08-01',
]);
export const MAX_TOKENS = 16_000;
export const MAX_BODY_BYTES = 1_500_000;

/** The kinds of call the proxy forwards: the chat, and small structured reads. */
export type CallType = 'chat' | 'memory' | 'resume' | 'rapport' | 'judge';
export const CALL_TYPES: readonly CallType[] = ['chat', 'memory', 'resume', 'rapport', 'judge'];
/** Per call type: the largest max_tokens and request body allowed (the chat keeps MAX_TOKENS and MAX_BODY_BYTES). */
export const CALL_LIMITS: Record<Exclude<CallType, 'chat'>, { maxTokens: number; maxBytes: number }> = {
  memory: { maxTokens: 1024, maxBytes: 60_000 },
  resume: { maxTokens: 8192, maxBytes: 200_000 },
  // how warm one reply reads (plan 27): the reply and the student's message it answers
  rapport: { maxTokens: 300, maxBytes: 24_000 },
  // network search (plan 32 §6.6): whether up to a dozen people meet an ask, with the words it rests on
  judge: { maxTokens: 2048, maxBytes: 60_000 },
};

export interface Limits {
  perMinute: number;
  perDay: number;
  globalPerDay: number;
  /** each visitor's daily count for one kind of call, on top of perDay */
  perDayCall?: Partial<Record<Exclude<CallType, 'chat'>, number>>;
}
// the dollar cap per user per day is the real limit; the counts only stop a runaway loop
export const DEFAULT_CALL_PER_DAY: Record<Exclude<CallType, 'chat'>, number> = {
  memory: 3000,
  resume: 50,
  rapport: 3000,
  judge: 5000,
};
export const DEFAULT_LIMITS: Limits = {
  perMinute: 120,
  perDay: 5000,
  globalPerDay: 100_000,
  perDayCall: DEFAULT_CALL_PER_DAY,
};
/** Dollars one user may spend on Orbit's key in a UTC day (plan 34: the whole product's measured peak is $4.35). */
export const DEFAULT_CAP_USD = 3;
/**
 * Dollars a day from one network without a signed-in session. The browser id a request names is the caller's own
 * choice, so a fresh one is a fresh allowance: without this a script rotating it spends Orbit's key until the global
 * request count stops it.
 */
export const DEFAULT_ANON_IP_DAILY_USD = 1;
/** Dollars a day on Orbit's key across everyone: the hard stop on the bill. */
export const DEFAULT_GLOBAL_DAILY_USD = 25;
/**
 * Dollars of Claude a signed-in student may use in a calendar month (UTC), chat and server work together: the
 * allowance the $49 subscription is priced on, so a heavy month cannot take the margin under half. The month's
 * subject `user:<uuid>:m:<YYYY-MM>` is the chat's spend; orbit_spend_total adds the server's Claude spend that month.
 */
export const DEFAULT_MONTHLY_USD = 10;

/** The first instant of the next calendar month, UTC: when a monthly allowance comes back. */
export function nextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** One answer's shape and price, written once the answer is complete (plan 34 C1). */
export interface UsageRow {
  subject: string;
  call: CallType;
  model: string | undefined;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  webSearches: number;
  /** which model request of the chat turn this was, from `x-orbit-iterations` */
  iterations: number | undefined;
  usd: number;
}

/** Running dollar totals per user (see subjectOf). */
export interface Spend {
  total: (subject: string) => Promise<number>;
  add: (subject: string, usd: number) => Promise<void>;
}

export interface Bucket {
  key: string;
  limit: number;
  expires: string;
}
export type Take = (buckets: Bucket[]) => Promise<{ allowed: boolean; over?: string }>;

export interface ProxyDeps {
  /** the server's Anthropic key, or a lookup for it (read per request, so it can be cached and rotated) */
  apiKey: string | undefined | (() => Promise<string | undefined>);
  origins: (origin: string) => boolean;
  take: Take;
  limits?: Limits;
  fetch?: typeof fetch;
  now?: () => Date;
  /** salt for the visitor hash, so stored buckets never hold a raw IP */
  salt?: string;
  /** the per-user dollar totals; without it nothing is metered (tests that do not need it) */
  spend?: Spend;
  capUsd?: number;
  /** dollars a day from one network for requests without a signed-in session */
  anonIpDailyUsd?: number;
  /** dollars a day across everyone */
  globalDailyUsd?: number;
  /** dollars a calendar month for one signed-in student, chat and server work together */
  monthlyUsd?: number;
  /** the owner's user id (ORBIT_OWNER_ID): no monthly allowance, so testing never runs out (or a lookup for it) */
  ownerId?: string | (() => Promise<string | undefined>);
  /** ORBIT_SESSION_SECRET, to recognise a signed-in user's access token (or a lookup for it, cached by the caller) */
  sessionSecret?: string | (() => Promise<string | undefined>);
  /** whether Orbit's Anthropic access is switched on (orbit_private.provider_switches); absent means on */
  enabled?: () => Promise<boolean>;
  /** records one usage row per answer; absent means nothing is recorded */
  usage?: (row: UsageRow) => Promise<void>;
}

const EXPOSE = [
  'request-id',
  'retry-after',
  'x-should-retry',
  'x-orbit-limit',
  'x-orbit-budget-remaining',
  'x-orbit-budget-scope',
  'x-orbit-reset',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-tokens-remaining',
].join(', ');

function cors(origin: string | null, allowed: boolean): Record<string, string> {
  if (!origin || !allowed) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': EXPOSE,
    Vary: 'Origin',
  };
}

/** An error in the Messages API's own shape, so the SDK raises its usual typed error. */
function apiError(
  status: number,
  type: string,
  message: string,
  headers: Record<string, string>,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers, ...extra },
  });
}

/**
 * The one server tool the chat may use: Claude's web search, a few searches a request (each is billed, and counted in
 * the user's cap), with nothing else that changes what it reaches or costs.
 */
export const WEB_SEARCH = { type: 'web_search_20260209', name: 'web_search', maxUses: 5 } as const;
const WEB_SEARCH_KEYS = new Set(['type', 'name', 'max_uses', 'cache_control']);

/** Claude's BM25 tool search: finds the deferred client tools of the same request, costs nothing of its own. */
export const TOOL_SEARCH = { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' } as const;
const TOOL_SEARCH_KEYS = new Set(['type', 'name']);

function rejectToolSearch(t: Record<string, unknown>): string | undefined {
  if (t.name !== TOOL_SEARCH.name) return 'Server tools are not available here.';
  for (const k of Object.keys(t)) if (!TOOL_SEARCH_KEYS.has(k)) return `${k} is not available here.`;
  return undefined;
}

function rejectWebSearch(t: Record<string, unknown>): string | undefined {
  if (t.name !== WEB_SEARCH.name) return 'Server tools are not available here.';
  if (typeof t.max_uses !== 'number' || t.max_uses < 1 || t.max_uses > WEB_SEARCH.maxUses)
    return `Web search needs max_uses between 1 and ${WEB_SEARCH.maxUses}.`;
  for (const k of Object.keys(t)) if (!WEB_SEARCH_KEYS.has(k)) return `${k} is not available here.`;
  return undefined;
}

/** Why a request body may not be forwarded, or undefined when it may. */
export function rejectBody(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return 'The request body must be a JSON object.';
  const b = body as Record<string, unknown>;
  if (typeof b.model !== 'string' || !(ALLOWED_MODELS.has(b.model) || LIGHT_MODELS.has(b.model)))
    return 'That model is not available here.';
  if (typeof b.max_tokens !== 'number' || b.max_tokens < 1 || b.max_tokens > MAX_TOKENS)
    return `max_tokens must be between 1 and ${MAX_TOKENS}.`;
  if (!Array.isArray(b.messages) || b.messages.length === 0) return 'messages must be a non-empty array.';
  for (const k of ['mcp_servers', 'container', 'service_tier', 'inference_geo'])
    if (k in b) return `${k} is not available here.`;
  if (b.fallbacks !== undefined) {
    if (!Array.isArray(b.fallbacks)) return 'fallbacks must be an array.';
    for (const f of b.fallbacks)
      if (!f || typeof f !== 'object' || !ALLOWED_FALLBACKS.has((f as { model?: unknown }).model as string))
        return 'That fallback model is not available here.';
  }
  if (b.tools !== undefined) {
    if (!Array.isArray(b.tools)) return 'tools must be an array.';
    for (const t of b.tools) {
      const type = t && typeof t === 'object' ? (t as { type?: unknown }).type : undefined;
      if (type === WEB_SEARCH.type) {
        const why = rejectWebSearch(t as Record<string, unknown>);
        if (why) return why;
      } else if (type === TOOL_SEARCH.type) {
        const why = rejectToolSearch(t as Record<string, unknown>);
        if (why) return why;
      } else if (type !== undefined && type !== 'custom') return 'Server tools are not available here.';
    }
  }
  return undefined;
}

/** The call type a request names, or undefined for one the proxy does not know. */
export function callOf(req: Request): CallType | undefined {
  const raw = req.headers.get('x-orbit-call')?.trim().toLowerCase();
  if (!raw) return 'chat';
  return (CALL_TYPES as readonly string[]).includes(raw) ? (raw as CallType) : undefined;
}

/** Why a memory or resume read may not be forwarded (on top of rejectBody), or undefined when it may. */
export function rejectCall(call: CallType, body: unknown, bytes: number): string | undefined {
  const b = body as Record<string, unknown>;
  if (call === 'chat') return LIGHT_MODELS.has(String(b.model)) ? 'The chat runs on Opus here.' : undefined;
  const limit = CALL_LIMITS[call];
  if (bytes > limit.maxBytes) return `A ${call} request is at most ${limit.maxBytes} bytes.`;
  if (typeof b.max_tokens !== 'number' || b.max_tokens > limit.maxTokens)
    return `max_tokens for a ${call} request is at most ${limit.maxTokens}.`;
  if (b.tools !== undefined || b.tool_choice !== undefined) return `A ${call} request takes no tools.`;
  const thinking = b.thinking as { type?: unknown } | undefined;
  if (thinking !== undefined && thinking?.type !== 'disabled') return `A ${call} request takes no thinking.`;
  if (!Array.isArray(b.messages) || b.messages.length !== 1) return `A ${call} request is one message.`;
  return undefined;
}

export function filterBetas(header: string | null): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(',')
    .map((s) => s.trim())
    .filter((s) => ALLOWED_BETAS.has(s));
  return kept.length ? kept.join(',') : undefined;
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');
}

export function buckets(visitor: string, now: Date, limits: Limits, call: CallType = 'chat'): Bucket[] {
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  const minute = iso.slice(0, 16);
  const endOfDay = new Date(`${day}T00:00:00Z`);
  endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);
  const endOfMinute = new Date(`${minute}:00Z`);
  endOfMinute.setUTCMinutes(endOfMinute.getUTCMinutes() + 1);
  const out: Bucket[] = [
    { key: `orbit:min:${minute}:${visitor}`, limit: limits.perMinute, expires: endOfMinute.toISOString() },
    { key: `orbit:day:${day}:${visitor}`, limit: limits.perDay, expires: endOfDay.toISOString() },
    { key: `orbit:global:${day}`, limit: limits.globalPerDay, expires: endOfDay.toISOString() },
  ];
  if (call !== 'chat')
    out.push({
      key: `orbit:${call}:${day}:${visitor}`,
      limit: limits.perDayCall?.[call] ?? DEFAULT_CALL_PER_DAY[call],
      expires: endOfDay.toISOString(),
    });
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_ID = /^[A-Za-z0-9_-]{16,64}$/;

function b64urlBytes(s: string): Uint8Array | undefined {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/** The HMAC key the way orbit-api signs with it: base64 of 32+ bytes as bytes, anything else as UTF-8. */
function sessionKeyBytes(secret: string): Uint8Array {
  const t = secret.trim();
  if (/^[A-Za-z0-9+/=_-]+$/.test(t)) {
    const decoded = b64urlBytes(t.replace(/=+$/, ''));
    if (decoded && decoded.length >= 32) return decoded;
  }
  return new TextEncoder().encode(secret);
}

/** The user id in a valid Orbit access token (HS256, audience "orbit", not expired), else undefined. */
export async function verifyOrbitSession(
  token: string,
  secret: string,
  now = new Date(),
): Promise<string | undefined> {
  const parts = token.split('.');
  if (parts.length !== 3 || secret.trim().length < 32) return undefined;
  const [h, p, sig] = parts as [string, string, string];
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlBytes(h)));
    if (header?.alg !== 'HS256') return undefined;
    const key = await crypto.subtle.importKey(
      'raw',
      sessionKeyBytes(secret) as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const sigBytes = b64urlBytes(sig);
    if (!sigBytes) return undefined;
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes as BufferSource,
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) return undefined;
    const claims = JSON.parse(new TextDecoder().decode(b64urlBytes(p)));
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes('orbit')) return undefined;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now.getTime()) return undefined;
    return typeof claims.sub === 'string' && UUID.test(claims.sub) ? claims.sub.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Whose spend a request counts toward: the signed-in user, else this browser, else the hashed IP. */
export async function subjectOf(
  req: Request,
  visitor: string,
  sessionSecret: string | undefined,
  now = new Date(),
): Promise<string> {
  const token = req.headers.get('x-orbit-session');
  if (token && sessionSecret) {
    const uid = await verifyOrbitSession(token, sessionSecret, now);
    if (uid) return `user:${uid}`;
  }
  const client = req.headers.get('x-orbit-client');
  if (client && CLIENT_ID.test(client)) return `client:${client}`;
  return `ip:${visitor}`;
}

/** The price of an answer, at the chat model's rates when the model is not one Orbit knows (a fallback model). */
export function answerCost(model: string | undefined, u: Usage): number {
  return (
    costUsd(model && PRICES[model] ? model : 'claude-opus-5-5', u) +
    (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD
  );
}

/**
 * Passes the answer through untouched while reading its usage: from a stream, the input tokens at message_start and
 * the output tokens at message_delta (each charged as it arrives, so an answer cut short still pays for its
 * prompt); from a JSON answer, everything at the end.
 */
export interface MeterTotals {
  model: string | undefined;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  webSearches: number;
  usd: number;
}

export function meter(
  body: ReadableStream<Uint8Array>,
  stream: boolean,
  charge: (usd: number) => Promise<void>,
  done?: (totals: MeterTotals) => Promise<void>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let pending = '';
  let model: string | undefined;
  let started: Usage = { input_tokens: 0, output_tokens: 0 };
  let seen = false;
  const totals: MeterTotals = {
    model: undefined,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    webSearches: 0,
    usd: 0,
  };
  const tally = (u: Usage, usd: number) => {
    seen = true;
    totals.model = model;
    totals.input += u.input_tokens ?? 0;
    totals.cacheRead += u.cache_read_input_tokens ?? 0;
    totals.cacheWrite += u.cache_creation_input_tokens ?? 0;
    totals.output += u.output_tokens ?? 0;
    totals.webSearches += u.server_tool_use?.web_search_requests ?? 0;
    totals.usd += usd;
  };
  const priced = async (u: Usage) => {
    const usd = answerCost(model, u);
    tally(u, usd);
    await safely(usd);
  };
  const finish = async () => {
    if (!done || !seen) return;
    try {
      await done({ ...totals, usd: Math.round(totals.usd * 100_000) / 100_000 });
    } catch {
      // recording never breaks the answer
    }
  };
  const safely = async (usd: number) => {
    if (!(usd > 0)) return;
    try {
      await charge(usd);
    } catch {
      // metering never breaks the answer
    }
  };
  const onEvent = async (data: string) => {
    let d: {
      type?: string;
      message?: { model?: string; usage?: Partial<Usage> };
      usage?: Partial<Usage>;
    };
    try {
      d = JSON.parse(data);
    } catch {
      return;
    }
    if (d.type === 'message_start' && d.message) {
      model = d.message.model;
      const u = d.message.usage ?? {};
      started = {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      };
      await priced(started);
    } else if (d.type === 'message_delta' && d.usage) {
      // the totals at the end: the output, the searches, and any input read after the start (a web search's results
      // are read in further passes), less what message_start already charged
      const u = d.usage;
      const more = (n: number | null | undefined, had: number | null | undefined) =>
        Math.max(0, (n ?? 0) - (had ?? 0));
      await priced({
        input_tokens: more(u.input_tokens, started.input_tokens),
        output_tokens: u.output_tokens ?? 0,
        cache_read_input_tokens: more(u.cache_read_input_tokens, started.cache_read_input_tokens),
        cache_creation_input_tokens: more(u.cache_creation_input_tokens, started.cache_creation_input_tokens),
        server_tool_use: u.server_tool_use,
      });
    }
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        controller.enqueue(chunk);
        pending += decoder.decode(chunk, { stream: true });
        if (!stream) return;
        let nl = pending.indexOf('\n');
        while (nl >= 0) {
          const line = pending.slice(0, nl).trim();
          pending = pending.slice(nl + 1);
          if (line.startsWith('data:')) await onEvent(line.slice(5).trim());
          nl = pending.indexOf('\n');
        }
      },
      async flush() {
        pending += decoder.decode();
        if (stream) {
          const line = pending.trim();
          if (line.startsWith('data:')) await onEvent(line.slice(5).trim());
          await finish();
          return;
        }
        try {
          const d = JSON.parse(pending) as { model?: string; usage?: Usage };
          if (d.usage) {
            model = d.model;
            await priced(d.usage);
          }
        } catch {
          // not an answer we can price
        }
        await finish();
      },
    }),
  );
}

export function makeHandler(deps: ProxyDeps): (req: Request) => Promise<Response> {
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const cap = deps.capUsd ?? DEFAULT_CAP_USD;
  const monthCap = deps.monthlyUsd ?? DEFAULT_MONTHLY_USD;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  return async (req) => {
    const origin = req.headers.get('origin');
    const allowed = !!origin && deps.origins(origin);
    const h = cors(origin, allowed);

    if (req.method === 'OPTIONS') {
      if (!allowed) return new Response(null, { status: 403, headers: h });
      return new Response(null, {
        status: 204,
        headers: {
          ...h,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': req.headers.get('access-control-request-headers') ?? '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    if (!allowed)
      return apiError(403, 'permission_error', 'This origin may not use Orbit’s Claude access.', h);
    const path = new URL(req.url).pathname;
    if (req.method !== 'POST' || !path.endsWith('/v1/messages'))
      return apiError(404, 'not_found_error', 'Only POST /v1/messages is available here.', h);
    let apiKey: string | undefined;
    try {
      apiKey = typeof deps.apiKey === 'function' ? await deps.apiKey() : deps.apiKey;
    } catch {
      apiKey = undefined;
    }
    if (!apiKey)
      return apiError(503, 'api_error', 'Orbit’s shared Claude access is not set up yet.', h, {
        'x-should-retry': 'false',
        'x-orbit-limit': 'unconfigured',
      });
    let on = true;
    try {
      on = deps.enabled ? await deps.enabled() : true;
    } catch {
      on = true;
    }
    if (!on)
      return apiError(503, 'api_error', 'Orbit’s shared Claude access is paused right now.', h, {
        'x-should-retry': 'false',
        'x-orbit-limit': 'unconfigured',
      });

    const declared = Number(req.headers.get('content-length') ?? '0');
    if (declared > MAX_BODY_BYTES) return apiError(413, 'request_too_large', 'The request is too large.', h);
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES)
      return apiError(413, 'request_too_large', 'The request is too large.', h);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return apiError(400, 'invalid_request_error', 'The request body is not valid JSON.', h);
    }
    const call = callOf(req);
    if (!call) return apiError(400, 'invalid_request_error', 'That call type is not available here.', h);
    const why = rejectBody(body) ?? rejectCall(call, body, raw.length);
    if (why) return apiError(400, 'invalid_request_error', why, h);

    const visitor = (await sha256(`${deps.salt ?? 'orbit'}:${clientIp(req)}`)).slice(0, 32);
    let verdict: { allowed: boolean; over?: string };
    try {
      verdict = await deps.take(buckets(visitor, now(), limits, call));
    } catch {
      return apiError(503, 'api_error', 'Orbit’s shared Claude access is unavailable right now.', h);
    }
    if (!verdict.allowed) {
      const kind = verdict.over?.includes(':min:')
        ? 'minute'
        : verdict.over?.includes(':global:')
          ? 'global'
          : /^orbit:(?:memory|resume|rapport):/.test(verdict.over ?? '')
            ? 'call'
            : 'day';
      const message =
        kind === 'minute'
          ? 'Too many requests in the last minute on Orbit’s shared Claude access. Try again shortly.'
          : kind === 'call'
            ? `Orbit’s shared Claude has done enough ${call} reads for today.`
            : 'Orbit’s shared Claude access has reached today’s limit.';
      return apiError(429, 'rate_limit_error', message, h, {
        'x-orbit-limit': kind,
        'x-should-retry': 'false',
        ...(kind === 'minute' ? { 'retry-after': '30' } : {}),
      });
    }

    // the per-user dollar cap for the day: counted before the call, charged as the answer streams back
    const day = now().toISOString().slice(0, 10);
    let sessionSecret: string | undefined;
    try {
      sessionSecret =
        typeof deps.sessionSecret === 'function' ? await deps.sessionSecret() : deps.sessionSecret;
    } catch {
      sessionSecret = undefined;
    }
    const who = await subjectOf(req, visitor, sessionSecret, now());
    const subject = `${who}:${day}`;
    // also counted: the day's total for everyone, the day's total for this network when nobody is signed in, and a
    // signed-in user's lifetime total (the subject the server's caps read, so chat and server spend see each other)
    const globalDay = `global:${day}`;
    const signedIn = who.startsWith('user:');
    const ipDay = signedIn ? undefined : `ipday:${visitor}:${day}`;
    // a signed-in student's month, for the monthly allowance; the owner has none
    let ownerId: string | undefined;
    if (signedIn && deps.ownerId)
      try {
        ownerId = typeof deps.ownerId === 'function' ? await deps.ownerId() : deps.ownerId;
      } catch {
        ownerId = undefined;
      }
    const monthSubject = signedIn ? `${who}:m:${day.slice(0, 7)}` : undefined;
    const monthCapped = !!monthSubject && (!ownerId || who !== `user:${ownerId}`);
    const charged = [
      subject,
      globalDay,
      ...(ipDay ? [ipDay] : []),
      ...(signedIn ? [who] : []),
      ...(monthSubject ? [monthSubject] : []),
    ];
    const iterHeader = Number(req.headers.get('x-orbit-iterations'));
    const iterations =
      Number.isInteger(iterHeader) && iterHeader >= 0 && iterHeader <= 1000 ? iterHeader : undefined;
    let spent = 0;
    let monthSpent = 0;
    if (deps.spend) {
      const spend = deps.spend;
      let globalSpent = 0;
      let ipSpent = 0;
      try {
        [spent, globalSpent, ipSpent, monthSpent] = await Promise.all([
          spend.total(subject),
          spend.total(globalDay),
          ipDay ? spend.total(ipDay) : Promise.resolve(0),
          monthSubject && monthCapped ? spend.total(monthSubject) : Promise.resolve(0),
        ]);
      } catch {
        return apiError(503, 'api_error', 'Orbit’s shared Claude access is unavailable right now.', h);
      }
      if (globalSpent >= (deps.globalDailyUsd ?? DEFAULT_GLOBAL_DAILY_USD))
        return apiError(
          429,
          'rate_limit_error',
          'Orbit’s shared Claude access has reached today’s limit.',
          h,
          {
            'x-orbit-limit': 'global',
            'x-should-retry': 'false',
          },
        );
      if (ipDay && ipSpent >= (deps.anonIpDailyUsd ?? DEFAULT_ANON_IP_DAILY_USD))
        return apiError(
          429,
          'rate_limit_error',
          'Orbit’s shared Claude has done enough for today without a sign-in. Sign in, or add your own Anthropic key in Settings, to keep chatting.',
          h,
          { 'x-orbit-limit': 'day', 'x-should-retry': 'false' },
        );
      if (spent >= cap)
        return apiError(
          429,
          'rate_limit_error',
          `You have used today's $${cap} of Claude that Orbit includes. It resets at midnight UTC, or add your own Anthropic key in Settings to keep going.`,
          h,
          { 'x-orbit-limit': 'budget', 'x-should-retry': 'false', 'x-orbit-budget-remaining': '0' },
        );
      if (monthCapped && monthSpent >= monthCap) {
        const back = nextMonthStart(now());
        const on = back.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
        return apiError(
          429,
          'rate_limit_error',
          `You have used this month's $${monthCap} of Claude that Orbit includes. It comes back on ${on}, or add your own Anthropic key in Settings to keep going.`,
          h,
          {
            'x-orbit-limit': 'budget',
            'x-orbit-budget-scope': 'month',
            'x-orbit-reset': back.toISOString(),
            'x-should-retry': 'false',
            'x-orbit-budget-remaining': '0',
          },
        );
      }
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': req.headers.get('anthropic-version') ?? '2023-06-01',
    };
    const betas = filterBetas(req.headers.get('anthropic-beta'));
    if (betas) headers['anthropic-beta'] = betas;
    let upstream: Response;
    try {
      upstream = await doFetch(UPSTREAM, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch {
      return apiError(502, 'api_error', 'Could not reach Anthropic from Orbit’s server.', h);
    }
    const out: Record<string, string> = { ...h };
    if (deps.spend)
      out['x-orbit-budget-remaining'] = Math.max(
        0,
        monthCapped ? Math.min(cap - spent, monthCap - monthSpent) : cap - spent,
      ).toFixed(2);
    for (const k of ['content-type', 'request-id', 'retry-after', 'x-should-retry']) {
      const v = upstream.headers.get(k);
      if (v) out[k] = v;
    }
    // A key problem on the server is not the visitor's to fix: report it as a temporary server error.
    if (upstream.status === 401 || upstream.status === 403) {
      await upstream.body?.cancel();
      return apiError(503, 'api_error', 'Orbit’s shared Claude access is unavailable right now.', h, {
        'x-should-retry': 'false',
        'x-orbit-limit': 'unconfigured',
      });
    }
    const spend = deps.spend;
    if (!spend || !upstream.ok || !upstream.body)
      return new Response(upstream.body, { status: upstream.status, headers: out });
    const streamed = (upstream.headers.get('content-type') ?? '').includes('text/event-stream');
    const usage = deps.usage;
    return new Response(
      meter(
        upstream.body,
        streamed,
        async (usd) => {
          await Promise.all(charged.map((c) => spend.add(c, usd)));
        },
        usage ? (t) => usage({ subject, call, ...t, iterations }) : undefined,
      ),
      { status: upstream.status, headers: out },
    );
  };
}

/** The dollar totals over PostgREST (orbit_spend_total / orbit_spend_add), with the service role key. */
export function postgrestSpend(url: string, serviceKey: string, doFetch: typeof fetch = fetch): Spend {
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const r = await doFetch(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify(args),
    });
    if (!r.ok) throw new Error(`spend store ${r.status}`);
    return r.json();
  };
  return {
    total: async (subject) => Number((await rpc('orbit_spend_total', { p_subject: subject })) ?? 0),
    add: async (subject, usd) => {
      await rpc('orbit_spend_add', { p_subject: subject, p_usd: Math.round(usd * 100_000) / 100_000 });
    },
  };
}

/** The counter store over PostgREST with the service role key (no client library needed). */
export function postgrestTake(url: string, serviceKey: string, doFetch: typeof fetch = fetch): Take {
  return async (bs) => {
    const r = await doFetch(`${url}/rest/v1/rpc/orbit_proxy_take`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        p_buckets: bs.map((b) => b.key),
        p_limits: bs.map((b) => b.limit),
        p_expires: bs.map((b) => b.expires),
      }),
    });
    if (!r.ok) throw new Error(`counter store ${r.status}`);
    const rows = (await r.json()) as { allowed: boolean; over_bucket: string | null }[];
    const row = rows[0];
    if (!row) throw new Error('counter store returned nothing');
    return { allowed: row.allowed, over: row.over_bucket ?? undefined };
  };
}

async function serviceRpc(
  url: string,
  serviceKey: string,
  name: string,
  args: Record<string, unknown>,
  doFetch: typeof fetch,
): Promise<unknown> {
  const r = await doFetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${name} ${r.status}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

/** A value read through a service-role-only function, cached for five minutes (a miss is cached too). */
export function postgrestCached<T>(
  load: () => Promise<T>,
  ttlMs = 5 * 60_000,
  now: () => number = Date.now,
): () => Promise<T> {
  let cached: { value: T; at: number } | undefined;
  return async () => {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    const value = await load();
    cached = { value, at: now() };
    return value;
  };
}

/** The session signing key kept in Vault (orbit_session_secret), the same one orbit-api signs with. */
export function postgrestSessionSecret(
  url: string,
  serviceKey: string,
  doFetch: typeof fetch = fetch,
): () => Promise<string | undefined> {
  return postgrestCached(
    async () =>
      ((await serviceRpc(url, serviceKey, 'orbit_session_secret', {}, doFetch)) as string | null) ||
      undefined,
  );
}

/** Whether a provider is switched on (orbit_provider_enabled); a store that cannot answer counts as on. */
export function postgrestEnabled(
  url: string,
  serviceKey: string,
  provider: string,
  doFetch: typeof fetch = fetch,
): () => Promise<boolean> {
  return postgrestCached(async () => {
    try {
      const v = await serviceRpc(url, serviceKey, 'orbit_provider_enabled', { p: provider }, doFetch);
      return v !== false;
    } catch {
      return true;
    }
  });
}

/** Writes one usage row per answer (orbit_claude_usage_add). */
export function postgrestUsage(
  url: string,
  serviceKey: string,
  doFetch: typeof fetch = fetch,
): (row: UsageRow) => Promise<void> {
  return async (row) => {
    await serviceRpc(
      url,
      serviceKey,
      'orbit_claude_usage_add',
      {
        p_subject: row.subject,
        p_call: row.call,
        p_model: row.model ?? null,
        p_input: row.input,
        p_cache_read: row.cacheRead,
        p_cache_write: row.cacheWrite,
        p_output: row.output,
        p_web_searches: row.webSearches,
        p_iterations: row.iterations ?? null,
        p_usd: row.usd,
      },
      doFetch,
    );
  };
}

/**
 * The key stored in the project's private schema, read through a service-role-only function, cached for five
 * minutes. Used when the key is not set as a function secret.
 */
export function postgrestSecret(
  url: string,
  serviceKey: string,
  name: string,
  doFetch: typeof fetch = fetch,
  ttlMs = 5 * 60_000,
): () => Promise<string | undefined> {
  let cached: { value: string | undefined; at: number } | undefined;
  return async () => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.value;
    const r = await doFetch(`${url}/rest/v1/rpc/orbit_secret`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ p_name: name }),
    });
    if (!r.ok) throw new Error(`secret store ${r.status}`);
    const value = ((await r.json()) as string | null) ?? undefined;
    cached = { value, at: Date.now() };
    return value;
  };
}
