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

/**
 * Pause the shared access after it refused: until the next UTC midnight for a daily limit, an hour when the server
 * is not set up, and for a long while once this student has used their whole allowance ($20 until it is raised;
 * clearing the pause in Settings, or raising the cap, brings it back).
 */
export function pauseSharedClaude(
  reason: 'day' | 'global' | 'unconfigured' | 'budget',
  now = new Date(),
): void {
  const until = new Date(now);
  if (reason === 'unconfigured') until.setTime(now.getTime() + 60 * 60_000);
  else if (reason === 'budget') until.setTime(now.getTime() + 30 * 24 * 3600_000);
  else {
    until.setUTCHours(0, 0, 0, 0);
    until.setUTCDate(until.getUTCDate() + 1);
  }
  writePrefs({ sharedClaudePause: { until: until.toISOString(), reason } });
}

const CLIENT_KEY = 'orbit.sharedClient';

/**
 * This browser's id for Orbit's shared access: random, made once and kept in localStorage, so the server can hold
 * each student to their own allowance instead of sharing one with everyone behind the same campus network.
 */
export function sharedClientId(): string {
  try {
    const kept = localStorage.getItem(CLIENT_KEY);
    if (kept && /^[A-Za-z0-9_-]{16,64}$/.test(kept)) return kept;
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(CLIENT_KEY, id);
    return id;
  } catch {
    return 'no-storage-available-0';
  }
}
