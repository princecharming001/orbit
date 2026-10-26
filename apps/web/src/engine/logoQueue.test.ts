/**
 * Company logos straight from LinkedIn, for a whole network: tiles without one ask, the queue sends names in batches
 * to Orbit's shared company list (which answers companies anyone found before for free), and keeps each company's id
 * and logo on its organisation. LinkedIn's answer is the only source.
 */
import type { User } from '@orbit/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import type { CompanyAnswer } from '../integrations/enrichmentProxy';
import {
  type CompanySource,
  fetchLogos,
  LOGO_BATCH,
  LOGO_GAP_MS,
  LOGO_RETRY_MS,
  resetLogoQueueForTests,
  setLogoJitterForTests,
  wantCompanyLogo,
} from './logoQueue';

const NOW = new Date('2026-10-25T12:00:00Z');
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

  it('sends what tiles asked for first, then the whole network by how many people work there, in one batch', async () => {
    const source = shared();
    await person('Stripe', 3);
    await person('folk.app', 1);
    await person('UC Berkeley', 9); // a school: its own site icon stands in
    wantCompanyLogo('Nozomio');
    await fetchLogos(user, { now: NOW, source });
    expect(source.calls).toEqual([['Nozomio', 'Stripe', 'folk.app']]);
    // all three now have their logo: nothing is sent again
    const again = await fetchLogos(user, { now: later(LOGO_GAP_MS + 1), source });
    expect(again.step).toBe('idle');
  });

  it('sends at most one batch of names a call, and waits between calls', async () => {
    const source = shared();
    for (let i = 0; i < LOGO_BATCH + 10; i++) await person(`Company ${i}`);
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
});
