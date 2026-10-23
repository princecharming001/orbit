import { describe, expect, it } from 'vitest';
import { sameSchool, schoolKey, universityPart } from '../text/school';

describe('school names', () => {
  it('reads the structural ways one school is written', () => {
    expect(schoolKey('The University of California, Berkeley')).toBe('uc berkeley');
    expect(schoolKey('University of California at Los Angeles')).toBe('uc los angeles');
    expect(sameSchool('UC Berkeley', 'University of California, Berkeley')).toBe(true);
    expect(sameSchool('Université de Montréal', 'universite de montreal')).toBe(true);
    expect(sameSchool('UC Berkeley, Haas School of Business', 'UC Berkeley')).toBe(true);
    expect(universityPart('University of Michigan - Stephen M. Ross School of Business')).toBe(
      'University of Michigan',
    );
    expect(universityPart('University of California, Berkeley')).toBe('University of California, Berkeley');
  });

  it('keeps similar names apart', () => {
    expect(sameSchool('Cornell University', 'Cornell College')).toBe(false);
    expect(sameSchool('Boston University', 'Boston College')).toBe(false);
    expect(sameSchool('UC Berkeley', 'UC Los Angeles')).toBe(false);
    expect(sameSchool('', 'Cornell University')).toBe(false);
  });

  it('uses the aliases it is given', () => {
    const alias = (n: string) =>
      /^(cal|umich)$/i.test(n)
        ? { cal: 'University of California, Berkeley', umich: 'University of Michigan' }[n.toLowerCase()]
        : undefined;
    expect(sameSchool('Cal', 'UC Berkeley', alias)).toBe(true);
    expect(sameSchool('UMich', 'University of Michigan', alias)).toBe(true);
    expect(sameSchool('Cal', 'University of Michigan', alias)).toBe(false);
  });
});
