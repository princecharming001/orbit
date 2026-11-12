/** Plan 43 §5: signing in with X, its status and disconnecting, and tokens refreshed on a 401. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryTake } from '../../functions/_shared/ratelimit.ts';
import { createSession } from '../../functions/_shared/session.ts';
import { SocialSignInNeeded } from '../../functions/_shared/social/adapter.ts';
import { xAdapterFor } from '../../functions/_shared/social/x/client.ts';
import { X_CONSENT_VERSION, type XConfig } from '../../functions/_shared/social/x/config.ts';
import {
  loadXState,
  storeXTokens,
  xAccessName,
  xRefreshName,
} from '../../functions/_shared/social/x/oauth.ts';
import { sqlVault } from '../../functions/_shared/vault.ts';
import { makeApiHandler } from '../../functions/orbit-api/api.ts';
import { upsertGoogleUser } from '../../functions/orbit-api/auth.ts';
import { FAKE_X_CLIENT_ID, FAKE_X_CLIENT_SECRET, FakeX } from '../helpers/fakeX.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

const BASE = 'https://ref.supabase.co/functions/v1/orbit-api';
const APP = 'https://princecharming001.github.io/orbit';
const SECRET = 'c2Vzc2lvbi1zZWNyZXQtcGxhY2Vob2xkZXItMzItYnl0ZXMhIQ==';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

const cfg = (over: Partial<XConfig> = {}): XConfig => ({
  clientId: FAKE_X_CLIENT_ID,
  clientSecret: FAKE_X_CLIENT_SECRET,
  studentMonthlyUsd: 15,
  orbitMonthlyUsd: 500,
  listLimit: 600,
  offered: true,
  ...over,
});

function api(fake: FakeX, x: XConfig | undefined) {
  return makeApiHandler({
    env: {
      googleClientId: 'google-client-placeholder',
      googleClientSecret: 'google-secret-placeholder',
      googleRedirectUri: `${BASE}/auth/google/callback`,
      sessionSecret: SECRET,
      appUrl: APP,
      x,
    },
    db: t.db,
    fetch: fake.fetch,
    take: memoryTake(),
  });
}

async function signedIn() {
  const sub = `s-${Math.random()}`;
  const userId = (await upsertGoogleUser(t.db, {
    sub,
    email: `${sub}@example.com`,
    name: 'Test User',
    scopes: ['openid'],
    refreshToken: 'refresh-placeholder',
  }))!;
  const tokens = await createSession(t.db, { secret: SECRET }, userId);
  return { userId, token: tokens.accessToken };
}

const post = (path: string, token: string, body: unknown = {}) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const get = (path: string, token?: string) =>
  new Request(`${BASE}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

function world() {
  const fake = new FakeX();
  fake.addUser({ id: '100', username: 'maya_c', name: 'Maya Chen' });
  fake.addUser({ id: '200', username: 'priya', name: 'Priya Rao' });
  return fake;
}

/** Start, then come back from X with a code for `xId`. */
async function connect(fake: FakeX, handler: ReturnType<typeof api>, token: string, xId = '100') {
  const r = await handler(post('/x/connect/start', token, { consent: true }));
  const { url } = (await r.json()) as { url: string };
  const state = new URL(url).searchParams.get('state')!;
  return handler(get(`/x/callback?state=${state}&code=${fake.code(xId)}`));
}

describe('/x/connect/start', () => {
  it('needs the consent first, then stores the PKCE state and records the consent', async () => {
    const fake = world();
    const handler = api(fake, cfg());
    const { userId, token } = await signedIn();
    const refused = await handler(post('/x/connect/start', token, {}));
    expect(refused.status).toBe(400);
    expect(await t.db.sql`select 1 from orbit.oauth_states where user_id = ${userId}::uuid`).toHaveLength(0);

    const r = await handler(post('/x/connect/start', token, { consent: true }));
    expect(r.status).toBe(200);
    const { url } = (await r.json()) as { url: string };
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('https://x.com/i/oauth2/authorize');
    expect(u.searchParams.get('client_id')).toBe(FAKE_X_CLIENT_ID);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('redirect_uri')).toBe(`${BASE}/x/callback`);
    expect(u.searchParams.get('scope')).toBe(
      'tweet.read users.read follows.read dm.read dm.write offline.access',
    );
    const [st] = await t.db.sql<{ state: string; code_verifier: string; scopes: string[] }>`
      select state, code_verifier, scopes from orbit.oauth_states where user_id = ${userId}::uuid`;
    expect(st!.state).toBe(u.searchParams.get('state'));
    expect(st!.code_verifier.length).toBeGreaterThan(40);
    expect(st!.scopes).toContain('dm.read');
    const [audit] = await t.db.sql<{ details: { version: string; at: string } }>`
      select details from orbit.audit_log where user_id = ${userId}::uuid and action = 'x.consent'`;
    expect(audit!.details.version).toBe(X_CONSENT_VERSION);
    expect(Number.isNaN(Date.parse(audit!.details.at))).toBe(false);
    expect((await loadXState(t.db, userId))!.status).toBe('connecting');
  });

  it('answers 503 "X is not set up" without the app or the owner switch', async () => {
    const fake = world();
    const { token } = await signedIn();
    for (const x of [
      undefined,
      cfg({ clientId: undefined }),
      cfg({ clientSecret: undefined }),
      cfg({ offered: false }),
    ]) {
      const r = await api(fake, x)(post('/x/connect/start', token, { consent: true }));
      expect(r.status).toBe(503);
      const body = (await r.json()) as { error: { message: string; missing: string[] } };
      expect(body.error.message).toBe('X is not set up');
      expect(body.error.missing.length).toBeGreaterThan(0);
      expect((await api(fake, x)(get('/x/status', token))).status).toBe(503);
    }
  });
});

describe('/x/callback', () => {
  it('stores both tokens in Vault, writes the row from /2/users/me and goes back to Settings', async () => {
    const fake = world();
    const handler = api(fake, cfg());
    const { userId, token } = await signedIn();
    const r = await connect(fake, handler, token);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(`${APP}/settings?x=connected`);
    const row = (await loadXState(t.db, userId))!;
    expect(row).toMatchObject({ status: 'active', socialAccountId: '100' });
    expect(row.state.username).toBe('maya_c');
    expect(row.state.consent?.version).toBe(X_CONSENT_VERSION);
    const vault = sqlVault(t.db);
    const refresh = await vault.get(row.refreshSecretId!);
    const access = await vault.get(row.state.accessSecretId!);
    expect(fake.refresh.get(refresh!)).toBe('100');
    expect(fake.access.get(access!)).toBe('100');
    const names = await t.db.sql<{ name: string }>`
      select name from vault.secrets where name in (${xAccessName(userId)}, ${xRefreshName(userId)}) order by name`;
    expect(names).toHaveLength(2);
    // the verifier X received is the one kept with the state
    expect([...fake.verifiers.values()][0]!.length).toBeGreaterThan(40);
    // /2/users/me was one paid user read
    const [ledger] = await t.db.sql<{ cost: string; op: string }>`
      select cost_usd::text as cost, operation as op from orbit.usage_ledger
       where user_id = ${userId}::uuid and provider = 'x'`;
    expect(ledger).toEqual({ cost: '0.01000', op: 'profile' });
    const [src] = await t.db.sql<{ state: string }>`
      select state from orbit.source_states where user_id = ${userId}::uuid and source = 'x'`;
    expect(src!.state).toBe('on');
    // the state is used once
    expect(await t.db.sql`select 1 from orbit.oauth_states where user_id = ${userId}::uuid`).toHaveLength(0);
  });

  it('fails back to Settings on a bad state, a denial or Orbit X limit, and revokes what it got', async () => {
    const fake = world();
    const { token, userId } = await signedIn();
    expect((await api(fake, cfg())(get('/x/callback?state=nope&code=x'))).headers.get('location')).toBe(
      `${APP}/settings?x=failed`,
    );
    const handler = api(fake, cfg());
    const r = await handler(post('/x/connect/start', token, { consent: true }));
    const state = new URL(((await r.json()) as { url: string }).url).searchParams.get('state');
    expect(
      (await handler(get(`/x/callback?state=${state}&error=access_denied`))).headers.get('location'),
    ).toBe(`${APP}/settings?x=failed`);
    // Orbit's limit is 0: even /2/users/me is not read, and the fresh token is revoked
    const off = api(fake, cfg({ orbitMonthlyUsd: 0 }));
    const back = await connect(fake, off, token);
    expect(back.headers.get('location')).toBe(`${APP}/settings?x=failed`);
    expect(fake.paths('/2/users/me')).toHaveLength(0);
    expect(fake.revoked).toHaveLength(1);
    expect((await loadXState(t.db, userId))!.status).not.toBe('active');
  });
});

describe('/x/status and /x/disconnect', () => {
  it('reports spending against both limits, then disconnects', async () => {
    const fake = world();
    const handler = api(fake, cfg({ studentMonthlyUsd: 12 }));
    const { userId, token } = await signedIn();
    const before = (await (await handler(get('/x/status', token))).json()) as Record<string, unknown>;
    expect(before).toEqual({
      status: 'not_connected',
      spentThisMonthUsd: 0,
      limitUsd: 12,
      orbitLimitReached: false,
    });
    await connect(fake, handler, token);
    const after = (await (await handler(get('/x/status', token))).json()) as Record<string, unknown>;
    expect(after).toEqual({
      status: 'active',
      username: 'maya_c',
      spentThisMonthUsd: 0.01,
      limitUsd: 12,
      orbitLimitReached: false,
    });
    expect(
      (
        (await (await api(fake, cfg({ orbitMonthlyUsd: 0 }))(get('/x/status', token))).json()) as {
          orbitLimitReached: boolean;
        }
      ).orbitLimitReached,
    ).toBe(true);

    const row = (await loadXState(t.db, userId))!;
    const vault = sqlVault(t.db);
    const refresh = (await vault.get(row.refreshSecretId!))!;
    const d = await handler(post('/x/disconnect', token));
    expect(await d.json()).toEqual({ ok: true, revokedAtX: true });
    expect(fake.revoked).toContain(refresh);
    expect(await vault.get(row.refreshSecretId!)).toBeNull();
    expect(await vault.get(row.state.accessSecretId!)).toBeNull();
    const gone = (await loadXState(t.db, userId))!;
    expect(gone.status).toBe('revoked');
    expect(gone.refreshSecretId).toBeNull();
    expect(((await (await handler(get('/x/status', token))).json()) as { status: string }).status).toBe(
      'not_connected',
    );
  });
});

describe('tokens', () => {
  async function linked(fake: FakeX) {
    const { userId } = await signedIn();
    const tok = fake.issue('100');
    const s = await storeXTokens(
      sqlVault(t.db),
      userId,
      { access_token: tok.access, refresh_token: tok.refresh, expires_in: 7200 },
      new Date(),
    );
    await t.db.sql`
      insert into orbit.integration_accounts (user_id, provider, status, social_account_id, token_secret_id, sync_state)
      values (${userId}::uuid, 'x', 'active', '100', ${s.refreshSecretId}::uuid,
              ${{ x: { accessSecretId: s.accessSecretId, accessExpiresAt: s.accessExpiresAt } }}::jsonb)`;
    return { userId, tok };
  }

  it('refreshes on a 401, keeps the rotated refresh token and retries', async () => {
    const fake = world();
    const { userId, tok } = await linked(fake);
    fake.expireAccess();
    const client = (await xAdapterFor(t.db, userId, { cfg: cfg(), fetch: fake.fetch }))!;
    const read = await client.adapter.profile('200');
    expect(read.account.username).toBe('priya');
    // one 401, one refresh, one retry
    expect(fake.paths('/2/users/200')).toHaveLength(2);
    expect(fake.paths('/2/oauth2/token')).toHaveLength(1);
    const row = (await loadXState(t.db, userId))!;
    const stored = await sqlVault(t.db).get(row.refreshSecretId!);
    expect(stored).not.toBe(tok.refresh);
    expect(fake.refresh.get(stored!)).toBe('100');
    expect(row.status).toBe('active');
  });

  it('marks the row needs_reauth and throws SocialSignInNeeded when the refresh is refused', async () => {
    const fake = world();
    const { userId } = await linked(fake);
    fake.expireAccess();
    fake.refuseRefresh = true;
    const client = (await xAdapterFor(t.db, userId, { cfg: cfg(), fetch: fake.fetch }))!;
    await expect(client.adapter.profile('200')).rejects.toBeInstanceOf(SocialSignInNeeded);
    expect((await loadXState(t.db, userId))!.status).toBe('needs_reauth');
    // a call refused that way is not charged
    const [n] = await t.db.sql<{ usd: string }>`
      select coalesce(sum(cost_usd), 0)::text as usd from orbit.usage_ledger where user_id = ${userId}::uuid`;
    expect(Number(n!.usd)).toBe(0);
    // and no adapter is offered until the student signs in again
    expect(await xAdapterFor(t.db, userId, { cfg: cfg(), fetch: fake.fetch })).toBeUndefined();
  });
});
