import { describe, expect, it } from 'vitest';
import { wordRange } from '../drafts/compose';
import {
  draftPlaybook,
  NICHE_FORM,
  NICHE_PLAYBOOKS,
  type Niche,
  nicheFor,
  nicheRules,
} from '../drafts/niche';
import type { GoalKind } from '../types';

const DASH_OR_BANG = /[—–!]/;

/** The nine student scenarios of the live draft bench (plan 30), as the resolver sees them. */
const CASES: [string, GoalKind, string, { title: string; org: string }, string | undefined, Niche][] = [
  [
    'UT junior, IB',
    'recruiting',
    'IB summer analyst coffee chats',
    { title: 'Investment Banking Analyst', org: 'Tudor, Pickering, Holt & Co.' },
    'BBA',
    'ib_coffee_chat',
  ],
  [
    'Georgetown sophomore, consulting',
    'recruiting',
    'Consulting internship networking',
    { title: 'Business Analyst', org: 'McKinsey & Company' },
    'BS',
    'consulting_coffee_chat',
  ],
  [
    'Rutgers senior, restructuring',
    'advice',
    'Move from audit into restructuring',
    { title: 'Associate, Restructuring', org: 'Houlihan Lokey' },
    'BS',
    'ib_coffee_chat',
  ],
  [
    'Davis sophomore, sleep lab',
    'collaboration',
    'Undergraduate research position in a sleep lab',
    { title: 'Associate Professor of Psychology', org: 'University of California, Davis' },
    'BS',
    'research_position',
  ],
  [
    'Georgia Tech junior, NLP lab',
    'recruiting',
    'Research assistant in an NLP lab this spring',
    { title: 'Assistant Professor, School of Interactive Computing', org: 'Georgia Institute of Technology' },
    'BS',
    'research_position',
  ],
  [
    'Ohio State first-year, PhD student',
    'advice',
    'Join a lab as an undergraduate researcher',
    { title: 'PhD Candidate', org: 'The Ohio State University' },
    'BS',
    'research_position',
  ],
  [
    'Northeastern senior, founding engineer',
    'recruiting',
    'Founding backend engineer role at a seed-stage startup hiring now',
    { title: 'CTO and Co-founder', org: 'Fieldnote' },
    'BS',
    'startup_job',
  ],
  [
    'CMU MS, founding ML engineer',
    'recruiting',
    'Founding ML engineer at an early-stage AI startup',
    { title: 'Co-founder and CEO', org: 'Arcline AI' },
    'MS',
    'startup_job',
  ],
];

describe('nicheFor (plan 30)', () => {
  it.each(CASES)('%s', (_label, goalKind, goalText, recipient, degree, want) => {
    expect(nicheFor({ goalKind, goalText, recipient, degree })).toBe(want);
  });

  it('a PhD student writing to a professor proposes a collaboration, not a lab position', () => {
    expect(
      nicheFor({
        goalKind: 'collaboration',
        goalText: 'Co-author a paper on retrieval',
        recipient: { title: 'Professor of Computer Science', org: 'Stanford University' },
        degree: 'PhD',
      }),
    ).toBe('research_collaboration');
  });

  it('business goals keep their own playbook whoever the recipient is', () => {
    const r = { title: 'Partner', org: 'Sequoia Capital' };
    expect(nicheFor({ goalKind: 'fundraising', recipient: r })).toBe('fundraising');
    expect(nicheFor({ goalKind: 'sales', recipient: r })).toBe('sales');
  });

  it('a recipient and goal no playbook knows fall back to general (or advice for an advice goal)', () => {
    const r = { title: 'Head Chef', org: 'Chez Panisse' };
    expect(nicheFor({ goalKind: 'recruiting', goalText: 'Line cook job', recipient: r })).toBe('general');
    expect(nicheFor({ goalKind: 'advice', goalText: 'Opening a restaurant', recipient: r })).toBe('advice');
  });
});

describe('the niche playbooks', () => {
  it('every niche has every step, a sane word range, cited sources and no dash or exclamation mark', () => {
    for (const [niche, p] of Object.entries(NICHE_PLAYBOOKS)) {
      for (const t of [p.first, p.followUp, p.reply, p.thankYou]) {
        expect(t.trim().length, niche).toBeGreaterThan(20);
        expect(t, niche).not.toMatch(DASH_OR_BANG);
      }
      expect(p.firstWords[0], niche).toBeLessThan(p.firstWords[1]);
      expect(p.sources.length, niche).toBeGreaterThan(0);
      expect(NICHE_FORM[niche as Niche], niche).toBeDefined();
    }
  });

  it('the validator and the prompt agree on a niche word range; a sales note keeps its short range', () => {
    expect(wordRange('first_touch', 'collaboration', 'research_position')).toEqual([80, 180]);
    expect(wordRange('first_touch', 'sales', 'sales')).toEqual([40, 90]);
    expect(wordRange('first_touch', 'recruiting')).toEqual([50, 110]);
    expect(wordRange('bump', 'recruiting', 'research_position')).toEqual([20, 75]);
    expect(wordRange('bump', 'recruiting')).toEqual([15, 50]);
  });

  it('rules follow the step, and a follow-up never leans on "in case it got buried"', () => {
    expect(nicheRules('ib_coffee_chat', 'bump')[0]).toMatch(/Never "just bumping this"/);
    expect(nicheRules('ib_coffee_chat', 'reply')[0]).toMatch(/two or three concrete times/);
    expect(nicheRules('general', 'congratulate')).toEqual([]);
  });

  it('draftPlaybook adds the firm ask on a coffee chat, the greeting for a professor, the call length', () => {
    const ib = draftPlaybook({
      goalKind: 'recruiting',
      recipient: { title: 'Analyst', org: 'Goldman Sachs' },
      kind: 'first_touch',
    });
    expect(ib.lines).toHaveLength(3);
    expect(ib.lines[1]).toMatch(/A banker is asked about their group/);
    expect(ib.lines[2]).toMatch(/15 minutes/);
    const lab = draftPlaybook({
      goalKind: 'recruiting',
      goalText: 'research assistant position',
      recipient: { title: 'Professor', org: 'MIT' },
      kind: 'bump',
    });
    expect(lab.lines.some((l) => /^Greeting: "Dear Professor/.test(l))).toBe(true);
    expect(lab.lines.some((l) => /A banker|A professor is asked/.test(l))).toBe(false);
  });
});
