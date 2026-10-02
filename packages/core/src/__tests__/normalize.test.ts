import { describe, expect, it } from 'vitest';
import { isAutomatedSender, splitSignature, stripQuotedReply } from '../text/email';
import { jaroWinkler } from '../text/jaro';
import {
  canonicalFirstName,
  initials,
  linkedInSlug,
  normalizeCompany,
  normalizeEmail,
  normalizeLinkedInUrl,
  parseName,
} from '../text/normalize';

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
