import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { embeddable, keywordScore } from '../../functions/_shared/memory/memory.ts';
import {
  addPerson,
  anthropic,
  api,
  DAY,
  fakeNet,
  iso,
  signedInUser,
  systemText,
  userText,
} from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

describe('goals', () => {
  it('creates, lists, updates and archives goals, at most five active (409 too_many_goals)', async () => {
    const net = fakeNet();
    const call = api(t, net);
    const { token } = await signedInUser(t);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await call<{ goal: { id: string; kind: string; targets: { roles: string[] } } }>(
        '/goals/upsert',
        token,
        {
          goal: { kind: 'recruiting', title: `Goal ${i}`, targets: { roles: ['PM'] } },
        },
      );
      expect(r.status).toBe(200);
      expect(r.body.goal.targets.roles).toEqual(['PM']);
      ids.push(r.body.goal.id);
    }
    const sixth = await call<{ error: { code: string } }>('/goals/upsert', token, {
      goal: { kind: 'advice', title: 'Six' },
    });
    expect(sixth.status).toBe(409);
    expect(sixth.body.error.code).toBe('too_many_goals');
    // a paused sixth is fine, and editing an active one does not count itself
    expect(
      (await call('/goals/upsert', token, { goal: { kind: 'advice', title: 'Later', status: 'paused' } }))
        .status,
    ).toBe(200);
    const edit = await call<{ goal: { title: string; priority: number } }>('/goals/upsert', token, {
      goal: { id: ids[0], kind: 'recruiting', title: 'Renamed', priority: 1 },
    });
    expect(edit.body.goal).toMatchObject({ title: 'Renamed', priority: 1 });
    const archived = await call<{ goal: { deletedAt?: string } }>('/goals/archive', token, { id: ids[1] });
    expect(archived.body.goal.deletedAt).toBeTruthy();
    const list = await call<{ goals: { id: string; status: string }[] }>('/goals/list', token);
    expect(list.body.goals).toHaveLength(5);
    expect(list.body.goals.filter((g) => g.status === 'active')).toHaveLength(4);
    expect((await call('/goals/upsert', token, { goal: { kind: 'astrology', title: 'x' } })).status).toBe(
      400,
    );
  });

  it('keeps one user out of another user’s goals', async () => {
    const call = api(t, fakeNet());
    const a = await signedInUser(t);
    const b = await signedInUser(t);
    const g = await call<{ goal: { id: string } }>('/goals/upsert', a.token, {
      goal: { kind: 'advice', title: 'Mine' },
    });
    const r = await call('/goals/upsert', b.token, {
      goal: { id: g.body.goal.id, kind: 'advice', title: 'Theirs' },
    });
    expect(r.status).toBe(404);
    expect((await call('/goals/archive', b.token, { id: g.body.goal.id })).status).toBe(404);
  });
});

describe('scores', () => {
  it('explains a score, and a label re-scores at once from stored features', async () => {
    const call = api(t, fakeNet());
    const { userId, token } = await signedInUser(t);
    const p = await addPerson(t, userId, {
      name: 'Priya Ahmed',
      score: 34,
      features: { reciprocity: 0.4, f1: 1 },
    });
    const ex = await call<{ score: number; band: string; explanation: string[]; labelled?: number }>(
      '/scores/explain',
      token,
      {
        personId: p,
      },
    );
    expect(ex.status).toBe(200);
    expect(ex.body).toMatchObject({ score: 34, band: 'light', explanation: ['You email each other'] });
    expect(ex.body.labelled).toBeUndefined();
    const lab = await call<{ score: number; band: string; labelled: number; explanation: string[] }>(
      '/scores/label',
      token,
      {
        personId: p,
        closeness: 4,
      },
    );
    expect(lab.status).toBe(200);
    expect(lab.body).toMatchObject({ score: 70, band: 'strong', labelled: 4 });
    expect(lab.body.explanation[0]).toBe('You rated this tie 4 of 5');
    const [row] = await t.db.sql<{
      strength: number;
    }>`select strength from orbit.people where id = ${p}::uuid`;
    expect(row!.strength).toBeCloseTo(0.7);
  });

  it('queues score.person when there are no features to re-score from', async () => {
    const call = api(t, fakeNet());
    const { userId, token } = await signedInUser(t);
    const p = await addPerson(t, userId, { name: 'New Person' });
    const r = await call<{ queued: boolean }>('/scores/label', token, { personId: p, closeness: 2 });
    expect(r.status).toBe(202);
    expect(r.body.queued).toBe(true);
    const q = await t.db.sql<{ message: { kind: string; payload: { personId: string } } }>`
      select message from pgmq.q_orbit_score where message->>'userId' = ${userId}`;
    expect(q.map((m) => m.message.kind)).toEqual(['score.person']);
    expect((await call('/scores/explain', token, { personId: p })).status).toBe(404);
    expect((await call('/scores/label', token, { personId: p, closeness: 9 })).status).toBe(400);
  });
});

describe('settings', () => {
  it('sets the autonomy level for the user or one goal, and pauses outreach', async () => {
    const call = api(t, fakeNet());
    const { userId, token } = await signedInUser(t);
    expect((await call('/settings/autonomy', token, { level: 2 })).status).toBe(200);
    const g = await call<{ goal: { id: string } }>('/goals/upsert', token, {
      goal: { kind: 'sales', title: 'Pilots' },
    });
    expect((await call('/settings/autonomy', token, { level: 1, goalId: g.body.goal.id })).status).toBe(200);
    expect((await call('/settings/autonomy', token, { level: 3 })).status).toBe(400);
    const until = new Date(Date.now() + 7 * DAY).toISOString();
    expect((await call('/settings/pause', token, { until })).status).toBe(200);
    const [u] = await t.db.sql<{ autonomy_level: number; settings: { quiet_until?: string } }>`
      select autonomy_level, settings from orbit.users where id = ${userId}::uuid`;
    expect(u!.autonomy_level).toBe(2);
    expect(u!.settings.quiet_until).toBe(until);
    const [goal] = await t.db.sql<{
      autonomy_level: number;
    }>`select autonomy_level from orbit.goals where id = ${g.body.goal.id}::uuid`;
    expect(goal!.autonomy_level).toBe(1);
    await call('/settings/pause', token, { until: null });
    const [u2] = await t.db.sql<{
      settings: { quiet_until?: string };
    }>`select settings from orbit.users where id = ${userId}::uuid`;
    expect(u2!.settings.quiet_until).toBeUndefined();
    const audit = await t.db.sql<{ action: string }>`
      select action from orbit.audit_log where user_id = ${userId}::uuid and action like 'settings.%' order by id`;
    expect(audit.map((a) => a.action)).toEqual([
      'settings.autonomy',
      'settings.autonomy',
      'settings.pause',
      'settings.pause',
    ]);
  });
});

describe('memory (§10)', () => {
  it('§10.8 test 1: remember, then recall with a paraphrase, returns that memory first', async () => {
    const call = api(t, fakeNet());
    const { token } = await signedInUser(t);
    for (const [text, kind] of [
      ['Prefers morning calls', 'preference'],
      ['Applying to fintech PM roles this fall', 'goal_detail'],
      ['Cannot travel in December', 'constraint'],
    ] as const)
      expect((await call('/memory/add', token, { text, kind })).status).toBe(200);
    const r = await call<{ memories: { text: string; score: number }[] }>('/memory/search', token, {
      query: 'what time of day does she like for calls? mornings?',
    });
    expect(r.status).toBe(200);
    expect(r.body.memories[0]!.text).toBe('Prefers morning calls');
    expect(r.body.memories[0]!.score).toBeGreaterThan(r.body.memories[1]!.score);
  });

  it('§10.8 test 2: a duplicate (cosine ≥ 0.92) refreshes the existing memory instead of inserting', async () => {
    const call = api(t, fakeNet());
    const { userId, token } = await signedInUser(t);
    const a = await call<{ memory: { id: string }; deduped: boolean }>('/memory/add', token, {
      text: 'Prefers morning calls',
      kind: 'preference',
    });
    expect(a.body.deduped).toBe(false);
    await t.db
      .sql`update orbit.memories set last_seen_at = now() - interval '10 days' where id = ${a.body.memory.id}::uuid`;
    const b = await call<{ memory: { id: string; lastSeenAt: string }; deduped: boolean }>(
      '/memory/add',
      token,
      {
        text: 'prefers morning calls.',
        kind: 'preference',
      },
    );
    expect(b.body.deduped).toBe(true);
    expect(b.body.memory.id).toBe(a.body.memory.id);
    expect(Date.now() - Date.parse(b.body.memory.lastSeenAt)).toBeLessThan(DAY);
    const rows = await t.db.sql`select 1 from orbit.memories where user_id = ${userId}::uuid`;
    expect(rows).toHaveLength(1);
  });

  it('lists per person, forgets (soft delete), and finds non-English memories by keyword', async () => {
    const call = api(t, fakeNet());
    const { userId, token } = await signedInUser(t);
    const p = await addPerson(t, userId, { name: 'Maya Chen' });
    await call('/memory/add', token, {
      text: 'Maya offered to refer me in March',
      kind: 'person_fact',
      personId: p,
    });
    const general = await call<{ memory: { id: string } }>('/memory/add', token, {
      text: 'Prefers email',
      kind: 'preference',
    });
    await call('/memory/add', token, { text: 'Предпочитает звонки утром', kind: 'preference' });
    const forMaya = await call<{ memories: { text: string }[] }>('/memory/list', token, { personId: p });
    expect(forMaya.body.memories.map((m) => m.text)).toEqual(['Maya offered to refer me in March']);
    const [ru] = await t.db.sql<{ has: boolean }>`
      select embedding is not null as has from orbit.memories where user_id = ${userId}::uuid and text like 'Пред%'`;
    expect(ru!.has).toBe(false);
    const found = await call<{ memories: { text: string }[] }>('/memory/search', token, { query: 'звонки' });
    expect(found.body.memories[0]!.text).toContain('звонки');
    expect((await call('/memory/forget', token, { id: general.body.memory.id })).status).toBe(200);
    expect((await call('/memory/forget', token, { id: general.body.memory.id })).status).toBe(404);
    const all = await call<{ memories: { id: string }[] }>('/memory/list', token, {});
    expect(all.body.memories.map((m) => m.id)).not.toContain(general.body.memory.id);
    expect(embeddable('Hello there')).toBe(true);
    expect(keywordScore('morning calls', 'Prefers morning calls')).toBe(1);
  });
});

describe('cadence/due', () => {
  it('lists what the scan would do, and nothing while paused', async () => {
    const call = api(t, fakeNet());
    const { userId, token } = await signedInUser(t);
    const p = await addPerson(t, userId, {
      name: 'Jordan Lee',
      email: 'jordan@example.com',
      title: 'Engineer',
      score: 30,
    });
    await t.db.sql`
      insert into orbit.chats (user_id, person_id, stage, stage_entered_at, data)
      values (${userId}::uuid, ${p}::uuid, 'outreach_sent', ${iso(20 * DAY)}::timestamptz,
              ${{ lastOutboundAt: iso(20 * DAY), firstOutreachAt: iso(20 * DAY), bumpCount: 0, outreachChannel: 'email' }}::jsonb)`;
    const r = await call<{ items: { kind: string; personId: string }[] }>('/cadence/due', token);
    expect(r.status).toBe(200);
    expect(r.body.items.map((i) => i.kind)).toEqual(expect.arrayContaining(['bump', 'went_quiet']));
    expect(r.body.items.every((i) => i.personId === p)).toBe(true);
    await call('/settings/pause', token, { until: new Date(Date.now() + DAY).toISOString() });
    expect((await call<{ items: unknown[] }>('/cadence/due', token)).body.items).toEqual([]);
  });
});

describe('settings/profile (§14.3)', () => {
  it('keeps the postal address, the scheduling link and the time zone, and validates each', async () => {
    const call = api(t, fakeNet(), { env: {} });
    const { userId, token } = await signedInUser(t, { settings: { quiet_until: '2026-12-01' } });
    const r = await call<{ postalAddress: string; schedulingLink: string; timezone: string }>(
      '/settings/profile',
      token,
      {
        postalAddress: '1 Main St, Palo Alto, CA 94301',
        schedulingLink: 'https://cal.com/sam/20min',
        timezone: 'America/Los_Angeles',
      },
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      postalAddress: '1 Main St, Palo Alto, CA 94301',
      schedulingLink: 'https://cal.com/sam/20min',
      timezone: 'America/Los_Angeles',
    });
    const [u] = await t.db.sql<{ settings: Record<string, unknown>; timezone: string }>`
      select settings, timezone from orbit.users where id = ${userId}::uuid`;
    expect(u).toEqual({
      settings: {
        quiet_until: '2026-12-01',
        postal_address: '1 Main St, Palo Alto, CA 94301',
        scheduling_link: 'https://cal.com/sam/20min',
      },
      timezone: 'America/Los_Angeles',
    });
    // a field left out is kept; null or '' removes it
    const cleared = await call<{ postalAddress: string | null; schedulingLink: string | null }>(
      '/settings/profile',
      token,
      { schedulingLink: '' },
    );
    expect(cleared.body).toMatchObject({
      postalAddress: '1 Main St, Palo Alto, CA 94301',
      schedulingLink: null,
    });
    await call('/settings/profile', token, { postalAddress: null });
    const [after] = await t.db.sql<{ settings: Record<string, unknown> }>`
      select settings from orbit.users where id = ${userId}::uuid`;
    expect(after!.settings).toEqual({ quiet_until: '2026-12-01' });
    for (const bad of [
      { schedulingLink: 'http://cal.com/sam' },
      { schedulingLink: 'javascript:alert(1)' },
      { schedulingLink: 'cal.com/sam' },
      { postalAddress: 'x'.repeat(501) },
      { postalAddress: 42 },
      { timezone: 'Mars/Olympus' },
      { timezone: '+05:00' },
      { timezone: '' },
    ])
      expect((await call('/settings/profile', token, bad)).status).toBe(400);
    const audit = await t.db.sql<{ details: { fields: string[] } }>`
      select details from orbit.audit_log where user_id = ${userId}::uuid and action = 'settings.profile' order by id`;
    expect(audit.map((a) => a.details.fields)).toEqual([
      ['postal_address', 'scheduling_link', 'timezone'],
      ['scheduling_link'],
      ['postal_address'],
    ]);
  });
});

const TURNS = [
  {
    role: 'user',
    text: 'I prefer morning calls, and my advisor Maya Chen says to talk to fintech PMs first.',
  },
  { role: 'assistant', text: 'Got it. Want me to find fintech PMs?' },
  { role: 'user', text: 'Yes please, and never on Fridays.' },
] as const;

describe('memory/extract (§10.6)', () => {
  it('adds what the last turns say worth keeping (source chat), dedupes, and drops unquoted memories', async () => {
    const claude = anthropic(() => ({
      memories: [
        {
          kind: 'preference',
          text: 'Prefers morning calls',
          person_name: null,
          importance: 0.6,
          quote: 'I prefer morning calls',
        },
        {
          kind: 'person_fact',
          text: 'Maya Chen advises talking to fintech PMs first',
          person_name: 'Maya Chen',
          importance: 0.5,
          quote: 'my advisor Maya Chen says to talk to fintech PMs first',
        },
        {
          kind: 'constraint',
          text: 'No calls on Fridays',
          person_name: null,
          importance: 0.7,
          quote: 'never on Fridays',
        },
        { kind: 'note', text: 'Likes tea', person_name: null, importance: 0.2, quote: 'I love tea' },
      ],
    }));
    const net = fakeNet(claude.answer);
    const call = api(t, net);
    const { userId, token } = await signedInUser(t);
    const maya = await addPerson(t, userId, { name: 'Maya Chen', email: 'maya@example.com' });
    // kept already in other words: the extracted one refreshes it (cosine ≥ 0.92) instead of adding a second
    await call('/memory/add', token, { text: 'Prefers calls in the morning', kind: 'preference' });
    const r = await call<{
      memories: { text: string; kind: string; personId: string | null }[];
      added: number;
    }>('/memory/extract', token, { turns: TURNS });
    expect(r.status).toBe(200);
    expect(r.body.added).toBe(2);
    expect(r.body.memories.map((m) => [m.kind, m.text, m.personId])).toEqual([
      ['preference', 'Prefers calls in the morning', null],
      ['person_fact', 'Maya Chen advises talking to fintech PMs first', maya],
      ['constraint', 'No calls on Fridays', null],
    ]);
    const req = claude.requests[0]!;
    expect(req.model).toBe('claude-haiku-5-5');
    expect(systemText(req)).toContain('Extract durable facts worth remembering');
    // the known memories are in the prompt, so the model skips them
    expect(userText(req)).toContain('<known>Prefers calls in the morning</known>');
    const rows = await t.db.sql<{ text: string; source: string; quote: string | null }>`
      select text, source, quote from orbit.memories where user_id = ${userId}::uuid and deleted_at is null
       order by created_at, text`;
    expect(rows.filter((x) => x.source === 'chat').map((x) => x.quote)).toEqual(
      expect.arrayContaining(['never on Fridays', 'my advisor Maya Chen says to talk to fintech PMs first']),
    );
    expect(rows).toHaveLength(3);
  });

  it('answers unconfigured with 200 and nothing extracted, and validates the turns', async () => {
    const net = fakeNet();
    const call = api(t, net, { env: {} });
    const { token } = await signedInUser(t);
    const r = await call('/memory/extract', token, { turns: TURNS });
    expect(r).toEqual({ status: 200, body: { memories: [], added: 0, unconfigured: true } });
    expect(net.calls).toHaveLength(0);
    for (const turns of [
      [],
      Array.from({ length: 7 }, () => ({ role: 'user', text: 'hi' })),
      [{ role: 'system', text: 'x' }],
      [{ role: 'user', text: 'x'.repeat(8001) }],
      'hello',
    ])
      expect((await call('/memory/extract', token, { turns })).status).toBe(400);
  });
});

describe('goals/infer (§1.6)', () => {
  it('proposes the goals the student states, quote-checked, without saving them', async () => {
    const claude = anthropic(() => ({
      goals: [
        {
          kind: 'fundraising',
          title: 'Raise a pre-seed round for my climate startup, from angels in the Bay Area',
          targets: { organizations: [], roles: ['angel investor'], geographies: ['Bay Area'], people: [] },
          criteria: {
            sector: 'climate',
            stage: 'pre-seed',
            seniority: null,
            skills: null,
            keywords: [' carbon ', ''],
          },
          success_metric: '5 investor calls by December',
          due_at: '2026-12-15',
          is_update_of: null,
          quote: "I'm trying to raise a pre-seed round",
        },
        {
          kind: 'hiring',
          title: 'Hire a designer',
          targets: { organizations: [], roles: ['designer'], geographies: [], people: [] },
          criteria: { sector: null, stage: null, seniority: null, skills: null, keywords: null },
          success_metric: null,
          due_at: 'soon',
          is_update_of: 'not-a-goal',
          quote: 'we need to hire a designer',
        },
      ],
    }));
    const net = fakeNet(claude.answer);
    const call = api(t, net);
    const { userId, token } = await signedInUser(t);
    const g = await call<{ goal: { id: string } }>('/goals/upsert', token, {
      goal: { kind: 'recruiting', title: 'PM internship', targets: { roles: ['PM'] } },
    });
    const r = await call<{ goals: Record<string, unknown>[] }>('/goals/infer', token, {
      turns: [
        {
          role: 'user',
          text: 'I’m trying to raise a pre-seed round for my climate startup, ideally angels in the Bay Area.',
        },
        { role: 'assistant', text: 'That sounds exciting. Who have you talked to so far?' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.goals).toEqual([
      {
        kind: 'fundraising',
        title: 'Raise a pre-seed round for my climate startup, from angels i',
        targets: { organizations: [], roles: ['angel investor'], geographies: ['Bay Area'], people: [] },
        criteria: { sector: 'climate', stage: 'pre-seed', keywords: ['carbon'] },
        successMetric: '5 investor calls by December',
        dueAt: '2026-12-15',
        isUpdateOf: null,
        quote: "I'm trying to raise a pre-seed round",
      },
    ]);
    const req = claude.requests[0]!;
    expect(req.model).toBe('claude-haiku-5-5');
    expect(systemText(req)).toContain('You extract networking goals from a conversation');
    expect(userText(req)).toContain(`"id":"${g.body.goal.id}"`);
    expect(userText(req)).toContain('<conversation>user: I’m trying to raise');
    // nothing is saved
    const [n] = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.goals where user_id = ${userId}::uuid`;
    expect(n!.n).toBe(1);
  });

  it('answers unconfigured with 200 and no goals', async () => {
    const call = api(t, fakeNet(), { env: {} });
    const { token } = await signedInUser(t);
    const r = await call('/goals/infer', token, { turns: [{ role: 'user', text: 'I want to raise money' }] });
    expect(r).toEqual({ status: 200, body: { goals: [], unconfigured: true } });
    expect((await call('/goals/infer', token, { turns: [] })).status).toBe(400);
  });
});
