import { describe, expect, it } from 'vitest';
import { isRecruiter } from '../drafts/sector';
import { looksLikeHeadline, roleFromHeadline } from '../linkedin/headline';

describe('roleFromHeadline', () => {
  it('reads the role from the first part only', () => {
    expect(roleFromHeadline('Product @ Google | Growing Ads for SMBs at scale')).toEqual({
      title: 'Product',
      org: 'Google',
    });
    expect(roleFromHeadline('Sr. Product Manager | Google | AI Infrastructure')).toEqual({
      title: 'Sr. Product Manager',
    });
    expect(roleFromHeadline('Product Manager at Google · Bengaluru')).toEqual({
      title: 'Product Manager',
      org: 'Google',
    });
    expect(roleFromHeadline('Product @Google | Certifications don’t move careers')).toEqual({
      title: 'Product',
      org: 'Google',
    });
    expect(roleFromHeadline('APM @ YouTube')).toEqual({ title: 'APM', org: 'YouTube' });
    expect(roleFromHeadline(undefined)).toEqual({});
  });

  it('a company ends at the next clause', () => {
    expect(roleFromHeadline('Intern at Google, CS @ Berkeley')).toEqual({ title: 'Intern', org: 'Google' });
    expect(roleFromHeadline('Software Engineer at Stripe; ex-Square')).toEqual({
      title: 'Software Engineer',
      org: 'Stripe',
    });
    expect(roleFromHeadline('Analyst at Moelis & Company (prev. JPM)')).toEqual({
      title: 'Analyst',
      org: 'Moelis & Company',
    });
  });

  it('a past, future or wished-for role is not where they are now', () => {
    for (const h of [
      'Former Analyst at Goldman Sachs',
      'Formerly @ McKinsey | Building something new',
      'Ex-Google, now exploring',
      'ex Meta PM',
      'Previously at Bain',
      'Incoming SWE Intern @ Meta',
      'Aspiring Product Manager',
      'Seeking Summer 2027 internships',
      'Open to work',
    ])
      expect(roleFromHeadline(h), h).toEqual({ notCurrent: true });
    // a word that only starts like one is not
    expect(roleFromHeadline('Executive Director at Code2040')).toEqual({
      title: 'Executive Director',
      org: 'Code2040',
    });
  });

  it('tells a headline from a job title', () => {
    expect(looksLikeHeadline('Product @ Google | Growing Ads')).toBe(true);
    expect(looksLikeHeadline('Analyst at Goldman Sachs')).toBe(true);
    expect(looksLikeHeadline('PM @Stripe')).toBe(true);
    expect(looksLikeHeadline('Former Analyst')).toBe(true);
    expect(looksLikeHeadline('Senior Software Engineer')).toBe(false);
    expect(looksLikeHeadline('Associate, M&A')).toBe(false);
    expect(looksLikeHeadline(undefined)).toBe(false);
  });
});

describe('isRecruiter', () => {
  it('reads recruiting titles as whole titles, not words anywhere', () => {
    for (const t of [
      'Recruiter',
      'Technical Recruiter',
      'Campus Recruiter',
      'University Recruiting Lead',
      'Recruiting Coordinator',
      'Talent Acquisition Partner',
      'Head of Talent',
      'Technical Sourcer',
      'Early Careers Program Manager',
      'HR Business Partner',
      'Senior HR Generalist',
      'People Partner',
      'University Relations',
    ])
      expect(isRecruiter(t), t).toBe(true);
    for (const t of [
      'Campus Ambassador',
      'Strategic Sourcing Analyst',
      'Sourcing Manager, Procurement',
      'Recruitment Chair',
      'Software Engineer, Talent Platform',
      'HRIS Analyst',
      'Product Manager',
      undefined,
    ])
      expect(isRecruiter(t), String(t)).toBe(false);
  });
});

describe('isKnownContact for people kept on Orbit server', () => {
  it('counts the server tie score when there is no local history', async () => {
    const { isKnownContact } = await import('../scoring/known');
    const base = {
      firstName: 'Priya',
      lastName: 'Shah',
      displayName: 'Priya Shah',
      isHuman: true,
      sources: [],
    };
    expect(isKnownContact({ ...base, tieScore: 78 })).toBe(true);
    expect(isKnownContact({ ...base, tieScore: 0 })).toBe(false);
    expect(isKnownContact({ ...base, sources: ['gmail'], tieScore: 78 })).toBe(true);
    // scored here in the browser: the local history decides, and inbound-only mail is not a relationship
    expect(
      isKnownContact({
        ...base,
        sources: ['gmail'],
        tieScore: 20,
        strengthBreakdown: { counts: { email_in: 4 } } as never,
      }),
    ).toBe(false);
  });
});
