/**
 * The dependencies research, sourcing and path gathering take, as small structural interfaces. Each is bound at
 * merge time to the real `_shared` modules (claude.ts, db.ts, budget.ts); tests pass in-memory fakes.
 */
import type { z } from '../providers/zod';

/** Milliseconds since the epoch. */
export type Clock = () => number;

/** Model routing is by task (§13.1): `dossier` → Opus 5.5 medium, `sourcing_fit` → Haiku 5.5 low. */
export type ClaudeTask = 'dossier' | 'sourcing_fit';

export interface ClaudePrompt {
  /** the stable, versioned instruction block (cached by the helper) */
  system: string;
  /** the per-call data, after the cache breakpoint */
  user: string;
}

export type ClaudeParseResult<T> =
  | { ok: true; value: T; costUsd: number; model?: string }
  | {
      ok: false;
      reason: 'refusal' | 'budget_exceeded' | 'max_tokens' | 'error';
      message?: string;
      costUsd?: number;
    };

/**
 * Structured output through `_shared/claude.ts` (`messages.parse` with the Zod schema). The helper enforces the
 * per-user Claude caps and records its own usage in `usage_ledger`; callers only add `costUsd` to their own caps.
 */
export interface ClaudeDep {
  parse<S extends z.ZodType>(
    task: ClaudeTask,
    schema: S,
    prompt: ClaudePrompt,
  ): Promise<ClaudeParseResult<z.output<S>>>;
}

/** Provider names as the per-user caps know them (§13.5). */
export type BudgetProvider =
  | 'claude'
  | 'exa'
  | 'village'
  | 'apollo'
  | 'apollo_match'
  | 'unipile_profile'
  | 'unipile_search';

export type BudgetVerdict = { ok: true } | { ok: false; reason: 'budget_exceeded'; resetsAt?: string };

/**
 * Per-user caps from `usage_ledger` (`_shared/budget.ts`). `estimate` is in the cap's own unit: USD for claude and
 * exa, credits for village and apollo_match, views for unipile_profile, searches for unipile_search.
 */
export interface BudgetDep {
  check(userId: string, provider: BudgetProvider, estimate: number): Promise<BudgetVerdict>;
  record(
    userId: string,
    entry: { provider: BudgetProvider; operation: string; units: number; costUsd: number },
  ): Promise<void>;
}

/** `orbit.research_cache` (primary key user_id + key). `get` returns only unexpired rows. */
export interface CacheDep {
  get(userId: string, key: string): Promise<unknown | undefined>;
  put(
    userId: string,
    entry: { key: string; provider: string; response: unknown; expiresAt: Date },
  ): Promise<void>;
}

export interface InternalMessage {
  at: string;
  direction: 'inbound' | 'outbound';
  subject?: string;
  /** quotes already stripped */
  body: string;
}

export interface InternalHistory {
  /** the last 20 messages with the person, newest last */
  messages: InternalMessage[];
  notes: { at: string; text: string }[];
  facts: { type: string; text: string }[];
  events: { at: string; title: string }[];
  firstContact?: string | null;
  lastContact?: string | null;
}

export type DossierStatus = 'pending' | 'ready' | 'partial' | 'needs_disambiguation' | 'failed';

/** An `orbit.dossiers` row (snake_case, as stored). `prompt_version` belongs inside `content` metadata if no column. */
export interface DossierRow {
  user_id: string;
  person_id: string;
  goal_id: string | null;
  status: DossierStatus;
  content: unknown | null;
  sources: unknown[];
  candidates: unknown[] | null;
  cost_usd: number;
  model: string | null;
  prompt_version: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

/** Reads and writes research needs: internal history, the dossier row, and the research cache (get/put). */
export interface ResearchDb extends CacheDep {
  internalHistory(userId: string, personId: string): Promise<InternalHistory>;
  getDossier(userId: string, personId: string): Promise<DossierRow | null>;
  putDossier(row: DossierRow): Promise<void>;
}
