import { describe, expect, it } from 'vitest';
import { buildSchoolIndex } from '../search/schools';

describe('school short names', () => {
  const s = buildSchoolIndex([
    { name: 'Stanford University', aliases: [], kind: 1, domain: 'stanford.edu' },
    { name: 'Boston University', aliases: [], kind: 1, domain: 'bu.edu' },
    { name: 'University of Miami', aliases: [], kind: 1, domain: 'miami.edu' },
    {
      name: 'University of California, Berkeley',
      aliases: ['UC Berkeley', 'Berkeley'],
      kind: 1,
      domain: 'berkeley.edu',
    },
    { name: 'New England Law-Boston', aliases: ['Boston'], kind: 1, domain: 'nesl.edu' },
  ]);
  it('takes the short name when the site says it', () => {
    expect(s.lookup('Stanford')).toBe('Stanford University');
    expect(s.lookup('Boston')).toBeUndefined();
    expect(s.lookup('Miami')).toBeUndefined();
  });
  it('reads a unit of a school as the school', () => {
    expect(s.lookup('UC Berkeley College of Engineering')).toBe('University of California, Berkeley');
    expect(s.lookup('Stanford Graduate School of Business')).toBe('Stanford University');
  });
});
