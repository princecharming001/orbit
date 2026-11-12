import type { Person, User } from '@orbit/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wipeDatabase } from '../../db/schema';
import type { MutualsResult } from '../../engine/linkedinLive';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let answer: MutualsResult;
vi.mock('../../engine/externalRoutes', () => ({ targetMutuals: async () => answer }));

const { ReachMutuals } = await import('./ReachMutuals');

/**
 * The Map's "People who know" list when LinkedIn's answer is not in yet because other students' accounts looked the
 * target up lately (the server's swarm limit): it says Orbit checks a little later, never that no one knows them.
 */
describe('People who know, when Orbit checks later', () => {
  let host: HTMLDivElement;
  let root: Root;
  const user = { id: 'u_reach', createdAt: '2026-11-01T00:00:00.000Z' } as unknown as User;
  const target = {
    id: 'p_target',
    userId: user.id,
    displayName: 'Omar Haddad',
    firstName: 'Omar',
    lastName: 'Haddad',
    linkedinMemberId: 'm_omar',
  } as unknown as Person;

  const settle = async () => {
    for (let i = 0; i < 12; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
  };
  const show = async () => {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <ReachMutuals user={user} target={target} onAsk={() => undefined} />
        </MemoryRouter>,
      ),
    );
    await settle();
  };

  beforeEach(async () => {
    await wipeDatabase();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('shows the later message, not "no one"', async () => {
    answer = {
      ok: false,
      reason: 'busy',
      message: 'Orbit will check who you both know a little later.',
      mutuals: [],
    };
    await show();
    const later = host.querySelector('[data-testid="reach-mutuals-later"]');
    expect(later?.textContent).toBe('Orbit will check who you both know a little later.');
    expect(host.querySelector('[data-testid="reach-mutuals-none"]')).toBeNull();
    expect(host.querySelector('[data-testid="reach-mutuals-retry"]')).toBeNull();
    expect(host.textContent).not.toMatch(/None of your LinkedIn connections/);
  });

  it('still says no one when LinkedIn did answer with no one', async () => {
    answer = { ok: true, source: 'linkedin', mutuals: [] };
    await show();
    expect(host.querySelector('[data-testid="reach-mutuals-none"]')?.textContent).toBe(
      'None of your LinkedIn connections is connected to Omar.',
    );
  });
});
