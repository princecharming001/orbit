import { describe, expect, it } from 'vitest';
import { loadDemo } from '../../../engine/demo';
import { createFakeOrbitApi } from '../../../test/fakeOrbitApi';
import { registry } from '../../registry';
import { NOW } from '../helpers';
import { seed, shapeCheck, type Transcript, teardownSim } from './harness';
import { CAMPAIGN_GROUPS, GROUPS, SCENARIOS } from './scenarios';

/** The simulated students need a Claude key to run; this checks, without one, that every scenario can. */
describe('sim scenarios', () => {
  it('cover the plan 28 campaign: knowledge, web, shape, honesty and the new students, each with its reference', () => {
    for (const g of [
      'knowledge',
      'data',
      'drafting',
      'goals',
      'web',
      'shape',
      'honesty',
      'persona-soph-ib',
      'persona-founder-seed',
      'persona-hiring',
      'persona-advice',
      'persona-switcher',
      'persona-intl',
      'persona-empty',
      'persona-quiet',
    ])
      expect(CAMPAIGN_GROUPS).toContain(g);
    // every knowledge question carries the standard the judge scores it against
    for (const s of SCENARIOS.filter((x) => x.group === 'knowledge'))
      expect(s.reference?.length ?? 0, s.id).toBeGreaterThan(80);
    // a scenario cannot both need and forbid the web
    for (const s of SCENARIOS) expect(s.expectWeb && s.noWeb, s.id).toBeFalsy();
  });

  it('build every student profile: the sophomore, the founder, the hiring founder, the freshman, the switcher, the international student', async () => {
    try {
      for (const id of [
        'know-ib-start',
        'draft-founder-first',
        'hiring-who-first',
        'advice-where-start',
        'switch-story',
        'intl-first-banker',
      ]) {
        const s = SCENARIOS.find((x) => x.id === id)!;
        const { user } = await seed(s.account);
        expect(user.firstName, id).not.toBe('Jordan');
        const goals = await (await import('../../../db/schema')).db.userGoals
          .where('userId')
          .equals(user.id)
          .toArray();
        expect(goals.length, `${id} has a goal`).toBeGreaterThan(0);
        const people = await (await import('../../../db/schema')).db.people
          .where('userId')
          .equals(user.id)
          .toArray();
        expect(people.length, `${id} has people`).toBeGreaterThan(3);
      }
    } finally {
      teardownSim();
    }
  }, 120_000);

  it('shapeCheck reads the rules the prompt states off a transcript', () => {
    const turn = (over: Partial<Transcript['turns'][number]>): Transcript['turns'][number] => ({
      student: 'who should i message',
      tools: [],
      text: 'Lena, then Daniel.',
      web: [],
      preamble: '',
      betweenTools: 0,
      pills: 0,
      ...over,
    });
    const clean = shapeCheck({ persona: '', goal: '', screen: '', turns: [turn({})] });
    expect(clean.ok).toBe(true);
    const bad = shapeCheck(
      {
        persona: '',
        goal: '',
        screen: '',
        turns: [
          turn({
            text: 'Let me look at a few things first, this will take a moment while I check your pipeline and your drafts.\n\nOne more thing.\n\nHere you go — three names!',
            preamble:
              'Let me look at a few things first, this will take a moment while I check your pipeline and your drafts.',
            betweenTools: 1,
            pills: 5,
            web: [
              { query: 'a', sources: 2 },
              { query: 'b', sources: 2 },
              { query: 'c', sources: 2 },
              { query: 'd', sources: 2 },
            ],
          }),
        ],
      },
      { noWeb: true },
    );
    expect(bad.ok).toBe(false);
    expect(bad.problems.join('\n')).toMatch(/written before the tools/);
    expect(bad.problems.join('\n')).toMatch(/between rounds/);
    expect(bad.problems.join('\n')).toMatch(/4 web searches/);
    expect(bad.problems.join('\n')).toMatch(/dash or an exclamation/);
    expect(bad.problems.join('\n')).toMatch(/5 next-step pills/);
    expect(bad.problems.join('\n')).toMatch(/playbook answers/);
    expect(bad.stats.webSearches).toBe(4);
    // a wide goal lifts the per-turn caps, not the rest
    const wide = shapeCheck(
      {
        persona: '',
        goal: '',
        screen: '',
        turns: [turn({ web: [{ sources: 1 }, { sources: 1 }, { sources: 1 }, { sources: 1 }] })],
      },
      { wide: true },
    );
    expect(wide.ok).toBe(true);
    expect(
      shapeCheck({ persona: '', goal: '', screen: '', turns: [turn({})] }, { expectWeb: true }).problems[0],
    ).toMatch(/no web search/);
  });

  it('have unique ids, the plan 16 persona groups with four scenarios each, and the new singles', () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of ['persona-intern', 'persona-founder', 'persona-sales', 'persona-phd']) {
      expect(GROUPS).toContain(g);
      expect(SCENARIOS.filter((s) => s.group === g)).toHaveLength(4);
    }
    for (const id of [
      'goal-infer',
      'memory-pref',
      'research-person',
      'find-investors',
      'reply-schedule',
      'autonomy-refuse-linkedin',
    ])
      expect(ids).toContain(id);
  });

  it('only expect tools the registry has', () => {
    for (const s of SCENARIOS)
      for (const anyOf of s.expectTools ?? [])
        for (const t of anyOf) expect(registry.has(t), `${s.id}: ${t}`).toBe(true);
  });

  it('seed the fake orbit-api for every account scenario against the demo', async () => {
    const user = await loadDemo({ reset: true, now: NOW });
    for (const s of SCENARIOS.filter((x) => x.api)) {
      const api = createFakeOrbitApi();
      await s.api!(api, user);
      if (['founder-investors', 'find-investors', 'sales-find', 'phd-find'].includes(s.id))
        expect(api.state.sourced.length, s.id).toBeGreaterThan(0);
      if (['reply-schedule', 'memory-pref'].includes(s.id)) expect(api.state.replies, s.id).toHaveLength(1);
      if (['phd-research', 'research-person'].includes(s.id)) expect(api.state.dossiers.size, s.id).toBe(1);
      if (['intern-route', 'founder-intro'].includes(s.id)) expect(api.state.paths.size, s.id).toBe(1);
    }
  }, 90_000);
});
