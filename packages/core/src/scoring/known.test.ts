import { describe, expect, it } from 'vitest';
import { contactedStage, hasHistoryWith, hasRealName, isKnownContact } from './known';

const person = (patch: Record<string, unknown> = {}) =>
  ({
    firstName: 'Ana',
    lastName: 'Ruiz',
    displayName: 'Ana Ruiz',
    isHuman: true,
    sources: ['gmail'],
    strengthBreakdown: { raw: 1, recency: 1, counts: { email_in: 2, email_out: 1 } },
    ...patch,
  }) as Parameters<typeof isKnownContact>[0];

describe('people the student knows', () => {
  it('needs a real first and last name', () => {
    expect(hasRealName({ firstName: 'Ana', lastName: 'Ruiz', displayName: 'Ana Ruiz' })).toBe(true);
    expect(
      hasRealName({ firstName: "D'Angelo", lastName: 'Smith-Jones', displayName: "D'Angelo Smith-Jones" }),
    ).toBe(true);
    expect(hasRealName({ firstName: 'z.tech4future', lastName: '', displayName: 'z.tech4future' })).toBe(
      false,
    );
    expect(hasRealName({ firstName: 'Y', lastName: '', displayName: 'Y' })).toBe(false);
    expect(hasRealName({ firstName: 'Andre', lastName: '', displayName: 'Andre' })).toBe(false);
    expect(hasRealName({ firstName: 'Team', lastName: 'Two', displayName: 'Team 2' })).toBe(false);
    expect(hasRealName({ firstName: 'J', lastName: 'Smith', displayName: 'J Smith' })).toBe(false);
  });

  it('needs history both ways, a meeting, a LinkedIn connection, a chat, or adding them yourself', () => {
    expect(isKnownContact(person())).toBe(true);
    // a newsletter or a cold pitch: they wrote, the student never did
    expect(
      isKnownContact(person({ strengthBreakdown: { raw: 1, recency: 1, counts: { email_in: 3 } } })),
    ).toBe(false);
    expect(
      isKnownContact(person({ strengthBreakdown: { raw: 1, recency: 1, counts: { meeting: 1 } } })),
    ).toBe(true);
    expect(isKnownContact(person({ strengthBreakdown: undefined, linkedinConnectedOn: '2025-01-01' }))).toBe(
      true,
    );
    expect(isKnownContact(person({ strengthBreakdown: undefined }), { hasChat: true })).toBe(true);
    expect(isKnownContact(person({ strengthBreakdown: undefined, sources: ['manual'] }))).toBe(true);
    expect(isKnownContact(person({ isHuman: false }))).toBe(false);
    expect(isKnownContact(person({ hiddenAt: '2026-01-01' }))).toBe(false);
  });

  it('someone saved from a LinkedIn search is not known until they talk; history is a connection, both-way mail, a chat past "to contact" or a server tie', () => {
    const saved = person({ strengthBreakdown: undefined, sources: ['linkedin_search'] });
    expect(isKnownContact(saved)).toBe(false);
    // a chat at "to contact" keeps them on People and the map, but is no history
    expect(isKnownContact(saved, { hasChat: true })).toBe(true);
    expect(hasHistoryWith(saved)).toBe(false);
    expect(hasHistoryWith(saved, { contacted: false })).toBe(false);
    expect(hasHistoryWith(saved, { contacted: true })).toBe(true);
    expect(hasHistoryWith(person({ strengthBreakdown: undefined, sources: ['manual'] }))).toBe(false);
    expect(hasHistoryWith(person({ strengthBreakdown: undefined, linkedinConnectedOn: '2025-01-01' }))).toBe(
      true,
    );
    expect(hasHistoryWith(person({ strengthBreakdown: undefined, sources: ['linkedin_csv'] }))).toBe(true);
    expect(
      hasHistoryWith(person({ strengthBreakdown: { raw: 1, recency: 1, counts: { email_in: 3 } } })),
    ).toBe(false);
    expect(
      hasHistoryWith(person({ strengthBreakdown: { raw: 1, recency: 1, counts: { meeting: 1 } } })),
    ).toBe(true);
    expect(hasHistoryWith(person({ strengthBreakdown: undefined, tieScore: 12 }))).toBe(true);
    expect(contactedStage('identified')).toBe(false);
    expect(contactedStage('warming')).toBe(false);
    expect(contactedStage('outreach_sent')).toBe(true);
    expect(contactedStage(undefined)).toBe(false);
  });

  it('counts LinkedIn comments and reactions only when they go both ways or sit next to messages (plan 17 B)', () => {
    const counts = (c: Record<string, number>) =>
      person({ strengthBreakdown: { raw: 0.1, recency: 1, counts: c } });
    // an audience: reacts to and comments on every post, never more
    expect(isKnownContact(counts({ linkedin_reaction_in: 40, linkedin_comment_in: 3 }))).toBe(false);
    // the student comments on their posts and nothing comes back
    expect(isKnownContact(counts({ linkedin_comment_out: 2 }))).toBe(false);
    // comments both ways, or engagement next to a direct message the other way
    expect(isKnownContact(counts({ linkedin_comment_in: 1, linkedin_comment_out: 1 }))).toBe(true);
    expect(isKnownContact(counts({ linkedin_reaction_in: 2, linkedin_out: 1 }))).toBe(true);
    expect(isKnownContact(counts({ linkedin_comment_out: 1, linkedin_in: 1 }))).toBe(true);
  });
});
