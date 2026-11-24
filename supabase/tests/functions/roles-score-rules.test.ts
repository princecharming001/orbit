/**
 * Plan 44 §6: the small rules the score rests on, found by the first live run against real postings. A skill is
 * matched by any alternative the posting accepts, traits are never requirements, and a gap is never cut mid-sentence.
 */
import { describe, expect, it } from 'vitest';
import {
  isSoftSkill,
  quoteNames,
  skillAlternatives,
  wholeSentences,
} from '../../functions/_shared/roles/score.ts';

describe('alternatives a requirement accepts', () => {
  it('reads "or", slashes, commas and a parenthesis', () => {
    expect(skillAlternatives('Python or R')).toEqual(['Python', 'R']);
    expect(skillAlternatives('Figma/Sketch')).toEqual(['Figma', 'Sketch']);
    expect(skillAlternatives('design tools (Figma, Canva)')).toEqual(['design tools', 'Figma', 'Canva']);
  });

  it('a quote that names any one of them counts', () => {
    expect(
      quoteNames('Designed onboarding screens in Figma', 'Experience with design tools (Figma, Canva)'),
    ).toBe(true);
    expect(quoteNames('Analysis in R and SQL', 'Python or R')).toBe(true);
    expect(quoteNames('Ran user research sessions with 12 students', 'User research')).toBe(true);
    // one letter, and not inside a longer word
    expect(quoteNames('Built a React app', 'R')).toBe(false);
    expect(quoteNames('Wrote JavaScript for the site', 'Java')).toBe(false);
  });
});

describe('traits are not requirements', () => {
  it('leaves out soft skills, keeps skills a resume can show', () => {
    for (const s of [
      'Strong interpersonal and communication skills',
      'Ability to learn unfamiliar systems',
      'Collaborating with multidisciplinary stakeholders',
      'Attention to detail',
    ])
      expect(isSoftSkill(s), s).toBe(true);
    for (const s of ['Python', 'Figma', 'User research', 'Financial modeling', 'SQL'])
      expect(isSoftSkill(s), s).toBe(false);
  });
});

describe('gaps and reasons stay whole', () => {
  it('keeps a short line, cuts a long one at a sentence end, drops one with no end in reach', () => {
    expect(wholeSentences('Kubernetes is asked for and not on your resume.', 180)).toBe(
      'Kubernetes is asked for and not on your resume.',
    );
    const long =
      'SQL is required and is not on your resume. Learn it and add a project that uses it, for example a class project with a real dataset and queries you wrote yourself.';
    expect(wholeSentences(long, 120)).toBe('SQL is required and is not on your resume.');
    expect(wholeSentences(`${'word '.repeat(60)}end`, 100)).toBe('');
  });
});
