/**
 * An Orbit account reads LinkedIn through the same proxy as a browser account, with the account and token its server
 * hands over (POST /linkedin/reader): the About tab's work history, company logos, photos and "people who know them"
 * all use it. Without it the browser's own row (which carries no token in account mode) was refused with a 403.
 */
import type { Person } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../../db/schema';
import { setUnipileUrlForTests } from '../../integrations/unipile';
import { leaveFakeApi, signInToFakeApi } from '../../test/account';
import { mutualsFor } from '../linkedinLive';
import { forgetAccountLinkedInReader, liveAccountFor, READER_NOT_CONNECTED_TTL_MS } from './sources';

const PROXY = 'https://proxy.test';

beforeEach(async () => {
  await wipeDatabase();
  forgetAccountLinkedInReader();
  setUnipileUrlForTests(PROXY);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  setUnipileUrlForTests(undefined);
  forgetAccountLinkedInReader();
  await leaveFakeApi();
  await wipeDatabase();
});

describe("an Orbit account's LinkedIn reader", () => {
  it('has none until LinkedIn is connected, then the account and token from its server', async () => {
    const { api, user } = await signInToFakeApi();
    expect(await liveAccountFor(user)).toBeUndefined();
    api.state.linkedin.status = 'active';
    forgetAccountLinkedInReader();
    expect(await liveAccountFor(user)).toEqual({ accountId: 'acc_1', token: 'tok_acc_1' });
  });

  it('keeps "not connected" for a minute only: LinkedIn linked again is read on the next look', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { api, user } = await signInToFakeApi();
      expect(await liveAccountFor(user)).toBeUndefined();
      // linked on the server a moment later (the sign-in window, or another tab): nothing here was told
      api.state.linkedin.status = 'active';
      expect(await liveAccountFor(user)).toBeUndefined();
      vi.setSystemTime(Date.now() + READER_NOT_CONNECTED_TTL_MS + 1);
      expect(await liveAccountFor(user)).toEqual({ accountId: 'acc_1', token: 'tok_acc_1' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('says "not connected" for mutuals while LinkedIn is not linked', async () => {
    const { user } = await signInToFakeApi();
    const target = { id: 'p1', userId: user.id, firstName: 'Jay', linkedinMemberId: 'm_target' } as Person;
    expect(await mutualsFor(user, target)).toMatchObject({ ok: false, reason: 'not_connected' });
  });

  it('asks LinkedIn for mutuals with that token, never with the token-less row kept in the browser', async () => {
    const { api, user } = await signInToFakeApi();
    api.state.linkedin.status = 'active';
    // the row account mode keeps here for LinkedIn: no token
    await db.integrations.put({
      id: 'int_li',
      userId: user.id,
      provider: 'linkedin_live',
      status: 'active',
      externalAccountId: 'acc_1',
    } as never);
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (String(url).startsWith(PROXY)) {
        sent.push(JSON.parse(String(init.body ?? '{}')));
        return new Response(
          JSON.stringify({ verified: true, mutuals: [{ name: 'Sana Ahmed', member_id: 'm_sana' }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      return new Response('{}', { status: 404 });
    });
    const target = {
      id: 'p1',
      userId: user.id,
      firstName: 'Prahalad',
      linkedinMemberId: 'm_target',
    } as Person;
    const r = await mutualsFor(user, target);
    expect(r).toMatchObject({ ok: true, source: 'linkedin' });
    expect(sent[0]).toMatchObject({ accountId: 'acc_1', token: 'tok_acc_1' });
  });
});
