import type { User } from '@orbit/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wipeDatabase } from '../db/schema';
import { LINKEDIN_PARKED, linkedInLiveStatus, refreshLinkedInFromServer } from '../engine/linkedinLive';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import type { FakeOrbitApi } from '../test/fakeOrbitApi';
import { LinkedInLiveCard } from './ConnectorCards';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Plan 35 E5: a LinkedIn link Orbit's server parked while the student was away shows as paused, with Reconnect
 * LinkedIn in place of the switch, and turns back to connected once the server says the account is active again.
 */
describe('a parked LinkedIn link in Settings', () => {
  let api: FakeOrbitApi;
  let user: User;
  beforeEach(async () => {
    await wipeDatabase();
    ({ api, user } = await signInToFakeApi());
  });
  afterEach(async () => {
    await leaveFakeApi();
  });

  it('mirrors parked from the server, then active again after the reconnect', async () => {
    api.state.linkedin = { status: 'parked', relations: 120 };
    expect(await refreshLinkedInFromServer(user)).toBe(true);
    const parked = await linkedInLiveStatus(user);
    expect(parked).toMatchObject({ connected: false, parked: true });
    expect(LINKEDIN_PARKED).not.toMatch(/[—–!]/);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<LinkedInLiveCard user={user} />));
    for (let i = 0; i < 15; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
    expect(host.querySelector('[data-testid="settings-linkedin-live-status"]')?.textContent).toBe(
      LINKEDIN_PARKED,
    );
    expect(host.querySelector('[data-testid="settings-linkedin-live-reconnect"]')?.textContent).toBe(
      'Reconnect LinkedIn',
    );
    expect(host.querySelector('[data-testid="settings-linkedin-live-connect"]')).toBeNull();
    act(() => root.unmount());
    host.remove();

    api.state.linkedin = { status: 'active', relations: 120 };
    await refreshLinkedInFromServer(user);
    expect(await linkedInLiveStatus(user)).toMatchObject({ connected: true, parked: false, rows: 120 });
  });
});
