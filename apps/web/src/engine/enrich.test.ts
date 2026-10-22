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
    // a direct connection with the same name
    expect(pickMatch(brooke, [at('Brooke Lin', 'Designer', 1)])?.name).toBe('Brooke Lin');
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
});
