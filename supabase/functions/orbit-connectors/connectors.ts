/**
 * Orbit's connector proxy: Unipile (live LinkedIn: hosted connect, the student's connections, mutual connections)
 * and Village (warm intro paths). Both third-party keys stay on the server here, never in the browser. Only Orbit's
 * own origins may call it, and only the routes below. Kept free of Deno APIs so it runs under Node tests.
 *
 * Routes (POST, JSON):
 *   /connect/start, /connect/status, /relations, /mutuals  -> Unipile
 *   /paths                                                 -> Village
 * A route whose provider key is not set returns 503 with x-orbit-connector: unconfigured, so the app shows the
 * CSV fallback instead. The exact upstream request and response mapping lives in the two adapter functions, so a
 * live test with real keys only changes this file.
 */

export interface ConnectorDeps {
  unipileKey: string | undefined;
  unipileBase: string | undefined; // e.g. https://api{dc}.unipile.com:{port}
  villageKey: string | undefined;
  villageBase: string | undefined;
  origins: (origin: string) => boolean;
  fetch?: typeof fetch;
}

export function defaultOrigins(origin: string): boolean {
  if (origin === 'https://princecharming001.github.io') return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function cors(origin: string | null, allowed: boolean): Record<string, string> {
  if (!origin || !allowed) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': 'x-orbit-connector',
    Vary: 'Origin',
  };
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const unconfigured = (h: Record<string, string>) =>
  json(503, { error: 'not configured' }, { ...h, 'x-orbit-connector': 'unconfigured' });

export function makeHandler(deps: ConnectorDeps): (req: Request) => Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
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
    if (!allowed) return json(403, { error: 'origin not allowed' }, h);
    if (req.method !== 'POST') return json(405, { error: 'POST only' }, h);
    const path = new URL(req.url).pathname.replace(/.*\/orbit-connectors/, '') || '/';
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    try {
      if (path === '/paths') {
        if (!deps.villageKey || !deps.villageBase) return unconfigured(h);
        return json(200, await villagePaths(deps, body, doFetch), h);
      }
      if (path.startsWith('/connect') || path === '/relations' || path === '/mutuals') {
        if (!deps.unipileKey || !deps.unipileBase) return unconfigured(h);
        if (path === '/connect/start') return json(200, await unipileConnectStart(deps, doFetch), h);
        if (path === '/connect/status') return json(200, await unipileConnectStatus(deps, body, doFetch), h);
        if (path === '/relations') return json(200, await unipileRelations(deps, body, doFetch), h);
        if (path === '/mutuals') return json(200, await unipileMutuals(deps, body, doFetch), h);
      }
      return json(404, { error: 'no such route' }, h);
    } catch (e) {
      return json(502, { error: e instanceof Error ? e.message : 'upstream error' }, h);
    }
  };
}

// ---- Unipile adapters (shapes per Unipile's API; corrected against a live key before launch) ----------------

function uHeaders(deps: ConnectorDeps): Record<string, string> {
  return { 'content-type': 'application/json', accept: 'application/json', 'X-API-KEY': deps.unipileKey! };
}

async function unipileConnectStart(deps: ConnectorDeps, doFetch: typeof fetch) {
  const res = await doFetch(`${deps.unipileBase}/api/v1/hosted/accounts/link`, {
    method: 'POST',
    headers: uHeaders(deps),
    body: JSON.stringify({ providers: ['LINKEDIN'], type: 'create' }),
  });
  if (!res.ok) throw new Error(`unipile ${res.status}`);
  const b = (await res.json()) as { url?: string; object_id?: string; id?: string };
  return { url: b.url, ref: b.object_id ?? b.id };
}

async function unipileConnectStatus(
  deps: ConnectorDeps,
  body: Record<string, unknown>,
  doFetch: typeof fetch,
) {
  const ref = String(body.ref ?? '');
  const res = await doFetch(`${deps.unipileBase}/api/v1/accounts?object_id=${encodeURIComponent(ref)}`, {
    headers: uHeaders(deps),
  });
  if (!res.ok) return { status: 'pending' };
  const b = (await res.json()) as { items?: { id?: string; sources?: { status?: string }[] }[] };
  const acc = b.items?.[0];
  const ok = acc?.sources?.some((s) => s.status === 'OK');
  return ok ? { status: 'connected', accountId: acc!.id } : { status: 'pending' };
}

async function unipileRelations(deps: ConnectorDeps, body: Record<string, unknown>, doFetch: typeof fetch) {
  const accountId = String(body.accountId ?? '');
  const cursor = body.cursor ? `&cursor=${encodeURIComponent(String(body.cursor))}` : '';
  const res = await doFetch(
    `${deps.unipileBase}/api/v1/users/relations?account_id=${encodeURIComponent(accountId)}&limit=200${cursor}`,
    { headers: uHeaders(deps) },
  );
  if (!res.ok) throw new Error(`unipile ${res.status}`);
  const b = (await res.json()) as {
    items?: Record<string, unknown>[];
    cursor?: string | null;
  };
  return {
    items: (b.items ?? []).map((r) => ({
      first_name: r.first_name,
      last_name: r.last_name,
      headline: r.headline,
      position: r.occupation ?? r.headline,
      company: r.company,
      public_profile_url: r.public_profile_url ?? r.profile_url,
      connected_at: r.created_at,
      member_id: r.member_id ?? r.provider_id ?? r.id,
    })),
    cursor: b.cursor ?? null,
  };
}

async function unipileMutuals(deps: ConnectorDeps, body: Record<string, unknown>, doFetch: typeof fetch) {
  const accountId = String(body.accountId ?? '');
  const target = String(body.targetMemberId ?? '');
  // LinkedIn search for the student's 1st-degree connections who are connected to the target
  const res = await doFetch(
    `${deps.unipileBase}/api/v1/linkedin/search?account_id=${encodeURIComponent(accountId)}`,
    {
      method: 'POST',
      headers: uHeaders(deps),
      body: JSON.stringify({
        api: 'classic',
        category: 'people',
        network_distance: ['DISTANCE_1'],
        connections_of: target,
      }),
    },
  );
  if (!res.ok) throw new Error(`unipile ${res.status}`);
  const b = (await res.json()) as { items?: Record<string, unknown>[] };
  return {
    mutuals: (b.items ?? []).map((m) => ({
      name: m.name ?? `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim(),
      headline: m.headline,
      url: m.public_profile_url ?? m.profile_url,
      member_id: m.member_id ?? m.id,
    })),
  };
}

// ---- Village adapter --------------------------------------------------------------------------------------

async function villagePaths(deps: ConnectorDeps, body: Record<string, unknown>, doFetch: typeof fetch) {
  const res = await doFetch(`${deps.villageBase}/v1/paths`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.villageKey}` },
    body: JSON.stringify({
      target: { name: body.name, company: body.company, linkedin_url: body.linkedin_url },
      limit: 5,
    }),
  });
  if (!res.ok) throw new Error(`village ${res.status}`);
  const b = (await res.json()) as {
    paths?: {
      introducer?: { name?: string; headline?: string; linkedin_url?: string };
      warmth_score?: number;
      warmth?: number;
      path?: string[];
      hops?: string[];
      reason?: string;
    }[];
  };
  return {
    paths: (b.paths ?? []).map((p) => ({
      introducer: p.introducer,
      warmth: p.warmth ?? p.warmth_score,
      hops: p.hops ?? p.path,
      note: p.reason,
    })),
  };
}
