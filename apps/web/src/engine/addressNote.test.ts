import { describe, expect, it } from 'vitest';
import { addressNote, addressUnconfirmed, FAILED_NOTE, UNCONFIRMED_NOTE } from './addressNote';

describe('the note beside an address Orbit found itself', () => {
  it('a guessed or pattern-built address is said to be unconfirmed', () => {
    expect(addressNote({ primaryEmail: 'maya.chen@stripe.com', emailConfidence: 'guess' })).toBe(
      UNCONFIRMED_NOTE,
    );
    expect(addressNote({ primaryEmail: 'mchen@stripe.com', emailConfidence: 'pattern' })).toBe(
      UNCONFIRMED_NOTE,
    );
    expect(addressUnconfirmed({ emailConfidence: 'guess' })).toBe(true);
  });

  it('an address from their own mail, a verified one or one read on a page gets no note', () => {
    expect(addressNote({ primaryEmail: 'maya@stripe.com' })).toBeUndefined();
    expect(addressNote({ primaryEmail: 'maya@stripe.com', emailConfidence: 'verified' })).toBeUndefined();
    expect(addressNote({ primaryEmail: 'maya@stripe.com', emailConfidence: 'page' })).toBeUndefined();
    expect(addressUnconfirmed(undefined)).toBe(false);
  });

  it('an address a verifier refused is said to have failed', () => {
    expect(addressNote({ primaryEmail: 'maya.chen@stripe.com', emailConfidence: 'invalid' })).toBe(
      FAILED_NOTE,
    );
  });

  it('the note is about the stored address: another one the student chose gets none', () => {
    const person = { primaryEmail: 'maya.chen@stripe.com', emailConfidence: 'guess' as const };
    expect(addressNote(person, 'Maya.Chen@stripe.com')).toBe(UNCONFIRMED_NOTE);
    expect(addressNote(person, 'maya@gmail.com')).toBeUndefined();
    expect(addressNote(undefined)).toBeUndefined();
  });

  it('the words have no em dash and no exclamation mark', () => {
    for (const words of [UNCONFIRMED_NOTE, FAILED_NOTE]) expect(words).not.toMatch(/[—!]/);
  });
});
