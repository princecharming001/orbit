import type { User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { mockLinkedInSearchPage, setConnectorsMockForTests } from '../integrations/connectorsMock';
import { setUnipileUrlForTests } from '../integrations/unipile';
import {
  actOnFound,
  DISCOVER_SEARCHES_PER_DAY,
  discoverView,
  dismissFound,
  type LoadMoreOutcome,
  loadMoreDiscover,
  readFeedState,
  restoreFound,
} from './discoverFeed';
import { addPersonByHand } from './people';

const BASE = 'https://proxy.test/functions/v1/orbit-connectors';
const NOW = new Date('2026-10-06T15:00:00.000Z');
const user: User = {
  id: 'u1',
  email: 'ravi.jain@umich.edu',
  fullName: 'Ravi Jain',
  firstName: 'Ravi',
  lastName: 'Jain',
  school: 'University of Michigan',
  majors: ['Computer Science'],
  timezone: 'America/Detroit',
  onboardingStep: 11,
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** A LinkedIn of 30 people: a third at Stripe, the rest elsewhere; five a page, cursor = the next offset. */
const POOL = Array.from({ length: 30 }, (_, i) => {
  const company = i % 3 === 0 ? 'Stripe' : i % 3 === 1 ? 'Figma' : 'Acme';
  const title = ['Software Engineer', 'Product Manager', 'Senior Software Engineer', 'Engineering Manager'][
    i % 4
  ]!;
  return {
    id: `m${i}`,
    name: `Person ${String.fromCharCode(65 + (i % 26))}${i}`,
    headline: `${title} at ${company}`,
    location: i % 2 ? 'New York' : 'Seattle',
    public_profile_url: `https://www.linkedin.com/in/person-${i}`,
    network_distance: i % 4 === 3 ? 'DISTANCE_3' : 'DISTANCE_2',
    company,
    title,
  };
});

let calls: Record<string, unknown>[];
let searchAnswer: (body: Record<string, unknown>) => { status?: number; body: unknown };

/** What the proxy's /search answers (connectors.ts): filtered by company, five a page. */
function fakeSearch(body: Record<string, unknown>) {
  const rows = POOL.filter((p) => !body.company || p.company === body.company);
  const from = Number(String(body.cursor ?? '0').replace('c', '')) || 0;
  const page = rows.slice(from, from + 5);
  return {
    body: {
      ok: true,
      people: page.map((p) => ({
        memberId: p.id,
        name: p.name,
        headline: p.headline,
        location: p.location,
        profileUrl: p.public_profile_url,
        distance: p.network_distance === 'DISTANCE_3' ? 3 : 2,
        mutualCount: p.network_distance === 'DISTANCE_3' ? undefined : Number(p.id.slice(1)) % 7,
      })),
      cursor: from + 5 < rows.length ? `c${from + 5}` : null,
      total: rows.length,
    },
  };
}

beforeEach(async () => {
  await wipeDatabase();
  await db.users.put(user);
  await db.goals.put({
    userId: user.id,
    cycleLabel: 'Summer 2027',
    targetRoles: ['Software Engineering Intern'],
    targetFunctions: ['swe'],
    targetIndustries: [],
    targetLocations: ['New York'],
    ambition: 2,
  });
  await db.targetCompanies.put({
    id: 'tc1',
    userId: user.id,
    nameRaw: 'Stripe',
    priority: 1,
    status: 'researching',
  } as never);
  await db.integrations.put({
    id: 'int_li',
    userId: user.id,
    provider: 'linkedin_live',
    externalAccountId: 'acc_1',
    accessToken: 'tok',
    status: 'active',
    scopes: [],
    syncState: {},
    connectedAt: NOW.toISOString(),
  } as never);
  setUnipileUrlForTests(BASE);
  setConnectorsMockForTests(false);
  calls = [];
  searchAnswer = fakeSearch;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = url.replace(BASE, '');
    const body = JSON.parse((init.body as string) || '{}') as Record<string, unknown>;
    if (path !== '/search') return new Response('{}', { status: 404 });
    calls.push(body);
    const a = searchAnswer(body);
    return new Response(JSON.stringify(a.body), {
      status: a.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setUnipileUrlForTests(undefined);
  setConnectorsMockForTests(undefined);
});

describe('the Discover feed of new people', () => {
  it('searches with filters from the goals, pages with the cursor, and never repeats anyone', async () => {
    const r = await loadMoreDiscover(user, { now: NOW });
    expect(r).toMatchObject({ status: 'ok' });
    // filters, not just keywords: a target company, the school, a target role
    expect(calls[0]).toMatchObject({ accountId: 'acc_1', token: 'tok', distance: [2, 3] });
    expect(calls.some((c) => c.company === 'Stripe')).toBe(true);
    expect(calls.some((c) => c.school === 'University of Michigan')).toBe(true);
    expect(calls.some((c) => c.title === 'Software Engineer')).toBe(true);
    expect(calls.every((c) => c.cursor === undefined)).toBe(true);
    let s = await readFeedState(user.id, NOW);
    const ids = s.people.map((p) => p.memberId);
    expect(new Set(ids).size).toBe(ids.length);
    // the next load continues a search from its saved cursor
    calls = [];
    await loadMoreDiscover(user, { now: NOW });
    expect(calls.some((c) => typeof c.cursor === 'string' && /^c\d+$/.test(c.cursor as string))).toBe(true);
    s = await readFeedState(user.id, NOW);
    const all = s.people.map((p) => p.memberId);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThan(ids.length);
    // the search filtered on the student's school is evidence they went there
    const viaSchool = s.people.filter((p) => p.schoolEvidence);
    expect(viaSchool.length).toBeGreaterThan(0);
  });

  it('leaves out everyone already in Orbit: by member id, by profile link, and by name and company', async () => {
    const a = await addPersonByHand(user.id, { name: 'Someone Known', company: 'Stripe' }, user.school);
    await db.people.update(a!.person.id, { linkedinMemberId: 'm0' });
    await addPersonByHand(
      user.id,
      { name: 'Other Name', linkedinUrl: 'https://www.linkedin.com/in/person-3' },
      user.school,
    );
    await addPersonByHand(user.id, { name: POOL[6]!.name, company: 'Stripe' }, user.school);
    for (let i = 0; i < 4; i++) await loadMoreDiscover(user, { now: NOW });
    const v = await discoverView(user, NOW);
    const shown = v.found.map((c) => c.entry.memberId);
    expect(shown.length).toBeGreaterThan(5);
    expect(shown).not.toContain('m0');
    expect(shown).not.toContain('m3');
    expect(shown).not.toContain('m6');
  });

  it('stops at the day’s search limit and says more tomorrow, keeping the cursors for the next day', async () => {
    searchAnswer = (b) =>
      calls.length > 2
        ? {
            body: {
              ok: false,
              reason: 'limit',
              message: 'You have run as many LinkedIn searches as Orbit allows today.',
            },
          }
        : fakeSearch(b);
    const first = await loadMoreDiscover(user, { now: NOW });
    expect(first).toMatchObject({ status: 'ok' });
    const second = await loadMoreDiscover(user, { now: NOW });
    expect(second).toMatchObject({ status: 'limit' });
    const n = calls.length;
    // no more searches today once the proxy said so
    expect(await loadMoreDiscover(user, { now: NOW })).toMatchObject({ status: 'limit' });
    expect(calls.length).toBe(n);
    expect((await discoverView(user, NOW)).limitToday).toBe(true);
    // tomorrow it starts again, from the saved cursors
    searchAnswer = fakeSearch;
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    calls = [];
    expect(await loadMoreDiscover(user, { now: tomorrow })).toMatchObject({ status: 'ok' });
    expect((await readFeedState(user.id, tomorrow)).searches).toBe(calls.length);
  });

  it('uses at most its share of the day’s searches, then waits for tomorrow', async () => {
    let last: LoadMoreOutcome | undefined;
    for (let i = 0; i < 10; i++) last = await loadMoreDiscover(user, { now: NOW });
    expect(calls.length).toBeLessThanOrEqual(DISCOVER_SEARCHES_PER_DAY);
    expect(['budget', 'exhausted']).toContain(last!.status);
    const v = await discoverView(user, NOW);
    expect(v.searchesLeft === 0 || v.exhausted).toBe(true);
  });

  it('keeps its pages in this browser, scores them with spread, and asks LinkedIn nothing to show them again', async () => {
    await loadMoreDiscover(user, { now: NOW });
    calls = [];
    const v = await discoverView(user, NOW);
    expect(calls).toHaveLength(0);
    expect(v.found.length).toBeGreaterThan(4);
    expect(v.connected).toBe(true);
    const fits = v.found.map((c) => Math.round(c.scored.fit * 100));
    expect(new Set(fits).size).toBeGreaterThan(2);
    // best first, and a Stripe software engineer (a target company, a target role) near the top
    expect(v.found[0]!.scored.score).toBeGreaterThanOrEqual(v.found[v.found.length - 1]!.scored.score);
    expect(v.found.slice(0, 4).some((c) => c.entry.company === 'Stripe')).toBe(true);
    for (const c of v.found) expect(c.reason.text.length).toBeGreaterThan(3);
  });

  it('a dismissal made while more people are loading stays dismissed', async () => {
    await loadMoreDiscover(user, { now: NOW });
    const first = (await discoverView(user, NOW)).found[0]!;
    // the next search hangs until the dismissal is saved
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const answer = searchAnswer;
    searchAnswer = (b) => answer(b);
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const path = url.replace(BASE, '');
      if (path !== '/search') return new Response('{}', { status: 404 });
      await gate;
      const a = answer(JSON.parse((init.body as string) || '{}'));
      return new Response(JSON.stringify(a.body), {
        status: a.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const loading = loadMoreDiscover(user, { now: NOW });
    expect(await dismissFound(user.id, first.entry.memberId, 'wrong_role', NOW)).toBe(true);
    release();
    await loading;
    const v = await discoverView(user, NOW);
    expect(v.found.some((c) => c.entry.memberId === first.entry.memberId)).toBe(false);
  });

  it('adds a person only when the student acts, and a dismissal removes the card and teaches the next pages', async () => {
    await loadMoreDiscover(user, { now: NOW });
    const before = await discoverView(user, NOW);
    expect(await db.people.count()).toBe(0);
    const pick = before.found[0]!;
    const r = await actOnFound(user, pick.entry.memberId, 'save', NOW);
    expect(r.ok).toBe(true);
    const added = (await db.people.toArray())[0]!;
    expect(added).toMatchObject({ displayName: pick.entry.name, linkedinMemberId: pick.entry.memberId });
    expect((await db.chats.where('personId').equals(added.id).first())?.stage).toBe('identified');
    const after = await discoverView(user, NOW);
    expect(after.found.some((c) => c.entry.memberId === pick.entry.memberId)).toBe(false);

    const stripe = after.found.find((c) => c.entry.company === 'Stripe')!;
    const fitBefore = stripe.scored.fit;
    await dismissFound(user.id, stripe.entry.memberId, 'wrong_company', NOW);
    const v = await discoverView(user, NOW);
    expect(v.found.some((c) => c.entry.memberId === stripe.entry.memberId)).toBe(false);
    const otherStripe = v.found.find((c) => c.entry.company === 'Stripe');
    if (otherStripe) expect(otherStripe.scored.fit).toBeLessThan(fitBefore);
    // the next searches leave Stripe out
    calls = [];
    await loadMoreDiscover(user, { now: NOW });
    expect(calls.some((c) => c.company === 'Stripe')).toBe(false);
    // undo brings the card back
    await restoreFound(user.id, stripe.entry.memberId);
    expect(
      (await discoverView(user, NOW)).found.some((c) => c.entry.memberId === stripe.entry.memberId),
    ).toBe(true);
  });

  it('a warm-up from a new person opens their chat as a warm-up; writing opens a first message', async () => {
    await loadMoreDiscover(user, { now: NOW });
    const v = await discoverView(user, NOW);
    const [a, b] = v.found;
    const w = await actOnFound(user, a!.entry.memberId, 'warm_up', NOW);
    expect(w.ok && (await db.chats.get(w.chatId!))?.stage).toBe('warming');
    const d = await actOnFound(user, b!.entry.memberId, 'write', NOW);
    expect(d.ok && d.draftId).toBeTruthy();
    const draft = d.ok ? await db.outbound.get(d.draftId!) : undefined;
    expect(draft).toMatchObject({ kind: 'outreach', channel: 'linkedin' });
  });

  it('names a friend at the company as the way in, for a couple of people there and not for all of them', async () => {
    const friend = await addPersonByHand(user.id, { name: 'Maya Chen', company: 'Stripe' }, user.school);
    await db.people.update(friend!.person.id, { strength: 0.62, tieScore: 62, tieBand: 'strong' });
    for (let i = 0; i < 3; i++) await loadMoreDiscover(user, { now: NOW });
    const v = await discoverView(user, NOW);
    const atStripe = v.found.filter((c) => c.entry.company === 'Stripe');
    expect(atStripe.length).toBeGreaterThan(2);
    const intros = v.found.filter((c) => c.action === 'intro');
    expect(intros.length).toBe(2);
    expect(intros[0]!.reason.text).toBe('Maya, whom you know, works at Stripe too');
    // the picks ask Maya once at most
    expect(v.suggestions.filter((c) => c.kind === 'found' && c.colleague).length).toBeLessThanOrEqual(1);
    // someone the student barely knows is never offered as the way in
    await db.people.update(friend!.person.id, { strength: 0.12, tieScore: 12, tieBand: 'faint' });
    expect((await discoverView(user, NOW)).found.some((c) => c.action === 'intro')).toBe(false);
  });

  it('says LinkedIn is not connected when it is not, without searching', async () => {
    await db.integrations.clear();
    expect(await loadMoreDiscover(user, { now: NOW })).toEqual({ status: 'not_connected' });
    expect(calls).toHaveLength(0);
    expect((await discoverView(user, NOW)).connected).toBe(false);
  });
});

describe('the sample student’s mock search', () => {
  it('pages with a cursor through a large pool, and filters like LinkedIn', () => {
    const first = mockLinkedInSearchPage({ title: 'Software Engineer' });
    expect(first.people).toHaveLength(10);
    expect(first.cursor).toBe('mock:10');
    const second = mockLinkedInSearchPage({ title: 'Software Engineer' }, first.cursor);
    const ids = [...first.people, ...second.people].map((p) => p.memberId);
    expect(new Set(ids).size).toBe(ids.length);
    const stripe = mockLinkedInSearchPage({ company: 'Stripe', school: 'Cornell University' });
    expect(stripe.total).toBeGreaterThan(0);
    for (const p of stripe.people) expect(p.headline).toMatch(/Stripe/);
    expect(first.people.every((p) => p.memberId.startsWith('demo-search-') && p.pictureUrl)).toBe(true);
  });
});
