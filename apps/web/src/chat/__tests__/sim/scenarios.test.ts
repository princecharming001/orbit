import { describe, expect, it } from 'vitest';
import { loadDemo } from '../../../engine/demo';
import { createFakeOrbitApi } from '../../../test/fakeOrbitApi';
import { registry } from '../../registry';
import { NOW } from '../helpers';
import { GROUPS, SCENARIOS } from './scenarios';

/** The simulated students need a Claude key to run; this checks, without one, that every scenario can. */
describe('sim scenarios', () => {
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
