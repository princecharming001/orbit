import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCadence } from '../../functions/_shared/cadence/cadence.ts';
import { makeClaude, TASKS } from '../../functions/_shared/claude.ts';
import { extractMemories } from '../../functions/_shared/memory/memory.ts';
import { buildMime, headerValue } from '../../functions/_shared/sending/mime.ts';
import { makeServices } from '../../functions/_shared/services.ts';
import { defaultHandlers, PLACEHOLDER_KINDS, runTick } from '../../functions/orbit-worker/worker.ts';
import {
  addPerson,
  addThread,
  agentConfig,
  anthropic,
  api,
  DAY,
  fakeNet,
  jsonRes,
  type NetCall,
  signedInUser,
} from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

/** A Wednesday, so send days and business-day timers do not depend on when the suite runs. */
const NOW = new Date('2026-10-14T15:00:00Z');
let seq = 0;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const gmail = (c: NetCall) => {
  if (c.url === GMAIL_SEND) return jsonRes(200, { id: 'gm-1', threadId: 'gt-1' });
  if (c.url.includes('/gmail/v1/users/me/threads/')) return jsonRes(200, { messages: [] });
  return undefined;
};

async function outreachChat(userId: string, personId: string, lastOutboundDaysAgo: number, bumpCount = 0) {
  const [c] = await t.db.sql<{ id: string }>`
    insert into orbit.chats (user_id, person_id, stage, stage_entered_at, data)
    values (${userId}::uuid, ${personId}::uuid, 'outreach_sent', ${ago(lastOutboundDaysAgo * DAY)}::timestamptz,
            ${{ lastOutboundAt: ago(lastOutboundDaysAgo * DAY), firstOutreachAt: ago(lastOutboundDaysAgo * DAY), bumpCount, outreachChannel: 'email' }}::jsonb)
    returning id`;
  return c!.id;
}

describe('cadence.user (§9)', () => {
  it('is registered in place of the placeholder, with the other P4–P5 kinds', () => {
    const h = defaultHandlers();
    for (const k of ['cadence.user', 'enrich.dossier', 'source.search', 'send.draft']) {
      expect(h[k]).toBeTypeOf('function');
      expect(PLACEHOLDER_KINDS as readonly string[]).not.toContain(k);
    }
  });

  it('§9.8 test 3: a bump is never sent when an inbound message arrived after it was drafted', async () => {
    const net = fakeNet(gmail);
    const call = api(t, net, { env: {} });
    const { userId, token } = await signedInUser(t);
    const p = await addPerson(t, userId, { name: 'Jordan Lee', email: 'jordan@example.com' });
    await addThread(t, userId, p, [
      {
        direction: 'out',
        at: new Date(Date.now() - 10 * DAY).toISOString(),
        body: 'Hi Jordan, could we talk?',
      },
    ]);
    const c = await call<{ draft: { id: string } }>('/drafts/compose', token, {
      personId: p,
      kind: 'bump',
      channel: 'gmail',
    });
    await call('/drafts/approve', token, {
      draftId: c.body.draft.id,
      sendAt: new Date(Date.now() + DAY).toISOString(),
    });
    // they answer after the bump was drafted
    await t.db
      .sql`update orbit.drafts set created_at = now() - interval '2 hours', send_at = now() where id = ${c.body.draft.id}::uuid`;
    await addThread(t, userId, p, [
      { direction: 'in', at: new Date(Date.now() - 3_600_000).toISOString(), body: 'Yes, happy to.' },
    ]);
    await t.db.sql`update pgmq.q_orbit_send set vt = now()`;
    await runTick({ db: t.db, handlers: defaultHandlers(agentConfig(net, {})) });
    const [d] = await t.db.sql<{ status: string; cancel_reason: string }>`
      select status, cancel_reason from orbit.drafts where id = ${c.body.draft.id}::uuid`;
    expect(d).toEqual({ status: 'cancelled', cancel_reason: 'replied' });
    expect(net.calls.filter((x) => x.url === GMAIL_SEND)).toHaveLength(0);
  });

  it('§9.8 test 4: nobody gets a fourth unanswered message across channels; a second message is drafted', async () => {
    const net = fakeNet();
    const s = makeServices(agentConfig(net, {}), { db: t.db, now: () => NOW });
    const { userId } = await signedInUser(t);
    const full = await addPerson(t, userId, {
      name: 'Ann Full',
      email: 'ann@example.com',
      title: 'Engineer',
    });
    await addThread(t, userId, full, [
      { direction: 'out', at: ago(30 * DAY), body: 'one' },
      { direction: 'out', at: ago(20 * DAY), body: 'two' },
    ]);
    await addThread(t, userId, full, [{ direction: 'out', at: ago(12 * DAY), body: 'three on LinkedIn' }], {
      provider: 'linkedin',
    });
    await outreachChat(userId, full, 12);
    const room = await addPerson(t, userId, {
      name: 'Ben Room',
      email: 'ben@example.com',
      title: 'Engineer',
    });
    await addThread(t, userId, room, [
      { direction: 'out', at: ago(12 * DAY), body: 'Hi Ben, could we talk?' },
    ]);
    await outreachChat(userId, room, 12);
    const summary = await runCadence(s, userId);
    expect(summary.drafted).toBe(1);
    const drafts = await t.db.sql<{ person_id: string; kind: string; generated_by: string }>`
      select person_id, kind, generated_by from orbit.drafts where user_id = ${userId}::uuid`;
    expect(drafts).toEqual([{ person_id: room, kind: 'bump', generated_by: 'template' }]);
    // the next hour drafts nothing new
    const again = await runCadence(s, userId);
    expect(again.drafted).toBe(0);
  });

  it('§9.8 test 5: nurture writes at most three a week, each with its reason', async () => {
    const net = fakeNet();
    const s = makeServices(agentConfig(net, {}), { db: t.db, now: () => NOW });
    const { userId } = await signedInUser(t);
    for (let i = 0; i < 5; i++) {
      const p = await addPerson(t, userId, {
        name: `Close Friend${i}`,
        email: `friend${i}@example.com`,
        score: 85 + i,
        lastInteractionAt: ago(100 * DAY),
      });
      await t.db.sql`
        insert into orbit.dossiers (user_id, person_id, status, content, expires_at)
        values (${userId}::uuid, ${p}::uuid, 'ready',
                ${{ recently: [{ date: '2026-09-30', text: `Started a new role at Company${i}`, source_ids: ['S1'] }], openers: [] }}::jsonb,
                now() + interval '30 days')`;
    }
    const first = await runCadence(s, userId);
    expect(first.drafted).toBe(3);
    const drafts = await t.db.sql<{ kind: string; ask: { reason: string } }>`
      select kind, ask from orbit.drafts where user_id = ${userId}::uuid`;
    expect(drafts).toHaveLength(3);
    for (const d of drafts) {
      expect(d.kind).toBe('nurture');
      expect(d.ask.reason).toMatch(/^Started a new role at Company\d$/);
    }
    // an hour later, and the next day: still three this week
    const later = makeServices(agentConfig(net, {}), { db: t.db, now: () => new Date(NOW.getTime() + DAY) });
    expect((await runCadence(later, userId)).drafted).toBe(0);
    expect(await t.db.sql`select 1 from orbit.drafts where user_id = ${userId}::uuid`).toHaveLength(3);
  });

  it('plan 29 §B2.1: a bump of a kind in auto_kinds is approved for the window on its own at level 1, with the record; never at level 0, under a score of 40, or while paused', async () => {
    const net = fakeNet();
    const s = makeServices(agentConfig(net, {}), { db: t.db, now: () => NOW });
    const seed = async (settings: Record<string, unknown>, level: number, score = 70) => {
      const { userId } = await signedInUser(t, { settings });
      await t.db.sql`update orbit.users set autonomy_level = ${level}::smallint where id = ${userId}::uuid`;
      const p = await addPerson(t, userId, {
        name: `Lee Ladder${seq++}`,
        email: `lee${seq}@example.com`,
        score,
      });
      await addThread(t, userId, p, [
        { direction: 'out', at: ago(12 * DAY), body: 'Hi Lee, could we talk?' },
      ]);
      await outreachChat(userId, p, 12);
      return { userId, p };
    };
    const draftOf = async (userId: string) =>
      (
        await t.db.sql<{
          id: string;
          status: string;
          auto_rung: string | null;
          autonomy_level: number;
          send_at: Date | null;
        }>`select id, status, auto_rung, autonomy_level, send_at from orbit.drafts where user_id = ${userId}::uuid`
      )[0]!;

    const on = await seed({ auto_kinds: ['bump'] }, 1);
    expect(await runCadence(s, on.userId)).toMatchObject({ drafted: 1, approved: 1 });
    const d = await draftOf(on.userId);
    expect(d).toMatchObject({ status: 'approved', auto_rung: 'bump' });
    expect(Number(d.autonomy_level)).toBe(1);
    expect(new Date(d.send_at!).getTime()).toBeGreaterThan(NOW.getTime());
    const audit = await t.db.sql<{ action: string; actor: string; details: Record<string, unknown> }>`
      select action, actor, details from orbit.audit_log where target_id = ${d.id} and action = 'draft.auto_approve'`;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: 'agent',
      details: { standing: 'auto_kinds', rung: 'bump', level: 1 },
    });
    const jobs = await t.db.sql<{ message: { kind: string; payload: { draftId: string } } }>`
      select message from pgmq.q_orbit_send where message->>'userId' = ${on.userId}`;
    expect(jobs.map((j) => j.message)).toMatchObject([{ kind: 'send.draft', payload: { draftId: d.id } }]);

    const off = await seed({ auto_kinds: ['bump'] }, 0);
    expect(await runCadence(s, off.userId)).toMatchObject({ drafted: 1, approved: 0 });
    expect((await draftOf(off.userId)).status).toBe('draft');

    const notHanded = await seed({}, 1);
    expect(await runCadence(s, notHanded.userId)).toMatchObject({ drafted: 1, approved: 0 });

    const stranger = await seed({ auto_kinds: ['bump'] }, 1, 30);
    expect(await runCadence(s, stranger.userId)).toMatchObject({ drafted: 1, approved: 0 });

    const paused = await seed(
      { auto_kinds: ['bump'], autopilot_paused_until: new Date(NOW.getTime() + DAY).toISOString() },
      1,
    );
    expect(await runCadence(s, paused.userId)).toMatchObject({ drafted: 1, approved: 0 });
  });

  it('queues approved drafts whose time has come once, and does nothing while paused', async () => {
    const net = fakeNet();
    const s = makeServices(agentConfig(net, {}), { db: t.db, now: () => NOW });
    const { userId } = await signedInUser(t);
    const p = await addPerson(t, userId, { name: 'Sid Due', email: 'sid@example.com' });
    const [d] = await t.db.sql<{ id: string }>`
      insert into orbit.drafts (user_id, person_id, channel, kind, body, status, send_at, created_at)
      values (${userId}::uuid, ${p}::uuid, 'gmail', 'thank_you', 'Thanks', 'approved', ${ago(60_000)}::timestamptz,
              ${ago(DAY)}::timestamptz) returning id`;
    await t.db
      .sql`update orbit.users set settings = ${{ quiet_until: new Date(NOW.getTime() + DAY).toISOString() }}::jsonb where id = ${userId}::uuid`;
    expect(await runCadence(s, userId)).toMatchObject({ quiet: true, queued: 0 });
    await t.db.sql`update orbit.users set settings = '{}'::jsonb where id = ${userId}::uuid`;
    expect((await runCadence(s, userId)).queued).toBe(1);
    expect((await runCadence(s, userId)).queued).toBe(0);
    const q = await t.db.sql<{ message: { kind: string; dedupeKey: string } }>`
      select message from pgmq.q_orbit_send where message->>'userId' = ${userId}`;
    expect(q.map((m) => m.message)).toMatchObject([{ kind: 'send.draft', dedupeKey: `send:${d!.id}` }]);
  });

  it('runs from the queue as cadence.user, with templates when Claude is not configured', async () => {
    const net = fakeNet();
    const { userId } = await signedInUser(t);
    const p = await addPerson(t, userId, { name: 'Tom Queue', email: 'tom@example.com' });
    await addThread(t, userId, p, [
      { direction: 'out', at: new Date(Date.now() - 20 * DAY).toISOString(), body: 'Hi Tom' },
    ]);
    await outreachChat(userId, p, 0);
    await t.db
      .sql`update orbit.chats set data = ${{ lastOutboundAt: new Date(Date.now() - 20 * DAY).toISOString(), bumpCount: 0, outreachChannel: 'email' }}::jsonb
      where person_id = ${p}::uuid`;
    await t.db
      .sql`select orbit.enqueue('orbit_cadence', ${JSON.stringify({ kind: 'cadence.user', userId, payload: {}, dedupeKey: `cadence:${userId}:x` })}::jsonb, 0)`;
    const tick = await runTick({ db: t.db, handlers: defaultHandlers(agentConfig(net, {})) });
    expect(tick.failed).toBe(0);
    const runs = await t.db.sql<{
      status: string;
    }>`select status from orbit.job_runs where kind = 'cadence.user' and user_id = ${userId}::uuid`;
    expect(runs.map((r) => r.status)).toEqual(['ok']);
  });
});

describe('memory extraction (§10.6)', () => {
  it('runs on Haiku, keeps only memories quoting the user, and never extracts sensitive categories', async () => {
    const claude = anthropic(() => ({
      memories: [
        {
          kind: 'preference',
          text: 'Prefers morning calls',
          person_name: null,
          importance: 0.7,
          quote: 'I prefer morning calls',
        },
        {
          kind: 'outcome',
          text: 'Got the Stripe offer',
          person_name: null,
          importance: 0.9,
          quote: 'I got the offer from Stripe',
        },
        {
          kind: 'constraint',
          text: 'Has a cancer diagnosis',
          person_name: null,
          importance: 0.9,
          quote: 'my cancer diagnosis',
        },
      ],
    }));
    const net = fakeNet(claude.answer);
    const { userId } = await signedInUser(t);
    const c = makeClaude({ apiKey: 'sk-placeholder', fetch: net.fetch, db: t.db });
    const out = await extractMemories(c, userId, [
      {
        role: 'user',
        text: 'Honestly I prefer morning calls, and I am dealing with my cancer diagnosis right now.',
      },
      { role: 'assistant', text: 'Noted.' },
    ]);
    expect(out).toEqual([
      {
        kind: 'preference',
        text: 'Prefers morning calls',
        personName: null,
        importance: 0.7,
        quote: 'I prefer morning calls',
      },
    ]);
    expect(claude.requests[0]!.model).toBe(TASKS.memory_extract.model);
    expect(claude.requests[0]!.model).toBe('claude-haiku-5-5');
    expect(claude.requests[0]!.output_config.effort).toBe('low');
    expect(await extractMemories(makeClaude({}), userId, [{ role: 'user', text: 'hi' }])).toEqual([]);
  });

  it('routes every task to the §13.1 model and effort', () => {
    for (const k of ['compose', 'reply', 'dossier'] as const)
      expect(TASKS[k]).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' });
    for (const k of ['fit', 'reply_classify', 'memory_extract', 'goal_infer'] as const)
      expect(TASKS[k]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' });
  });
});

describe('MIME (§8.5)', () => {
  it('encodes non-ASCII headers and never lets a header break the message', () => {
    expect(headerValue('Café chat')).toMatch(/^=\?UTF-8\?B\?/);
    const raw = buildMime({
      from: 'sam@example.com',
      fromName: 'Sam',
      to: 'jane@example.com\r\nBcc: evil@example.com',
      subject: 'hello\r\nBcc: evil@example.com',
      body: 'Hi',
      draftId: 'd1',
      inReplyTo: 'abc@mail',
    });
    const headers = raw.split('\r\n\r\n')[0]!.split('\r\n');
    expect(headers.some((h) => h.startsWith('Bcc:'))).toBe(false);
    expect(raw).toContain('In-Reply-To: <abc@mail>');
    expect(raw).toContain('X-Orbit-Draft-Id: d1');
  });
});
