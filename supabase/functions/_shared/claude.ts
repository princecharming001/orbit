/**
 * The one way Orbit's server tasks call Claude (§13.1): the model per task from one table, the stable system
 * prompt marked for caching, structured output through `messages.parse` with a Zod schema, `stop_reason` handled
 * (`refusal` → the caller's fallback path; `max_tokens` → one retry with twice the room), usage written to
 * orbit.usage_ledger, and the per-user caps of budget.ts checked first. With no key it answers
 * `{unconfigured: true}` and makes no call. The chat agent itself stays on the browser/orbit-claude path.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod/v4';
import { checkBudget, recordUsage } from './budget.ts';
import type { Db } from './db.ts';

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
}

/** §13.1. Claude Opus 5.5 and Haiku 5.5 think adaptively on their own; effort is the only dial. */
export const TASKS: Record<Task, TaskSetting> = {
  compose: { model: 'claude-opus-5-5', effort: 'medium', maxTokens: 4000 },
  reply: { model: 'claude-opus-5-5', effort: 'medium', maxTokens: 4000 },
  dossier: { model: 'claude-opus-5-5', effort: 'medium', maxTokens: 8000 },
  reply_classify: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 1000 },
  memory_extract: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 1500 },
  goal_infer: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 1500 },
  fit: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 3000 },
  triage: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 1000 },
  classify: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 1000 },
  extract_memory: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 1500 },
  extract_goal: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 1500 },
  judge: { model: 'claude-sonnet-5-5', maxTokens: 2000 },
};

/** Dollars per million tokens: input, output, cache read, cache write (5-minute). */
export const PRICES: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function costUsd(model: string, u: Usage): number {
  const p = PRICES[model];
  if (!p) return 0;
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
    1_000_000
  );
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
}

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
    const base = zodOutputFormat(req.schema);
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
          operation: req.task,
          units: usage.input_tokens + usage.output_tokens,
          costUsd: cost,
        });
      if (msg.stop_reason === 'refusal') {
        const details = (msg as { stop_details?: { category?: string | null } | null }).stop_details;
        return { ok: false, refused: true, category: details?.category ?? null };
      }
      if (msg.stop_reason === 'max_tokens') {
        if (attempt === 0) {
          maxTokens *= 2;
          continue;
        }
        return { ok: false, error: 'max_tokens' };
      }
      const parsed = msg.parsed_output as Safe<z.infer<S>> | null;
      if (!parsed?.ok) return { ok: false, error: 'invalid_output', detail: parsed?.error?.slice(0, 200) };
      return { ok: true, data: parsed.value, model: setting.model, costUsd: cost, usage };
    }
    return { ok: false, error: 'max_tokens' };

    function callParse(max: number) {
      return client!.messages.parse({
        model: setting.model,
        max_tokens: max,
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: req.user }],
        output_config: { ...(setting.effort ? { effort: setting.effort } : {}), format },
      });
    }
  }

  return { configured: !!client, structured };
}

export type Claude = ReturnType<typeof makeClaude>;
