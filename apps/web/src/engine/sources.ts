/**
 * The optional sources of plan 43 (Instagram, X and texts) in the browser: which ones this Orbit offers, where the
 * student stands with each (not connected, on, off, removed) and which of them count right now. Texts are the first
 * to use it; the Instagram and X screens read the same answers.
 *
 * - Offered: in account mode the server says (GET /sources, from its `ORBIT_EXTRA_SOURCES`); in local mode the build
 *   does (`VITE_ORBIT_EXTRA_SOURCES`, the same comma list). The demo offers all three. Nothing offered means nothing
 *   changes for anyone.
 * - States: in account mode the server keeps them (PUT /sources/:source); in local mode this browser does, in `kv`.
 *   Either way the last answer is kept in `kv` too, so a screen can watch it live.
 * - In use: offered and on (core `sourcesInUse`). Local closeness leaves out every touch of a source not in use
 *   (db/repo.ts), so switching Texts off hides them from closeness without deleting anything, and switching back on
 *   gives back the same scores.
 */
import {
  OPTIONAL_SOURCES,
  type OptionalSource,
  parseExtraSources,
  type SourceState,
  type SourceStates,
  sourcesInUse,
} from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect } from 'react';
import { db } from '../db/schema';
import { callApi, isServerUser } from '../integrations/orbitApi';

/** The sample student (engine/demo.ts DEMO_USER_ID, named here so this file stays below the demo in the imports). */
const DEMO_USER = 'demo-user';
const CURRENT_USER_KEY = 'currentUserId';
const statesKey = (userId: string) => `sources:${userId}`;

export interface SourcesView {
  offered: OptionalSource[];
  states: SourceStates;
  inUse: Set<OptionalSource>;
}

interface Stored {
  states: SourceStates;
  /** account mode: what the server last said it offers */
  offered?: OptionalSource[];
  at?: string;
}

let extraOverride: string | null | undefined;
/** accounts whose sources were asked of the server since this page loaded */
const asked = new Set<string>();

/** Test hook: the owner's list as if the build had been made with it (undefined restores the build's). */
export function setExtraSourcesForTests(raw: string | null | undefined): void {
  extraOverride = raw;
  asked.clear();
}

/** The owner's list this build was made with. */
export function builtInSources(): OptionalSource[] {
  if (extraOverride !== undefined) return parseExtraSources(extraOverride);
  return parseExtraSources(import.meta.env.VITE_ORBIT_EXTRA_SOURCES as string | undefined);
}

async function currentUser(userId?: string): Promise<string | undefined> {
  return userId ?? ((await db.kv.get(CURRENT_USER_KEY))?.value as string | undefined);
}

async function stored(userId: string): Promise<Stored> {
  const v = (await db.kv.get(statesKey(userId)))?.value as Stored | undefined;
  return { states: { ...(v?.states ?? {}) }, ...(v?.offered ? { offered: v.offered } : {}) };
}

function offeredFrom(userId: string, s: Stored): OptionalSource[] {
  if (userId === DEMO_USER) return [...OPTIONAL_SOURCES];
  if (isServerUser(userId)) return s.offered ?? [];
  return builtInSources();
}

/**
 * What the student's sources look like right now, from what this browser holds (no network). With the user's id the
 * first thing it does is read the stored row, so a live query that calls it is told when the switch changes.
 */
export function sourcesNow(userId?: string): Promise<SourcesView> {
  if (userId) return viewFor(userId);
  return currentUser().then((id) =>
    id ? viewFor(id) : { offered: builtInSources(), states: {}, inUse: new Set<OptionalSource>() },
  );
}

async function viewFor(id: string): Promise<SourcesView> {
  const s = await stored(id);
  const offered = offeredFrom(id, s);
  return { offered, states: s.states, inUse: sourcesInUse(offered, s.states) };
}

/**
 * Ask again: in account mode GET /sources (kept in `kv`); elsewhere what this browser holds. A failed request keeps
 * the last answer.
 */
export async function loadSources(userId?: string): Promise<SourcesView> {
  const id = await currentUser(userId);
  if (id && isServerUser(id)) {
    const r = await callApi('/sources', {});
    if (r.ok) {
      const offered = (r.value.offered ?? []).filter((s) => OPTIONAL_SOURCES.includes(s));
      await db.kv.put({
        key: statesKey(id),
        value: { states: r.value.states ?? {}, offered, at: new Date().toISOString() } satisfies Stored,
      });
    }
  }
  return sourcesNow(id);
}

/** The optional sources this Orbit offers the student. */
export async function offeredSources(userId?: string): Promise<OptionalSource[]> {
  return (await loadSources(userId)).offered;
}

/** Where the student stands with each optional source; a source with no entry is not connected. */
export async function sourceStates(userId?: string): Promise<SourceStates> {
  return (await sourcesNow(userId)).states;
}

/** The sources whose rows count right now: offered and on. */
export async function inUseNow(userId?: string): Promise<Set<OptionalSource>> {
  return (await sourcesNow(userId)).inUse;
}

/** Where the student stands with one source. */
export async function sourceState(source: OptionalSource, userId?: string): Promise<SourceState> {
  return (await sourcesNow(userId)).states[source] ?? 'not_connected';
}

export type SetSourceResult = { ok: true; state: SourceState } | { ok: false; message: string };

/**
 * The student's switch for one source. Account mode tells the server first (PUT /sources/:source), which runs the
 * switch job there; the browser keeps the answer. Local mode keeps it here. Callers rescore what the switch changes.
 */
export async function setSourceState(
  source: OptionalSource,
  state: SourceState,
  userId?: string,
): Promise<SetSourceResult> {
  const id = await currentUser(userId);
  if (!id) return { ok: false, message: 'Sign in first.' };
  if (isServerUser(id)) {
    const r = await callApi(`/sources/${source}`, { state });
    if (!r.ok) return { ok: false, message: r.message };
  }
  const s = await stored(id);
  s.states[source] = state;
  await db.kv.put({ key: statesKey(id), value: { ...s, at: new Date().toISOString() } satisfies Stored });
  return { ok: true, state };
}

/**
 * The student's sources, watched: undefined while the first read is in flight. In account mode the server is asked
 * once when a screen first needs it, so what it offers and what the student set elsewhere show up here.
 */
export function useSources(userId: string | undefined): SourcesView | undefined {
  useEffect(() => {
    if (!userId || !isServerUser(userId) || asked.has(userId)) return;
    asked.add(userId);
    void loadSources(userId).catch(() => asked.delete(userId));
  }, [userId]);
  return useLiveQuery(async () => {
    if (!userId) return undefined;
    // read the kv row inside the query so a switch anywhere updates every screen
    await db.kv.get(statesKey(userId));
    return sourcesNow(userId);
  }, [userId]);
}
