/**
 * Company logos straight from LinkedIn: a tile without one asks, the queue finds the company on LinkedIn by name and
 * keeps its id and logo on the organisation; LinkedIn's answer is the only source, at a bounded pace.
 */
import type { User } from '@orbit/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import type { LinkedInCompany } from '../integrations/enrichmentProxy';
import {
  type CompanySource,
  fetchOneLogo,
  LOGO_RETRY_MS,
  LOGOS_PER_DAY,
  resetLogoQueueForTests,
  setLogoJitterForTests,
  wantCompanyLogo,
} from './logoQueue';

const NOW = new Date('2026-10-25T12:00:00Z');
const user = { id: 'u1' } as User;
const logo = (slug: string) =>
  `https://media.licdn.com/dms/image/v2/${slug}/company-logo_200_200?e=2147483647&t=x`;
const later = (ms: number) => new Date(NOW.getTime() + ms);

/** A LinkedIn that knows a few companies by name, and says a name it has twice of is ambiguous. */
function linkedIn(): CompanySource & { asked: string[] } {
  const asked: string[] = [];
  const pages: Record<string, LinkedInCompany> = {
    nozomio: { id: '9001', name: 'Nozomio', publicIdentifier: 'nozomio', logoUrl: logo('nozomio') },
    'folk.app': { id: '9002', name: 'folk', publicIdentifier: 'folkapp', logoUrl: logo('folk') },
  };
  return {
    asked,
    async byName(name) {
      asked.push(name);
      const key = name.toLowerCase();
      if (key === 'nova')
        return { ok: false, reason: 'error', message: 'LinkedIn has more than one company of that name.' };
      const page = pages[key];
      return page ? { ok: true, value: page } : { ok: false, reason: 'not_found', message: 'none' };
    },
  };
}

beforeEach(async () => {
  await wipeDatabase();
  resetLogoQueueForTests();
  setLogoJitterForTests(() => 0);
});

describe('logo queue', () => {
  it('keeps the LinkedIn id, public name and logo of a company found by its name', async () => {
    const li = linkedIn();
    wantCompanyLogo('Nozomio');
    expect(await fetchOneLogo(user, { now: NOW, source: li })).toEqual({ step: 'asked', name: 'Nozomio' });
    const [org] = await db.organizations.toArray();
    expect(org).toMatchObject({
      name: 'Nozomio',
      linkedinCompanyId: '9001',
      linkedinSlug: 'nozomio',
      logoUrl: logo('nozomio'),
    });
    // nothing else waits
    expect(await fetchOneLogo(user, { now: later(60_000), source: li })).toEqual({ step: 'idle' });
  });

  it('asks the most recently shown company first, spaced out, and never one that already has a LinkedIn logo', async () => {
    const li = linkedIn();
    await db.organizations.put({
      id: 'o_folk',
      name: 'folk.app',
      nameNormalized: 'folk app',
      domains: [],
      linkedinCompanyId: '9002',
      logoUrl: logo('folk'),
    });
    wantCompanyLogo('folk.app');
    wantCompanyLogo('Nova');
    await new Promise((r) => setTimeout(r, 2));
    wantCompanyLogo('Nozomio');
    expect((await fetchOneLogo(user, { now: NOW, source: li })).name).toBe('Nozomio');
    expect((await fetchOneLogo(user, { now: later(1000), source: li })).step).toBe('wait');
    expect((await fetchOneLogo(user, { now: later(30_000), source: li })).name).toBe('Nova');
    expect(li.asked).toEqual(['Nozomio', 'Nova']);
  });

  it('leaves a name LinkedIn cannot pin down to its initials, and asks again only after two weeks', async () => {
    const li = linkedIn();
    wantCompanyLogo('Nova');
    await fetchOneLogo(user, { now: NOW, source: li });
    expect(await db.organizations.count()).toBe(0);
    wantCompanyLogo('Nova');
    expect((await fetchOneLogo(user, { now: later(86_400_000), source: li })).step).toBe('idle');
    expect((await fetchOneLogo(user, { now: later(LOGO_RETRY_MS + 1), source: li })).name).toBe('Nova');
  });

  it('stops for the day at its allowance, and when LinkedIn says the day’s reads are used', async () => {
    const li = linkedIn();
    await db.kv.put({ key: 'logos:day:u1', value: { day: '2026-10-25', used: LOGOS_PER_DAY } });
    wantCompanyLogo('Nozomio');
    expect((await fetchOneLogo(user, { now: NOW, source: li })).step).toBe('paused');
    await db.kv.delete('logos:day:u1');
    const limited: CompanySource = { byName: async () => ({ ok: false, reason: 'limit', message: 'limit' }) };
    expect((await fetchOneLogo(user, { now: NOW, source: limited })).step).toBe('paused');
    expect((await db.kv.get('logos:day:u1'))?.value).toEqual({ day: '2026-10-25', used: LOGOS_PER_DAY });
  });

  it('does nothing without a LinkedIn to ask', async () => {
    wantCompanyLogo('Nozomio');
    expect(await fetchOneLogo(user, { now: NOW })).toEqual({ step: 'off' });
  });
});
