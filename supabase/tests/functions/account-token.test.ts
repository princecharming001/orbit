/**
 * Account tokens after 2026-11-05: orbit-api hands a signed-in student a second-version token for their own account;
 * a first-version token (what /connect/status hands a browser) opens only an account Unipile names orbit_<random>,
 * so one handed out by user id for an account linked through orbit-api opens nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  accountToken,
  accountTokenOk,
  accountTokenV2,
  unipileBrowserKept,
} from '../../functions/_shared/accountToken.ts';

const KEY = 'signing-placeholder';
const BASE = 'https://api1.unipile.com:443';

function unipile(names: Record<string, string | number>) {
  const calls: string[] = [];
  const doFetch = (async (url: string, init: RequestInit = {}) => {
    calls.push(url);
    expect((init.headers as Record<string, string>)['X-API-KEY']).toBe('u-key');
    const id = decodeURIComponent(url.slice(`${BASE}/api/v1/accounts/`.length));
    const name = names[id];
    if (typeof name === 'number') return new Response('{}', { status: name });
    if (name === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ id, name }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, doFetch };
}

describe('account tokens', () => {
  it('a second-version token opens its account without asking Unipile; another account or key does not', async () => {
    const ask = async () => {
      throw new Error('asked');
    };
    const v2 = await accountTokenV2('acc-1', KEY);
    expect(await accountTokenOk('acc-1', v2, KEY, ask)).toBe(true);
    expect(await accountTokenOk('acc-2', v2, KEY, async () => true)).toBe(false);
    expect(await accountTokenOk('acc-1', v2, 'other-key', async () => true)).toBe(false);
    expect(await accountTokenOk('acc-1', v2, undefined, async () => true)).toBe(false);
    expect(await accountTokenOk('acc-1', undefined, KEY, async () => true)).toBe(false);
  });

  it('a first-version token opens only an account a browser linked through /connect/start', async () => {
    const u = unipile({
      'acc-browser': 'orbit_3f2a9c1e-77aa-4b1c-9d0e-1234567890ab',
      'acc-server': '390cf6d9-fd4b-47ce-942d-7689cda5d312',
    });
    const kept = unipileBrowserKept(BASE, 'u-key', u.doFetch);
    expect(await accountTokenOk('acc-browser', await accountToken('acc-browser', KEY), KEY, kept)).toBe(true);
    // the account orbit-api linked is named after its owner's user id: the token /connect/status once handed out for it
    expect(await accountTokenOk('acc-server', await accountToken('acc-server', KEY), KEY, kept)).toBe(false);
    expect(await accountTokenOk('acc-server', await accountTokenV2('acc-server', KEY), KEY, kept)).toBe(true);
    expect(await accountTokenOk('acc-browser', 'forged', KEY, kept)).toBe(false);
  });

  it('Unipile answers are kept for an hour; a failed answer counts as no and is asked again', async () => {
    let at = 0;
    const u = unipile({ a: 'orbit_abcd1234', b: 500 });
    const kept = unipileBrowserKept(BASE, 'u-key', u.doFetch, () => at);
    expect(await kept('a')).toBe(true);
    expect(await kept('a')).toBe(true);
    expect(u.calls).toHaveLength(1);
    at = 3_600_001;
    expect(await kept('a')).toBe(true);
    expect(u.calls).toHaveLength(2);
    expect(await kept('b')).toBe(false);
    expect(await kept('b')).toBe(false);
    expect(u.calls).toHaveLength(4);
    expect(await kept('missing')).toBe(false);
    expect(await unipileBrowserKept(undefined, 'u-key', u.doFetch)('a')).toBe(false);
    // a lookup that throws is a no, never a pass
    const broken = unipileBrowserKept(BASE, 'u-key', (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch);
    expect(await accountTokenOk('a', await accountToken('a', KEY), KEY, broken)).toBe(false);
  });
});
