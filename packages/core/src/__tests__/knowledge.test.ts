import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FirmKind } from '../drafts/sector';
import { KNOWLEDGE_FILES } from '../knowledge/bundle';
import {
  ASK_RULES,
  DRAFT_RULES,
  findPlaybookSection,
  functionsFromText,
  KNOWLEDGE_IDS,
  KNOWLEDGE_MAX_GOAL_SECTIONS,
  KNOWLEDGE_WORD_BUDGET,
  type KnowledgeId,
  knowledgeBlockText,
  knowledgeFor,
  knowledgeSection,
} from '../knowledge/index';
import { GOAL_KINDS } from '../types';

const DIR = join(__dirname, '..', 'knowledge');
const DASH_OR_BANG = /[—–!]/;
const words = (s: string) => s.trim().split(/\s+/).length;

describe('the playbook files (plan 28 §3a)', () => {
  it('bundle.ts is built from every .md file, title and body, sources line left out', () => {
    const files = readdirSync(DIR)
      .filter((f) => f.endsWith('.md'))
      .sort();
    expect(files.map((f) => f.replace(/\.md$/, ''))).toEqual([...KNOWLEDGE_IDS].sort());
    for (const f of files) {
      const id = f.replace(/\.md$/, '');
      const lines = readFileSync(join(DIR, f), 'utf8').replace(/\r\n/g, '\n').split('\n');
      const titleLine = lines.find((l) => l.startsWith('# '))!;
      const body = lines
        .filter((l) => l !== titleLine && !/^Sources:/.test(l))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      expect(KNOWLEDGE_FILES[id]?.title, id).toBe(titleLine.slice(2).trim());
      expect(KNOWLEDGE_FILES[id]?.body, `${id} is stale: run node scripts/knowledge-bundle.mjs`).toBe(body);
      // every file names where it came from and when it was checked
      expect(
        lines.some((l) => /^Sources: .*Checked 20\d\d-\d\d-\d\d/.test(l)),
        id,
      ).toBe(true);
    }
  });

  it('every section is plain prose of 450 to 850 words with no dashes, exclamation marks, headings or bullets', () => {
    for (const id of KNOWLEDGE_IDS) {
      const s = knowledgeSection(id);
      expect(s.title.length, id).toBeGreaterThan(5);
      expect(s.words, id).toBeGreaterThanOrEqual(450);
      expect(s.words, id).toBeLessThanOrEqual(850);
      expect(s.body, id).not.toMatch(DASH_OR_BANG);
      expect(s.body, id).not.toMatch(/^\s*[#*-] /m);
      expect(s.body, id).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('the yearly facts are tagged so the model checks them live', () => {
    for (const id of ['ib', 'consulting', 'tech', 'pm', 'quant', 'fundraising'] as KnowledgeId[])
      expect(knowledgeSection(id).body, id).toMatch(/\[CHANGES YEARLY/);
  });
});

describe('knowledgeFor (plan 28 §3b, channel 1)', () => {
  it('always starts with etiquette, then the goal sections in goal order, at most two, within the budget', () => {
    const none = knowledgeFor([]);
    expect(none.map((s) => s.id)).toEqual(['etiquette']);
    const ib = knowledgeFor([{ kind: 'recruiting' }], ['ib']);
    expect(ib.map((s) => s.id)).toEqual(['etiquette', 'ib']);
    const two = knowledgeFor([{ kind: 'fundraising' }, { kind: 'hiring' }, { kind: 'sales' }]);
    expect(two.map((s) => s.id)).toEqual(['etiquette', 'fundraising', 'hiring']);
    expect(two.length).toBeLessThanOrEqual(1 + KNOWLEDGE_MAX_GOAL_SECTIONS);
    for (const s of two) expect(s.words).toBeGreaterThan(0);
  });

  it('a recruiting goal resolves through target functions, then the goal roles; functions alone count too', () => {
    expect(knowledgeFor([{ kind: 'recruiting' }], ['consulting']).map((s) => s.id)).toEqual([
      'etiquette',
      'consulting',
    ]);
    expect(
      knowledgeFor([{ kind: 'recruiting', targets: { roles: ['Product Manager intern'] } }]).map((s) => s.id),
    ).toEqual(['etiquette', 'pm']);
    expect(
      knowledgeFor([{ kind: 'recruiting', title: 'Quant trading internships' }]).map((s) => s.id),
    ).toEqual(['etiquette', 'quant']);
    expect(knowledgeFor([], ['swe']).map((s) => s.id)).toEqual(['etiquette', 'tech']);
    expect(knowledgeFor([{ kind: 'recruiting' }], ['vc']).map((s) => s.id)).toEqual(['etiquette', 'vc-job']);
    expect(knowledgeFor([{ kind: 'recruiting' }], ['design']).map((s) => s.id)).toEqual([
      'etiquette',
      'data-design',
    ]);
    // unknown codes and an unknown recruiting target leave etiquette alone
    expect(knowledgeFor([{ kind: 'recruiting' }], ['astronaut']).map((s) => s.id)).toEqual(['etiquette']);
  });

  it('every goal kind has a section, and no combination of two goals breaks the word budget', () => {
    for (const kind of GOAL_KINDS) {
      const ids = knowledgeFor([{ kind }], kind === 'recruiting' ? ['ib'] : []).map((s) => s.id);
      expect(ids.length, kind).toBe(2);
    }
    for (const a of GOAL_KINDS)
      for (const b of GOAL_KINDS) {
        const got = knowledgeFor([{ kind: a }, { kind: b }], ['ib', 'swe']);
        const total = got.reduce((n, s) => n + s.words, 0);
        expect(total, `${a}+${b}`).toBeLessThanOrEqual(KNOWLEDGE_WORD_BUDGET);
      }
  });

  it('the block says how to use it and which sections are one lookup away', () => {
    const text = knowledgeBlockText(knowledgeFor([{ kind: 'fundraising' }]));
    expect(text).toMatch(/^Playbook\. What a sharp friend who has done this knows/);
    expect(text).toMatch(/\[CHANGES YEARLY\] gives the pattern/);
    expect(text).toMatch(/Other sections, through lookup_playbook: .*vc-job.*glossary|glossary.*vc-job/);
    expect(text).toMatch(/## Networking etiquette/);
    expect(text).toMatch(/## Raising a first round/);
    expect(text).not.toMatch(/## Investment banking/);
    expect(text).not.toMatch(DASH_OR_BANG);
    // about 3k tokens at the most for any student
    expect(Math.ceil(text.length / 4)).toBeLessThanOrEqual(3300);
  });
});

describe('findPlaybookSection (channel 2) and functionsFromText', () => {
  it('finds the section a student means, longer phrases first, and the glossary for a what-is question', () => {
    const cases: [string, KnowledgeId][] = [
      ['how does vc recruiting work', 'vc-job'],
      ['break into venture', 'vc-job'],
      ['what is a superday', 'glossary'],
      ['what does pro rata mean', 'glossary'],
      ['how do seed rounds work', 'fundraising'],
      ['first partner meeting at a seed fund', 'fundraising'],
      ['when do banks recruit', 'ib'],
      ['case interview prep', 'consulting'],
      ['how to find a cofounder', 'cofounder'],
      ['cold email to a customer', 'sales'],
      ['how to ask a professor to collaborate', 'collaboration'],
      ['thank you after a coffee chat', 'etiquette'],
      ['how many follow ups is too many', 'etiquette'],
      ['quant trading interviews', 'quant'],
      ['private equity path', 'finance-other'],
      ['hiring my first engineer', 'hiring'],
      ['finding a mentor as a freshman', 'advice'],
      ['glossary', 'glossary'],
      ['ib', 'ib'],
    ];
    for (const [topic, id] of cases) expect(findPlaybookSection(topic)?.id, topic).toBe(id);
    expect(findPlaybookSection('zzz qqq')).toBeUndefined();
    expect(findPlaybookSection('')).toBeUndefined();
  });

  it('reads a function out of a role name', () => {
    expect(functionsFromText('Investment Banking Summer Analyst')).toEqual(['ib']);
    expect(functionsFromText('Software Engineer intern, Stripe')).toEqual(['swe']);
    expect(functionsFromText('Associate Product Manager')).toEqual(['pm']);
    expect(functionsFromText('Management consulting')).toEqual(['consulting']);
    expect(functionsFromText('Research assistant in a neuroscience lab')).toEqual(['research']);
    expect(functionsFromText('barista')).toEqual([]);
  });
});

describe('the draft rules (channel 3)', () => {
  it('has one register rule per goal kind and one ask rule per firm kind, each short and clean', () => {
    for (const kind of GOAL_KINDS) {
      expect(DRAFT_RULES[kind], kind).toMatch(/register/);
      expect(words(DRAFT_RULES[kind]), kind).toBeLessThanOrEqual(80);
      expect(DRAFT_RULES[kind], kind).not.toMatch(DASH_OR_BANG);
    }
    const firms: FirmKind[] = [
      'bank',
      'pe',
      'trading',
      'vc',
      'consulting',
      'big_tech',
      'startup',
      'tech',
      'academic',
      'other',
    ];
    for (const f of firms) {
      expect(ASK_RULES[f], f).toMatch(/\bask|asked\b/i);
      expect(ASK_RULES[f], f).toMatch(/Never|never/);
      expect(words(ASK_RULES[f]), f).toBeLessThanOrEqual(80);
      expect(ASK_RULES[f], f).not.toMatch(DASH_OR_BANG);
    }
    // the fundraising register is not a job hunt, and the banker is never asked consulting words
    expect(DRAFT_RULES.fundraising).toMatch(/Never a job hunting line/);
    expect(ASK_RULES.bank).toMatch(/Never about staffing or an office/);
    expect(ASK_RULES.vc).toMatch(/Never "your bank"/);
  });
});
