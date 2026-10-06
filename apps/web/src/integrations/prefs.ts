// Browser-local preferences that never leave the device and are never part of the data export:
// the Anthropic API key, the Google OAuth client id, which features may call Claude, the daily
// Claude budget and today's usage.
//
// They live in their own IndexedDB database (`orbit-local`), separate from the `orbit` data
// database, so "Export everything" cannot include them. Reads are synchronous from an in-memory
// copy that `loadPrefs()` fills once at startup; writes update the copy at once and persist in
// the background (`flushPrefs()` waits for them). Older builds kept these values in localStorage
// under `orbit.prefs.v1`; `loadPrefs()` moves them into IndexedDB and deletes the localStorage key.
import Dexie, { type EntityTable } from 'dexie';

export const LEGACY_LOCALSTORAGE_KEY = 'orbit.prefs.v1';
const ROW_KEY = 'prefs';

/** Features that can call Claude. Each is opt-in, except drafting, which is on by default once a key is saved. */
export type LlmFeature = 'drafts' | 'emailTriage' | 'notes' | 'resume' | 'summaries';

export const DEFAULT_LLM_FEATURES: Record<LlmFeature, boolean> = {
  drafts: true,
  emailTriage: false,
  notes: false,
  resume: false,
  summaries: false,
};
export const DEFAULT_DAILY_REQUEST_CAP = 50;
export const DEFAULT_DAILY_TOKEN_CAP = 300_000;

export interface LlmUsage {
  /** local calendar day, YYYY-MM-DD */
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmErrorRecord {
  reason: string;
  message: string;
  at: string;
}

export interface LocalPrefs {
  anthropicApiKey?: string;
  googleClientId?: string;
  theme?: 'light' | 'dark' | 'system';
  llmFeatures?: Partial<Record<LlmFeature, boolean>>;
  llmDailyRequestCap?: number;
  llmDailyTokenCap?: number;
  llmUsage?: LlmUsage;
  lastLlmError?: LlmErrorRecord;
}

interface PrefsRow {
  key: string;
  value: LocalPrefs;
}

class LocalDB extends Dexie {
  prefs!: EntityTable<PrefsRow, 'key'>;
  constructor() {
    super('orbit-local');
    this.version(1).stores({ prefs: 'key' });
  }
}

let localDb: LocalDB | undefined;
function store(): LocalDB {
  localDb ??= new LocalDB();
  return localDb;
}

let cache: LocalPrefs = {};
let loaded: Promise<LocalPrefs> | undefined;
let pending: Promise<void> = Promise.resolve();

function readLegacy(): LocalPrefs | undefined {
  try {
    const raw = localStorage.getItem(LEGACY_LOCALSTORAGE_KEY);
    return raw ? (JSON.parse(raw) as LocalPrefs) : undefined;
  } catch {
    return undefined;
  }
}

function clearLegacy(): void {
  try {
    localStorage.removeItem(LEGACY_LOCALSTORAGE_KEY);
  } catch {}
}

function persist(): void {
  const snapshot = { ...cache };
  pending = pending
    .then(() => store().prefs.put({ key: ROW_KEY, value: snapshot }))
    .then(() => undefined)
    .catch(() => undefined);
}

/** Load prefs from IndexedDB into memory, migrating any legacy localStorage copy. Safe to call repeatedly. */
export function loadPrefs(): Promise<LocalPrefs> {
  loaded ??= (async () => {
    let stored: LocalPrefs = {};
    try {
      stored = (await store().prefs.get(ROW_KEY))?.value ?? {};
    } catch {
      // IndexedDB unavailable (some private modes): keep the in-memory copy only.
    }
    const legacy = readLegacy();
    // IndexedDB wins over the legacy copy; anything written in memory before the load wins over both.
    cache = { ...(legacy ?? {}), ...stored, ...cache };
    if (legacy) {
      persist();
      await pending;
      clearLegacy();
    }
    return { ...cache };
  })();
  return loaded;
}

/** Synchronous read of the in-memory copy. `loadPrefs()` runs once at startup before the app renders. */
export function readPrefs(): LocalPrefs {
  return { ...cache };
}

export function writePrefs(p: Partial<LocalPrefs>): LocalPrefs {
  const next: LocalPrefs = { ...cache, ...p };
  for (const k of Object.keys(next) as (keyof LocalPrefs)[]) if (next[k] === undefined) delete next[k];
  cache = next;
  persist();
  return { ...next };
}

/** Resolves when every write so far has reached IndexedDB. */
export function flushPrefs(): Promise<void> {
  return pending;
}

/** Remove every local pref (key, client id, AI settings) from memory, IndexedDB and legacy localStorage. */
export async function clearPrefs(): Promise<void> {
  cache = {};
  clearLegacy();
  await pending;
  try {
    await store().prefs.clear();
  } catch {}
}

/** Test hook: forget the in-memory copy so the next `loadPrefs()` reads storage again. */
export function resetPrefsMemoryForTests(): void {
  cache = {};
  loaded = undefined;
}

export function llmFeatures(p: LocalPrefs = cache): Record<LlmFeature, boolean> {
  return { ...DEFAULT_LLM_FEATURES, ...(p.llmFeatures ?? {}) };
}

/** Today's date on this device, YYYY-MM-DD. */
export function localDay(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function todaysLlmUsage(p: LocalPrefs = cache, now = new Date()): LlmUsage {
  const day = localDay(now);
  return p.llmUsage?.date === day ? p.llmUsage : { date: day, requests: 0, inputTokens: 0, outputTokens: 0 };
}

export function envGoogleClientId(): string | undefined {
  return (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || undefined;
}
