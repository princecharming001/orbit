/**
 * Plan 43 in Settings and on people, against the fake orbit-api: the owner's Launch section (owner only, readiness in
 * words, a question before a source is taken away, a source the server lists is locked on), the Instagram row through
 * its states (the risk note first, reading step by step, Off, Remove, the different-account question, the friends'
 * switch), the X row (nothing until the student agrees to what Orbit stores, the spend), the "same person" question
 * (Yes, No, and picking which person stays), "Not their account", and an X check that shows its price first.
 */
import type { User } from '@orbit/core';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setSocialPollForTests } from '../engine/social';
import { loadSources, setExtraSourcesForTests } from '../engine/sources';
import { LaunchSection, readinessWords } from '../pages/settings/Launch';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import type { FakeOrbitApi } from '../test/fakeOrbitApi';
import { ToastProvider } from '../ui';
import { PersonSocialCard, SocialAskCard, SocialCheckButton } from './SocialPeople';
import { InstagramRow, XRow } from './SocialRows';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settle = async (n = 15) => {
  for (let i = 0; i < n; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};

let api: FakeOrbitApi;
let user: User;
let unmount: (() => void) | undefined;

async function mount(node: ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ToastProvider>{node}</ToastProvider>
      </MemoryRouter>,
    ),
  );
  unmount = () => {
    act(() => root.unmount());
    host.remove();
  };
  await settle();
}
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (id: string) => (q(id)?.textContent ?? '').trim();
const click = async (id: string) => {
  await act(async () => q(id)!.click());
  await settle(30);
};
const bodies = (route: string) => api.calls.filter((c) => c.route === route).map((c) => c.body);

/** Offer sources on the fake server and read them again, as a student's next visit would. */
async function offer(...sources: ('instagram' | 'x' | 'imessage')[]) {
  api.state.sources.offered = sources;
  await loadSources(user.id);
}

beforeEach(async () => {
  await wipeDatabase();
  setExtraSourcesForTests(undefined);
  setSocialPollForTests({ everyMs: 5, tries: 40 });
  ({ api, user } = await signInToFakeApi());
});
afterEach(async () => {
  unmount?.();
  unmount = undefined;
  await leaveFakeApi();
});
afterAll(() => setSocialPollForTests(undefined));

describe('the Launch section', () => {
  it('shows nothing to anyone but the owner', async () => {
    await mount(<LaunchSection />);
    expect(q('settings-launch')).toBeNull();
    expect(bodies('/admin/sources')).toHaveLength(1);
  });

  it('lists each source with its readiness in words and how many have it on, and asks before taking one away', async () => {
    api.state.isOwner = true;
    api.state.sources.offered = ['imessage'];
    await mount(<LaunchSection />);
    expect(text('launch-instagram-ready')).toBe('Ready');
    expect(text('launch-x-ready')).toBe(
      'Needs the X app client ID (ORBIT_X_CLIENT_ID) and a monthly X spending limit above 0 dollars (ORBIT_X_MONTHLY_USD)',
    );
    expect(text('launch-imessage-students')).toBe('3 students have it on · 5 connected');
    // X is not ready: it cannot be offered
    expect((q('launch-x-switch') as HTMLButtonElement).disabled).toBe(true);
    // Instagram is ready: one switch offers it, and students read it from GET /sources with nothing rebuilt
    await click('launch-instagram-switch');
    expect(bodies('/admin/sources/instagram')).toEqual([{ offered: true }]);
    expect(api.state.sources.offered).toContain('instagram');
    expect(q('launch-instagram-switch')?.getAttribute('aria-checked')).toBe('true');
    // taking Texts away asks first, and says what happens to what students took
    await click('launch-imessage-switch');
    expect(bodies('/admin/sources/imessage')).toEqual([]);
    expect(document.querySelector('[data-testid="launch-confirm"]')?.textContent).toMatch(
      /Students who connected it keep what Orbit took, and it stops being read/,
    );
    await act(async () =>
      document.querySelector<HTMLElement>('[data-testid="launch-confirm-take"]')!.click(),
    );
    await settle(30);
    expect(bodies('/admin/sources/imessage')).toEqual([{ offered: false }]);
    expect(api.state.sources.offered).not.toContain('imessage');
  });

  it('locks a source the server lists on, and says why', async () => {
    api.state.isOwner = true;
    api.state.admin[0]!.env = true;
    await mount(<LaunchSection />);
    expect(q('launch-instagram-switch')?.getAttribute('aria-checked')).toBe('true');
    expect((q('launch-instagram-switch') as HTMLButtonElement).disabled).toBe(true);
    expect(text('launch-instagram-students')).toMatch(/Set on the server/);
  });

  it('says readiness in plain words', () => {
    expect(readinessWords({ ready: true, missing: [] })).toBe('Ready');
    expect(readinessWords({ ready: false, missing: ['The X app client ID'] })).toBe(
      'Needs the X app client ID',
    );
  });
});

describe('the Instagram row', () => {
  it('is not there while Instagram is not offered', async () => {
    await mount(<InstagramRow user={user} />);
    expect(q('settings-instagram')).toBeNull();
  });

  it('says the risk before connecting, reads step by step, and goes Off and Removed', async () => {
    await offer('instagram');
    const opened: string[] = [];
    vi.spyOn(window, 'open').mockImplementation(((url: string) => {
      opened.push(url);
      return { closed: false, close() {} } as unknown as Window;
    }) as typeof window.open);
    await mount(<InstagramRow user={user} />);
    expect(text('settings-instagram-status')).toBe('Not connected');
    await click('settings-instagram-switch');
    expect(text('instagram-risk')).toMatch(/Instagram does not allow automation/);
    expect(text('instagram-risk')).toMatch(/never sends a message without your tap/);
    // Unipile's hosted sign-in opens; the server finishes the link and turns the source on
    const connecting = act(async () => q('instagram-connect')!.click());
    await settle(5);
    api.state.instagram.status = 'active';
    api.state.instagram.username = 'sam.lee';
    api.state.instagram.steps = {
      profile: 'done',
      chats: 'done',
      following: 'reading',
      followers: 'waiting',
    };
    api.state.sources.states.instagram = 'on';
    await connecting;
    await settle(40);
    expect(opened).toEqual([api.state.instagram.url]);
    expect(text('settings-instagram-status')).toBe('On · @sam.lee · Reading who you follow');
    // the friends' switch is off until the student turns it on
    expect(q('settings-instagram-share-switch')?.getAttribute('aria-checked')).toBe('false');
    await click('settings-instagram-share-switch');
    expect(bodies('/sources/instagram').at(-1)).toEqual({ state: 'on', shareFollows: true });
    // Off: kept, left out
    await click('settings-instagram-switch');
    expect(text('settings-instagram-status')).toBe('Off · kept, left out of closeness and paths');
    expect(api.state.sources.states.instagram).toBe('off');
    // Removed, after a question
    await click('settings-instagram-remove');
    expect(document.querySelector('[data-testid="settings-instagram-confirm"]')).not.toBeNull();
    await act(async () =>
      document.querySelector<HTMLElement>('[data-testid="settings-instagram-confirm-remove"]')!.click(),
    );
    await settle(30);
    expect(api.state.sources.states.instagram).toBe('removed');
    expect(text('settings-instagram-status')).toBe('Removed · nothing from Instagram is kept');
    vi.restoreAllMocks();
  });

  it('asks before a different account replaces the old one', async () => {
    await offer('instagram');
    api.state.sources.states.instagram = 'on';
    await loadSources(user.id);
    api.state.instagram.status = 'different_account';
    api.state.instagram.pending = 'sam.second';
    await mount(<InstagramRow user={user} />);
    expect(text('settings-instagram-different')).toMatch(
      /This is a different Instagram account. Replace the old one, or keep it\?/,
    );
    await click('settings-instagram-replace');
    expect(bodies('/instagram/connect/start')).toEqual([{ replace: true }]);
    expect(text('settings-instagram-status')).toMatch(/^On · @sam.second/);
  });

  it('can keep the old account when a different one signed in', async () => {
    await offer('instagram');
    api.state.sources.states.instagram = 'on';
    await loadSources(user.id);
    api.state.instagram.status = 'different_account';
    api.state.instagram.username = 'sam.lee';
    api.state.instagram.pending = 'sam.second';
    await mount(<InstagramRow user={user} />);
    await click('settings-instagram-keep');
    expect(bodies('/instagram/connect/keep')).toEqual([{}]);
    expect(bodies('/instagram/connect/start')).toEqual([]);
    expect(text('settings-instagram-status')).toMatch(/^On · @sam.lee/);
  });

  it('asks to sign in again when Instagram wants it', async () => {
    await offer('instagram');
    api.state.sources.states.instagram = 'on';
    await loadSources(user.id);
    api.state.instagram.status = 'needs_reauth';
    api.state.instagram.username = 'sam.lee';
    await mount(<InstagramRow user={user} />);
    expect(text('settings-instagram-status')).toMatch(/Sign in again/);
    expect(q('settings-instagram-reauth')).not.toBeNull();
  });
});

describe('the X row', () => {
  it('needs the consent before the sign-in, then shows the spend', async () => {
    await offer('x');
    await mount(<XRow user={user} />);
    expect(text('settings-x-status')).toBe('Not connected');
    await click('settings-x-switch');
    expect(text('x-consent-lines')).toMatch(/Who you follow on X, and who follows you back/);
    expect(text('x-consent-lines')).toMatch(/Your last 30 days of X messages/);
    expect(text('x-consent-lines')).toMatch(/Nothing you post/);
    // nothing until the student agrees
    expect((q('x-connect') as HTMLButtonElement).disabled).toBe(true);
    expect(bodies('/x/connect/start')).toEqual([]);
    await act(async () => q('x-consent-agree')!.click());
    await settle();
    expect((q('x-connect') as HTMLButtonElement).disabled).toBe(false);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await click('x-connect');
    errors.mockRestore();
    expect(bodies('/x/connect/start')).toEqual([{ consent: true }]);
    unmount!();
    // back from X: on, with this month's spend and the limit; no friends' switch
    api.state.x.status = 'active';
    api.state.x.username = 'samlee';
    api.state.x.spentThisMonthUsd = 4;
    api.state.sources.states.x = 'on';
    await loadSources(user.id);
    await mount(<XRow user={user} />);
    expect(text('settings-x-status')).toBe('On · @samlee · $4 of $15 this month');
    expect(q('settings-instagram-share-switch')).toBeNull();
  });
});

describe('people', () => {
  const person = {
    id: 'a3f1c2d4-1111-4222-8333-944455556666',
    firstName: 'Jason',
    lastName: 'Chen',
    displayName: 'Jason Chen',
    currentOrganizationRaw: 'Stripe',
  };
  beforeEach(async () => {
    await db.people.put({
      ...person,
      userId: user.id,
      nameNormalized: 'jason chen',
      emails: [],
      relationshipType: 'unknown',
      strength: 0.4,
      interactionCount: 3,
      sources: ['gmail'],
      isHuman: true,
      tags: [],
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    });
  });

  async function ask() {
    const row = {
      id: 'b1b2b3b4-0000-4000-8000-000000000001',
      platform: 'instagram' as const,
      accountId: '1789',
      username: 'jchen_22',
      name: 'Jason Chen',
      personId: person.id,
      personName: 'Jason Chen',
      score: 0.8,
      signals: { for: ['The same name', 'The bio names Stripe'], against: ['A second account he lists'] },
    };
    api.state.socialAsks = [row];
    await db.socialAsks.put({ ...row, userId: user.id, status: 'open', createdAt: '', updatedAt: '' });
    return row;
  }

  it('asks "is this the same person" with the evidence both ways, and Yes attaches it', async () => {
    await offer('instagram');
    const a = await ask();
    await mount(<SocialAskCard user={user} ask={(await db.socialAsks.get(a.id))!} />);
    expect(text('social-ask-question')).toBe(
      'Is @jchen_22 on Instagram the Jason Chen you know from Stripe?',
    );
    expect(text('social-ask-for')).toBe('The same name. The bio names Stripe.');
    expect(text('social-ask-against')).toBe('A second account he lists.');
    await click('social-ask-yes');
    expect(bodies(`/social/asks/${a.id}`)).toEqual([{ answer: 'yes' }]);
    expect(api.state.socialLinks.map((l) => l.personId)).toEqual([person.id]);
  });

  it('shows both people when each has things of its own, and says this one cannot be undone', async () => {
    await offer('instagram');
    const a = await ask();
    api.state.pickPerson = [
      { id: person.id, name: 'Jason Chen' },
      { id: 'c0c0c0c0-0000-4000-8000-000000000009', name: 'jchen_22' },
    ];
    await mount(<SocialAskCard user={user} ask={(await db.socialAsks.get(a.id))!} />);
    await click('social-ask-yes');
    const pick = document.querySelector('[data-testid="social-pick"]');
    expect(pick?.textContent).toMatch(/Jason Chen/);
    expect(pick?.textContent).toMatch(/jchen_22/);
    expect(pick?.textContent).toMatch(/This one cannot be undone/);
    await act(async () => document.querySelector<HTMLElement>('[data-testid="social-pick-keep"]')!.click());
    await settle(30);
    expect(bodies('/social/links').at(-1)).toMatchObject({ accountId: '1789', keep: person.id });
  });

  it('"Not their account" asks first, then takes the account off', async () => {
    await offer('instagram');
    api.state.sources.states.instagram = 'on';
    await loadSources(user.id);
    const id = 'd1d1d1d1-0000-4000-8000-000000000002';
    api.state.socialLinks = [{ id, platform: 'instagram', accountId: '42', personId: person.id }];
    await db.socialLinks.put({
      id,
      userId: user.id,
      platform: 'instagram',
      accountId: '42',
      personId: person.id,
      username: 'jason.photo',
      via: 'score',
      createdAt: '',
      updatedAt: '',
    });
    const p = (await db.people.get(person.id))!;
    await mount(<PersonSocialCard user={user} person={p} />);
    expect(text('person-social-link')).toMatch(/@jason.photo/);
    await click('person-social-detach');
    expect(api.calls.some((c) => c.route.startsWith('/social/links/'))).toBe(false);
    expect(document.querySelector('[data-testid="person-social-detach-confirm"]')?.textContent).toMatch(
      /takes the account off Jason/,
    );
    await act(async () =>
      document.querySelector<HTMLElement>('[data-testid="person-social-detach-yes"]')!.click(),
    );
    await settle(30);
    expect(api.state.socialLinks).toEqual([]);
    expect(await db.socialLinks.get(id)).toBeUndefined();
  });

  it('an X check shows the price first and reads nothing until Go ahead', async () => {
    await offer('x');
    api.state.sources.states.x = 'on';
    await loadSources(user.id);
    api.state.socialLinks = [{ id: 'l1', platform: 'x', accountId: '99', personId: person.id }];
    await db.socialLinks.put({
      id: 'l1',
      userId: user.id,
      platform: 'x',
      accountId: '99',
      personId: person.id,
      username: 'jasonchen',
      via: 'proof',
      createdAt: '',
      updatedAt: '',
    });
    await mount(<SocialCheckButton user={user} person={person} platform="x" />);
    expect(text('check-x')).toBe('Check X for Jason');
    await click('check-x');
    expect(document.querySelector('[data-testid="x-quote-line"]')?.textContent).toBe(
      'This reads about 400 people on X and costs about $4. Go ahead?',
    );
    expect(bodies('/social/lookups')).toEqual([{ platform: 'x', personId: person.id }]);
    expect(api.state.lookups.size).toBe(0);
    await act(async () => document.querySelector<HTMLElement>('[data-testid="x-quote-go"]')!.click());
    await settle(30);
    expect(bodies('/social/lookups').at(-1)).toEqual({
      platform: 'x',
      personId: person.id,
      confirm: true,
      quoteUsd: 4,
    });
    expect(api.state.lookups.size).toBe(1);
  });
});
