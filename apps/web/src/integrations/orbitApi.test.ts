import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeOrbitApi, FAKE_API_BASE, type FakeOrbitApi } from '../test/fakeOrbitApi';
import {
  accountUser,
  callApi,
  clearSession,
  completeSignIn,
  googleSignInUrl,
  isAccountMode,
  isSignedIn,
  loadSession,
  parseAuthFragment,
  REFRESH_BEFORE_MS,
  resetSessionForTests,
  sessionTokensForTests,
  setOrbitApiBaseForTests,
  setOrbitApiFetchForTests,
  signInErrorText,
  signOutAccount,
} from './orbitApi';

let api: FakeOrbitApi;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T14:00:00Z'));
  api = createFakeOrbitApi();
  setOrbitApiBaseForTests(api.base);
  setOrbitApiFetchForTests(api.fetch);
  resetSessionForTests();
  await clearSession();
});

afterEach(async () => {
  await clearSession();
  resetSessionForTests();
  setOrbitApiFetchForTests(undefined);
  setOrbitApiBaseForTests(undefined);
  vi.useRealTimers();
});

/** Move the browser's clock and the server's together. */
function tick(ms: number) {
  vi.setSystemTime(new Date(Date.now() + ms));
  api.advance(ms);
}

describe('account mode switch', () => {
  it('is off without VITE_ORBIT_API, and every call says so without a request', async () => {
    setOrbitApiBaseForTests(null);
    expect(isAccountMode()).toBe(false);
    const r = await callApi('/goals/list', {});
    expect(r).toMatchObject({ ok: false, reason: 'off' });
    expect(api.calls).toHaveLength(0);
    expect(googleSignInUrl()).toBeUndefined();
  });

  it('builds the sign-in address with the app as the place to come back to', () => {
    expect(googleSignInUrl('https://app.test/orbit')).toBe(
      `${FAKE_API_BASE}/auth/google/start?redirect=${encodeURIComponent('https://app.test/orbit')}`,
    );
  });

  it('a signed-out call never reaches the server and says to sign in', async () => {
    const r = await callApi('/goals/list', {});
    expect(r).toMatchObject({ ok: false, reason: 'signed_out' });
    expect(r.ok ? '' : r.message).toMatch(/Sign in with Google/);
    expect(api.calls).toHaveLength(0);
  });
});

describe('sign-in', () => {
  it('reads #code and #error from /auth/done', () => {
    expect(parseAuthFragment('#code=abc')).toEqual({ code: 'abc' });
    expect(parseAuthFragment('#error=access_denied')).toEqual({ error: 'access_denied' });
    expect(parseAuthFragment('')).toEqual({ error: 'no_code' });
  });

  it('trades the code for a session, keeps the refresh token and the user', async () => {
    const r = await completeSignIn(`#code=${api.code}`);
    expect(r.ok).toBe(true);
    expect(isSignedIn()).toBe(true);
    expect(accountUser()?.email).toBe('maya@cornell.edu');
    expect(api.calls[0]).toMatchObject({ route: '/auth/session', body: { code: api.code } });
    // a fresh tab (memory gone) finds the stored refresh token and the user
    resetSessionForTests();
    expect(isSignedIn()).toBe(false);
    await loadSession();
    expect(isSignedIn()).toBe(true);
    expect(sessionTokensForTests().accessToken).toBeUndefined();
    expect(accountUser()?.id).toBe(api.state.user.id);
  });

  it('explains errors in plain words: access_denied says invite-only, an expired code says sign in again', async () => {
    const denied = await completeSignIn('#error=access_denied');
    expect(denied).toMatchObject({ ok: false, error: 'access_denied' });
    expect(denied.ok ? '' : denied.message).toMatch(/invite-only during the pilot/);
    expect(denied.ok ? '' : denied.message).toMatch(/without Google/);
    const expired = await completeSignIn('#code=stale');
    expect(expired).toMatchObject({ ok: false, error: 'expired' });
    expect(isSignedIn()).toBe(false);
    for (const code of ['invalid_state', 'email_unverified', 'sign_in_failed', 'unconfigured', 'whatever'])
      expect(signInErrorText(code)).not.toMatch(/_/);
  });

  it('sign-out revokes the session on the server and forgets it here', async () => {
    await completeSignIn(`#code=${api.code}`);
    await signOutAccount();
    expect(api.routes()).toContain('/auth/logout');
    expect(isSignedIn()).toBe(false);
    resetSessionForTests();
    await loadSession();
    expect(isSignedIn()).toBe(false);
  });
});

describe('calls with the session', () => {
  beforeEach(async () => {
    await completeSignIn(`#code=${api.code}`);
    api.calls.length = 0;
  });

  it('sends the access token as a Bearer and returns the typed body', async () => {
    const r = await callApi('/goals/list', {});
    expect(r).toEqual({ ok: true, value: { goals: [] } });
    expect(api.calls[0]?.auth).toMatch(/^Bearer at_/);
  });

  it('refreshes five minutes before the token expires, and the refresh token rotates', async () => {
    const before = sessionTokensForTests();
    tick(60 * 60_000 - REFRESH_BEFORE_MS + 1000);
    const r = await callApi('/goals/list', {});
    expect(r.ok).toBe(true);
    expect(api.routes()).toEqual(['/auth/refresh', '/goals/list']);
    const after = sessionTokensForTests();
    expect(after.accessToken).not.toBe(before.accessToken);
    expect(after.refreshToken).not.toBe(before.refreshToken);
  });

  it('does not refresh while the token is fresh', async () => {
    tick(30 * 60_000);
    await callApi('/goals/list', {});
    expect(api.routes()).toEqual(['/goals/list']);
  });

  it('retries once after a 401, with a refreshed token', async () => {
    // the server forgets the access token (a restart, a rotated secret): 401, refresh, retry
    api.state.access.clear();
    const r = await callApi('/memory/list', {});
    expect(r).toEqual({ ok: true, value: { memories: [] } });
    expect(api.routes()).toEqual(['/memory/list', '/auth/refresh', '/memory/list']);
  });

  it('a refresh that is refused ends the session in plain words', async () => {
    api.state.access.clear();
    api.state.refresh = undefined;
    const r = await callApi('/memory/list', {});
    expect(r).toMatchObject({ ok: false, reason: 'signed_out' });
    expect(r.ok ? '' : r.message).toMatch(/Sign in with Google again/);
    expect(isSignedIn()).toBe(false);
  });

  it('maps a 503 unconfigured answer to a typed result, with what is missing', async () => {
    api.state.unconfigured.add('/research/person');
    const r = await callApi('/research/person', { personId: 'p1' });
    expect(r).toMatchObject({ ok: false, reason: 'unconfigured', missing: ['EXA_API_KEY'] });
    expect(r.ok ? '' : r.message).not.toMatch(/_|unconfigured/);
  });

  it('turns other refusals into plain words, never codes', async () => {
    const r = await callApi('/goals/archive', { id: 'nope' });
    expect(r).toMatchObject({ ok: false, reason: 'error', status: 404, code: 'not_found' });
    expect(r.ok ? '' : r.message).toBe('No such goal.');
    const fail = await callApi('/account/delete', { confirm: 'nope' as 'DELETE' });
    expect(fail.ok ? '' : fail.message).not.toMatch(/[{}_]/);
  });

  it('says the server cannot be reached when the network fails', async () => {
    setOrbitApiFetchForTests(async () => {
      throw new TypeError('Failed to fetch');
    });
    const r = await callApi('/goals/list', {});
    expect(r).toMatchObject({ ok: false, reason: 'network' });
  });
});
