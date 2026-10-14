/**
 * In-memory stand-ins for the function dependencies (fetch, research cache, dossier store, budget ledger, Claude)
 * used by the research, sourcing and path tests. Upstream calls are recorded so tests can assert "no call".
 */
import type {
  BudgetDep,
  BudgetProvider,
  CacheDep,
  ClaudeDep,
  ClaudeParseResult,
  ClaudePrompt,
  ClaudeTask,
  DossierRow,
  InternalHistory,
  ResearchDb,
} from '../../../../../supabase/functions/_shared/research/deps';

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Route = (call: Call) => Response | Promise<Response> | undefined;

/** A fetch that answers from routes in order and records every call; an unmatched call is a 599. */
export function fakeFetch(...routes: Route[]) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    for (const r of routes) {
      const res = await r(call);
      if (res) return res;
    }
    return new Response(JSON.stringify({ error: `no route for ${url}` }), { status: 599 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const instant = async () => {};

/** A clock tests move by hand. */
export function manualClock(start = Date.parse('2026-10-14T12:00:00Z')) {
  let t = start;
  const clock = () => t;
  return {
    clock,
    advance(ms: number) {
      t += ms;
    },
  };
}

export const DAY = 86_400_000;

/** `orbit.research_cache` in memory; only unexpired rows come back. */
export function memoryCache(
  clock: () => number,
): CacheDep & { rows: Map<string, { provider: string; response: unknown; expiresAt: Date }> } {
  const rows = new Map<string, { provider: string; response: unknown; expiresAt: Date }>();
  return {
    rows,
    async get(userId, key) {
      const r = rows.get(`${userId}:${key}`);
      if (!r || r.expiresAt.getTime() <= clock()) return undefined;
      return structuredClone(r.response);
    },
    async put(userId, e) {
      rows.set(`${userId}:${e.key}`, {
        provider: e.provider,
        response: structuredClone(e.response),
        expiresAt: e.expiresAt,
      });
    },
  };
}

export function memoryResearchDb(
  clock: () => number,
  history: InternalHistory = { messages: [], notes: [], facts: [], events: [] },
): ResearchDb & { dossiers: Map<string, DossierRow>; cache: ReturnType<typeof memoryCache> } {
  const cache = memoryCache(clock);
  const dossiers = new Map<string, DossierRow>();
  return {
    cache,
    dossiers,
    get: cache.get,
    put: cache.put,
    async internalHistory() {
      return history;
    },
    async getDossier(userId, personId) {
      return dossiers.get(`${userId}:${personId}`) ?? null;
    },
    async putDossier(row) {
      dossiers.set(`${row.user_id}:${row.person_id}`, structuredClone(row));
    },
  };
}

export interface LedgerRow {
  userId: string;
  provider: BudgetProvider;
  operation: string;
  units: number;
  costUsd: number;
}

/** A ledger with optional per-provider refusals. */
export function memoryBudget(deny: Partial<Record<BudgetProvider, boolean>> = {}) {
  const ledger: LedgerRow[] = [];
  const checks: { provider: BudgetProvider; estimate: number }[] = [];
  const budget: BudgetDep = {
    async check(_userId, provider, estimate) {
      checks.push({ provider, estimate });
      return deny[provider] ? { ok: false, reason: 'budget_exceeded' } : { ok: true };
    },
    async record(userId, e) {
      ledger.push({ userId, ...e });
    },
  };
  return { budget, ledger, checks, total: () => ledger.reduce((s, r) => s + r.costUsd, 0) };
}

/**
 * A Claude stand-in: `answer` builds the structured output from the prompt; the result is validated by the schema
 * exactly as `messages.parse` would, and the cost is recorded in the ledger like `_shared/claude.ts` does.
 */
export function fakeClaude(
  answer: (task: ClaudeTask, prompt: ClaudePrompt, n: number) => unknown,
  opts: { costUsd?: number; ledger?: LedgerRow[]; userId?: string } = {},
) {
  const calls: { task: ClaudeTask; prompt: ClaudePrompt }[] = [];
  const claude: ClaudeDep = {
    async parse(task, schema, prompt) {
      calls.push({ task, prompt });
      const raw = answer(task, prompt, calls.length);
      if (raw instanceof Error)
        return { ok: false, reason: 'error', message: raw.message } as ClaudeParseResult<never>;
      const parsed = schema.safeParse(raw);
      const costUsd = opts.costUsd ?? 0.1;
      opts.ledger?.push({
        userId: opts.userId ?? 'u1',
        provider: 'claude',
        operation: task,
        units: 1,
        costUsd,
      });
      if (!parsed.success) return { ok: false, reason: 'error', message: 'schema', costUsd };
      return { ok: true, value: parsed.data, costUsd, model: 'claude-opus-5-5' };
    },
  };
  return { claude, calls };
}
