/**
 * Plan 35 (cost reduction), the server half: the token split in the ledger (A5), Message Batches at half price with
 * the synchronous fallback when a batch expires (C2), the rapport read folded into the reply classifier (A4), and
 * emails looked up on demand through the cheaper finders and verified only before a send (C3, E6). Every provider is
 * a fake; nothing here reaches a real API.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { type Continuation, pollClaudeBatches } from '../../functions/_shared/batchJobs.ts';
import { costUsd, makeClaude } from '../../functions/_shared/claude.ts';
import { BATCH_DISCOUNT } from '../../functions/_shared/prices.ts';
import { makeServices } from '../../functions/_shared/services.ts';
import { defaultHandlers } from '../../functions/orbit-worker/worker.ts';
import {
  ALL_KEYS,
  type AnthropicRequest,
  addPerson,
  agentConfig,
  anthropic,
  api,
  fakeNet,
  jsonRes,
  type NetCall,
  signedInUser,
  systemText,
  userText,
} from '../helpers/agents.ts';
import { recordingFetch } from '../helpers/google.ts';
import { clearQueues, connectedUser, drain } from '../helpers/ingest.ts';
import { ago, NOW } from '../helpers/mailFixtures.ts';
import { freshDb, makeUser, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

const Schema = z.object({ kind: z.enum(['interested', 'decline']), confidence: z.number() });
const USAGE = {
  input_tokens: 1000,
  output_tokens: 100,
  cache_read_input_tokens: 2000,
  cache_creation_input_tokens: 500,
};
const message = (data: unknown = { kind: 'interested', confidence: 0.9 }) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: [{ type: 'text', text: JSON.stringify(data) }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  stop_details: null,
  usage: USAGE,
});
const request = {
  task: 'classify' as const,
  system: 'Classify the reply.',
  user: 'Sounds great!',
  schema: Schema,
};

const BATCHES = 'https://api.anthropic.com/v1/messages/batches';
const MESSAGES = 'https://api.anthropic.com/v1/messages';

/**
 * Anthropic with Message Batches: create answers in_progress, retrieve answers `status()` for the batch, results
 * answer each submitted request with `result(customId)` as JSONL, and /v1/messages answers synchronously.
 */
function batchApi(opts: {
  status: () => 'in_progress' | 'ended';
  result?: (customId: string) => unknown;
  expiresAt?: string;
}) {
  let submitted: string[] = [];
  return recordingFetch((c) => {
    const batch = (status: string) => ({
      id: 'msgbatch_1',
      type: 'message_batch',
      processing_status: status,
      request_counts: { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      created_at: '2026-11-09T00:00:00Z',
      expires_at: opts.expiresAt ?? '2026-11-10T00:00:00Z',
      ended_at: status === 'ended' ? '2026-11-09T01:00:00Z' : null,
      archived_at: null,
      cancel_initiated_at: null,
      results_url: status === 'ended' ? `${BATCHES}/msgbatch_1/results` : null,
    });
    if (c.url === BATCHES && c.method === 'POST') {
      submitted = (JSON.parse(c.body) as { requests: { custom_id: string }[] }).requests.map(
        (r) => r.custom_id,
      );
      return jsonRes(200, batch('in_progress'));
    }
    if (c.url === `${BATCHES}/msgbatch_1/results`)
      return new Response(
        submitted
          .map((id) =>
            JSON.stringify({
              custom_id: id,
              result: opts.result?.(id) ?? { type: 'succeeded', message: message() },
            }),
          )
          .join('\n'),
        { status: 200, headers: { 'content-type': 'application/binary' } },
      );
    if (c.url === `${BATCHES}/msgbatch_1/cancel`) return jsonRes(200, batch('canceling'));
    if (c.url === `${BATCHES}/msgbatch_1`) return jsonRes(200, batch(opts.status()));
    if (c.url === MESSAGES) return jsonRes(200, message());
    return jsonRes(404, { type: 'error', error: { type: 'not_found_error', message: c.url } });
  });
}

const ledger = (userId: string) =>
  t.db.sql<{
    operation: string;
    cost_usd: string;
    input_tokens: string | null;
    cache_read_tokens: string | null;
    cache_write_tokens: string | null;
    output_tokens: string | null;
  }>`
    select operation, cost_usd::text, input_tokens::text, cache_read_tokens::text, cache_write_tokens::text,
           output_tokens::text
      from orbit.usage_ledger where user_id = ${userId}::uuid order by id`;

describe('A5: the token split in the ledger', () => {
  it('a Claude call keeps its input, cache read, cache write and output tokens on its ledger row', async () => {
    const u = await makeUser(t.db);
    const net = recordingFetch(() => jsonRes(200, message()));
    const c = makeClaude({ apiKey: 'sk-placeholder', fetch: net.fetch, db: t.db });
    expect((await c.structured({ ...request, userId: u })).ok).toBe(true);
    expect(await ledger(u)).toEqual([
      expect.objectContaining({
        operation: 'classify',
        input_tokens: '1000',
        cache_read_tokens: '2000',
        cache_write_tokens: '500',
        output_tokens: '100',
      }),
    ]);
  });
});

describe('C2: Message Batches', () => {
  // the batch table is shared by every user: each case starts with it empty
  beforeEach(async () => {
    await t.db.sql`delete from orbit.claude_batch_requests`;
  });

  it('queues, submits in one batch, and records the answer as <task>:batch at half the synchronous price', async () => {
    const u = await makeUser(t.db);
    const net = batchApi({ status: () => 'ended' });
    const c = makeClaude({ apiKey: 'sk-placeholder', fetch: net.fetch, db: t.db, batch: true });
    const q = await c.structuredBatch(
      { ...request, userId: u },
      { handler: 'test', payload: {}, dedupeKey: `k:${u}` },
    );
    expect(q).toMatchObject({ queued: true });
    // one waiting request per key
    expect(
      await c.structuredBatch(
        { ...request, userId: u },
        { handler: 'test', payload: {}, dedupeKey: `k:${u}` },
      ),
    ).toEqual({ queued: false, reason: 'duplicate' });
    expect(await c.batches.submit()).toEqual({ submitted: 1 });
    const create = JSON.parse(net.calls.find((x) => x.url === BATCHES)!.body);
    expect(create.requests).toHaveLength(1);
    expect(create.requests[0].params.output_config.format.type).toBe('json_schema');
    const out = await c.batches.collect();
    expect(out).toHaveLength(1);
    expect(out[0]!.outcome.ok).toBe(true);
    const r = await c.resolveBatch(out[0]!.row, out[0]!.outcome, Schema);
    expect(r).toMatchObject({ ok: true, data: { kind: 'interested' } });
    const rows = await ledger(u);
    expect(rows.map((x) => x.operation)).toEqual(['classify:batch']);
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(costUsd('claude-haiku-5-5', USAGE) * BATCH_DISCOUNT, 5);
    expect(BATCH_DISCOUNT).toBe(0.5);
    expect(rows[0]!.output_tokens).toBe('100');
    // nothing went synchronously
    expect(net.calls.filter((x) => x.url === MESSAGES)).toHaveLength(0);
  });

  it('a batch past its 24 hours is canceled and its request answered synchronously, at the full price', async () => {
    const u = await makeUser(t.db);
    let at = new Date('2026-11-09T00:00:00Z');
    const net = batchApi({ status: () => 'in_progress', expiresAt: '2026-11-10T00:00:00Z' });
    const c = makeClaude({
      apiKey: 'sk-placeholder',
      fetch: net.fetch,
      db: t.db,
      batch: true,
      now: () => at,
    });
    await c.structuredBatch({ ...request, userId: u }, { handler: 'test', payload: {} });
    await c.batches.submit();
    // still running, inside the window: nothing to answer yet
    at = new Date('2026-11-09T12:00:00Z');
    expect(await c.batches.collect()).toHaveLength(0);
    // past expires_at and the hour of grace: expired, canceled, the synchronous call answers
    at = new Date('2026-11-10T01:30:00Z');
    const out = await c.batches.collect();
    expect(out.map((x) => x.outcome)).toEqual([{ ok: false, reason: 'expired' }]);
    expect(net.calls.some((x) => x.url === `${BATCHES}/msgbatch_1/cancel`)).toBe(true);
    const r = await c.resolveBatch(out[0]!.row, out[0]!.outcome, Schema);
    expect(r).toMatchObject({ ok: true, data: { kind: 'interested' } });
    expect(net.calls.filter((x) => x.url === MESSAGES)).toHaveLength(1);
    expect((await ledger(u)).map((x) => x.operation)).toEqual(['classify']);
  });

  it('claude.batch.poll runs each continuation on its answer and marks the request done, or expired on fallback', async () => {
    const u = await makeUser(t.db);
    const net = batchApi({
      status: () => 'ended',
      result: () => ({
        type: 'errored',
        error: { type: 'error', error: { type: 'api_error', message: 'x' } },
      }),
    });
    const s = makeServices(
      { env: { anthropicKey: 'sk-placeholder', claudeBatch: 'on' }, fetch: net.fetch },
      { db: t.db, now: () => new Date('2026-11-09T00:00:00Z') },
    );
    expect(s.claude.batching).toBe(true);
    await s.claude.structuredBatch!({ ...request, userId: u }, { handler: 'test.echo', payload: { n: 1 } });
    const seen: unknown[] = [];
    const continuations: Record<string, Continuation> = {
      'test.echo': async (_s, row, answer) => {
        const r = await answer(Schema);
        seen.push({ payload: row.payload, ok: r.ok });
        return 'ok';
      },
    };
    // the first poll only submits; the second reads the errored answer and falls back to a synchronous call
    expect(await pollClaudeBatches(s, { continuations })).toMatchObject({ submitted: 1, collected: 0 });
    expect(await pollClaudeBatches(s, { continuations })).toMatchObject({
      collected: 1,
      expired: 1,
      done: 0,
    });
    expect(seen).toEqual([{ payload: { n: 1 }, ok: true }]);
    const [row] = await t.db.sql<{ status: string; error: string | null }>`
      select status, error from orbit.claude_batch_requests where user_id = ${u}::uuid`;
    expect(row!.status).toBe('expired');
    expect(row!.error).toContain('errored');
    expect((await ledger(u)).map((x) => x.operation)).toEqual(['classify']);
  });

  it('the worker has the claude.batch.poll job, and the cron queues it only while a request waits', async () => {
    expect(typeof defaultHandlers({ env: {} })['claude.batch.poll']).toBe('function');
    const [none] = await t.db.sql<{
      id: string | null;
    }>`select orbit.enqueue_claude_batch_poll()::text as id`;
    expect(none!.id).toBeNull();
    const u = await makeUser(t.db);
    await t.db.sql`
      insert into orbit.claude_batch_requests (user_id, task, model, request, params, handler)
      values (${u}::uuid, 'classify', 'claude-haiku-5-5', '{}', '{}', 'test')`;
    const [one] = await t.db.sql<{ id: string | null }>`select orbit.enqueue_claude_batch_poll()::text as id`;
    expect(one!.id).not.toBeNull();
  });

  it('ORBIT_CLAUDE_BATCH: on unless turned off, and off for a config built by hand', async () => {
    const off = makeServices({ env: { anthropicKey: 'k' } }, { db: t.db });
    expect(off.claude.batching).toBe(false);
    const on = makeServices({ env: { anthropicKey: 'k', claudeBatch: 'on' } }, { db: t.db });
    expect(on.claude.batching).toBe(true);
    const turnedOff = makeServices({ env: { anthropicKey: 'k', claudeBatch: 'off' } }, { db: t.db });
    expect(turnedOff.claude.batching).toBe(false);
    const { agentEnvFrom } = await import('../../functions/_shared/services.ts');
    expect(agentEnvFrom(() => undefined).claudeBatch).toBe('on');
  });

  it('a batched compose goes through the same checks: an answer that fails them is asked again synchronously', async () => {
    const { userId } = await signedInUser(t);
    const person = await addPerson(t, userId, {
      name: 'Jane Doe',
      email: 'jane@northwind.example',
      title: 'PM',
    });
    const BODY = {
      subject: 'Quick question',
      body: 'Hi Jane,\n\nI am a student at Berkeley and I would love to hear how you got into product at Northwind. Would you have 15 minutes next week?\n\nBest,\nSam',
      ask: { kind: 'call', text: '15 minutes next week' },
      hooks: [],
    };
    const net = batchApi({
      status: () => 'ended',
      result: () => ({ type: 'succeeded', message: { ...message(BODY), model: 'claude-opus-5-5' } }),
    });
    const s = makeServices(
      {
        ...agentConfig(fakeNet()),
        env: { anthropicKey: 'sk-placeholder', claudeBatch: 'on' },
        fetch: net.fetch,
      },
      { db: t.db, now: () => new Date('2026-11-09T15:00:00Z') },
    );
    const { composeDraftBatched } = await import('../../functions/_shared/compose/compose.ts');
    const r = await composeDraftBatched(
      s,
      { userId, personId: person, kind: 'first_touch', channel: 'gmail', actor: 'agent' },
      { handler: 'test.compose', dedupeKey: `test:${person}` },
    );
    expect(r).toEqual({ batched: true });
    const { composeFromBatch } = await import('../../functions/_shared/compose/compose.ts');
    const continuations: Record<string, Continuation> = {
      'test.compose': async (s2, row, answer) => {
        const p = row.payload as { req: never; frozen: never };
        const { composeSchema } = await import('../../functions/_shared/compose/prompts.ts');
        return (await composeFromBatch(s2, p.req, p.frozen, await answer(composeSchema))).draft.id;
      },
    };
    await pollClaudeBatches(s, { continuations });
    expect(await pollClaudeBatches(s, { continuations })).toMatchObject({ done: 1 });
    const drafts = await t.db.sql<{ body: string; status: string }>`
      select body, status from orbit.drafts where user_id = ${userId}::uuid and person_id = ${person}::uuid`;
    // the batch's answer (44 words, no hook) fails the first-message checks; the one retry is synchronous, and its
    // answer (not a message at all) leaves the template to stand in, exactly as a synchronous compose would
    expect(drafts).toHaveLength(1);
    const [d] = await t.db.sql<{ generated_by: string; validator: { issues: string[] } }>`
      select generated_by, validator from orbit.drafts where user_id = ${userId}::uuid and person_id = ${person}::uuid`;
    expect(d!.generated_by).toBe('template');
    expect((await ledger(userId)).map((x) => x.operation)).toEqual(['compose:batch', 'compose']);
    const retry = JSON.parse(net.calls.find((x) => x.url === MESSAGES)!.body);
    expect(JSON.stringify(retry.messages)).toContain('hook_missing');
  });
});

describe('A4: rapport folded into the reply classifier', () => {
  const AMBIGUOUS =
    'Let me think about it and loop back once I have talked with the team about how this could work.';

  async function world(body: string) {
    await clearQueues(t);
    const u = await connectedUser(t.db);
    const [p] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, first_name, name_norm, primary_email)
      values (${u}::uuid, 'Rae Moon', 'Rae', 'rae moon', 'rae@moon.co') returning id`;
    const [th] = await t.db.sql<{ id: string }>`
      insert into orbit.threads (user_id, provider, external_id, is_networking, participant_person_ids, participant_count)
      values (${u}::uuid, 'gmail', ${`T-${Math.random()}`}, true, ${[p!.id]}::uuid[], 1) returning id`;
    await t.db.sql`
      insert into orbit.messages (user_id, thread_id, provider, external_id, direction, to_person_ids, sent_at, body_text)
      values (${u}::uuid, ${th!.id}::uuid, 'gmail', ${`g-${Math.random()}`}, 'out', ${[p!.id]}::uuid[],
              ${ago(4)}::timestamptz, 'Hi Rae, could I ask about your time at Stripe?')`;
    const [m] = await t.db.sql<{ id: string }>`
      insert into orbit.messages (user_id, thread_id, provider, external_id, direction, from_person_id, sent_at, body_text)
      values (${u}::uuid, ${th!.id}::uuid, 'gmail', ${`g-${Math.random()}`}, 'in', ${p!.id}::uuid,
              ${ago(3)}::timestamptz, ${body}) returning id`;
    await t.db
      .sql`select orbit.enqueue('orbit_classify', ${{ kind: 'classify.message', userId: u, payload: { messageId: m!.id } }}::jsonb, 0)`;
    return { u, messageId: m!.id };
  }

  const haiku = () =>
    recordingFetch((c) => {
      const body = JSON.parse(c.body) as { system: { text: string }[] };
      const sys = body.system.map((x) => x.text).join('\n');
      const rapport = { warmth: 1, familiarity: 'professional', effort: 1, cues: [] };
      const cls = {
        class: 'not_now',
        confidence: 0.8,
        proposed_times: [],
        return_date: null,
        referred_people: [],
        question: null,
      };
      return jsonRes(
        200,
        message(
          sys.includes('Also fill "rapport"')
            ? { ...cls, rapport }
            : sys.includes('how the sender feels')
              ? rapport
              : cls,
        ),
      );
    });

  it('a reply the classifier sends to Haiku gets its rapport in the same call: one call, one classify row', async () => {
    const { u, messageId } = await world(AMBIGUOUS);
    const net = haiku();
    const claude = makeClaude({ apiKey: 'sk-placeholder', fetch: net.fetch, db: t.db });
    await drain(t, defaultHandlers({ claude }), () => new Date(NOW));
    expect(net.calls).toHaveLength(1);
    expect((await ledger(u)).map((x) => x.operation)).toEqual(['classify']);
    const [m] = await t.db.sql<{ cls: string; rapport: { by: string } }>`
      select reply_class as cls, extraction -> 'rapport' as rapport from orbit.messages where id = ${messageId}::uuid`;
    expect(m!.cls).toBe('not_now');
    expect(m!.rapport.by).toBe('llm');
  });

  it('a reply too short to read for tone never reaches Haiku for rapport', async () => {
    const { u, messageId } = await world('Thanks so much!');
    const net = haiku();
    const claude = makeClaude({ apiKey: 'sk-placeholder', fetch: net.fetch, db: t.db });
    await drain(t, defaultHandlers({ claude }), () => new Date(NOW));
    expect(net.calls.filter((c) => c.body.includes('how the sender feels'))).toHaveLength(0);
    expect((await ledger(u)).map((x) => x.operation)).not.toContain('rapport');
    const [m] = await t.db.sql<{ rapport: { by: string } }>`
      select extraction -> 'rapport' as rapport from orbit.messages where id = ${messageId}::uuid`;
    expect(m!.rapport.by).toBe('lexical');
  });
});

// ---- C3 and E6: emails on demand --------------------------------------------------------------------------------

const FACULTY = 'https://bioeng.berkeley.edu/faculty';
const FACULTY_TEXT = [
  'Faculty. Department of Bioengineering, University of California, Berkeley.',
  'Raj Patel, Associate Professor. Research: biomedical imaging, optical microscopy for surgery.',
  'Maria Lopez, Department Manager.',
  'Footer. Apply now. Courses. Events.',
].join('\n');
const FACULTY_HTML = `<html><head><title>Faculty | Bioengineering at Berkeley</title></head><body>
<h1>Faculty</h1><ul><li>Raj Patel, Associate Professor</li><li>Maria Lopez, Department Manager</li></ul>
<p>${'Research across the department. '.repeat(20)}</p></body></html>`;
const ENROW = 'https://api.enrow.io';
const REOON = 'https://emailverifier.reoon.com/api/v1/verify';
const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/** Enrow finds rpatel@berkeley.edu (valid), Hunter answers anything, Reoon answers per address. */
function emailProviders(verdicts: Record<string, string> = {}) {
  return (c: NetCall) => {
    if (c.url === `${ENROW}/email/find/single` && c.method === 'POST') return jsonRes(200, { id: 'enr_1' });
    if (c.url.startsWith(`${ENROW}/email/find/single?id=`))
      return jsonRes(200, { email: 'rpatel@berkeley.edu', qualification: 'valid', credits_used: 1 });
    if (c.url.startsWith('https://api.hunter.io/'))
      return jsonRes(200, { data: { email: 'hunter@berkeley.edu', score: 90, sources: [] } });
    if (c.url.startsWith(REOON)) {
      const email = new URL(c.url).searchParams.get('email') ?? '';
      return jsonRes(200, { email, status: verdicts[email] ?? 'unknown' });
    }
    if (c.url === GMAIL_SEND) return jsonRes(200, { id: 'gm-1', threadId: 'gt-1' });
    if (c.url === FACULTY)
      return new Response(FACULTY_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    if (c.url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/threads/'))
      return jsonRes(200, { messages: [] });
    return undefined;
  };
}

function facultyClaude() {
  return anthropic((r: AnthropicRequest) => {
    if (systemText(r).includes('list the people it names'))
      return userText(r).includes(FACULTY)
        ? {
            people: [
              {
                name: 'Raj Patel',
                title: 'Associate Professor',
                department: 'Bioengineering',
                email: null,
                works_on: ['biomedical imaging'],
                lab_url: null,
                note: null,
              },
            ],
          }
        : { people: [] };
    const block = userText(r).split('<candidates>')[1]?.split('</candidates>')[0] ?? '';
    const cands = block
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l) as { id: string });
    return { scores: cands.map((c) => ({ id: c.id, fit: 0.8, reasons: ['On the department page'] })) };
  });
}

const facultyWeb = () => ({
  name: 'exa' as const,
  estimateUsd: () => 0.02,
  async gather(
    plan: { queries: { query: string }[] },
    ctx: { select: (h: { url: string; title: string; query: string }[]) => string[] },
  ) {
    const hits = plan.queries.map((q) => ({
      url: FACULTY,
      title: 'Faculty | Bioengineering',
      query: q.query,
    }));
    const want = ctx.select(hits);
    return {
      hits,
      pages: want.includes(FACULTY)
        ? [{ url: FACULTY, title: 'Faculty | Bioengineering at Berkeley', text: FACULTY_TEXT }]
        : [],
      costUsd: 0.02,
      notes: [],
      steps: [],
    };
  },
});

describe('C3 and E6: emails on demand', () => {
  it('a search looks up nobody; Add looks the person up through Enrow (its key is set) instead of Hunter', async () => {
    const claude = facultyClaude();
    const net = fakeNet(claude.answer, emailProviders());
    const env = {
      ...ALL_KEYS,
      exaKey: undefined,
      apolloKey: undefined,
      unipileKey: undefined,
      semanticScholarKey: undefined,
      hunterKey: 'hunter-placeholder',
      enrowKey: 'enrow-placeholder',
    };
    const call = api(t, net, { env, agent: { ...agentConfig(net, env), web: [facultyWeb() as never] } });
    const { userId, token } = await signedInUser(t, { firstName: 'Ana' });
    const r = await call<{ results: { id: string; name: string; email?: string; emailStatus?: string }[] }>(
      '/source/search',
      token,
      {
        purpose: 'collaboration',
        query: 'professors I can reach out to for biomed research',
        filters: { schools: ['UC Berkeley'], keywords: ['biomedical research'] },
      },
    );
    expect(r.status).toBe(200);
    const raj = r.body.results.find((c) => c.name === 'Raj Patel')!;
    expect(raj.email).toBeUndefined();
    expect(raj.emailStatus).toBe('not looked up');
    const paid = () => net.calls.filter((c) => /api\.(hunter|enrow)\.io/.test(c.url));
    expect(paid()).toHaveLength(0);

    const added = await call<{ people: { id: string }[] }>('/source/add', token, {
      recommendationIds: [raj.id],
    });
    expect(added.status).toBe(200);
    expect(paid().some((c) => c.url.startsWith(ENROW))).toBe(true);
    expect(paid().some((c) => c.url.includes('hunter'))).toBe(false);
    const enrowAsk = net.calls.find((c) => c.url === `${ENROW}/email/find/single`)!;
    expect(enrowAsk.headers['x-api-key']).toBe('enrow-placeholder');
    expect(enrowAsk.body).toMatchObject({ fullname: 'raj patel', company_domain: 'berkeley.edu' });
    const [p] = await t.db.sql<{ primary_email: string; email_confidence: string }>`
      select primary_email, email_confidence from orbit.people where id = ${added.body.people[0]!.id}::uuid`;
    expect(p).toEqual({ primary_email: 'rpatel@berkeley.edu', email_confidence: 'verified' });
    const spend = await t.db.sql<{ provider: string; operation: string; units: string; cost_usd: string }>`
      select provider, operation, units::text, cost_usd::text from orbit.usage_ledger
       where user_id = ${userId}::uuid and provider = 'enrow'`;
    expect(spend).toEqual([{ provider: 'enrow', operation: 'find', units: '1', cost_usd: '0.01700' }]);
  });

  it('POST /source/email looks one person up on demand and keeps the address', async () => {
    const net = fakeNet(emailProviders());
    const call = api(t, net, { env: { enrowKey: 'enrow-placeholder' } });
    const { userId, token } = await signedInUser(t);
    const raj = await addPerson(t, userId, { name: 'Raj Patel', org: 'UC Berkeley' });
    // the student's own contact at the same school tells Orbit the domain
    await addPerson(t, userId, { name: 'Lee Chan', org: 'UC Berkeley', email: 'lchan@berkeley.edu' });
    const r = await call<{ email?: string; emailConfidence?: string; emailStatus: string }>(
      '/source/email',
      token,
      {
        personId: raj,
      },
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      email: 'rpatel@berkeley.edu',
      emailConfidence: 'verified',
      emailStatus: 'found',
    });
    const [p] = await t.db.sql<{
      primary_email: string;
    }>`select primary_email from orbit.people where id = ${raj}::uuid`;
    expect(p!.primary_email).toBe('rpatel@berkeley.edu');
    // asked again: the address it has, no second lookup
    const asks = net.calls.filter((c) => c.url === `${ENROW}/email/find/single`).length;
    expect(
      (await call<{ emailStatus: string }>('/source/email', token, { personId: raj })).body.emailStatus,
    ).toBe('found');
    expect(net.calls.filter((c) => c.url === `${ENROW}/email/find/single`).length).toBe(asks);
    expect((await call('/source/email', token, {})).status).toBe(400);
  });

  it('asking to email someone with no address looks it up before the draft is written', async () => {
    const net = fakeNet(emailProviders());
    const call = api(t, net, { env: { enrowKey: 'enrow-placeholder' } });
    const { userId, token } = await signedInUser(t);
    const raj = await addPerson(t, userId, { name: 'Raj Patel', org: 'UC Berkeley', title: 'Professor' });
    await addPerson(t, userId, { name: 'Lee Chan', org: 'UC Berkeley', email: 'lchan@berkeley.edu' });
    const c = await call('/drafts/compose', token, { personId: raj, kind: 'first_touch', channel: 'gmail' });
    expect(c.status).toBe(200);
    // Enrow, or the shared cache of an earlier lookup of the same person (a person is looked up once for everyone)
    const [p] = await t.db.sql<{
      primary_email: string;
    }>`select primary_email from orbit.people where id = ${raj}::uuid`;
    expect(p!.primary_email).toBe('rpatel@berkeley.edu');
  });

  it('a built address is verified with Reoon before the send: invalid holds the message, safe sends and marks it', async () => {
    const net = fakeNet(
      emailProviders({ 'jdoe@northwind.example': 'invalid', 'ann@northwind.example': 'safe' }),
    );
    const call = api(t, net, { env: { reoonKey: 'reoon-placeholder' } });
    const { token, userId } = await signedInUser(t);
    const send = async (name: string, email: string) => {
      const person = await addPerson(t, userId, { name, email, title: 'Engineer' });
      await t.db.sql`update orbit.people set email_confidence = 'pattern' where id = ${person}::uuid`;
      const c = await call<{ draft: { id: string } }>('/drafts/compose', token, {
        personId: person,
        kind: 'first_touch',
        channel: 'gmail',
      });
      await call('/drafts/approve', token, { draftId: c.body.draft.id, sendAt: new Date().toISOString() });
      const [d] = await t.db.sql<{ status: string; error: string | null }>`
        select status, error from orbit.drafts where id = ${c.body.draft.id}::uuid`;
      const [p] = await t.db.sql<{ email_confidence: string; email_checked_at: Date | null }>`
        select email_confidence, email_checked_at from orbit.people where id = ${person}::uuid`;
      return { d: d!, p: p! };
    };
    const bad = await send('John Doe', 'jdoe@northwind.example');
    expect(bad.d).toEqual({ status: 'draft', error: 'email_invalid' });
    expect(bad.p.email_confidence).toBe('invalid');
    expect(net.calls.filter((c) => c.url === GMAIL_SEND)).toHaveLength(0);
    const reoonCall = net.calls.find((c) => c.url.startsWith(REOON))!;
    expect(new URL(reoonCall.url).searchParams.get('mode')).toBe('power');

    const good = await send('Ann Lee', 'ann@northwind.example');
    expect(good.d.status).toBe('sent');
    expect(good.p.email_confidence).toBe('verified');
    expect(good.p.email_checked_at).toBeTruthy();
    expect(net.calls.filter((c) => c.url === GMAIL_SEND)).toHaveLength(1);
    // an address from the student's own mail is never checked
    const before = net.calls.filter((c) => c.url.startsWith(REOON)).length;
    const own = await addPerson(t, userId, {
      name: 'Kim Park',
      email: 'kim@northwind.example',
      title: 'Engineer',
    });
    const c = await call<{ draft: { id: string } }>('/drafts/compose', token, {
      personId: own,
      kind: 'first_touch',
      channel: 'gmail',
    });
    await call('/drafts/approve', token, { draftId: c.body.draft.id, sendAt: new Date().toISOString() });
    expect(net.calls.filter((x) => x.url.startsWith(REOON)).length).toBe(before);
  });
});
