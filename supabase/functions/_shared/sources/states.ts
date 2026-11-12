/**
 * Which optional sources count for one student (plan 43 §3.1, §3.2): offered by the owner (`ORBIT_EXTRA_SOURCES`,
 * read once per process and passed in) and switched on by the student (orbit.source_states). Every server reader of
 * closeness, ties, messages and identities asks `sourcesFor` and filters with what it returns, so a source that is
 * off is left out everywhere without its rows being deleted.
 *
 * With nothing offered (the default) this makes no query and excludes every optional kind, so behaviour is exactly
 * what it was before plan 43.
 */
import {
  excludedBy,
  OPTIONAL_SOURCES,
  type OptionalSource,
  parseExtraSources,
  type SourceState,
  type SourceStates,
  sourcesInUse,
} from '@orbit/core/sources';
import type { Db } from '../db.ts';

export interface SourcesInUse {
  offered: OptionalSource[];
  states: SourceStates;
  inUse: Set<OptionalSource>;
  /** for SQL filters: `kind <> all(${excluded.tieKinds}::text[])` and the like; empty when everything is in use */
  excluded: ReturnType<typeof excludedBy>;
}

/** The owner's list, from the environment value. */
export const offeredSources = (raw: string | undefined | null): OptionalSource[] => parseExtraSources(raw);

export async function loadSourceStates(db: Db, userId: string): Promise<SourceStates> {
  const rows = await db.sql<{ source: string; state: string }>`
    select source, state from orbit.source_states where user_id = ${userId}::uuid`;
  const out: SourceStates = {};
  for (const r of rows)
    if ((OPTIONAL_SOURCES as readonly string[]).includes(r.source))
      out[r.source as OptionalSource] = r.state as SourceState;
  return out;
}

/** What counts for this student right now. */
export async function sourcesFor(
  db: Db,
  userId: string,
  offered: readonly OptionalSource[],
): Promise<SourcesInUse> {
  const states = offered.length ? await loadSourceStates(db, userId) : {};
  const inUse = sourcesInUse(offered, states);
  return { offered: [...offered], states, inUse, excluded: excludedBy(inUse) };
}

/** Nothing optional in use: what every reader gets before plan 43 is switched on. */
export const NO_SOURCES: SourcesInUse = {
  offered: [],
  states: {},
  inUse: new Set(),
  excluded: excludedBy(new Set()),
};
