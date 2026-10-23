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

async function render(env: ResultEnvelope) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const block: ToolBlock = {
    type: 'tool',
    toolUseId: 't1',
    toolName: 'find_routes',
    envelope: env,
    status: 'done',
  };
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <ResultCard
          block={block}
          actions={{ approve: async () => undefined, cancel: async () => {}, send: () => {} }}
        />
      </MemoryRouter>,
    );
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  host?.remove();
});

const target = { id: 'p1', name: 'Daniel Okafor', href: '/people/p1' };
const intro = (name: string, warmth: number, warmthWord: string, hops: string[], personId?: string) => ({
  introducer: { name, headline: 'Software Engineer at Stripe', personId },
  warmth,
  warmthWord,
  hops,
  note: 'Worked together at Stripe',
});

const $ = (sel: string) => host.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];

describe('the routes card shows warm intros', () => {
  it('next to Orbit routes, with warmth in a word and the hops', async () => {
    const ui = {
      target,
      routes: [
        {
          band: 'possible',
          bandLabel: 'possible',
          score: 0.4,
          hops: [
            { from: 'you', to: 'Maya Chen', toId: 'p9', how: 'Worked together' },
            { from: 'Maya Chen', to: 'Daniel Okafor', toId: 'p1', how: 'Same team' },
          ],
        },
      ],
      warmIntros: [intro('Maya Chen', 0.74, 'warm', ['You', 'Maya Chen', 'Daniel Okafor'], 'p9')],
    };
    await render({
      kind: 'routes',
      data: { ui, forModel: {} },
      summary: '1 route to Daniel Okafor. One warm intro too, the best through Maya Chen (warm).',
      href: '/map?reach=p1',
    });
    const card = $('[data-testid="result-routes"]')!;
    expect(card.textContent).toMatch(/Routes to Daniel/);
    // the warm intro runs along the same chain as the route: one row carries both, not two lists saying it twice
    const rows = $$('[data-testid="warm-intro"]');
    expect(rows).toHaveLength(1);
    expect($('[data-testid="warm-intros"]')).toBeNull();
    const row = rows[0]!;
    expect(row.textContent).toContain('Maya Chen');
    expect(row.textContent).toContain('warm');
    expect(row.textContent).toContain('You → Maya Chen → Daniel Okafor');
    expect(row.textContent).toContain('Worked together at Stripe');
    // the introducer opens their profile; no raw warmth number is shown
    expect(row.querySelector('a')?.getAttribute('href')).toBe('/people/p9');
    expect(card.textContent).not.toMatch(/0\.74|74/);
    // the next step asks the first person on the best route for the intro
    expect($('[data-testid="next-step"]')?.textContent).toBe('Ask Maya for an intro');
  });

  it('on their own when Orbit has no route (Village found one)', async () => {
    await render({
      kind: 'routes',
      data: {
        ui: {
          target,
          routes: [],
          warmIntros: [
            intro('Lee Park', 0.75, 'warm', ['You', 'Lee Park', 'Daniel Okafor']),
            intro('Ana Ruiz', 0.3, 'a stretch', ['You', 'Ana Ruiz', 'Daniel Okafor']),
          ],
        },
        forModel: {},
      },
      summary:
        'No route to Daniel Okafor through people you know yet. 2 warm intros too, the best through Lee Park (warm).',
    });
    expect($('[data-testid="result-routes"]')).not.toBeNull();
    expect($('[data-testid="result-routes"]')!.textContent).toMatch(/No route to Daniel Okafor/);
    expect($$('[data-testid="warm-intro"]').map((r) => r.textContent)).toEqual([
      expect.stringContaining('Lee Parkwarm'),
      expect.stringContaining('Ana Ruiza stretch'),
    ]);
  });

  it('on the company card too', async () => {
    await render({
      kind: 'company',
      data: {
        ui: {
          company: 'Stripe',
          thereNow: [{ id: 'p9', name: 'Maya Chen', href: '/people/p9' }],
          former: [],
          warmIntros: [intro('Maya Chen', 0.5, 'good', ['You', 'Maya Chen', 'Priya Ahmed', 'Stripe'], 'p9')],
        },
        forModel: {},
      },
      summary: 'Stripe: 1 person there now. One warm intro too, the best through Maya Chen (good).',
    });
    expect($('[data-testid="result-company"] [data-testid="warm-intro"]')?.textContent).toContain(
      'You → Maya Chen → Priya Ahmed → Stripe',
    );
  });
});
