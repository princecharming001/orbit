import type { User } from '@orbit/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { createLocalUser } from '../engine/account';
import { MEET_ROW_LINE, ZOOM_ROW_LINE } from '../engine/callNotes';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import { ToastProvider } from '../ui';
import { MeetingLinkRow, MeetRow, ZoomRow } from './CallAppRows';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let unmount: (() => void) | undefined;
afterEach(async () => {
  unmount?.();
  unmount = undefined;
  setConnectorsMockForTests(undefined);
  await leaveFakeApi();
  document.body.innerHTML = '';
});

const settle = async () => {
  for (let i = 0; i < 20; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const click = async (el: HTMLElement | null) => {
  await act(async () => el!.click());
  await settle();
};

async function mount(user: User) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  unmount = () => act(() => root.unmount());
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ToastProvider>
          <ZoomRow user={user} />
          <MeetRow user={user} />
          <MeetingLinkRow user={user} />
        </ToastProvider>
      </MemoryRouter>,
    ),
  );
  await settle();
}

async function localUser() {
  await wipeDatabase();
  return createLocalUser({ fullName: 'Alex Rivera', email: 'alex@umich.edu', school: 'Michigan' });
}

/** Plain words: no em or en dashes, no exclamation marks. */
const plain = (text: string) => {
  expect(text).not.toMatch(/[–—!]/);
};

describe('Settings: Zoom and Google Meet rows', () => {
  it('the demo: each says when notes come in, and turns on at once', async () => {
    setConnectorsMockForTests(true);
    const user = await localUser();
    await mount(user);
    expect(q('[data-testid="settings-zoom-line"]')!.textContent).toBe(ZOOM_ROW_LINE);
    expect(q('[data-testid="settings-meet-line"]')!.textContent).toBe(MEET_ROW_LINE);
    expect(MEET_ROW_LINE).toBe('Notes come in when your Google account records a transcript.');
    await click(q('[data-testid="settings-zoom-connect"]'));
    expect(q('[data-testid="settings-zoom-status"]')!.textContent).toMatch(/Connected · 0 calls · checked/);
    expect(q('[data-testid="settings-zoom-disconnect"]')).toBeTruthy();
    expect(q('[data-testid="settings-zoom-sync"]')).toBeTruthy();
    await click(q('[data-testid="settings-meet-connect"]'));
    expect(q('[data-testid="settings-meet-status"]')!.textContent).toMatch(/Connected/);
    await click(q('[data-testid="settings-zoom-disconnect"]'));
    expect(q('[data-testid="settings-zoom-status"]')).toBeNull();
    expect(q('[data-testid="settings-zoom-connect"]')).toBeTruthy();
    plain(document.body.textContent ?? '');
  });

  it('Zoom before the owner stores its keys: "Not set up yet", no switch, nothing asked', async () => {
    await wipeDatabase();
    const { api, user } = await signInToFakeApi();
    api.state.callApps.zoom.configured = false;
    await mount(user);
    await settle();
    expect(q('[data-testid="settings-zoom-not-set-up"]')!.textContent).toBe('Not set up yet');
    expect(q('[data-testid="settings-zoom-connect"]')).toBeNull();
    expect(q('[data-testid="settings-zoom-error"]')).toBeNull();
    // Meet needs no new keys: its row is ready
    expect(q('[data-testid="settings-meet-connect"]')).toBeTruthy();
    expect(
      api.calls.map((c) => c.route).filter((r) => r.startsWith('/zoom/') && r !== '/zoom/status'),
    ).toEqual([]);
  });

  it('Meet before the owner turns transcripts on: "Not set up yet", no switch, nothing asked', async () => {
    await wipeDatabase();
    const { api, user } = await signInToFakeApi();
    api.state.callApps.meet.configured = false;
    await mount(user);
    await settle();
    expect(q('[data-testid="settings-meet-not-set-up"]')!.textContent).toBe('Not set up yet');
    expect(q('[data-testid="settings-meet-connect"]')).toBeNull();
    expect(q('[data-testid="settings-zoom-connect"]')).toBeTruthy();
    expect(
      api.calls.map((c) => c.route).filter((r) => r.startsWith('/meet/') && r !== '/meet/status'),
    ).toEqual([]);
  });

  it('without an Orbit account: both say they need one', async () => {
    setConnectorsMockForTests(false);
    const user = await localUser();
    await mount(user);
    expect(q('[data-testid="settings-zoom-unavailable"]')!.textContent).toBe('Needs an Orbit account');
    expect(q('[data-testid="settings-meet-unavailable"]')).toBeTruthy();
    expect(q('[data-testid="settings-zoom-connect"]')).toBeNull();
  });

  it('a Zoom sign-in Zoom refused: the row asks to sign in again', async () => {
    await wipeDatabase();
    const { api, user } = await signInToFakeApi();
    api.state.callApps.zoom.status = 'needs_reauth';
    await mount(user);
    await settle();
    expect(q('[data-testid="settings-zoom-status"]')!.textContent).toBe(
      'Zoom signed Orbit out. Sign in again.',
    );
    expect(q('[data-testid="settings-zoom-reconnect"]')!.textContent).toBe('Sign in again');
  });
});

describe('Settings: the call link on invites', () => {
  it('Google Meet by default; the choice is kept, with a word when Zoom is not connected', async () => {
    setConnectorsMockForTests(true);
    const user = await localUser();
    await mount(user);
    const meet = q('[data-testid="settings-meeting-link-meet"]')!;
    expect(meet.getAttribute('aria-checked')).toBe('true');
    await click(q('[data-testid="settings-meeting-link-zoom"]'));
    expect((await db.settings.get(user.id))?.meetingLink).toBe('zoom');
    expect(q('[data-testid="settings-meeting-link-zoom"]')!.getAttribute('aria-checked')).toBe('true');
    expect(q('[data-testid="settings-meeting-link-hint"]')!.textContent).toBe(
      'Zoom is not connected, so invites get a Google Meet link until it is.',
    );
    await click(q('[data-testid="settings-zoom-connect"]'));
    expect(q('[data-testid="settings-meeting-link-hint"]')).toBeNull();
    await click(q('[data-testid="settings-meeting-link-none"]'));
    expect((await db.settings.get(user.id))?.meetingLink).toBe('none');
    plain(q('[data-testid="settings-meeting-link"]')!.textContent ?? '');
  });
});
