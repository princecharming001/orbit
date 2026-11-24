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
  domainsOf,
  fillEmails,
  fromTemplate,
  isCompanyDomain,
  isRoleAddress,
  type LookupNote,
  MAX_LOOKUPS,
  MAX_VERIFIES,
  ownSiteDomain,
  withDeadline,
} from '../../../../../supabase/functions/_shared/sourcing/email';
import {
  domainTemplate,
  emailLookup,
  emailVerifier,
  linkedInEmail,
} from '../../../../../supabase/functions/_shared/sourcing/lookup';
import type { Candidate } from '../../../../../supabase/functions/_shared/sourcing/search';
import { linksFor, mailtoFit } from '../../../../../supabase/functions/_shared/sourcing/web';
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

  it('H2b no domain known for their company: by name and the company’s name, Hunter finds the domain', async () => {
    const h = fakeHunter((p) => (p.company ? ok('shubham@razorpay.com') : null));
    const look = emailLookup({ userId: 'u', hunter: h.hunter, cache: memorySharedCache() });
    const shubham = cand({
      name: 'Shubham Bisht',
      headline: 'Senior Product Manager at RazorPay (UPI payments)',
      linkedinUrl: 'https://www.linkedin.com/in/shubham-bisht',
    });
    expect(await look(shubham)).toMatchObject({ email: 'shubham@razorpay.com' });
    expect(h.finds).toEqual([
      { linkedin_handle: 'shubham-bisht' },
      { first_name: 'shubham', last_name: 'bisht', company: 'RazorPay' },
    ]);
    // nobody to ask about without a name and a company
    const none = fakeHunter(() => null);
    await emailLookup({ userId: 'u', hunter: none.hunter, cache: memorySharedCache() })(
      cand({ name: 'Emily W.', linkedinUrl: undefined }),
    );
    expect(none.finds).toEqual([]);
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
    const cs = ['Al One', 'Bo Two', 'Cy Three'].map((name) =>
      cand({ name, org: 'Beta', url: 'https://beta.io/team' }),
    );
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
    // by handle, then by name and company: two misses, no credit
    expect(money.ledger.map((r) => [r.provider, r.operation, r.units])).toEqual([
      ['hunter', 'find:attempt', 0],
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

describe('the email finding audit of 2026-11-24', () => {
  const found = (email: string): Found => ({
    email,
    score: 95,
    verification: { status: 'valid' },
    sources: [],
  });

  it('3 a news page about someone is not their company: no address is built at techcrunch.com', async () => {
    const inNews = cand({ name: 'Ana Ruiz', org: 'Acme', url: 'https://techcrunch.com/2026/11/acme-raises' });
    expect(ownSiteDomain(inNews)).toBeUndefined();
    expect(domainsOf(inNews, new Map())).toEqual([]);
    const asked: string[] = [];
    await fillEmails([inNews], {
      known: [],
      orgDomains: new Map(),
      mx: async () => true,
      template: async (d) => {
        asked.push(d);
        return '{first}.{last}';
      },
    });
    expect(inNews.email).toBeUndefined();
    expect(asked).toEqual([]);
    // their company's own team page still is
    const onOwnSite = cand({ name: 'Ana Ruiz', org: 'Acme', url: 'https://team.acme.ai/ana' });
    expect(domainsOf(onOwnSite, new Map())).toEqual(['acme.ai']);
    // and the domain the student's contacts teach comes first, whatever the page
    expect(domainsOf(inNews, new Map([['acme', 'acme.ai']]))).toEqual(['acme.ai']);
  });

  it('4 a contact’s free-mail, university or personal domain is not the company’s', () => {
    expect(isCompanyDomain('gmail.com', 'Stripe', { count: 5 })).toBe(false);
    expect(isCompanyDomain('berkeley.edu', 'Stripe', { count: 3 })).toBe(false);
    expect(isCompanyDomain('boliu.dev', 'Stripe', { count: 1 })).toBe(false);
    expect(isCompanyDomain('stripe.com', 'Stripe, Inc.', { count: 1 })).toBe(true);
    expect(isCompanyDomain('berkeley.edu', 'UC Berkeley', { count: 1 })).toBe(true);
    // a domain that does not name the company: only on the company facts, or when several contacts there use it
    expect(isCompanyDomain('squareup.com', 'Block', { count: 1 })).toBe(false);
    expect(isCompanyDomain('squareup.com', 'Block', { count: 1, facts: new Set(['squareup.com']) })).toBe(
      true,
    );
    expect(isCompanyDomain('squareup.com', 'Block', { count: 2 })).toBe(true);
  });

  it('5 a finder that did not answer is not a miss: nothing cached, the caller told, the next ask finds it', async () => {
    let up = false;
    const finds: Record<string, string>[] = [];
    const hunter = {
      configured: true,
      findEmail: async (p: Record<string, string>) => {
        finds.push(p);
        return up
          ? { ok: true, value: { data: found('maya@stripe.com') } }
          : { ok: false, kind: 'timeout', provider: 'hunter', message: 'hunter: timed out' };
      },
    } as unknown as Hunter;
    const cache = memorySharedCache();
    const look = emailLookup({ userId: 'u', hunter, cache });
    const note: LookupNote = {};
    expect(await look(maya, note)).toBeUndefined();
    expect(note.unchecked).toBe(true);
    up = true;
    expect(await look(maya)).toMatchObject({ email: 'maya@stripe.com' });
    expect(finds).toHaveLength(2);
  });

  it('5 over a cap is not a miss either; a real miss is, and is cached', async () => {
    const h = fakeHunter(() => found('maya@stripe.com'));
    const cache = memorySharedCache();
    const capped: LookupNote = {};
    const over = emailLookup({
      userId: 'u',
      hunter: h.hunter,
      budget: memoryBudget({ hunter: true }).budget,
      cache,
    });
    expect(await over(maya, capped)).toBeUndefined();
    expect(capped.unchecked).toBe(true);
    // the next student, under the cap, is not told "not found" from the cache
    expect(await emailLookup({ userId: 'u2', hunter: h.hunter, cache })(maya)).toMatchObject({
      email: 'maya@stripe.com',
    });

    const none = fakeHunter(() => null);
    const missed: LookupNote = {};
    const cache2 = memorySharedCache();
    const look = emailLookup({ userId: 'u', hunter: none.hunter, cache: cache2 });
    expect(await look(maya, missed)).toBeUndefined();
    expect(missed.unchecked).toBeUndefined();
    const asks = none.finds.length;
    await look(maya);
    expect(none.finds).toHaveLength(asks);
  });

  it('5 a company pattern Hunter could not be asked for says so', async () => {
    const hunter = {
      configured: true,
      domainPattern: async () => ({ ok: false, kind: 'timeout', provider: 'hunter', message: 'timed out' }),
    } as unknown as Hunter;
    const t = domainTemplate({ userId: 'u', hunter, cache: memorySharedCache() })!;
    const note: LookupNote = {};
    expect(await t('beta.io', note)).toBeUndefined();
    expect(note.unchecked).toBe(true);
  });

  it('6 a guessed address does not teach its pattern to the next person at the company', async () => {
    const acme = new Map([['acme', 'acme.ai']]);
    const a = cand({ name: 'Ana Ruiz', org: 'Acme', email: 'aruiz@acme.ai', emailConfidence: 'guess' });
    const b = cand({ name: 'Bo Liu', org: 'Acme' });
    await fillEmails([a, b], { known: [], orgDomains: acme });
    expect(b.email).toBeUndefined();
    // a finder's own guess for the first person teaches nothing either
    const c = cand({ name: 'Cy Park', org: 'Acme', linkedinUrl: 'https://www.linkedin.com/in/cy-park' });
    const d = cand({ name: 'Di Wu', org: 'Acme' });
    await fillEmails([c, d], {
      known: [],
      orgDomains: acme,
      lookup: async (x) =>
        x.name === 'Cy Park' ? { email: 'cpark@acme.ai', source: 'apollo', status: 'guess' } : undefined,
    });
    expect(c.emailConfidence).toBe('guess');
    expect(d.email).toBeUndefined();
  });

  it('7 Apollo is verified only on "verified" at the person’s company; its locked placeholder is nothing', async () => {
    const ask = async (answer: { email?: string; email_status?: string }, c = maya) => {
      const ap = fakeApollo(() => answer);
      return emailLookup({ userId: 'u', apollo: ap.apollo, cache: memorySharedCache() })(c);
    };
    expect(await ask({ email: 'maya.chen@stripe.com', email_status: 'verified' })).toMatchObject({
      status: 'verified',
    });
    // no status at all used to read as verified
    expect(await ask({ email: 'maya.chen@stripe.com' })).toMatchObject({ status: 'guess' });
    expect(await ask({ email: 'maya.chen@stripe.com', email_status: 'likely to engage' })).toMatchObject({
      status: 'guess',
    });
    // "verified" at an old employer's domain is not her address at Stripe
    expect(await ask({ email: 'maya@oldjob.io', email_status: 'verified' })).toMatchObject({
      email: 'maya@oldjob.io',
      status: 'guess',
    });
    expect(await ask({ email: 'email_not_unlocked@domain.com', email_status: 'verified' })).toBeUndefined();
  });

  it('9 a connection’s contact email can be asked for on its own, before anything is built', async () => {
    const li = fakeUnipile(['Maya.Chen@stripe.com']);
    const deps = { userId: 'u', unipile: li.unipile, unipileAccountId: 'acc', cache: memorySharedCache() };
    expect(await linkedInEmail(deps)(cand({ ...maya, networkDistance: 1 }))).toEqual({
      email: 'maya.chen@stripe.com',
      source: 'linkedin',
      status: 'verified',
    });
    // not a connection: the profile is not viewed
    expect(await linkedInEmail(deps)(cand({ ...maya, networkDistance: 2 }))).toBeUndefined();
    expect(li.calls).toHaveLength(1);
  });

  it('10 two people who share a last name: a mailto goes to the one whose first name or initial it carries', () => {
    const people = [{ name: 'Wei Zhang' }, { name: 'Li Zhang' }, { name: 'Raj Patel' }];
    const anchors = [
      { href: 'mailto:lzhang@lab.example.edu', text: 'Email' },
      { href: 'mailto:zhang-lab@lab.example.edu', text: 'Lab' },
      { href: 'mailto:rpatel@lab.example.edu', text: 'Email' },
    ];
    const links = linksFor(anchors, people, 'https://lab.example.edu/people');
    expect(links.get('Li Zhang')?.email).toBe('lzhang@lab.example.edu');
    expect(links.get('Wei Zhang')?.email).toBeUndefined();
    expect(links.get('Raj Patel')?.email).toBe('rpatel@lab.example.edu');
    // a bare last name fits both Zhangs equally: nobody gets it; a single Zhang would
    const bare = [{ href: 'mailto:zhang@lab.example.edu', text: 'Email' }];
    expect(linksFor(bare, people, 'https://lab.example.edu/people').get('Wei Zhang')?.email).toBeUndefined();
    expect(
      linksFor(bare, [{ name: 'Wei Zhang' }], 'https://lab.example.edu/people').get('Wei Zhang')?.email,
    ).toBe('zhang@lab.example.edu');
    expect(mailtoFit('weizhang', 'wei', 'zhang')).toBeGreaterThan(mailtoFit('wzhang', 'wei', 'zhang'));
    expect(mailtoFit('lzhang', 'wei', 'zhang')).toBe(0);
  });

  it('12 a shared inbox is never a person’s address, from a finder, LinkedIn or a page', async () => {
    for (const e of ['info@acme.ai', 'Hello@acme.ai', 'support@acme.ai', 'founders@acme.ai'])
      expect(isRoleAddress(e)).toBe(true);
    expect(isRoleAddress('maya.chen@acme.ai')).toBe(false);
    expect(isRoleAddress('infante@acme.ai')).toBe(false);

    // LinkedIn: her own address is taken, the company inbox beside it is not
    const both = fakeUnipile(['info@stripe.com', 'maya@stripe.com']);
    const li = (u: typeof both) =>
      emailLookup({ userId: 'u', unipile: u.unipile, unipileAccountId: 'acc', cache: memorySharedCache() });
    expect(await li(both)(cand({ ...maya, networkDistance: 1 }))).toMatchObject({ email: 'maya@stripe.com' });
    expect(
      await li(fakeUnipile(['hello@stripe.com']))(cand({ ...maya, networkDistance: 1 })),
    ).toBeUndefined();

    // finders
    const h = fakeHunter(() => found('info@stripe.com'));
    expect(
      await emailLookup({ userId: 'u', hunter: h.hunter, cache: memorySharedCache() })(maya),
    ).toBeUndefined();
    const ap = fakeApollo(() => ({ email: 'support@stripe.com', email_status: 'verified' }));
    expect(
      await emailLookup({ userId: 'u', apollo: ap.apollo, cache: memorySharedCache() })(maya),
    ).toBeUndefined();

    // a page: the office inbox printed beside a professor, and a mailto to it
    const prof = cand({ name: 'Sam Office', org: 'Acme', email: 'office@acme.ai' });
    await fillEmails([prof], { known: [], orgDomains: new Map() });
    expect(prof.email).toBeUndefined();
    expect(prof.emailConfidence).toBeUndefined();
    const links = linksFor(
      [{ href: 'mailto:office@acme.ai', text: 'Email' }],
      [{ name: 'Sam Office' }],
      'https://acme.ai/team',
    );
    expect(links.get('Sam Office')?.email).toBeUndefined();
  });
});
