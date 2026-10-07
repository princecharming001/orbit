// Browser-local preferences that never leave the device and are never part of the data export:
// the Anthropic API key, the Google OAuth client id, which features may call Claude, the daily
// Claude budget and today's usage.
//
// They live in their own IndexedDB database (`orbit-local`), separate from the `orbit` data
// database, so "Export everything" cannot include them. Reads are synchronous from an in-memory
// copy that `loadPrefs()` fills at startup. Every write is a change (a patch or a function of the
// current prefs) applied to that copy at once and, in the background, to the row freshly read inside
// an IndexedDB transaction, so a tab with an older copy never writes back fields it did not change
// (a key removed or a feature turned off in another tab stays removed) and usage counters add up
// across tabs. After each write the tab tells the others on a BroadcastChannel, and they re-read the
// row; Claude calls also re-read it first (`refreshPrefs()`). `flushPrefs()` waits for pending writes.
// Older builds kept these values in localStorage under `orbit.prefs.v1`; `loadPrefs()` moves them
// into IndexedDB and deletes the localStorage key.
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

type Mutation = (p: LocalPrefs) => LocalPrefs;

let cache: LocalPrefs = {};
let loaded: Promise<LocalPrefs> | undefined;
let pending: Promise<void> = Promise.resolve();
/** Changes applied to `cache` that have not reached IndexedDB yet, oldest first. */
let unsaved: Mutation[] = [];
const listeners = new Set<(p: LocalPrefs) => void>();

const CHANNEL_NAME = 'orbit-prefs';
let channel: BroadcastChannel | undefined;

function clean(p: LocalPrefs): LocalPrefs {
  const next = { ...p };
  for (const k of Object.keys(next) as (keyof LocalPrefs)[]) if (next[k] === undefined) delete next[k];
  return next;
}

function notify(): void {
  const snapshot = { ...cache };
  for (const l of listeners) l(snapshot);
}

/** The stored row with every not-yet-saved local change applied on top. */
function rebase(stored: LocalPrefs): void {
  cache = unsaved.reduce((acc, f) => clean(f(acc)), clean(stored));
}

function ensureChannel(): void {
  if (channel || typeof BroadcastChannel === 'undefined') return;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = () => {
      void refreshPrefs();
    };
    // Node (tests) keeps the process alive while a channel is open.
    (channel as unknown as { unref?: () => void }).unref?.();
  } catch {
    channel = undefined;
  }
}

function announce(): void {
  try {
    channel?.postMessage('changed');
  } catch {}
}

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

/** Apply `f` to the row as it is in IndexedDB now (not to this tab's copy) and save the result. */
function persist(f: Mutation): void {
  ensureChannel();
  unsaved.push(f);
  pending = pending.then(async () => {
    try {
      const db = store();
      const saved = await db.transaction('rw', db.prefs, async () => {
        const next = clean(f((await db.prefs.get(ROW_KEY))?.value ?? {}));
        await db.prefs.put({ key: ROW_KEY, value: next });
        return next;
      });
      unsaved.shift();
      rebase(saved);
      announce();
      notify();
    } catch {
      // IndexedDB unavailable (some private modes): the change lives in memory only.
      unsaved.shift();
    }
  });
}

/** Load prefs from IndexedDB into memory, migrating any legacy localStorage copy. Safe to call repeatedly. */
export function loadPrefs(): Promise<LocalPrefs> {
  ensureChannel();
  loaded ??= (async () => {
    const legacy = readLegacy();
    // IndexedDB wins over the legacy copy; anything written in this tab before the load wins over both.
    if (legacy) updatePrefs((stored) => ({ ...legacy, ...stored }));
    const readable = await reload();
    // Only drop the legacy copy once IndexedDB works, or a private window would lose the key on reload.
    if (legacy && readable) clearLegacy();
    return { ...cache };
  })();
  return loaded;
}

/** Queue a re-read of the stored row behind every write so far. Resolves false if IndexedDB is unavailable. */
function reload(): Promise<boolean> {
  const run = pending.then(async () => {
    let stored: LocalPrefs;
    try {
      stored = (await store().prefs.get(ROW_KEY))?.value ?? {};
    } catch {
      return false;
    }
    const before = JSON.stringify(cache);
    rebase(stored);
    if (JSON.stringify(cache) !== before) notify();
    return true;
  });
  pending = run.then(() => undefined);
  return run;
}

/** Re-read the stored row (another tab may have changed it), keeping this tab's unsaved changes on top. */
export async function refreshPrefs(): Promise<LocalPrefs> {
  await reload();
  return { ...cache };
}

/** Synchronous read of the in-memory copy. `loadPrefs()` runs once at startup before the app renders. */
export function readPrefs(): LocalPrefs {
  return { ...cache };
}

/** Change prefs as a function of their current value; the same function runs against the stored row. */
export function updatePrefs(f: Mutation): LocalPrefs {
  cache = clean(f(cache));
  persist(f);
  return { ...cache };
}

/** Set (or, with `undefined`, remove) the given fields. Fields not named are left as stored. */
export function writePrefs(p: Partial<LocalPrefs>): LocalPrefs {
  return updatePrefs((cur) => ({ ...cur, ...p }));
}

/** Called with the new prefs whenever this tab or another one changes them. Returns an unsubscribe. */
export function subscribePrefs(listener: (p: LocalPrefs) => void): () => void {
  ensureChannel();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Resolves when every write so far has reached IndexedDB. */
export function flushPrefs(): Promise<void> {
  return pending;
}

/** Remove every local pref (key, client id, AI settings) from memory, IndexedDB and legacy localStorage. */
export async function clearPrefs(): Promise<void> {
  updatePrefs(() => ({}));
  clearLegacy();
  await pending;
}

/** Test hook: forget the in-memory copy so the next `loadPrefs()` reads storage again. */
export function resetPrefsMemoryForTests(): void {
  cache = {};
  unsaved = [];
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
