/**
 * orbit-api: account mode's HTTP surface (§11.2, §12.1, §17 P1). Orbit's own Google sign-in and sessions, the
 * sync endpoints the SPA fills its Dexie cache from, and account export/deletion. All JSON; CORS for Orbit's
 * origins; rate limits per IP and per signed-in user. Every route except /auth/google/*, /auth/session and
 * /auth/refresh needs an Orbit access token. Missing secrets → 503 with `x-orbit-connector: unconfigured`.
 * Kept free of Deno APIs: main.ts wires the environment.
 */
import type { JWTVerifyGetKey } from 'jose';
import { sha256Hex } from '../_shared/crypto.ts';
import type { Db } from '../_shared/db.ts';
import type { GoogleConfig } from '../_shared/google.ts';
import {
  corsHeaders,
  errorResponse,
  type Headers_,
  HttpError,
  type Logger,
  notFound,
  originPolicy,
  preflight,
  requestId,
  silentLogger,
  unconfigured,
} from '../_shared/http.ts';
import { clientIp } from '../_shared/origins.ts';
import { ipBuckets, memoryTake, sqlTake, type Take, userBuckets } from '../_shared/ratelimit.ts';
import { type AgentConfig, makeServices, type Services } from '../_shared/services.ts';
import { authenticate, type SessionConfig, sessionSecretUsable } from '../_shared/session.ts';
import { accountDelete, accountExport } from './account.ts';
import { googleCallback, googleStart, logout, me, refresh, session } from './auth.ts';
import { cadenceRoutes } from './routes/cadence.ts';
import { calendarRoutes } from './routes/calendar.ts';
import { draftRoutes } from './routes/drafts.ts';
import { goalRoutes } from './routes/goals.ts';
import { INTEGRATION_ROUTES } from './routes/integrations.ts';
import { memoryRoutes } from './routes/memory.ts';
import { pathRoutes } from './routes/paths.ts';
import { replyRoutes } from './routes/replies.ts';
import { researchRoutes } from './routes/research.ts';
import { scoreRoutes } from './routes/scores.ts';
import { settingsRoutes } from './routes/settings.ts';
import { sourceRoutes } from './routes/source.ts';
import { syncPull, syncPush, syncStatus } from './sync.ts';

export const DEFAULT_APP_URL = 'https://tryorbit.today';

export interface ApiEnv {
  googleClientId?: string;
  googleClientSecret?: string;
  /** defaults to <SUPABASE_URL>/functions/v1/orbit-api/auth/google/callback; ORBIT_GOOGLE_REDIRECT_URI (a function secret or
   *  orbit_private.secrets) moves it to the site page that passes sign-in on (apps/web/public/auth/google/callback) */
  googleRedirectUri?: string;
  sessionSecret?: string;
  /** where the SPA lives; sign-in finishes at <app>/auth/done */
  appUrl?: string;
  unipileKey?: string;
  unipileBase?: string;
  /** ORBIT_UNIPILE_WEBHOOK_SECRET when set as an environment variable (else read from Vault) */
  unipileWebhookSecret?: string;
  /** <SUPABASE_URL>/functions/v1, for the URLs providers call back (Unipile's notify_url) */
  functionsUrl?: string;
}

export interface ApiLimits {
  ipPerMinute: number;
  userPerMinute: number;
  userPerDay: number;
}
export const DEFAULT_LIMITS: ApiLimits = { ipPerMinute: 120, userPerMinute: 240, userPerDay: 20_000 };

export interface ApiDeps {
  env: ApiEnv;
  /** undefined when SUPABASE_DB_URL is not available: every route is unconfigured */
  db: Db | undefined;
  fetch?: typeof fetch;
  /** Google's JWKS (tests pass a local set) */
  jwks?: JWTVerifyGetKey;
  now?: () => Date;
  take?: Take;
  limits?: ApiLimits;
  log?: Logger;
  /** salt for hashed IPs and user ids in counters and logs */
  salt?: string;
  /** how far behind "now" /sync/pull reads, so rows from transactions still committing are not skipped */
  pullLagMs?: number;
  /** provider keys and test fakes for the agent routes (goals … cadence); Google and Unipile default from env */
  agent?: AgentConfig;
}

/** What a route handler gets. */
export interface Ctx {
  req: Request;
  url: URL;
  db: Db;
  env: Required<Pick<ApiEnv, 'appUrl'>> & ApiEnv;
  session: SessionConfig;
  google: GoogleConfig | undefined;
  fetch: typeof fetch;
  now: () => Date;
  requestId: string;
  pullLagMs: number;
  /** set once the caller is authenticated */
  userId?: string;
  sessionId?: string;
  /** the agent services (Claude, providers, Google tokens, embeddings, queue), built on first use */
  services: () => Services;
}

type Handler = (ctx: Ctx) => Promise<Response>;

export interface Route {
  method: 'GET' | 'POST' | 'GET|POST';
  auth: boolean;
  google?: boolean;
  run: Handler;
}

const ROUTES: Record<string, Route> = {
  '/auth/google/start': { method: 'GET', auth: false, google: true, run: googleStart },
  '/auth/google/callback': { method: 'GET', auth: false, google: true, run: googleCallback },
  '/auth/session': { method: 'POST', auth: false, run: session },
  '/auth/refresh': { method: 'POST', auth: false, run: refresh },
  '/auth/logout': { method: 'POST', auth: true, run: logout },
  '/auth/me': { method: 'GET', auth: true, run: me },
  '/sync/status': { method: 'GET|POST', auth: true, run: syncStatus },
  '/sync/pull': { method: 'POST', auth: true, run: syncPull },
  '/sync/push': { method: 'POST', auth: true, run: syncPush },
  '/account/export': { method: 'POST', auth: true, run: accountExport },
  '/account/delete': { method: 'POST', auth: true, run: accountDelete },
  ...INTEGRATION_ROUTES,
  ...goalRoutes,
  ...scoreRoutes,
  ...researchRoutes,
  ...sourceRoutes,
  ...pathRoutes,
  ...draftRoutes,
  ...replyRoutes,
  ...calendarRoutes,
  ...memoryRoutes,
  ...settingsRoutes,
  ...cadenceRoutes,
};

/** The secrets a route needs that are not set. */
export function missingSecrets(deps: ApiDeps, google: boolean): string[] {
  const m: string[] = [];
  if (!deps.db) m.push('SUPABASE_DB_URL');
  if (!sessionSecretUsable(deps.env.sessionSecret)) m.push('ORBIT_SESSION_SECRET');
  if (google) {
    if (!deps.env.googleClientId) m.push('ORBIT_GOOGLE_CLIENT_ID');
    if (!deps.env.googleClientSecret) m.push('ORBIT_GOOGLE_CLIENT_SECRET');
    if (!deps.env.googleRedirectUri) m.push('ORBIT_GOOGLE_REDIRECT_URI');
  }
  return m;
}

export function makeApiHandler(deps: ApiDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? silentLogger;
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const salt = deps.salt ?? 'orbit';
  const appUrl = (deps.env.appUrl || DEFAULT_APP_URL).replace(/\/+$/, '');
  const origins = originPolicy(appUrl);
  const take = deps.take ?? (deps.db ? sqlTake(deps.db) : memoryTake(() => now().getTime()));
  const google: GoogleConfig | undefined =
    deps.env.googleClientId && deps.env.googleClientSecret && deps.env.googleRedirectUri
      ? {
          clientId: deps.env.googleClientId,
          clientSecret: deps.env.googleClientSecret,
          redirectUri: deps.env.googleRedirectUri,
          fetch: doFetch,
          jwks: deps.jwks,
          now,
        }
      : undefined;
  const agent: AgentConfig = {
    ...deps.agent,
    fetch: deps.agent?.fetch ?? deps.fetch,
    env: {
      googleClientId: deps.env.googleClientId,
      googleClientSecret: deps.env.googleClientSecret,
      googleRedirectUri: deps.env.googleRedirectUri,
      unipileKey: deps.env.unipileKey,
      unipileBase: deps.env.unipileBase,
      ...deps.agent?.env,
    },
  };

  return async (req) => {
    const started = Date.now();
    const rid = requestId(req);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^.*\/orbit-api(?=\/|$)/, '') || '/';
    const origin = req.headers.get('origin');
    const allowedOrigin = !!origin && origins(origin);
    const h: Headers_ = { ...corsHeaders(origin, allowedOrigin), 'x-request-id': rid };
    let userId: string | undefined;
    let res: Response;
    try {
      res = await route();
    } catch (e) {
      res = errorResponse(e, h);
      if (!(e instanceof HttpError))
        await log.log({
          fn: 'orbit-api',
          route: path,
          request_id: rid,
          status: 'exception',
          duration_ms: 0,
          error: e instanceof Error ? e.name : 'error',
          // where it broke, and the engine's own words for range and type errors (never the request's data)
          error_message:
            e instanceof RangeError || e instanceof TypeError ? e.message.slice(0, 160) : undefined,
          error_at:
            e instanceof Error
              ? (e.stack ?? '')
                  .split('\n')
                  .slice(1, 4)
                  .map((l) => l.trim().replace(/https?:\/\/\S+\//, ''))
                  .join(' | ')
                  .slice(0, 400)
              : undefined,
          userId,
        });
    }
    await log.log({
      fn: 'orbit-api',
      route: path,
      request_id: rid,
      status: res.status,
      duration_ms: Date.now() - started,
      userId,
    });
    return res;

    async function route(): Promise<Response> {
      if (req.method === 'OPTIONS') {
        if (!allowedOrigin) return new Response(null, { status: 403, headers: h });
        return preflight(req, h);
      }
      // browsers send Origin on fetches; other callers (curl, server code) send none and rely on their token
      if (origin && !allowedOrigin) throw new HttpError(403, 'forbidden', 'origin not allowed');
      const r = ROUTES[path];
      if (!r) throw notFound();
      if (!r.method.split('|').includes(req.method)) throw new HttpError(405, 'method_not_allowed', r.method);
      const missing = missingSecrets(deps, !!r.google);
      if (missing.length) return unconfigured(h, missing);
      const db = deps.db!;

      const visitor = (await sha256Hex(`${salt}:${clientIp(req)}`)).slice(0, 32);
      await limit(ipBuckets('api', visitor, now(), limits.ipPerMinute));

      let services: Services | undefined;
      const ctx: Ctx = {
        req,
        url,
        db,
        env: { ...deps.env, appUrl },
        session: { secret: deps.env.sessionSecret!, now },
        google,
        fetch: doFetch,
        now,
        requestId: rid,
        pullLagMs: deps.pullLagMs ?? 2000,
        services: () => (services ??= makeServices(agent, { db, now })),
      };
      if (r.auth) {
        const claims = await authenticate(db, ctx.session, req.headers.get('authorization'));
        ctx.userId = userId = claims.userId;
        ctx.sessionId = claims.sessionId;
        const who = (await sha256Hex(`${salt}:${claims.userId}`)).slice(0, 32);
        await limit(
          userBuckets('api', who, now(), { perMinute: limits.userPerMinute, perDay: limits.userPerDay }),
        );
      }
      const out = await r.run(ctx);
      // route handlers return bare responses; add CORS and the request id to each
      const headers = new Headers(out.headers);
      for (const [k, v] of Object.entries(h)) if (!headers.has(k)) headers.set(k, v);
      return new Response(out.body, { status: out.status, headers });
    }

    async function limit(bs: ReturnType<typeof ipBuckets>) {
      let verdict: { allowed: boolean; over?: string };
      try {
        verdict = await take(bs);
      } catch {
        throw new HttpError(503, 'unavailable', 'unavailable right now');
      }
      if (!verdict.allowed) {
        const minute = verdict.over?.includes(':min:') ?? false;
        throw new HttpError(
          429,
          'rate_limited',
          minute ? 'too many requests, try again shortly' : "today's limit reached",
          {
            'x-orbit-limit': minute ? 'minute' : 'day',
            ...(minute ? { 'retry-after': '30' } : {}),
          },
        );
      }
    }
  };
}
