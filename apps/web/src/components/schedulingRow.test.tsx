import type { User } from '@orbit/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../db/schema';
import { resetSignInClients } from '../engine/appSignIn';
import { disconnectScheduling } from '../engine/calcom';
import { loadDemo } from '../engine/demo';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import { setNotesProxyUrlForTests } from '../integrations/notesApps';
import { ToastProvider } from '../ui';
import { BookingLinkRow, SchedulingRow } from './NotesAppRows';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let user: User;
beforeAll(async () => {
  user = await loadDemo({ reset: true });
}, 90_000);

let unmount: (() => void) | undefined;

afterEach(async () => {
  unmount?.();
  unmount = undefined;
  vi.restoreAllMocks();
  setConnectorsMockForTests(undefined);
  setNotesProxyUrlForTests(undefined);
  resetSignInClients();
  await disconnectScheduling(user, 'calcom');
  await disconnectScheduling(user, 'calendly');
  document.body.innerHTML = '';
});

const settle = async () => {
  for (let i = 0; i < 20; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  unmount = () => act(() => root.unmount());
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ToastProvider>
          <SchedulingRow user={user} app="calcom" />
          <SchedulingRow user={user} app="calendly" />
          <BookingLinkRow user={user} />
        </ToastProvider>
      </MemoryRouter>,
    ),
  );
  await settle();
}

const type = async (el: HTMLInputElement, v: string) => {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

function live(answer: (body: Record<string, unknown>, path: string) => unknown) {
  setConnectorsMockForTests(false);
  setNotesProxyUrlForTests('https://proxy.test/orbit-notes');
  resetSignInClients();
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url).replace('https://proxy.test/orbit-notes', '');
    return json(answer(JSON.parse(String(init?.body ?? '{}')), path));
  });
}

describe('Settings, Scheduling: Cal.com and Calendly rows', () => {
  it('with no sign-in set up, Connect opens the booking link field, and the link alone connects', async () => {
    await db.settings.update(user.id, { schedulingLink: undefined });
    const f = live((body, path) =>
      path === '/oauth/config'
        ? { ok: true, calcom: null, fathom: null, calendly: null }
        : {
            ok: true,
            username: body.username,
            eventTypes: [
              {
                id: 'A',
                title: 'Intro',
                slug: 'intro',
                hidden: false,
                url: `https://calendly.com/${body.username}/intro`,
              },
            ],
          },
    );
    await mount();
    expect(q('[data-testid="settings-calendly-page"]')).toBeNull();
    await act(async () => q('[data-testid="settings-calendly-connect"]')!.click());
    await settle();
    const field = q('[data-testid="settings-calendly-page"]') as HTMLInputElement;
    expect(field).not.toBeNull();
    // the hint says no key is needed; Calendly offers no API key path
    expect(q('[data-testid="settings-calendly"]')!.textContent).toMatch(/no key\s+needed/);
    expect(q('[data-testid="settings-calcom-use-key"]')).toBeNull();
    await type(field, 'https://calendly.com/sam-o');
    await act(async () => q('[data-testid="settings-calendly-page-save"]')!.click());
    await settle();
    expect(q('[data-testid="settings-calendly-status"]')!.textContent).toContain(
      'Connected · calendly.com/sam-o · 1 event type',
    );
    expect(f.mock.calls.some(([u]) => String(u).endsWith('/scheduling/public'))).toBe(true);
    // the event type fills the picker under both rows, and became the link drafts offer
    const select = q('[data-testid="scheduling-link-select"]') as HTMLSelectElement;
    expect(select.value).toBe('https://calendly.com/sam-o/intro');
  });

  it('a wrong link is named back in the row and nothing is sent', async () => {
    const f = live(() => ({ ok: true, calcom: null, fathom: null, calendly: null }));
    await mount();
    await act(async () => q('[data-testid="settings-calcom-connect"]')!.click());
    await settle();
    await type(q('[data-testid="settings-calcom-page"]') as HTMLInputElement, 'calendly.com/sam');
    await act(async () => q('[data-testid="settings-calcom-page-save"]')!.click());
    await settle();
    expect(q('[data-testid="settings-calcom-error"]')!.textContent).toBe(
      'That is a Calendly link. Add it in the Calendly row.',
    );
    expect(f.mock.calls.filter(([u]) => String(u).endsWith('/scheduling/public'))).toHaveLength(0);
    // the API key stays one click away for hidden event types
    await act(async () => q('[data-testid="settings-calcom-use-key"]')!.click());
    await settle();
    expect(q('[data-testid="settings-calcom-key"]')).not.toBeNull();
  });

  it('with sign-in set up, the row offers the booking link as the quieter way in', async () => {
    live(() => ({ ok: true, calcom: 'cal_client', fathom: null, calendly: 'cly_client' }));
    await mount();
    expect(q('[data-testid="settings-calcom-use-link"]')).not.toBeNull();
    expect(q('[data-testid="settings-calendly-use-link"]')).not.toBeNull();
    await act(async () => q('[data-testid="settings-calendly-use-link"]')!.click());
    await settle();
    expect(q('[data-testid="settings-calendly-page"]')).not.toBeNull();
  });
});
