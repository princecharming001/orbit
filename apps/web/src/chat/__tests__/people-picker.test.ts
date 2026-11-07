import { describe, expect, it } from 'vitest';
import { looksLikeName } from '../tools/read';

// plan 32 §15 bugs 14 and 15: only a name asks "which one"; a company, batch or title is a plain list
describe('looksLikeName', () => {
  const people = [{ displayName: 'Lena Park' }, { displayName: 'Ana Ruiz' }, { displayName: 'Omar Haddad' }];
  it('takes given names and the start of a name', () => {
    expect(looksLikeName('Lena', people)).toBe(true);
    expect(looksLikeName('lena p', people)).toBe(true);
    expect(looksLikeName('Haddad', people)).toBe(true);
    expect(looksLikeName('Michael', [])).toBe(true);
  });
  it('leaves companies, batches and titles alone', () => {
    expect(looksLikeName('W26', people)).toBe(false);
    expect(looksLikeName('Stripe', people)).toBe(false);
    expect(looksLikeName('consultant', people)).toBe(false);
  });
});
