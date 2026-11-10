/**
 * Which LinkedIn page a company name means (plan 37, the student's rule: a logo is that exact company's, or none).
 * The live cases are LinkedIn's real answers; the old rules took a fan page for NASA, a club page for SJSU and the
 * page at /company/smith for anyone's "Smith".
 */
import { describe, expect, it } from 'vitest';
import { chooseCompany, namesCompany } from '../../functions/_shared/providers/linkedinCompanies.ts';
import { LIVE_SEARCH } from '../fixtures/linkedin-company-search.ts';

const pick = (name: string, items = LIVE_SEARCH[name]!) => {
  const c = chooseCompany(items, name);
  return 'id' in c ? c.id : c.reason;
};

describe('chooseCompany on LinkedIn’s real answers', () => {
  it('NASA is the agency’s own page, not the fan page called exactly "NASA"', () => {
    expect(pick('NASA')).toBe('2003');
  });
  it('SJSU is San José State University (its initials), not a club or a department', () => {
    expect(pick('SJSU')).toBe('157344');
  });
  it('a name several companies share is left for a person’s position or the student to settle', () => {
    expect(pick('Triumph')).toBe('ambiguous');
    expect(pick('Smith')).toBe('ambiguous');
    expect(pick('Nova')).toBe('ambiguous');
    const t = chooseCompany(LIVE_SEARCH.Triumph!, 'Triumph');
    expect('sameIds' in t && t.sameIds).toEqual(['74900938', '50454', '1515366']);
  });
  it('the second live batch: plain names taken, shared names left, nothing guessed', () => {
    expect(pick('Google')).toBe('1441');
    expect(pick('Tesla')).toBe('15564');
    expect(pick('Compass')).toBe('2866215');
    // several pages called Mercury, Pigeon, Moonshot: none taken
    for (const n of ['Mercury', 'Pigeon', 'Moonshot']) expect([n, pick(n)]).toEqual([n, 'ambiguous']);
    // a newer page also called Apple: left unsettled for a new name (the shared list keeps Apple from before, and a
    // person's position or the student's pick settles it); "Dell" answers as Dell Technologies, which is not the name
    expect(pick('Apple')).toBe('ambiguous');
    expect(pick('Dell')).toBe('not_found');
  });

  it('follower counts decide nothing (LinkedIn cuts them to three digits)', () => {
    const items = [
      { id: '9', name: 'Acme', followers_count: 3 },
      { id: '50000', name: 'Acme', followers_count: 999 },
    ];
    // the first page is the long-established one and the other is far newer: Acme is the first
    expect(pick('Acme', items)).toBe('9');
    // the same two pages the other way round: the first is newer than the other, so nothing is taken
    expect(pick('Acme', [items[1]!, items[0]!])).toBe('ambiguous');
  });
});

describe('chooseCompany on the shapes that matter', () => {
  it('one page with the name: taken', () => {
    expect(pick('Benchling', [{ id: '3769390', name: 'Benchling', followers_count: 1 }])).toBe('3769390');
  });
  it('Tesla beside fan pages of the same name: the long-established page', () => {
    expect(
      pick('Tesla', [
        { id: '15564', name: 'Tesla', followers_count: 1 },
        { id: '99000001', name: 'Tesla', followers_count: 999 },
        { id: '88000002', name: 'Tesla Fans', followers_count: 1 },
      ]),
    ).toBe('15564');
  });
  it('a first result about something else: the one page with exactly the name, if there is one', () => {
    expect(
      pick('Lekko', [
        { id: '1', name: 'Lekko Studio', followers_count: 1 },
        { id: '89778399', name: 'Lekko', followers_count: 1 },
      ]),
    ).toBe('89778399');
    expect(pick('Zzyzx', [{ id: '1', name: 'Something Else', followers_count: 1 }])).toBe('not_found');
    expect(pick('Zzyzx', [])).toBe('not_found');
  });
  it('a YC page written with its batch counts as the same name, so a namesake beside it is not taken', () => {
    expect(
      pick('Aden', [
        { id: '727424', name: 'ADEN', followers_count: 1 },
        { id: '30000000', name: 'Aden (YC W20)', followers_count: 1 },
      ]),
    ).toBe('ambiguous');
  });
  it('results without a usable id are skipped', () => {
    expect(
      pick('Acme', [{ id: 'x', name: 'Acme' } as never, { id: '42', name: 'Acme', followers_count: 1 }]),
    ).toBe('42');
  });
});

describe('namesCompany', () => {
  it('the same name, the name LinkedIn writes it under, or its initials', () => {
    expect(namesCompany('Ramp', 'ramp')).toBe(true);
    expect(namesCompany('NASA - National Aeronautics and Space Administration', 'NASA')).toBe(true);
    expect(namesCompany('Amazon Web Services (AWS)', 'AWS')).toBe(true);
    expect(namesCompany('San José State University', 'SJSU')).toBe(true);
    expect(namesCompany('University of California, Riverside', 'UCR')).toBe(true);
  });
  it('a different company that only starts with the name is not it', () => {
    expect(namesCompany('NASA Jet Propulsion Laboratory', 'NASA')).toBe(false);
    expect(namesCompany('Smith & Wesson', 'Smith')).toBe(false);
    expect(namesCompany('Fashion Nova', 'Nova')).toBe(false);
    // two letters are never initials enough
    expect(namesCompany('Ernst Young', 'EY')).toBe(false);
  });
});
