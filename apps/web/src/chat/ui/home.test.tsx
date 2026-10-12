import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentUserId } from '../../db/repo';
import { db } from '../../db/schema';
import { createLocalUser } from '../../engine/account';
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

  it('shows the full set of eight chips once there are people, with no status when nothing waits', async () => {
    await db.people.bulkPut([0, 1].map((i) => fixturePerson(i, { userId })));
    await mount();
    expect(chipIds()).toHaveLength(8);
    expect(chipIds()[0]).toBe('chip-who-today');
    expect($('[data-testid="home-status"]')).toBeNull();
    expect($('[data-testid="chips"]')?.children).toHaveLength(2);
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
    expect(chipIds()).toHaveLength(8);
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
    expect(homeChips(all, false)).toBe(all);
    expect(homeChips(all, true)).toHaveLength(3);
    expect(chipRows(all).map((r) => r.length)).toEqual([4, 4]);
    expect(chipRows(starterChips(all)).map((r) => r.length)).toEqual([3]);
    expect(chipRows([])).toEqual([]);
  });

  it('homeStatusLine only speaks when there is something to say', () => {
    expect(homeStatusLine({ ready: false, empty: true, waiting: 0 })).toBeUndefined();
    expect(homeStatusLine({ ready: true, empty: false, waiting: 0 })).toBeUndefined();
    expect(homeStatusLine({ ready: true, empty: false, waiting: 1 })).toBe(
      'One person is waiting on a message from you.',
    );
    expect(homeStatusLine({ ready: true, empty: false, waiting: 12 })).toBe(
      '12 people are waiting on a message from you.',
    );
    expect(homeStatusLine({ ready: true, empty: true, waiting: 0 })).toMatch(/^Let's get you set up\./);
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
