import { describe, expect, it } from 'vitest';
import { parseConnectionsCsv } from '../linkedin/csv';
import { isAutomatedSender, splitSignature, stripQuotedReply } from '../text/email';
import { jaroWinkler } from '../text/jaro';
import {
  canonicalFirstName,
  firstNameRelation,
  initials,
  linkedInSlug,
  nameFromEmailLocal,
  nameFromParts,
  normalizeCompany,
  normalizeEmail,
  normalizeLinkedInUrl,
  parseName,
} from '../text/normalize';
import { MESSY_CONNECTIONS_CSV, MESSY_CONNECTIONS_EXPECT } from './fixtures/connections-messy';

describe('normalizeEmail', () => {
  it('lowercases and strips gmail dots and plus tags', () => {
    expect(normalizeEmail('John.Doe+recruiting@Gmail.com')).toBe('johndoe@gmail.com');
    expect(normalizeEmail('John.Doe@Stripe.com')).toBe('john.doe@stripe.com');
    expect(normalizeEmail('Priya Patel <priya@figma.com>')).toBe('priya@figma.com');
  });
});

describe('parseName', () => {
  it('handles honorifics, credentials, pronouns and Last, First', () => {
    expect(parseName('Dr. Priya Patel, PhD (she/her)').normalized).toBe('priya patel');
    expect(parseName('Patel, Priya').full).toBe('Priya Patel');
    expect(initials('priya patel')).toBe('PP');
    expect(canonicalFirstName('Mike')).toBe('michael');
  });
});

describe('linkedin urls', () => {
  it('normalizes variants', () => {
    expect(normalizeLinkedInUrl('linkedin.com/in/Priya-Patel/?trk=x')).toBe(
      'https://www.linkedin.com/in/priya-patel',
    );
    expect(linkedInSlug('https://www.linkedin.com/in/priya-patel')).toBe('priya-patel');
    expect(normalizeLinkedInUrl('https://example.com/in/x')).toBeUndefined();
  });
});

describe('normalizeCompany', () => {
  it('strips legal suffixes and articles', () => {
    expect(normalizeCompany('Stripe, Inc.')).toBe('stripe');
    expect(normalizeCompany('The Boston Consulting Group LLC')).toBe('boston consulting group');
  });
});

describe('jaroWinkler', () => {
  it('scores similar names highly', () => {
    expect(jaroWinkler('priya patel', 'priya patel')).toBe(1);
    expect(jaroWinkler('priya patel', 'priya patil')).toBeGreaterThan(0.9);
    expect(jaroWinkler('priya patel', 'daniel kim')).toBeLessThan(0.6);
  });
});

describe('email heuristics', () => {
  it('detects automated senders', () => {
    expect(isAutomatedSender('noreply@linkedin.com')).toBe(true);
    expect(isAutomatedSender('jobs-noreply@foo.com')).toBe(true);
    expect(isAutomatedSender('priya@figma.com', { 'list-unsubscribe': '<x>' })).toBe(true);
    expect(isAutomatedSender('priya@figma.com')).toBe(false);
  });
  it('strips quoted replies', () => {
    const body =
      'Sounds good, Thursday works.\n\nOn Tue, Mar 3, 2026 at 9:00 AM Alex <alex@cornell.edu> wrote:\n> Hi Priya\n> ...';
    expect(stripQuotedReply(body)).toBe('Sounds good, Thursday works.');
  });
  it('splits signatures and extracts title/company', () => {
    const r = splitSignature(
      'Happy to chat.\n\nBest,\nPriya\nProduct Manager | Figma\n+1 (415) 555-0100\nlinkedin.com/in/priya-patel',
    );
    expect(r.body).toBe('Happy to chat.');
    expect(r.title).toBe('Product Manager');
    expect(r.company).toBe('Figma');
    expect(r.linkedinUrl).toContain('linkedin.com/in/priya-patel');
  });
});

describe('parseName on messy real-world names', () => {
  it('strips generational suffixes instead of greeting "Jr"', () => {
    expect(parseName('Sam Lee, Jr.')).toMatchObject({ first: 'Sam', last: 'Lee', full: 'Sam Lee' });
    expect(parseName('Smith, John, Jr.')).toMatchObject({ first: 'John', last: 'Smith' });
    expect(parseName('John Smith Jr.').normalized).toBe('john smith');
    expect(parseName('John Smith III').normalized).toBe('john smith');
  });
  it('cuts company tails', () => {
    expect(parseName('Priya Patel - Figma')).toMatchObject({ first: 'Priya', last: 'Patel' });
    expect(parseName('Priya Patel – Figma')).toMatchObject({ first: 'Priya', last: 'Patel' });
    expect(parseName('Priya Patel, Figma')).toMatchObject({ first: 'Priya', last: 'Patel' });
    expect(parseName('Priya Patel | Figma').full).toBe('Priya Patel');
    expect(parseName('Dr. Priya Patel, PhD, MBA').full).toBe('Priya Patel');
    expect(parseName('Patel, Priya (she/her)').full).toBe('Priya Patel');
  });
  it('keeps accents in the display name and drops them only from the matching key', () => {
    const n = parseName('José Núñez-García');
    expect(n.first).toBe('José');
    expect(n.full).toBe('José Núñez-García');
    expect(n.normalized).toBe('jose nunez-garcia');
    expect(parseName('Jose Nunez-Garcia').normalized).toBe(n.normalized);
  });
  it('fixes all-lowercase and all-uppercase names but keeps mixed case', () => {
    expect(parseName('tom wu').full).toBe('Tom Wu');
    expect(parseName('PRIYA PATEL').full).toBe('Priya Patel');
    expect(parseName("CHRISTOPHER O'BRIEN").full).toBe("Christopher O'Brien");
    expect(parseName('DeShawn McKinsey').full).toBe('DeShawn McKinsey');
    expect(parseName('ana de la cruz')).toMatchObject({ first: 'Ana', last: 'de la Cruz' });
    expect(parseName('Yo-Yo Ma').last).toBe('Ma');
  });
  it('builds names from separate CSV fields', () => {
    expect(nameFromParts('Sam', 'Lee, Jr.')).toMatchObject({ first: 'Sam', full: 'Sam Lee' });
    expect(nameFromParts('Maya (she/her)', 'Wu').full).toBe('Maya Wu');
    expect(nameFromParts('Priya Patel', '').full).toBe('Priya Patel');
  });
  it('derives a readable placeholder from an email address', () => {
    expect(nameFromEmailLocal('tom.wu@datadog.com')).toBe('Tom Wu');
    expect(nameFromEmailLocal('erodriguez@bain.com')).toBe('erodriguez');
  });
});

describe('messy LinkedIn CSV corpus (30 rows)', () => {
  it('parses every row into the right greeting name, display name and org key', () => {
    const { rows } = parseConnectionsCsv(MESSY_CONNECTIONS_CSV);
    expect(rows).toHaveLength(MESSY_CONNECTIONS_EXPECT.length);
    rows.forEach((r, i) => {
      const n = nameFromParts(r.firstName, r.lastName);
      const want = MESSY_CONNECTIONS_EXPECT[i]!;
      expect({ row: i, first: n.first, full: n.full }).toEqual({
        row: i,
        first: want.first,
        full: want.full,
      });
      expect({ row: i, org: normalizeCompany(r.company) }).toEqual({ row: i, org: want.org });
    });
  });
});

describe('nicknames', () => {
  it('maps real nicknames one way and keeps distinct given names apart', () => {
    expect(canonicalFirstName('Bill')).toBe('william');
    expect(canonicalFirstName('Ken')).toBe('kenneth');
    expect(canonicalFirstName('William')).toBe('william');
    expect(firstNameRelation('Bill', 'William')).toBe('nickname');
    expect(firstNameRelation('Josh', 'Joshua')).toBe('nickname');
    for (const [a, b] of [
      ['John', 'Jonathan'],
      ['Liam', 'William'],
      ['Jamie', 'James'],
      ['Sasha', 'Alexander'],
      ['Gail', 'Abigail'],
      ['Eliza', 'Elizabeth'],
      ['Nat', 'Natalie'],
      ['Alex', 'Alexandra'],
      ['Sam', 'Samantha'],
    ] as const)
      expect(firstNameRelation(a, b)).toBe('ambiguous');
    expect(firstNameRelation('Stephen', 'Steven')).toBe('different');
    expect(firstNameRelation('Catherine', 'Katherine')).toBe('different');
    expect(firstNameRelation('José', 'Jose')).toBe('same');
  });
});

describe('normalizeCompany variants', () => {
  it('collapses "& Company", dangling ampersands, legal suffixes and common aliases', () => {
    const same = [
      ['McKinsey', 'McKinsey & Company'],
      ['Bain', 'Bain & Company, Inc.'],
      ['Goldman Sachs', 'Goldman Sachs & Co. LLC'],
      ['JPMorgan', 'J.P. Morgan'],
      ['JP Morgan Chase & Co.', 'JPMorgan Chase'],
      ['PwC', 'PricewaterhouseCoopers LLP'],
      ['EY', 'Ernst & Young LLP'],
      ['AWS', 'Amazon Web Services'],
      ['BCG', 'The Boston Consulting Group'],
      ['Boston Consulting Group (BCG)', 'BCG'],
      ['Deloitte', 'Deloitte Consulting LLP'],
      ['Blackstone', 'The Blackstone Group Inc.'],
      ['Evercore', 'Evercore Partners'],
    ];
    for (const [a, b] of same) expect({ a, n: normalizeCompany(a) }).toEqual({ a, n: normalizeCompany(b) });
    expect(normalizeCompany('Goldman Sachs & Co. LLC')).toBe('goldman sachs');
    expect(normalizeCompany('Stripe')).not.toBe(normalizeCompany('Square'));
    expect(normalizeCompany('Group')).toBe('group');
  });
});
