/**
 * HTTP plumbing shared by orbit-api, orbit-worker and orbit-webhooks: CORS for Orbit's origins, JSON responses,
 * typed errors, request ids, and the one-JSON-line-per-request log of §16 (user ids hashed; never bodies, names or
 * addresses). Kept free of Deno APIs so it runs under Node tests.
 */
import { sha256Hex } from './crypto.ts';
import { defaultOrigins } from './origins.ts';

export type Headers_ = Record<string, string>;

/** An error with the status and machine code the client sees. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly headers: Headers_ = {},
  ) {
    super(message ?? code);
  }
}

export const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
export const unauthorized = (message = 'sign in again') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'not allowed') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'no such route') => new HttpError(404, 'not_found', message);

/** Origins allowed for browser calls: Orbit's defaults plus the configured app URL's origin. */
export function originPolicy(appUrl?: string): (origin: string) => boolean {
  let extra: string | undefined;
  try {
    extra = appUrl ? new URL(appUrl).origin : undefined;
  } catch {
    extra = undefined;
  }
  return (origin) => defaultOrigins(origin) || (!!extra && origin === extra);
}

const EXPOSE = 'x-orbit-connector, x-orbit-limit, x-request-id, retry-after';

export function corsHeaders(origin: string | null, allowed: boolean): Headers_ {
  if (!origin || !allowed) return { Vary: 'Origin' };
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': EXPOSE, Vary: 'Origin' };
}

/** The preflight answer for an allowed origin. */
export function preflight(req: Request, h: Headers_, methods = 'GET, POST, OPTIONS'): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...h,
      'Access-Control-Allow-Methods': methods,
      'Access-Control-Allow-Headers':
        req.headers.get('access-control-request-headers') ?? 'authorization, content-type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

export function json(status: number, body: unknown, headers: Headers_ = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

export function redirect(location: string, headers: Headers_ = {}): Response {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', ...headers } });
}

/** 503 with the same marker orbit-connectors uses, so the app can tell "not set up yet" from "down". */
export function unconfigured(headers: Headers_ = {}, missing?: string[]): Response {
  return json(
    503,
    { error: { code: 'unconfigured', message: 'not configured', ...(missing ? { missing } : {}) } },
    { ...headers, 'x-orbit-connector': 'unconfigured' },
  );
}

/** Any thrown value → a JSON error response; unknown errors become a 500 without details. */
export function errorResponse(e: unknown, headers: Headers_ = {}): Response {
  if (e instanceof HttpError)
    return json(e.status, { error: { code: e.code, message: e.message } }, { ...headers, ...e.headers });
  return json(500, { error: { code: 'internal', message: 'something went wrong' } }, headers);
}

/** The caller's request id when it is a sane token, else a new one. */
export function requestId(req: Request): string {
  const given = req.headers.get('x-request-id');
  if (given && /^[A-Za-z0-9._:-]{8,80}$/.test(given)) return given;
  return crypto.randomUUID();
}

/** The JSON body as an object; a missing or invalid body is a 400 (or {} when optional). */
export async function readJson(
  req: Request,
  { optional = false, maxBytes = 1_000_000 } = {},
): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new HttpError(413, 'too_large', 'the request is too large');
  const raw = await req.text();
  if (raw.length > maxBytes) throw new HttpError(413, 'too_large', 'the request is too large');
  if (!raw.trim()) {
    if (optional) return {};
    throw badRequest('a JSON body is required');
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw badRequest('the body is not valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw badRequest('the body must be a JSON object');
  return body as Record<string, unknown>;
}

// ---- the request/job log line (§16) -----------------------------------------------------------------------------

export interface Upstream {
  provider: string;
  status: number;
  ms: number;
}

export interface LogLine {
  ts: string;
  fn: string;
  route?: string;
  kind?: string;
  user_id_hash?: string;
  request_id?: string;
  status: number | string;
  duration_ms: number;
  upstream?: Upstream[];
  cost_usd?: number;
  error?: string;
}

export type LogSink = (line: string) => void;

export interface Logger {
  /** Writes one line; `userId` is hashed with the salt before it is written. */
  log(entry: Omit<LogLine, 'ts' | 'user_id_hash'> & { userId?: string | null }): Promise<void>;
}

export function makeLogger(
  salt: string,
  sink: LogSink = (l) => console.log(l),
  now = () => new Date(),
): Logger {
  return {
    async log({ userId, ...rest }) {
      const line: LogLine = { ts: now().toISOString(), ...rest };
      if (userId) line.user_id_hash = (await sha256Hex(`${salt}:${userId}`)).slice(0, 16);
      // never let a log line carry more than a short error code
      if (line.error) line.error = line.error.slice(0, 200);
      sink(JSON.stringify(line));
    },
  };
}

/** A logger that writes nothing, for tests that do not look at logs. */
export const silentLogger: Logger = { log: async () => {} };
