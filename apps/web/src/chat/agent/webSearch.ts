/**
 * Claude's own web search (a server tool: Anthropic runs it and bills each search, $10 a thousand, on top of tokens):
 * for what Orbit's data cannot answer, such as a company's news, a recruiting timeline or someone's public role. A few
 * searches a request at most; the proxy allows exactly this tool and counts the searches in the user's cap. Kept free
 * of the SDK's code (types only) so the thread can read its results without loading the chat client.
 */
import type Anthropic from '@anthropic-ai/sdk';

/**
 * Searches a request may run. The prompt asks for one to three focused searches a turn; two a request (plan 34 C2)
 * keeps a single request from spending the whole turn's share on one query rerun.
 */
export const WEB_SEARCH_MAX_USES = 2;
/** Searches a whole turn should run; past it the tool results tell the model to answer from what it found. */
export const WEB_SEARCH_TURN_BUDGET = 3;
export const WEB_SEARCH_TOOL: Anthropic.Beta.BetaWebSearchTool20260209 = {
  type: 'web_search_20260209',
  name: 'web_search',
  max_uses: WEB_SEARCH_MAX_USES,
};

/** A web search's sources as the thread shows them: the title and the address of each result. */
export function webSources(content: unknown): { title: string; url: string }[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (r): r is { type: string; url: string; title?: string } =>
        !!r && r.type === 'web_search_result' && typeof r.url === 'string' && /^https?:\/\//.test(r.url),
    )
    .map((r) => ({ title: (r.title ?? '').trim() || r.url, url: r.url }));
}
