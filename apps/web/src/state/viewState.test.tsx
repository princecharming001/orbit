/**
 * What a page was showing is still there when the student comes back to it (the back button, a tab inside Discover):
 * the page is unmounted while it is away, so the value lives outside it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetViews, keepScroll, readView, scrollOf, useViewState, writeView } from './viewState';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function Page({ user }: { user: string }) {
  const [q, setQ] = useViewState(`people:q:${user}`, '');
  const [n, setN] = useViewState(`people:limit:${user}`, () => 50);
  return (
    <div>
      <input data-testid="q" value={q} onChange={(e) => setQ(e.target.value)} />
      <button type="button" data-testid="more" onClick={() => setN((x) => x + 50)}>
        {n}
      </button>
    </div>
  );
}
const q = () => host.querySelector('[data-testid="q"]') as HTMLInputElement;
const more = () => host.querySelector('[data-testid="more"]') as HTMLButtonElement;
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(q(), value);
    q().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
/** Leaving a page unmounts it; coming back mounts a new one. */
async function leaveAndReturn(user = 'u1') {
  act(() => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<Page user={user} />));
}

describe('a page finds what it was showing', () => {
  it('what was typed and how far the list was opened are there after the page was away', async () => {
    await act(async () => root.render(<Page user="u1" />));
    expect(q().value).toBe('');
    expect(more().textContent).toBe('50');
    await type('investors');
    await act(async () => more().click());
    await leaveAndReturn();
    expect(q().value).toBe('investors');
    expect(more().textContent).toBe('100');
  });

  it('one person’s page is never shown to another', async () => {
    await act(async () => root.render(<Page user="u1" />));
    await type('investors');
    await leaveAndReturn('u2');
    expect(q().value).toBe('');
  });

  it('work that finishes while the page is away still lands, and the page shows it at once when it is there', async () => {
    writeView('people:q:u1', 'set while away', '');
    await act(async () => root.render(<Page user="u1" />));
    expect(q().value).toBe('set while away');
    await act(async () => writeView<string>('people:q:u1', (was) => `${was}, then updated`));
    expect(q().value).toBe('set while away, then updated');
    expect(readView('people:q:u1')).toBe('set while away, then updated');
  });

  it('forgetting by prefix clears that page only; the page falls back to its first value', async () => {
    await act(async () => root.render(<Page user="u1" />));
    await type('investors');
    await act(async () => more().click());
    await act(async () => forgetViews('people:q:'));
    await leaveAndReturn();
    expect(q().value).toBe('');
    expect(more().textContent).toBe('100');
    forgetViews();
    expect(readView('people:limit:u1')).toBeUndefined();
  });
});

describe('where a page was scrolled to', () => {
  it('is kept per history entry, and an entry never visited is the top', () => {
    keepScroll('entry-a', 840);
    keepScroll('entry-b', 12);
    keepScroll('entry-a', 900);
    expect(scrollOf('entry-a')).toBe(900);
    expect(scrollOf('entry-b')).toBe(12);
    expect(scrollOf('entry-never')).toBe(0);
  });

  it('keeps the most recent entries only', () => {
    for (let i = 0; i < 200; i++) keepScroll(`e${i}`, i + 1);
    expect(scrollOf('e199')).toBe(200);
    expect(scrollOf('e0')).toBe(0);
  });
});
