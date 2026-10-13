import Anthropic from '@anthropic-ai/sdk';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentUserId } from '../../db/repo';
import { db } from '../../db/schema';
import { createLocalUser } from '../../engine/account';
import { connectAndSyncGoogle } from '../../engine/integrations';
import { setLlmClientFactoryForTests } from '../../integrations/anthropic';
import { setConnectorModeForTests } from '../../integrations/connectorOutcome';
import { setConnectorsMockForTests } from '../../integrations/connectorsMock';
import { clearPrefs, flushPrefs, readPrefs, writePrefs } from '../../integrations/prefs';
import { setSharedClaudeUrlForTests } from '../../integrations/shared-claude';
import { SessionProvider } from '../../state/session';
import { ToastProvider } from '../../ui';
import { ChatEngineProvider } from '../engineContext';
import { createFakeChatEngine, type FakeChatEngine } from '../testing/fakeEngine';
import { ChatHome } from './ChatHome';
import { getThread, resetThread, threadActions } from './threadStore';

// the Google sign-in needs the live page; the widget's own states are what is under test
vi.mock('../../engine/integrations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../engine/integrations')>()),
  connectAndSyncGoogle: vi.fn(),
}));

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
const sends = () => engine.calls.filter((c) => c.method === 'send').map((c) => c.args[1]);

/** Types into a React-controlled input the way a person would. */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Picks a file in a file input the way the browser would. */
async function choose(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function showWidget(what: 'google' | 'linkedin' | 'claude' | 'resume') {
  await mount();
  await act(() => threadActions(engine).send(`setup ${what}`));
  await settle();
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await clearPrefs();
  resetThread();
  vi.mocked(connectAndSyncGoogle).mockReset();
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
  root = undefined;
  host?.remove();
  setLlmClientFactoryForTests(undefined);
  resetThread();
});

describe('tap-to-answer choices', () => {
  it('shows the options as pills and sends exactly the pill message once', async () => {
    await mount();
    await act(() => threadActions(engine).send('show choices'));
    await settle();
    const pills = $$('[data-testid="choice-pill"]');
    expect(pills.map((p) => p.textContent)).toEqual(['Show my pipeline', 'What else can you do?']);
    // the same classes as the chips on the home
    expect(pills[0]!.className).toMatch(/glass glass-hover type-chip rounded-full/);
    // two quick taps still send one turn
    await act(async () => {
      pills[0]!.click();
      pills[0]!.click();
    });
    await settle();
    expect(sends().filter((m) => m === 'Show my pipeline')).toHaveLength(1);
    expect($$('[data-testid="turn-user"]').map((u) => u.textContent)).toEqual([
      'show choices',
      'Show my pipeline',
    ]);
    // the answer is a normal turn with a pipeline card
    expect($('[data-testid="result-pipeline"]')).not.toBeNull();
  });

  it('turns into a quiet "You chose" line once a pill was tapped, with no live buttons left', async () => {
    await mount();
    await act(() => threadActions(engine).send('show choices'));
    await settle();
    await act(async () => $$('[data-testid="choice-pill"]')[1]!.click());
    await settle();
    expect($$('[data-testid="choice-pill"]')).toHaveLength(0);
    expect($('[data-testid="result-choices"]')?.textContent?.trim()).toBe('You chose: What else can you do?');
    expect($$('[data-testid="result-choices"] button')).toHaveLength(0);
  });

  it('disappears when the student types their own words instead', async () => {
    await mount();
    await act(() => threadActions(engine).send('show choices'));
    await settle();
    expect($$('[data-testid="choice-pill"]')).toHaveLength(2);
    await act(() => threadActions(engine).send('who is on my list'));
    await settle();
    expect($('[data-testid="result-choices"]')).toBeNull();
    expect($$('[data-testid="choice-pill"]')).toHaveLength(0);
  });

  it('is disabled while a turn runs and does nothing if clicked', async () => {
    engine = createFakeChatEngine({ delay: 50 });
    await mount();
    let turn!: Promise<void>;
    await act(async () => {
      turn = threadActions(engine).send('show choices');
    });
    // the pills arrive before the turn ends
    for (let i = 0; i < 600 && $$('[data-testid="choice-pill"]').length === 0; i++)
      await act(() => new Promise((r) => setTimeout(r, 5)));
    const pills = $$('[data-testid="choice-pill"]') as HTMLButtonElement[];
    expect(pills).toHaveLength(2);
    expect(getThread().running).toBe(true);
    expect(pills.every((p) => p.disabled)).toBe(true);
    await act(async () => pills[0]!.click());
    expect(sends()).toEqual(['show choices']);
    await act(async () => {
      await turn;
    });
    await settle();
    expect(
      (($$('[data-testid="choice-pill"]') as HTMLButtonElement[])[0] as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

const CSV = `First Name,Last Name,URL,Email Address,Company,Position,Connected On
Tara,Nguyen,https://www.linkedin.com/in/tara-nguyen-demo,,Brex,Associate Product Manager,01 Oct 2026
Dev,Patel,https://www.linkedin.com/in/dev-patel-demo,,Ramp,Software Engineer,02 Oct 2026
Mia,Chen,https://www.linkedin.com/in/mia-chen-demo,,Stripe,Analyst,03 Oct 2026
`;

describe('setup: LinkedIn', () => {
  it('imports a small Connections.csv, adds the people and links on', async () => {
    await showWidget('linkedin');
    const card = $('[data-testid="setup-linkedin"]')!;
    expect(card.textContent).toMatch(/Settings > Data privacy > Get a copy of your data > Connections/);
    expect(card.textContent).not.toMatch(/[—–]/);
    expect(await db.people.where('userId').equals(userId).count()).toBe(0);
    await choose(
      $('[data-testid="linkedin-file"]') as HTMLInputElement,
      new File([CSV], 'Connections.csv', { type: 'text/csv' }),
    );
    await settle(60);
    const names = (await db.people.where('userId').equals(userId).toArray()).map((p) => p.displayName);
    expect(names).toEqual(expect.arrayContaining(['Tara Nguyen', 'Dev Patel', 'Mia Chen']));
    const done = $('[data-testid="linkedin-done"]')!;
    expect(done.textContent).toMatch(/3 people added, 0 updated/);
    const links = [...done.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual(
      expect.arrayContaining([
        ['Show the map', '/map'],
        ['See my people', '/people?view=list'],
      ]),
    );
    // a second upload updates, never doubles
    await choose(
      $('[data-testid="linkedin-file"]') as HTMLInputElement,
      new File([CSV], 'Connections.csv', { type: 'text/csv' }),
    );
    await settle(60);
    expect($('[data-testid="linkedin-done"]')?.textContent).toMatch(/0 people added, 3 updated/);
    expect(await db.people.where('userId').equals(userId).count()).toBe(3);
  });

  it('says so in plain words when the file holds nobody or is not a CSV', async () => {
    await showWidget('linkedin');
    await choose(
      $('[data-testid="linkedin-file"]') as HTMLInputElement,
      new File(['First Name,Last Name,URL\n'], 'Connections.csv', { type: 'text/csv' }),
    );
    await settle(30);
    expect($('[data-testid="linkedin-error"]')?.textContent).toMatch(/found nobody in that file/);
    await choose(
      $('[data-testid="linkedin-file"]') as HTMLInputElement,
      new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 1, 2])], 'cv.pdf', { type: 'application/pdf' }),
    );
    await settle(30);
    expect($('[data-testid="linkedin-error"]')?.textContent).toMatch(/not a CSV file/);
  });
});

describe('setup: LinkedIn live', () => {
  afterEach(() => {
    setConnectorsMockForTests(undefined);
    setConnectorModeForTests(undefined);
  });

  it('puts Connect LinkedIn first, connects, then offers Sync now', async () => {
    setConnectorsMockForTests(true);
    await showWidget('linkedin');
    const card = $('[data-testid="setup-linkedin"]')!;
    expect(card.textContent).toMatch(/Connect your LinkedIn/);
    expect($('[data-testid="linkedin-live-connect"]')).not.toBeNull();
    // the export is one tap away, not in the way
    expect($('[data-testid="linkedin-dropzone"]')).toBeNull();
    await act(async () => $('[data-testid="linkedin-show-upload"]')!.click());
    expect($('[data-testid="linkedin-dropzone"]')).not.toBeNull();
    await act(async () => $('[data-testid="linkedin-live-connect"]')!.click());
    await settle(80);
    expect($('[data-testid="linkedin-done"]')?.textContent).toMatch(
      /4 people added, 0 updated\. Orbit keeps them in sync/,
    );
    expect($('[data-testid="linkedin-live-connected"]')?.textContent).toMatch(
      /Synced live, 4 connections, last sync/,
    );
    expect($('[data-testid="setup-linkedin"]')!.textContent).toMatch(/LinkedIn is connected/);
    await act(async () => $('[data-testid="linkedin-live-sync"]')!.click());
    await settle(80);
    expect($('[data-testid="linkedin-done"]')?.textContent).toMatch(/0 people added, 4 updated/);
    expect(await db.people.where('userId').equals(userId).count()).toBe(4);
  });

  it('says live sync is switching on soon and keeps the export when the key is not pasted yet', async () => {
    setConnectorModeForTests('unconfigured');
    await showWidget('linkedin');
    await act(async () => $('[data-testid="linkedin-live-connect"]')!.click());
    await settle(20);
    expect($('[data-testid="linkedin-live-soon"]')?.textContent).toBe(
      'Live sync is switching on soon. Upload your export for now.',
    );
    expect($('[data-testid="linkedin-live-connect"]')).toBeNull();
    expect($('[data-testid="linkedin-dropzone"]')).not.toBeNull();
    expect($('[data-testid="linkedin-error"]')).toBeNull();
  });
});

const KEY = 'sk-ant-api03-widget-test-key-0123456789';

describe('setup: Claude key', () => {
  it('explains the shared access, saves the key, tests it and never shows it back', async () => {
    const create = vi.fn(async () => ({}));
    setLlmClientFactoryForTests(() => ({ messages: { create } }) as never);
    await showWidget('claude');
    const card = $('[data-testid="setup-claude_key"]')!;
    expect(card.textContent).toMatch(/Without a key/);
    expect(card.textContent).toMatch(/Claude chat and write your drafts/);
    const input = $('[data-testid="claude-key-input"]') as HTMLInputElement;
    expect(input.type).toBe('password');
    const save = $('[data-testid="claude-key-save"]') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    act(() => type(input, KEY));
    await settle(2);
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    await settle(20);
    expect(create).toHaveBeenCalledTimes(1);
    await flushPrefs();
    expect(readPrefs().anthropicApiKey).toBe(KEY);
    expect($('[data-testid="claude-key-result"]')?.textContent).toMatch(/Saved, and it works/);
    // nothing on the page holds the key: not the field, not the text, not an attribute
    expect(($('[data-testid="claude-key-input"]') as HTMLInputElement).value).toBe('');
    expect(host.innerHTML).not.toContain(KEY);
    expect(host.textContent).not.toContain('sk-ant-api03');
    // the live status flips with it
    await settle(10);
    expect($('[data-testid="claude-key-remove"]')).not.toBeNull();
    // and a stored envelope never carries it
    expect(JSON.stringify(engine.calls)).not.toContain(KEY);
  });

  it('where Orbit has shared Claude access, says it has a daily limit that a key lifts', async () => {
    setSharedClaudeUrlForTests('https://claude.example.test');
    try {
      await showWidget('claude');
      const text = $('[data-testid="setup-claude_key"]')!.textContent!;
      expect(text).toMatch(/shared Claude access, which has a daily limit/);
      expect(text).toMatch(/lifts the limit and lets Claude write your drafts/);
    } finally {
      setSharedClaudeUrlForTests(undefined);
    }
  });

  it('keeps the key but says the test failed when Anthropic rejects it', async () => {
    setLlmClientFactoryForTests(
      () =>
        ({
          messages: {
            create: async () => {
              throw new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers());
            },
          },
        }) as never,
    );
    await showWidget('claude');
    act(() => type($('[data-testid="claude-key-input"]') as HTMLInputElement, KEY));
    await settle(2);
    await act(async () => ($('[data-testid="claude-key-save"]') as HTMLButtonElement).click());
    await settle(20);
    expect($('[data-testid="claude-key-result"]')?.textContent).toMatch(
      /Saved, but the test failed: Anthropic rejected this key/,
    );
    expect(host.innerHTML).not.toContain(KEY);
  });

  it('removes a saved key', async () => {
    writePrefs({ anthropicApiKey: KEY });
    await showWidget('claude');
    expect($('[data-testid="claude-key-saved"]')?.textContent).toMatch(/A key is saved/);
    expect(host.innerHTML).not.toContain(KEY);
    await act(async () => ($('[data-testid="claude-key-remove"]') as HTMLButtonElement).click());
    await settle(10);
    await flushPrefs();
    expect(readPrefs().anthropicApiKey).toBeUndefined();
  });
});

describe('setup: Google', () => {
  it('idle without a client id: explains what is needed and offers a field and the Settings link', async () => {
    await showWidget('google');
    const card = $('[data-testid="setup-google"]')!;
    expect($('[data-testid="google-needs-client"]')?.textContent).toMatch(/OAuth client ID/);
    expect(card.querySelector('a[href="/settings/integrations"]')).not.toBeNull();
    const connect = $('[data-testid="google-connect"]') as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    act(() =>
      type($('[data-testid="google-client-id"]') as HTMLInputElement, 'abc.apps.googleusercontent.com'),
    );
    await settle(2);
    expect(connect.disabled).toBe(false);
  });

  it('idle with a client id: Connect Google runs the same connect and sync Settings uses', async () => {
    writePrefs({ googleClientId: 'abc.apps.googleusercontent.com' });
    vi.mocked(connectAndSyncGoogle).mockResolvedValue({ email: 'alex@example.edu' });
    await showWidget('google');
    expect($('[data-testid="google-needs-client"]')).toBeNull();
    const connect = $('[data-testid="google-connect"]') as HTMLButtonElement;
    expect(connect.textContent).toBe('Connect Google');
    await act(async () => connect.click());
    await settle(10);
    expect(connectAndSyncGoogle).toHaveBeenCalledTimes(1);
    expect(vi.mocked(connectAndSyncGoogle).mock.calls[0]![1]).toMatchObject({
      clientId: 'abc.apps.googleusercontent.com',
    });
    expect($('[data-testid="google-error"]')).toBeNull();
  });

  it('says in plain words when the sign-in window was closed', async () => {
    writePrefs({ googleClientId: 'abc.apps.googleusercontent.com' });
    vi.mocked(connectAndSyncGoogle).mockRejectedValue(new Error('popup_closed'));
    await showWidget('google');
    await act(async () => ($('[data-testid="google-connect"]') as HTMLButtonElement).click());
    await settle(10);
    expect($('[data-testid="google-error"]')?.textContent).toMatch(/window was closed/);
    expect(($('[data-testid="google-connect"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('connecting: shows the wait and disables the button', async () => {
    writePrefs({ googleClientId: 'abc.apps.googleusercontent.com' });
    let finish!: () => void;
    vi.mocked(connectAndSyncGoogle).mockImplementation(
      () => new Promise((r) => (finish = () => r({ email: 'alex@example.edu' }))),
    );
    await showWidget('google');
    await act(async () => ($('[data-testid="google-connect"]') as HTMLButtonElement).click());
    await settle(2);
    const btn = $('[data-testid="google-connect"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toMatch(/Waiting for Google/);
    await act(async () => finish());
    await settle(5);
  });

  it('connected: says what Orbit now does and offers a reconnect', async () => {
    await db.integrations.put({
      id: 'int_g',
      userId,
      provider: 'google',
      externalAccountId: 'alex@example.edu',
      status: 'active',
      scopes: [],
      syncState: {},
      connectedAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
    });
    await showWidget('google');
    const card = $('[data-testid="setup-google"]')!;
    expect(card.textContent).toMatch(/Connected as alex@example\.edu/);
    expect(card.textContent).toMatch(/replies/);
    expect(card.textContent).toMatch(/coffee chats you book/);
    expect(card.textContent).toMatch(/Reconnect and sync now/);
    expect($('[data-testid="google-client-id"]')).toBeNull();
  });

  it('demo: explains the sample calendar and does not offer a sign-in', async () => {
    await db.integrations.put({
      id: 'int_demo',
      userId,
      provider: 'demo',
      status: 'active',
      scopes: [],
      syncState: {},
      connectedAt: new Date().toISOString(),
    });
    await showWidget('google');
    expect($('[data-testid="google-demo"]')?.textContent).toMatch(/demo/);
    expect($('[data-testid="google-connect"]')).toBeNull();
  });
});

describe('setup: resume', () => {
  it('saves a resume through the same path as Settings and reports the lines it read', async () => {
    await showWidget('resume');
    expect($('[data-testid="resume-status"]')).toBeNull();
    const text =
      'Alex Rivera\nCornell University, BS Computer Science, 2028\nSoftware Engineering Intern, Brex, Summer 2026\n';
    await choose(
      $('[data-testid="resume-file"]') as HTMLInputElement,
      new File([text], 'resume.txt', { type: 'text/plain' }),
    );
    await settle(40);
    const current = (await db.resumes.where('userId').equals(userId).toArray()).filter((r) => r.isCurrent);
    expect(current.map((r) => r.filename)).toEqual(['resume.txt']);
    expect($('[data-testid="resume-done"]')?.textContent).toMatch(
      /Saved resume\.txt and read \d+ lines? from it/,
    );
  });

  it('shows the resume on file, and refuses a file it cannot read in plain words', async () => {
    await db.resumes.add({
      id: 'r_old',
      userId,
      filename: 'old.pdf',
      text: 'x',
      isCurrent: true,
      createdAt: new Date().toISOString(),
    });
    await showWidget('resume');
    expect($('[data-testid="resume-status"]')?.textContent).toMatch(/On file: old\.pdf/);
    await choose(
      $('[data-testid="resume-file"]') as HTMLInputElement,
      new File(['x'], 'resume.pages', { type: 'application/octet-stream' }),
    );
    await settle(20);
    expect($('[data-testid="resume-error"]')?.textContent).toMatch(/Save your resume as a PDF/);
  });
});
