/**
 * Plan 35 E6: the cheaper email finders (Enrow, Icypeas) and the Reoon verifier, chosen by which key is set, with
 * Hunter as the fallback. Every call goes to a mocked fetch; no real key or API is used.
 */
import { describe, expect, it } from 'vitest';
import { createEnrow } from '../../../../../supabase/functions/_shared/providers/enrow';
import { createHunter } from '../../../../../supabase/functions/_shared/providers/hunter';
import { createIcypeas } from '../../../../../supabase/functions/_shared/providers/icypeas';
import { createReoon, reoonDeliverability } from '../../../../../supabase/functions/_shared/providers/reoon';
import { memorySharedCache } from '../../../../../supabase/functions/_shared/research/web';
import {
  CREDIT_USD,
  emailLookup,
  emailVerifier,
} from '../../../../../supabase/functions/_shared/sourcing/lookup';
import type { Candidate } from '../../../../../supabase/functions/_shared/sourcing/search';
import { memoryBudget } from './fakes';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that answers each call with `answer(call)` and keeps the calls. */
function mockFetch(answer: (c: Call) => Response) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const c = { url, method: (init.method ?? 'GET').toUpperCase(), headers, body };
    calls.push(c);
    return answer(c);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const instant = async () => {};

const cand = (c: Partial<Candidate> = {}): Candidate => ({
  key: 'maya',
  entity: 'person',
  name: 'Maya Chen',
  org: 'Stripe',
  sources: ['web'],
  externalIds: {},
  ...c,
});

/** Enrow answering `email` for a find, Icypeas `email` at `certainty`, Hunter `hunterEmail`, Reoon `status`. */
function vendors(o: {
  enrow?: { email: string | null; qualification?: string };
  icypeas?: { email: string; certainty: string; status?: string };
  hunterEmail?: string | null;
  reoon?: string;
}) {
  return mockFetch((c) => {
    if (c.url === 'https://api.enrow.io/email/find/single') return json(200, { id: 'enr_1', message: 'ok' });
    if (c.url.startsWith('https://api.enrow.io/email/find/single?id='))
      return json(200, {
        email: o.enrow?.email ?? null,
        qualification: o.enrow?.qualification ?? (o.enrow?.email ? 'valid' : 'invalid'),
        credits_used: o.enrow?.email ? 1 : 0,
      });
    if (c.url === 'https://app.icypeas.com/api/email-search')
      return json(200, { success: true, item: { _id: 'icy_1', status: 'NONE' } });
    if (c.url === 'https://app.icypeas.com/api/bulk-single-searchs/read')
      return json(200, {
        success: true,
        items: [
          {
            status: o.icypeas?.status ?? (o.icypeas ? 'DEBITED' : 'DEBITED_NOT_FOUND'),
            results: {
              emails: o.icypeas ? [{ email: o.icypeas.email, certainty: o.icypeas.certainty }] : [],
            },
          },
        ],
      });
    if (c.url.startsWith('https://api.hunter.io/v2/email-finder'))
      return json(200, {
        data: o.hunterEmail ? { email: o.hunterEmail, score: 95, verification: { status: 'valid' } } : null,
      });
    if (c.url.startsWith('https://api.hunter.io/v2/email-verifier'))
      return json(200, { data: { status: 'valid' } });
    if (c.url.startsWith('https://emailverifier.reoon.com/api/v1/verify'))
      return json(200, { email: 'x', status: o.reoon ?? 'safe', is_safe_to_send: o.reoon === 'safe' });
    return json(404, {});
  });
}

const providers = (
  f: typeof globalThis.fetch,
  keys: { enrow?: boolean; icypeas?: boolean; hunter?: boolean; reoon?: boolean },
) => ({
  enrow: createEnrow({ fetch: f, apiKey: keys.enrow ? 'enrow-test' : undefined, sleep: instant }),
  icypeas: createIcypeas({ fetch: f, apiKey: keys.icypeas ? 'icypeas-test' : undefined, sleep: instant }),
  hunter: createHunter({ fetch: f, apiKey: keys.hunter ? 'hunter-test' : undefined }),
  reoon: createReoon({ fetch: f, apiKey: keys.reoon ? 'reoon-test' : undefined }),
});

describe('Enrow, Icypeas and Reoon adapters', () => {
  it('Enrow: starts a search with the key in x-api-key, then reads the result by id', async () => {
    const net = vendors({ enrow: { email: 'maya@stripe.com' } });
    const enrow = createEnrow({ fetch: net.fetch, apiKey: 'enrow-test', sleep: instant });
    const r = await enrow.findEmail({ fullname: 'Maya Chen', domain: 'stripe.com' });
    expect(r).toMatchObject({ ok: true, value: { email: 'maya@stripe.com', qualification: 'valid' } });
    expect(net.calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.enrow.io/email/find/single',
      headers: { 'x-api-key': 'enrow-test' },
      body: { fullname: 'Maya Chen', company_domain: 'stripe.com' },
    });
    expect(net.calls[1]!.url).toBe('https://api.enrow.io/email/find/single?id=enr_1');
  });

  it('Enrow: waits through a running search (202 with no body yet) and gives up after a few polls', async () => {
    let n = 0;
    const net = mockFetch((c) => {
      if (c.method === 'POST') return json(200, { id: 'enr_2' });
      n++;
      return new Response(null, { status: 202 });
    });
    const enrow = createEnrow({ fetch: net.fetch, apiKey: 'enrow-test', sleep: instant });
    expect(await enrow.findEmail({ fullname: 'Maya Chen', domain: 'stripe.com' })).toMatchObject({
      ok: false,
      kind: 'timeout',
    });
    expect(n).toBe(4);
  });

  it('Enrow: no key, nothing sent; out of credits (402) stops every later call', async () => {
    const none = mockFetch(() => json(200, {}));
    expect(
      await createEnrow({ fetch: none.fetch }).findEmail({ fullname: 'A B', domain: 'x.com' }),
    ).toMatchObject({
      ok: false,
      kind: 'unconfigured',
    });
    expect(none.calls).toHaveLength(0);
    const spent = mockFetch(() => json(402, { message: 'Insufficient credits' }));
    const enrow = createEnrow({ fetch: spent.fetch, apiKey: 'k', sleep: instant });
    await enrow.findEmail({ fullname: 'A B', domain: 'x.com' });
    expect(await enrow.findEmail({ fullname: 'C D', domain: 'x.com' })).toMatchObject({
      kind: 'budget_exceeded',
    });
    expect(spent.calls).toHaveLength(1);
  });

  it('Icypeas: the key itself in Authorization, the search then the read; the surest address wins', async () => {
    const net = mockFetch((c) =>
      c.url.endsWith('/email-search')
        ? json(200, { success: true, item: { _id: 'icy_9', status: 'NONE' } })
        : json(200, {
            success: true,
            items: [
              {
                status: 'DEBITED',
                results: {
                  emails: [
                    { email: 'm.chen@stripe.com', certainty: 'probable' },
                    { email: 'Maya@Stripe.com', certainty: 'ultra_sure' },
                  ],
                },
              },
            ],
          }),
    );
    const icy = createIcypeas({ fetch: net.fetch, apiKey: 'icypeas-test', sleep: instant });
    const r = await icy.findEmail({ firstname: 'maya', lastname: 'chen', domainOrCompany: 'stripe.com' });
    expect(r).toEqual({
      ok: true,
      value: { email: 'maya@stripe.com', certainty: 'ultra_sure', status: 'DEBITED', debited: true },
    });
    expect(net.calls[0]!.headers.authorization).toBe('icypeas-test');
    expect(net.calls[0]!.body).toEqual({
      firstname: 'maya',
      lastname: 'chen',
      domainOrCompany: 'stripe.com',
    });
    expect(net.calls[1]).toMatchObject({
      url: 'https://app.icypeas.com/api/bulk-single-searchs/read',
      body: { id: 'icy_9' },
    });
  });

  it('Icypeas: a refused search (200 with success false) and a not-found are told apart', async () => {
    const refused = mockFetch(() =>
      json(200, { success: false, validationErrors: [{ field: 'firstname' }] }),
    );
    expect(
      await createIcypeas({ fetch: refused.fetch, apiKey: 'k', sleep: instant }).findEmail({
        firstname: '',
        lastname: 'chen',
        domainOrCompany: 'stripe.com',
      }),
    ).toMatchObject({ ok: false, kind: 'invalid' });
    const net = vendors({});
    expect(
      await createIcypeas({ fetch: net.fetch, apiKey: 'k', sleep: instant }).findEmail({
        firstname: 'maya',
        lastname: 'chen',
        domainOrCompany: 'stripe.com',
      }),
    ).toMatchObject({ ok: true, value: { email: null, status: 'DEBITED_NOT_FOUND' } });
  });

  it('Reoon: power mode by GET with the key in the query; statuses map to valid, invalid and risky', async () => {
    const net = vendors({ reoon: 'safe' });
    const reoon = createReoon({ fetch: net.fetch, apiKey: 'reoon-test' });
    const r = await reoon.verifyEmail('maya@stripe.com');
    expect(r.ok).toBe(true);
    const u = new URL(net.calls[0]!.url);
    expect(u.origin + u.pathname).toBe('https://emailverifier.reoon.com/api/v1/verify');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      email: 'maya@stripe.com',
      key: 'reoon-test',
      mode: 'power',
    });
    expect(reoonDeliverability({ status: 'safe' })).toBe('valid');
    expect(reoonDeliverability({ status: 'valid' })).toBe('valid');
    for (const s of ['invalid', 'disabled', 'disposable', 'spamtrap'])
      expect(reoonDeliverability({ status: s })).toBe('invalid');
    for (const s of ['catch_all', 'role_account', 'inbox_full', 'unknown'])
      expect(reoonDeliverability({ status: s })).toBe('risky');
  });
});

describe('the finder chosen by key, Hunter as the fallback (plan 35 E6)', () => {
  const look = (
    net: ReturnType<typeof vendors>,
    keys: Parameters<typeof providers>[1],
    budget = memoryBudget(),
  ) => ({
    budget,
    lookup: emailLookup({
      userId: 'u',
      ...providers(net.fetch, keys),
      budget: budget.budget,
      cache: memorySharedCache(),
      domainOf: () => 'stripe.com',
    }),
  });
  const asked = (net: ReturnType<typeof vendors>) =>
    [...new Set(net.calls.map((c) => new URL(c.url).hostname))].sort();

  it('with an Enrow key: Enrow finds it, Hunter is never asked, and the credit is priced in the ledger', async () => {
    const net = vendors({ enrow: { email: 'maya@stripe.com' }, hunterEmail: 'other@stripe.com' });
    const { lookup, budget } = look(net, { enrow: true, icypeas: true, hunter: true });
    expect(await lookup(cand())).toEqual({ email: 'maya@stripe.com', source: 'enrow', status: 'verified' });
    expect(asked(net)).toEqual(['api.enrow.io']);
    expect(budget.ledger).toEqual([
      { userId: 'u', provider: 'enrow', operation: 'find', units: 1, costUsd: CREDIT_USD.enrow },
    ]);
  });

  it('with only an Icypeas key: Icypeas; a "probable" address is a guess', async () => {
    const net = vendors({ icypeas: { email: 'maya@stripe.com', certainty: 'probable' } });
    const { lookup, budget } = look(net, { icypeas: true, hunter: true });
    expect(await lookup(cand())).toEqual({ email: 'maya@stripe.com', source: 'icypeas', status: 'guess' });
    expect(asked(net)).toEqual(['app.icypeas.com']);
    expect(budget.ledger[0]).toMatchObject({ provider: 'icypeas', units: 1, costUsd: CREDIT_USD.icypeas });
  });

  it('the cheaper finder misses: Hunter is asked next, and the miss is kept at 0 credits as an attempt', async () => {
    const net = vendors({ enrow: { email: null }, hunterEmail: 'maya@stripe.com' });
    const { lookup, budget } = look(net, { enrow: true, hunter: true });
    expect(await lookup(cand())).toMatchObject({ email: 'maya@stripe.com', source: 'hunter' });
    expect(asked(net)).toEqual(['api.enrow.io', 'api.hunter.io']);
    expect(budget.ledger[0]).toMatchObject({
      provider: 'enrow',
      operation: 'find:attempt',
      units: 0,
      costUsd: 0,
    });
  });

  it('no Enrow or Icypeas key: Hunter alone, as before', async () => {
    const net = vendors({ hunterEmail: 'maya@stripe.com' });
    const { lookup } = look(net, { hunter: true });
    expect(await lookup(cand())).toMatchObject({ source: 'hunter' });
    expect(asked(net)).toEqual(['api.hunter.io']);
  });

  it('over the daily Enrow cap: no Enrow call', async () => {
    const net = vendors({ enrow: { email: 'maya@stripe.com' } });
    const { lookup } = look(net, { enrow: true }, memoryBudget({ enrow: true }));
    expect(await lookup(cand())).toBeUndefined();
    expect(net.calls).toHaveLength(0);
  });

  it('the verifier: Reoon with its key (Hunter not asked), Hunter without it, none with neither', async () => {
    const net = vendors({ reoon: 'invalid' });
    const both = emailVerifier({
      userId: 'u',
      ...providers(net.fetch, { reoon: true, hunter: true }),
      cache: memorySharedCache(),
    })!;
    expect(await both('maya@stripe.com')).toBe('invalid');
    expect(asked(net)).toEqual(['emailverifier.reoon.com']);
    const net2 = vendors({});
    const hunterOnly = emailVerifier({
      userId: 'u',
      ...providers(net2.fetch, { hunter: true }),
      cache: memorySharedCache(),
    })!;
    expect(await hunterOnly('maya@stripe.com')).toBe('valid');
    expect(asked(net2)).toEqual(['api.hunter.io']);
    expect(
      emailVerifier({ userId: 'u', ...providers(net2.fetch, {}), cache: memorySharedCache() }),
    ).toBeUndefined();
  });
});
