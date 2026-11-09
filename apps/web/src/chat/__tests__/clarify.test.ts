/**
 * Plan 37, ask before you guess. A company name that fits two companies the student knows people at is a question
 * back with the choices as buttons, from every tool that takes a company; a name that fits one, a known parent, an
 * exact name and a target never ask; the pick holds for the rest of the conversation and finishes the ask it
 * interrupted, with or without the model.
 */
import type { User } from '@orbit/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db/schema';
import { companyEntries, decideCompany, rememberResolution } from '../../engine/companyRef';
import { loadDemo } from '../../engine/demo';
import { clearPrefs } from '../../integrations/prefs';
import { createChatEngine } from '../agent';
import { ChatStore } from '../agent/store';
import {
  CLARIFY_INSTRUCTION,
  parsePick,
  pickMessage,
  readClarify,
  resolutionOf,
  routedText,
  withoutPick,
} from '../clarify';
import { execute, modelResult, registry } from '../registry';
import type { ClarifyData, ResultEnvelope, TurnEvent } from '../types';
import { withoutRefs } from '../ui/cards/next';
import { makeCtx, NOW } from './helpers';

let user: User;
beforeAll(async () => {
  user = await loadDemo({ reset: true, now: NOW });
  await clearPrefs();
}, 90_000);

const clarify = (env: ResultEnvelope): ClarifyData => {
  expect(env.kind).toBe('clarify');
  const c = readClarify(env.data);
  expect(c).toBeDefined();
  return c!;
};
const labels = (c: ClarifyData) => c.options.map((o) => o.label).sort();

describe('decideCompany (the pure rule)', () => {
  const entries = companyEntries({
    people: [
      { id: 'a', currentOrganizationRaw: 'Triumph Law', isHuman: true },
      { id: 'b', currentOrganizationRaw: 'Triumph Law LLP', isHuman: true },
      { id: 'c', currentOrganizationRaw: 'Triumph Education Group', isHuman: true },
      { id: 'd', currentOrganizationRaw: 'Stripe', isHuman: true },
      { id: 'e', currentOrganizationRaw: 'Stripe Capital Partners', isHuman: true },
      { id: 'f', currentOrganizationRaw: 'Amazon Web Services', isHuman: true },
      { id: 'g', currentOrganizationRaw: 'Amazon Robotics', isHuman: true },
      { id: 'h', currentOrganizationRaw: 'Metaview', isHuman: true },
      { id: 'i', currentOrganizationRaw: 'Lumen Bio', isHuman: true },
      { id: 'j', currentOrganizationRaw: 'Lumen Labs', isHuman: true },
      { id: 'k', currentOrganizationRaw: 'Hidden Co', isHuman: true, hiddenAt: '2026-01-01' },
    ],
    orgs: [{ id: 'org_triumph_edu', name: 'Triumph Education Group', industry: 'Education' }],
    affiliations: [
      { personId: 'd', nameRaw: 'Ember Analytics', isCurrent: false, kind: 'employment' },
      { personId: 'd', nameRaw: 'Ember Health', isCurrent: false, kind: 'employment' },
    ],
    targets: [{ nameRaw: 'Lumen Labs' }],
  });

  it('two companies that start with the name are a question, the bigger first, with what each is', () => {
    const r = decideCompany('Triumph', entries);
    expect(r.kind).toBe('many');
    if (r.kind !== 'many') return;
    expect(r.options.map((o) => o.label)).toEqual(['Triumph Law', 'Triumph Education Group']);
    // "Triumph Law" and "Triumph Law LLP" are one company
    expect(r.options[0]!.sub).toBe('2 people you know there');
    expect(r.options[1]).toMatchObject({ id: 'org_triumph_edu', organizationId: 'org_triumph_edu' });
    expect(r.options[1]!.sub).toBe('Education. 1 person you know there');
  });

  it('people who used to work there count, and say so', () => {
    const r = decideCompany('ember', entries);
    expect(r.kind).toBe('many');
    if (r.kind === 'many') expect(r.options[0]!.sub).toBe('1 person who used to work there');
  });

  it('an exact name wins over longer names that start with it', () => {
    expect(decideCompany('Stripe', entries)).toMatchObject({ kind: 'one', label: 'Stripe' });
    expect(decideCompany('stripe, inc.', entries)).toMatchObject({ kind: 'one', label: 'Stripe' });
  });

  it('a known parent never asks: the search covers its brands', () => {
    expect(decideCompany('Amazon', entries).kind).toBe('none');
  });

  it('only whole words from the start count: Meta is not Metaview, Law is not Triumph Law', () => {
    expect(decideCompany('Meta', entries).kind).toBe('none');
    expect(decideCompany('Law', entries).kind).toBe('none');
  });

  it('a target among the candidates is what they mean', () => {
    expect(decideCompany('Lumen', entries)).toMatchObject({ kind: 'one', label: 'Lumen Labs' });
  });

  it('a pick earlier in the conversation is what they mean', () => {
    const r = decideCompany('Triumph', entries, [
      { about: 'company', term: 'triumph', id: 'org_triumph_edu', label: 'Triumph Education Group' },
    ]);
    expect(r).toMatchObject({ kind: 'one', id: 'org_triumph_edu' });
  });

  it('hidden people, unknown names and very short names never make a question', () => {
    expect(decideCompany('Hidden', entries).kind).toBe('none');
    expect(decideCompany('Nowhere', entries).kind).toBe('none');
    expect(decideCompany('Tr', entries).kind).toBe('none');
  });
});

describe('the pick message', () => {
  const option = { id: 'org_juniper-capital', label: 'Juniper Capital' };

  it('reads back exactly, shows only the label, and finishes the ask for the router', () => {
    const m = pickMessage('company', 'Juniper', option, 'who do I know at Juniper');
    expect(parsePick(m)).toEqual({
      about: 'company',
      id: 'org_juniper-capital',
      term: 'Juniper',
      label: 'Juniper Capital',
      ask: 'who do I know at Juniper',
    });
    expect(withoutRefs(m)).toBe('Juniper Capital');
    expect(withoutPick(m)).toBe('Juniper Capital');
    expect(routedText(m)).toBe('who do I know at Juniper');
    expect(routedText('Juniper Capital [picked company x for "Juniper"]')).toBe('Juniper Capital');
    expect(routedText('who do I know at Stripe')).toBe('who do I know at Stripe');
  });

  it('carries an id with spaces and an ask with brackets and quotes', () => {
    const m = pickMessage(
      'company',
      'Tri "umph',
      { id: 'Triumph Law', label: 'Triumph Law' },
      'at [Triumph] "now"',
    );
    const p = parsePick(m)!;
    expect(p.id).toBe('Triumph Law');
    expect(p.ask).toBe('at Triumph now');
    expect(resolutionOf(p)).toEqual({
      about: 'company',
      term: 'tri umph',
      id: 'Triumph Law',
      label: 'Triumph Law',
      organizationId: undefined,
    });
  });
});

describe('every company tool asks first on the demo (Juniper Health and Juniper Capital)', () => {
  it('find_routes, by company and by query', async () => {
    for (const input of [{ company: 'Juniper' }, { query: 'juniper' }]) {
      const env = await execute('find_routes', input, makeCtx(user, { caller: 'llm' }));
      const c = clarify(env);
      expect(labels(c)).toEqual(['Juniper Capital', 'Juniper Health']);
      expect(c.question).toBe(`Which ${input.company ?? input.query}?`);
      expect(c.options.find((o) => o.label === 'Juniper Health')!.sub).toBe(
        'Healthcare. 2 people you know there',
      );
      // the model is told to ask and stop, and given the choices to name
      const m = modelResult('find_routes', env) as { data: Record<string, unknown> };
      expect(m.data.howToAnswer).toBe(CLARIFY_INSTRUCTION);
      expect(String(m.data.choices)).toMatch(/Juniper Health/);
      expect(env.summary).not.toMatch(/nobody/i);
    }
  });

  it('search_network and find_people', async () => {
    const s = await execute(
      'search_network',
      { ask: 'who do I know at Juniper', companies: ['Juniper'] },
      makeCtx(user, { caller: 'llm' }),
    );
    expect(labels(clarify(s))).toEqual(['Juniper Capital', 'Juniper Health']);
    const f = await execute(
      'find_people',
      { purpose: 'recruiting', query: 'product managers at Juniper', organization: 'Juniper' },
      makeCtx(user, { caller: 'llm' }),
    );
    expect(labels(clarify(f))).toEqual(['Juniper Capital', 'Juniper Health']);
  });

  it('a company that fits one never asks: Stripe, Ramp, and a full name', async () => {
    for (const company of ['Stripe', 'Ramp', 'Juniper Health']) {
      const env = await execute('find_routes', { company }, makeCtx(user, { caller: 'llm' }));
      expect(env.kind).toBe('company');
    }
    const s = await execute(
      'search_network',
      { ask: 'PMs at Stripe', roles: ['product'], companies: ['Stripe'] },
      makeCtx(user, { caller: 'llm' }),
    );
    expect(s.kind).toBe('people_table');
  });

  it('after a pick, the same name means that company for the rest of the conversation', async () => {
    const conversationId = 'conv_pick';
    await rememberResolution(conversationId, {
      about: 'company',
      term: 'juniper',
      id: 'org_juniper-capital',
      label: 'Juniper Capital',
      organizationId: 'org_juniper-capital',
    });
    const env = await execute('find_routes', { company: 'Juniper' }, makeCtx(user, { conversationId }));
    expect(env.kind).toBe('company');
    expect((env.data as { ui: { company: string } }).ui.company).toBe('Juniper Capital');
    // another conversation still asks
    const other = await execute(
      'find_routes',
      { company: 'Juniper' },
      makeCtx(user, { conversationId: 'conv_other' }),
    );
    expect(other.kind).toBe('clarify');
  });

  describe('a target settles it', () => {
    afterEach(() => db.targetCompanies.delete('tc_juniper'));
    it('Juniper Health on the targets means Juniper Health', async () => {
      await db.targetCompanies.add({
        id: 'tc_juniper',
        userId: user.id,
        organizationId: 'org_juniper-health',
        nameRaw: 'Juniper Health',
        priority: 2,
        status: 'researching',
      });
      const env = await execute('find_routes', { company: 'Juniper' }, makeCtx(user));
      expect(env.kind).toBe('company');
      expect((env.data as { ui: { company: string } }).ui.company).toBe('Juniper Health');
    });
  });
});

describe('without a Claude key, the router asks and the pick finishes the ask', () => {
  it('who do I know at Juniper: a question; the tap: the company card for the pick', async () => {
    const engine = createChatEngine({
      registry,
      execute,
      user: () => user,
      store: new ChatStore(),
      now: () => NOW,
    });
    expect(engine.mode()).toBe('router');
    const c = await engine.startConversation({ temporary: false });
    const first: TurnEvent[] = [];
    await engine.send(c.id, 'who do I know at Juniper', (e) => first.push(e));
    const asked = first.find((e) => e.type === 'tool_result') as Extract<TurnEvent, { type: 'tool_result' }>;
    const q = clarify(asked.envelope);
    const pick = q.options.find((o) => o.label === 'Juniper Health')!;
    const second: TurnEvent[] = [];
    await engine.send(c.id, pickMessage('company', q.term, pick, 'who do I know at Juniper'), (e) =>
      second.push(e),
    );
    const done = second.find((e) => e.type === 'tool_result') as Extract<TurnEvent, { type: 'tool_result' }>;
    expect(done.envelope.kind).toBe('company');
    expect((done.envelope.data as { ui: { company: string } }).ui.company).toBe('Juniper Health');
    // the conversation keeps the pick, and its title is the student's words
    const conv = await db.chatConversations.get(c.id);
    expect(conv?.resolved).toEqual([
      expect.objectContaining({
        term: 'juniper',
        label: 'Juniper Health',
        organizationId: 'org_juniper-health',
      }),
    ]);
    expect(conv?.title).toBe('who do I know at Juniper');
  });
});
