import { llmFeatures, readPrefs, writePrefs } from './prefs';

/**
 * Orbit's shared Claude access: a small server function (see supabase/functions/orbit-claude) that holds an
 * Anthropic key and forwards the chat's requests, with per-visitor limits. Visitors with their own key never use it.
 * The URL is set at build time; without it the chat falls back to commands as before. It is off in automated
 * browsers, so end-to-end runs never spend from it.
 */

let override: string | null | undefined;

/** Test hook: a proxy URL to use, null for none, or undefined to restore the build-time setting. */
export function setSharedClaudeUrlForTests(url: string | null | undefined): void {
  override = url;
}

export function sharedClaudeUrl(): string | undefined {
  if (override !== undefined) return override ?? undefined;
  if (typeof navigator !== 'undefined' && navigator.webdriver) return undefined;
  const url = (import.meta.env.VITE_ORBIT_CLAUDE_PROXY as string | undefined)?.trim();
  return url ? url.replace(/\/+$/, '') : undefined;
}

/** The active pause, or undefined once it has passed. */
export function sharedClaudePause(now = new Date()): { until: string; reason: string } | undefined {
  const p = readPrefs().sharedClaudePause;
  return p && new Date(p.until).getTime() > now.getTime() ? p : undefined;
}

/** The chat may use the shared access: no own key, configured, chat on, and not paused. */
export function sharedClaudeAvailable(now = new Date()): boolean {
  const p = readPrefs();
  return !p.anthropicApiKey && !!sharedClaudeUrl() && llmFeatures(p).chat && !sharedClaudePause(now);
}

/** Pause the shared access after it refused: until the next UTC midnight for a daily limit, an hour otherwise. */
export function pauseSharedClaude(reason: 'day' | 'global' | 'unconfigured', now = new Date()): void {
  const until = new Date(now);
  if (reason === 'unconfigured') until.setTime(now.getTime() + 60 * 60_000);
  else {
    until.setUTCHours(0, 0, 0, 0);
    until.setUTCDate(until.getUTCDate() + 1);
  }
  writePrefs({ sharedClaudePause: { until: until.toISOString(), reason } });
}
