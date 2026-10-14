import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPS, checkBudget, MONTHLY_TOTAL_USD, recordUsage } from '../../functions/_shared/budget.ts';
import {
  base64url,
  fromBase64,
  fromBase64url,
  isUuid,
  randomToken,
  sha256Bytes,
  timingSafeEqual,
} from '../../functions/_shared/crypto.ts';
import { toParam, toText } from '../../functions/_shared/db.ts';
import {
  authUrl,
  exchangeCode,
  type GoogleConfig,
  GoogleError,
  googleTokenSource,
  NeedsReauth,
  pkcePair,
  refreshAccessToken,
  revokeToken,
  verifyIdToken,
} from '../../functions/_shared/google.ts';
import {
  errorResponse,
  HttpError,
  json,
  makeLogger,
  originPolicy,
  readJson,
  requestId,
} from '../../functions/_shared/http.ts';
import { clientIp, defaultOrigins } from '../../functions/_shared/origins.ts';
import { queueFor, sqlQueue } from '../../functions/_shared/queue.ts';
import { memoryTake, sqlTake, userBuckets } from '../../functions/_shared/ratelimit.ts';
import {
  authenticate,
  createLoginCode,
  createSession,
  redeemLoginCode,
  refreshSession,
  revokeSession,
  sessionKey,
  sessionSecretUsable,
  signAccess,
  verifyAccess,
} from '../../functions/_shared/session.ts';
import { sqlVault } from '../../functions/_shared/vault.ts';
import { CLIENT_ID, type FakeGoogle, fakeGoogle, jsonRes, recordingFetch } from '../helpers/google.ts';
import { freshDb, makeUser, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
let g: FakeGoogle;
beforeAll(async () => {
  t = await freshDb();
  g = await fakeGoogle();
});
afterAll(async () => {
  await t.pg.close();
});

const SECRET = 'c2Vzc2lvbi1zZWNyZXQtcGxhY2Vob2xkZXItMzItYnl0ZXMhIQ==';

describe('crypto', () => {
  it('round-trips base64url and makes 43-character tokens', () => {
    const bytes = new Uint8Array([0, 255, 62, 63, 1]);
    expect(fromBase64url(base64url(bytes))).toEqual(bytes);
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(randomToken());
    expect(fromBase64('***')).toBeUndefined();
    expect(fromBase64(SECRET)!.length).toBeGreaterThanOrEqual(32);
  });

  it('compares secrets', async () => {
    expect(await timingSafeEqual('abc', 'abc')).toBe(true);
    expect(await timingSafeEqual('abc', 'abd')).toBe(false);
    expect(await timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(await timingSafeEqual(null, 'abc')).toBe(false);
    expect(await timingSafeEqual('', '')).toBe(false);
  });

  it('recognizes uuids', () => {
    expect(isUuid(crypto.randomUUID())).toBe(true);
    expect(isUuid('x')).toBe(false);
    expect(isUuid(5)).toBe(false);
  });
});

describe('db helpers', () => {
  it('turns template strings into numbered parameters', () => {
    const tpl = (s: TemplateStringsArray, ..._v: unknown[]) => toText(s);
    expect(tpl`select ${1}, ${2}::int`).toBe('select $1, $2::int');
  });

  it('serializes arrays, objects and dates the same way for both adapters', () => {
    expect(toParam(['a', 'b "c"', null, 'd\\e'])).toBe('{"a","b \\"c\\"",NULL,"d\\\\e"}');
    expect(toParam({ a: 1 })).toBe('{"a":1}');
    expect(toParam(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00:00:00.000Z');
    expect(toParam(undefined)).toBeNull();
    expect(toParam(5)).toBe(5);
  });

  it('round-trips awkward text arrays through Postgres', async () => {
    const values = ['plain', 'with "quotes"', 'back\\slash', 'comma,brace{}', ''];
    const [r] = await t.db.sql<{ a: string[] }>`select ${values}::text[] as a`;
    expect(r!.a).toEqual(values);
  });

  it('rolls a transaction back on error, and a nested one to its savepoint', async () => {
    const u = await makeUser(t.db);
    await expect(
      t.db.begin(async (tx) => {
        await tx.sql`update orbit.users set school = 'MIT' where id = ${u}::uuid`;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await t.db.begin(async (tx) => {
      await tx.sql`update orbit.users set degree = 'BS' where id = ${u}::uuid`;
      await tx
        .begin(async (inner) => {
          await inner.sql`update orbit.users set school = 'Stanford' where id = ${u}::uuid`;
          throw new Error('inner');
        })
        .catch(() => undefined);
    });
    const [row] = await t.db.sql<{ school: string | null; degree: string }>`
      select school, degree from orbit.users where id = ${u}::uuid`;
    expect(row).toEqual({ school: null, degree: 'BS' });
  });
});

describe('http', () => {
  it('allows Orbit origins plus the configured app', () => {
    const p = originPolicy('https://orbit.example.com/app');
    expect(p('https://princecharming001.github.io')).toBe(true);
    expect(p('http://localhost:5173')).toBe(true);
    expect(p('https://orbit.example.com')).toBe(true);
    expect(p('https://evil.example.com')).toBe(false);
    expect(defaultOrigins('https://princecharming001.github.io')).toBe(true);
  });

  it('maps errors to JSON without leaking internals', async () => {
    const e = errorResponse(new HttpError(429, 'rate_limited', 'slow down', { 'retry-after': '30' }));
    expect(e.status).toBe(429);
    expect(e.headers.get('retry-after')).toBe('30');
    expect(await e.json()).toEqual({ error: { code: 'rate_limited', message: 'slow down' } });
    const boom = errorResponse(new Error('password=hunter2'));
    expect(boom.status).toBe(500);
    expect(await boom.text()).not.toContain('hunter2');
    expect(json(200, { a: 1 }).headers.get('cache-control')).toBe('no-store');
  });

  it('reads JSON bodies strictly', async () => {
    const r = (body: string) => new Request('https://x', { method: 'POST', body });
    expect(await readJson(r('{"a":1}'))).toEqual({ a: 1 });
    await expect(readJson(r('[1]'))).rejects.toThrow(HttpError);
    await expect(readJson(r('nope'))).rejects.toThrow(HttpError);
    await expect(readJson(r(''))).rejects.toThrow(HttpError);
    expect(await readJson(r(''), { optional: true })).toEqual({});
    await expect(readJson(r('{"a":"xxxxxxxx"}'), { maxBytes: 5 })).rejects.toMatchObject({ status: 413 });
  });

  it('keeps a sane request id and makes one otherwise', () => {
    expect(requestId(new Request('https://x', { headers: { 'x-request-id': 'abc-12345' } }))).toBe(
      'abc-12345',
    );
    expect(requestId(new Request('https://x', { headers: { 'x-request-id': 'bad id<>' } }))).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(clientIp(new Request('https://x', { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }))).toBe(
      '1.2.3.4',
    );
  });

  it('logs one JSON line per call with the user id hashed', async () => {
    const lines: string[] = [];
    const log = makeLogger(
      'salt',
      (l) => lines.push(l),
      () => new Date('2026-10-14T00:00:00Z'),
    );
    const userId = crypto.randomUUID();
    await log.log({
      fn: 'orbit-api',
      route: '/sync/pull',
      status: 200,
      duration_ms: 12,
      userId,
      request_id: 'r1',
    });
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({
      ts: '2026-10-14T00:00:00.000Z',
      fn: 'orbit-api',
      route: '/sync/pull',
      status: 200,
    });
    expect(line.user_id_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(lines[0]).not.toContain(userId);
  });
});

describe('rate limits', () => {
  it('counts in memory and in the shared SQL store', async () => {
    const now = new Date('2026-10-14T10:00:00Z');
    const bs = userBuckets('test', `u${Math.random()}`, now, { perMinute: 2, perDay: 10 });
    for (const take of [memoryTake(() => now.getTime()), sqlTake(t.db)]) {
      expect((await take(bs)).allowed).toBe(true);
      expect((await take(bs)).allowed).toBe(true);
      const third = await take(bs);
      expect(third.allowed).toBe(false);
      expect(third.over).toContain(':min:');
    }
  });
});

describe('sessions', () => {
  const cfg = { secret: SECRET };

  it('signs and verifies HS256 access tokens with aud orbit and a one-hour life', async () => {
    const claims = { userId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
    const { token, expiresAt } = await signAccess(cfg, claims);
    const [header, payload] = token
      .split('.')
      .slice(0, 2)
      .map((p) => JSON.parse(new TextDecoder().decode(fromBase64url(p))));
    expect(header).toMatchObject({ alg: 'HS256' });
    expect(payload).toMatchObject({ sub: claims.userId, sid: claims.sessionId, aud: 'orbit' });
    expect(payload.exp - payload.iat).toBe(3600);
    expect(Date.parse(expiresAt)).toBe(payload.exp * 1000);
    expect(await verifyAccess(cfg, token)).toEqual(claims);
    await expect(verifyAccess({ secret: `${SECRET}x` }, token)).rejects.toMatchObject({ status: 401 });
    await expect(
      verifyAccess({ ...cfg, now: () => new Date(Date.now() + 3601_000) }, token),
    ).rejects.toMatchObject({
      status: 401,
    });
    const [h, p, sig] = token.split('.') as [string, string, string];
    const flipped = sig[10] === 'A' ? 'B' : 'A';
    const tampered = `${h}.${p}.${sig.slice(0, 10)}${flipped}${sig.slice(11)}`;
    await expect(verifyAccess(cfg, tampered)).rejects.toMatchObject({ status: 401 });
  });

  it('uses the decoded bytes of a base64 secret and refuses short secrets', () => {
    expect(sessionKey(SECRET).length).toBeGreaterThanOrEqual(32);
    expect(sessionSecretUsable('short')).toBe(false);
    expect(sessionSecretUsable(SECRET)).toBe(true);
  });

  it('stores only the hash of the refresh token, rotates it, and revokes it', async () => {
    const u = await makeUser(t.db);
    const s = await createSession(t.db, cfg, u, 'test-agent');
    const stored = await t.db.sql<{
      refresh_hash: string;
    }>`select refresh_hash from orbit.sessions where id = ${s.sessionId}::uuid`;
    expect(stored[0]!.refresh_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]!.refresh_hash).not.toBe(s.refreshToken);
    const r = await refreshSession(t.db, cfg, s.refreshToken);
    expect(r?.sessionId).toBe(s.sessionId);
    expect(await refreshSession(t.db, cfg, s.refreshToken)).toBeNull();
    expect(await authenticate(t.db, cfg, `Bearer ${r!.accessToken}`)).toMatchObject({ userId: u });
    expect(await revokeSession(t.db, r!.refreshToken)).toBe(true);
    await expect(authenticate(t.db, cfg, `Bearer ${r!.accessToken}`)).rejects.toMatchObject({ status: 401 });
    await expect(authenticate(t.db, cfg, null)).rejects.toMatchObject({ status: 401 });
  });

  it('expires refresh tokens after 30 days', async () => {
    const u = await makeUser(t.db);
    const s = await createSession(t.db, cfg, u);
    const later = { ...cfg, now: () => new Date(Date.now() + 31 * 86_400_000) };
    expect(await refreshSession(t.db, later, s.refreshToken)).toBeNull();
  });

  it('login codes work once, within two minutes', async () => {
    const u = await makeUser(t.db);
    const now = new Date();
    const code = await createLoginCode(t.db, u, now);
    expect(await redeemLoginCode(t.db, code, now)).toBe(u);
    expect(await redeemLoginCode(t.db, code, now)).toBeNull();
    const late = await createLoginCode(t.db, u, now);
    expect(await redeemLoginCode(t.db, late, new Date(now.getTime() + 121_000))).toBeNull();
  });
});

describe('google', () => {
  const cfg = (over: Partial<GoogleConfig> = {}): GoogleConfig => ({
    clientId: CLIENT_ID,
    clientSecret: 'secret-placeholder',
    redirectUri: 'https://ref.supabase.co/functions/v1/orbit-api/auth/google/callback',
    jwks: g.jwks,
    ...over,
  });

  it('makes an S256 PKCE pair and the consent URL', async () => {
    const { verifier, challenge } = await pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(base64url(await sha256Bytes(verifier)));
    const u = new URL(
      authUrl(cfg(), { state: 's', challenge, scopes: ['openid', 'email'], loginHint: 'a@b.c' }),
    );
    expect(u.searchParams.get('scope')).toBe('openid email');
    expect(u.searchParams.get('login_hint')).toBe('a@b.c');
    expect(u.searchParams.get('code_challenge')).toBe(challenge);
  });

  it('exchanges a code and maps Google errors', async () => {
    const ok = recordingFetch(() =>
      jsonRes(200, { access_token: 'a', expires_in: 3600, refresh_token: 'r' }),
    );
    const t1 = await exchangeCode(cfg({ fetch: ok.fetch }), 'code1', 'verifier1');
    expect(t1.refresh_token).toBe('r');
    const form = new URLSearchParams(ok.calls[0]!.body);
    expect(Object.fromEntries(form)).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code1',
      code_verifier: 'verifier1',
      client_id: CLIENT_ID,
    });
    const bad = recordingFetch(() => jsonRes(400, { error: 'invalid_grant' }));
    await expect(exchangeCode(cfg({ fetch: bad.fetch }), 'c', 'v')).rejects.toBeInstanceOf(GoogleError);
  });

  it('verifies id_tokens: signature, audience, issuer and expiry', async () => {
    const claims = await verifyIdToken(cfg(), await g.idToken({ sub: '123' }));
    expect(claims).toMatchObject({
      sub: '123',
      email: 'maya@example.com',
      emailVerified: true,
      givenName: 'Maya',
    });
    await expect(verifyIdToken(cfg(), await g.idToken({}, { aud: 'other' }))).rejects.toThrow();
    await expect(
      verifyIdToken(cfg(), await g.idToken({}, { iss: 'https://evil.example.com' })),
    ).rejects.toThrow();
    await expect(verifyIdToken(cfg(), await g.idToken({}, { expSec: -60 }))).rejects.toThrow();
    const other = await fakeGoogle();
    await expect(verifyIdToken(cfg(), await other.idToken())).rejects.toThrow();
  });

  it('turns invalid_grant into NeedsReauth', async () => {
    const f = recordingFetch(() => jsonRes(400, { error: 'invalid_grant' }));
    await expect(refreshAccessToken(cfg({ fetch: f.fetch }), 'r')).rejects.toBeInstanceOf(NeedsReauth);
  });

  it('mints access tokens from the Vault refresh token, caches them, and marks the account on invalid_grant', async () => {
    const u = await makeUser(t.db);
    const vault = sqlVault(t.db);
    const sid = await vault.put(`google_refresh:${u}`, 'refresh-placeholder');
    await t.db.sql`insert into orbit.integration_accounts (user_id, provider, token_secret_id)
      values (${u}::uuid, 'google', ${sid}::uuid)`;
    let clock = Date.now();
    let answer = jsonRes(200, { access_token: 'at-1', expires_in: 3600 });
    const f = recordingFetch(() => answer.clone());
    const src = googleTokenSource(cfg({ fetch: f.fetch, now: () => new Date(clock) }), { db: t.db, vault });
    expect(await src.accessToken(u)).toBe('at-1');
    expect(await src.accessToken(u)).toBe('at-1');
    expect(f.calls).toHaveLength(1);
    expect(new URLSearchParams(f.calls[0]!.body).get('refresh_token')).toBe('refresh-placeholder');
    clock += 56 * 60_000; // past lifetime minus 5 minutes
    answer = jsonRes(400, { error: 'invalid_grant' });
    await expect(src.accessToken(u)).rejects.toBeInstanceOf(NeedsReauth);
    const [row] = await t.db.sql<{ status: string }>`
      select status from orbit.integration_accounts where user_id = ${u}::uuid`;
    expect(row!.status).toBe('needs_reauth');
    await expect(src.accessToken(u)).rejects.toBeInstanceOf(NeedsReauth);
    expect(f.calls).toHaveLength(2);
  });

  it('revokes tokens', async () => {
    const f = recordingFetch(() => new Response(null, { status: 200 }));
    expect(await revokeToken({ fetch: f.fetch }, 'tok')).toBe(true);
    expect(f.calls[0]).toMatchObject({ url: 'https://oauth2.googleapis.com/revoke', method: 'POST' });
  });
});

describe('queue', () => {
  it('routes kinds to queues and runs the pgmq calls', async () => {
    expect(queueFor('send.draft')).toBe('orbit_send');
    expect(queueFor('sync.gmail.backfill')).toBe('orbit_sync');
    expect(() => queueFor('mystery')).toThrow();
    const q = sqlQueue(t.db);
    const id = await q.enqueue({ kind: 'noop', userId: null, payload: {}, dedupeKey: 'queue-test' });
    expect(id).toBeGreaterThan(0);
    expect(await q.enqueue({ kind: 'noop', userId: null, payload: {}, dedupeKey: 'queue-test' })).toBeNull();
    const [m] = await q.read('orbit_enrich', 30, 10);
    expect(m).toMatchObject({ msgId: id, readCt: 1, message: { kind: 'noop', dedupeKey: 'queue-test' } });
    expect(await q.read('orbit_enrich', 30, 10)).toHaveLength(0);
    await q.setVt('orbit_enrich', id!, 0);
    expect(await q.read('orbit_enrich', 30, 10)).toHaveLength(1);
    await q.archive('orbit_enrich', id!);
    expect(await t.db.sql`select 1 from pgmq.a_orbit_enrich where msg_id = ${id}::bigint`).toHaveLength(1);
    const id2 = (await q.enqueue({ kind: 'noop', userId: null, payload: {} }, { delaySec: 0 }))!;
    await q.delete('orbit_enrich', id2);
    expect(await t.db.sql`select 1 from pgmq.q_orbit_enrich`).toHaveLength(0);
  });
});

describe('budget (§13.5)', () => {
  it('stops Claude at $1.50 a day and resets at midnight UTC', async () => {
    const u = await makeUser(t.db);
    const now = new Date();
    expect(await checkBudget(t.db, u, { provider: 'anthropic' }, now)).toEqual({ ok: true });
    await recordUsage(t.db, {
      userId: u,
      provider: 'anthropic',
      operation: 'compose',
      units: 1,
      costUsd: 1.5,
    });
    const v = await checkBudget(t.db, u, { provider: 'anthropic' }, now);
    expect(v).toMatchObject({ ok: false, reason: 'budget_exceeded', cap: 'claude_daily_usd', limit: 1.5 });
    if (!v.ok) expect(new Date(v.resetsAt).getUTCHours()).toBe(0);
    // other providers are unaffected
    expect(await checkBudget(t.db, u, { provider: 'exa', costUsd: 0.01 }, now)).toEqual({ ok: true });
  });

  it('counts credits and views per operation', async () => {
    const u = await makeUser(t.db);
    await recordUsage(t.db, {
      userId: u,
      provider: 'unipile',
      operation: 'profile_view',
      units: 40,
      costUsd: 0,
    });
    expect(
      await checkBudget(t.db, u, { provider: 'unipile', operation: 'profile_view', units: 1 }),
    ).toMatchObject({
      ok: false,
      cap: 'unipile_profile_views_daily',
    });
    expect(await checkBudget(t.db, u, { provider: 'unipile', operation: 'search', units: 1 })).toEqual({
      ok: true,
    });
    await recordUsage(t.db, { userId: u, provider: 'village', operation: 'paths', units: 46, costUsd: 0.92 });
    expect(await checkBudget(t.db, u, { provider: 'village', units: 5 })).toMatchObject({
      cap: 'village_daily_credits',
    });
    expect(await checkBudget(t.db, u, { provider: 'village', units: 4 })).toEqual({ ok: true });
    expect(CAPS.map((c) => c.id)).toContain('apollo_match_daily_credits');
  });

  it('caps the month at $25 across providers', async () => {
    const u = await makeUser(t.db);
    await t.db.sql`insert into orbit.usage_ledger (user_id, provider, operation, units, cost_usd, created_at)
      values (${u}::uuid, 'exa', 'search', 1, ${MONTHLY_TOTAL_USD}::numeric, date_trunc('month', now()) + interval '1 minute')`;
    expect(await checkBudget(t.db, u, { provider: 'anthropic' })).toMatchObject({ cap: 'monthly_total_usd' });
  });
});
