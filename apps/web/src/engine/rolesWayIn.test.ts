/**
 * Plan 45 §3: the way in as the Roles list reads it. Who the student knows at a company (close or not), alumni, an
 * intro through a friend; Best match is the fit plus a small step for each; the Way in filter; the search box; and
 * where the Apply button goes, in words.
 */
import type { Job, RoleMatch } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { agoWords, factsOf, payWords } from '../components/roles/RoleCards';
import {
  applyWhere,
  DEFAULT_FILTERS,
  filterMatches,
  matchesQuery,
  type RoleIntro,
  type RolePath,
  sortMatches,
  WAY_IN_BONUS,
  wayInOf,
} from './roles';

const job = (id: string, companyName: string, extra: Partial<Job> = {}): Job => ({
  id,
  source: 'greenhouse',
  externalId: id,
  companyKey: companyName.toLowerCase(),
  companyName,
  title: 'Software Engineer Intern',
  places: ['San Francisco, CA'],
  countries: ['US'],
  degrees: [],
  url: `https://boards.greenhouse.io/${companyName.toLowerCase()}/jobs/${id}`,
  firstSeenAt: '2026-11-20T00:00:00.000Z',
  ...extra,
});
const match = (id: string, company: string, score: number, extra: Partial<RoleMatch> = {}): RoleMatch => ({
  id,
  job: job(id, company),
  state: 'read',
  rank: 0,
  fit: { score, raw: score, parts: {}, weights: {}, caps: [], band: score >= 7 ? 'good' : 'stretch' },
  status: 'new',
  ...extra,
});
const NONE: RolePath = { known: [], alumni: [], level: 0 };
const known = (level: number): RolePath => ({
  known: [{ id: 'p1', name: 'Dana Whitfield', level }],
  alumni: [],
  level,
});
const alum: RolePath = { known: [], alumni: [{ id: 'p2', name: 'Ava Patel' }], level: 1 };
const intro: RoleIntro = {
  via: { id: 'p3', name: 'Kenji Mori' },
  to: { id: 'p4', name: 'Priya Shah' },
  score: 0.6,
};

describe('the way in at a company', () => {
  it('close, known, intro or none, best first', () => {
    expect(wayInOf(known(4))).toBe('close');
    expect(wayInOf(known(3))).toBe('close');
    expect(wayInOf(known(2))).toBe('known');
    expect(wayInOf(alum)).toBe('known');
    expect(wayInOf(NONE, [intro])).toBe('intro');
    // someone they know beats an intro
    expect(wayInOf(known(1), [intro])).toBe('known');
    expect(wayInOf(NONE, [])).toBe('none');
    expect(wayInOf(NONE)).toBe('none');
  });
});

describe('Best match', () => {
  const paths = new Map<string, RolePath>([
    ['stripe', known(4)],
    ['ramp', alum],
  ]);
  const intros = new Map<string, RoleIntro[]>([['figma', [intro]]]);
  const rows = [
    match('a', 'Notion', 8),
    match('b', 'Stripe', 7),
    match('c', 'Ramp', 6),
    match('d', 'Figma', 6),
    match('e', 'Linear', 5),
    match('f', 'Stripe', 4),
  ];

  it('is the fit plus a small step for the way in: a 7 with a close friend there sits above an 8 with no one', () => {
    expect(sortMatches(rows, 'best', paths, intros).map((m) => m.id)).toEqual(['b', 'a', 'c', 'd', 'f', 'e']);
    // never so much that a weak fit with a friend beats a strong one
    expect(4 + WAY_IN_BONUS.close).toBeLessThan(8);
  });

  it('best fit ignores the way in for the order; easiest way in puts it first', () => {
    expect(sortMatches(rows, 'fit', paths, intros).map((m) => m.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(sortMatches(rows, 'warmest', paths, intros).map((m) => m.id)).toEqual([
      'b',
      'f',
      'c',
      'd',
      'a',
      'e',
    ]);
  });

  it('the Way in filter: someone known, someone or an intro, or no way in yet', () => {
    const f = { ...DEFAULT_FILTERS, minFit: 1 };
    const ways = { paths, intros };
    const ids = (wayIn: typeof f.wayIn) =>
      filterMatches(rows, { ...f, wayIn }, [], ways)
        .map((m) => m.id)
        .sort();
    expect(ids('any')).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(ids('known')).toEqual(['b', 'c', 'f']);
    expect(ids('reach')).toEqual(['b', 'c', 'd', 'f']);
    expect(ids('none')).toEqual(['a', 'e']);
  });
});

describe('the search box', () => {
  it('every word is in the title, company, team, places or a skill the posting names', () => {
    const m = match('a', 'Stripe', 7, {
      job: job('a', 'Stripe', { team: 'Payments', places: ['New York, NY'] }),
      answers: {
        skills: [{ name: 'Go', need: 'must', answer: 'work', you: '', posting: '' }],
        experience: { answer: 'none', you: '', posting: '' },
        education: { answer: 'unsaid', you: '', posting: '' },
        level: { answer: 'at', you: '', posting: '' },
        caps: [],
        reason: '',
        gaps: [],
      } as unknown as RoleMatch['answers'],
    });
    expect(matchesQuery(m, '')).toBe(true);
    expect(matchesQuery(m, 'stripe')).toBe(true);
    expect(matchesQuery(m, 'payments intern')).toBe(true);
    expect(matchesQuery(m, 'new york')).toBe(true);
    expect(matchesQuery(m, 'go')).toBe(true);
    expect(matchesQuery(m, 'stripe designer')).toBe(false);
  });
});

describe('where to apply, and the card facts', () => {
  it('names the board, LinkedIn, or the site it goes to', () => {
    expect(applyWhere(job('1', 'Stripe')).words).toBe('Stripe careers, on Greenhouse');
    expect(applyWhere(job('1', 'Stripe', { applyUrl: 'https://x.test/apply' })).href).toBe(
      'https://x.test/apply',
    );
    expect(
      applyWhere(job('1', 'Acme', { source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/1' })).words,
    ).toBe('LinkedIn');
    expect(
      applyWhere(job('1', 'Acme', { source: 'posting', url: 'https://www.acme.com/careers/42' })).words,
    ).toBe('Acme careers, acme.com');
  });

  it('pay in short words, posted in short words, facts in order', () => {
    expect(payWords({ min: 52, max: 58, per: 'hour' })).toBe('$52 to $58/hr');
    expect(payWords({ min: 120000, max: 150000, per: 'year' })).toBe('$120k to $150k');
    expect(payWords({ min: 45, per: 'hour' })).toBe('$45/hr');
    expect(payWords(undefined)).toBe('');
    const now = new Date('2026-11-24T12:00:00Z');
    expect(agoWords('2026-11-24T08:00:00Z', now)).toBe('Today');
    expect(agoWords('2026-11-21T08:00:00Z', now)).toBe('3d');
    expect(agoWords('2026-11-03T08:00:00Z', now)).toBe('3w');
    const m = match('a', 'Stripe', 7, {
      job: job('a', 'Stripe', { remote: 'hybrid', level: 'intern', pay: { min: 45, per: 'hour' } }),
    });
    expect(factsOf(m)).toEqual(['San Francisco', 'Hybrid', 'Internship', '$45/hr']);
  });
});
