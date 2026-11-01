/**
 * Settings, Voice (plan 29 §B5) against the fake orbit-api: the card in sentences, the notes Orbit learned with Keep
 * and Forget calling /voice/notes, the score, and "Relearn from my sent mail" calling /voice/relearn. No dash and no
 * exclamation mark anywhere on the page.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setCurrentUserId } from '../../db/repo';
import { db, wipeDatabase } from '../../db/schema';
import { SessionProvider } from '../../state/session';
import { leaveFakeApi, signInToFakeApi } from '../../test/account';
import type { FakeOrbitApi } from '../../test/fakeOrbitApi';
import { ToastProvider } from '../../ui';
import { VoiceSection } from './Voice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};
const until = async (fn: () => boolean, what: string) => {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await settle(1);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const NOTES = [
  { id: 'vn_thanks', text: "You cut 'Thanks either way' every time", evidence: ['e1', 'e4', 'e9'] },
  {
    id: 'vn_line',
    text: 'You never open with the connection line twice in one thread',
    evidence: ['e2', 'e7'],
  },
  { id: 'vn_name', text: 'You sign with your first name only', evidence: ['e3', 'e5'] },
].map((n) => ({ ...n, createdAt: '2026-10-05T03:10:00.000Z', keptAt: null, forgottenAt: null }));

let api: FakeOrbitApi;
let host: HTMLDivElement;
let unmount: () => void;

beforeEach(async () => {
  await wipeDatabase();
  let user;
  ({ api, user } = await signInToFakeApi());
  api.state.voice = {
    cardProse: [
      'You greet with Hi and sign off with Thanks.',
      'You write short, with contractions and no exclamation marks.',
    ],
    notes: NOTES.map((n) => ({ ...n })),
    soundsLikeYou: 2.6,
    relearnedAt: '2026-10-01T03:00:00.000Z',
    relearnRequests: 0,
  };
  await setCurrentUserId(user.id);
  host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/settings/voice']}>
        <SessionProvider>
          <ToastProvider>
            <VoiceSection />
          </ToastProvider>
        </SessionProvider>
      </MemoryRouter>,
    ),
  );
  unmount = () => {
    act(() => root.unmount());
    host.remove();
  };
});
afterEach(async () => {
  unmount();
  await leaveFakeApi();
});

const notes = () => [...host.querySelectorAll('[data-testid="voice-note"]')];
const button = (row: Element, name: RegExp) =>
  [...row.querySelectorAll('button')].find((b) =>
    name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''),
  )!;

describe('Settings, Voice', () => {
  it('shows the card in sentences, the score and the three notes, with no dash or exclamation mark', async () => {
    await until(() => notes().length === 3, 'the notes');
    expect(host.querySelector('[data-testid="voice-card"]')!.textContent).toContain('You greet with Hi');
    expect(host.querySelector('[data-testid="voice-score"]')!.textContent).toContain('2.6 of 3');
    expect(notes()[0]!.textContent).toContain('from 3 edits');
    expect(host.textContent).not.toMatch(/[!–—]/);
  });

  it('Forget and Keep call /voice/notes; a forgotten note leaves the list and the copy here says so', async () => {
    await until(() => notes().length === 3, 'the notes');
    const thanks = notes().find((n) => n.textContent!.includes('Thanks either way'))!;
    await act(async () => button(thanks, /^forget/i).click());
    await until(() => notes().length === 2, 'the note to go');
    expect(api.state.voice.notes.find((n) => n.id === 'vn_thanks')!.forgottenAt).toBeTruthy();
    const name = notes().find((n) => n.textContent!.includes('first name'))!;
    await act(async () => button(name, /^keep/i).click());
    await until(() => !!api.state.voice.notes.find((n) => n.id === 'vn_name')!.keptAt, 'the keep');
    await until(
      () =>
        notes()
          .find((n) => n.textContent!.includes('first name'))!
          .textContent!.includes('Kept'),
      'Kept',
    );
    const user = (await db.users.toArray())[0]!;
    const copy = (await db.settings.get(user.id))!.voiceNotes!;
    expect(copy.find((n) => n.id === 'vn_thanks')!.forgottenAt).toBeTruthy();
  });

  it('Relearn from my sent mail asks the server to read it all again', async () => {
    await until(() => notes().length === 3, 'the notes');
    const relearn = host.querySelector<HTMLButtonElement>('[data-testid="voice-relearn"]')!;
    await act(async () => relearn.click());
    await until(() => api.state.voice.relearnRequests === 1, 'the relearn');
  });
});
