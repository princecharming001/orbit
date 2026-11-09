/**
 * The question-back card (plan 37 §3.2): one button per option with what each is; a tap sends the pick with the ask
 * it finishes; once answered it is a quiet line with the choice; a second question in the same turn is not shown.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { clarifyResult, parsePick } from '../../clarify';
import type { ToolBlock } from '../threadStore';
import { ChoicesContext, type ChoicesState } from './Choices';
import { ResultCard } from './ResultCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
let sent: string[] = [];

const env = clarifyResult('company', 'Juniper', [
  { id: 'org_juniper-health', label: 'Juniper Health', sub: 'Healthcare. 2 people you know there' },
  { id: 'org_juniper-capital', label: 'Juniper Capital', sub: 'Venture capital. 1 person you know there' },
]);

async function render(state: ChoicesState, toolUseId = 't1') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const block: ToolBlock = {
    type: 'tool',
    toolUseId,
    toolName: 'find_routes',
    envelope: env,
    status: 'done',
  };
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <ChoicesContext.Provider value={state}>
          <ResultCard
            block={block}
            actions={{
              approve: async () => undefined,
              cancel: async () => {},
              send: (text) => {
                sent.push(text);
              },
            }}
          />
        </ChoicesContext.Provider>
      </MemoryRouter>,
    );
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  host?.remove();
  sent = [];
});

const $ = (sel: string) => host.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];

describe('the question-back card', () => {
  it('shows each option with what it is, and a tap sends the pick with the ask it finishes', async () => {
    await render({ running: false, askText: 'who do I know at Juniper', firstClarify: 't1' });
    const card = $('[data-testid="result-clarify"]')!;
    expect(card.dataset.state).toBe('open');
    expect(card.getAttribute('aria-label')).toBe('Which Juniper?');
    const options = $$('[data-testid="clarify-option"]');
    expect(options.map((o) => o.textContent)).toEqual([
      'Juniper HealthHealthcare. 2 people you know there',
      'Juniper CapitalVenture capital. 1 person you know there',
    ]);
    await act(async () => options[1]!.click());
    expect(sent).toHaveLength(1);
    expect(parsePick(sent[0]!)).toEqual({
      about: 'company',
      id: 'org_juniper-capital',
      term: 'Juniper',
      label: 'Juniper Capital',
      ask: 'who do I know at Juniper',
    });
  });

  it('when the ask was itself a pick, the new pick finishes the original ask', async () => {
    await render({
      running: false,
      askText: 'Juniper Health [picked company org_x for "Juniper": draft a note to someone at Juniper]',
    });
    await act(async () => $$('[data-testid="clarify-option"]')[0]!.click());
    expect(parsePick(sent[0]!)?.ask).toBe('draft a note to someone at Juniper');
  });

  it('waits while a turn runs', async () => {
    await render({ running: true });
    expect($$('[data-testid="clarify-option"]').every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('once answered, is a quiet line with the choice; typed words leave nothing behind', async () => {
    await render({
      running: false,
      laterUserText: 'Juniper Health [picked company org_juniper-health for "Juniper"]',
    });
    expect($('[data-testid="result-clarify"]')!.dataset.state).toBe('answered');
    expect($('[data-testid="result-clarify"]')!.textContent).toBe(' Juniper Health');
    expect($$('[data-testid="clarify-option"]')).toHaveLength(0);
    act(() => root!.unmount());
    root = undefined;
    host.remove();
    await render({ running: false, laterUserText: 'never mind, show my drafts' });
    expect($('[data-testid="result-clarify"]')).toBeNull();
  });

  it('a second question in the same turn is not shown', async () => {
    await render({ running: false, firstClarify: 't1' }, 't2');
    expect($('[data-testid="result-clarify"]')).toBeNull();
  });
});

describe('a question back reads question first', () => {
  it('puts the options under the words, whatever order they streamed in, and keeps them as a card', async () => {
    const { questionLast, turnLayout } = await import('../Thread');
    const blocks = [
      {
        type: 'tool' as const,
        toolUseId: 't1',
        toolName: 'find_routes',
        envelope: env,
        status: 'done' as const,
      },
      { type: 'text' as const, text: 'Juniper Health or Juniper Capital?' },
    ];
    const pieces = turnLayout(questionLast(blocks));
    expect(pieces.map((p) => (p.type === 'work' ? 'work' : p.b.type))).toEqual(['text', 'tool']);
    // a turn without a question keeps its order
    const other = [
      blocks[1]!,
      { ...blocks[0]!, envelope: { kind: 'company' as const, data: {}, summary: '' } },
    ];
    expect(questionLast(other)).toBe(other);
  });
});
