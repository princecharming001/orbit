import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TILES_FOLDED, TILES_STEP, TileSection } from './Discover';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
  document.body.innerHTML = '';
});

const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const tiles = () => document.body.querySelectorAll('[data-testid="tile"]').length;

async function mount(props: { count: number; hasMore?: boolean; onMore?: () => Promise<void> }) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  unmount = () => act(() => root.unmount());
  const render = (p: typeof props) =>
    act(async () =>
      root.render(
        <TileSection title="People" testId="grid" {...p}>
          {(limit) =>
            Array.from({ length: Math.min(limit, p.count) }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed test list
              <li key={i} data-testid="tile" />
            ))
          }
        </TileSection>,
      ),
    );
  await render(props);
  return render;
}

const tap = (id: string) => act(async () => q(id)!.click());

describe('a grid of suggestions always offers more, until there is nobody left', () => {
  it('folds to two rows, adds three rows a tap, and folds back', async () => {
    await mount({ count: 40, hasMore: false });
    expect(tiles()).toBe(TILES_FOLDED);
    await tap('grid-more');
    expect(tiles()).toBe(TILES_FOLDED + TILES_STEP);
    await tap('grid-more');
    expect(tiles()).toBe(40);
    expect(q('grid-more')).toBeNull();
    expect(q('grid-end')!.textContent).toBe('That is everyone');
    await tap('grid-fewer');
    expect(tiles()).toBe(TILES_FOLDED);
  });

  it('asks the server for the next batch when what is loaded runs out, and the count says there is more', async () => {
    let count = 24;
    const onMore = vi.fn(async () => {
      count = 48;
    });
    const render = await mount({ count, hasMore: true, onMore });
    expect(q('grid-count')!.textContent).toBe('24+');
    await tap('grid-more'); // 25 wanted, 24 loaded: the server is asked
    expect(onMore).toHaveBeenCalledTimes(1);
    await render({ count, hasMore: false, onMore });
    expect(tiles()).toBe(25);
    expect(q('grid-count')!.textContent).toBe('48');
  });

  it('a server that does not page yet: everything loaded can be shown, and the list never claims to be complete', async () => {
    await mount({ count: 24 });
    await tap('grid-more');
    expect(tiles()).toBe(24);
    expect(q('grid-more')).toBeNull();
    expect(q('grid-end')).toBeNull();
    expect(q('grid-fewer')).not.toBeNull();
    expect(q('grid-count')!.textContent).toBe('24');
  });

  it('ten or fewer need no control at all', async () => {
    await mount({ count: 7, hasMore: false });
    expect(tiles()).toBe(7);
    expect(q('grid-pager')).toBeNull();
  });
});
