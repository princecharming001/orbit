/**
 * The automated LinkedIn warm-up on the server: the preview reads the person's posts once and drafts the comment; Start
 * stores the words the student approved and the plan; each step runs once at its time, through the student's own
 * LinkedIn account and no other, inside the daily caps and the spacing; a failed step is tried once more and then
 * skipped; every stop condition stops it; the last step tells the student once. Unipile and Claude are fakes: nothing
 * here reaches LinkedIn.
 */
import { inWorkingHours, WARMUP_AUTO_CAPS, type WarmUpRun } from '@orbit/core/warmup/auto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeServices } from '../../functions/_shared/services.ts';
import { finishIfOver, runWarmupStep, type StepOutcome } from '../../functions/_shared/warmup/warmup.ts';
import { defaultHandlers, runTick } from '../../functions/orbit-worker/worker.ts';
import {
  ALL_KEYS,
  addPerson,
  addThread,
  agentConfig,
  anthropic,
  api,
  fakeNet,
  jsonRes,
  type NetCall,
  signedInUser,
  systemText,
  UNIPILE,
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
beforeEach(async () => {
  await t.pg.exec(
    'delete from pgmq.q_orbit_cadence; delete from pgmq.a_orbit_cadence; delete from orbit.job_runs; delete from orbit.dead_letters;',
  );
  // other tests' warm-ups are over: the schedule's sweep reads every running one
  await t.pg.exec("delete from orbit.warmups where status = 'running'");
});

const NY = 'America/New_York';
/** Monday 16 November 2026, 10:00 in New York: a working day, in the past, so the database's clock is past it too. */
const MONDAY = Date.parse('2026-11-16T15:00:00Z');
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const POST_ID = 'urn:li:activity:7332661864792854528';
const POST_URL = 'https://www.linkedin.com/posts/priya-rao_onboarding-activity-7332661864792854528-hcGT';
const COMMENT = 'Did the week one rule hold once the team passed twenty people?';
const TOPIC = 'new analysts shipping in week one';

interface World {
  posts: Record<string, unknown>[];
  comments: { text: string }[];
  on: Partial<
    Record<'profile' | 'posts' | 'react' | 'comment' | 'comments', (c: NetCall) => Response | undefined>
  >;
  claude: (req: unknown) => unknown;
}

const post = (over: Record<string, unknown> = {}) => ({
  id: '7332661864792854528',
  social_id: POST_ID,
  share_url: POST_URL,
  text: 'New analysts should ship something real in their first week. We stopped doing onboarding decks and gave every new hire one small production change on day two.',
  date: '3d',
  parsed_datetime: new Date(MONDAY - 3 * DAY).toISOString(),
  is_repost: false,
  ...over,
});

function setup(over: { env?: typeof ALL_KEYS; linkedinTarget?: boolean } = {}) {
  const clock = { now: MONDAY };
  const world: World = {
    posts: [post()],
    comments: [],
    on: {},
    claude: () => ({ post: 1, topic: TOPIC, comment: COMMENT }),
  };
  const ai = anthropic((req) => world.claude(req));
  const net = fakeNet(ai.answer, (c) => {
    if (!c.url.startsWith(UNIPILE)) return undefined;
    const u = new URL(c.url);
    const path = u.pathname;
    if (c.method === 'GET' && /^\/api\/v1\/users\/[^/]+$/.test(path))
      return (
        world.on.profile?.(c) ??
        jsonRes(200, { provider: 'LINKEDIN', provider_id: 'ACoAAPriya', public_identifier: 'priya-rao' })
      );
    if (c.method === 'GET' && /^\/api\/v1\/users\/[^/]+\/posts$/.test(path))
      return world.on.posts?.(c) ?? jsonRes(200, { object: 'PostList', items: world.posts });
    if (c.method === 'POST' && path === '/api/v1/posts/reaction')
      return world.on.react?.(c) ?? jsonRes(201, { object: 'ReactionAdded' });
    if (c.method === 'POST' && /^\/api\/v1\/posts\/[^/]+\/comments$/.test(path))
      return world.on.comment?.(c) ?? jsonRes(201, { object: 'CommentSent', comment_id: 'cmt-1' });
    if (c.method === 'GET' && /^\/api\/v1\/posts\/[^/]+\/comments$/.test(path))
      return world.on.comments?.(c) ?? jsonRes(200, { object: 'CommentList', items: world.comments });
    return undefined;
  });
  const env = {
    ...(over.env ?? ALL_KEYS),
    ...(over.linkedinTarget ? { linkedinTarget: { accountsPerDay: 3, gapSeconds: 1200 } } : {}),
  };
  const now = () => new Date(clock.now);
  const call = api(t, net, { env, now });
  // the database stamps rows with its own clock, which is past the test's: the pull reads by the real one
  const realTime = api(t, net, { env, pullLagMs: 0 });
  const pull = (token: string, cursor?: string) =>
    realTime<{ cursor: string; changes: { warmups?: Record<string, unknown>[] } }>('/sync/pull', token, {
      tables: ['warmups'],
      ...(cursor ? { cursor } : {}),
    });
  const config = agentConfig(net, env);
  const services = () => makeServices(config, { db: t.db, now });
  const unipile = () => net.calls.filter((c) => c.url.startsWith(UNIPILE));
  return { clock, world, net, ai, call, pull, config, services, unipile, now };
}

type Kit = ReturnType<typeof setup>;

async function student(
  over: { settings?: Record<string, unknown>; account?: string | null; status?: string } = {},
) {
  const u = await signedInUser(t, { settings: over.settings, timezone: NY, firstName: 'Sam' });
  if (over.account !== null)
    await t.db.sql`
      insert into orbit.integration_accounts (user_id, provider, external_account_id, status)
      values (${u.userId}::uuid, 'linkedin', ${over.account ?? `acc-${u.userId.slice(0, 8)}`}, ${over.status ?? 'active'})`;
  return { ...u, account: over.account ?? `acc-${u.userId.slice(0, 8)}` };
}

let people = 0;
const priya = (userId: string, over: Partial<Parameters<typeof addPerson>[2]> = {}) => {
  people++;
  return addPerson(t, userId, {
    name: `Priya Rao${people}`,
    title: 'Head of Analytics',
    linkedinUrl: `https://www.linkedin.com/in/priya-rao-${people}/`,
    memberId: `ACoAAPriya${people}`,
    ...over,
  });
};

type Preview = {
  ok: boolean;
  reason?: string;
  preview?: {
    id: string;
    post: { url?: string; excerpt: string } | null;
    comment: string | null;
    steps: { id: string; kind: string; dueAt: string }[];
  };
};
type Started = { ok: boolean; reason?: string; run?: WarmUpRun };

/** Preview and Start for one person, with the drafted comment unless another is given (null leaves it out). */
async function begin(k: Kit, token: string, personId: string, comment?: string | null): Promise<WarmUpRun> {
  const p = await k.call<Preview>('/warmups/preview', token, { personId });
  expect(p.body.ok, JSON.stringify(p.body)).toBe(true);
  const s = await k.call<Started>('/warmups/start', token, {
    warmupId: p.body.preview!.id,
    comment: comment === undefined ? p.body.preview!.comment : comment,
  });
  expect(s.body.ok, JSON.stringify(s.body)).toBe(true);
  return s.body.run!;
}

const steps = (warmupId: string) =>
  t.db.sql<{
    id: string;
    seq: number;
    kind: string;
    status: string;
    attempts: number;
    due_at: Date;
    ran_at: Date | null;
    note: string | null;
    result: { tries?: Record<string, unknown>[] };
  }>`select id, seq, kind, status, attempts, due_at, ran_at, note, result
       from orbit.warmup_steps where warmup_id = ${warmupId}::uuid order by seq`;
const runRow = async (id: string) =>
  (
    await t.db.sql<{
      status: string;
      stop_reason: string | null;
      comment: string | null;
      notified_at: Date | null;
      finished_at: Date | null;
    }>`select status, stop_reason, comment, notified_at, finished_at from orbit.warmups where id = ${id}::uuid`
  )[0]!;
const notices = (userId: string) =>
  t.db.sql<{ title: string; body: string | null; link: string | null }>`
    select title, body, link from orbit.notifications where user_id = ${userId}::uuid order by created_at`;

/** Move the clock to a step's time and run it. */
async function runAt(k: Kit, userId: string, step: { id: string; due_at: Date }): Promise<StepOutcome> {
  k.clock.now = Math.max(k.clock.now, new Date(step.due_at).getTime());
  return runWarmupStep(k.services(), userId, step.id);
}

/** Run every step of a run at its time, in order, and return what each one did. */
async function runAll(k: Kit, userId: string, warmupId: string): Promise<StepOutcome[]> {
  const out: StepOutcome[] = [];
  for (let guard = 0; guard < 12; guard++) {
    const [next] = (await steps(warmupId)).filter((s) => s.status === 'pending');
    if (!next) break;
    out.push(await runAt(k, userId, next));
  }
  return out;
}

const mutations = (calls: NetCall[]) => calls.filter((c) => c.method !== 'GET');

describe('the preview', () => {
  it('reads the profile quietly and the posts once, picks a post and drafts the comment with the light model', async () => {
    const k = setup();
    const u = await student();
    const p = await priya(u.userId, { memberId: undefined });
    const r = await k.call<Preview>('/warmups/preview', u.token, { personId: p });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      preview: {
        post: { url: POST_URL },
        comment: COMMENT,
      },
    });
    expect(r.body.preview!.post!.excerpt).toMatch(/^New analysts should ship something real/);
    expect(r.body.preview!.steps.map((s) => s.kind)).toEqual(['view_profile', 'react_post', 'comment_post']);
    // LinkedIn: one profile read that leaves no visit, then one read of their posts by LinkedIn's own id
    const calls = k.unipile();
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      `GET /api/v1/users/priya-rao-${people}`,
      'GET /api/v1/users/ACoAAPriya/posts',
    ]);
    expect(new URL(calls[0]!.url).searchParams.get('notify')).toBe('false');
    for (const c of calls) {
      expect(new URL(c.url).searchParams.get('account_id')).toBe(u.account);
      expect(c.headers['x-api-key']).toBe('unipile-placeholder');
    }
    // the writer: the light model, told to write no praise and nothing to ask for, with the posts fenced as data
    expect(k.ai.requests).toHaveLength(1);
    const req = k.ai.requests[0]!;
    expect(req.model).toBe('claude-haiku-5-5');
    expect(systemText(req)).toMatch(/no praise and no thanks/);
    expect(systemText(req)).toMatch(/asks for nothing/);
    expect(systemText(req)).toMatch(/no em dashes, no exclamation marks/);
    expect(userText(req)).toMatch(/<untrusted_[0-9a-f]+ source="post 1">/);
    expect(userText(req)).toContain('New analysts should ship something real');
    expect(userText(req)).toContain('<voice>');
    // kept as a preview: nothing scheduled, nothing sent to the browser yet
    const [row] = await t.db.sql<{
      status: string;
      linkedin_account: string;
      post_id: string;
      comment: string | null;
    }>`
      select status, linkedin_account, post_id, comment from orbit.warmups where person_id = ${p}::uuid`;
    expect(row).toEqual({ status: 'preview', linkedin_account: u.account, post_id: POST_ID, comment: null });
    expect(await t.db.sql`select 1 from orbit.warmup_steps where user_id = ${u.userId}::uuid`).toHaveLength(
      0,
    );
    expect((await k.pull(u.token)).body.changes.warmups ?? []).toEqual([]);
  });

  it('shows the same preview again without reading LinkedIn or writing again', async () => {
    const k = setup();
    const u = await student();
    const p = await priya(u.userId);
    const a = await k.call<Preview>('/warmups/preview', u.token, { personId: p });
    const b = await k.call<Preview>('/warmups/preview', u.token, { personId: p });
    expect(b.body.preview!.id).toBe(a.body.preview!.id);
    expect(b.body.preview!.comment).toBe(COMMENT);
    // the member id was known, so the first preview made one call (their posts), and the second none
    expect(k.unipile()).toHaveLength(1);
    expect(k.ai.requests).toHaveLength(1);
    // an old preview is made again
    await t.db.sql`update orbit.warmups set created_at = ${new Date(MONDAY - 7 * HOUR)}::timestamptz
                    where id = ${a.body.preview!.id}::uuid`;
    const c = await k.call<Preview>('/warmups/preview', u.token, { personId: p });
    expect(c.body.preview!.id).not.toBe(a.body.preview!.id);
    expect(k.unipile()).toHaveLength(2);
    expect(await t.db.sql`select 1 from orbit.warmups where person_id = ${p}::uuid`).toHaveLength(1);
  });

  it('is the profile view only when they have no recent post of their own', async () => {
    const k = setup();
    k.world.posts = [
      post({ social_id: 'urn:li:activity:1', is_repost: true }),
      post({ social_id: 'urn:li:activity:2', parsed_datetime: new Date(MONDAY - 90 * DAY).toISOString() }),
      post({ social_id: 'urn:li:activity:3', text: 'Hiring.' }),
    ];
    const u = await student();
    const p = await priya(u.userId);
    const r = await k.call<Preview>('/warmups/preview', u.token, { personId: p });
    expect(r.body.preview).toMatchObject({ post: null, comment: null });
    expect(r.body.preview!.steps.map((s) => s.kind)).toEqual(['view_profile']);
    expect(k.ai.requests).toHaveLength(0);
    // and a comment cannot be started without a post
    const bad = await k.call('/warmups/start', u.token, {
      warmupId: r.body.preview!.id,
      comment: 'Hello there',
    });
    expect(bad.status).toBe(400);
    const run = await begin(k, u.token, p, null);
    expect(run.steps.map((s) => s.kind)).toEqual(['view_profile']);
    expect(run.post).toBeUndefined();
  });

  it('offers no comment when the writer is missing, fails, or writes praise', async () => {
    const u = await student();
    const noKey = setup({ env: { ...ALL_KEYS, anthropicKey: undefined } });
    const a = await noKey.call<Preview>('/warmups/preview', u.token, { personId: await priya(u.userId) });
    expect(a.body.preview).toMatchObject({ comment: null, post: { url: POST_URL } });
    expect(a.body.preview!.steps).toHaveLength(3);

    const praise = setup();
    praise.world.claude = () => ({ post: 1, topic: TOPIC, comment: 'Great post, so inspiring!' });
    const b = await praise.call<Preview>('/warmups/preview', u.token, { personId: await priya(u.userId) });
    expect(b.body.preview!.comment).toBeNull();

    const dashes = setup();
    dashes.world.claude = () => ({
      post: 1,
      topic: 'About new analysts shipping in week one.',
      comment: '"Shipping on day two — did that survive the first outage?"',
    });
    const p = await priya(u.userId);
    const c = await dashes.call<Preview>('/warmups/preview', u.token, { personId: p });
    // tidied before the student sees it: no quotes around it, no dash
    expect(c.body.preview!.comment).toBe('Shipping on day two, did that survive the first outage?');
    const [row] = await t.db.sql<{ post_topic: string }>`
      select post_topic from orbit.warmups where person_id = ${p}::uuid`;
    expect(row!.post_topic).toBe('new analysts shipping in week one');
  });

  it('picks the post the writer chose among the candidates', async () => {
    const k = setup();
    k.world.posts = [
      post({
        social_id: 'urn:li:activity:10',
        text: `We are hiring three analysts in Austin this quarter. ${'x'.repeat(40)}`,
      }),
      post({ social_id: 'urn:li:activity:11', parsed_datetime: new Date(MONDAY - 9 * DAY).toISOString() }),
    ];
    k.world.claude = () => ({ post: 2, topic: TOPIC, comment: COMMENT });
    const u = await student();
    const p = await priya(u.userId);
    await k.call<Preview>('/warmups/preview', u.token, { personId: p });
    const [row] = await t.db.sql<{
      post_id: string;
    }>`select post_id from orbit.warmups where person_id = ${p}::uuid`;
    expect(row!.post_id).toBe('urn:li:activity:11');
  });

  it('refuses, and calls nobody, when it must not run', async () => {
    const k = setup();
    const off = await student({ settings: { warmup_auto: false } });
    expect(
      (await k.call<Preview>('/warmups/preview', off.token, { personId: await priya(off.userId) })).body,
    ).toEqual({
      ok: false,
      reason: 'off',
    });
    const none = await student({ account: null });
    expect(
      (await k.call<Preview>('/warmups/preview', none.token, { personId: await priya(none.userId) })).body
        .reason,
    ).toBe('not_connected');
    for (const [status, reason] of [
      ['needs_reauth', 'sign_in'],
      ['parked', 'not_connected'],
      ['revoked', 'not_connected'],
      ['error', 'not_connected'],
      ['connecting', 'not_connected'],
    ] as const) {
      const u = await student({ status });
      const r = await k.call<Preview>('/warmups/preview', u.token, { personId: await priya(u.userId) });
      expect(r.body, status).toEqual({ ok: false, reason });
    }
    const u = await student();
    const dnc = await priya(u.userId, { doNotContact: true });
    expect((await k.call<Preview>('/warmups/preview', u.token, { personId: dnc })).body.reason).toBe(
      'blocked',
    );
    const noLinkedin = await addPerson(t, u.userId, { name: 'No Link' });
    expect((await k.call<Preview>('/warmups/preview', u.token, { personId: noLinkedin })).body.reason).toBe(
      'no_profile',
    );
    // someone else's person is not found at all
    const other = await student();
    const theirs = await priya(other.userId);
    expect((await k.call('/warmups/preview', u.token, { personId: theirs })).status).toBe(404);
    expect(k.unipile()).toEqual([]);
    expect(k.ai.requests).toEqual([]);
    // no Unipile key on this server
    const bare = setup({ env: { ...ALL_KEYS, unipileKey: undefined } });
    expect(
      (await bare.call<Preview>('/warmups/preview', u.token, { personId: await priya(u.userId) })).body
        .reason,
    ).toBe('unconfigured');
    expect(bare.unipile()).toEqual([]);
  });

  it('says so when LinkedIn cannot be read, or the account needs a new sign-in', async () => {
    const k = setup();
    const u = await student();
    k.world.on.posts = () => jsonRes(503, { type: 'errors/service_unavailable' });
    expect(
      (await k.call<Preview>('/warmups/preview', u.token, { personId: await priya(u.userId) })).body,
    ).toEqual({
      ok: false,
      reason: 'busy',
    });
    k.world.on.posts = () => jsonRes(401, { type: 'errors/disconnected_account' });
    expect(
      (await k.call<Preview>('/warmups/preview', u.token, { personId: await priya(u.userId) })).body.reason,
    ).toBe('sign_in');
    expect(await t.db.sql`select 1 from orbit.warmups where user_id = ${u.userId}::uuid`).toHaveLength(0);
  });
});

describe('Start', () => {
  it('stores the approved comment exactly as it was sent, and the plan', async () => {
    const k = setup();
    const u = await student();
    const p = await priya(u.userId);
    // edited by the student: their own punctuation, a line break, an accent, an emoji, trailing space and all
    const edited =
      'Day two in prod, wow!  Did that hold at 20+ people?\nAsking as a student — très curious 🙂 ';
    const run = await begin(k, u.token, p, edited);
    expect(run.comment).toBe(edited);
    const row = await runRow(run.id);
    expect(row.status).toBe('running');
    expect(row.comment).toBe(edited);
    expect(Buffer.from(row.comment!, 'utf8').equals(Buffer.from(edited, 'utf8'))).toBe(true);
    // the plan: the view today in a minute, the like on Wednesday, the comment on Thursday, all in working hours
    const st = await steps(run.id);
    expect(st.map((s) => [s.seq, s.kind, s.status, s.attempts])).toEqual([
      [1, 'view_profile', 'pending', 0],
      [2, 'react_post', 'pending', 0],
      [3, 'comment_post', 'pending', 0],
    ]);
    expect(st.map((s) => new Date(s.due_at).toISOString().slice(0, 10))).toEqual([
      '2026-11-16',
      '2026-11-18',
      '2026-11-19',
    ]);
    expect(new Date(st[0]!.due_at).getTime()).toBe(MONDAY + MIN);
    for (const s of st) expect(inWorkingHours(new Date(s.due_at), NY)).toBe(true);
    // what the browser gets: the run and its steps, and nothing of how it is carried out
    expect(run).toMatchObject({
      status: 'running',
      personId: p,
      post: { url: POST_URL, topic: TOPIC },
      startedAt: new Date(MONDAY).toISOString(),
    });
    expect(run.steps.map((s) => s.kind)).toEqual(['view_profile', 'react_post', 'comment_post']);
    const pulled = (await k.pull(u.token)).body.changes.warmups!.find((w) => w.id === run.id)!;
    expect(pulled).toMatchObject({ id: run.id, status: 'running', comment: edited, personId: p });
    expect((pulled.steps as unknown[]).length).toBe(3);
    for (const hidden of [
      'linkedinAccount',
      'targetMemberId',
      'postId',
      'commentDraft',
      'linkedin_account',
      'post_id',
    ])
      expect(pulled, hidden).not.toHaveProperty(hidden);
    // the approval is on record, without the words
    const [audit] = await t.db.sql<{ details: Record<string, unknown> }>`
      select details from orbit.audit_log where user_id = ${u.userId}::uuid and action = 'warmup.start'`;
    expect(audit!.details).toMatchObject({
      commentApproved: true,
      commentChars: edited.length,
      commentEdited: true,
    });
    // Start touched LinkedIn not at all
    expect(mutations(k.unipile())).toEqual([]);
  });

  it('leaves the comment out when the student says so', async () => {
    const k = setup();
    const u = await student();
    const run = await begin(k, u.token, await priya(u.userId), null);
    expect(run.comment).toBeNull();
    expect(run.steps.map((s) => s.kind)).toEqual(['view_profile', 'react_post']);
    expect((await runRow(run.id)).comment).toBeNull();
  });

  it('refuses an empty, an overlong or a tagged comment', async () => {
    const k = setup();
    const u = await student();
    const p = await priya(u.userId);
    const pre = await k.call<Preview>('/warmups/preview', u.token, { personId: p });
    const id = pre.body.preview!.id;
    for (const comment of ['', '   ', 'x'.repeat(WARMUP_AUTO_CAPS.commentMaxChars + 1), 'Hi {{0}}, nice']) {
      const r = await k.call('/warmups/start', u.token, { warmupId: id, comment });
      expect(r.status, JSON.stringify(comment).slice(0, 30)).toBe(400);
    }
    expect((await k.call('/warmups/start', u.token, { warmupId: id })).status).toBe(400);
    expect((await runRow(id)).status).toBe('preview');
  });

  it('starts one warm-up per person, and a second Start answers with the same run', async () => {
    const k = setup();
    const u = await student();
    const p = await priya(u.userId);
    const pre = await k.call<Preview>('/warmups/preview', u.token, { personId: p });
    const [a, b] = await Promise.all([
      k.call<Started>('/warmups/start', u.token, { warmupId: pre.body.preview!.id, comment: COMMENT }),
      k.call<Started>('/warmups/start', u.token, { warmupId: pre.body.preview!.id, comment: 'Another text' }),
    ]);
    const ok = [a, b].filter((r) => r.status === 200 && r.body.ok);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(
      await t.db.sql`select 1 from orbit.warmups where person_id = ${p}::uuid and status = 'running'`,
    ).toHaveLength(1);
    expect(await steps(pre.body.preview!.id)).toHaveLength(3);
    const again = await k.call<Preview>('/warmups/preview', u.token, { personId: p });
    expect(again.body).toMatchObject({ ok: false, reason: 'running', run: { id: pre.body.preview!.id } });
  });

  it('never lets the approved comment, its post or its account change after Start', async () => {
    const k = setup();
    const u = await student();
    const run = await begin(k, u.token, await priya(u.userId));
    await expect(
      t.db.sql`update orbit.warmups set comment = 'Other words' where id = ${run.id}::uuid`,
    ).rejects.toThrow(/cannot change after Start/);
    await expect(
      t.db.sql`update orbit.warmups set comment = null where id = ${run.id}::uuid`,
    ).rejects.toThrow(/cannot change after Start/);
    await expect(
      t.db.sql`update orbit.warmups set post_id = 'urn:li:activity:999' where id = ${run.id}::uuid`,
    ).rejects.toThrow(/cannot change after Start/);
    await expect(
      t.db.sql`update orbit.warmups set linkedin_account = 'someone-else' where id = ${run.id}::uuid`,
    ).rejects.toThrow(/cannot change after Start/);
    await expect(
      t.db.sql`update orbit.warmups set status = 'preview' where id = ${run.id}::uuid`,
    ).rejects.toThrow(/cannot go back/);
    expect((await runRow(run.id)).comment).toBe(COMMENT);
  });

  it('does not start with the setting off, LinkedIn not active, or another LinkedIn account than the one that read the post', async () => {
    const k = setup();
    const u = await student();
    const mk = async () => {
      const p = await priya(u.userId);
      const pre = await k.call<Preview>('/warmups/preview', u.token, { personId: p });
      return pre.body.preview!.id;
    };
    const a = await mk();
    await t.db
      .sql`update orbit.users set settings = '{"warmup_auto": false}'::jsonb where id = ${u.userId}::uuid`;
    expect(
      (await k.call<Started>('/warmups/start', u.token, { warmupId: a, comment: COMMENT })).body,
    ).toEqual({
      ok: false,
      reason: 'off',
    });
    await t.db.sql`update orbit.users set settings = '{}'::jsonb where id = ${u.userId}::uuid`;
    await t.db
      .sql`update orbit.integration_accounts set status = 'needs_reauth' where user_id = ${u.userId}::uuid`;
    expect(
      (await k.call<Started>('/warmups/start', u.token, { warmupId: a, comment: COMMENT })).body.reason,
    ).toBe('sign_in');
    await t.db.sql`update orbit.integration_accounts set status = 'active', external_account_id = 'acc-new'
                    where user_id = ${u.userId}::uuid`;
    expect(
      (await k.call<Started>('/warmups/start', u.token, { warmupId: a, comment: COMMENT })).body.reason,
    ).toBe('not_connected');
    expect(await t.db.sql`select 1 from orbit.warmup_steps where user_id = ${u.userId}::uuid`).toHaveLength(
      0,
    );
    // another student cannot start it
    const other = await student();
    expect((await k.call('/warmups/start', other.token, { warmupId: a, comment: COMMENT })).status).toBe(404);
  });
});

describe('running the steps', () => {
  it('runs each step once at its time, through the student’s own account, and posts the approved text byte for byte', async () => {
    const k = setup();
    const u = await student();
    const bystander = await student();
    const p = await priya(u.userId);
    const approved = 'Day two in prod.  Did that hold at 20+ people?\nAsking as a student, très curious 🙂';
    const run = await begin(k, u.token, p, approved);
    const before = k.unipile().length;
    const st = await steps(run.id);

    // not before its time
    expect(await runWarmupStep(k.services(), u.userId, st[0]!.id)).toEqual({
      kind: 'nothing',
      why: 'not due yet',
    });
    // not by another student
    k.clock.now = MONDAY + 2 * MIN;
    expect((await runWarmupStep(k.services(), bystander.userId, st[0]!.id)).kind).toBe('nothing');
    expect(k.unipile()).toHaveLength(before);

    expect(await runAll(k, u.userId, run.id)).toEqual([{ kind: 'done' }, { kind: 'done' }, { kind: 'done' }]);
    const made = k.unipile().slice(before);
    expect(made.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      `GET /api/v1/users/ACoAAPriya${people}`,
      'POST /api/v1/posts/reaction',
      `POST /api/v1/posts/${encodeURIComponent(POST_ID)}/comments`,
    ]);
    // the view is a visible one
    const view = new URL(made[0]!.url);
    expect(view.searchParams.get('notify')).toBe('true');
    expect(view.searchParams.get('account_id')).toBe(u.account);
    // the like: on the chosen post, from the student's account
    expect(made[1]!.body).toEqual({ account_id: u.account, post_id: POST_ID, reaction_type: 'like' });
    // the comment: the approved words and nothing else
    const sent = made[2]!.body as Record<string, string>;
    expect(Object.keys(sent).sort()).toEqual(['account_id', 'text']);
    expect(sent.account_id).toBe(u.account);
    expect(sent.text).toBe(approved);
    expect(Buffer.from(sent.text!, 'utf8').equals(Buffer.from(approved, 'utf8'))).toBe(true);
    // every call names the student's account, and none the bystander's
    for (const c of k.unipile()) {
      const id =
        new URL(c.url).searchParams.get('account_id') ?? (c.body as { account_id?: string }).account_id;
      expect(id).toBe(u.account);
      expect(JSON.stringify(c)).not.toContain(bystander.account);
    }
    // no message, no connection request, no other account, no webhook: ever
    for (const c of k.unipile())
      expect(new URL(c.url).pathname).not.toMatch(
        /\/chats|\/invite|\/accounts|\/webhooks|\/messages|\/hosted/,
      );
    // each step is recorded with when it ran and what happened
    const after = await steps(run.id);
    expect(after.map((s) => [s.status, s.attempts])).toEqual([
      ['done', 1],
      ['done', 1],
      ['done', 1],
    ]);
    for (const s of after) {
      expect(s.ran_at).not.toBeNull();
      expect(inWorkingHours(new Date(s.ran_at!), NY)).toBe(true);
      expect(s.result.tries).toHaveLength(1);
      expect(s.result.tries![0]).toMatchObject({ ok: true });
    }
    // on three different days
    expect(new Set(after.map((s) => new Date(s.ran_at!).toISOString().slice(0, 10))).size).toBe(3);
    // done, and running a step again does nothing
    expect((await runRow(run.id)).status).toBe('done');
    const n = k.unipile().length;
    for (const s of after) expect((await runWarmupStep(k.services(), u.userId, s.id)).kind).toBe('nothing');
    expect(k.unipile()).toHaveLength(n);
    // the day's counts
    const counted = await t.db.sql<{ kind: string; n: number }>`
      select kind, count(*)::int as n from orbit.warmup_actions where user_id = ${u.userId}::uuid group by 1 order by 1`;
    expect(counted).toEqual([
      { kind: 'comment_post', n: 1 },
      { kind: 'react_post', n: 1 },
      { kind: 'view_profile', n: 1 },
    ]);
    const daily = await t.db.sql<{ kind: string; made: number }>`
      select kind, made from orbit.linkedin_calls_daily where linkedin_account = ${u.account} and caller = 'warmup' order by 1`;
    expect(daily.map((d) => d.kind)).toEqual(['comment', 'posts', 'profile', 'reaction']);
  });

  it('takes a step once when two jobs run it at the same moment', async () => {
    const k = setup();
    const u = await student();
    const run = await begin(k, u.token, await priya(u.userId));
    const [first] = await steps(run.id);
    k.clock.now = MONDAY + 2 * MIN;
    const before = k.unipile().length;
    const out = await Promise.all([1, 2, 3, 4].map(() => runWarmupStep(k.services(), u.userId, first!.id)));
    expect(out.filter((o) => o.kind === 'done')).toHaveLength(1);
    expect(out.filter((o) => o.kind === 'nothing')).toHaveLength(3);
    expect(k.unipile().length - before).toBe(1);
    expect((await steps(run.id))[0]).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('goes through the schedule and the worker: a job per due step, run once', async () => {
    const k = setup();
    const u = await student();
    const run = await begin(k, u.token, await priya(u.userId));
    const handlers = defaultHandlers(k.config);
    k.clock.now = MONDAY + 2 * MIN;
    // the database's clock is past every step: only the view is given a time that has come in the test's clock
    const [{ n }] = (await t.db.sql<{ n: number }>`select orbit.enqueue_warmup_steps() as n`) as [
      { n: number },
    ];
    expect(n).toBe(3);
    // the same tick again queues nothing twice
    expect((await t.db.sql<{ n: number }>`select count(*)::int as n from pgmq.q_orbit_cadence`)[0]!.n).toBe(
      3,
    );
    await t.db.sql`select orbit.enqueue_warmup_steps()`;
    expect((await t.db.sql<{ n: number }>`select count(*)::int as n from pgmq.q_orbit_cadence`)[0]!.n).toBe(
      3,
    );
    const before = k.unipile().length;
    const tick = await runTick({ db: t.db, handlers, now: k.now });
    expect(tick).toMatchObject({ processed: 3, ok: 3, failed: 0 });
    // the view ran; the like and the comment were not due by the test's clock
    expect(k.unipile().length - before).toBe(1);
    expect((await steps(run.id)).map((s) => s.status)).toEqual(['done', 'pending', 'pending']);
    const jobs = await t.db.sql<{ kind: string; status: string }>`select kind, status from orbit.job_runs`;
    expect(jobs).toEqual([
      { kind: 'warmup.step', status: 'ok' },
      { kind: 'warmup.step', status: 'ok' },
      { kind: 'warmup.step', status: 'ok' },
    ]);
  });

  it('does nothing at night or at the weekend: the step moves to the next working window', async () => {
    const k = setup();
    const u = await student();
    const run = await begin(k, u.token, await priya(u.userId));
    const [first] = await steps(run.id);
    const before = k.unipile().length;
    // 23:00 on Monday in New York
    k.clock.now = Date.parse('2026-11-17T04:00:00Z');
    const night = await runWarmupStep(k.services(), u.userId, first!.id);
    expect(night).toMatchObject({ kind: 'waiting', why: 'hours' });
    let due = (await steps(run.id))[0]!.due_at;
    expect(new Date(due).toISOString().slice(0, 10)).toBe('2026-11-17');
    expect(inWorkingHours(new Date(due), NY)).toBe(true);
    // Saturday noon
    await t.db
      .sql`update orbit.warmup_steps set due_at = ${new Date(MONDAY)}::timestamptz where id = ${first!.id}::uuid`;
    k.clock.now = Date.parse('2026-11-21T17:00:00Z');
    expect(await runWarmupStep(k.services(), u.userId, first!.id)).toMatchObject({
      kind: 'waiting',
      why: 'hours',
    });
    due = (await steps(run.id))[0]!.due_at;
    expect(new Date(due).toISOString().slice(0, 10)).toBe('2026-11-23');
    expect(k.unipile()).toHaveLength(before);
    expect((await steps(run.id))[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });
});

describe('the daily caps and the spacing', () => {
  /** `n` warm-ups for one student, every profile view due at the same moment. */
  async function many(k: Kit, n: number) {
    const u = await student();
    const firsts: { id: string; due_at: Date }[] = [];
    for (let i = 0; i < n; i++) {
      const run = await begin(k, u.token, await priya(u.userId), null);
      firsts.push((await steps(run.id))[0]!);
    }
    return { u, firsts };
  }

  it('lets one action through when many are due at once, and spaces the rest at least 90 seconds on', async () => {
    const k = setup();
    const { u, firsts } = await many(k, 6);
    k.clock.now = MONDAY + 5 * MIN;
    const before = k.unipile().length;
    const out = await Promise.all(firsts.map((s) => runWarmupStep(k.services(), u.userId, s.id)));
    expect(out.filter((o) => o.kind === 'done')).toHaveLength(1);
    const waiting = out.filter((o) => o.kind === 'waiting') as Extract<StepOutcome, { kind: 'waiting' }>[];
    expect(waiting).toHaveLength(5);
    for (const w of waiting) {
      expect(w.why).toBe('gap');
      expect(Date.parse(w.until) - k.clock.now).toBeGreaterThanOrEqual(WARMUP_AUTO_CAPS.minGapSeconds * 1000);
    }
    expect(k.unipile().length - before).toBe(1);
    expect(await t.db.sql`select 1 from orbit.warmup_actions where user_id = ${u.userId}::uuid`).toHaveLength(
      1,
    );
    // 89 seconds later still nothing; at 90 seconds the next one goes
    k.clock.now += 89_000;
    await t.db.sql`update orbit.warmup_steps set due_at = ${new Date(MONDAY)}::timestamptz
                    where user_id = ${u.userId}::uuid and status = 'pending'`;
    const [second] = await t.db.sql<{ id: string }>`
      select id from orbit.warmup_steps where user_id = ${u.userId}::uuid and seq = 1 and status = 'pending' limit 1`;
    const early = await Promise.all(firsts.map((s) => runWarmupStep(k.services(), u.userId, s.id)));
    expect(early.filter((o) => o.kind === 'done')).toHaveLength(0);
    await t.db.sql`update orbit.warmup_steps set due_at = ${new Date(MONDAY)}::timestamptz
                    where user_id = ${u.userId}::uuid and status = 'pending'`;
    k.clock.now += 1_000;
    expect((await runWarmupStep(k.services(), u.userId, second!.id)).kind).toBe('done');
    expect(k.unipile().length - before).toBe(2);
    // a step that was not allowed is not a failed try
    const attempts = await t.db.sql<{ attempts: number; status: string }>`
      select attempts, status from orbit.warmup_steps where user_id = ${u.userId}::uuid and seq = 1 and status = 'pending'`;
    for (const a of attempts) expect(a.attempts).toBe(0);
  });

  it('holds the day at 15 profile views: the sixteenth waits for the next working day', async () => {
    const k = setup();
    const cap = WARMUP_AUTO_CAPS.perDay.view_profile;
    const { u, firsts } = await many(k, cap + 1);
    const before = k.unipile().length;
    const out: StepOutcome[] = [];
    for (const s of firsts) {
      k.clock.now += 2 * MIN;
      out.push(await runWarmupStep(k.services(), u.userId, s.id));
    }
    expect(out.slice(0, cap).every((o) => o.kind === 'done')).toBe(true);
    const last = out[cap] as Extract<StepOutcome, { kind: 'waiting' }>;
    expect(last).toMatchObject({ kind: 'waiting', why: 'day_cap' });
    expect(last.until.slice(0, 10)).toBe('2026-11-17');
    expect(inWorkingHours(new Date(last.until), NY)).toBe(true);
    expect(k.unipile().length - before).toBe(cap);
    // the next working day it runs
    const [left] = await t.db.sql<{ id: string; due_at: Date }>`
      select id, due_at from orbit.warmup_steps where user_id = ${u.userId}::uuid and seq = 1 and status = 'pending'`;
    expect((await runAt(k, u.userId, left!)).kind).toBe('done');
  });

  it('counts likes and comments on their own, lower, counts', async () => {
    const u = await student();
    const dayStart = new Date('2026-11-16T05:00:00Z');
    for (const [kind, cap] of [
      ['react_post', WARMUP_AUTO_CAPS.perDay.react_post],
      ['comment_post', WARMUP_AUTO_CAPS.perDay.comment_post],
    ] as const) {
      const take = (person: string, at: number) =>
        t.db.sql<{ allowed: boolean; reason: string | null }>`
          select allowed, reason from orbit.warmup_take(
            ${u.userId}::uuid, ${person}::uuid, null, ${kind}, ${u.account}, ${dayStart}::timestamptz,
            ${cap}::int, 90, 1, ${new Date(at)}::timestamptz)`;
      const base = kind === 'react_post' ? MONDAY : MONDAY + 2 * HOUR;
      for (let i = 0; i < cap; i++) {
        const [r] = await take(crypto.randomUUID(), base + i * 2 * MIN);
        expect(r, `${kind} ${i}`).toEqual({ allowed: true, reason: null });
      }
      const [over] = await take(crypto.randomUUID(), base + cap * 2 * MIN);
      expect(over).toEqual({ allowed: false, reason: 'day_cap' });
    }
    // the next day starts at zero
    const [next] = await t.db.sql<{ allowed: boolean }>`
      select allowed from orbit.warmup_take(${u.userId}::uuid, ${crypto.randomUUID()}::uuid, null, 'comment_post',
        ${u.account}, ${new Date('2026-11-17T05:00:00Z')}::timestamptz, 4, 90, 1, ${new Date('2026-11-17T15:00:00Z')}::timestamptz)`;
    expect(next!.allowed).toBe(true);
    // and one student's count is not another's
    const other = await student();
    const [theirs] = await t.db.sql<{ allowed: boolean }>`
      select allowed from orbit.warmup_take(${other.userId}::uuid, ${crypto.randomUUID()}::uuid, null, 'comment_post',
        ${other.account}, ${dayStart}::timestamptz, 4, 90, 1, ${new Date(MONDAY + 3 * HOUR)}::timestamptz)`;
    expect(theirs!.allowed).toBe(true);
  });

  it('acts on one person once a day: a second step due the same day waits for the next working day', async () => {
    const k = setup();
    const u = await student();
    const run = await begin(k, u.token, await priya(u.userId));
    const st = await steps(run.id);
    expect((await runAt(k, u.userId, st[0]!)).kind).toBe('done');
    // the like pulled forward to the same afternoon
    await t.db
      .sql`update orbit.warmup_steps set due_at = ${new Date(MONDAY + HOUR)}::timestamptz where id = ${st[1]!.id}::uuid`;
    k.clock.now = MONDAY + 2 * HOUR;
    const before = k.unipile().length;
    const out = await runWarmupStep(k.services(), u.userId, st[1]!.id);
    expect(out).toMatchObject({ kind: 'waiting', why: 'person_day' });
    expect((out as { until: string }).until.slice(0, 10)).toBe('2026-11-17');
    expect(k.unipile()).toHaveLength(before);
  });

  it('counts a warm-up view toward the day’s profile views across Orbit, and waits when they are used up', async () => {
    const k = setup();
    const u = await student();
    const run = await begin(k, u.token, await priya(u.userId));
    await t.db.sql`
      insert into orbit.usage_ledger (user_id, provider, operation, units, cost_usd, created_at)
      select ${u.userId}::uuid, 'unipile', 'profile_view', 1, 0, ${new Date(MONDAY)}::timestamptz from generate_series(1, 40)`;
    const [first] = await steps(run.id);
    const before = k.unipile().length;
    expect(await runAt(k, u.userId, first!)).toMatchObject({ kind: 'waiting', why: 'budget' });
    expect(k.unipile()).toHaveLength(before);
  });

  it('waits, uncounted, when other accounts looked the person up lately (the swarm limit)', async () => {
    const plain = setup();
    const k = setup({ linkedinTarget: true });
    const u = await student();
    const p = await priya(u.userId);
    const run = await begin(plain, u.token, p);
    const [first] = await steps(run.id);
    // another account read this person a moment ago
    await t.db
      .sql`select public.orbit_linkedin_target_take(${`acoaapriya${people}`}, 'someone-elses-account', 3, 1200)`;
    // a preview for them now says LinkedIn cannot be read, and reads nothing
    await t.db.sql`select orbit.warmup_stop(${run.id}::uuid, 'cancelled')`;
    expect((await k.call<Preview>('/warmups/preview', u.token, { personId: p })).body).toEqual({
      ok: false,
      reason: 'busy',
    });
    expect(k.unipile()).toEqual([]);
    await t.db
      .sql`update orbit.warmups set status = 'running', stop_reason = null, finished_at = null where id = ${run.id}::uuid`;
    await t.db
      .sql`update orbit.warmup_steps set status = 'pending', note = null where warmup_id = ${run.id}::uuid`;
    k.clock.now = MONDAY + 2 * MIN;
    const before = k.unipile().length;
    const out = await runWarmupStep(k.services(), u.userId, first!.id);
    expect(out).toMatchObject({ kind: 'waiting', why: 'busy' });
    expect(k.unipile()).toHaveLength(before);
    expect((await steps(run.id))[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await t.db.sql`select 1 from orbit.warmup_actions where user_id = ${u.userId}::uuid`).toHaveLength(
      0,
    );
  });
});

describe('a step that fails', () => {
  it('is tried once more later that day, then skipped with a note, and the run still finishes', async () => {
    const k = setup();
    const u = await student();
    const run = await begin(k, u.token, await priya(u.userId));
    let st = await steps(run.id);
    expect((await runAt(k, u.userId, st[0]!)).kind).toBe('done');
    k.world.on.react = () => jsonRes(500, { type: 'errors/provider_error' });
    const first = await runAt(k, u.userId, st[1]!);
    expect(first).toMatchObject({ kind: 'retry', error: 'unavailable' });
    st = await steps(run.id);
    expect(st[1]).toMatchObject({ status: 'pending', attempts: 1 });
    // later the same day, 45 minutes to two hours on, still in working hours
    const wait = new Date(st[1]!.due_at).getTime() - k.clock.now;
    expect(wait).toBeGreaterThanOrEqual(45 * MIN);
    expect(wait).toBeLessThanOrEqual(120 * MIN);
    expect(new Date(st[1]!.due_at).toISOString().slice(0, 10)).toBe('2026-11-18');
    expect(inWorkingHours(new Date(st[1]!.due_at), NY)).toBe(true);
    // not before then
    expect((await runWarmupStep(k.services(), u.userId, st[1]!.id)).kind).toBe('nothing');
    const second = await runAt(k, u.userId, st[1]!);
    expect(second).toEqual({ kind: 'skipped', note: 'failed' });
    st = await steps(run.id);
    expect(st[1]).toMatchObject({ status: 'skipped', attempts: 2, note: 'failed' });
    expect(st[1]!.result.tries).toHaveLength(2);
    expect(st[1]!.result.tries![0]).toMatchObject({ ok: false, error: 'unavailable', status: 500 });
    // exactly two tries reached LinkedIn
    expect(k.unipile().filter((c) => c.url.endsWith('/posts/reaction'))).toHaveLength(2);
    // the comment still goes, and the run is done
    expect((await runAt(k, u.userId, st[2]!)).kind).toBe('done');
    expect((await runRow(run.id)).status).toBe('done');
    expect(await notices(u.userId)).toHaveLength(1);
  });

  it('succeeds on the second try', async () => {
    const k = setup();
    const u = await student();
    const run = await begin(k, u.token, await priya(u.userId), null);
    const st = await steps(run.id);
    let n = 0;
    k.world.on.profile = () => (n++ === 0 ? jsonRes(429, { type: 'errors/too_many_requests' }) : undefined);
    expect(await runAt(k, u.userId, st[0]!)).toMatchObject({ kind: 'retry', error: 'rate_limited' });
    const again = (await steps(run.id))[0]!;
    expect((await runAt(k, u.userId, again)).kind).toBe('done');
    expect((await steps(run.id))[0]).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('never posts a comment twice: a try with no answer is looked for on the post before it is tried again', async () => {
    const k = setup();
    const u = await student();
    const run = await begin(k, u.token, await priya(u.userId));
    let st = await steps(run.id);
    await runAt(k, u.userId, st[0]!);
    await runAt(k, u.userId, st[1]!);
    // the comment went through at LinkedIn but the answer was lost
    k.world.on.comment = () => {
      k.world.comments = [{ text: 'Someone else said this' }, { text: COMMENT }];
      return jsonRes(504, { type: 'errors/request_timeout' });
    };
    expect(await runAt(k, u.userId, st[2]!)).toMatchObject({ kind: 'retry', error: 'unavailable' });
    st = await steps(run.id);
    expect(st[2]!.result.tries![0]).toMatchObject({ ambiguous: true });
    const posts = () =>
      k.unipile().filter((c) => c.method === 'POST' && /\/comments$/.test(new URL(c.url).pathname));
    expect(posts()).toHaveLength(1);
    expect((await runAt(k, u.userId, st[2]!)).kind).toBe('done');
    // the second run read the post's comments, found the words there, and posted nothing
    expect(posts()).toHaveLength(1);
    const check = k.unipile().find((c) => c.method === 'GET' && /\/comments$/.test(new URL(c.url).pathname))!;
    expect(new URL(check.url).searchParams.get('account_id')).toBe(u.account);
    st = await steps(run.id);
    expect(st[2]).toMatchObject({ status: 'done', attempts: 2 });
    expect(st[2]!.result.tries![1]).toMatchObject({ ok: true, found: true });
  });

  it('posts on the second try when the first did not land, and skips it unconfirmed when it cannot tell', async () => {
    const landed = setup();
    const u = await student();
    const run = await begin(landed, u.token, await priya(u.userId));
    let st = await steps(run.id);
    await runAt(landed, u.userId, st[0]!);
    await runAt(landed, u.userId, st[1]!);
    let n = 0;
    landed.world.on.comment = () =>
      n++ === 0 ? jsonRes(503, { type: 'errors/service_unavailable' }) : undefined;
    await runAt(landed, u.userId, st[2]!);
    expect((await runAt(landed, u.userId, (await steps(run.id))[2]!)).kind).toBe('done');
    expect(n).toBe(2);

    const blind = setup();
    const u2 = await student();
    const run2 = await begin(blind, u2.token, await priya(u2.userId));
    st = await steps(run2.id);
    await runAt(blind, u2.userId, st[0]!);
    await runAt(blind, u2.userId, st[1]!);
    let tries = 0;
    blind.world.on.comment = () => {
      tries++;
      return jsonRes(504, { type: 'errors/request_timeout' });
    };
    blind.world.on.comments = () => jsonRes(503, { type: 'errors/service_unavailable' });
    await runAt(blind, u2.userId, st[2]!);
    expect(await runAt(blind, u2.userId, (await steps(run2.id))[2]!)).toEqual({
      kind: 'skipped',
      note: 'unconfirmed',
    });
    expect(tries).toBe(1);
    expect((await runRow(run2.id)).status).toBe('done');
  });

  it('skips the steps on a post that was deleted, and finishes', async () => {
    const k = setup();
    const u = await student();
    const run = await begin(k, u.token, await priya(u.userId));
    const st = await steps(run.id);
    await runAt(k, u.userId, st[0]!);
    k.world.on.react = () => jsonRes(404, { type: 'errors/resource_not_found', title: 'Post not found' });
    expect(await runAt(k, u.userId, st[1]!)).toEqual({ kind: 'skipped', note: 'post_gone' });
    const after = await steps(run.id);
    expect(after.map((s) => [s.status, s.note])).toEqual([
      ['done', null],
      ['skipped', 'post_gone'],
      ['skipped', 'post_gone'],
    ]);
    // no comment was ever tried on it
    expect(k.unipile().filter((c) => /\/comments$/.test(new URL(c.url).pathname))).toEqual([]);
    expect((await runRow(run.id)).status).toBe('done');
    // an invalid post (422) reads the same way
    const k2 = setup();
    const run2 = await begin(k2, u.token, await priya(u.userId));
    const st2 = await steps(run2.id);
    await runAt(k2, u.userId, st2[0]!);
    await runAt(k2, u.userId, st2[1]!);
    k2.world.on.comment = () => jsonRes(422, { type: 'errors/invalid_post' });
    expect(await runAt(k2, u.userId, st2[2]!)).toEqual({ kind: 'skipped', note: 'post_gone' });
  });

  it('takes "already reacted" as done', async () => {
    const k = setup();
    const u = await student();
    const run = await begin(k, u.token, await priya(u.userId), null);
    const st = await steps(run.id);
    await runAt(k, u.userId, st[0]!);
    k.world.on.react = () => jsonRes(422, { type: 'errors/action_already_performed' });
    expect((await runAt(k, u.userId, st[1]!)).kind).toBe('done');
    expect((await steps(run.id))[1]).toMatchObject({ status: 'done', note: 'already_reacted' });
  });

  it('stops the run when LinkedIn turns the account away', async () => {
    const k = setup();
    const u = await student();
    const run = await begin(k, u.token, await priya(u.userId));
    const st = await steps(run.id);
    k.world.on.profile = () => jsonRes(401, { type: 'errors/disconnected_account' });
    expect(await runAt(k, u.userId, st[0]!)).toEqual({ kind: 'stopped', reason: 'linkedin_sign_in' });
    expect(await runRow(run.id)).toMatchObject({ status: 'stopped', stop_reason: 'linkedin_sign_in' });
    const n = k.unipile().length;
    for (const s of await steps(run.id)) {
      expect(s.status).toBe('skipped');
      k.clock.now += DAY;
      expect((await runWarmupStep(k.services(), u.userId, s.id)).kind).toBe('nothing');
    }
    expect(k.unipile()).toHaveLength(n);
    // a stopped run tells nobody it is done
    expect(await notices(u.userId)).toEqual([]);
  });

  it('closes a step whose worker died twice instead of trying a third time', async () => {
    const k = setup();
    const u = await student();
    const run = await begin(k, u.token, await priya(u.userId), null);
    const [first] = await steps(run.id);
    await t.db.sql`
      update orbit.warmup_steps set status = 'running', attempts = 2, claimed_at = now() - interval '20 minutes'
       where id = ${first!.id}::uuid`;
    // the schedule puts it back in line, marked
    await t.db.sql`select orbit.enqueue_warmup_steps()`;
    expect((await steps(run.id))[0]).toMatchObject({
      status: 'pending',
      attempts: 2,
      result: { interrupted: true },
    });
    k.clock.now = MONDAY + 2 * MIN;
    const before = k.unipile().length;
    expect(await runWarmupStep(k.services(), u.userId, first!.id)).toEqual({
      kind: 'skipped',
      note: 'failed',
    });
    expect(k.unipile()).toHaveLength(before);
  });
});

describe('what stops a warm-up', () => {
  /** A run with its first step due, a change made to the world, and then the step run. */
  async function stoppedBy(
    change: (c: {
      k: Kit;
      userId: string;
      token: string;
      personId: string;
      run: WarmUpRun;
    }) => Promise<unknown>,
    viaSchedule = false,
  ) {
    const k = setup();
    const u = await student();
    const personId = await priya(u.userId);
    const run = await begin(k, u.token, personId);
    const [first] = await steps(run.id);
    k.clock.now = MONDAY + 2 * MIN;
    await change({ k, userId: u.userId, token: u.token, personId, run });
    const before = k.unipile().length;
    if (viaSchedule) await t.db.sql`select orbit.enqueue_warmup_steps()`;
    const out = await runWarmupStep(k.services(), u.userId, first!.id);
    expect(k.unipile(), 'no LinkedIn call after the stop').toHaveLength(before);
    expect(mutations(k.unipile())).toEqual([]);
    return { out, row: await runRow(run.id), steps: await steps(run.id), k, u, run };
  }

  it('the student’s Stop, at any time', async () => {
    const r = await stoppedBy(async ({ k, token, run }) => {
      const s = await k.call<{ stopped: boolean; run: WarmUpRun }>('/warmups/stop', token, {
        warmupId: run.id,
      });
      expect(s.body).toMatchObject({ stopped: true, run: { status: 'stopped', stopReason: 'cancelled' } });
      // Stop by person works too, and a second Stop is a no-op
      expect(
        (await k.call<{ stopped: boolean }>('/warmups/stop', token, { personId: run.personId })).body.stopped,
      ).toBe(false);
    });
    expect(r.out.kind).toBe('nothing');
    expect(r.row).toMatchObject({ status: 'stopped', stop_reason: 'cancelled' });
    expect(r.steps.map((s) => [s.status, s.note])).toEqual([
      ['skipped', 'stopped'],
      ['skipped', 'stopped'],
      ['skipped', 'stopped'],
    ]);
    // a new warm-up for the same person can be started afterwards
    await begin(r.k, r.u.token, r.run.personId);
    // and another student cannot stop it
    const other = await student();
    expect(
      (await r.k.call<{ stopped: boolean }>('/warmups/stop', other.token, { personId: r.run.personId })).body
        .stopped,
    ).toBe(false);
  });

  const cases: [string, string, Parameters<typeof stoppedBy>[0]][] = [
    [
      'the person replies',
      'replied',
      ({ userId, personId }) =>
        addThread(
          t,
          userId,
          personId,
          [
            {
              direction: 'in',
              at: new Date(MONDAY + MIN).toISOString(),
              body: 'Saw you looked at my profile. What are you working on?',
            },
          ],
          { provider: 'linkedin' },
        ),
    ],
    [
      'the student writes to them',
      'messaged',
      ({ userId, personId }) =>
        addThread(
          t,
          userId,
          personId,
          [{ direction: 'out', at: new Date(MONDAY + MIN).toISOString(), body: 'Hi Priya' }],
          {
            provider: 'linkedin',
          },
        ),
    ],
    [
      'a first message is approved to go',
      'messaged',
      ({ userId, personId }) => t.db.sql`
        insert into orbit.drafts (user_id, person_id, channel, kind, body, status, updated_at)
        values (${userId}::uuid, ${personId}::uuid, 'linkedin', 'outreach', 'Hi Priya', 'approved', ${new Date(MONDAY + MIN)}::timestamptz)`,
    ],
    [
      'they become a connection',
      'connected',
      ({ personId }) =>
        t.db.sql`update orbit.people set linkedin_connected_on = '2026-11-16' where id = ${personId}::uuid`,
    ],
    [
      'they are marked do not contact',
      'do_not_contact',
      ({ personId }) => t.db.sql`update orbit.people set do_not_contact = true where id = ${personId}::uuid`,
    ],
    [
      'they are hidden',
      'hidden',
      ({ personId }) => t.db.sql`update orbit.people set hidden_at = now() where id = ${personId}::uuid`,
    ],
    [
      'they are merged into someone else',
      'merged',
      async ({ userId, personId }) => {
        const keep = await addPerson(t, userId, { name: 'Priya R' });
        await t.db.sql`update orbit.people set merged_into = ${keep}::uuid where id = ${personId}::uuid`;
      },
    ],
    [
      'they are deleted',
      'person_gone',
      ({ personId }) => t.db.sql`update orbit.people set deleted_at = now() where id = ${personId}::uuid`,
    ],
    [
      'LinkedIn is disconnected',
      'linkedin_disconnected',
      ({ userId }) =>
        t.db.sql`update orbit.integration_accounts set status = 'revoked' where user_id = ${userId}::uuid`,
    ],
    [
      'the LinkedIn row is gone',
      'linkedin_disconnected',
      ({ userId }) => t.db.sql`delete from orbit.integration_accounts where user_id = ${userId}::uuid`,
    ],
    [
      'LinkedIn is parked',
      'linkedin_parked',
      ({ userId }) => t.db.sql`
        update orbit.integration_accounts set status = 'parked', external_account_id = null where user_id = ${userId}::uuid`,
    ],
    [
      'LinkedIn needs a new sign-in',
      'linkedin_sign_in',
      ({ userId }) =>
        t.db
          .sql`update orbit.integration_accounts set status = 'needs_reauth' where user_id = ${userId}::uuid`,
    ],
    [
      'another LinkedIn account was connected',
      'linkedin_changed',
      ({ userId }) => t.db.sql`
        update orbit.integration_accounts set external_account_id = 'acc-another' where user_id = ${userId}::uuid`,
    ],
    [
      'the browser’s pipeline says they replied',
      'replied',
      ({ userId, personId }) => t.db.sql`
        insert into orbit.chats (user_id, person_id, stage) values (${userId}::uuid, ${personId}::uuid, 'replied')`,
    ],
    [
      'the browser’s pipeline says a message went out',
      'messaged',
      ({ userId, personId }) => t.db.sql`
        insert into orbit.chats (user_id, person_id, stage) values (${userId}::uuid, ${personId}::uuid, 'outreach_sent')`,
    ],
  ];
  for (const [name, reason, change] of cases)
    it(`${name}: stopped (${reason}), and nothing more is done`, async () => {
      const r = await stoppedBy(change);
      expect(r.out).toEqual({ kind: 'stopped', reason });
      expect(r.row).toMatchObject({ status: 'stopped', stop_reason: reason });
      expect(r.steps.every((s) => s.status === 'skipped')).toBe(true);
      expect(await notices(r.u.userId)).toEqual([]);
      // the schedule alone stops it as well, before any step is due
      const viaTick = await stoppedBy(change, true);
      expect(viaTick.row).toMatchObject({ status: 'stopped', stop_reason: reason });
      expect(viaTick.out.kind).toBe('nothing');
    });

  it('a chat in the "warming" stage, or a message from before the start, stops nothing', async () => {
    const k = setup();
    const u = await student();
    const p = await priya(u.userId);
    const run = await begin(k, u.token, p);
    await t.db
      .sql`insert into orbit.chats (user_id, person_id, stage) values (${u.userId}::uuid, ${p}::uuid, 'warming')`;
    await addThread(t, u.userId, p, [
      { direction: 'in', at: new Date(MONDAY - 30 * DAY).toISOString(), body: 'An old note' },
      { direction: 'out', at: new Date(MONDAY - 29 * DAY).toISOString(), body: 'An old answer' },
    ]);
    await t.db.sql`select orbit.enqueue_warmup_steps()`;
    expect((await runRow(run.id)).status).toBe('running');
    const [first] = await steps(run.id);
    expect((await runAt(k, u.userId, first!)).kind).toBe('done');
  });

  it('turning "Run warm-ups for me" off stops every warm-up at once', async () => {
    const k = setup();
    const u = await student();
    const a = await begin(k, u.token, await priya(u.userId));
    const b = await begin(k, u.token, await priya(u.userId));
    const r = await k.call('/settings/profile', u.token, { warmUpAuto: false });
    expect(r.status).toBe(200);
    for (const run of [a, b])
      expect(await runRow(run.id)).toMatchObject({ status: 'stopped', stop_reason: 'setting_off' });
    const [s] = await t.db.sql<{ settings: Record<string, unknown> }>`
      select settings from orbit.users where id = ${u.userId}::uuid`;
    expect(s!.settings.warmup_auto).toBe(false);
    // nothing runs for them, and nothing new starts
    k.clock.now = MONDAY + 3 * DAY;
    const before = k.unipile().length;
    for (const st of await steps(a.id))
      expect((await runWarmupStep(k.services(), u.userId, st.id)).kind).toBe('nothing');
    expect(
      (await k.call<Preview>('/warmups/preview', u.token, { personId: await priya(u.userId) })).body.reason,
    ).toBe('off');
    expect(k.unipile()).toHaveLength(before);
    // back on: the key is removed (on is the default) and a warm-up can start again
    await k.call('/settings/profile', u.token, { warmUpAuto: true });
    const [s2] = await t.db.sql<{ settings: Record<string, unknown> }>`
      select settings from orbit.users where id = ${u.userId}::uuid`;
    expect(s2!.settings).not.toHaveProperty('warmup_auto');
    await begin(k, u.token, await priya(u.userId));
  });

  it('an account in a passing error waits instead of stopping', async () => {
    const k = setup();
    const u = await student();
    const run = await begin(k, u.token, await priya(u.userId));
    const [first] = await steps(run.id);
    await t.db.sql`update orbit.integration_accounts set status = 'error' where user_id = ${u.userId}::uuid`;
    k.clock.now = MONDAY + 2 * MIN;
    const before = k.unipile().length;
    expect(await runWarmupStep(k.services(), u.userId, first!.id)).toMatchObject({
      kind: 'waiting',
      why: 'account',
    });
    expect(k.unipile()).toHaveLength(before);
    expect((await runRow(run.id)).status).toBe('running');
  });
});

describe('done', () => {
  it('tells the student once, with a link to the person, however often the end is reached', async () => {
    const k = setup();
    const u = await student();
    const p = await priya(u.userId);
    const run = await begin(k, u.token, p);
    await runAll(k, u.userId, run.id);
    const row = await runRow(run.id);
    expect(row).toMatchObject({ status: 'done', stop_reason: null });
    expect(row.notified_at).not.toBeNull();
    expect(row.finished_at).not.toBeNull();
    // reaching the end again (a late job, a second worker) writes nothing more
    await Promise.all([1, 2, 3].map(() => finishIfOver(k.services(), u.userId, run.id, k.now())));
    expect(await notices(u.userId)).toEqual([
      {
        title: `Orbit finished the warm-up for Priya`,
        body: 'Your first message is ready to write.',
        link: `/people/${p}`,
      },
    ]);
    for (const n of await notices(u.userId)) expect(`${n.title} ${n.body}`).not.toMatch(/[—!]/);
    // the browser gets the finished run
    const pulled = (await k.pull(u.token)).body.changes.warmups!.find((w) => w.id === run.id)!;
    expect(pulled).toMatchObject({ status: 'done' });
    expect((pulled.steps as { status: string }[]).map((s) => s.status)).toEqual(['done', 'done', 'done']);
    expect(pulled.finishedAt).toBeTruthy();
    // "the student saw it" is kept once
    const told = await k.call<{ ok: boolean }>('/warmups/told', u.token, { warmupId: run.id });
    expect(told.body.ok).toBe(true);
    expect((await k.call<{ ok: boolean }>('/warmups/told', u.token, { warmupId: run.id })).body.ok).toBe(
      false,
    );
    // the sequence never wrote a draft or sent anything
    expect(await t.db.sql`select 1 from orbit.drafts where user_id = ${u.userId}::uuid`).toHaveLength(0);
  });

  it('says so when no step could run', async () => {
    const k = setup();
    const u = await student();
    const run = await begin(k, u.token, await priya(u.userId), null);
    k.world.on.profile = () => jsonRes(500, {});
    k.world.on.react = () => jsonRes(500, {});
    const out = await runAll(k, u.userId, run.id);
    expect(out.map((o) => o.kind)).toEqual(['retry', 'skipped', 'retry', 'skipped']);
    expect((await runRow(run.id)).status).toBe('done');
    expect(await notices(u.userId)).toEqual([
      expect.objectContaining({ title: 'Orbit could not run the warm-up for Priya' }),
    ]);
  });

  it('each step that runs moves the run, so the browser hears of it', async () => {
    const k = setup();
    const u = await student();
    const mark = async () =>
      (
        await t.db.sql<{ at: string }>`
        select changed_at::text as at from orbit.user_marks where user_id = ${u.userId}::uuid`
      )[0]?.at;
    const p = await priya(u.userId);
    const m0 = await mark();
    // a preview is the sheet's own business: the "something changed" mark does not move for it
    await k.call<Preview>('/warmups/preview', u.token, { personId: p });
    expect(await mark()).toBe(m0);
    const run = await begin(k, u.token, p);
    const m1 = await mark();
    expect(m1).not.toBe(m0);
    const first = await k.pull(u.token);
    expect(first.body.changes.warmups).toHaveLength(1);
    // nothing changed: nothing comes down again
    expect((await k.pull(u.token, first.body.cursor)).body.changes.warmups ?? []).toEqual([]);
    const [st] = await steps(run.id);
    await runAt(k, u.userId, st!);
    // the mark the browser polls moved, so it pulls now rather than at the next timer
    expect(await mark()).not.toBe(m1);
    const next = await k.pull(u.token, first.body.cursor);
    expect(next.body.changes.warmups).toHaveLength(1);
    expect((next.body.changes.warmups![0]!.steps as { status: string }[]).map((s) => s.status)).toEqual([
      'done',
      'pending',
      'pending',
    ]);
  });
});
