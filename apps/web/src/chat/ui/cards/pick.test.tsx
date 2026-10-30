import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResultEnvelope } from '../../types';
import type { ToolBlock } from '../threadStore';
import { ResultCard } from './ResultCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
let sent: string[] = [];

async function render(env: ResultEnvelope, toolName = 'find_people') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const block: ToolBlock = { type: 'tool', toolUseId: 't1', toolName, envelope: env, status: 'done' };
  await act(async () => {
    root!.render(
      <MemoryRouter>
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
const click = (el: HTMLElement | null) => act(async () => el?.click());

describe('picking people on a list of search results', () => {
  const ui = {
    title: 'On LinkedIn: recruiting',
    items: [
      { id: 'li:1', text: 'Dana Lee', sub: 'Engineer at Stripe', avatar: { name: 'Dana Lee' } },
      { id: 'li:2', text: 'Kai Ito', sub: 'PM at Stripe', avatar: { name: 'Kai Ito' } },
      {
        id: 'li:3',
        known: 'p7',
        text: 'Maya Chen',
        chip: 'You know them',
        href: '/people/p7',
        avatar: { name: 'Maya Chen' },
      },
    ],
  };
  const env: ResultEnvelope = {
    kind: 'list',
    data: { ui, forModel: {} },
    summary: 'Found 3 people on LinkedIn.',
  };

  it('each row has a checkbox; picked rows become one message naming them with their ids', async () => {
    await render(env);
    const boxes = $$('[data-testid="pick-person"]');
    expect(boxes).toHaveLength(3);
    expect($('[data-testid="selection-count"]')).toBeNull();
    // nothing picked: the usual next steps stay
    expect($('[data-testid="next-steps"]')).not.toBeNull();
    await click(boxes[0]!);
    await click(boxes[2]!);
    expect($('[data-testid="selection-count"]')?.textContent).toBe('2 picked');
    const steps = $$('[data-testid="selection-step"]');
    expect(steps.map((s) => s.textContent)).toEqual(['Find warm routes', 'Add to People', 'Write to them']);
    await click(steps[0]!);
    // someone Orbit already has is named plainly; a stranger carries the id add_sourced needs
    expect(sent).toEqual([
      'Add to People and find warm routes to each of: Dana Lee [rec li:1] and Maya Chen',
    ]);
    await click(steps[2]!);
    expect(sent[1]).toBe('Add to People and draft a message to each of: Dana Lee [rec li:1] and Maya Chen');
  });

  it('All picks every row shown, None clears them', async () => {
    await render(env);
    await click($('[data-testid="selection-all"]'));
    expect($('[data-testid="selection-count"]')?.textContent).toBe('3 picked');
    expect($('[data-testid="selection-all"]')?.textContent).toBe('None');
    await click($('[data-testid="selection-all"]'));
    expect($('[data-testid="selection-count"]')).toBeNull();
  });
});

describe('picking people on a people card', () => {
  it('offers routes to each and a draft to each', async () => {
    const people = [
      { person: { id: 'p1', name: 'Priya Ahmed', title: 'PM', company: 'Stripe' } },
      { person: { id: 'p2', name: 'Elena Garcia', title: 'Engineer', company: 'Figma' } },
    ];
    await render(
      { kind: 'people', data: { ui: { people }, forModel: {} }, summary: '2 people at target companies.' },
      'search_people',
    );
    const boxes = $$('[data-testid="pick-person"]');
    expect(boxes).toHaveLength(2);
    await click(boxes[0]!);
    await click(boxes[1]!);
    const steps = $$('[data-testid="selection-step"]');
    expect(steps.map((s) => s.textContent)).toEqual(['Find warm routes', 'Draft a message to both']);
    await click(steps[0]!);
    expect(sent).toEqual(['Find warm routes to each of: Priya Ahmed and Elena Garcia']);
  });
});

describe('the routes to several people card', () => {
  it('shows each person with their best way in and the step to take', async () => {
    const route = (toId: string, to: string, via: string, viaId: string) => ({
      band: 'possible',
      bandLabel: 'possible',
      score: 0.4,
      hops: [
        { from: 'you', to: via, toId: viaId, how: 'Worked together' },
        { from: via, to, toId, how: 'Same team' },
      ],
    });
    const people = [
      {
        target: { id: 'p1', name: 'Daniel Okafor', href: '/people/p1' },
        routes: [route('p1', 'Daniel Okafor', 'Maya Chen', 'p9')],
      },
      { target: { id: 'p2', name: 'Elena Garcia', href: '/people/p2' }, routes: [] },
    ];
    await render(
      {
        kind: 'routes_many',
        data: { ui: { people }, forModel: {} },
        summary:
          'Routes to 2 people. Daniel Okafor: through Maya Chen (possible). Elena Garcia: no route yet.',
        href: '/map?reach=p1',
      },
      'find_routes',
    );
    const rows = $$('[data-testid="routes-many-person"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Daniel Okafor');
    expect(rows[0]!.textContent).toContain('You → Maya Chen → Daniel Okafor');
    expect([...rows[0]!.querySelectorAll('[data-testid="next-step"]')].map((b) => b.textContent)).toEqual([
      'Ask Maya for an intro',
      'Write to Daniel',
    ]);
    expect(rows[1]!.textContent).toContain('No route through people you know yet');
    expect([...rows[1]!.querySelectorAll('[data-testid="next-step"]')].map((b) => b.textContent)).toEqual([
      'Write to Elena',
    ]);
  });
});
