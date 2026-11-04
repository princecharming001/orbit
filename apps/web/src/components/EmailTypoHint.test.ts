import { describe, expect, it } from 'vitest';
import { emailTypo } from './EmailTypoHint';

describe('emailTypo', () => {
  it('offers the common provider a mistyped domain was meant to be', () => {
    expect(emailTypo('priya@gmial.com')).toBe('priya@gmail.com');
    expect(emailTypo('dan@yaho.com')).toBe('dan@yahoo.com');
  });
  it('says nothing for a right address, a school or an employer, or a half-typed one', () => {
    expect(emailTypo('priya@gmail.com')).toBeUndefined();
    expect(emailTypo('apolakala@berkeley.edu')).toBeUndefined();
    expect(emailTypo('priya@evercore.com')).toBeUndefined();
    expect(emailTypo('priya@gm')).toBeUndefined();
  });
});
