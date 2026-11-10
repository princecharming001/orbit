/**
 * Account tokens after 2026-11-05: orbit-api hands a signed-in student a second-version token for their own account;
 * a first-version token (what /connect/status hands a browser) opens only an account one of Orbit's own browser
 * sign-ins made (public.orbit_unipile_links), so one handed out by user id for an account linked through orbit-api
 * opens nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  accountToken,
  accountTokenOk,
  accountTokenV2,
  linkedBrowserKept,
  postgrestLinkCreated,
} from '../../functions/_shared/accountToken.ts';

const KEY = 'signing-placeholder';
const URL_ = 'https://x.supabase.co';

/** PostgREST over the links table: `rows` maps an account to the statuses its sign-ins were reported with. */
function linksTable(rows: Record<string, string[] | number>) {
  const calls: string[] = [];
  const doFetch = (async (url: string, init: RequestInit = {}) => {
    calls.push(url);
    const h = init.headers as Record<string, string>;
    expect(h.apikey).toBe('service-placeholder');
    expect(h.Authorization).toBe('Bearer service-placeholder');
    const q = new URL(url).searchParams;
    const id = (q.get('account_id') ?? '').replace(/^eq\./, '');
    const status = (q.get('status') ?? '').replace(/^eq\./, '');
    const found = rows[id];
    if (typeof found === 'number') return new Response('{}', { status: found });
    return new Response(JSON.stringify((found ?? []).filter((s) => s === status).map(() => ({ ref: 'r' }))), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  return { calls, created: postgrestLinkCreated(URL_, 'service-placeholder', doFetch) };
}

describe('account tokens', () => {
  it('a second-version token opens its account without asking anything; another account or key does not', async () => {
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
    // Orbit's record: acc-browser was made new by one of its browser sign-ins; acc-server (linked through orbit-api)
    // was not; acc-again was only ever signed in again
    const t = linksTable({ 'acc-browser': ['CREATION_SUCCESS'], 'acc-again': ['RECONNECTED'] });
    const kept = linkedBrowserKept(t.created);
    expect(await accountTokenOk('acc-browser', await accountToken('acc-browser', KEY), KEY, kept)).toBe(true);
    // the token /connect/status once handed out by user id for an account orbit-api linked
    expect(await accountTokenOk('acc-server', await accountToken('acc-server', KEY), KEY, kept)).toBe(false);
    expect(await accountTokenOk('acc-server', await accountTokenV2('acc-server', KEY), KEY, kept)).toBe(true);
    expect(await accountTokenOk('acc-again', await accountToken('acc-again', KEY), KEY, kept)).toBe(false);
    expect(await accountTokenOk('acc-browser', 'forged', KEY, kept)).toBe(false);
    // a forged token never reaches the record
    expect(t.calls.filter((u) => u.includes('acc-browser'))).toHaveLength(1);
  });

  it('asks for exactly the new-account row of that account', async () => {
    const t = linksTable({ 'acc/1 x': ['CREATION_SUCCESS'] });
    expect(await t.created('acc/1 x')).toBe(true);
    expect(t.calls[0]).toBe(
      `${URL_}/rest/v1/orbit_unipile_links?account_id=eq.acc%2F1%20x&status=eq.CREATION_SUCCESS&select=ref&limit=1`,
    );
  });

  it('a yes is kept for an hour; a no, or a record that cannot be read, is asked again and never passes', async () => {
    let at = 0;
    const rows: Record<string, string[] | number> = { a: ['CREATION_SUCCESS'], b: 500 };
    const t = linksTable(rows);
    const kept = linkedBrowserKept(t.created, () => at);
    expect(await kept('a')).toBe(true);
    expect(await kept('a')).toBe(true);
    expect(t.calls).toHaveLength(1);
    at = 3_600_001;
    expect(await kept('a')).toBe(true);
    expect(t.calls).toHaveLength(2);
    expect(await kept('b')).toBe(false);
    expect(await kept('b')).toBe(false);
    expect(t.calls).toHaveLength(4);
    // a sign-in that finishes a moment later passes at once: the no was not remembered
    expect(await kept('late')).toBe(false);
    rows.late = ['CREATION_SUCCESS'];
    expect(await kept('late')).toBe(true);
    expect(await kept('')).toBe(false);
    expect(await postgrestLinkCreated(undefined, 'k')('a')).toBe(false);
    // a lookup that throws is a no, never a pass
    const broken = linkedBrowserKept(async () => {
      throw new Error('down');
    });
    expect(await accountTokenOk('a', await accountToken('a', KEY), KEY, broken)).toBe(false);
  });
});
