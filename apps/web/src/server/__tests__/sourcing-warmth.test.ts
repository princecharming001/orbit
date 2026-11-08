import { describe, expect, it } from 'vitest';
import {
  dnsMx,
  fillEmails,
  learnPattern,
  nameParts,
} from '../../../../../supabase/functions/_shared/sourcing/email';
import type { Candidate } from '../../../../../supabase/functions/_shared/sourcing/search';
import {
  type StudentContext,
  sameOrg,
  studentFromResume,
  warmRank,
  warmthOf,
} from '../../../../../supabase/functions/_shared/sourcing/warmth';

const cand = (c: Partial<Candidate>): Candidate => ({
  key: c.name ?? 'k',
  entity: 'person',
  name: 'Maya Chen',
  sources: ['web'],
  externalIds: {},
  ...c,
});

const student: StudentContext = {
  school: 'University of California, Berkeley',
  orgs: ['Prosimo', 'Palo', 'University of California, Berkeley'],
  homeCity: 'San Jose, CA',
  interests: ['product management', 'sql'],
  gradYear: 2028,
};
const base = { student, warm: [], year: 2026 };

describe('warmth tiers', () => {
  it('puts someone the student has talked with first', () => {
    expect(warmthOf(cand({}), { ...base, known: { personId: 'p', score: 55 } }).tier).toBe(1);
    // a name Orbit has only seen is not "in your world"
    expect(warmthOf(cand({}), { ...base, known: { personId: 'p', score: 5 } }).tier).toBe(5);
  });

  it('finds a warm contact at the same company, by name or by work email domain', () => {
    const w = warmthOf(cand({ org: 'Stripe, Inc.' }), {
      ...base,
      warm: [{ personId: 's', name: 'Sam Lee', score: 70, org: 'Stripe' }],
    });
    expect(w).toMatchObject({ tier: 2, bridge: { personId: 's' } });
    expect(w.why).toContain('Sam');
    const byDomain = warmthOf(cand({ org: 'Acme Robotics' }), {
      ...base,
      domains: ['acme.ai'],
      warm: [{ personId: 'a', name: 'Ana Ruiz', score: 50, email: 'ana@acme.ai' }],
    });
    expect(byDomain.tier).toBe(2);
  });

  it('reads shared school, past company and hometown', () => {
    expect(warmthOf(cand({ headline: 'PM at Figma, UC Berkeley alum' }), base)).toMatchObject({ tier: 3 });
    expect(warmthOf(cand({ org: 'Prosimo', title: 'Director' }), base).why).toBe('Also worked at Prosimo');
    expect(warmthOf(cand({ location: 'San Jose, California' }), base).tier).toBe(3);
  });

  it('sees an open door, then a résumé hook, then nothing', () => {
    expect(
      warmthOf(cand({ evidence: ['Undergraduates interested in research, email me.'] }), base).tier,
    ).toBe(4);
    expect(warmthOf(cand({ headline: 'Analyst, class of 2025' }), base).tier).toBe(4);
    const hook = warmthOf(cand({ headline: 'Leads product management for payments' }), base);
    expect(hook).toMatchObject({ tier: 5 });
    expect(hook.why).toContain('product management');
    expect(warmthOf(cand({ headline: 'Geologist' }), base)).toEqual({ tier: 5 });
  });

  it('lifts by tier, scaled by fit', () => {
    expect(warmRank(0.5, 1, 1)).toBeCloseTo(1.1);
    expect(warmRank(0.5, 0, 1)).toBeCloseTo(0.74);
    expect(warmRank(0.5, 1, 5)).toBe(0.5);
  });

  it('matches org names loosely but not by accident', () => {
    expect(sameOrg('Stripe', 'Stripe, Inc.')).toBe(true);
    expect(sameOrg('Meta', 'Metabase')).toBe(false);
  });

  it('reads the résumé facets into orgs and interests', () => {
    const s = studentFromResume(
      {
        facets: [
          { kind: 'experience', org: 'Prosimo', keywords: ['Product Management'] },
          { kind: 'experience', org: 'Freelance' },
          { kind: 'experience', org: 'Hidden Co', excluded: true },
        ],
      },
      { school: 'UC Berkeley' },
    );
    expect(s.orgs).toEqual(['Prosimo']);
    expect(s.interests).toEqual(['product management']);
  });
});

describe('finding emails', () => {
  it('splits names without titles or middle names', () => {
    expect(nameParts('Dr. Maya J. Chen')).toEqual({ f: 'maya', l: 'chen' });
    expect(nameParts('Cher')).toBeUndefined();
  });

  it('learns the pattern a domain uses from known addresses', () => {
    const known = [
      { name: 'Sam Lee', email: 'slee@acme.com' },
      { name: 'Ana Ruiz', email: 'aruiz@acme.com' },
      { name: 'Bo Diaz', email: 'bo.diaz@other.com' },
    ];
    expect(learnPattern(known, 'acme.com')).toBe('flast');
    expect(learnPattern(known, 'none.com')).toBeUndefined();
  });

  it('keeps a page email, builds one from the pattern, guesses only where mail is accepted and never at a university', async () => {
    const page = cand({ name: 'Page Person', email: 'pp@x.com' });
    const pattern = cand({ name: 'Maya Chen', org: 'Acme' });
    const guess = cand({ name: 'Jo Park', org: 'Beta', url: 'https://beta.io/team' });
    const nomail = cand({ name: 'Al Kim', url: 'https://nomail.io/about' });
    const uni = cand({ name: 'Lu Wang', url: 'https://eecs.berkeley.edu/faculty/lu' });
    await fillEmails([page, pattern, guess, nomail, uni], {
      known: [
        { name: 'Sam Lee', email: 'slee@acme.com' },
        { name: 'Ana Ruiz', email: 'aruiz@acme.com' },
      ],
      orgDomains: new Map([['acme', 'acme.com']]),
      mx: async (d) => d === 'beta.io',
    });
    expect(page).toMatchObject({ email: 'pp@x.com', emailConfidence: 'page' });
    expect(pattern).toMatchObject({ email: 'mchen@acme.com', emailConfidence: 'pattern' });
    expect(guess).toMatchObject({ email: 'jo.park@beta.io', emailConfidence: 'guess' });
    expect(nomail.email).toBeUndefined();
    expect(uni.email).toBeUndefined();
  });

  it('checks MX over DNS-over-HTTPS and caches it', async () => {
    let calls = 0;
    const mx = dnsMx((async () => {
      calls++;
      return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 15 }] }));
    }) as unknown as typeof fetch);
    expect(await mx('beta.io')).toBe(true);
    expect(await mx('beta.io')).toBe(true);
    expect(calls).toBe(1);
  });
});
