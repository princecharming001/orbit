/**
 * What Claude costs, shared by the server tasks (claude.ts) and the chat's proxy (orbit-claude), so both count the
 * same dollars against a user's cap. Kept free of imports so the proxy stays small.
 */

/** Dollars per million tokens: input, output, cache read, cache write (5-minute). */
export const PRICES: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** Claude's web search, per search, on top of the tokens its results add ($10 a thousand). costUsd prices tokens
 * only; a caller that lets Claude search adds this per search itself (research/web.ts, the chat's proxy). */
export const WEB_SEARCH_USD = 0.01;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  /** server tools the answer used (web searches are billed per search) */
  server_tool_use?: { web_search_requests?: number | null } | null;
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
