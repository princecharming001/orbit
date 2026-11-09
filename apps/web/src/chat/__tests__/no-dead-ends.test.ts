/**
 * Plan 36, no dead ends: a people question always ends with people. On the sample student (who has nobody in
 * climate), the network search shows the next tier instead of an empty card, find_people returns made-up investors
 * that can be added, and a copy without an account or demo goes to the web instead of refusing.
 */
import type { User } from '@orbit/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db/schema';
import { loadDemo } from '../../engine/demo';
import { relatedTerms } from '../../engine/networkSearch/ladder';
import { mockSourcedPeople, setConnectorsMockForTests } from '../../integrations/connectorsMock';
import { execute, modelResult } from '../registry';
import type { ResultEnvelope } from '../types';
import { makeCtx, NOW, nextToolUseId } from './helpers';

let user: User;
beforeAll(async () => {
  user = await loadDemo({ reset: true, now: NOW });
}, 90_000);

afterEach(() => setConnectorsMockForTests(undefined));

type Section = {
  tier: string;
  label: string;
  rows: { person: { id: string; displayName: string }; evidence?: string }[];
};
type Table = { counts: { strong: number; likely: number }; fallback?: Section[]; topic?: string };
const ui = (env: ResultEnvelope) => (env.data as { ui: Table }).ui;
const DEAD_END =
  /Nobody to show|No clear matches|did not find anyone|didn't find anyone|Nobody in your network/i;

describe('search_network never ends empty', () => {
  it('relatedTerms widens climate to its neighbours', () => {
    const t = relatedTerms(['climate']);
    for (const w of ['clean energy', 'solar', 'sustainability', 'carbon', 'ev', 'utilities', 'esg'])
      expect(t).toContain(w);
  });

  it('a climate ask on the demo shows people to ask and the next rung, never an empty answer', async () => {
    for (const input of [
      { ask: 'who do I know who works in climate', industries: ['climate'] },
      { ask: 'who do I know who works in climate', topics: ['climate'] },
    ]) {
      const env = await execute('search_network', input, makeCtx(user, { caller: 'llm' }));
      expect(env.kind).toBe('people_table');
      const t = ui(env);
      expect(t.counts.strong + t.counts.likely).toBe(0);
      const rows = (t.fallback ?? []).flatMap((s) => s.rows);
      expect(rows.length).toBeGreaterThan(0);
      // every row is someone the student knows, with the reason they are there
      const mine = new Set((await db.people.where('userId').equals(user.id).toArray()).map((p) => p.id));
      for (const r of rows) {
        expect(mine.has(r.person.id)).toBe(true);
        expect(r.evidence).toBeTruthy();
      }
      expect(env.summary).not.toMatch(DEAD_END);
      expect(env.summary).toMatch(/Closest/);
      const m = modelResult('search_network', env) as { data: Record<string, unknown> };
      const d = m.data as { nextStep?: string; nextTier?: unknown[]; replyStyle: string };
      expect(d.nextTier?.length).toBeGreaterThan(0);
      // nobody near climate in the demo: the paid rung runs next, without asking
      expect(d.nextStep).toMatch(/find_people/);
      expect(d.nextStep).toMatch(/without asking/);
      expect(d.replyStyle).toMatch(/never answer with nobody/);
      expect(JSON.stringify(d)).not.toMatch(/[—–!]/);
    }
  }, 60_000);

  it('a field the demo is near (crypto, next to its fintech firms) shows a related-field tier first', async () => {
    const env = await execute(
      'search_network',
      { ask: 'who do I know in crypto', industries: ['crypto'] },
      makeCtx(user, { caller: 'llm' }),
    );
    const t = ui(env);
    expect(t.counts.strong + t.counts.likely).toBe(0);
    const first = t.fallback?.[0];
    expect(first?.tier).toBe('related');
    expect(first?.rows.length).toBeGreaterThan(0);
    expect(first?.rows[0]?.evidence).toMatch(/Fintech|Trading/);
    expect(env.summary).toMatch(/in a related field/);
    const d = (modelResult('search_network', env) as { data: { nextStep?: string } }).data;
    expect(d.nextStep).toMatch(/one short question/);
  }, 60_000);

  it('a company nobody is at shows who can introduce or could know someone', async () => {
    const env = await execute(
      'search_network',
      { ask: 'who do I know at SpaceX', companies: ['SpaceX'] },
      makeCtx(user, { caller: 'llm' }),
    );
    const t = ui(env);
    expect(t.counts.strong + t.counts.likely).toBe(0);
    expect((t.fallback ?? []).flatMap((s) => s.rows).length).toBeGreaterThan(0);
    expect(t.topic).toBe('SpaceX');
  }, 60_000);
});

describe('find_people never refuses', () => {
  it('mock sourcing finds seed investors in climate software at made-up firms', () => {
    const a = mockSourcedPeople({ purpose: 'fundraising', query: 'seed investors in climate software' }, 10);
    const b = mockSourcedPeople({ purpose: 'fundraising', query: 'seed investors in climate software' }, 10);
    expect(a).toHaveLength(10);
    expect(a.map((x) => x.found.name)).toEqual(b.map((x) => x.found.name));
    expect(new Set(a.map((x) => x.found.name)).size).toBe(10);
    for (const x of a) {
      expect(x.title).toMatch(/Partner|Principal|Associate/);
      expect(x.why).toMatch(/seed climate software/);
      expect(x.found.profileUrl).toBeUndefined();
    }
  });

  it('the demo answers "10 seed investors in climate software" with ten new people it can add', async () => {
    const env = await execute(
      'find_people',
      { purpose: 'fundraising', query: 'seed investors in climate software', topic: 'climate software' },
      makeCtx(user, { caller: 'llm' }),
    );
    expect(env.kind).toBe('list');
    const items = (env.data as { ui: { items: { id: string; person?: { role?: string } }[] } }).ui.items;
    expect(items).toHaveLength(10);
    for (const it of items) expect(it.person?.role).toMatch(/ at /);
    expect(env.summary).toMatch(/new people you do not know yet/);
    expect(env.summary).not.toMatch(/needs an Orbit account/);
    const m = (modelResult('find_people', env) as { data: { results: { knownPersonId?: string }[] } }).data;
    expect(m.results.every((r) => !r.knownPersonId)).toBe(true);
    expect(m.results).toHaveLength(10);
    // picked people can be added like LinkedIn finds, saved to contact
    const ctx = makeCtx(user, { caller: 'ui' });
    const ask = await execute('add_sourced', { recommendationIds: [items[0]!.id] }, ctx);
    const added = await execute(
      'add_sourced',
      { recommendationIds: [items[0]!.id] },
      { ...ctx, confirmation: ask.confirmationId, toolUseId: nextToolUseId() },
    );
    expect(added.summary).toMatch(/saved to contact/);
  }, 60_000);

  it('a copy with no account and no demo goes to the web instead of refusing', async () => {
    setConnectorsMockForTests(false);
    const env = await execute(
      'find_people',
      { purpose: 'fundraising', query: 'seed investors in climate software' },
      makeCtx(user, { caller: 'llm' }),
    );
    expect(env.kind).toBe('text');
    expect(env.summary).toMatch(/next step is the web/);
    const d = (modelResult('find_people', env) as { data: { nextStep: string } }).data;
    expect(d.nextStep).toMatch(/web_search/);
    expect(d.nextStep).toMatch(/Never refuse/);
  }, 60_000);
});
