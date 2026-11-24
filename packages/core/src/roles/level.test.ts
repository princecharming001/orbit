import { describe, expect, it } from 'vitest';
import { LEVEL_TITLES } from './__fixtures__/levelTitles';
import { employmentOf, employmentWord, roleLevel, termOf, yearsAsked } from './level';

describe('roleLevel on real titles', () => {
  it('has a table of at least 300 titles from the captured boards', () => {
    expect(LEVEL_TITLES.length).toBeGreaterThanOrEqual(300);
    const levels = new Set(LEVEL_TITLES.map(([, l]) => l));
    for (const l of ['intern', 'entry', 'mid', 'senior', 'lead', 'exec', null])
      expect(levels.has(l as never)).toBe(true);
  });

  it.each(LEVEL_TITLES)('%s is %s', (title, level) => {
    expect(roleLevel(title) ?? null).toBe(level);
  });

  it('never calls a role intern, entry or senior that a careful reader would not', () => {
    for (const want of ['intern', 'entry', 'senior'] as const) {
      const said = LEVEL_TITLES.filter(([t]) => roleLevel(t) === want);
      const right = said.filter(([, l]) => l === want);
      expect(right.length / Math.max(1, said.length)).toBe(1);
    }
  });
});

describe('roleLevel reads words in their place', () => {
  it.each([
    ['Analyst Relations Senior Manager', 'lead'],
    ['Software Engineer', undefined],
    ['Analyst', undefined],
    ['University Recruiter', undefined],
    ['Recruiter, Early Careers', undefined],
    ['Early Career Program Manager', undefined],
    ['Recruiting Intern', 'intern'],
    ['Product Manager', undefined],
    ['Senior Product Manager', 'senior'],
    ['Engineering Manager', 'lead'],
    ['Manager, Solutions Architecture', 'lead'],
    ['Solutions Architect', undefined],
    ['Software Architect', 'lead'],
    ['Staff Accountant', undefined],
    ['Staff Software Engineer', 'lead'],
    ['Member of Technical Staff', undefined],
    ['Associate Director, Strategy', 'lead'],
    ['Associate General Counsel', 'lead'],
    ['Operations Associate', 'entry'],
    ['Associate Product Manager', 'entry'],
    ['Private Equity Associate', undefined],
    ['Summer Associate', 'intern'],
    ['Summer Analyst, Investment Banking', 'intern'],
    ['Software Engineer II', 'mid'],
    ['Software Engineer III', 'senior'],
    ['Software Engineer I', 'entry'],
    ['Engineer 2', 'mid'],
    ['Motion Designer 3D', undefined],
    ['Sr. Data Scientist', 'senior'],
    ['Jr. Developer', 'entry'],
    ['VP, Engineering', 'exec'],
    ['Head of Design', 'exec'],
    ['Chief of Staff', undefined],
    ['Account Executive', undefined],
    ['Lead Generation Specialist', undefined],
    ['Software Engineer, Summer 2027', 'intern'],
    ['Software Engineer, New Grad (2027 Start)', 'entry'],
    ['Co-op, Fall 2026', 'intern'],
    ['Product Manager, Senior Living', undefined],
    ['Technical Program Manager, Office of the CTO', undefined],
  ])('%s', (title, level) => {
    expect(roleLevel(title)).toBe(level);
  });

  it('uses the text only when the title says nothing', () => {
    expect(roleLevel('Software Engineer', 'You have 0-2 years of professional experience.')).toBe('entry');
    expect(roleLevel('Software Engineer', 'We ask for 3+ years of experience with Go.')).toBe('mid');
    expect(roleLevel('Software Engineer', 'At least 5 years of industry experience.')).toBe('senior');
    expect(roleLevel('Senior Software Engineer', 'At least 1 year of experience.')).toBe('senior');
    expect(roleLevel('Software Engineer', 'Founded 10 years ago, we build payments.')).toBeUndefined();
    expect(roleLevel('Data Analyst', 'This summer internship runs for 12 weeks.')).toBe('intern');
    expect(roleLevel('Software Engineer', 'Open to new grads graduating in 2027.')).toBe('entry');
  });

  it('reads the least years asked', () => {
    expect(yearsAsked('5+ years of experience required, or 3 years of experience with a PhD')).toBe(3);
    expect(yearsAsked('2-4 years of relevant work experience')).toBe(2);
    expect(yearsAsked('a team with 30 years of history')).toBeUndefined();
  });
});

describe('termOf', () => {
  it.each([
    ['Software Engineer Intern - Summer 2027', 'Summer 2027'],
    ['Software Engineer Co-op - Fall 2026', 'Fall 2026'],
    ["Data Intern (Summer '27)", 'Summer 2027'],
    ['Research Intern, 2027 Summer', 'Summer 2027'],
    ['Co-op, Winter/Spring 2027', 'Winter 2027, Spring 2027'],
    ['Autumn 2026 Placement', 'Fall 2026'],
    ['Software Engineer', undefined],
  ])('%s', (title, term) => {
    expect(termOf(title)).toBe(term);
  });

  it('reads the text only beside the internship it describes', () => {
    expect(termOf('Data Intern', 'This internship runs in Summer 2027, in New York.')).toBe('Summer 2027');
    expect(termOf('Data Intern', 'Our office opened in Spring 2019. We value focus.')).toBeUndefined();
  });
});

describe('employmentOf', () => {
  it('reads the title first, then the source, then the level', () => {
    expect(employmentOf('Technical Sourcer | Engineering (Contract)')).toBe('contract');
    expect(employmentOf('Barista, Part-Time')).toBe('part_time');
    expect(employmentOf('Software Engineer Intern')).toBe('internship');
    expect(employmentOf('Software Engineer', undefined, 'FullTime')).toBe('full_time');
    expect(employmentOf('Software Engineer', undefined, 'Intern')).toBe('internship');
    expect(employmentOf('Software Engineer')).toBeUndefined();
  });
  it('maps each source word', () => {
    expect(employmentWord('Full-time')).toBe('full_time');
    expect(employmentWord('PartTime')).toBe('part_time');
    expect(employmentWord('contract')).toBe('contract');
    expect(employmentWord('Temporary')).toBe('temporary');
    expect(employmentWord('intern')).toBe('internship');
    expect(employmentWord('other')).toBeUndefined();
  });
});
