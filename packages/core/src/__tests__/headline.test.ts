import { describe, expect, it } from 'vitest';
import { roleFromHeadline } from '../linkedin/headline';

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
