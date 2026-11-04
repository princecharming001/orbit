import { ASK_RULES, type DraftContext } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { draftKnowledgeRules, draftPlaybookFor } from './draftKnowledge';

const user = (over: Partial<DraftContext['user']> = {}): DraftContext['user'] => ({
  firstName: 'Maya',
  fullName: 'Maya Okonkwo',
  school: 'Cornell',
  majors: ['Computer Science'],
  cycleLabel: 'Summer 2027 internships',
  targetFunctions: ['ib'],
  timezone: 'America/New_York',
  ...over,
});
const person = (over: Partial<DraftContext['person']> = {}): DraftContext['person'] => ({
  firstName: 'Dan',
  fullName: 'Dan Lee',
  relationshipType: 'alumni',
  strength: 0.3,
  ...over,
});

describe('draftKnowledgeRules (plan 30: the niche playbook, shared with the server)', () => {
  it('a banker gets the IB coffee chat norms and what to ask a bank, numbered from 13', () => {
    const [r13, r14] = draftKnowledgeRules({
      user: user(),
      person: person({ title: 'Analyst, Healthcare', org: 'Evercore' }),
      kind: 'outreach',
    });
    expect(r13).toMatch(/^13\. This is an investment banking coffee chat\./);
    expect(r13).toMatch(/Never a job, an interview, a referral/);
    expect(r14).toBe(`14. ${ASK_RULES.bank}`);
  });

  it('a founder raising a round gets the investor norms, never a banking line or a firm ask', () => {
    const rules = draftKnowledgeRules({
      user: user({ goal: 'fundraising', targetFunctions: [], cycleLabel: 'Pre-seed round' }),
      person: person({ title: 'Partner', org: 'Lightspeed Venture Partners' }),
      kind: 'outreach',
    });
    expect(rules[0]).toMatch(/a founder writing to an investor/);
    expect(rules.join(' ')).not.toMatch(/your group|coffee chat/);
  });

  it('a student asking a professor about a lab gets the formal greeting and the longer range', () => {
    const p = draftPlaybookFor({
      user: user({
        goal: 'recruiting',
        goalText: 'Undergraduate research position in a sleep lab',
        targetFunctions: [],
      }),
      person: person({ title: 'Associate Professor of Psychology', org: 'UC Davis' }),
      kind: 'outreach',
    });
    expect(p.niche).toBe('research_position');
    expect(p.lines.join('\n')).toMatch(/Dear Professor <last name>/);
    expect(p.form.gradeMax).toBe(10);
  });

  it('a follow-up carries the follow-up norm and no first-message ask rule', () => {
    const rules = draftKnowledgeRules({
      user: user(),
      person: person({ title: 'Analyst', org: 'Evercore' }),
      kind: 'bump',
    });
    expect(rules[0]).toMatch(/Never "just bumping this"/);
    expect(rules.join(' ')).not.toContain(ASK_RULES.bank);
  });

  it('a goal the student set wins over the cycle label, and a goal brief rides along', () => {
    const p = draftPlaybookFor({
      user: user({
        goal: 'recruiting',
        goalText: 'Founding engineer role at a seed-stage startup that is hiring now',
        goalBrief: 'Mention the open-source CLI I maintain.',
        targetFunctions: [],
      }),
      person: person({ title: 'CTO and Co-founder', org: 'Fieldnote' }),
      kind: 'outreach',
    });
    expect(p.niche).toBe('startup_job');
    expect(p.lines).toContain('For this goal in particular: Mention the open-source CLI I maintain.');
  });
});
