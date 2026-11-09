/**
 * Find People looks up an address only when the student asks (plan 35 C3): a sourced person without one shows
 * "Find email", the lookup fills it in, and a miss says so instead of leaving the button.
 */
import type { SourcedCandidate } from '@orbit/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sourcing = vi.hoisted(() => ({
  searchPeople: vi.fn(),
  findEmail: vi.fn(),
  addSourced: vi.fn(),
}));
vi.mock('../../engine/sourcing', async (orig) => ({
  ...(await orig<typeof import('../../engine/sourcing')>()),
  ...sourcing,
}));
vi.mock('../../engine/goals', async (orig) => ({
  ...(await orig<typeof import('../../engine/goals')>()),
  activeGoals: async () => [],
}));

import { FindPeople } from './FindPeople';

const candidate = (over: Partial<SourcedCandidate>): SourcedCandidate =>
  ({
    id: 'r1',
    name: 'Maya Chen',
    title: 'Partner',
    org: 'Seed Fund',
    reasons: ['Backs pre-seed software'],
    emailStatus: 'not looked up',
    ...over,
  }) as SourcedCandidate;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

async function searchWith(results: SourcedCandidate[]) {
  sourcing.searchPeople.mockResolvedValue({
    ok: true,
    value: { batchId: 'b', results, unconfigured: [], relaxed: [] },
  });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <FindPeople userId="u1" />
      </MemoryRouter>,
    );
  });
  const input = host.querySelector('input') as HTMLInputElement;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, 'seed investors');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    (host.querySelector('[data-testid="find-search"]') as HTMLButtonElement).click();
  });
}

describe('Find People, email on demand', () => {
  it('a person without an address offers the lookup, and the found address replaces it', async () => {
    sourcing.findEmail.mockResolvedValue({
      ok: true,
      value: { email: 'maya@seedfund.vc', emailConfidence: 'verified', emailStatus: 'found' },
    });
    await searchWith([candidate({})]);
    const lookup = host.querySelector('[data-testid="find-email-lookup"]') as HTMLButtonElement;
    expect(lookup?.textContent).toBe('Find email');
    expect(sourcing.findEmail).not.toHaveBeenCalled();
    await act(async () => lookup.click());
    expect(sourcing.findEmail).toHaveBeenCalledWith({ id: 'u1' }, 'r1');
    expect(host.querySelector('[data-testid="find-email-lookup"]')).toBeNull();
    expect(host.querySelector('[data-testid="find-email"]')?.textContent).toContain('maya@seedfund.vc');
  });

  it('a miss says no email was found', async () => {
    sourcing.findEmail.mockResolvedValue({ ok: true, value: { emailStatus: 'not found' } });
    await searchWith([candidate({})]);
    await act(async () =>
      (host.querySelector('[data-testid="find-email-lookup"]') as HTMLButtonElement).click(),
    );
    expect(host.querySelector('[data-testid="find-email-none"]')?.textContent).toBe('No email found');
  });

  it('a person who already has an address shows no lookup', async () => {
    await searchWith([
      candidate({ email: 'maya@seedfund.vc', emailConfidence: 'page', emailStatus: undefined }),
    ]);
    expect(host.querySelector('[data-testid="find-email-lookup"]')).toBeNull();
  });
});
