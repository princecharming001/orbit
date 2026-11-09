/**
 * Settings, LinkedIn row (plan 35 B3): an account's LinkedIn is read from the server once when the card opens and
 * again only when the sync status's LinkedIn mark moves. The card has no /linkedin/status timer of its own.
 */
import type { User } from '@orbit/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentUserId } from '../db/repo';
import { wipeDatabase } from '../db/schema';
import { refreshSyncStatus } from '../engine/serverSync';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import type { FakeOrbitApi } from '../test/fakeOrbitApi';
import { ToastProvider } from '../ui';
import { LinkedInLiveCard } from './ConnectorCards';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};

let api: FakeOrbitApi;
let user: User;
let host: HTMLDivElement;
let unmount: () => void;

beforeEach(async () => {
  await wipeDatabase();
  ({ api, user } = await signInToFakeApi());
  api.state.linkedin = { status: 'active', relations: 120 };
  await setCurrentUserId(user.id);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});
afterEach(async () => {
  unmount?.();
  vi.useRealTimers();
  await leaveFakeApi();
});

const statusCalls = () => api.calls.filter((c) => c.route === '/linkedin/status').length;

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ToastProvider>
          <LinkedInLiveCard user={user} />
        </ToastProvider>
      </MemoryRouter>,
    ),
  );
  unmount = () => {
    act(() => root.unmount());
    host.remove();
  };
}

describe('LinkedInLiveCard', () => {
  it('reads /linkedin/status when it opens and when the LinkedIn mark moves, never on a timer', async () => {
    await mount();
    await settle();
    expect(statusCalls()).toBe(1);
    // ten minutes open: no timer reads it again
    act(() => vi.advanceTimersByTime(10 * 60_000));
    await settle();
    expect(statusCalls()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    // the first status with marks says nothing new for the card
    api.state.status.marks = { changed: 'c1', linkedin: 'l1', autopilot: 'a1' };
    await act(async () => void (await refreshSyncStatus()));
    await settle();
    expect(statusCalls()).toBe(1);
    // another mark moving leaves it alone; the LinkedIn mark moving reads it once
    api.state.status.marks = { changed: 'c2', linkedin: 'l1', autopilot: 'a2' };
    await act(async () => void (await refreshSyncStatus()));
    await settle();
    expect(statusCalls()).toBe(1);
    api.state.status.marks = { changed: 'c2', linkedin: 'l2', autopilot: 'a2' };
    await act(async () => void (await refreshSyncStatus()));
    await settle();
    expect(statusCalls()).toBe(2);
  });
});
