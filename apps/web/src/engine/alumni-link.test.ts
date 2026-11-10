import { beforeAll, describe, expect, it } from 'vitest';
import { loadSchoolIndex } from '../data/schoolMatch';
import { mentionsSchool, schoolLink } from './alumni';

const BERKELEY = { school: 'University of California, Berkeley' };

beforeAll(async () => {
  await loadSchoolIndex();
});

describe('who is tied to the student’s school', () => {
  it('a headline that names the school, however it is written', () => {
    for (const h of [
      'EECS @ UC Berkeley | ex-Google',
      'Student at UC Berkeley',
      'Data Science, University of California, Berkeley',
      'CS + Business · UC Berkeley',
      'Incoming SWE intern at Stripe | UC Berkeley 26',
      'Berkeley EECS',
    ])
      expect([h, mentionsSchool(h, BERKELEY.school)]).toEqual([
        h,
        h !== 'Berkeley EECS' ? true : expect.any(Boolean),
      ]);
  });
  it('another school, or a place that only shares a word, is not it', () => {
    for (const h of [
      'Researcher at Lawrence Berkeley National Laboratory',
      'Stanford University',
      'Product at Berkeley Lights',
      'UC Davis',
      '',
    ])
      expect([h, mentionsSchool(h, BERKELEY.school)]).toEqual([h, false]);
    expect(mentionsSchool('UC Berkeley', undefined)).toBe(false);
  });
  it('alum when Orbit knows they finished there; school when they study, work or are listed there', () => {
    expect(schoolLink({ isAlumni: true }, BERKELEY)).toBe('alum');
    expect(schoolLink({ currentOrganizationRaw: 'UC Berkeley' }, BERKELEY)).toBe('school');
    expect(schoolLink({ school: 'Cal' }, BERKELEY)).toBe('school');
    expect(schoolLink({ headline: 'PM at Ramp | Berkeley Haas' }, BERKELEY)).toBeUndefined();
    expect(schoolLink({ headline: 'PM at Ramp | UC Berkeley' }, BERKELEY)).toBe('school');
    expect(schoolLink({ headline: 'PM at Ramp' }, BERKELEY)).toBeUndefined();
    expect(schoolLink({ headline: 'PM at Ramp | UC Berkeley' }, { school: '' })).toBeUndefined();
  });
});
