import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, type IntegrationAccount } from '../db/schema';
import { setNotesProxyUrlForTests } from '../integrations/notesApps';
import { appAuth, finishAppSignIn } from './appSignIn';

const row = (patch: Partial<IntegrationAccount>): IntegrationAccount => ({
  id: 'int_cal',
  userId: 'u1',
  provider: 'calcom',
  status: 'active',
  scopes: [],
  syncState: {},
  connectedAt: new Date().toISOString(),
  ...patch,
});

describe('a connected app, by key or by signing in', () => {
  beforeEach(async () => {
    setNotesProxyUrlForTests('https://x.supabase.co/functions/v1/orbit-notes');
    await db.integrations.clear();
  });
  afterEach(() => {
    setNotesProxyUrlForTests(undefined);
    vi.unstubAllGlobals();
  });

  it('a pasted key is used as it is', async () => {
    expect(await appAuth('calcom', row({ accessToken: 'cal_live_key_123' }))).toBe('cal_live_key_123');
  });

  it('a fresh sign-in token is used; one about to run out is renewed once and the new one kept', async () => {
    const fresh = row({
      accessToken: 'acc_fresh_1234567',
      oauth: { refreshToken: 'ref_1', expiresAt: new Date(Date.now() + 20 * 60_000).toISOString() },
    });
    expect(await appAuth('calcom', fresh)).toEqual({ accessToken: 'acc_fresh_1234567' });

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            accessToken: 'acc_new_123456789',
            refreshToken: 'ref_2',
            expiresIn: 1800,
          }),
          {
            status: 200,
          },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const stale = row({
      accessToken: 'acc_old_123456789',
      oauth: { refreshToken: 'ref_1', expiresAt: new Date(Date.now() + 10_000).toISOString() },
    });
    await db.integrations.put(stale);
    expect(await appAuth('calcom', stale)).toEqual({ accessToken: 'acc_new_123456789' });
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(sent).toMatchObject({ provider: 'calcom', grant: 'refresh', refreshToken: 'ref_1' });
    const saved = (await db.integrations.get('int_cal'))!;
    expect(saved.accessToken).toBe('acc_new_123456789');
    expect(saved.oauth?.refreshToken).toBe('ref_2');
  });

  it('a renewal the app refuses asks the student to connect again', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, reason: 'bad_key', message: 'connect again' }), {
            status: 200,
          }),
      ),
    );
    const stale = row({
      accessToken: 'acc_old_123456789',
      oauth: { refreshToken: 'ref_1', expiresAt: new Date(0).toISOString() },
    });
    await db.integrations.put(stale);
    expect(await appAuth('calcom', stale)).toBeUndefined();
    expect((await db.integrations.get('int_cal'))!.status).toBe('needs_reauth');
  });

  it('the return page only answers a sign-in Orbit started', () => {
    expect(finishAppSignIn('?code=abc&state=calcom.0123456789abcdef0123456789abcdef')).toBe(true);
    expect(finishAppSignIn('?code=abc&state=somebody-else')).toBe(false);
  });
});
