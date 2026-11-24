import { describe, expect, it } from 'vitest';
import { verifyQuote } from './quote';
import {
  canonicalSkill,
  knownSkill,
  sameSkill,
  showsSkill,
  skillIn,
  skillName,
  skillsIn,
  splitSkillList,
  uniqueSkills,
} from './skills';

describe('skill names', () => {
  it('folds the common spellings into one skill', () => {
    expect(sameSkill('JS', 'JavaScript')).toBe(true);
    expect(sameSkill('TS', 'typescript')).toBe(true);
    expect(sameSkill('Postgres', 'PostgreSQL')).toBe(true);
    expect(sameSkill('ML', 'machine learning')).toBe(true);
    expect(sameSkill('k8s', 'Kubernetes')).toBe(true);
    expect(sameSkill('GCP', 'Google Cloud')).toBe(true);
    expect(sameSkill('Golang', 'Go')).toBe(true);
    expect(sameSkill('React.js', 'React')).toBe(true);
    expect(sameSkill('Java', 'JavaScript')).toBe(false);
    expect(sameSkill('C', 'C++')).toBe(false);
    expect(sameSkill('C#', 'C++')).toBe(false);
  });

  it('shows a known skill the usual way and an unknown one as written', () => {
    expect(skillName('js')).toBe('JavaScript');
    expect(skillName('Underwater basket weaving')).toBe('Underwater basket weaving');
    expect(canonicalSkill('  Python3 ')).toBe('python');
  });

  it('keeps one of each skill', () => {
    expect(
      uniqueSkills([{ name: 'JS' }, { name: 'JavaScript' }, { name: 'SQL' }]).map((s) => s.name),
    ).toEqual(['JS', 'SQL']);
  });
});

describe('skillIn: whole words', () => {
  it('Java is not inside JavaScript', () => {
    expect(skillIn('Built the front end in JavaScript', 'Java')).toBe(false);
    expect(skillIn('Wrote services in Java and Kotlin', 'Java')).toBe(true);
    expect(skillIn('Built the front end in JavaScript', 'JS')).toBe(true);
  });

  it('C, R and Go only as a standalone word with their capital letter', () => {
    expect(skillIn('Firmware in C for an STM32', 'C')).toBe(true);
    expect(skillIn('Engine written in C++', 'C')).toBe(false);
    expect(skillIn('Unity scripts in C#', 'C')).toBe(false);
    expect(skillIn('a c program', 'C')).toBe(false);
    expect(skillIn('Survival models in R', 'R')).toBe(true);
    expect(skillIn('Two terms in R&D', 'R')).toBe(false);
    expect(skillIn('Rewrote the API in Go', 'Go')).toBe(true);
    expect(skillIn('I like to go hiking', 'Go')).toBe(false);
    expect(skillIn('A self-starter and go-getter', 'Go')).toBe(false);
    expect(skillIn('Services in Golang', 'Go')).toBe(true);
  });

  it('C++ and C# are their own skills', () => {
    expect(skillIn('Engine written in C++', 'C++')).toBe(true);
    expect(skillIn('Unity scripts in C#', 'C#')).toBe(true);
    expect(skillIn('Firmware in C', 'C++')).toBe(false);
  });

  it('matches longer skills in any case and through their aliases', () => {
    expect(skillIn('deployed on k8s with helm', 'Kubernetes')).toBe(true);
    expect(skillIn('analysis in postgres', 'PostgreSQL')).toBe(true);
    expect(skillIn('An API in Node.js', 'Node.js')).toBe(true);
    expect(skillIn('Trained models with PyTorch', 'pytorch')).toBe(true);
    expect(skillIn('Hosted on Google Cloud Platform', 'GCP')).toBe(true);
    expect(skillIn('', 'Python')).toBe(false);
  });

  it('skillsIn keeps the ones named', () => {
    expect(skillsIn('Python, SQL and Tableau dashboards', ['Python', 'Java', 'SQL', 'Excel'])).toEqual([
      'Python',
      'SQL',
    ]);
  });
});

describe('verifyQuote', () => {
  const text = 'Built a churn model in Python. “Shipped” the JavaScript   dashboard to 40 users.';

  it('finds a quote ignoring case, curly quotes and spacing (same as the browser judge)', () => {
    expect(verifyQuote(text, 'built a churn model')).toBe('built a churn model');
    expect(verifyQuote(text, '“Shipped” the JavaScript dashboard')).toBe(
      '“Shipped” the JavaScript dashboard',
    );
    expect(verifyQuote(text, '"a churn model"')).toBe('a churn model');
    expect(verifyQuote(text, 'not in the text')).toBeUndefined();
    expect(verifyQuote(text, 'ab')).toBeUndefined();
    expect(verifyQuote(text, null)).toBeUndefined();
  });

  it('whole words: "Java" quoted from "JavaScript" does not count', () => {
    expect(verifyQuote(text, 'Java')).toBe('Java');
    expect(verifyQuote(text, 'Java', { wholeWord: true })).toBeUndefined();
    expect(verifyQuote(text, 'JavaScript', { wholeWord: true })).toBe('JavaScript');
    expect(verifyQuote(text, 'model in Python.', { wholeWord: true })).toBe('model in Python.');
    expect(verifyQuote(text, 'hurn model', { wholeWord: true })).toBeUndefined();
  });
});

describe('a skill that plainly includes another', () => {
  it('PostgreSQL shows SQL, pandas shows Python, never the other way', async () => {
    const { showsSkill, skillShownIn } = await import('./skills');
    expect(showsSkill('PostgreSQL', 'SQL')).toBe(true);
    expect(showsSkill('pandas', 'Python')).toBe(true);
    expect(showsSkill('SQL', 'PostgreSQL')).toBe(false);
    expect(skillShownIn('Built reconciliation services in Go and PostgreSQL', 'SQL')).toBe(true);
    expect(skillShownIn('Cleaned claims data with pandas', 'Python')).toBe(true);
    expect(skillShownIn('Wrote the site in JavaScript', 'Java')).toBe(false);
  });
});

describe('a written list of skills', () => {
  it('splits on commas, semicolons, slashes, "and" and "or"', () => {
    expect(splitSkillList('Python, SQL; Figma/Sketch and R or Stata')).toEqual([
      'Python',
      'SQL',
      'Figma',
      'Sketch',
      'R',
      'Stata',
    ]);
  });

  it('keeps names written with a slash or an ampersand whole', () => {
    expect(splitSkillList('Figma, user research, A/B testing')).toEqual([
      'Figma',
      'user research',
      'A/B testing',
    ]);
    expect(splitSkillList('CI/CD, UI/UX design and TCP/IP')).toEqual(['CI/CD', 'UI/UX design', 'TCP/IP']);
    expect(splitSkillList('P&L ownership; R&D')).toEqual(['P&L ownership', 'R&D']);
  });
});

describe('a skill Orbit knows by name', () => {
  it('is one specific tool or language, however it is spelled', () => {
    for (const s of ['Python', 'js', 'Postgres', 'Excel', 'k8s', 'Figma', 'PowerPoint'])
      expect(knownSkill(s), s).toBe(true);
    for (const s of ['Spreadsheets', 'Secondary research', 'Statistical programs', 'Kafkaesque writing'])
      expect(knownSkill(s), s).toBe(false);
  });

  it('a tool shows the kind of work it is for', () => {
    expect(showsSkill('Excel', 'Spreadsheets')).toBe(true);
    expect(showsSkill('Google Sheets', 'spreadsheets')).toBe(true);
    expect(showsSkill('PowerPoint', 'Presentations')).toBe(true);
    expect(showsSkill('Stata', 'Statistical software')).toBe(true);
    // one direction only
    expect(showsSkill('Spreadsheets', 'Excel')).toBe(false);
  });
});
