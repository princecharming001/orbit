import type { User } from '@orbit/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wipeDatabase } from '../../db/schema';
import type { FoundView } from '../../engine/linkedinSearch';
import { leaveFakeApi, signInToFakeApi } from '../../test/account';
import type { FakeOrbitApi } from '../../test/fakeOrbitApi';
import { ReachSearch } from './ReachSearch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The Map's search with an Orbit account: LinkedIn is linked on Orbit's server, not in the browser, and the box must
 * still search everyone on LinkedIn. It used to read only a browser-side link, so a signed-in student with LinkedIn
 * connected was told to connect LinkedIn and was never shown anyone outside their network.
 */
describe('the Map search with an Orbit account', () => {
  let api: FakeOrbitApi;
  let user: User;
  let host: HTMLDivElement;
  let root: Root;
  let picked: FoundView[];

  const settle = async (ms = 60) => {
    for (let i = 0; i < ms / 5; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
  };
  const show = async (query: string) => {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <ReachSearch
            user={user}
            query={query}
            onQuery={() => undefined}
            network={[]}
            byId={new Map()}
            onPick={() => undefined}
            onPickLinkedIn={(f) => picked.push(f)}
            onSubmit={() => undefined}
            autoFocus={false}
          />
        </MemoryRouter>,
      ),
    );
  };
  const text = () => host.textContent ?? '';

  beforeEach(async () => {
    await wipeDatabase();
    ({ api, user } = await signInToFakeApi());
    picked = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    act(() => root.unmount());
    host.remove();
    await leaveFakeApi();
  });

  it('with LinkedIn linked on the server: no "Connect LinkedIn", and a typed name finds people outside the network', async () => {
    api.state.linkedin = {
      status: 'active',
      relations: 120,
      found: [
        { memberId: 'm_far', name: 'Priya Raman', headline: 'Partner at Northwind Capital', distance: 3 },
        { memberId: 'm_out', name: 'Priya Desai', headline: 'Founder at Kiln' },
      ],
    };
    await show('');
    await settle();
    expect(text()).not.toContain('Connect LinkedIn');
    await show('Priya');
    // the search waits for a pause in typing
    await settle(900);
    const results = [...host.querySelectorAll('[data-testid="map-linkedin-result"]')];
    expect(results.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Priya Raman'),
      expect.stringContaining('Priya Desai'),
    ]);
    expect(results[0]!.textContent).toContain('3rd · Add');
    expect(api.state.linkedin.searches).toEqual(['priya']);
    // picking one hands it to the Map, which adds them to People
    await act(async () => {
      results[1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(picked.map((p) => p.name)).toEqual(['Priya Desai']);
  });

  it('with no LinkedIn linked anywhere: says to connect it', async () => {
    await show('');
    await settle();
    expect(text()).toContain('Connect LinkedIn to search everyone.');
  });

  it("says so when today's searches are used up, without telling a connected student to connect", async () => {
    api.state.linkedin = { status: 'active', relations: 120, searchReason: 'limit' };
    // (another name than the test above: one answer per name is kept for the session)
    await show('Marcus');
    await settle(900);
    expect(host.querySelector('[data-testid="map-linkedin-note"]')?.textContent).toBe(
      "That's today's LinkedIn searches. They come back tomorrow.",
    );
    expect(text()).not.toContain('Connect LinkedIn');
    expect(text()).not.toMatch(/[—–!]/);
  });
});
