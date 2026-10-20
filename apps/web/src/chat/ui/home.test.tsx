import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentUserId } from '../../db/repo';
import { db } from '../../db/schema';
import { createLocalUser } from '../../engine/account';
import { clearPrefs, writePrefs } from '../../integrations/prefs';
import { SessionProvider } from '../../state/session';
import { ToastProvider } from '../../ui';
import { chipRows, homeChips, starterChips } from '../agent/chips';
import { ChatEngineProvider } from '../engineContext';
import { createFakeChatEngine, type FakeChatEngine } from '../testing/fakeEngine';
import { fixturePerson } from '../testing/fixtures';
import { ChatHome } from './ChatHome';
import { homeStatusLine, readHomeStatus, resetHomeStatusCache } from './homeStatus';
import { resetThread, threadActions } from './threadStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
let engine: FakeChatEngine;
let userId: string;

async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
}

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <SessionProvider>
          <ChatEngineProvider engine={engine}>
            <ToastProvider>
              <ChatHome />
            </ToastProvider>
          </ChatEngineProvider>
        </SessionProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

const $ = (sel: string) => host.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];
const chipIds = () => $$('[data-testid^="chip-"]').map((el) => el.dataset.testid);

async function addCards(count: number) {
  for (let i = 0; i < count; i++)
    await db.suggestions.add({
      id: `s_${i}`,
      userId,
      kind: 'thank_you',
      personId: `p${i}`,
      priorityScore: 100 - i,
      reasonText: 'Met two days ago',
      signals: {},
      payload: {},
      status: 'pending',
      dedupeKey: `k${i}`,
      carriedOver: 0,
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      createdAt: new Date().toISOString(),
    } as never);
}

/** LinkedIn (the export) and Gmail both in, so the home has nothing to ask for. */
async function connectBoth() {
  await db.integrations.bulkPut([
    {
      id: 'li',
      userId,
      provider: 'linkedin_csv',
      status: 'active',
      scopes: [],
      syncState: {},
      connectedAt: '',
    },
    { id: 'g', userId, provider: 'google', status: 'active', scopes: [], syncState: {}, connectedAt: '' },
  ]);
}

describe('the home: gentle for an empty account, the full set once there are people', () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
    resetThread();
    resetHomeStatusCache();
    const u = await createLocalUser({
      fullName: 'Alex Rivera',
      firstName: 'Alex',
      onboardingCompletedAt: new Date().toISOString(),
    });
    userId = u.id;
    await setCurrentUserId(u.id);
    engine = createFakeChatEngine({ delay: 0 });
  });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = undefined;
    resetThread();
  });

  it('shows three starter chips and a setup line when nobody is in the account', async () => {
    await mount();
    expect($('[data-testid="greeting"]')?.textContent).toBe('Hey Alex, what’s on your mind today?');
    expect(chipIds()).toEqual(['chip-linkedin', 'chip-add-person', 'chip-what-can-you-do']);
    expect($$('[data-testid^="chip-"]').map((el) => el.textContent)).toEqual([
      'Bring in my LinkedIn',
      'Add someone I met',
      'What can you do?',
    ]);
    expect($('[data-testid="home-status"]')?.textContent).toBe(
      "Let's get you set up. It takes about two minutes.",
    );
    // one row
    expect($('[data-testid="chips"]')?.children).toHaveLength(1);
  });

  it('the LinkedIn chip opens the file picker; the message chips just say it', async () => {
    await mount();
    const input = $('[data-testid="linkedin-chip-file"]') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    await act(async () => $('[data-testid="chip-linkedin"]')!.click());
    expect(click).toHaveBeenCalledTimes(1);
    await act(async () => $('[data-testid="chip-what-can-you-do"]')!.click());
    await settle();
    expect($('[data-testid="turn-user"]')?.textContent).toBe('What can you do?');
    expect(engine.calls.some((c) => c.method === 'send' && c.args.includes('What can you do?'))).toBe(true);
  });

  it('shows one row of four everyday chips once there are people, with no status when nothing waits', async () => {
    await db.people.bulkPut([0, 1].map((i) => fixturePerson(i, { userId })));
    await connectBoth();
    await mount();
    expect(chipIds()).toEqual(['chip-who-today', 'chip-thank-you', 'chip-route', 'chip-pipeline']);
    expect($('[data-testid="home-status"]')).toBeNull();
    expect($('[data-testid="chips"]')?.children).toHaveLength(1);
  });

  it('says how many people are waiting when there is something real to say', async () => {
    await db.people.bulkPut([0, 1, 2].map((i) => fixturePerson(i, { userId })));
    await addCards(3);
    await mount();
    expect($('[data-testid="home-status"]')?.textContent).toBe(
      'Three people are waiting on a message from you.',
    );
  });

  it('switches from the starter chips to the full set after a turn ends', async () => {
    await mount();
    expect(chipIds()).toHaveLength(3);
    // the student's first people arrive (an import, a person added by hand)
    await db.people.bulkPut([0, 1].map((i) => fixturePerson(i, { userId })));
    await act(() => threadActions(engine).send('hello'));
    await settle();
    expect($('[data-testid="chat-thread"]')).not.toBeNull();
    await act(() => threadActions(engine).newChat());
    await settle();
    expect(chipIds()).toHaveLength(4);
  });
});

describe('the home: connect your apps', () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
    resetThread();
    resetHomeStatusCache();
    try {
      localStorage.clear();
    } catch {
      // no storage in this environment
    }
    // Google sign-in set up, so Gmail can be connected here
    writePrefs({ googleClientId: 'test-client.apps.googleusercontent.com' });
    const u = await createLocalUser({
      fullName: 'Alex Rivera',
      firstName: 'Alex',
      onboardingCompletedAt: new Date().toISOString(),
    });
    userId = u.id;
    await setCurrentUserId(u.id);
    await db.people.bulkPut([0, 1].map((i) => fixturePerson(i, { userId })));
    engine = createFakeChatEngine({ delay: 0 });
  });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = undefined;
    resetThread();
  });

  it('shows LinkedIn and Gmail as not connected, under the composer, with Connect buttons', async () => {
    await mount();
    const strip = $('[data-testid="connect-strip"]')!;
    expect(strip).not.toBeNull();
    expect(strip.textContent).toMatch(/Connect your apps/);
    expect($('[data-testid="connect-status-linkedin"]')?.textContent?.trim()).toBe('Not connected');
    expect($('[data-testid="connect-status-google"]')?.textContent?.trim()).toBe('Not connected');
    expect($('[data-testid="home-status"]')?.textContent).toBe(
      'Connect LinkedIn and Gmail so I can see who you know.',
    );
    // after the composer, before the chips
    const order = [
      ...host.querySelectorAll(
        '[data-testid="composer-footer"], [data-testid="connect-strip"], [data-testid="chips"]',
      ),
    ].map((el) => (el as HTMLElement).dataset.testid);
    expect(order).toEqual(['composer-footer', 'connect-strip', 'chips']);
  });

  it('Connect posts the matching setup widget into the thread', async () => {
    await mount();
    await act(async () => $('[data-testid="connect-gmail"]')!.click());
    await settle();
    expect($('[data-testid="turn-user"]')?.textContent).toBe('Connect my Gmail.');
    expect(engine.calls.some((c) => c.method === 'runChip' && c.args.includes('connect-gmail'))).toBe(true);
    expect($('[data-testid="setup-google"]')).not.toBeNull();
    await act(() => threadActions(engine).newChat());
    await settle();
    await act(async () => $('[data-testid="connect-linkedin"]')!.click());
    await settle();
    expect($('[data-testid="setup-linkedin"]')).not.toBeNull();
  });

  it('shows what is connected, and hides once both are', async () => {
    await db.integrations.put({
      id: 'li',
      userId,
      provider: 'linkedin_csv',
      status: 'active',
      scopes: [],
      syncState: {},
      connectedAt: '',
    });
    await mount();
    expect($('[data-testid="connect-status-linkedin"]')?.textContent?.trim()).toBe('Connected');
    expect($('[data-testid="connect-linkedin"]')).toBeNull();
    expect($('[data-testid="connect-gmail"]')).not.toBeNull();
    act(() => root!.unmount());
    host.remove();
    root = undefined;
    resetHomeStatusCache();
    await connectBoth();
    await mount();
    expect($('[data-testid="connect-strip"]')).toBeNull();
  });

  it('where Google sign-in is not set up, shows Gmail as coming soon and never asks for it', async () => {
    await clearPrefs();
    await mount();
    expect($('[data-testid="connect-status-google"]')?.textContent?.trim()).toBe('Coming soon');
    expect($('[data-testid="connect-gmail"]')).toBeNull();
    expect($('[data-testid="connect-linkedin"]')).not.toBeNull();
    expect($('[data-testid="home-status"]')?.textContent).toBe(
      'Connect LinkedIn so I can see everyone you know.',
    );
    act(() => root!.unmount());
    host.remove();
    root = undefined;
    resetHomeStatusCache();
    // with LinkedIn in, nothing is left that can be connected, so the strip goes away
    await db.integrations.put({
      id: 'li',
      userId,
      provider: 'linkedin_csv',
      status: 'active',
      scopes: [],
      syncState: {},
      connectedAt: '',
    });
    await mount();
    expect($('[data-testid="connect-strip"]')).toBeNull();
    expect($('[data-testid="home-status"]')).toBeNull();
  });

  it('stays hidden once dismissed, and the line under the greeting stops asking too', async () => {
    await mount();
    await act(async () => $('[data-testid="connect-strip-dismiss"]')!.click());
    expect($('[data-testid="connect-strip"]')).toBeNull();
    expect($('[data-testid="home-status"]')).toBeNull();
    act(() => root!.unmount());
    host.remove();
    root = undefined;
    await mount();
    expect($('[data-testid="connect-strip"]')).toBeNull();
  });

  it('never shows for the sample student', async () => {
    await db.integrations.put({
      id: 'int_demo',
      userId,
      provider: 'demo',
      status: 'active',
      scopes: [],
      syncState: {},
      connectedAt: '',
    });
    await mount();
    expect($('[data-testid="connect-strip"]')).toBeNull();
  });
});

describe('home helpers', () => {
  const all = createFakeChatEngine({ delay: 0 }).chips();

  it('starterChips: LinkedIn (relabelled, same id and tool), add someone, what can you do', () => {
    const s = starterChips(all);
    expect(s.map((c) => c.id)).toEqual(['linkedin', 'add-person', 'what-can-you-do']);
    expect(s[0]).toMatchObject({ tool: 'import_linkedin', label: 'Bring in my LinkedIn' });
    expect(s[1]).toMatchObject({ message: 'Add someone I met' });
    expect(s[2]).toMatchObject({ message: 'What can you do?' });
  });

  it('starterChips leaves out the LinkedIn chip when the engine has none', () => {
    expect(starterChips(all.filter((c) => c.id !== 'linkedin')).map((c) => c.id)).toEqual([
      'add-person',
      'what-can-you-do',
    ]);
  });

  it('homeChips picks the set; chipRows cuts rows of four', () => {
    expect(homeChips(all, false).map((c) => c.id)).toEqual(['who-today', 'thank-you', 'route', 'pipeline']);
    expect(homeChips(all, true)).toHaveLength(3);
    expect(chipRows(all).map((r) => r.length)).toEqual([4, 4]);
    expect(chipRows(starterChips(all)).map((r) => r.length)).toEqual([3]);
    expect(chipRows([])).toEqual([]);
  });

  it('homeStatusLine only speaks when there is something to say', () => {
    const all = { linkedin: true, gmail: true, demo: false };
    expect(homeStatusLine({ ready: false, empty: true, waiting: 0, ...all })).toBeUndefined();
    expect(homeStatusLine({ ready: true, empty: false, waiting: 0, ...all })).toBeUndefined();
    expect(homeStatusLine({ ready: true, empty: false, waiting: 1, ...all })).toBe(
      'One person is waiting on a message from you.',
    );
    expect(homeStatusLine({ ready: true, empty: false, waiting: 12, ...all })).toBe(
      '12 people are waiting on a message from you.',
    );
    expect(homeStatusLine({ ready: true, empty: true, waiting: 0, ...all })).toMatch(
      /^Let's get you set up\./,
    );
  });

  it('homeStatusLine says what is not connected when nothing is waiting', () => {
    const s = { ready: true, empty: false, waiting: 0, demo: false };
    expect(homeStatusLine({ ...s, linkedin: false, gmail: false })).toBe(
      'Connect LinkedIn and Gmail so I can see who you know.',
    );
    expect(homeStatusLine({ ...s, linkedin: false, gmail: true })).toBe(
      'Connect LinkedIn so I can see everyone you know.',
    );
    expect(homeStatusLine({ ...s, linkedin: true, gmail: false })).toBe(
      'Connect Gmail so I can see who you email and send what you approve.',
    );
    // someone waiting comes first, and the sample student is never asked
    expect(homeStatusLine({ ...s, waiting: 2, linkedin: false, gmail: false })).toMatch(/^Two people/);
    expect(homeStatusLine({ ...s, demo: true, linkedin: false, gmail: false })).toBeUndefined();
    // Gmail is never asked for where it cannot be connected
    expect(homeStatusLine({ ...s, linkedin: true, gmail: false, gmailAvailable: false })).toBeUndefined();
    expect(homeStatusLine({ ...s, linkedin: false, gmail: false, gmailAvailable: false })).toBe(
      'Connect LinkedIn so I can see everyone you know.',
    );
  });

  it('readHomeStatus knows what is connected, the way the Setup line counts it', async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
    const u = await createLocalUser({ fullName: 'Pat Doe', firstName: 'Pat' });
    expect(await readHomeStatus(u.id)).toMatchObject({ linkedin: false, gmail: false, demo: false });
    await db.integrations.bulkPut([
      {
        id: 'i1',
        userId: u.id,
        provider: 'linkedin_live',
        status: 'revoked',
        scopes: [],
        syncState: {},
        connectedAt: '',
      },
      {
        id: 'i2',
        userId: u.id,
        provider: 'google',
        status: 'revoked',
        scopes: [],
        syncState: {},
        connectedAt: '',
      },
    ]);
    expect(await readHomeStatus(u.id)).toMatchObject({ linkedin: false, gmail: false });
    await db.integrations.bulkPut([
      {
        id: 'i1',
        userId: u.id,
        provider: 'linkedin_live',
        externalAccountId: 'acc',
        status: 'active',
        scopes: [],
        syncState: {},
        connectedAt: '',
      },
      {
        id: 'i2',
        userId: u.id,
        provider: 'google',
        status: 'needs_reauth',
        scopes: [],
        syncState: {},
        connectedAt: '',
      },
    ]);
    expect(await readHomeStatus(u.id)).toMatchObject({ linkedin: true, gmail: true });
  });

  it('readHomeStatus ignores hidden people and non-human rows', async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
    const u = await createLocalUser({ fullName: 'Pat Doe', firstName: 'Pat' });
    await db.people.bulkPut([
      fixturePerson(0, { userId: u.id, hiddenAt: '2026-01-01T00:00:00Z' }),
      fixturePerson(1, { userId: u.id, isHuman: false }),
    ]);
    expect(await readHomeStatus(u.id)).toMatchObject({ ready: true, empty: true });
    await db.people.put(fixturePerson(2, { userId: u.id }));
    expect(await readHomeStatus(u.id)).toMatchObject({ empty: false });
  });
});
