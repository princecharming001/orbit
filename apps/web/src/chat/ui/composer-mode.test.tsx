/**
 * The composer's mode menu (plan 37 §5.1): Auto, Smart and Quick, Auto first and the default for a student who never
 * picked; once Auto has answered, its row says which it picked for the last reply, and nothing else does.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Composer } from './Composer';
import { getChatMode, setLastAutoChoice } from './prefs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => localStorage.removeItem('orbit:chatMode'));
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  host?.remove();
});

async function render() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <Composer onSend={() => {}} onStop={() => {}} onAttach={() => {}} running={false} mode="llm" />
      </MemoryRouter>,
    );
  });
}
const $ = (sel: string) => host.querySelector<HTMLElement>(sel);
const items = () => [...host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];

describe('the mode menu', () => {
  it('starts on Auto and lists Auto, Smart and Quick in that order', async () => {
    expect(getChatMode()).toBe('auto');
    await render();
    expect($('[data-testid="composer-mode"]')!.textContent).toMatch(/^Auto/);
    await act(async () => $('[data-testid="composer-mode"]')!.click());
    expect(items().map((i) => i.querySelector('div')!.textContent)).toEqual(['Auto', 'Smart', 'Quick']);
    expect(items()[0]!.getAttribute('aria-checked')).toBe('true');
    expect($('[data-testid="mode-last-auto"]')).toBeNull();
  });

  it('says what Auto picked for the last reply, under Auto only', async () => {
    await render();
    act(() => setLastAutoChoice('low'));
    await act(async () => $('[data-testid="composer-mode"]')!.click());
    expect($('[data-testid="mode-last-auto"]')!.textContent).toBe('Last reply: Quick');
    act(() => setLastAutoChoice('medium'));
    expect($('[data-testid="mode-last-auto"]')!.textContent).toBe('Last reply: Smart');
  });

  it('a pick is kept, and Smart or Quick stays the student’s choice', async () => {
    await render();
    await act(async () => $('[data-testid="composer-mode"]')!.click());
    await act(async () => items()[2]!.click());
    expect(getChatMode()).toBe('quick');
    expect($('[data-testid="composer-mode"]')!.textContent).toMatch(/^Quick/);
    localStorage.setItem('orbit:chatMode', 'smart');
    expect(getChatMode()).toBe('smart');
  });
});
