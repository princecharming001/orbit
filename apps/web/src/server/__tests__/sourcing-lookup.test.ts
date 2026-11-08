/** The verified email lookup (lookup.ts): LinkedIn's own contact email first, Apollo second, cached, capped. */
import { describe, expect, it } from 'vitest';
import type { Apollo } from '../../../../../supabase/functions/_shared/providers/apollo';
import type { UnipileResearch } from '../../../../../supabase/functions/_shared/providers/unipileResearch';
import { memorySharedCache } from '../../../../../supabase/functions/_shared/research/web';
import { fillEmails } from '../../../../../supabase/functions/_shared/sourcing/email';
import { emailLookup } from '../../../../../supabase/functions/_shared/sourcing/lookup';
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
