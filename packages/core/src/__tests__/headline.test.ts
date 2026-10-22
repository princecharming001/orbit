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
