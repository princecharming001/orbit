/**
 * orbit-connectors, the LinkedIn profile mapping (plan 44 §3): each position keeps what the person wrote about it, so
 * the Roles profile has the student's own words for what they did. The browser's `LinkedInPosition.description`
 * (apps/web/src/integrations/enrichmentProxy.ts) and `aboutMe()` (engine/selfProfile.ts) read exactly this field.
 */
import { describe, expect, it } from 'vitest';
import { yearMonth } from '../../../packages/core/src/roles/profileLevel.ts';
import {
  mapProfile,
  POSITION_DESCRIPTION_MAX,
  publicProfile,
} from '../../functions/orbit-connectors/connectors.ts';

const UNIPILE = {
  provider_id: 'ACoAAA999',
  public_identifier: 'maya-lin',
  first_name: 'Maya',
  last_name: 'Lin',
  headline: 'CS at Berkeley',
  network_distance: 'SELF',
  work_experience: [
    {
      position: 'Software Engineering Intern',
      company: 'Brex',
      company_id: '18505670',
      start: '6/1/2026',
      end: '8/15/2026',
      description:
        '  Built a reconciliation service for card transactions in Go.\n- Cut nightly run time by 40%.  ',
    },
    { position: 'Teaching Assistant', company: 'UC Berkeley', current: true, description: '   ' },
    { position: 'Barista', company: 'Blue Bottle', description: 42 },
    {
      position: 'Research Assistant',
      company: 'BAIR',
      description: 'x'.repeat(POSITION_DESCRIPTION_MAX + 500),
    },
  ],
  education: [{ school: 'UC Berkeley', degree: 'B.S.', field_of_study: 'Computer Science', end: '5/1/2028' }],
  throttled_sections: [],
};

describe('mapProfile: positions', () => {
  const p = mapProfile(UNIPILE);

  it("keeps a position's description as written, trimmed, lines kept", () => {
    expect(p.experience[0]).toMatchObject({
      title: 'Software Engineering Intern',
      company: 'Brex',
      description:
        'Built a reconciliation service for card transactions in Go.\n- Cut nightly run time by 40%.',
    });
  });

  it('a blank or non-text description is left out, never an empty string', () => {
    expect(p.experience[1]!.description).toBeUndefined();
    expect(p.experience[2]!.description).toBeUndefined();
    // and it is absent from what goes over the wire
    expect(JSON.parse(JSON.stringify(p)).experience[1]).not.toHaveProperty('description');
  });

  it('a very long description is cut, not dropped', () => {
    expect(p.experience[3]!.description).toHaveLength(POSITION_DESCRIPTION_MAX);
  });

  it('the copy kept for every student carries it too (it is on the public profile)', () => {
    const shared = publicProfile(p as unknown as Record<string, unknown>) as unknown as typeof p;
    expect(shared.experience[0]!.description).toMatch(/reconciliation service/);
  });

  it('is what the browser reads: title, company, dates and description of each job', () => {
    // the shape engine/selfProfile.ts aboutMe() maps into ProfileLines.linkedin.positions
    const positions = p.experience.map((x) => ({
      title: x.title,
      org: x.company,
      start: x.start,
      end: x.end,
      description: x.description,
    }));
    expect(positions[0]).toEqual({
      title: 'Software Engineering Intern',
      org: 'Brex',
      // Unipile's own way of writing a date, passed through; the Roles profile reading reads it (core yearMonth)
      start: '6/1/2026',
      end: '8/15/2026',
      description:
        'Built a reconciliation service for card transactions in Go.\n- Cut nightly run time by 40%.',
    });
    expect(yearMonth(positions[0]!.start)).toBe('2026-06');
    expect(yearMonth(positions[0]!.end)).toBe('2026-08');
    expect(yearMonth(p.education[0]!.end)).toBe('2028-05');
  });
});
