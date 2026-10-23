import { describe, expect, it } from 'vitest';
import { companyFromEmail, pickMatch } from './enrich';

const brooke = {
  firstName: 'Brooke',
  lastName: 'Lin',
  currentOrganizationRaw: undefined,
  primaryEmail: 'brooke@corgi.com',
  emails: ['brooke@corgi.com'],
};

describe('filling in people from LinkedIn', () => {
  it('reads a company from a work address, not from a personal or school one', () => {
    expect(companyFromEmail('brooke@corgi.com')).toBe('corgi');
    expect(companyFromEmail('ana@mail.stripe.com')).toBe('stripe');
    expect(companyFromEmail('ana@gmail.com')).toBeUndefined();
    expect(companyFromEmail('ana@cornell.edu')).toBeUndefined();
  });

  it('keeps only the one result that is surely them', () => {
    const at = (name: string, headline: string, distance = 2, memberId = name) => ({
      memberId,
      name,
      headline,
      distance,
      profileUrl: `https://www.linkedin.com/in/${memberId.replace(/\s/g, '-').toLowerCase()}`,
    });
    // the same name, and their company in the headline
    expect(
      pickMatch(brooke, [at('Brooke Lin', 'Founder at Corgi'), at('Brooke Lin', 'Nurse at Kaiser')])
        ?.headline,
    ).toBe('Founder at Corgi');
    // a direct connection with the same name and nothing else in common: the student may know two Brooke Lins
    expect(pickMatch(brooke, [at('Brooke Lin', 'Designer', 1)])).toBeUndefined();
    // a direct connection in the same city
    expect(
      pickMatch({ ...brooke, location: 'Austin, TX' }, [
        { ...at('Brooke Lin', 'Designer', 1), location: 'Austin, Texas, United States' },
      ])?.name,
    ).toBe('Brooke Lin');
    // a different person, or two who could be them: nothing
    expect(pickMatch(brooke, [at('Brooke Lindsey', 'Founder at Corgi')])).toBeUndefined();
    expect(
      pickMatch(brooke, [
        at('Brooke Lin', 'Founder at Corgi', 2, 'a'),
        at('Brooke Lin', 'Engineer at Corgi', 3, 'b'),
      ]),
    ).toBeUndefined();
    expect(pickMatch(brooke, [at('Brooke Lin', 'Nurse at Kaiser')])).toBeUndefined();
  });

  it('compares names with the shared matcher: accents, nicknames and scripts, never two names that fold to nothing', () => {
    const at = (name: string, headline: string, memberId = name) => ({
      memberId,
      name,
      headline,
      distance: 2,
      profileUrl: `https://www.linkedin.com/in/${encodeURIComponent(memberId)}`,
    });
    const jose = { ...brooke, firstName: 'Jose', lastName: 'Nunez' };
    expect(pickMatch(jose, [at('José Núñez', 'Founder at Corgi')])?.name).toBe('José Núñez');
    const bill = { ...brooke, firstName: 'Bill', lastName: 'Chen' };
    expect(pickMatch(bill, [at('William Chen', 'Engineer at Corgi')])?.name).toBe('William Chen');
    const lukasz = { ...brooke, firstName: 'Łukasz', lastName: 'Żółć' };
    expect(pickMatch(lukasz, [at('Lukasz Zolc', 'Engineer at Corgi')])?.name).toBe('Lukasz Zolc');
    // two different names in one script are two names (they used to both fold to "")
    const wang = { ...brooke, firstName: '伟', lastName: '王', displayName: '王伟' };
    expect(pickMatch(wang, [at('李娜', 'Engineer at Corgi')])).toBeUndefined();
    expect(pickMatch(wang, [at('Wei Wang', 'Engineer at Corgi')])?.name).toBe('Wei Wang');
    // the headline says they work somewhere else: not them
    expect(pickMatch(brooke, [at('Brooke Lin', 'Nurse at Kaiser')])).toBeUndefined();
    // a school in the headline counts
    expect(
      pickMatch({ ...brooke, emails: [], primaryEmail: undefined, school: 'Cornell University' }, [
        at('Brooke Lin', 'Student at Cornell University'),
      ])?.name,
    ).toBe('Brooke Lin');
  });
});
