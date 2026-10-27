import { describe, expect, it } from 'vitest';
import type { LinkedInPosition } from '../../integrations/enrichmentProxy';
import { currentPosition } from './profile';

/** Their main role when LinkedIn lists several current ones, as a person reading the profile would tell it. */
const pos = (title: string, company: string, start: string, current = true): LinkedInPosition => ({
  title,
  company,
  start,
  current,
});

describe('main current role', () => {
  it('is the one current role when there is one, never an ended one', () => {
    const exp = [
      pos('Electrical Engineer', 'Boeing', '8/1/2026'),
      pos('SWE Intern', 'Mysten Labs', '9/1/2025', false),
    ];
    expect(currentPosition(exp)?.company).toBe('Boeing');
  });

  it('is the one at the company their headline names', () => {
    const exp = [
      pos('Founder', 'Side Project Labs', '1/1/2026'),
      pos('Software Engineer III', 'Google', '6/1/2024'),
    ];
    expect(currentPosition(exp, 'Bringing AI Agents & AI Infra to Life @ Google')?.company).toBe('Google');
  });

  it('is a real role over a side one (advisor, ambassador, teaching assistant), whichever started last', () => {
    const exp = [
      pos('Student Ambassador', 'Notion', '9/1/2026'),
      pos('Advisor', 'Acme Ventures', '7/1/2026'),
      pos('Product Manager', 'Ramp', '1/1/2025'),
    ];
    expect(currentPosition(exp, 'Building things')?.company).toBe('Ramp');
  });

  it('is the latest started when nothing else tells them apart', () => {
    const exp = [pos('Engineer', 'Alpha', '1/1/2024'), pos('Engineer', 'Beta', '3/1/2026')];
    expect(currentPosition(exp)?.company).toBe('Beta');
  });
});
