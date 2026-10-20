import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setCurrentUserId } from '../../db/repo';
import { db } from '../../db/schema';
import { createLocalUser } from '../../engine/account';
import { SessionProvider } from '../../state/session';
import { ToastProvider } from '../../ui';
import { ChatEngineProvider } from '../engineContext';
import { createFakeChatEngine, type FakeChatEngine } from '../testing/fakeEngine';
import { fixturePerson } from '../testing/fixtures';
import type { ResultKind } from '../types';
import { ChatHome } from './ChatHome';
import { applyEvent, getThread, hydrate, resetThread, threadActions } from './threadStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
let engine: FakeChatEngine;

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

/** Types into a React-controlled field the way a person would. */
function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('the chat thread', () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
    resetThread();
    const u = await createLocalUser({
      fullName: 'Alex Rivera',
      firstName: 'Alex',
      onboardingCompletedAt: new Date().toISOString(),
    });
    await setCurrentUserId(u.id);
    // people the send rules know, so the draft card's Approve is not held back
    await db.people.bulkPut([0, 1, 2, 3].map((i) => fixturePerson(i, { userId: u.id })));
    engine = createFakeChatEngine({ delay: 0 });
  });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    resetThread();
  });

  it('shows the greeting, the chips and the router note on the home state', async () => {
    await mount();
    expect($('[data-testid="greeting"]')?.textContent).toMatch(/Hey Alex/);
    expect($$('[data-testid^="chip-"]')).toHaveLength(4);
    expect($('[data-testid="router-note"]')?.textContent).toMatch(/no Claude key/);
    expect($('[data-testid="composer-mode"]')?.textContent).toMatch(/Templates/);
  });

  it('renders a card for every result kind', async () => {
    await mount();
    await act(() => threadActions(engine).send('show me everything'));
    await settle();
    const kinds: Exclude<ResultKind, 'text'>[] = [
      'person',
      'people',
      'draft',
      'drafts',
      'pipeline',
      'routes',
      'brief',
      'suggestion',
      'note',
      'facts',
      'company',
      'settings',
      'import',
      'prep',
      'list',
      'needs_confirmation',
      'error',
    ];
    for (const k of kinds) expect($(`[data-testid="result-${k}"]`), k).not.toBeNull();
    // the user's words sit in a bubble, the assistant's text streams in as plain text
    expect($('[data-testid="turn-user"]')?.textContent).toBe('show me everything');
    expect($('[data-testid="turn-assistant"]')?.textContent).toMatch(/That is the whole set/);
    // every card that lives on a page offers the way there
    expect($$('[data-testid="open-in-app"]').length).toBeGreaterThan(8);
  });

  it('appends streamed text deltas to one paragraph', async () => {
    await mount();
    const actions = threadActions(engine);
    await act(() => actions.send('hello there'));
    await settle();
    const turn = getThread().turns.find((t) => t.role === 'assistant');
    expect(turn?.role).toBe('assistant');
    const id = turn!.id;
    act(() => applyEvent(id, { type: 'text', delta: ' One more' }));
    act(() => applyEvent(id, { type: 'text', delta: ' line.' }));
    await settle(2);
    const text = $('[data-testid="turn-assistant"]')?.textContent ?? '';
    expect(text).toMatch(/own words\. One more line\.$/);
    // one text block, not three
    const blocks = (getThread().turns.find((t) => t.id === id) as { blocks: unknown[] }).blocks;
    expect(blocks.filter((b) => (b as { type: string }).type === 'text')).toHaveLength(1);
  });

  it('shows the running tool as a status card until its result arrives', async () => {
    await mount();
    const actions = threadActions(engine);
    await act(() => actions.send('hi'));
    await settle();
    const turn = getThread().turns.find((t) => t.role === 'assistant')!;
    act(() =>
      applyEvent(turn.id, {
        type: 'tool_start',
        toolUseId: 'tu_x',
        toolName: 'get_pipeline',
        progress: 'Looking at your pipeline',
      }),
    );
    await settle(2);
    expect($('[data-testid="tool-status"]')?.textContent).toMatch(/Looking at your pipeline/);
    act(() =>
      applyEvent(turn.id, {
        type: 'tool_result',
        toolUseId: 'tu_x',
        envelope: { kind: 'text', data: {}, summary: 'Nothing moving today.' },
      }),
    );
    await settle(2);
    expect($('[data-testid="tool-status"]')).toBeNull();
    expect($('[data-testid="turn-assistant"]')?.textContent).toMatch(/Nothing moving today/);
  });

  it('approves a send with the text as edited in the card, and cancels through the engine', async () => {
    await mount();
    await act(() => threadActions(engine).send('send it'));
    await settle();
    const card = $('[data-testid="result-needs_confirmation"]')!;
    expect(card.textContent).toMatch(/Needs your approval/i);
    const box = card.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message body"]')!;
    act(() => type(box, `${box.value}\n\nP.S. Edited in the chat.`));
    await settle(30);
    const approve = [...card.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Approve & send'),
    )!;
    expect(approve.disabled).toBe(false);
    await act(async () => approve.click());
    await settle(10);
    const call = engine.calls.find((c) => c.method === 'approve');
    expect(call).toBeDefined();
    const [actionId, edited] = call!.args as [string, { body: string; subject?: string }];
    expect(actionId).toMatch(/^conf_/);
    expect(edited.body).toMatch(/P\.S\. Edited in the chat\.$/);
    expect(edited.subject).toBe('Thank you for your time');
    // the decision is on the record and the card shows what happened
    expect($('[data-testid="turn-decision"]')?.textContent?.trim()).toMatch(/^Approved/);
    expect($('[data-testid="result-outcome"]')?.textContent).toMatch(/Opened in your mail app/);

    // a second confirmation, cancelled
    await act(() => threadActions(engine).send('send it again'));
    await settle();
    const cards = $$('[data-testid="result-needs_confirmation"]');
    const second = cards[cards.length - 1]!;
    const cancel = second.querySelector<HTMLButtonElement>('[data-testid="confirm-cancel"]')!;
    await act(async () => cancel.click());
    await settle(5);
    const cancelled = engine.calls.find((c) => c.method === 'cancel');
    expect(cancelled?.args[0]).toMatch(/^conf_/);
    expect(second.querySelector('[data-testid="confirm-decided"]')?.textContent).toMatch(/Cancelled/);
    expect($$('[data-testid="turn-decision"]').at(-1)?.textContent?.trim()).toMatch(/^Cancelled/);
  });

  it('keeps Approve off when the engine blocks the action', async () => {
    await mount();
    await act(() => threadActions(engine).send('wipe my data'));
    await settle();
    const card = $('[data-testid="result-needs_confirmation"]')!;
    expect(card.querySelector('[data-testid="confirm-blocked"]')?.textContent).toMatch(
      /Export your data first/,
    );
    expect(card.querySelector<HTMLButtonElement>('[data-testid="confirm-approve"]')?.disabled).toBe(true);
  });

  it('shows each error kind with its own words and keeps the thread', async () => {
    await mount();
    for (const [ask, kind, words] of [
      ['fail no key', 'no_key', /Claude key/],
      ['fail cap', 'cap', /budget/],
      ['fail refusal', 'refusal', /declined/],
      ['fail network', 'network', /reach Claude/],
      ['fail other', 'other', /went wrong/],
    ] as const) {
      await act(() => threadActions(engine).send(ask));
      await settle();
      const errs = $$('[data-testid="turn-error"]');
      const last = errs[errs.length - 1]!;
      expect(last.dataset.kind, ask).toBe(kind);
      expect(last.textContent, ask).toMatch(words);
    }
    expect($$('[data-testid="turn-user"]')).toHaveLength(5);
  });

  it('rebuilds a stored conversation from its content blocks and actions', () => {
    const turns = hydrate(
      [
        {
          id: 'm1',
          conversationId: 'c',
          userId: 'u',
          seq: 0,
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          createdAt: '2026-10-01T00:00:00Z',
        },
        {
          id: 'm2',
          conversationId: 'c',
          userId: 'u',
          seq: 1,
          role: 'assistant',
          content: [
            { type: 'text', text: 'Looking.' },
            { type: 'tool_use', id: 'tu1', name: 'get_pipeline', input: {} },
            { type: 'text', text: 'Done.' },
          ],
          createdAt: '2026-10-01T00:00:01Z',
        },
        {
          id: 'm3',
          conversationId: 'c',
          userId: 'u',
          seq: 2,
          role: 'system',
          content: 'Approved: send',
          meta: 'decision',
          createdAt: '2026-10-01T00:00:02Z',
        },
      ],
      [
        {
          id: 'tu1',
          conversationId: 'c',
          userId: 'u',
          toolName: 'get_pipeline',
          input: {},
          status: 'done',
          envelope: { kind: 'text', data: {}, summary: 'Three moving.' },
          createdAt: '',
          updatedAt: '',
        },
      ],
    );
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'decision']);
    const a = turns[1] as { blocks: { type: string; envelope?: { summary: string } }[] };
    expect(a.blocks.map((b) => b.type)).toEqual(['text', 'tool', 'text']);
    expect(a.blocks[1]!.envelope?.summary).toBe('Three moving.');
  });
});
