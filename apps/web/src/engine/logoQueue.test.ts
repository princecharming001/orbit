/**
 * Company logos straight from LinkedIn, for the companies the student sees: tiles without one ask, the queue sends
 * names in batches to Orbit's shared company list (which answers companies anyone found before for free), and keeps
 * each company's id and logo on its organisation. LinkedIn's answer is the only source. Plan 35 B4: a company no tile
 * showed is never sent (the server's weekly sweep fills the shared list for the network's big companies).
 */
import type { User } from '@orbit/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import type { CompanyAnswer } from '../integrations/enrichmentProxy';
import { refreshLogos } from './enrichment/logos';
import {
  type CompanySource,
  fetchLogos,
  LOGO_BATCH,
  LOGO_GAP_MS,
  LOGO_PULL_EVERY_MS,
  LOGO_RETRY_MS,
  pullKnownLogos,
  resetLogoQueueForTests,
  setLogoJitterForTests,
  wantCompanyLogo,
} from './logoQueue';
import { upsertOrganization } from './people';

const NOW = new Date('2026-11-12T12:00:00Z');
const user = { id: 'u1' } as User;
const kept = (slug: string) => `https://store.test/company-logos/${slug}.png`;
const later = (ms: number) => new Date(NOW.getTime() + ms);

/** The shared company list: a few companies it knows, one name LinkedIn has twice of. */
function shared(
  over: Partial<{ stopped: 'limit' | 'throttled' }> = {},
): CompanySource & { calls: string[][] } {
  const calls: string[][] = [];
  const known: Record<string, CompanyAnswer> = {
    nozomio: {
      status: 'found',
      companyId: '9001',
      name: 'Nozomio',
      publicIdentifier: 'nozomio',
      logoUrl: kept('nozomio'),
    },
    'folk.app': {
      status: 'found',
      companyId: '9002',
      name: 'folk',
      publicIdentifier: 'folkapp',
      logoUrl: kept('folk'),
    },
    stripe: {
      status: 'found',
      companyId: '2135371',
      name: 'Stripe',
      publicIdentifier: 'stripe',
      logoUrl: kept('stripe'),
    },
    nova: { status: 'ambiguous' },
  };
  return {
    calls,
    async byNames(names) {
      calls.push(names);
      const companies: Record<string, CompanyAnswer> = {};
      for (const n of names) companies[n] = known[n.toLowerCase()] ?? { status: 'not_found' };
      return { ok: true, value: { companies, pending: 0, ...over } };
    },
  };
}

async function person(org: string, n = 1) {
  for (let i = 0; i < n; i++)
    await db.people.add({
      id: `p_${org}_${i}`,
      userId: user.id,
      displayName: `Someone ${i}`,
      firstName: 'Someone',
      isHuman: true,
      emails: [],
      sources: ['linkedin_csv'],
      currentOrganizationRaw: org,
      strength: 0,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    } as never);
}

beforeEach(async () => {
  await wipeDatabase();
  resetLogoQueueForTests();
  setLogoJitterForTests(() => 0);
});

describe('logo queue', () => {
  it('keeps the LinkedIn id, public name and a logo that does not expire for each company found', async () => {
    const source = shared();
    wantCompanyLogo('Nozomio');
    const r = await fetchLogos(user, { now: NOW, source });
    expect(r.step).toBe('asked');
    const org = (await db.organizations.toArray()).find((o) => o.name === 'Nozomio')!;
    expect(org.linkedinCompanyId).toBe('9001');
    expect(org.logoUrl).toBe(kept('nozomio'));
  });

  it('sends only the companies tiles showed, never the rest of the network', async () => {
    const source = shared();
    await person('Stripe', 3);
    await person('folk.app', 1);
    await person('Initech', 5);
    await person('UC Berkeley', 9); // a school: its own site icon stands in
    wantCompanyLogo('Nozomio');
    wantCompanyLogo('Stripe');
    wantCompanyLogo('UC Berkeley');
    await fetchLogos(user, { now: NOW, source });
    expect(source.calls.map((c) => [...c].sort())).toEqual([['Nozomio', 'Stripe']]);
    // both now have their logo, and nobody showed folk.app or Initech: nothing is sent again
    const again = await fetchLogos(user, { now: later(LOGO_GAP_MS + 1), source });
    expect(again.step).toBe('idle');
    expect(source.calls.flat()).not.toContain('Initech');
  });

  it('remembers companies shown in an earlier visit', async () => {
    const source = shared();
    wantCompanyLogo('Nova');
    wantCompanyLogo('folk.app');
    // the visit ends before the queue ran: the next visit still knows they were shown
    const first = await fetchLogos(user, {
      now: NOW,
      source: { byNames: async () => ({ ok: false, reason: 'error', message: 'down' }) },
    });
    expect(first.step).toBe('asked');
    resetLogoQueueForTests();
    await fetchLogos(user, { now: later(LOGO_GAP_MS * 3), source });
    expect(source.calls.map((c) => [...c].sort())).toEqual([['Nova', 'folk.app']]);
  });

  it('sends at most one batch of names a call, and waits between calls', async () => {
    const source = shared();
    for (let i = 0; i < LOGO_BATCH + 10; i++) wantCompanyLogo(`Company ${i}`);
    await fetchLogos(user, { now: NOW, source });
    expect(source.calls[0]).toHaveLength(LOGO_BATCH);
    expect((await fetchLogos(user, { now: later(1000), source })).step).toBe('wait');
  });

  it('leaves a name LinkedIn cannot pin down to its initials, and sends it again only after two weeks', async () => {
    const source = shared();
    wantCompanyLogo('Nova');
    await fetchLogos(user, { now: NOW, source });
    expect((await db.organizations.toArray()).some((o) => o.logoUrl)).toBe(false);
    wantCompanyLogo('Nova');
    expect((await fetchLogos(user, { now: later(LOGO_GAP_MS * 3), source })).step).toBe('idle');
    wantCompanyLogo('Nova');
    await fetchLogos(user, { now: later(LOGO_RETRY_MS + 1), source });
    expect(source.calls.at(-1)).toEqual(['Nova']);
  });

  it('a company LinkedIn found without a logo is not asked again by name or by id for a while (plan 34 B6)', async () => {
    const calls: string[][] = [];
    const source: CompanySource = {
      async byNames(names) {
        calls.push(names);
        const companies: Record<string, CompanyAnswer> = {};
        for (const n of names)
          companies[n] = { status: 'found', companyId: '7001', name: n, publicIdentifier: 'plain' };
        return { ok: true, value: { companies, pending: 0 } };
      },
    };
    wantCompanyLogo('Plain Co');
    await fetchLogos(user, { now: NOW, source });
    expect(calls).toEqual([['Plain Co']]);
    wantCompanyLogo('Plain Co');
    expect((await fetchLogos(user, { now: later(LOGO_GAP_MS * 3), source })).step).toBe('idle');
    // the refresh by id skips it too: LinkedIn answered for it this week
    const org = (await db.organizations.toArray()).find((o) => o.linkedinCompanyId === '7001')!;
    let byId = 0;
    await refreshLogos(
      [org.id],
      async () => {
        byId++;
        return { ok: false };
      },
      { now: later(60_000), limit: 5 },
    );
    expect(byId).toBe(0);
  });

  it('slows down when the day’s company reads are used, and pauses when LinkedIn says so', async () => {
    const tired = shared({ stopped: 'limit' });
    wantCompanyLogo('Acme');
    await fetchLogos(user, { now: NOW, source: tired });
    wantCompanyLogo('Globex');
    expect((await fetchLogos(user, { now: later(LOGO_GAP_MS * 2 + 1), source: tired })).step).toBe('wait');
    const slow = shared({ stopped: 'throttled' });
    wantCompanyLogo('Initech');
    await fetchLogos(user, { now: later(31 * 60_000), source: slow });
    wantCompanyLogo('Umbrella');
    expect((await fetchLogos(user, { now: later(32 * 60_000), source: slow })).step).toBe('paused');
  });

  it('does nothing without a LinkedIn to ask', async () => {
    wantCompanyLogo('Nozomio');
    expect((await fetchLogos(user, { now: NOW })).step).toBe('off');
  });

  it('brings what the shared list knows for every company without a logo, free, the busiest first', async () => {
    const calls: { names: string[]; resolve?: number }[] = [];
    const base = shared();
    const source: CompanySource = {
      byNames: async (names, o) => {
        calls.push({ names, resolve: o?.resolve });
        return base.byNames(names, o);
      },
    };
    for (const n of ['Initech', 'Stripe', 'Nozomio', 'Stanford University']) await upsertOrganization(n);
    const stripe = (await db.organizations.where('nameNormalized').equals('stripe').first())!;
    for (let i = 0; i < 3; i++)
      await db.people.add({
        id: `s${i}`,
        userId: user.id,
        displayName: 'S',
        isHuman: true,
        emails: [],
        sources: [],
        currentOrganizationId: stripe.id,
        strength: 0,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      } as never);
    expect(await pullKnownLogos(user, { now: NOW, source })).toBe(2);
    // never a LinkedIn read (resolve 0), never the school, Stripe (3 people) first
    expect(calls).toHaveLength(1);
    expect(calls[0]!.resolve).toBe(0);
    expect(calls[0]!.names[0]).toBe('Stripe');
    expect(calls[0]!.names).not.toContain('Stanford University');
    expect((await db.organizations.get(stripe.id))!.logoUrl).toBe(kept('stripe'));
    // within the next few hours: nothing is asked again; after, only the ones still without a logo
    await pullKnownLogos(user, { now: later(60_000), source });
    expect(calls).toHaveLength(1);
    await pullKnownLogos(user, { now: later(LOGO_PULL_EVERY_MS + 1), source });
    expect(calls[1]!.names).toEqual(['Initech']);
  });

  it('asks again for a company whose LinkedIn link expired, and sends LinkedIn’s id when a profile gave one', async () => {
    const seen: { names: string[]; ids?: Record<string, string> }[] = [];
    const source: CompanySource = {
      byNames: async (names, o) => {
        seen.push({ names, ids: o?.ids });
        return shared().byNames(names, o);
      },
    };
    const org = (await upsertOrganization('Stripe'))!;
    await db.organizations.update(org.id, {
      linkedinCompanyId: '2135371',
      logoUrl: 'https://media.licdn.com/dms/image/v2/x/company-logo_200_200?e=1700000000&t=y',
    });
    wantCompanyLogo('Stripe');
    await fetchLogos(user, { now: NOW, source });
    expect(seen[0]).toEqual({ names: ['Stripe'], ids: { Stripe: '2135371' } });
    expect((await db.organizations.get(org.id))!.logoUrl).toBe(kept('stripe'));
  });
});
