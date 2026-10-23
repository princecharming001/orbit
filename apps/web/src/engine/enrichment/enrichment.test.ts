import type { Person, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../../db/schema';
import { setConnectorModeForTests } from '../../integrations/connectorOutcome';
import { setConnectorsMockForTests } from '../../integrations/connectorsMock';
import { setUnipileUrlForTests } from '../../integrations/unipile';
import { buildSchoolAlias, studiedAt, studiedAtFrom } from './education';
import { enrichmentRecord, enrichmentStatus, runEnrichment } from './index';
import { linkedInDate } from './profile';
import { readBudget } from './store';

const BASE = 'https://proxy.test/functions/v1/orbit-connectors';
const NOW = new Date('2026-10-22T15:00:00Z');
const user: User = {
  id: 'u1',
  email: 'ravi.jain@umich.edu',
  fullName: 'Ravi Jain',
  firstName: 'Ravi',
  lastName: 'Jain',
  school: 'University of Michigan - Ann Arbor',
  majors: ['Computer Science'],
  timezone: 'America/Detroit',
  onboardingStep: 11,
  onboardingCompletedAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** a LinkedIn image link that expires at `e` (seconds) */
const licdn = (name: string, e = 1_900_000_000) =>
  `https://media.licdn.com/dms/image/v2/${name}?e=${e}&v=beta&t=x`;

type Answer = { status?: number; body: unknown; headers?: Record<string, string> };
let calls: { path: string; body: Record<string, unknown> }[];
let profiles: Record<string, Answer>;
let companies: Record<string, Answer>;
let searches: (keywords: string) => Answer;

function person(over: Partial<Person> & Pick<Person, 'id' | 'firstName' | 'lastName'>): Person {
  return {
    userId: user.id,
    displayName: `${over.firstName} ${over.lastName}`,
    nameNormalized: `${over.firstName} ${over.lastName}`.toLowerCase(),
    emails: [],
    relationshipType: 'unknown',
    strength: 0.3,
    interactionCount: 3,
    sources: ['gmail'],
    isHuman: true,
    tags: [],
    // replies both ways: someone the student knows (isKnownContact)
    strengthBreakdown: { counts: { email_in: 3, email_out: 3 } } as never,
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    ...over,
  };
}

const profile = (over: Record<string, unknown>) => ({
  ok: true,
  profile: { experience: [], education: [], throttled: [], ...over },
});

beforeEach(async () => {
  await wipeDatabase();
  await db.users.put(user);
  await db.integrations.put({
    id: 'int_li',
    userId: user.id,
    provider: 'linkedin_live',
    externalAccountId: 'acc_1',
    accessToken: 'tok',
    status: 'active',
    scopes: [],
    syncState: {},
    connectedAt: '2026-01-01T00:00:00.000Z',
  });
  setUnipileUrlForTests(BASE);
  setConnectorsMockForTests(false);
  // under jsdom the connectors would count as "automation": Gravatar is checked through the test's own probe
  setConnectorModeForTests('live');
  calls = [];
  profiles = {};
  companies = {};
  searches = () => ({ body: { ok: true, people: [] } });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = url.replace(BASE, '');
    const body = JSON.parse((init.body as string) || '{}') as Record<string, unknown>;
    calls.push({ path, body });
    let a: Answer | undefined;
    if (path === '/profile') a = profiles[String(body.identifier)];
    else if (path === '/company') a = companies[String(body.identifier)];
    else if (path === '/search') a = searches(String(body.keywords));
    else if (path === '/providers')
      a = { body: { linkedin: true, exa: false, firecrawl: false, apollo: false, peopleDataLabs: false } };
    a ??= { body: { ok: false, reason: 'not_found', message: 'no' } };
    return new Response(JSON.stringify(a.body), {
      status: a.status ?? 200,
      headers: { 'content-type': 'application/json', ...(a.headers ?? {}) },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setUnipileUrlForTests(undefined);
  setConnectorsMockForTests(undefined);
  setConnectorModeForTests(undefined);
});

const run = (opts: Parameters<typeof runEnrichment>[1] = {}) =>
  runEnrichment(user, { now: NOW, pauseMs: [0, 0], probe: async () => false, ...opts });
const paths = () => calls.map((c) => c.path).filter((p) => p !== '/providers');

describe('LinkedIn is the truth about a current position', () => {
  it('overrides a Gmail signature and a headline read as a title, and stores the company with its logo', async () => {
    await db.people.bulkPut([
      person({
        id: 'p_maya',
        firstName: 'Maya',
        lastName: 'Chen',
        linkedinMemberId: 'ACo_maya',
        currentTitle: 'Analyst',
        currentOrganizationRaw: 'Goldman Sachs',
        fieldSources: { currentTitle: 'gmail', currentOrganizationId: 'gmail' },
        sources: ['gmail', 'linkedin_csv'],
      }),
      person({
        id: 'p_omar',
        firstName: 'Omar',
        lastName: 'Haddad',
        linkedinSlug: 'omar-haddad',
        // the live sync read "President at Enactus Berkeley | Haas '26" as a title
        currentTitle: "President at Enactus Berkeley | Haas '26",
        fieldSources: { currentTitle: 'linkedin_csv' },
        sources: ['linkedin_csv'],
      }),
    ]);
    profiles.ACo_maya = {
      body: profile({
        providerId: 'ACo_maya',
        publicIdentifier: 'maya-chen',
        headline: 'Private equity at Blackstone',
        experience: [
          {
            title: 'Associate',
            company: 'Blackstone',
            companyId: '1234',
            logoUrl: licdn('blackstone-logo'),
            current: true,
            start: '2026-08',
          },
          { title: 'Analyst', company: 'Goldman Sachs', current: false, start: '2023-07', end: '2026-07' },
        ],
      }),
    };
    profiles['omar-haddad'] = {
      body: profile({
        providerId: 'ACo_omar',
        publicIdentifier: 'omar-haddad',
        experience: [
          {
            title: 'President',
            company: 'Enactus Berkeley',
            companyId: '777',
            companySlug: 'enactus-berkeley',
            logoUrl: licdn('enactus-logo'),
            current: true,
            start: '2025-05',
          },
        ],
      }),
    };
    const r = await run();
    expect(r.profiles).toBe(2);
    const maya = (await db.people.get('p_maya'))!;
    expect(maya.currentTitle).toBe('Associate');
    expect(maya.currentOrganizationRaw).toBe('Blackstone');
    expect(maya.fieldSources?.currentTitle).toBe('linkedin_profile');
    expect(maya.sources).toContain('linkedin_profile');
    // a new company is a job change, dated by LinkedIn
    const rec = (await enrichmentRecord('p_maya'))!;
    expect(rec.jobChange).toMatchObject({
      from: { company: 'Goldman Sachs' },
      to: { company: 'Blackstone', title: 'Associate' },
      startedAt: '2026-08',
    });
    expect(rec.fields.currentTitle).toMatchObject({ source: 'linkedin_profile', confidence: 1 });
    const affs = await db.affiliations.where('personId').equals('p_maya').toArray();
    expect(affs.find((a) => a.isCurrent)).toMatchObject({ nameRaw: 'Blackstone', startDate: '2026-08' });
    expect(affs.find((a) => a.nameRaw === 'Goldman Sachs')).toMatchObject({
      isCurrent: false,
      endDate: '2026-07',
    });
    const org = (await db.organizations.get(maya.currentOrganizationId!))!;
    expect(org).toMatchObject({ linkedinCompanyId: '1234', logoUrl: licdn('blackstone-logo') });
    const omar = (await db.people.get('p_omar'))!;
    expect(omar.currentTitle).toBe('President');
    expect(omar.currentOrganizationRaw).toBe('Enactus Berkeley');
    const enactus = (await db.organizations.get(omar.currentOrganizationId!))!;
    expect(enactus).toMatchObject({ linkedinSlug: 'enactus-berkeley', logoUrl: licdn('enactus-logo') });
    // people who matter less get the lighter sections; nobody here is in the pipeline
    expect(calls.find((c) => c.path === '/profile')?.body.sections).toEqual([
      'experience_preview',
      'education_preview',
    ]);
  });

  it("never overwrites the student's own edit", async () => {
    await db.people.put(
      person({
        id: 'p_lee',
        firstName: 'Ana',
        lastName: 'Lee',
        linkedinMemberId: 'ACo_lee',
        currentTitle: 'Chief of Staff',
        currentOrganizationRaw: 'Ramp',
        fieldSources: { currentTitle: 'manual', currentOrganizationId: 'manual' },
        sources: ['manual'],
      }),
    );
    profiles.ACo_lee = {
      body: profile({ experience: [{ title: 'Operations', company: 'Brex', current: true }] }),
    };
    await run();
    const p = (await db.people.get('p_lee'))!;
    expect(p.currentTitle).toBe('Chief of Staff');
    expect(p.currentOrganizationRaw).toBe('Ramp');
    expect((await enrichmentRecord('p_lee'))?.jobChange).toBeUndefined();
  });
});

describe('the waterfall', () => {
  it('goes cheapest first and stops when nothing more is needed', async () => {
    await db.people.bulkPut([
      // a Gmail person without a photo and without LinkedIn: Gravatar first, then a LinkedIn search (rule 3)
      person({
        id: 'p_g',
        firstName: 'Brooke',
        lastName: 'Lin',
        primaryEmail: 'brooke@corgi.com',
        emails: ['brooke@corgi.com'],
      }),
      // read last week: nothing to do
      person({ id: 'p_fresh', firstName: 'Sam', lastName: 'Ortiz', linkedinMemberId: 'ACo_sam' }),
    ]);
    await db.kv.put({
      key: 'enrich:rec:p_fresh',
      value: { userId: user.id, personId: 'p_fresh', fields: {}, profileAt: '2026-10-15T00:00:00Z' },
    });
    const r = await run({
      probe: async (url) => {
        calls.push({ path: url.startsWith('https://gravatar.com/avatar/') ? 'gravatar' : url, body: {} });
        return true;
      },
    });
    // Gravatar first; then LinkedIn by name and the company their address names, and by name alone
    expect(paths()).toEqual(['gravatar', '/search', '/search']);
    expect(calls.filter((c) => c.path === '/search').map((c) => c.body.keywords)).toEqual([
      'Brooke Lin corgi',
      'Brooke Lin',
    ]);
    expect(r.gravatars).toBe(1);
    expect((await db.people.get('p_g'))!.photoUrl).toMatch(
      /^https:\/\/gravatar\.com\/avatar\/[0-9a-f]{64}\?s=200&d=404$/,
    );
    expect(calls.some((c) => c.path === '/profile' && c.body.identifier === 'ACo_sam')).toBe(false);
    // a second run the same day finds nothing due
    calls = [];
    await run();
    expect(paths()).toEqual([]);
  });

  it('a LinkedIn photo replaces a Gravatar; a photo from elsewhere stays', async () => {
    await db.people.bulkPut([
      person({
        id: 'p1',
        firstName: 'A',
        lastName: 'One',
        linkedinMemberId: 'm1',
        photoUrl: 'https://gravatar.com/avatar/abc?d=404',
      }),
      person({
        id: 'p2',
        firstName: 'B',
        lastName: 'Two',
        linkedinMemberId: 'm2',
        photoUrl: 'data:image/png;base64,AAAA',
      }),
    ]);
    profiles.m1 = { body: profile({ pictureUrl: licdn('one') }) };
    profiles.m2 = { body: profile({ pictureUrl: licdn('two') }) };
    await run();
    expect((await db.people.get('p1'))!.photoUrl).toBe(licdn('one'));
    expect((await db.people.get('p2'))!.photoUrl).toBe('data:image/png;base64,AAAA');
  });

  it('keeps to the daily budget and orders the queue by who matters now', async () => {
    const ids = ['a', 'b', 'c', 'd'];
    await db.people.bulkPut(
      ids.map((id, i) =>
        person({ id, firstName: 'P', lastName: id, linkedinMemberId: `m_${id}`, strength: i / 10 }),
      ),
    );
    // d is in the pipeline, c is a Discover pick
    await db.chats.put({ id: 'ch1', userId: user.id, personId: 'd', stage: 'outreach_sent' } as never);
    await db.recommendations.put({
      id: 'r1',
      userId: user.id,
      personId: 'c',
      status: 'new',
      score: 1,
    } as never);
    for (const id of ids) profiles[`m_${id}`] = { body: profile({}) };
    await run({ limits: { profile: 2, view: 0, search: 0, company: 0, gravatar: 0, web: 0 } });
    expect(calls.filter((c) => c.path === '/profile').map((c) => c.body.identifier)).toEqual(['m_d', 'm_c']);
    // full sections for the pipeline
    expect(calls.find((c) => c.path === '/profile')?.body.sections).toEqual([
      'experience',
      'education',
      'about',
    ]);
    expect((await readBudget(user.id, NOW)).used.profile).toBe(2);
    // tomorrow the rest
    calls = [];
    await run({
      now: new Date('2026-10-23T15:00:00Z'),
      limits: { profile: 5, view: 0, search: 0, company: 0, gravatar: 0, web: 0 },
    });
    expect(
      calls
        .filter((c) => c.path === '/profile')
        .map((c) => c.body.identifier)
        .sort(),
    ).toEqual(['m_a', 'm_b']);
  });

  it('respects sections LinkedIn held back, and stops LinkedIn calls for the day', async () => {
    await db.people.bulkPut([
      person({
        id: 'p_t',
        firstName: 'Tess',
        lastName: 'Ng',
        linkedinMemberId: 'm_t',
        currentTitle: 'Engineer',
        currentOrganizationRaw: 'Figma',
        strength: 0.9,
      }),
      person({ id: 'p_u', firstName: 'Uma', lastName: 'Rao', linkedinMemberId: 'm_u', strength: 0.1 }),
    ]);
    profiles.m_t = {
      body: profile({
        location: 'Seattle, Washington',
        experience: [],
        education: [{ school: 'University of Washington', start: '2014', end: '2018' }],
        throttled: ['experience'],
      }),
    };
    profiles.m_u = { body: profile({}) };
    const r = await run();
    const t = (await db.people.get('p_t'))!;
    // what came back is kept; the position is not emptied
    expect(t.currentTitle).toBe('Engineer');
    expect(t.currentOrganizationRaw).toBe('Figma');
    expect(t.location).toBe('Seattle, Washington');
    expect(await db.affiliations.where('personId').equals('p_t').count()).toBe(1);
    const rec = (await enrichmentRecord('p_t'))!;
    expect(rec.profileAt).toBeUndefined();
    expect(rec.throttledAt).toBeDefined();
    expect(r.stopped).toMatch(/held back/);
    // no more profile reads today
    expect(calls.filter((c) => c.path === '/profile')).toHaveLength(1);
    const status = await enrichmentStatus(user, NOW);
    expect(status.pauseReason).toMatch(/held back/);
  });

  it('a 429 or Orbit’s own daily limit stops LinkedIn calls until tomorrow', async () => {
    await db.people.bulkPut([
      person({ id: 'x1', firstName: 'X', lastName: 'One', linkedinMemberId: 'mx1', strength: 0.9 }),
      person({ id: 'x2', firstName: 'X', lastName: 'Two', linkedinMemberId: 'mx2' }),
    ]);
    profiles.mx1 = {
      body: {
        ok: false,
        reason: 'limit',
        message: 'Orbit has read as many LinkedIn profiles as it allows today.',
      },
    };
    profiles.mx2 = { body: profile({}) };
    await run();
    expect(calls.filter((c) => c.path === '/profile')).toHaveLength(1);
    calls = [];
    await run({ now: new Date('2026-10-22T20:00:00Z') });
    expect(calls.filter((c) => c.path === '/profile')).toHaveLength(0);
    await run({ now: new Date('2026-10-23T09:00:00Z') });
    expect(calls.filter((c) => c.path === '/profile').length).toBeGreaterThan(0);
  });
});

describe('Gmail and iMessage people found on LinkedIn (rule 3)', () => {
  it('joins only the profile that agrees, never a namesake at another company', async () => {
    await db.people.put(
      person({
        id: 'p_b',
        firstName: 'Brooke',
        lastName: 'Lin',
        primaryEmail: 'brooke@corgi.com',
        emails: ['brooke@corgi.com'],
        photoUrl: 'https://gravatar.com/avatar/x?d=404',
      }),
    );
    searches = () => ({
      body: {
        ok: true,
        people: [
          { memberId: 'ACo_nurse', name: 'Brooke Lin', headline: 'Nurse at Kaiser', distance: 3 },
          {
            memberId: 'ACo_corgi',
            name: 'Brooke Lin',
            headline: 'Founder at Corgi',
            distance: 2,
            profileUrl: 'https://www.linkedin.com/in/brooke-lin',
          },
          { memberId: 'ACo_other', name: 'Brooke Lindsey', headline: 'Founder at Corgi', distance: 2 },
        ],
      },
    });
    profiles.ACo_corgi = {
      body: profile({
        providerId: 'ACo_corgi',
        publicIdentifier: 'brooke-lin',
        pictureUrl: licdn('brooke'),
        experience: [{ title: 'Founder', company: 'Corgi', current: true, start: '2024' }],
      }),
    };
    const r = await run();
    expect(r.matched).toBe(1);
    // the search was narrowed by the company their address names
    expect(calls.find((c) => c.path === '/search')?.body.keywords).toBe('Brooke Lin corgi');
    const b = (await db.people.get('p_b'))!;
    expect(b).toMatchObject({
      linkedinMemberId: 'ACo_corgi',
      linkedinSlug: 'brooke-lin',
      currentTitle: 'Founder',
    });
    // LinkedIn's photo over the Gravatar
    expect(b.photoUrl).toBe(licdn('brooke'));
    expect(calls.some((c) => c.path === '/profile' && c.body.identifier === 'ACo_nurse')).toBe(false);
    const rec = (await enrichmentRecord('p_b'))!;
    expect(rec.searchResult).toBe('matched');
    expect(rec.fields.linkedin).toMatchObject({ source: 'linkedin_search' });
    expect(rec.fields.linkedin!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('leaves alone a name alone, and two namesakes who both fit', async () => {
    await db.people.bulkPut([
      person({
        id: 'p_m',
        firstName: 'Michael',
        lastName: 'Chen',
        primaryEmail: 'mchen@gmail.com',
        emails: ['mchen@gmail.com'],
      }),
      person({
        id: 'p_j',
        firstName: 'Jordan',
        lastName: 'Park',
        primaryEmail: 'jordan@stripe.com',
        emails: ['jordan@stripe.com'],
      }),
    ]);
    searches = (k) =>
      k.startsWith('Michael')
        ? {
            body: {
              ok: true,
              people: [
                { memberId: 'ACo_m1', name: 'Michael Chen', headline: 'Engineer at Google', distance: 3 },
              ],
            },
          }
        : {
            body: {
              ok: true,
              people: [
                { memberId: 'ACo_j1', name: 'Jordan Park', headline: 'PM at Stripe', distance: 2 },
                { memberId: 'ACo_j2', name: 'Jordan Park', headline: 'Engineer at Stripe', distance: 3 },
              ],
            },
          };
    // the one Michael Chen's profile says nothing Orbit knows
    profiles.ACo_m1 = {
      body: profile({ experience: [{ title: 'Engineer', company: 'Google', current: true }] }),
    };
    const r = await run();
    expect(r.matched).toBe(0);
    expect((await db.people.get('p_m'))!.linkedinMemberId).toBeUndefined();
    expect((await db.people.get('p_j'))!.linkedinMemberId).toBeUndefined();
    expect((await enrichmentRecord('p_j'))!.searchResult).toBe('ambiguous');
    expect((await enrichmentRecord('p_m'))!.searchResult).toBe('none');
  });

  it("a connection's shared email joins the Gmail person exactly (one record, the older one kept)", async () => {
    await db.people.bulkPut([
      person({
        id: 'p_gmail',
        firstName: 'Dana',
        lastName: 'Lee',
        primaryEmail: 'dana.lee@gmail.com',
        emails: ['danalee@gmail.com'],
        createdAt: '2026-01-05T00:00:00Z',
      }),
      person({
        id: 'p_li',
        firstName: 'Dana',
        lastName: 'Lee',
        linkedinMemberId: 'ACo_dana',
        linkedinSlug: 'dana-lee',
        sources: ['linkedin_csv'],
        createdAt: '2026-03-01T00:00:00Z',
      }),
    ]);
    await db.chats.put({ id: 'ch_d', userId: user.id, personId: 'p_li', stage: 'identified' } as never);
    profiles.ACo_dana = {
      body: profile({
        providerId: 'ACo_dana',
        distance: 1,
        contact: { emails: ['Dana.Lee@gmail.com'], phones: ['(415) 555-0100'] },
        experience: [{ title: 'Designer', company: 'Figma', current: true }],
      }),
    };
    await run();
    expect(await db.people.get('p_li')).toBeUndefined();
    const d = (await db.people.get('p_gmail'))!;
    expect(d).toMatchObject({
      linkedinMemberId: 'ACo_dana',
      currentTitle: 'Designer',
      currentOrganizationRaw: 'Figma',
    });
    expect(d.phones).toEqual(['+14155550100']);
    // the address LinkedIn shared is not made the one Orbit writes to
    expect(d.primaryEmail).toBe('dana.lee@gmail.com');
    expect((await db.chats.get('ch_d'))!.personId).toBe('p_gmail');
    expect((await enrichmentRecord('p_gmail'))?.contact?.phones).toEqual(['+14155550100']);
  });
});

describe('logos and photos that expire', () => {
  it('fetches an expired company logo again, and a missing one by the company id', async () => {
    await db.organizations.bulkPut([
      {
        id: 'o1',
        name: 'Blackstone',
        nameNormalized: 'blackstone',
        domains: [],
        linkedinCompanyId: '1234',
        logoUrl: licdn('old', 1_700_000_000),
      },
      { id: 'o2', name: 'Corgi', nameNormalized: 'corgi', domains: [], linkedinCompanyId: '55' },
    ]);
    await db.people.bulkPut([
      person({
        id: 'q1',
        firstName: 'Q',
        lastName: 'One',
        currentOrganizationId: 'o1',
        currentOrganizationRaw: 'Blackstone',
      }),
      person({
        id: 'q2',
        firstName: 'Q',
        lastName: 'Two',
        currentOrganizationId: 'o2',
        currentOrganizationRaw: 'Corgi',
      }),
    ]);
    companies['1234'] = {
      body: { ok: true, company: { id: '1234', name: 'Blackstone', logoUrl: licdn('new') } },
    };
    companies['55'] = {
      body: {
        ok: true,
        company: { id: '55', name: 'Corgi', publicIdentifier: 'corgi-hq', logoUrl: licdn('corgi') },
      },
    };
    const r = await run({ limits: { profile: 0, view: 0, search: 0, company: 5, gravatar: 0, web: 0 } });
    expect(r.logos).toBe(2);
    expect((await db.organizations.get('o1'))!.logoUrl).toBe(licdn('new'));
    expect(await db.organizations.get('o2')).toMatchObject({
      logoUrl: licdn('corgi'),
      linkedinSlug: 'corgi-hq',
    });
    // a fresh logo is not asked for again
    calls = [];
    await run({ limits: { profile: 0, view: 0, search: 0, company: 5, gravatar: 0, web: 0 } });
    expect(calls.filter((c) => c.path === '/company')).toHaveLength(0);
  });

  it('reads the plain profile again when only the LinkedIn photo has expired', async () => {
    await db.people.put(
      person({
        id: 'ph',
        firstName: 'P',
        lastName: 'H',
        linkedinMemberId: 'm_ph',
        photoUrl: licdn('face', 1_700_000_000),
      }),
    );
    await db.kv.put({
      key: 'enrich:rec:ph',
      value: { userId: user.id, personId: 'ph', fields: {}, profileAt: '2026-10-01T00:00:00Z' },
    });
    profiles.m_ph = { body: profile({ pictureUrl: licdn('face2') }) };
    await run();
    const call = calls.find((c) => c.path === '/profile')!;
    expect(call.body.sections).toEqual([]);
    expect((await db.people.get('ph'))!.photoUrl).toBe(licdn('face2'));
  });
});

describe('education is the evidence for where someone studied', () => {
  it('turns the education section into affiliations that studiedAt reads', async () => {
    await db.people.put(
      person({ id: 'e1', firstName: 'Eli', lastName: 'Moss', linkedinMemberId: 'm_e', strength: 0.9 }),
    );
    // what an older import said about their school is replaced by LinkedIn's own row
    await db.affiliations.put({
      id: 'old_edu',
      userId: user.id,
      personId: 'e1',
      kind: 'education',
      nameRaw: 'UMich',
      isCurrent: false,
      source: 'enrichment',
    });
    profiles.m_e = {
      body: profile({
        education: [
          { school: 'University of Michigan', degree: 'BS', field: 'Economics', start: '2015', end: '2019' },
          { school: 'Harvard Business School', degree: 'MBA', start: '9/2023', end: '5/2025' },
        ],
      }),
    };
    await run();
    const affs = await db.affiliations.where('personId').equals('e1').toArray();
    expect(affs.map((a) => a.nameRaw).sort()).toEqual(['Harvard Business School', 'University of Michigan']);
    expect(affs.every((a) => a.source === 'linkedin_profile')).toBe(true);
    const ev = await studiedAt({ id: 'e1' }, user.school, NOW);
    expect(ev).toMatchObject({
      school: 'University of Michigan',
      degree: 'BS',
      endDate: '2019',
      source: 'linkedin_profile',
    });
    expect(await studiedAt({ id: 'e1' }, 'Cornell University', NOW)).toBeUndefined();
  });

  it('matches the ways students write a school, and keeps similar names apart', () => {
    const alias = buildSchoolAlias([
      {
        name: 'University of California, Berkeley',
        domain: 'berkeley.edu',
        where: '',
        aliases: ['Cal', 'UC Berkeley'],
        kind: 1,
      },
      {
        name: 'University of Michigan - Ann Arbor',
        domain: 'umich.edu',
        where: '',
        aliases: ['UMich'],
        kind: 1,
      },
      {
        name: 'University of Michigan - Dearborn',
        domain: 'umdearborn.edu',
        where: '',
        aliases: [],
        kind: 1,
      },
      { name: 'Cornell University', domain: 'cornell.edu', where: '', aliases: [], kind: 1 },
      { name: 'Cornell College', domain: 'cornellcollege.edu', where: '', aliases: [], kind: 1 },
    ]);
    const edu = (nameRaw: string) => [
      { id: 'a', kind: 'education' as const, nameRaw, source: 'linkedin_profile' as const },
    ];
    expect(
      studiedAtFrom(edu('UC Berkeley, Haas School of Business'), 'University of California, Berkeley', alias),
    ).toBeDefined();
    expect(studiedAtFrom(edu('Cal'), 'University of California-Berkeley', alias)).toBeDefined();
    expect(
      studiedAtFrom(edu('University of Michigan'), 'University of Michigan - Ann Arbor', alias),
    ).toBeDefined();
    expect(studiedAtFrom(edu('Cornell College'), 'Cornell University', alias)).toBeUndefined();
    expect(
      studiedAtFrom(edu('University of Michigan - Dearborn'), 'University of Michigan - Ann Arbor', alias),
    ).toBeUndefined();
    // an employer is not a school
    expect(
      studiedAtFrom(
        [{ id: 'w', kind: 'employment', nameRaw: 'Cornell University', source: 'linkedin_profile' }],
        'Cornell University',
      ),
    ).toBeUndefined();
  });
});

describe('the demo', () => {
  it('fills a person from the mock connector: position, company logo and schools', async () => {
    setConnectorsMockForTests(true);
    await db.organizations.put({
      id: 'org_stripe',
      name: 'Stripe',
      nameNormalized: 'stripe',
      domains: ['stripe.com'],
      linkedinSlug: 'stripe',
    });
    await db.people.put(
      person({
        id: 'pr',
        firstName: 'Priya',
        lastName: 'Raman',
        linkedinSlug: 'priya-raman-li',
        linkedinUrl: 'https://www.linkedin.com/in/priya-raman-li',
        currentTitle: 'Product Manager',
        currentOrganizationId: 'org_stripe',
        currentOrganizationRaw: 'Stripe',
        sources: ['linkedin_csv'],
        fieldSources: { currentTitle: 'linkedin_csv', currentOrganizationId: 'linkedin_csv' },
      }),
    );
    const r = await runEnrichment(user, { only: ['pr'], reason: 'view', now: NOW });
    expect(r.profiles).toBe(1);
    const p = (await db.people.get('pr'))!;
    expect(p.currentTitle).toBe('Product Manager, Payments');
    expect((await db.organizations.get('org_stripe'))!.logoUrl).toBe('/logos/stripe.png');
    expect(await studiedAt(p, 'University of Michigan - Ann Arbor', NOW)).toBeDefined();
    // nothing went to the network
    expect(calls).toEqual([]);
  });
});

describe('small readers', () => {
  it('reads the ways LinkedIn writes a date', () => {
    expect(linkedInDate('2021-6')).toBe('2021-06');
    expect(linkedInDate('6/2021')).toBe('2021-06');
    expect(linkedInDate('6/15/2021')).toBe('2021-06-15');
    expect(linkedInDate('Jun 2021')).toBe('2021-06');
    expect(linkedInDate('2021')).toBe('2021');
    expect(linkedInDate('')).toBeUndefined();
  });
});
