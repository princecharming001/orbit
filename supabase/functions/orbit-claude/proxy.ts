/**
 * Orbit's shared Claude access: a thin proxy in front of the Messages API so visitors without their own key can use
 * the chat. The key stays on the server (a function secret, or the project's private schema). Every request is
 * checked before it is forwarded:
 *
 * - only POST /v1/messages, from Orbit's own origins
 * - only Orbit's chat model (and its refusal fallback), only Orbit's betas, max_tokens capped
 * - only client tools (no server tools that bill extra, no MCP servers or containers)
 * - a body size cap, and request counters per visitor (hashed IP) per minute and per day, plus a global daily cap
 *
 * Responses, including the SSE stream, pass through unchanged. Kept free of Deno APIs so it runs under Node tests.
 */

import { clientIp, defaultOrigins } from '../_shared/origins.ts';

export { clientIp, defaultOrigins };

export const UPSTREAM = 'https://api.anthropic.com/v1/messages';
export const ALLOWED_MODELS = new Set(['claude-opus-5-5']);
export const ALLOWED_FALLBACKS = new Set(['claude-opus-5']);
export const ALLOWED_BETAS = new Set([
  'compact-2026-01-12',
  'server-side-fallback-2026-06-01',
  'thinking-display-updates-2026-08-18',
  'thinking-binding-controls-2026-08-01',
]);
export const MAX_TOKENS = 16_000;
export const MAX_BODY_BYTES = 1_500_000;

export interface Limits {
  perMinute: number;
  perDay: number;
  globalPerDay: number;
}
export const DEFAULT_LIMITS: Limits = { perMinute: 30, perDay: 250, globalPerDay: 3000 };

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
}

const EXPOSE = [
  'request-id',
  'retry-after',
  'x-should-retry',
  'x-orbit-limit',
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

/** Why a request body may not be forwarded, or undefined when it may. */
export function rejectBody(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return 'The request body must be a JSON object.';
  const b = body as Record<string, unknown>;
  if (typeof b.model !== 'string' || !ALLOWED_MODELS.has(b.model)) return 'That model is not available here.';
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
      if (type !== undefined && type !== 'custom') return 'Server tools are not available here.';
    }
  }
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

export function buckets(visitor: string, now: Date, limits: Limits): Bucket[] {
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  const minute = iso.slice(0, 16);
  const endOfDay = new Date(`${day}T00:00:00Z`);
  endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);
  const endOfMinute = new Date(`${minute}:00Z`);
  endOfMinute.setUTCMinutes(endOfMinute.getUTCMinutes() + 1);
  return [
    { key: `orbit:min:${minute}:${visitor}`, limit: limits.perMinute, expires: endOfMinute.toISOString() },
    { key: `orbit:day:${day}:${visitor}`, limit: limits.perDay, expires: endOfDay.toISOString() },
    { key: `orbit:global:${day}`, limit: limits.globalPerDay, expires: endOfDay.toISOString() },
  ];
}

export function makeHandler(deps: ProxyDeps): (req: Request) => Promise<Response> {
  const limits = deps.limits ?? DEFAULT_LIMITS;
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
    const why = rejectBody(body);
    if (why) return apiError(400, 'invalid_request_error', why, h);

    const visitor = (await sha256(`${deps.salt ?? 'orbit'}:${clientIp(req)}`)).slice(0, 32);
    let verdict: { allowed: boolean; over?: string };
    try {
      verdict = await deps.take(buckets(visitor, now(), limits));
    } catch {
      return apiError(503, 'api_error', 'Orbit’s shared Claude access is unavailable right now.', h);
    }
    if (!verdict.allowed) {
      const kind = verdict.over?.includes(':min:')
        ? 'minute'
        : verdict.over?.includes(':global:')
          ? 'global'
          : 'day';
      const message =
        kind === 'minute'
          ? 'Too many requests in the last minute on Orbit’s shared Claude access. Try again shortly.'
          : 'Orbit’s shared Claude access has reached today’s limit.';
      return apiError(429, 'rate_limit_error', message, h, {
        'x-orbit-limit': kind,
        'x-should-retry': 'false',
        ...(kind === 'minute' ? { 'retry-after': '30' } : {}),
      });
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
    return new Response(upstream.body, { status: upstream.status, headers: out });
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
