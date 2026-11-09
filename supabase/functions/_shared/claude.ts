/**
 * The one way Orbit's server tasks call Claude (§13.1): the model per task from one table, the stable system
 * prompt marked for caching, structured output through `messages.parse` with a Zod schema, `stop_reason` handled
 * (`refusal` → the caller's fallback path; `max_tokens` → one retry with twice the room, only when the cut answer
 * did not parse and the task is not a cheap one in NO_RETRY_TASKS; the retry is its own `<task>:retry` ledger row),
 * usage written to orbit.usage_ledger, the per-user caps of budget.ts checked first, and Anthropic's kill switch
 * (switches.ts) honoured. With no key it answers
 * `{unconfigured: true}` and makes no call. The chat agent itself stays on the browser/orbit-claude path.
 *
 * Each ledger row keeps the token split it was priced from (plan 35 A5). Work nobody waits on can go through
 * Message Batches at half price instead (`structuredBatch`, plan 35 C2): the request waits in
 * orbit.claude_batch_requests, the claude.batch.poll job submits the waiting ones together and reads the answers, and
 * `resolveBatch` gives the job that asked the same result `structured` would have, recorded as `<task>:batch` at half
 * price. A batch that cannot answer (its 24 hours ran out, an error, batching turned off) falls back to a synchronous
 * call, as does an answer that came back cut or unreadable.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod/v4';
import { checkBudget, recordUsage } from './budget.ts';
import type { Db } from './db.ts';
import { BATCH_DISCOUNT, costUsd, type Usage } from './prices.ts';

export type Task =
  | 'compose'
  | 'reply'
  | 'dossier'
  | 'reply_classify'
  | 'memory_extract'
  | 'goal_infer'
  | 'fit'
  | 'triage'
  | 'judge'
  /** deep research: does each claim of a brief say what its cited page says (docs/plan/20 §4) */
  | 'support'
  /** deep research's investigator loop: is a page about them, what it says they did, what to search next */
  | 'research_extract'
  /** deep research: the brief, written from the facts the loop extracted */
  | 'research_brief'
  /** plan 29 §B2.4: the student's edits read into notes on how they write */
  | 'voice_distill'
  /** plan 29 §B2.4c: was an auto first message written by the same person as their sent mail */
  | 'voice_judge'
  /** plan 33: LinkedIn About sections and company pages read into stated stage, size, focus and signals */
  | 'reading'
  /** plan 27: how warm a reply reads toward the student, when the reply classifier did not read it in its own call */
  | 'rapport'
  /** plan 31: the web pages sourcing reads for the people they name (was logged as `fit`) */
  | 'sourcing_read'
  /** earlier names of reply_classify, memory_extract and goal_infer, kept for callers that still use them */
  | 'classify'
  | 'extract_memory'
  | 'extract_goal';

export type Effort = 'low' | 'medium' | 'high';

export interface TaskSetting {
  model: string;
  /** undefined leaves the model's default */
  effort?: Effort;
  maxTokens: number;
  /**
   * Send `string | null` fields as plain strings ("" for none). Structured outputs compile each nullable into a
   * branch of the grammar, and a schema as large as the research brief's goes over the grammar limit with them
   * (400 "The compiled grammar is too large"). The Zod schema still accepts the strings; the caller turns blanks back
   * into nulls.
   */
  flatNullable?: boolean;
}

/** §13.1. Claude Opus 5.5 and Haiku 5.5 think adaptively on their own; effort is the only dial. */
export const TASKS: Record<Task, TaskSetting> = {
  compose: { model: 'claude-opus-5-5', effort: 'medium', maxTokens: 4000 },
  reply: { model: 'claude-opus-5-5', effort: 'medium', maxTokens: 4000 },
  dossier: { model: 'claude-opus-5-5', effort: 'medium', maxTokens: 8000, flatNullable: true },
  reply_classify: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 1000 },
  memory_extract: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 1500 },
  goal_infer: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 1500 },
  fit: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 3000 },
  triage: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 1000 },
  reading: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 3000 },
  rapport: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 1000 },
  sourcing_read: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 3000 },
  classify: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 1000 },
  extract_memory: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 1500 },
  extract_goal: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 1500 },
  judge: { model: 'claude-sonnet-5-5', maxTokens: 2000 },
  // the drafting model reads the edits, once a night per student with new ones
  voice_distill: { model: 'claude-opus-5-5', effort: 'low', maxTokens: 2000 },
  // the judge's model, for the few first messages autopilot would send on its own
  voice_judge: { model: 'claude-sonnet-5-5', maxTokens: 600 },
  // high effort: against the writing model as the reference it agreed on 14 of 16 claims (low effort: 8 of 16), for $0.003
  support: { model: 'claude-haiku-5-5', effort: 'high', maxTokens: 4000 },
  research_extract: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 2000 },
  // the brief reads compact facts, not raw pages: the mid model writes it for about a tenth of the writing model's price
  research_brief: { model: 'claude-sonnet-5-5', maxTokens: 8000, flatNullable: true },
};

export { BATCH_DISCOUNT, costUsd, PRICES, type Usage } from './prices.ts';

/**
 * Tasks that are cheap to leave `max_tokens`: a cut answer is dropped instead of paid for twice (plan 34 A6). The
 * work they do is redone on a later pass anyway.
 */
export const NO_RETRY_TASKS: ReadonlySet<Task> = new Set<Task>([
  'classify',
  'reply_classify',
  'fit',
  'reading',
  'rapport',
  'sourcing_read',
]);

/** The ledger's token columns from a response's usage (plan 35 A5). */
export function tokensOf(u: Usage): { input: number; cacheRead: number; cacheWrite: number; output: number } {
  return {
    input: u.input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  };
}

/** Whether ORBIT_CLAUDE_BATCH leaves batching on: anything but off, false, 0 or no (unset is on). */
export function batchFlagOn(v: string | undefined | null): boolean {
  return !/^(off|false|0|no)$/i.test((v ?? '').trim());
}

export type ClaudeResult<T> =
  | { ok: true; data: T; model: string; costUsd: number; usage: Usage }
  | { ok: false; unconfigured: true }
  | { ok: false; budgetExceeded: true; cap: string; resetsAt: string }
  | { ok: false; refused: true; category: string | null }
  | { ok: false; error: 'max_tokens' | 'invalid_output' | 'api_error'; detail?: string };

export interface ClaudeDeps {
  /** ORBIT_ANTHROPIC_API_KEY; without it every call answers unconfigured */
  apiKey?: string;
  db?: Db;
  fetch?: typeof fetch;
  now?: () => Date;
  /** a prepared client (tests); otherwise one is made from apiKey */
  client?: Anthropic;
  /** Anthropic's kill switch (switches.ts): false answers budget_exceeded with cap 'provider_off' and makes no call */
  enabled?: () => Promise<boolean>;
  /**
   * Message Batches for the work that waits anyway (ORBIT_CLAUDE_BATCH, on unless turned off; plan 35 C2). Off,
   * `structuredBatch` answers `{queued: false, reason: 'off'}` and the caller calls synchronously.
   */
  batch?: boolean;
}

/** What the job that asked for a batched answer needs to run on it later (batchJobs.ts). */
export interface BatchJob {
  /** the continuation that runs on the answer */
  handler: string;
  payload: Record<string, unknown>;
  /** at most one waiting request per key; a second answers `duplicate` */
  dedupeKey?: string;
  /** the person the answer is about */
  personId?: string | null;
}

export type BatchQueued =
  | { queued: true; id: string }
  | { queued: false; reason: 'off' | 'unconfigured' | 'duplicate' | 'budget' | 'provider_off' };

/** One waiting request as stored. */
export type BatchRow = {
  id: string;
  user_id: string | null;
  person_id: string | null;
  task: Task;
  model: string;
  request: { system: string; user: string; maxTokens?: number };
  params: Record<string, unknown>;
  handler: string;
  payload: Record<string, unknown>;
  status: string;
  batch_id: string | null;
  created_at: Date | string;
  expires_at: Date | string | null;
};

/** How a batch answered one request: the message, or why it could not (each falls back to a synchronous call). */
export type BatchOutcome =
  | { ok: true; message: Anthropic.Message }
  | { ok: false; reason: 'expired' | 'errored' | 'canceled' | 'off' | 'lost'; detail?: string };

/** A batch's answers are kept for 29 days, and a batch ends within 24 hours of being made. */
export const BATCH_WINDOW_MS = 24 * 3600 * 1000;
/** Requests one poll submits together at most (the API takes 100,000; a tick has a time budget). */
export const BATCH_SUBMIT_MAX = 200;

export interface StructuredRequest<S extends z.ZodType> {
  task: Task;
  /** stable instructions; cached */
  system: string;
  /** the per-call data, after the cache breakpoint */
  user: string;
  schema: S;
  /** whose budget pays; null for system work */
  userId: string | null;
  maxTokens?: number;
  /** give up on the call after this long (a deadline-bound caller, such as a 90-second research brief) */
  timeoutMs?: number;
}

type Safe<T> = { ok: true; value: T } | { ok: false; error: string };

export function makeClaude(deps: ClaudeDeps) {
  const client = deps.apiKey
    ? (deps.client ?? new Anthropic({ apiKey: deps.apiKey, fetch: deps.fetch, maxRetries: 2 }))
    : undefined;
  const now = deps.now ?? (() => new Date());

  async function structured<S extends z.ZodType>(
    req: StructuredRequest<S>,
  ): Promise<ClaudeResult<z.infer<S>>> {
    if (!client) return { ok: false, unconfigured: true };
    if (deps.enabled && !(await deps.enabled().catch(() => true)))
      return { ok: false, budgetExceeded: true, cap: 'provider_off', resetsAt: '9999-12-31T00:00:00.000Z' };
    const setting = TASKS[req.task];
    if (deps.db && req.userId) {
      const verdict = await checkBudget(
        deps.db,
        req.userId,
        { provider: 'anthropic', operation: req.task },
        now(),
      );
      if (!verdict.ok)
        return { ok: false, budgetExceeded: true, cap: verdict.cap, resetsAt: verdict.resetsAt };
    }
    // parse never throws on the model's text: a truncated or invalid answer comes back as an error value, so
    // stop_reason and usage are still read and recorded
    const base = formatOf(req.schema, setting);
    const format = {
      ...base,
      parse: (content: string): Safe<z.infer<S>> => {
        try {
          return { ok: true, value: base.parse(content) as z.infer<S> };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    };
    let maxTokens = req.maxTokens ?? setting.maxTokens;
    for (let attempt = 0; attempt < 2; attempt++) {
      let msg: Awaited<ReturnType<typeof callParse>>;
      try {
        msg = await callParse(maxTokens);
      } catch (e) {
        return {
          ok: false,
          error: 'api_error',
          detail: e instanceof Error ? e.message.slice(0, 200) : undefined,
        };
      }
      const usage = msg.usage as Usage;
      const cost = costUsd(setting.model, usage);
      if (deps.db)
        await recordUsage(deps.db, {
          userId: req.userId,
          provider: 'anthropic',
          operation: attempt === 0 ? req.task : `${req.task}:retry`,
          units: usage.input_tokens + usage.output_tokens,
          costUsd: cost,
          tokens: tokensOf(usage),
        });
      if (msg.stop_reason === 'refusal') {
        const details = (msg as { stop_details?: { category?: string | null } | null }).stop_details;
        return { ok: false, refused: true, category: details?.category ?? null };
      }
      const parsed = msg.parsed_output as Safe<z.infer<S>> | null;
      if (msg.stop_reason === 'max_tokens') {
        // a cut answer that still parses is kept; a cheap task is not paid for twice
        if (parsed?.ok) return { ok: true, data: parsed.value, model: setting.model, costUsd: cost, usage };
        if (attempt === 0 && !NO_RETRY_TASKS.has(req.task)) {
          maxTokens *= 2;
          continue;
        }
        return { ok: false, error: 'max_tokens' };
      }
      if (!parsed?.ok) return { ok: false, error: 'invalid_output', detail: parsed?.error?.slice(0, 200) };
      return { ok: true, data: parsed.value, model: setting.model, costUsd: cost, usage };
    }
    return { ok: false, error: 'max_tokens' };

    function callParse(max: number) {
      return client!.messages.parse(
        {
          model: setting.model,
          max_tokens: max,
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: req.user }],
          output_config: { ...(setting.effort ? { effort: setting.effort } : {}), format },
        },
        // a caller with a deadline gets one attempt within it, never a retry that runs past it
        req.timeoutMs ? { timeout: req.timeoutMs, maxRetries: 0 } : undefined,
      );
    }
  }

  /**
   * The same request through Message Batches (plan 35 C2): checked against the switch and the caps now, stored to
   * be submitted by the next claude.batch.poll, and answered later to the job named in `job`. Anything but
   * `{queued: true}` (or `duplicate`, a request already waiting under the key) means: call `structured` now.
   */
  async function structuredBatch<S extends z.ZodType>(
    req: StructuredRequest<S>,
    job: BatchJob,
  ): Promise<BatchQueued> {
    if (!client) return { queued: false, reason: 'unconfigured' };
    if (!deps.batch || !deps.db) return { queued: false, reason: 'off' };
    if (deps.enabled && !(await deps.enabled().catch(() => true)))
      return { queued: false, reason: 'provider_off' };
    const setting = TASKS[req.task];
    if (req.userId) {
      const verdict = await checkBudget(
        deps.db,
        req.userId,
        { provider: 'anthropic', operation: req.task },
        now(),
      );
      if (!verdict.ok) return { queued: false, reason: 'budget' };
    }
    const base = formatOf(req.schema, setting);
    const maxTokens = req.maxTokens ?? setting.maxTokens;
    const params = {
      model: setting.model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: req.user }],
      output_config: {
        ...(setting.effort ? { effort: setting.effort } : {}),
        format: { type: base.type, schema: base.schema },
      },
    };
    const request = {
      system: req.system,
      user: req.user,
      ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
    };
    const rows = await deps.db.sql<{ id: string }>`
      insert into orbit.claude_batch_requests (user_id, person_id, task, model, request, params, handler, payload,
                                               dedupe_key, created_at)
      values (${req.userId}::uuid, ${job.personId ?? null}::uuid, ${req.task}, ${setting.model}, ${request}::jsonb,
              ${params}::jsonb, ${job.handler}, ${job.payload}::jsonb, ${job.dedupeKey ?? null}, ${now()}::timestamptz)
      on conflict (dedupe_key) where dedupe_key is not null and status in ('queued', 'submitted') do nothing
      returning id::text as id`;
    return rows[0] ? { queued: true, id: rows[0].id } : { queued: false, reason: 'duplicate' };
  }

  /** Records a batch answer in the ledger as `<task>:batch` at half price; returns what it cost. */
  async function recordBatch(
    row: Pick<BatchRow, 'task' | 'user_id'>,
    msg: Anthropic.Message,
  ): Promise<number> {
    const usage = msg.usage as Usage;
    const cost = costUsd(TASKS[row.task].model, usage) * BATCH_DISCOUNT;
    if (deps.db)
      await recordUsage(deps.db, {
        userId: row.user_id,
        provider: 'anthropic',
        operation: `${row.task}:batch`,
        units: usage.input_tokens + usage.output_tokens,
        costUsd: cost,
        tokens: tokensOf(usage),
      });
    return cost;
  }

  /**
   * What a batched request's job gets: the answer as `structured` would have given it, recorded as `<task>:batch` at
   * half price; or, when the batch could not answer or the answer came back cut or unreadable, a synchronous call
   * with the same request (its own ledger row). A refusal is a refusal either way.
   */
  async function resolveBatch<S extends z.ZodType>(
    row: Pick<BatchRow, 'task' | 'user_id' | 'request'>,
    outcome: BatchOutcome,
    schema: S,
  ): Promise<ClaudeResult<z.infer<S>>> {
    const sync = () =>
      structured({
        task: row.task,
        system: row.request.system,
        user: row.request.user,
        schema,
        userId: row.user_id,
        maxTokens: row.request.maxTokens,
      });
    if (!outcome.ok) return sync();
    const setting = TASKS[row.task];
    const msg = outcome.message;
    const usage = msg.usage as Usage;
    const cost = await recordBatch(row, msg);
    if (msg.stop_reason === 'refusal') {
      const details = (msg as { stop_details?: { category?: string | null } | null }).stop_details;
      return { ok: false, refused: true, category: details?.category ?? null };
    }
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    try {
      const value = formatOf(schema, setting).parse(text) as z.infer<S>;
      return { ok: true, data: value, model: setting.model, costUsd: cost, usage };
    } catch {
      // cut at max_tokens or not the schema: the synchronous path (with its one larger retry) answers instead
      return sync();
    }
  }

  /**
   * claude.batch.poll's two steps. `submit` sends every queued request as one batch (when batching is off, nothing is
   * submitted and `collect` hands the queued ones back as `off`, so their jobs call synchronously). `collect` reads
   * the batches that ended and hands back each request with its outcome; a request whose batch is past its 24 hours
   * and still not readable, or was never submitted within them, comes back `expired`.
   */
  const batches = {
    async submit(limit = BATCH_SUBMIT_MAX): Promise<{ submitted: number; error?: string }> {
      if (!client || !deps.db || !deps.batch) return { submitted: 0 };
      if (deps.enabled && !(await deps.enabled().catch(() => true))) return { submitted: 0 };
      const db = deps.db;
      const queued = await db.sql<{ id: string; params: Record<string, unknown> }>`
        select id::text as id, params from orbit.claude_batch_requests
         where status = 'queued' order by created_at limit ${limit}::int`;
      if (!queued.length) return { submitted: 0 };
      let made: Anthropic.Messages.MessageBatch;
      try {
        made = await client.messages.batches.create({
          requests: queued.map((r) => ({
            custom_id: r.id,
            params: r.params as unknown as Anthropic.MessageCreateParamsNonStreaming,
          })),
        });
      } catch (e) {
        const error = e instanceof Error ? e.message.slice(0, 200) : 'error';
        await db.sql`
          update orbit.claude_batch_requests set error = ${error}
           where id = any(${queued.map((r) => r.id)}::uuid[])`;
        return { submitted: 0, error };
      }
      await db.sql`
        update orbit.claude_batch_requests
           set status = 'submitted', batch_id = ${made.id}, submitted_at = ${now()}::timestamptz,
               expires_at = ${made.expires_at}::timestamptz, error = null
         where id = any(${queued.map((r) => r.id)}::uuid[]) and status = 'queued'`;
      return { submitted: queued.length };
    },

    async collect(): Promise<{ row: BatchRow; outcome: BatchOutcome }[]> {
      if (!deps.db) return [];
      const db = deps.db;
      const out: { row: BatchRow; outcome: BatchOutcome }[] = [];
      const t = now().getTime();
      const rows = await db.sql<BatchRow>`
        select id::text as id, user_id::text as user_id, person_id::text as person_id, task, model, request, params,
               handler, payload, status, batch_id, created_at, expires_at
          from orbit.claude_batch_requests where status in ('queued', 'submitted') order by created_at`;
      for (const r of rows.filter((x) => x.status === 'queued')) {
        // off (or no key): the job runs synchronously now; never submitted within the window: the same
        if (!client || !deps.batch) out.push({ row: r, outcome: { ok: false, reason: 'off' } });
        else if (t - new Date(r.created_at).getTime() > BATCH_WINDOW_MS)
          out.push({ row: r, outcome: { ok: false, reason: 'expired', detail: 'never submitted' } });
      }
      const byBatch = new Map<string, BatchRow[]>();
      for (const r of rows)
        if (r.status === 'submitted' && r.batch_id)
          byBatch.set(r.batch_id, [...(byBatch.get(r.batch_id) ?? []), r]);
      for (const [batchId, part] of byBatch) {
        const late = part.every(
          (r) =>
            t >
            new Date(r.expires_at ?? r.created_at).getTime() + (r.expires_at ? 3600_000 : BATCH_WINDOW_MS),
        );
        const lost = (detail: string) => {
          for (const r of part) out.push({ row: r, outcome: { ok: false, reason: 'lost', detail } });
        };
        if (!client) {
          if (late) lost('no key');
          continue;
        }
        let batch: Anthropic.Messages.MessageBatch;
        try {
          batch = await client.messages.batches.retrieve(batchId);
        } catch (e) {
          // the batch cannot be read; past its window its requests run synchronously, before it they wait
          if (late) lost(e instanceof Error ? e.message.slice(0, 200) : 'retrieve failed');
          continue;
        }
        if (batch.processing_status !== 'ended') {
          if (late) {
            await client.messages.batches.cancel(batchId).catch(() => undefined);
            for (const r of part) out.push({ row: r, outcome: { ok: false, reason: 'expired' } });
          }
          continue;
        }
        const ids = new Map(part.map((r) => [r.id, r]));
        try {
          for await (const line of await client.messages.batches.results(batchId)) {
            const r = ids.get(line.custom_id);
            if (!r) continue;
            ids.delete(line.custom_id);
            const res = line.result;
            out.push({
              row: r,
              outcome:
                res.type === 'succeeded'
                  ? { ok: true, message: res.message }
                  : res.type === 'errored'
                    ? { ok: false, reason: 'errored', detail: res.error?.error?.message?.slice(0, 200) }
                    : { ok: false, reason: res.type },
            });
          }
        } catch (e) {
          if (!late) continue;
          lost(e instanceof Error ? e.message.slice(0, 200) : 'results failed');
          continue;
        }
        // ended without a line for them: nothing will come
        for (const r of ids.values())
          out.push({ row: r, outcome: { ok: false, reason: 'lost', detail: 'no result' } });
      }
      return out;
    },

    /** Records a batch answer its job did not need (it skipped): it was paid for all the same. */
    async record(row: Pick<BatchRow, 'task' | 'user_id'>, outcome: BatchOutcome): Promise<void> {
      if (outcome.ok) await recordBatch(row, outcome.message);
    },

    /** Marks a request finished: done when its job ran on a batch answer, expired when it ran synchronously. */
    async finish(id: string, status: 'done' | 'expired' | 'failed', error?: string): Promise<void> {
      if (!deps.db) return;
      await deps.db.sql`
        update orbit.claude_batch_requests set status = ${status}, finished_at = ${now()}::timestamptz,
               error = ${error ?? null}
         where id = ${id}::uuid`;
    },
  };

  return {
    configured: !!client,
    batching: !!client && !!deps.batch && !!deps.db,
    structured,
    structuredBatch,
    resolveBatch,
    batches,
  };
}

/** The structured-output format for a schema, with `string | null` flattened for the tasks that need it. */
function formatOf<S extends z.ZodType>(schema: S, setting: TaskSetting) {
  const zf = zodOutputFormat(schema);
  return setting.flatNullable ? { ...zf, schema: flattenNullable(zf.schema) as typeof zf.schema } : zf;
}

type FullClaude = ReturnType<typeof makeClaude>;
/**
 * The helper as its callers hold it. The batch members are optional so a stand-in (tests) can be the two plain
 * members; without them a caller calls synchronously.
 */
export type Claude = Pick<FullClaude, 'configured' | 'structured'> &
  Partial<Pick<FullClaude, 'batching' | 'structuredBatch' | 'resolveBatch' | 'batches'>>;

/** `anyOf: [{type: X}, {type: "null"}]` → `{type: X}`, everywhere in a JSON schema (see TaskSetting.flatNullable). */
export function flattenNullable(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(flattenNullable);
  if (!schema || typeof schema !== 'object') return schema;
  const o = schema as Record<string, unknown>;
  const any = o.anyOf;
  if (Array.isArray(any) && any.length === 2) {
    const rest = any.filter(
      (x) => !(x && typeof x === 'object' && (x as { type?: unknown }).type === 'null'),
    );
    if (rest.length === 1) {
      const { anyOf: _a, ...others } = o;
      return flattenNullable({ ...others, ...(rest[0] as object) });
    }
  }
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, flattenNullable(v)]));
}
