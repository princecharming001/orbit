import { act, Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { setCurrentUserId } from '../db/repo';
import { db } from '../db/schema';
import { createLocalUser } from '../engine/account';
import { SessionProvider } from '../state/session';
import { Landing } from './Landing';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Renders the landing page and records what the header actions show after every commit. */
async function headerStates(): Promise<string[]> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const seen: string[] = [];
  const record = () => {
    const el = host.querySelector('[data-testid="landing-actions"]');
    const text = el ? Array.from(el.querySelectorAll('button'), (b) => b.textContent ?? '').join(',') : '';
    if (seen[seen.length - 1] !== text) seen.push(text);
  };
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <Profiler id="landing" onRender={record}>
        <MemoryRouter>
          <SessionProvider>
            <Landing />
          </SessionProvider>
        </MemoryRouter>
      </Profiler>,
    );
  });
  // let every live query settle
  for (let i = 0; i < 20; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
  record();
  act(() => root.unmount());
  host.remove();
  return seen;
}

describe('Landing header for a returning user (L26)', () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });

  it('never shows the first-visit buttons to someone with a finished profile', async () => {
    const u = await createLocalUser({
      fullName: 'Real Person',
      onboardingCompletedAt: new Date().toISOString(),
    });
    await setCurrentUserId(u.id);
    const seen = await headerStates();
    expect(seen.at(-1)).toBe('Open Orbit');
    for (const s of seen) expect(s).not.toMatch(/Try the demo|Get started/);
  });

  it('never shows the first-visit buttons to someone mid-setup', async () => {
    const u = await createLocalUser({ fullName: 'Real Person', onboardingStep: 3 });
    await setCurrentUserId(u.id);
    const seen = await headerStates();
    expect(seen.at(-1)).toBe('Continue setup');
    for (const s of seen) expect(s).not.toMatch(/Try the demo|Get started/);
  });

  it('shows the first-visit buttons when there is no profile', async () => {
    const seen = await headerStates();
    expect(seen.at(-1)).toBe('Try the demo,Get started');
  });
});
