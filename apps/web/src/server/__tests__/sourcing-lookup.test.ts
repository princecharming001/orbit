/** The email lookup (lookup.ts): LinkedIn's own contact email, then Hunter, then Apollo, cached, capped; and the verifier. */
import { describe, expect, it } from 'vitest';
import type { Apollo } from '../../../../../supabase/functions/_shared/providers/apollo';
import {
  createHunter,
  type Hunter,
  type HunterFinder,
} from '../../../../../supabase/functions/_shared/providers/hunter';
import type { UnipileResearch } from '../../../../../supabase/functions/_shared/providers/unipileResearch';
import { memorySharedCache } from '../../../../../supabase/functions/_shared/research/web';
import {
  fillEmails,
  fromTemplate,
  MAX_LOOKUPS,
  MAX_VERIFIES,
  withDeadline,
} from '../../../../../supabase/functions/_shared/sourcing/email';
import {
  domainTemplate,
  emailLookup,
  emailVerifier,
} from '../../../../../supabase/functions/_shared/sourcing/lookup';
import type { Candidate } from '../../../../../supabase/functions/_shared/sourcing/search';
import { memoryBudget } from './fakes';

const cand = (c: Partial<Candidate>): Candidate => ({
  key: `${c.name ?? 'Maya Chen'}|${c.linkedinUrl ?? ''}|${c.org ?? ''}`,
  entity: 'person',
  name: 'Maya Chen',
  sources: ['unipile'],
  externalIds: {},
  ...c,
});

function fakeApollo(
  answer: (p: Record<string, unknown>) => { email?: string; email_status?: string } | null,
  configured = true,
) {
  const calls: Record<string, unknown>[] = [];
  const apollo = {
    configured,
    searchPeople: async () => ({ ok: true, value: { people: [] } }),
    matchPerson: async (p: Record<string, unknown>) => {
      calls.push(p);
      const a = answer(p);
      return { ok: true, value: { person: a ? { id: 'ap1', ...a } : null } };
    },
  } as unknown as Apollo;
  return { apollo, calls };
}

function fakeUnipile(emails: string[] | undefined) {
  const calls: string[] = [];
  const unipile = {
    configured: true,
    profile: async (_a: string, id: string) => {
      calls.push(id);
      return { ok: true, value: emails ? { contact_info: { emails } } : {} };
    },
  } as unknown as UnipileResearch;
  return { unipile, calls };
}

type Found = NonNullable<HunterFinder['data']>;

function fakeHunter(
  answer: (p: Record<string, string>) => Found | null,
  verdicts: Record<string, string> = {},
) {
  const finds: Record<string, string>[] = [];
  const verifies: string[] = [];
  const hunter = {
    configured: true,
    findEmail: async (p: Record<string, string>) => {
      finds.push(p);
      return { ok: true, value: { data: answer(p) } };
    },
    verifyEmail: async (email: string) => {
      verifies.push(email);
      return { ok: true, value: { data: { status: verdicts[email] ?? 'unknown' } } };
    },
  } as unknown as Hunter;
  return { hunter, finds, verifies };
}

const maya = cand({ linkedinUrl: 'https://www.linkedin.com/in/maya-chen-1', org: 'Stripe' });

describe('the verified email lookup: 8 cases', () => {
  it('U1 a 1st-degree connection: their own LinkedIn contact email, Apollo never asked', async () => {
    const li = fakeUnipile(['Maya.Chen@stripe.com']);
    const ap = fakeApollo(() => ({ email: 'other@stripe.com', email_status: 'verified' }));
    const look = emailLookup({
      userId: 'u',
      unipile: li.unipile,
      unipileAccountId: 'acc',
      apollo: ap.apollo,
      budget: memoryBudget().budget,
      cache: memorySharedCache(),
    });
    expect(await look(cand({ ...maya, networkDistance: 1 }))).toEqual({
      email: 'maya.chen@stripe.com',
      source: 'linkedin',
      status: 'verified',
    });
    expect(li.calls).toEqual(['maya-chen-1']);
    expect(ap.calls).toHaveLength(0);
  });

  it('U2 a 2nd-degree person: no profile view, Apollo by LinkedIn URL', async () => {
    const li = fakeUnipile(['x@stripe.com']);
    const ap = fakeApollo(() => ({ email: 'maya.chen@stripe.com', email_status: 'verified' }));
    const look = emailLookup({
      userId: 'u',
      unipile: li.unipile,
      unipileAccountId: 'acc',
      apollo: ap.apollo,
      cache: memorySharedCache(),
    });
    expect(await look(cand({ ...maya, networkDistance: 2 }))).toMatchObject({
      email: 'maya.chen@stripe.com',
      source: 'apollo',
      status: 'verified',
    });
    expect(li.calls).toHaveLength(0);
    expect(ap.calls[0]).toMatchObject({
      linkedin_url: 'https://www.linkedin.com/in/maya-chen-1',
      reveal_personal_emails: false,
    });
  });

  it('U3 the same person twice costs one credit: the answer is cached', async () => {
    const ap = fakeApollo(() => ({ email: 'maya.chen@stripe.com', email_status: 'verified' }));
    const cache = memorySharedCache();
    const look = emailLookup({ userId: 'u', apollo: ap.apollo, cache });
    await look(maya);
    const again = emailLookup({ userId: 'u2', apollo: ap.apollo, cache });
    expect(await again(cand({ ...maya, name: 'Maya C.' }))).toMatchObject({ email: 'maya.chen@stripe.com' });
    expect(ap.calls).toHaveLength(1);
  });

  it('U4 over the daily Apollo cap: no call, nothing found', async () => {
    const ap = fakeApollo(() => ({ email: 'maya.chen@stripe.com', email_status: 'verified' }));
    const money = memoryBudget({ apollo_match: true });
    const look = emailLookup({
      userId: 'u',
      apollo: ap.apollo,
      budget: money.budget,
      cache: memorySharedCache(),
    });
    expect(await look(maya)).toBeUndefined();
    expect(ap.calls).toHaveLength(0);
  });

  it('U5 Apollo says unavailable: nothing, and the miss is cached too', async () => {
    const ap = fakeApollo(() => ({ email: 'maya.chen@stripe.com', email_status: 'unavailable' }));
    const cache = memorySharedCache();
    const look = emailLookup({ userId: 'u', apollo: ap.apollo, cache });
    expect(await look(maya)).toBeUndefined();
    expect(await look(maya)).toBeUndefined();
    expect(ap.calls).toHaveLength(1);
  });

  it('U6 an extrapolated Apollo address comes back as a guess', async () => {
    const ap = fakeApollo(() => ({ email: 'maya.chen@stripe.com', email_status: 'guessed' }));
    const look = emailLookup({ userId: 'u', apollo: ap.apollo, cache: memorySharedCache() });
    expect(await look(maya)).toMatchObject({ status: 'guess' });
  });

  it('U7 no LinkedIn URL: Apollo by name and the company domain', async () => {
    const ap = fakeApollo(() => ({ email: 'ana.ruiz@acme.ai', email_status: 'verified' }));
    const look = emailLookup({
      userId: 'u',
      apollo: ap.apollo,
      cache: memorySharedCache(),
      domainOf: (c) => (c.org === 'Acme' ? 'acme.ai' : undefined),
    });
    expect(await look(cand({ name: 'Ana Ruiz', org: 'Acme' }))).toMatchObject({ email: 'ana.ruiz@acme.ai' });
    expect(ap.calls[0]).toMatchObject({ first_name: 'Ana', last_name: 'Ruiz', domain: 'acme.ai' });
    // nothing identifies them: nothing is asked
    expect(await look(cand({ name: 'Bo Liu', org: 'Nowhere' }))).toBeUndefined();
    expect(ap.calls).toHaveLength(1);
  });

  it('U8 Apollo not configured: nothing asked, nothing found', async () => {
    const ap = fakeApollo(() => ({ email: 'x@stripe.com' }), false);
    const look = emailLookup({ userId: 'u', apollo: ap.apollo, cache: memorySharedCache() });
    expect(await look(maya)).toBeUndefined();
    expect(ap.calls).toHaveLength(0);
  });
});

describe('verified addresses inside the email finder: 5 cases', () => {
  const mx = async () => true;
  const stripe = new Map([['stripe', 'stripe.com']]);

  it('F1 a verified address beats the pattern', async () => {
    const c = cand({ ...maya });
    await fillEmails([c], {
      known: [
        { name: 'Sam Lee', email: 'slee@stripe.com' },
        { name: 'Ana Ruiz', email: 'aruiz@stripe.com' },
      ],
      orgDomains: stripe,
      mx,
      lookup: async () => ({ email: 'maya.c@stripe.com', source: 'apollo', status: 'verified' }),
    });
    expect(c.email).toBe('maya.c@stripe.com');
    expect(c.emailConfidence).toBe('verified');
  });

  it('F2 nothing verified: the pattern fills in as before', async () => {
    const c = cand({ ...maya });
    await fillEmails([c], {
      known: [
        { name: 'Sam Lee', email: 'slee@stripe.com' },
        { name: 'Ana Ruiz', email: 'aruiz@stripe.com' },
      ],
      orgDomains: stripe,
      mx,
      lookup: async () => undefined,
    });
    expect(c.email).toBe('mchen@stripe.com');
    expect(c.emailConfidence).toBe('pattern');
  });

  it('F3 lookups stop at the cap, best fit first; a page email is never looked up', async () => {
    const asked: string[] = [];
    const cs = [
      cand({ name: 'A One', org: 'Stripe', email: 'a.one@stripe.com' }),
      cand({ name: 'B Two', org: 'Stripe' }),
      cand({ name: 'C Three', org: 'Stripe' }),
      cand({ name: 'D Four', org: 'Stripe' }),
    ];
    await fillEmails(cs, {
      known: [],
      orgDomains: stripe,
      mx,
      maxLookups: 2,
      lookup: async (c) => {
        asked.push(c.name);
        return undefined;
      },
    });
    expect(asked).toEqual(['B Two', 'C Three']);
    expect(cs[0]!.emailConfidence).toBe('page');
  });

  it('F4 an extrapolated lookup is shown as a guess', async () => {
    const c = cand({ ...maya });
    await fillEmails([c], {
      known: [],
      orgDomains: stripe,
      mx,
      lookup: async () => ({ email: 'maya.chen@stripe.com', source: 'apollo', status: 'guess' }),
    });
    expect(c.emailConfidence).toBe('guess');
  });

  it('F5 a verified address teaches its domain pattern to the next person there', async () => {
    const a = cand({ name: 'Ana Ruiz', org: 'Acme', linkedinUrl: 'https://www.linkedin.com/in/ana-ruiz' });
    const b = cand({ name: 'Bo Liu', org: 'Acme' });
    await fillEmails([a, b], {
      known: [],
      orgDomains: new Map([['acme', 'acme.ai']]),
      mx,
      lookup: async (c) =>
        c.name === 'Ana Ruiz'
          ? { email: 'aruiz@acme.ai', source: 'linkedin', status: 'verified' }
          : undefined,
    });
    expect(a.emailConfidence).toBe('verified');
    expect(b.email).toBe('bliu@acme.ai');
    expect(b.emailConfidence).toBe('guess');
  });
});

describe('Hunter in the lookup: 9 cases', () => {
  const ok = (email: string, extra: Partial<Found> = {}): Found => ({
    email,
    score: 95,
    verification: { status: 'valid' },
    sources: [],
    ...extra,
  });

  it('H1 by LinkedIn handle first: the person themself, verified; Apollo never asked', async () => {
    const h = fakeHunter(() => ok('maya@stripe.com'));
    const ap = fakeApollo(() => ({ email: 'other@stripe.com', email_status: 'verified' }));
    const look = emailLookup({
      userId: 'u',
      hunter: h.hunter,
      apollo: ap.apollo,
      cache: memorySharedCache(),
    });
    expect(await look(maya)).toEqual({ email: 'maya@stripe.com', source: 'hunter', status: 'verified' });
    expect(h.finds).toEqual([{ linkedin_handle: 'maya-chen-1' }]);
    expect(ap.calls).toHaveLength(0);
  });

  it('H2 nothing by handle: then by name and the company domain', async () => {
    const h = fakeHunter((p) => (p.domain ? ok('mchen@stripe.com') : null));
    const look = emailLookup({
      userId: 'u',
      hunter: h.hunter,
      cache: memorySharedCache(),
      domainOf: () => 'stripe.com',
    });
    expect(await look(maya)).toMatchObject({ email: 'mchen@stripe.com', status: 'verified' });
    expect(h.finds[1]).toEqual({ first_name: 'maya', last_name: 'chen', domain: 'stripe.com' });
  });

  it('H3 a namesake (their LinkedIn is someone else) is dropped', async () => {
    const h = fakeHunter(() =>
      ok('joseph.gonzalez@berkeley.edu', { linkedin_url: 'https://linkedin.com/in/joseph-go99' }),
    );
    const look = emailLookup({
      userId: 'u',
      hunter: h.hunter,
      cache: memorySharedCache(),
      domainOf: () => 'berkeley.edu',
    });
    const prof = cand({ name: 'Joseph Gonzalez', linkedinUrl: 'https://www.linkedin.com/in/jegonzal' });
    expect(await look(prof)).toBeUndefined();
    expect(h.finds).toHaveLength(2);
  });

  it('H4 by name at a university with no profile to compare: a guess at most', async () => {
    const h = fakeHunter(() => ok('hearst@berkeley.edu'));
    const look = emailLookup({
      userId: 'u',
      hunter: h.hunter,
      cache: memorySharedCache(),
      domainOf: () => 'berkeley.edu',
    });
    expect(await look(cand({ name: 'Marti Hearst', org: 'UC Berkeley' }))).toMatchObject({
      email: 'hearst@berkeley.edu',
      status: 'guess',
    });
  });

  it('H5 an address Hunter itself marks invalid is dropped', async () => {
    const h = fakeHunter(() => ok('maya@stripe.com', { verification: { status: 'invalid' } }));
    const look = emailLookup({ userId: 'u', hunter: h.hunter, cache: memorySharedCache() });
    expect(await look(maya)).toBeUndefined();
  });

  it('H6 a catch-all server: verified only when the address is still on a public page', async () => {
    const onPage = fakeHunter(() =>
      ok('maya@stripe.com', { verification: { status: 'accept_all' }, sources: [{ still_on_page: true }] }),
    );
    expect(
      await emailLookup({ userId: 'u', hunter: onPage.hunter, cache: memorySharedCache() })(maya),
    ).toMatchObject({ status: 'verified' });
    const weak = fakeHunter(() =>
      ok('maya@stripe.com', { verification: { status: 'accept_all' }, score: 40 }),
    );
    expect(
      await emailLookup({ userId: 'u', hunter: weak.hunter, cache: memorySharedCache() })(maya),
    ).toBeUndefined();
  });

  it("H7 a connection's LinkedIn email is never served to another student from the cache", async () => {
    const li = fakeUnipile(['maya.chen@stripe.com']);
    const ap = fakeApollo(() => null);
    const cache = memorySharedCache();
    const mine = emailLookup({
      userId: 'a',
      unipile: li.unipile,
      unipileAccountId: 'acc',
      apollo: ap.apollo,
      cache,
    });
    expect(await mine(cand({ ...maya, networkDistance: 1 }))).toMatchObject({ source: 'linkedin' });
    const theirs = emailLookup({
      userId: 'b',
      unipile: li.unipile,
      unipileAccountId: 'acc2',
      apollo: ap.apollo,
      cache,
    });
    expect(await theirs(cand({ ...maya, networkDistance: 2 }))).toBeUndefined();
    expect(li.calls).toHaveLength(1);
  });

  it('H8 a key added later asks again instead of reading the old miss', async () => {
    const cache = memorySharedCache();
    const ap = fakeApollo(() => null);
    expect(await emailLookup({ userId: 'u', apollo: ap.apollo, cache })(maya)).toBeUndefined();
    const h = fakeHunter(() => ok('maya@stripe.com'));
    expect(
      await emailLookup({ userId: 'u', hunter: h.hunter, apollo: ap.apollo, cache })(maya),
    ).toMatchObject({
      email: 'maya@stripe.com',
    });
  });

  it('H9 over the daily Hunter cap: no call', async () => {
    const h = fakeHunter(() => ok('maya@stripe.com'));
    const look = emailLookup({
      userId: 'u',
      hunter: h.hunter,
      budget: memoryBudget({ hunter: true }).budget,
      cache: memorySharedCache(),
    });
    expect(await look(maya)).toBeUndefined();
    expect(h.finds).toHaveLength(0);
  });
});

describe('live-test regressions: 4 cases', () => {
  const found = (email: string, extra: Partial<Found> = {}): Found => ({
    email,
    score: 95,
    verification: { status: 'valid' },
    sources: [],
    ...extra,
  });
  const atBerkeley = (h: Hunter) =>
    emailLookup({ userId: 'u', hunter: h, cache: memorySharedCache(), domainOf: () => 'berkeley.edu' });

  it("R1 by name at a university, Hunter's LinkedIn with none of ours to compare is not proof", async () => {
    const h = fakeHunter(() =>
      found('joseph.gonzalez@berkeley.edu', { linkedin_url: 'https://linkedin.com/in/joseph-go99' }),
    );
    expect(await atBerkeley(h.hunter)(cand({ name: 'Joseph Gonzalez', org: 'UC Berkeley' }))).toMatchObject({
      status: 'guess',
    });
  });

  it('R2 a professor matched to staff with the same name is dropped', async () => {
    const h = fakeHunter(() => found('joseph.gonzalez@berkeley.edu', { position: 'Event Specialist' }));
    const prof = cand({ name: 'Joseph Gonzalez', org: 'UC Berkeley', title: 'Associate Professor of EECS' });
    expect(await atBerkeley(h.hunter)(prof)).toBeUndefined();
    const real = fakeHunter(() => found('denero@berkeley.edu', { position: 'Assistant' }));
    expect(
      await atBerkeley(real.hunter)(cand({ name: 'John DeNero', title: 'Teaching Professor' })),
    ).toMatchObject({
      email: 'denero@berkeley.edu',
    });
  });

  it('R3 a catch-all server and no page showing it: "valid" is only a guess', async () => {
    const h = fakeHunter(() =>
      found('jasjit.singh@rockstar.com', { accept_all: true, score: 83, verification: { status: 'valid' } }),
    );
    const look = emailLookup({
      userId: 'u',
      hunter: h.hunter,
      cache: memorySharedCache(),
      domainOf: () => 'rockstar.com',
    });
    expect(await look(cand({ name: 'Jasjit Singh', org: 'Rockstar' }))).toMatchObject({ status: 'guess' });
  });

  it('R4 the company pattern: Hunter templates, cached per domain for everyone', async () => {
    expect(fromTemplate('{first}', 'george', 'bandarian')).toBe('george');
    expect(fromTemplate('{f}{last}', 'maya', 'chen')).toBe('mchen');
    expect(fromTemplate('{first}.{l}', 'maya', 'chen')).toBe('maya.c');
    expect(fromTemplate('{first}{middle}', 'maya', 'chen')).toBeUndefined();
    const asked: string[] = [];
    const hunter = {
      configured: true,
      domainPattern: async (d: string) => {
        asked.push(d);
        return { ok: true, value: { data: { pattern: d === 'pear.vc' ? '{first}' : null } } };
      },
    } as unknown as Hunter;
    const cache = memorySharedCache();
    const t = domainTemplate({ userId: 'u', hunter, cache })!;
    expect([await t('pear.vc'), await t('none.io')]).toEqual(['{first}', undefined]);
    await domainTemplate({ userId: 'u2', hunter, cache })!('pear.vc');
    await domainTemplate({ userId: 'u2', hunter, cache })!('none.io');
    expect(asked).toEqual(['pear.vc', 'none.io']);
  });
});

describe('the verifier: 4 cases', () => {
  it('V1 no Hunter key: no verifier at all', () => {
    expect(emailVerifier({ userId: 'u', cache: memorySharedCache() })).toBeUndefined();
  });

  it('V2 statuses map to valid, invalid and risky; each address is checked once for everyone', async () => {
    const h = fakeHunter(() => null, { 'a@x.com': 'valid', 'b@x.com': 'invalid', 'c@x.com': 'accept_all' });
    const cache = memorySharedCache();
    const v = emailVerifier({ userId: 'u', hunter: h.hunter, cache })!;
    expect([await v('a@x.com'), await v('b@x.com'), await v('c@x.com'), await v('d@x.com')]).toEqual([
      'valid',
      'invalid',
      'risky',
      'risky',
    ]);
    await emailVerifier({ userId: 'u2', hunter: h.hunter, cache })!('A@x.com');
    expect(h.verifies).toEqual(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']);
  });

  it('V3 over the daily Hunter cap: no call, no verdict', async () => {
    const h = fakeHunter(() => null, { 'a@x.com': 'valid' });
    const v = emailVerifier({
      userId: 'u',
      hunter: h.hunter,
      budget: memoryBudget({ hunter: true }).budget,
      cache: memorySharedCache(),
    })!;
    expect(await v('a@x.com')).toBeUndefined();
    expect(h.verifies).toHaveLength(0);
  });

  it('V4 the finder caps verifications per run, best fit first', async () => {
    const asked: string[] = [];
    const cs = ['Al One', 'Bo Two', 'Cy Three'].map((name) => cand({ name, url: 'https://beta.io/team' }));
    await fillEmails(cs, {
      known: [],
      orgDomains: new Map(),
      maxVerifies: 2,
      template: async () => '{first}.{last}',
      verify: async (e) => {
        asked.push(e);
        return 'valid';
      },
    });
    expect(asked).toEqual(['al.one@beta.io', 'bo.two@beta.io']);
    expect(cs.map((c) => c.emailConfidence)).toEqual(['verified', 'verified', 'pattern']);
  });
});

describe('Hunter never holds up a search: 3 cases', () => {
  it('out of credits: one try, then every later call in the search is skipped', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return new Response('{"errors":[{"id":"too_many_requests"}]}', {
        status: 429,
        headers: { 'retry-after': '30' },
      });
    }) as unknown as typeof globalThis.fetch;
    const h = createHunter({ fetch, apiKey: 'hk', sleep: async () => undefined });
    const a = await h.findEmail({ linkedin_handle: 'a' });
    const b = await h.verifyEmail('b@x.com');
    const c = await h.domainPattern('x.com');
    expect([a.ok, b.ok, c.ok]).toEqual([false, false, false]);
    expect(calls).toBe(1);
  });

  it('a server error is not retried either', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return new Response('{}', { status: 503 });
    }) as unknown as typeof globalThis.fetch;
    const h = createHunter({ fetch, apiKey: 'hk', sleep: async () => undefined });
    expect((await h.findEmail({ linkedin_handle: 'a' })).ok).toBe(false);
    expect((await h.findEmail({ linkedin_handle: 'b' })).ok).toBe(false);
    expect(calls).toBe(2);
  });

  it('the email step keeps what it found by the deadline and lets the search go on', async () => {
    const c = cand({ name: 'Al One' });
    const slow = new Promise<void>((resolve) => {
      c.email = 'al@x.com';
      setTimeout(resolve, 5000);
    });
    const t0 = Date.now();
    await withDeadline(slow, 30);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(c.email).toBe('al@x.com');
  });
});

describe('the Hunter adapter: 2 cases', () => {
  it('sends the key as a header and the person in the query; 404 is nobody found', async () => {
    const seen: { url: string; key: string | null }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, key: new Headers(init.headers).get('x-api-key') });
      return new Response('{"errors":[{"id":"not_found"}]}', { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    const r = await createHunter({ fetch, apiKey: 'hk' }).findEmail({ linkedin_handle: 'maya-chen-1' });
    expect(r).toEqual({ ok: true, value: { data: null } });
    expect(seen[0]!.url).toBe('https://api.hunter.io/v2/email-finder?linkedin_handle=maya-chen-1');
    expect(seen[0]!.key).toBe('hk');
  });

  it('no key: unconfigured, nothing sent', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return new Response('{}');
    }) as unknown as typeof globalThis.fetch;
    const r = await createHunter({ fetch }).verifyEmail('a@x.com');
    expect(r.ok).toBe(false);
    expect(calls).toBe(0);
  });
});

describe('plan 34 A4: Hunter spends less and shows every call', () => {
  it('runs take 5 lookups and 5 verifications at most', () => {
    expect([MAX_LOOKUPS, MAX_VERIFIES]).toEqual([5, 5]);
  });

  it('three candidates at one new domain share one domain search in a run', async () => {
    const asked: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const hunter = {
      configured: true,
      domainPattern: async (d: string) => {
        asked.push(d);
        await gate;
        return { ok: true, value: { data: { pattern: '{first}' } } };
      },
    } as unknown as Hunter;
    const t = domainTemplate({ userId: 'u', hunter, cache: memorySharedCache() })!;
    const all = Promise.all([t('Beta.io'), t('beta.io'), t('beta.io')]);
    await new Promise((r) => setTimeout(r, 0));
    release();
    expect(await all).toEqual(['{first}', '{first}', '{first}']);
    expect(asked).toEqual(['beta.io']);
  });

  it('a miss is kept at 0 credits as an attempt; a find is a credit', async () => {
    const money = memoryBudget();
    const h = fakeHunter(() => null);
    await emailLookup({ userId: 'u', hunter: h.hunter, budget: money.budget, cache: memorySharedCache() })(
      maya,
    );
    expect(money.ledger.map((r) => [r.provider, r.operation, r.units])).toEqual([
      ['hunter', 'find:attempt', 0],
    ]);
    const money2 = memoryBudget();
    const h2 = fakeHunter(() => ({
      email: 'maya@stripe.com',
      score: 95,
      verification: { status: 'valid' },
      sources: [],
    }));
    await emailLookup({ userId: 'u', hunter: h2.hunter, budget: money2.budget, cache: memorySharedCache() })(
      maya,
    );
    expect(money2.ledger.map((r) => [r.provider, r.operation, r.units])).toEqual([['hunter', 'find', 1]]);
  });

  it('with a reserving budget the credit is held before the call and settled after', async () => {
    const events: string[] = [];
    const budget = {
      check: async () => ({ ok: true as const }),
      record: async () => undefined,
      reserve: async (_u: string, e: { operation: string; units: number }) => {
        events.push(`reserve ${e.operation} ${e.units}`);
        return {
          ok: true as const,
          settle: async (a: { units: number; operation?: string }) => {
            events.push(`settle ${a.operation ?? e.operation} ${a.units}`);
          },
        };
      },
    };
    const h = fakeHunter(() => null, { 'a@x.com': 'valid' });
    const v = emailVerifier({ userId: 'u', hunter: h.hunter, budget, cache: memorySharedCache() })!;
    expect(await v('a@x.com')).toBe('valid');
    expect(events).toEqual(['reserve verify 0.5', 'settle verify 0.5']);
  });
});
