import { ASK_RULES, DRAFT_RULES, type DraftContext } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { draftKnowledgeRules } from './draftKnowledge';

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

describe('draftKnowledgeRules (plan 28 §3b, channel 3)', () => {
  it('appends the goal register and the firm ask rule as rules 13 and 14', () => {
    const [r13, r14] = draftKnowledgeRules({
      user: user(),
      person: person({ title: 'Analyst, Healthcare', org: 'Evercore' }),
    });
    expect(r13).toBe(`13. ${DRAFT_RULES.recruiting}`);
    expect(r14).toBe(`14. ${ASK_RULES.bank}`);
  });

  it('a founder raising a round gets the fundraising register and the investor ask, never a banking line', () => {
    const [r13, r14] = draftKnowledgeRules({
      user: user({ goal: 'fundraising', targetFunctions: [], cycleLabel: 'Pre-seed round' }),
      person: person({ title: 'Partner', org: 'Lightspeed Venture Partners' }),
    });
    expect(r13).toMatch(/Fundraising register/);
    expect(r13).toMatch(/Never a job hunting line/);
    expect(r14).toBe(`14. ${ASK_RULES.vc}`);
    expect(r14).not.toMatch(/your group/);
  });

  it('reads the goal from the cycle when none is set, and the firm from the title and org', () => {
    const [r13, r14] = draftKnowledgeRules({
      user: user({ cycleLabel: 'Raising a seed round in January', targetFunctions: [] }),
      person: person({ title: 'Associate Professor of Computer Science', org: 'Cornell University' }),
    });
    expect(r13).toMatch(/^13\. Fundraising register/);
    expect(r14).toBe(`14. ${ASK_RULES.academic}`);
    const [, consulting] = draftKnowledgeRules({
      user: user({ targetFunctions: ['consulting'] }),
      person: person({ title: 'Consultant', org: 'Bain & Company' }),
    });
    expect(consulting).toBe(`14. ${ASK_RULES.consulting}`);
    const [, unknown] = draftKnowledgeRules({ user: user({ targetFunctions: [] }), person: person() });
    expect(unknown).toBe(`14. ${ASK_RULES.other}`);
  });
});
