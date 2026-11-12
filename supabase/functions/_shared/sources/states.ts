/**
 * Which optional sources count for one student (plan 43 §3.1, §3.2): offered by the owner (`ORBIT_EXTRA_SOURCES`,
 * read once per process and passed in) and switched on by the student (orbit.source_states). Every server reader of
 * closeness, ties, messages and identities asks `sourcesFor` and filters with what it returns, so a source that is
 * off is left out everywhere without its rows being deleted.
 *
 * With nothing offered (the default) this makes no query and excludes every optional kind, so behaviour is exactly
 * what it was before plan 43.
 *
 * People count too: a person known only from a source not in use (people.sources holds nothing else, or the person
 * was made from an account on that platform, people.source_account) is left out wherever people are read, with
 * `orbit.person_in_use(p.sources, p.source_account, hidden)` in SQL or `hiddenPeople` in code. People with
 * `listed = false` take part in closeness and paths but are left out of the people pull, friend sharing and search.
 *
 * The read sites, each filtered (plan 43 §3.2 item 2). The removal test (supabase/tests/functions/sources-removal)
 * compares closeness, paths, the pull, the friend projection and a draft's context with a student who never had the
 * off sources' rows, so a site missed among those fails it.
 *
 *   scoring     _shared/ingest/score.ts: loadHistories (the people scored, messages, text days, follows, intros, the
 *               neighbours and their scores), scorePeople (who has a tie, last contact), changedPeople (text days
 *               and attached accounts); orbit-worker/handlers/score.ts passes the student's sources
 *   paths       _shared/paths/find.ts: graphContext (the owes-a-reply query), personColumns (the people loaded by
 *               loadWhole, loadNeighbourhood and extendNeighbourhood), addTies (every tie loaded: loadWhole,
 *               tiesTouching, extendNeighbourhood; kinds out of use and ties to hidden people), nearby (the
 *               neighbourhood walk), loadFriendLayer (matchShares), findPaths (both targets)
 *               _shared/paths/externalCandidates.ts: resolvePerson goes through resolvePersonRef, a writer; a tie it
 *               makes to a hidden person is dropped by addTies
 *   bridges     _shared/paths/hopJob.ts: runHopEvidenceJob reads LinkedIn members by id only, and the mutuals it is
 *               given come from findPaths' filtered graph
 *   sourcing    _shared/sourcing/run.ts: runSourcing (the graph, the known people batch)
 *   Discover    orbit-api/routes/friendsDiscover.ts: candidates (the student's contacts), toInvite (listed only);
 *               reach is read live, so the switch job's rescore is all it needs
 *   friends     _shared/friends/shares.ts: refreshFriendShares (hidden and unlisted people), matchShares;
 *               orbit-worker/handlers/friends.ts; orbit.friend_shares_guard and orbit.people_unshare refuse and drop
 *               unlisted people (migration 20261201)
 *   inbox       _shared/inbox/inbox.ts: peopleByEmail, readLinkedIn
 *   history     orbit-api/routes/history.ts
 *   replies     _shared/replies/replies.ts: listReplies; orbit-worker/handlers/funnel.ts (no funnel for a reply on
 *               a source out of use)
 *   voice       _shared/voice/voice.ts: relearnCard (orbit-worker/handlers/voice.ts); _shared/compose/context.ts:
 *               exemplars
 *   compose     _shared/compose/compose.ts: prepareCompose (loadPerson, historyWith, exemplars);
 *               _shared/compose/context.ts: loadPerson
 *   cadence     _shared/cadence/cadence.ts: loadCadence (runCadence, dueItems, batchJobs compose.cadence)
 *   autopilot   _shared/autopilot/plan.ts: runAutopilotPlan (candidateRows, the friend layer), firstTouchSendGate
 *   notify      orbit-notify/notify.ts: readinessInput (LinkedIn and Google only: optional sources never hold up
 *               "ready")
 *   readiness   orbit-api/sync.ts: countsFor (the counts /sync/status reports)
 *   search      people are searched in the browser over what it pulled; orbit-api/routes/search.ts acts on person
 *               ids the browser names
 *   pull        orbit-api/sync.ts: pull, with each table's `sources` filter in orbit-api/tables.ts (messages,
 *               threads, ties, identities, people, every table keyed by a person; unlisted people out of people)
 *
 * Writers (ingest, merges, the social writers of other work) are not read sites; they ask `sourceIsOn` before they
 * store anything from an optional source.
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
  /**
   * The optional sources not in use, by name: people made only from them are left out
   * (`orbit.person_in_use(p.sources, p.source_account, ${hidden}::text[])`). A source's name is also its people's
   * source, its account platform and its message provider.
   */
  hidden: OptionalSource[];
}

/** The owner's list, from the environment value. */
export const offeredSources = (raw: string | undefined | null): OptionalSource[] => parseExtraSources(raw);

/** The owner's list as a function carries it (AgentEnv, ApiEnv, HandlerDeps): empty when unset. */
export const offeredOf = (
  holder: { extraSources?: readonly OptionalSource[] } | undefined,
): OptionalSource[] => [...(holder?.extraSources ?? [])];

export async function loadSourceStates(db: Db, userId: string): Promise<SourceStates> {
  const rows = await db.sql<{ source: string; state: string }>`
    select source, state from orbit.source_states where user_id = ${userId}::uuid`;
  const out: SourceStates = {};
  for (const r of rows)
    if ((OPTIONAL_SOURCES as readonly string[]).includes(r.source))
      out[r.source as OptionalSource] = r.state as SourceState;
  return out;
}

const hiddenOf = (inUse: ReadonlySet<OptionalSource>) => OPTIONAL_SOURCES.filter((s) => !inUse.has(s));

/** What counts for this student right now. */
export async function sourcesFor(
  db: Db,
  userId: string,
  offered: readonly OptionalSource[],
): Promise<SourcesInUse> {
  const states = offered.length ? await loadSourceStates(db, userId) : {};
  const inUse = sourcesInUse(offered, states);
  return { offered: [...offered], states, inUse, excluded: excludedBy(inUse), hidden: hiddenOf(inUse) };
}

/** Nothing optional in use: what every reader gets before plan 43 is switched on. */
export const NO_SOURCES: SourcesInUse = {
  offered: [],
  states: {},
  inUse: new Set(),
  excluded: excludedBy(new Set()),
  hidden: hiddenOf(new Set()),
};

/** The SQL test that a person row (alias `p`) is not known only from a source out of use; `param` holds `hidden`. */
export const personInUseSql = (alias: string, param: string): string =>
  `orbit.person_in_use(${alias}.sources, ${alias}.source_account, ${param}::text[])`;

/**
 * The student's people known only from sources out of use (plan 43 §3.2). A reader that walks ties in code drops a tie
 * that touches one of them. One indexed read of the student's people.
 */
export async function hiddenPeople(db: Db, userId: string, src: SourcesInUse): Promise<Set<string>> {
  if (!src.hidden.length) return new Set();
  const rows = await db.sql<{ id: string }>`
    select id from orbit.people
     where user_id = ${userId}::uuid and not orbit.person_in_use(sources, source_account, ${src.hidden}::text[])`;
  return new Set(rows.map((r) => r.id));
}

/**
 * Whether a source may be read and stored from right now (plan 43 §3.1): offered by the owner and switched on by the
 * student. Webhook and worker writers ask this before they store a new row; a source that is off stores nothing.
 */
export async function sourceIsOn(
  db: Db,
  userId: string,
  source: OptionalSource,
  offered: readonly OptionalSource[],
): Promise<boolean> {
  if (!offered.includes(source)) return false;
  const [r] = await db.sql<{ state: string }>`
    select state from orbit.source_states where user_id = ${userId}::uuid and source = ${source}`;
  return r?.state === 'on';
}
