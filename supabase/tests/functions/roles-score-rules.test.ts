/**
 * Plan 44 §6: the small rules the score rests on, found by the first live run against real postings. A skill is
 * matched by any alternative the posting accepts, traits are never requirements, and a gap is never cut mid-sentence.
 */
import { describe, expect, it } from 'vitest';
import type { JobRequirement, RoleProfile } from '../../../packages/core/src/roles/types.ts';
import { evidenceOf } from '../../functions/_shared/roles/profile.ts';
import {
  answersFor,
  isNotASkill,
  isSoftSkill,
  mustBeNamed,
  quoteNames,
  settleAnswers,
  settleRequirements,
  skillAlternatives,
  wholeSentences,
} from '../../functions/_shared/roles/score.ts';

describe('alternatives a requirement accepts', () => {
  it('reads "or", slashes, commas and a parenthesis', () => {
    expect(skillAlternatives('Python or R')).toEqual(['Python', 'R']);
    expect(skillAlternatives('Figma/Sketch')).toEqual(['Figma', 'Sketch']);
    expect(skillAlternatives('design tools (Figma, Canva)')).toEqual(['design tools', 'Figma', 'Canva']);
    // a name written with a slash of its own is one name
    expect(skillAlternatives('A/B testing')).toEqual(['A/B testing']);
    expect(skillAlternatives('CI/CD or GitHub Actions')).toEqual(['CI/CD', 'GitHub Actions']);
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

describe('which answer is for which posting', () => {
  const role = (posting: string) => ({ posting });
  it('by its label, however it is written after the number', () => {
    const a = role('J1');
    const b = role('J2: Data Analyst, Intern at Stripe');
    expect(answersFor([b, a], ['Staff Engineer', 'Data Analyst, Intern'])).toEqual([a, b]);
  });

  it('by its title when the model wrote the title and no label (seen on 2026-11-24: 37 of 126 roles left unread)', () => {
    const only = role('PhD Data Scientist, Intern at Stripe');
    expect(answersFor([only], ['PhD Data Scientist, Intern'])).toEqual([only]);
    const x = role('Senior Financial Analyst - Strategic GTM Finance at Databricks');
    const y = role('Data Analyst, Intern at Stripe');
    expect(
      answersFor([x, y], ['Data Analyst, Intern', 'Senior Financial Analyst - Strategic GTM Finance']),
    ).toEqual([y, x]);
  });

  it('the one answer left is for the one posting left; two unnamed answers for two postings are not guessed', () => {
    const named = role('J2');
    const bare = role('the first posting');
    expect(answersFor([bare, named], ['Role A', 'Role B'])).toEqual([bare, named]);
    expect(answersFor([role('?'), role('??')], ['Role A', 'Role B'])).toEqual([undefined, undefined]);
    // an answer the model left out stays out, to be asked for again
    expect(answersFor([role('J1')], ['Role A', 'Role B'])).toEqual([role('J1'), undefined]);
    expect(answersFor([], ['Role A'])).toEqual([undefined]);
    // a label past the postings asked about is not an answer to any of them
    expect(answersFor([role('J7'), role('J1')], ['Role A'])).toEqual([role('J1')]);
  });
});

describe('what is not a skill at all', () => {
  it('general use of AI tools, and what goes with an application', () => {
    for (const s of [
      'AI tools for model development, analysis, and coding',
      'Using AI tools to streamline workflows',
      'AI coding agents',
      'Proficiency with AI tooling',
      'Cover letter',
      'Academic transcript',
    ])
      expect(isNotASkill(s), s).toBe(true);
    // a tool by name is a requirement, and so is building with AI
    for (const s of [
      'Cursor, Lovable, or V0',
      'Claude or ChatGPT',
      'Hands-on AI building',
      'Machine learning',
      'LLM evals',
    ])
      expect(isNotASkill(s), s).toBe(false);
  });

  it('is dropped when the requirements are settled, like a trait', () => {
    const text =
      'Minimum requirements\n- Experience with SQL\n- Proficiency with AI tools to accelerate model development\n- A cover letter that says why\n- Strong communication skills';
    const raw = (name: string, quote: string) => ({
      kind: 'skill' as const,
      need: 'must' as const,
      name,
      quote,
      named: name === 'SQL',
      years: 0,
      degree: 'none' as const,
      eligibility: 'none' as const,
      gradFrom: '',
      gradTo: '',
    });
    const kept = settleRequirements(text, [
      raw('SQL', 'Experience with SQL'),
      raw('AI tools for model development', 'Proficiency with AI tools to accelerate model development'),
      raw('Cover letter', 'A cover letter that says why'),
      raw('Communication', 'Strong communication skills'),
    ]);
    expect(kept).toEqual([
      { kind: 'skill', need: 'must', name: 'SQL', quote: 'Experience with SQL', named: true },
    ]);
  });
});

describe('when the words must name the skill', () => {
  const profile: RoleProfile = {
    level: 'new_grad',
    graduation: '2027-05',
    degree: 'bachelor',
    field: 'Economics',
    courses: [],
    experience: [
      {
        title: 'Summer Analyst',
        org: 'Beacon Strategy Group',
        fullTime: false,
        text: 'Built the pricing analysis in Excel and wrote six slides of the final client presentation in PowerPoint\nResearched the US home battery market from public filings and 14 expert interviews\nBuilt payment reconciliation services in Go',
      },
    ],
    projects: [],
    skills: [{ name: 'Stata', from: 'written' }],
    kinds: [],
    wants: { levels: [], places: [], notPlaces: [], remote: false },
    eligibility: {},
    sources: ['resume'],
    fullTimeMonths: 0,
  };
  const ev = evidenceOf(profile);
  const reqOf = (name: string, named?: boolean): JobRequirement => ({
    kind: 'skill',
    need: 'must',
    name,
    quote: name,
    ...(named === undefined ? {} : { named }),
  });
  const answer = (reqs: JobRequirement[], you: string[]) =>
    settleAnswers(
      {
        posting: 'J1',
        skills: reqs.map((_r, i) => ({
          requirement: `R${i + 1}`,
          answer: 'work',
          you: you[i]!,
          posting: '',
        })),
        experience: { answer: 'none', you: '', posting: '' },
        education: { answer: 'unsaid', you: '', posting: '' },
        level: { answer: 'at', you: '', posting: '' },
        reason: '',
        gaps: [],
      },
      reqs,
      profile,
      ev,
      reqs.map((r) => r.name).join('\n'),
      { places: [] },
    ).skills.map((s) => s.answer);

  it('a tool or language by name is named, or it is not shown', () => {
    expect(mustBeNamed(reqOf('Kubernetes', true))).toBe(true);
    // Orbit knows the name, whatever the requirement says of itself
    expect(mustBeNamed(reqOf('Python or R', false))).toBe(true);
    expect(mustBeNamed(reqOf('Kafka', true))).toBe(true);
    // a real line of theirs that does not name it is not credit for it
    expect(
      answer(
        [reqOf('Kubernetes', true), reqOf('Go', true)],
        ['Built payment reconciliation services in Go', 'Built payment reconciliation services in Go'],
      ),
    ).toEqual(['none', 'work']);
  });

  it('a kind of work is shown by the line that does it, whatever words it uses', () => {
    expect(mustBeNamed(reqOf('Spreadsheets', false))).toBe(false);
    expect(mustBeNamed(reqOf('Secondary research', false))).toBe(false);
    // requirements read before the question was asked: a name Orbit does not know is a kind of work
    expect(mustBeNamed(reqOf('Statistical programs'))).toBe(false);
    expect(
      answer(
        [reqOf('Spreadsheets', false), reqOf('Presentations', false), reqOf('Secondary research', false)],
        [
          'Built the pricing analysis in Excel',
          'wrote six slides of the final client presentation in PowerPoint',
          'Researched the US home battery market from public filings',
        ],
      ),
    ).toEqual(['work', 'work', 'work']);
    // the quote still has to be theirs: words that are not in their lines show nothing
    expect(answer([reqOf('Spreadsheets', false)], ['Ten years of spreadsheet modeling at Google'])).toEqual([
      'none',
    ]);
    // and with no line at all, a tool on their list shows the kind of work as listed, never as work
    expect(answer([reqOf('Statistical software', false)], [''])).toEqual(['listed']);
  });
});
