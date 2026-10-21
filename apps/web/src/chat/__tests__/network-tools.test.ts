import type { Person, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../../db/schema';
import { createLocalUser } from '../../engine/account';
import { clearPathCacheForTests } from '../../engine/paths';
import { setConnectorsMockForTests } from '../../integrations/connectorsMock';
import { setOrbitApiBaseForTests } from '../../integrations/orbitApi';
import { leaveFakeApi, signInToFakeApi } from '../../test/account';
import { type FakeOrbitApi, fakeDossier } from '../../test/fakeOrbitApi';
import { execute, modelResult } from '../registry';
import type { ResultEnvelope, ToolContext } from '../types';
import { makeCtx, nextToolUseId } from './helpers';

const DASHES = /[—–]/;
const at = '2026-10-06T12:00:00.000Z';

async function addPerson(user: User, id: string, name: string, extra: Partial<Person> = {}): Promise<Person> {
  const [first, ...rest] = name.split(' ');
  const p = {
    id,
    userId: user.id,
    displayName: name,
    firstName: first!,
    lastName: rest.join(' '),
    nameNormalized: name.toLowerCase(),
    emails: [],
    relationshipType: 'unknown',
    strength: 0.62,
    tieScore: 62,
    tieBand: 'strong',
    tieExplanation: ['14 messages between you (6 from them)', 'You both went to Cornell'],
    interactionCount: 3,
    sources: ['manual'],
    isHuman: true,
    tags: [],
    createdAt: at,
    updatedAt: at,
    ...extra,
  } as Person;
  await db.people.put(p);
  return p;
}

/** Run a tool; a risky one is approved with its token like the Approve button does. */
async function run(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ResultEnvelope> {
  const env = await execute(name, input, ctx);
  if (env.kind !== 'needs_confirmation') return env;
  return execute(name, input, { ...ctx, confirmation: env.confirmationId, toolUseId: nextToolUseId() });
}

function plainSummary(env: ResultEnvelope) {
  expect(env.summary).not.toMatch(DASHES);
  expect(env.summary).not.toMatch(/!/);
  expect(env.summary).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
}

describe('local mode', () => {
  let user: User;
  beforeEach(async () => {
    await wipeDatabase();
    setOrbitApiBaseForTests(null);
    user = await createLocalUser({
      fullName: 'Alex Rivera',
      firstName: 'Alex',
      school: 'Cornell University',
    });
    await addPerson(user, 'p_priya', 'Priya Shah');
  });
  afterEach(() => setOrbitApiBaseForTests(undefined));

  it('set_goal, list_goals, update_goal and archive_goal keep goals in the browser', async () => {
    const ctx = () => makeCtx(user, { toolUseId: nextToolUseId() });
    const set = await execute(
      'set_goal',
      { kind: 'fundraising', title: 'Raise a pre-seed', stage: 'pre-seed' },
      ctx(),
    );
    expect(set.kind).toBe('list');
    plainSummary(set);
    expect(set.summary).toMatch(/Tracking a new goal: Fundraising: Raise a pre-seed/);
    const goals = await db.userGoals.toArray();
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({
      kind: 'fundraising',
      status: 'active',
      source: 'user',
      criteria: { stage: 'pre-seed' },
    });
    const listed = await execute('list_goals', {}, ctx());
    expect(JSON.stringify(modelResult('list_goals', listed))).toContain(goals[0]!.id);
    const upd = await execute(
      'update_goal',
      { goalId: goals[0]!.id, organizations: ['Sequoia'], status: 'paused' },
      ctx(),
    );
    expect(upd.kind).toBe('list');
    expect((await db.userGoals.get(goals[0]!.id))?.targets.organizations).toEqual(['Sequoia']);
    const arch = await execute('archive_goal', { goalId: goals[0]!.id }, ctx());
    expect(arch.summary).toMatch(/Archived "Raise a pre-seed"/);
    expect((await execute('list_goals', {}, ctx())).summary).toMatch(/No goals yet/);
  });

  it("set_goal keeps an inferred goal's words, and refuses a sixth active goal", async () => {
    const ctx = () => makeCtx(user, { toolUseId: nextToolUseId() });
    await execute('set_goal', { kind: 'fundraising', evidence: "I'm raising a pre-seed in January" }, ctx());
    expect((await db.userGoals.toArray())[0]).toMatchObject({
      source: 'inferred',
      evidence: "I'm raising a pre-seed in January",
    });
    for (const kind of ['sales', 'hiring', 'advice', 'community'])
      expect((await execute('set_goal', { kind }, ctx())).kind).toBe('list');
    const sixth = await execute('set_goal', { kind: 'cofounder' }, ctx());
    expect(sixth.kind).toBe('error');
    expect(sixth.summary).toMatch(/5 active goals/);
  });

  it("explain_score reads the browser's score; rate_closeness overrides it with the band midpoint", async () => {
    const ctx = () => makeCtx(user, { toolUseId: nextToolUseId() });
    const ex = await execute('explain_score', { personId: 'p_priya' }, ctx());
    expect(ex.kind).toBe('list');
    expect(ex.summary).toMatch(/Priya Shah is 62 · Strong\. 14 messages between you/);
    const rated = await execute('rate_closeness', { personId: 'p_priya', closeness: 5 }, ctx());
    expect(rated.summary).toMatch(/"very close", shown as 90 · Close/);
    expect(await db.tieLabels.get('p_priya')).toMatchObject({ closeness: 5, modelScore: 62 });
    const again = await execute('explain_score', { personId: 'p_priya' }, ctx());
    expect(modelResult('explain_score', again).data).toMatchObject({
      score: 90,
      ratedByStudent: 'Very close',
      modelScore: 62,
    });
  });

  it('with LinkedIn live in this browser, find_people searches it and add_sourced adds who the student picks', async () => {
    setConnectorsMockForTests(true);
    try {
      await db.integrations.put({
        id: 'int_li',
        userId: user.id,
        provider: 'linkedin_live',
        externalAccountId: 'demo-linkedin-account',
        status: 'active',
        scopes: [],
        syncState: {},
        connectedAt: at,
      });
      const found = await execute(
        'find_people',
        { purpose: 'recruiting', query: 'product managers in San Francisco' },
        makeCtx(user, { toolUseId: nextToolUseId() }),
      );
      expect(found.kind).toBe('list');
      plainSummary(found);
      expect(found.summary).toMatch(/on LinkedIn outside your connections/);
      const results = (modelResult('find_people', found).data as { results: { recommendationId: string }[] })
        .results;
      expect(results[0]!.recommendationId).toMatch(/^li:/);
      const added = await execute(
        'add_sourced',
        { recommendationIds: [results[0]!.recommendationId] },
        makeCtx(user, { toolUseId: nextToolUseId() }),
      );
      expect(added.summary).toMatch(/ready to write to on LinkedIn/);
      const person = (await db.people.toArray()).find((p) => p.id !== 'p_priya')!;
      expect(person.linkedinMemberId).toMatch(/^demo-search-/);
      const chat = await db.chats.where('personId').equals(person.id).first();
      expect(chat).toMatchObject({ stage: 'identified', outreachChannel: 'linkedin' });
    } finally {
      setConnectorsMockForTests(undefined);
    }
  });

  it('the account tools answer in plain words that they need an Orbit account, never an error', async () => {
    const reads: [string, Record<string, unknown>][] = [
      ['research_person', { personId: 'p_priya' }],
      ['get_dossier', { personId: 'p_priya' }],
      ['find_people', { purpose: 'sales' }],
      ['add_sourced', { recommendationIds: ['r1'] }],
      ['list_replies', {}],
      ['draft_reply', { messageId: 'm1' }],
      ['pause_outreach', { until: '2026-12-20' }],
      ['list_due', {}],
      ['remember', { text: 'Prefers morning calls', kind: 'preference' }],
      ['recall', { query: 'calls' }],
    ];
    for (const [name, input] of reads) {
      const env = await execute(name, input, makeCtx(user, { toolUseId: nextToolUseId() }));
      expect(env.kind, name).toBe('text');
      expect(env.summary, name).toMatch(/needs an Orbit account/);
      plainSummary(env);
    }
    // risky ones explain on the Approve card why they cannot run
    for (const [name, input] of [
      ['ask_for_intro', { pathId: 'x' }],
      ['set_autonomy', { level: 1 }],
      ['forget', { memoryId: 'm' }],
    ] as const) {
      const env = await execute(name, input, makeCtx(user, { toolUseId: nextToolUseId() }));
      expect(env.kind, name).toBe('needs_confirmation');
      expect((env.data as { blockedReason?: string }).blockedReason, name).toMatch(/Orbit account/);
    }
    // book_call works in this browser too (Google sends the invite); it only needs to know who the call is with
    const book = await execute(
      'book_call',
      { slotStart: '2026-10-21T14:00:00Z' },
      makeCtx(user, { toolUseId: nextToolUseId() }),
    );
    expect(book.kind).toBe('needs_confirmation');
    expect((book.data as { blockedReason?: string }).blockedReason).toMatch(/who the call is with/);
  });
});

describe('account mode, against a fake orbit-api', () => {
  let api: FakeOrbitApi;
  let user: User;
  const P1 = '0b8f6a0e-1111-4c2e-8d1a-000000000001';
  const P2 = '0b8f6a0e-1111-4c2e-8d1a-000000000002';
  const ctx = () => makeCtx(user, { toolUseId: nextToolUseId() });

  beforeEach(async () => {
    await wipeDatabase();
    clearPathCacheForTests();
    ({ api, user } = await signInToFakeApi());
    await addPerson(user, P1, 'Priya Shah');
    await addPerson(user, P2, 'Sam Lee');
  });
  afterEach(async () => {
    await leaveFakeApi();
  });

  it('goals go through /goals/upsert and /goals/archive', async () => {
    const set = await execute('set_goal', { kind: 'sales', title: 'Find 10 dental clinics' }, ctx());
    expect(set.kind).toBe('list');
    expect(api.routes()).toContain('/goals/upsert');
    const goal = (await db.userGoals.toArray())[0]!;
    expect(api.state.goals[0]!.id).toBe(goal.id);
    await execute('archive_goal', { goalId: goal.id }, ctx());
    expect(api.routes()).toContain('/goals/archive');
  });

  it('explain_score and rate_closeness ask the server', async () => {
    api.state.scores.set(P1, { score: 81, band: 'close', explanation: ['4 meetings in the last 2 years'] });
    const ex = await execute('explain_score', { personId: P1 }, ctx());
    expect(ex.summary).toMatch(/81 · Close\. 4 meetings/);
    await execute('rate_closeness', { personId: P1, closeness: 2 }, ctx());
    expect(api.state.labels.get(P1)).toBe(2);
    // kept here without being queued to go up again
    expect(await db.tieLabels.get(P1)).toMatchObject({ closeness: 2 });
  });

  it('research_person queues, then get_dossier shows the cited brief', async () => {
    api.state.researchQueue.set(P1, fakeDossier(user.id, P1));
    const queued = await execute('research_person', { personId: P1 }, ctx());
    expect(queued.kind).toBe('text');
    expect(queued.summary).toMatch(/Started researching Priya Shah/);
    const got = await execute('get_dossier', { personId: P1 }, ctx());
    expect(got.kind).toBe('list');
    expect(got.summary).toMatch(/1 opener, 2 sources/);
    const m = JSON.stringify(modelResult('get_dossier', got));
    expect(m).toContain('Your talk on fraud models stuck with me.');
    expect(m).toContain('<untrusted_');
    const items = (got.data as { ui: { items: { chip?: string; links: { url: string }[] }[] } }).ui.items;
    expect(items.find((i) => i.chip === 'Opener')?.links[0]?.url).toBe('https://example.com/talk');
    expect(await db.dossiers.where('personId').equals(P1).count()).toBe(1);
  });

  it('research_person asks which person when two match', async () => {
    api.state.dossiers.set(
      P1,
      fakeDossier(user.id, P1, {
        status: 'needs_disambiguation',
        candidates: [
          { name: 'Priya Shah', org: 'Stripe' },
          { name: 'Priya Shah', org: 'Ramp' },
        ],
      }),
    );
    const env = await execute('research_person', { personId: P1 }, ctx());
    expect(env.kind).toBe('choices');
    expect((env.data as { ui: { options: { label: string }[] } }).ui.options.map((o) => o.label)).toEqual([
      'Priya Shah, Stripe',
      'Priya Shah, Ramp',
    ]);
  });

  it('find_people ranks with reasons, says who you know, and add_sourced pulls the new people in', async () => {
    api.state.sourced = [
      {
        id: 'rec_a',
        name: 'Maya Chen',
        title: 'Partner',
        org: 'Seed Fund',
        source: 'exa',
        rank: 0.81,
        fit: 0.9,
        reach: 0.4,
        responsiveness: 0.5,
        reasons: ['Invests in climate software at seed'],
      },
      {
        id: 'rec_b',
        name: 'Sam Lee',
        title: 'Principal',
        org: 'Climate VC',
        source: 'apollo',
        rank: 0.6,
        fit: 0.7,
        reach: 0.9,
        responsiveness: 0.4,
        reasons: ['You know them'],
        knownPersonId: P2,
      },
    ];
    const found = await execute(
      'find_people',
      { purpose: 'fundraising', query: 'seed investors in climate' },
      ctx(),
    );
    expect(found.kind).toBe('list');
    expect(found.summary).toMatch(/Found 2 people\. Apollo is not set up yet/);
    const items = (found.data as { ui: { items: { chip?: string }[] } }).ui.items;
    expect(items[1]?.chip).toBe('You know them');
    const added = await execute('add_sourced', { recommendationIds: ['rec_a'] }, ctx());
    expect(added.summary).toMatch(/Added Maya Chen/);
    expect((await db.people.toArray()).some((p) => p.displayName === 'Maya Chen')).toBe(true);
    expect((await db.chats.toArray()).some((c) => c.stage === 'identified')).toBe(true);
  });

  it('find_routes uses /paths/find with reasons and chances, and ask_for_intro drafts through the chosen route', async () => {
    api.state.paths.set(P1, [
      {
        id: 'path_1',
        nodes: ['user', P2, P1],
        hops: [
          { fromId: 'user', toId: P2, p: 0.7, kind: 'strength' },
          { fromId: P2, toId: P1, p: 0.6, kind: 'email_exchange' },
        ],
        p: 0.42,
        band: 'high',
        firstHopId: P2,
        otherWays: 1,
        reasonText: 'Sam (Strong · 71) emails with Priya.',
        names: { [P1]: 'Priya Shah', [P2]: 'Sam Lee' },
      },
    ]);
    const routes = await execute('find_routes', { personId: P1 }, ctx());
    expect(routes.kind).toBe('routes');
    expect(routes.summary).toMatch(/1 route to Priya Shah\. Best: through Sam Lee \(likely\)/);
    expect(JSON.stringify(modelResult('find_routes', routes))).toContain('path_1');
    const asked = await run('ask_for_intro', { pathId: 'path_1' }, ctx());
    expect(asked.kind).toBe('text');
    expect(asked.summary).toMatch(/Drafted the intro request to Sam Lee about Priya Shah.*Nothing was sent/);
    expect(api.calls.find((c) => c.route === '/intros/ask')?.body).toMatchObject({
      introducerPersonId: P2,
      targetPersonId: P1,
      pathScore: 0.42,
    });
  });

  it('find_routes says when you know someone directly', async () => {
    const env = await execute('find_routes', { personId: P1 }, ctx());
    expect(env.summary).toMatch(/No warm route to Priya Shah/);
  });

  it('list_replies, draft_reply (a question blocks approval) and book_call', async () => {
    api.state.replies = [
      {
        messageId: 'm1',
        threadId: 't1',
        personId: P1,
        personName: 'Priya Shah',
        channel: 'gmail',
        replyClass: 'scheduling',
        confidence: 0.9,
        receivedAt: at,
        snippet: 'Tuesday works',
        draftId: null,
      },
      {
        messageId: 'm2',
        threadId: 't2',
        personId: P2,
        personName: 'Sam Lee',
        channel: 'gmail',
        replyClass: 'question',
        confidence: 0.8,
        receivedAt: at,
        snippet: 'When do you start?',
        draftId: null,
      },
    ];
    const list = await execute('list_replies', {}, ctx());
    expect(list.summary).toBe('2 replies.');
    const only = await execute('list_replies', { replyClass: 'question' }, ctx());
    expect(only.summary).toBe('1 reply.');
    const q = await execute('draft_reply', { messageId: 'm2' }, ctx());
    expect(q.summary).toMatch(/needs one answer from you first: What is your start date\?/);
    const d = await execute('draft_reply', { messageId: 'm1' }, ctx());
    expect(d.summary).toMatch(/Nothing is sent until you approve it/);
    const draftId = (modelResult('draft_reply', d).data as { draftId: string }).draftId;
    const booked = await run(
      'book_call',
      { draftId, slotStart: '2026-10-07T14:00:00Z', label: 'Wed Oct 7, 10:00 ET' },
      ctx(),
    );
    expect(booked.summary).toBe('Booked Wed Oct 7, 10:00 ET and sent the invite.');
  });

  it('set_autonomy needs approval, then sets the level (for a goal too); pause_outreach and list_due', async () => {
    const first = await execute('set_autonomy', { level: 1 }, ctx());
    expect(first.kind).toBe('needs_confirmation');
    expect(api.state.autonomy).toEqual([]);
    const done = await execute(
      'set_autonomy',
      { level: 1 },
      { ...ctx(), confirmation: first.confirmationId },
    );
    expect(done.summary).toMatch(/Send after I approve/);
    expect(api.state.autonomy).toEqual([{ level: 1 }]);
    const paused = await execute('pause_outreach', { until: '2026-12-20' }, ctx());
    expect(paused.summary).toMatch(/paused until 2026-12-20/);
    expect(api.state.pausedUntil).toBe('2026-12-20');
    await execute('pause_outreach', {}, ctx());
    expect(api.state.pausedUntil).toBeNull();
    api.state.due = [
      {
        kind: 'bump',
        personId: P1,
        chatId: null,
        draftId: null,
        reason: 'No reply in 5 business days',
        dueAt: at,
      },
    ];
    const due = await execute('list_due', {}, ctx());
    expect(due.summary).toBe('1 thing due.');
    expect((due.data as { ui: { items: { text: string; chip: string }[] } }).ui.items[0]).toMatchObject({
      text: 'Priya Shah',
      chip: 'Follow-up',
    });
  });

  it('remember, recall and forget (everything about a person, after approval)', async () => {
    const saved = await execute('remember', { text: 'Prefers morning calls', kind: 'preference' }, ctx());
    expect(saved.summary).toBe('Saved to memory.');
    const dup = await execute('remember', { text: 'prefers morning calls', kind: 'preference' }, ctx());
    expect(dup.summary).toMatch(/Already in memory/);
    await execute('remember', { text: 'Priya prefers LinkedIn', kind: 'person_fact', personId: P1 }, ctx());
    const found = await execute('recall', { query: 'morning calls' }, ctx());
    expect(found.summary).toMatch(/1 memory found/);
    const gone = await run('forget', { personId: P1 }, ctx());
    expect(gone.summary).toBe('Deleted 1 memory.');
    expect(api.state.memories.map((m) => m.text)).toEqual(['Prefers morning calls']);
  });
});
