/**
 * Plan 44, Roles for you, in the browser (§10): what the student's profile is read from, the calls to the Roles routes,
 * the matches kept in this browser's database, the search read in steps, what the student does with a role, and
 * "Find a way in".
 *
 * - The profile is read from the lines this browser holds: the resume's kept facets (lines the student unticked are
 *   never sent) and the student's own LinkedIn profile. The server reads them into skills and kinds of role; the
 *   student corrects that; the corrected profile is saved and matched. A copy is kept here so the screen opens at once.
 * - A search is a job, not one long request (§5): /roles/search lists the roles to read, then /roles/more reads a few
 *   at a time until it is done. Each step is one short call, well inside the client's 25 seconds. The loop outlives
 *   the page: leaving Roles and coming back finds it still going, or carries on from where the last visit stopped.
 *   In production the server answers /roles/more at once and reads behind the answer, so each answer holds every row
 *   read so far and `done: false` until none is left: the loop waits between asks, keeps rows by id (never twice),
 *   stops on `done`, shows `note`, follows the search that replaced its own (404 `search_replaced`), and when nothing
 *   more is read for a long while it stops asking and shows the rest as "Not read closely yet".
 * - Every match is kept in `roleMatches`, so a reload, an offline visit and a chat card show the last matches.
 * - The demo student runs on sample roles in the browser (`rolesSim.ts`); a local copy with no Orbit account has no
 *   Roles at all.
 */
import {
  type DismissReason,
  type Job,
  type JobLevel,
  levelsFor,
  type MatchStatus,
  normalizeCompany,
  type PostingInfo,
  type ProfileLevel,
  type ProfileLines,
  type RoleMatch,
  type RoleProfile,
  type RolesCoverage,
  type RolesProfileResponse,
  type TargetPlan,
  type User,
} from '@orbit/core';
import { audit } from '../db/repo';
import { db, type RoleMatchRow } from '../db/schema';
import {
  type ApiFailure,
  type ApiResult,
  type ApiRoutes,
  callApi,
  isServerUser,
} from '../integrations/orbitApi';
import { readView, writeView } from '../state/viewState';
import { featureOn } from './features';
import { barsOfScore } from './peopleSearch';
import { currentResumeFacets } from './resume';
import { createRolesSim, profileKey, type RolesSim, type RolesSimState } from './rolesSim';
import { ownProfile, readOwnProfile } from './selfProfile';
import { buildTargetPlan } from './targetPlan';
import { addTarget } from './targets';

/** engine/demo DEMO_USER_ID (not imported: demo.ts imports most of the engine) */
const DEMO_ID = 'demo-user';

// ---- where Roles runs ------------------------------------------------------------------------------------------

export type RolesMode = 'server' | 'demo' | 'off';

/** The demo student on sample roles; an Orbit account with the feature on against the server; else nothing. */
export function rolesMode(userId: string | undefined): RolesMode {
  if (!userId || !featureOn('roles', userId)) return 'off';
  if (userId === DEMO_ID) return 'demo';
  return isServerUser(userId) ? 'server' : 'off';
}

type RolesRoute = Extract<keyof ApiRoutes, `/roles/${string}`>;

const sims = new Map<string, RolesSim>();
const SIM_KEY = (userId: string) => `roles:demo:${userId}`;

/** The demo student's sample server, its state kept in this browser so a reload finds it as it was. */
function demoSim(userId: string): RolesSim {
  let sim = sims.get(userId);
  if (!sim) {
    sim = createRolesSim({
      // a few at a time, so the table is seen filling in as the server's would
      step: 6,
      load: async () => (await db.kv.get(SIM_KEY(userId)))?.value as RolesSimState | undefined,
      save: async (s) => {
        await db.kv.put({ key: SIM_KEY(userId), value: s });
      },
    });
    sims.set(userId, sim);
  }
  return sim;
}

/** Test hook: forget the demo's sample servers held in memory. */
export function resetRolesForTests(): void {
  sims.clear();
  proposals.clear();
  for (const r of running.values()) r.abort.abort();
  running.clear();
}

const OFF: ApiFailure = {
  ok: false,
  reason: 'off',
  message: 'Roles needs an Orbit account with Roles turned on.',
};

/** One Roles route: the server's, or the demo's sample one. Never throws. */
export async function rolesCall<R extends RolesRoute>(
  userId: string,
  route: R,
  body: ApiRoutes[R][0],
): Promise<ApiResult<ApiRoutes[R][1]>> {
  const mode = rolesMode(userId);
  if (mode === 'off') return OFF;
  if (mode === 'server') return callApi(route, body);
  const r = await demoSim(userId).handle(route, body as Record<string, unknown>);
  return r.ok
    ? { ok: true, value: r.value as ApiRoutes[R][1] }
    : { ok: false, reason: 'error', message: r.message, status: r.status, code: r.code };
}

// ---- the profile -----------------------------------------------------------------------------------------------

const PROFILE_KEY = (userId: string) => `roles:profile:${userId}`;
const SEARCH_KEY = (userId: string) => `roles:search:${userId}`;
const WATCH_KEY = (userId: string) => `roles:watching:${userId}`;

/** What this browser keeps of the profile: the one the student confirmed, when, and the note the reading left. */
export interface KeptProfile {
  profile: RoleProfile;
  at: string;
  note?: string;
}

/** Where the student can be read from, and what each holds. */
export interface ProfileSources {
  resume?: { filename: string; lines: number };
  /** connected: LinkedIn is linked; read: Orbit has read the profile; described: some job on it says what they did */
  linkedin?: { connected: boolean; read: boolean; described: boolean };
}

export async function profileSources(userId: string): Promise<ProfileSources> {
  const [resume, facets, own, integrations] = await Promise.all([
    db.resumes
      .where('userId')
      .equals(userId)
      .filter((r) => r.isCurrent)
      .first(),
    currentResumeFacets(userId),
    ownProfile(userId),
    db.integrations.where('userId').equals(userId).toArray(),
  ]);
  const connected =
    userId === DEMO_ID ||
    integrations.some((i) => i.provider === 'linkedin_live' && i.status === 'active') ||
    !!own;
  const usable = facets.filter((f) => ['experience', 'education', 'project', 'skill_group'].includes(f.kind));
  return {
    resume: resume && usable.length ? { filename: resume.filename, lines: usable.length } : undefined,
    linkedin: connected
      ? {
          connected,
          read: !!own,
          described: !!own?.profile.experience.some((x) => !!x.description?.trim()),
        }
      : undefined,
  };
}

const lineSplit = (text: string): string[] =>
  text
    .split(/\n+|(?<=[.;])\s+(?=[A-Z])/)
    .map((l) => l.replace(/^[-•*\s]+/, '').trim())
    .filter(Boolean);

/**
 * The lines the server reads the profile from: the resume's kept facets (an unticked line is never sent) and the
 * LinkedIn profile, as asked. Names, addresses and numbers are not in either: the summary line, which names the
 * student, is left out.
 */
export async function profileLines(
  user: Pick<User, 'id'>,
  use: { resume: boolean; linkedin: boolean },
): Promise<ProfileLines> {
  const out: ProfileLines = {};
  if (use.resume) {
    const facets = await currentResumeFacets(user.id);
    if (facets.length) {
      const ed = facets.filter((f) => f.kind === 'education');
      const courses = ed.flatMap((f) => {
        const m = /courses?:\s*([^.]+)/i.exec(f.text);
        return m ? m[1]!.split(/,\s*/).map((c) => c.trim()) : [];
      });
      out.resume = {
        experience: facets
          .filter((f) => f.kind === 'experience')
          .map((f) => ({
            title: f.title ?? '',
            org: f.organizationName,
            start: f.startDate,
            end: f.endDate,
            lines: lineSplit(f.text),
          }))
          .filter((x) => x.title || x.org),
        education: ed.map((f) => {
          const degree = f.title;
          const field =
            /\b(?:in|of)\s+([A-Z][\w &]+)$/.exec(degree ?? '')?.[1] ??
            degree?.replace(/^(B\.?S\.?|B\.?A\.?|M\.?S\.?)\s+/i, '');
          return {
            school: f.organizationName ?? f.title ?? '',
            degree,
            field: field || undefined,
            end: f.endDate,
            lines: lineSplit(f.text).filter((l) => !/^gpa\b/i.test(l)),
          };
        }),
        projects: facets
          .filter((f) => f.kind === 'project')
          .map((f) => ({ title: f.title, lines: lineSplit(f.text) })),
        skills: facets
          .filter((f) => f.kind === 'skill_group')
          .flatMap((f) => f.text.split(/[,;\n]\s*/))
          .map((s) => s.replace(/^[^:]*:\s*/, '').trim())
          .filter(Boolean),
        courses,
      };
    }
  }
  if (use.linkedin) {
    const p = (await ownProfile(user.id))?.profile;
    if (p)
      out.linkedin = {
        headline: p.headline,
        about: p.about,
        positions: p.experience
          .filter((x) => x.title)
          .map((x) => ({
            title: x.title!,
            org: x.company,
            start: x.start,
            end: x.end,
            description: x.description,
          })),
        schools: p.education.map((e) => ({
          school: e.school,
          degree: e.degree,
          field: e.field,
          start: e.start,
          end: e.end,
        })),
        skills: p.skills ?? [],
        projects: (p.projects ?? []).map((x) => ({ name: x.name, description: x.description })),
      };
  }
  return out;
}

/**
 * Read the student's profile from what they chose, into the profile Orbit proposes. LinkedIn is read first when it
 * has not been yet. Answers the proposal and a note when it read little, or why it could not.
 */
export async function readProfile(
  user: User,
  use: { resume: boolean; linkedin: boolean },
): Promise<{ ok: true; proposed: RoleProfile; note?: string } | { ok: false; message: string }> {
  if (use.linkedin && !(await ownProfile(user.id)))
    await readOwnProfile(user, { force: true }).catch(() => undefined);
  const lines = await profileLines(user, use);
  if (!lines.resume && !lines.linkedin)
    return {
      ok: false,
      message: use.linkedin
        ? 'Orbit could not read your LinkedIn profile just now. Try again, or upload a resume.'
        : 'Orbit found no lines on your resume to read. Upload it again, or tick the lines it read in Settings.',
    };
  const r = await rolesCall(user.id, '/roles/profile', { read: lines });
  if (!r.ok) return { ok: false, message: r.message };
  const proposed = (r.value as RolesProfileResponse).proposed;
  if (!proposed) return { ok: false, message: 'Orbit could not read a profile from that. Try again.' };
  return { ok: true, proposed: withLevels(proposed), note: (r.value as RolesProfileResponse).note };
}

/**
 * The server leaves `wants.levels` empty to mean "the levels that fit the profile's level". The profile screen shows
 * levels as ticked boxes, so an empty list is filled with those levels here: the student sees which are searched and
 * unticks what they do not want. The search is the same either way.
 */
export function withLevels(p: RoleProfile): RoleProfile {
  return p.wants.levels.length ? p : { ...p, wants: { ...p.wants, levels: levelsFor(p.level) } };
}

export async function keptProfile(userId: string): Promise<KeptProfile | undefined> {
  return (await db.kv.get(PROFILE_KEY(userId)))?.value as KeptProfile | undefined;
}

/**
 * Save the profile the student confirmed and start a search on it. A search still running for the old profile is
 * dropped, and its rows with it: nothing scored for the old profile appears.
 */
export async function saveProfile(
  user: User,
  profile: RoleProfile,
  opts: { note?: string; search?: boolean } = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await rolesCall(user.id, '/roles/profile', { save: profile });
  if (!r.ok) return { ok: false, message: r.message };
  const saved = withLevels((r.value as RolesProfileResponse).profile ?? profile);
  const before = await keptProfile(user.id);
  await db.kv.put({
    key: PROFILE_KEY(user.id),
    value: {
      profile: saved,
      at: new Date().toISOString(),
      note: opts.note ?? before?.note,
    } satisfies KeptProfile,
  });
  void audit(user.id, before ? 'roles.profile_changed' : 'roles.profile_built', {
    metadata: {
      sources: saved.sources,
      kinds: saved.kinds.filter((k) => k.on).map((k) => k.title),
      skills: saved.skills.length,
      level: saved.level,
    },
  });
  const changed = !before || profileKey(before.profile) !== profileKey(saved);
  // a search for the old profile is dropped with its rows, whether or not a new one starts now
  if (changed && before) await dropSearch(user.id);
  if (opts.search !== false) void runSearch(user, { fresh: changed });
  return { ok: true };
}

/**
 * The profile from the server, kept here (a new browser, or another device changed it). The server answers `profile`
 * only once the student has confirmed one; before that it answers what Orbit proposed, which is never kept as their
 * profile: `proposedProfile` hands it to the review screen.
 */
export async function syncProfile(user: User): Promise<KeptProfile | undefined> {
  const r = await rolesCall(user.id, '/roles/profile', { get: true });
  const kept = await keptProfile(user.id);
  if (!r.ok) return kept;
  const p = (r.value as RolesProfileResponse).profile;
  if (!p) {
    const proposed = (r.value as RolesProfileResponse).proposed;
    if (proposed && !kept) proposals.set(user.id, withLevels(proposed));
    return kept;
  }
  const next: KeptProfile = {
    profile: withLevels(p),
    at: kept?.at ?? new Date().toISOString(),
    note: kept?.note,
  };
  await db.kv.put({ key: PROFILE_KEY(user.id), value: next });
  return next;
}

const proposals = new Map<string, RoleProfile>();

/**
 * What Orbit read for a student who has not confirmed a profile yet (they left before "Find roles"), as the last
 * `syncProfile` found it on the server: the review screen opens on it again, with no second read.
 */
export function proposedProfile(userId: string): RoleProfile | undefined {
  return proposals.get(userId);
}

// ---- the matches kept in this browser ---------------------------------------------------------------------------

/** Where the search stands, kept so a reload or the next visit carries on from it. */
export interface KeptSearch {
  searchId: string;
  listed: number;
  read: number;
  done: boolean;
  coverage?: RolesCoverage;
  note?: string;
  /** when the last answer came */
  at: string;
  /** the profile the search is for */
  profileKey?: string;
}

export async function keptSearch(userId: string): Promise<KeptSearch | undefined> {
  return (await db.kv.get(SEARCH_KEY(userId)))?.value as KeptSearch | undefined;
}

const rowId = (userId: string, matchId: string) => `${userId}:${matchId}`;

/** A row as kept, with the search it came from (a match read for an older profile is not shown in the table). */
export type KeptMatchRow = RoleMatchRow;

/** Keep what the server answered: new rows are added, known ones replaced, the search they came from kept. */
export async function keepMatches(userId: string, matches: RoleMatch[], searchId?: string): Promise<void> {
  if (!matches.length) return;
  const ids = matches.map((m) => rowId(userId, m.id));
  const had = await db.roleMatches.bulkGet(ids);
  const at = new Date().toISOString();
  await db.roleMatches.bulkPut(
    matches.map((m, i) => ({
      id: ids[i]!,
      userId,
      match: m,
      keptAt: at,
      // a posting the student scored themselves stays marked as theirs, whatever search lists it later
      searchId:
        (had[i] as KeptMatchRow | undefined)?.searchId === PASTED
          ? PASTED
          : (searchId ?? (had[i] as KeptMatchRow | undefined)?.searchId),
    })) as KeptMatchRow[],
  );
}

/** The search a posting the student pasted or linked is kept under (the server lists it with every search). */
export const PASTED = 'pasted';

/** Every match kept for the student, with the search each came from. */
export async function keptMatches(userId: string): Promise<KeptMatchRow[]> {
  return (await db.roleMatches.where('userId').equals(userId).toArray()) as KeptMatchRow[];
}

/** One kept match by its id. */
export async function keptMatch(userId: string, matchId: string): Promise<RoleMatch | undefined> {
  return (await db.roleMatches.get(rowId(userId, matchId)))?.match;
}

/**
 * The roles the table lists: the current search's and the postings the student scored themselves, not dismissed,
 * still open. A role still to be read is left out until it is read, unless the server sent it with its rough parts
 * (`roughFit`: the model is off, a limit is reached, the search stopped): that one is listed, marked "Not read
 * closely yet".
 */
export function tableMatches(rows: KeptMatchRow[], search: KeptSearch | undefined): RoleMatch[] {
  return rows
    .filter((r) => !search || r.searchId === search.searchId || r.searchId === PASTED)
    .map((r) => r.match)
    .filter(
      (m) =>
        m.status !== 'dismissed' &&
        !m.job.closedAt &&
        m.state !== 'gone' &&
        (m.state !== 'to_read' || !!m.fit || !!m.roughFit),
    );
}

/** What Saved lists: saved, applied and interviewing, closed ones too (they say "No longer listed"). */
export function savedMatches(rows: KeptMatchRow[]): RoleMatch[] {
  return rows
    .map((r) => r.match)
    .filter((m) => m.status === 'saved' || m.status === 'applied' || m.status === 'interviewing');
}

/** The table's rows for an older profile go: a new profile's search starts on an empty table. Saved ones stay. */
async function dropSearch(userId: string): Promise<void> {
  cancelSearch(userId);
  const rows = await keptMatches(userId);
  const gone = rows
    .filter((r) => r.match.status === 'new' || r.match.status === 'dismissed')
    .map((r) => r.id);
  await db.roleMatches.bulkDelete(gone);
  await db.kv.delete(SEARCH_KEY(userId));
}

/** Bring the kept copy up to date from the server's stored matches (free): the matches and Saved. */
export async function refreshMatches(
  user: Pick<User, 'id'>,
  opts: {
    /** also the roles not read closely yet; by default whenever the kept search is over and none is running */
    rest?: boolean;
  } = {},
): Promise<{ ok: boolean; offline?: boolean }> {
  const search = await keptSearch(user.id);
  // a search that is over: the roles it could not read closely come too, so they stay listed as such
  const rest = opts.rest ?? (!!search?.done && !searchRunning(user.id));
  const [list, saved] = await Promise.all([
    rolesCall(user.id, '/roles/list', rest ? { view: 'matches', rest: true } : { view: 'matches' }),
    rolesCall(user.id, '/roles/list', { view: 'saved' }),
  ]);
  if (!list.ok) return { ok: false, offline: list.reason === 'network' };
  const searchId = list.value.searchId ?? search?.searchId;
  await keepMatches(user.id, list.value.matches, searchId);
  if (saved.ok) await keepMatches(user.id, saved.value.matches);
  // a role taken down since: it leaves the table; Saved keeps it, marked as no longer listed
  const listed = new Set(list.value.matches.map((m) => m.id));
  const rows = await keptMatches(user.id);
  // only when the whole list was asked for (the roles not read closely too): a role missing from it is gone
  const closed = rows.filter(
    (r) =>
      rest &&
      r.searchId === searchId &&
      r.match.status === 'new' &&
      !listed.has(r.match.id) &&
      search?.done &&
      !r.match.job.closedAt,
  );
  if (closed.length)
    await db.roleMatches.bulkPut(
      closed.map((r) => ({ ...r, match: { ...r.match, state: 'gone' as const } })),
    );
  if (searchId && (!search || search.searchId !== searchId))
    await db.kv.put({
      key: SEARCH_KEY(user.id),
      value: {
        searchId,
        listed: list.value.matches.length,
        read: list.value.matches.length,
        done: true,
        coverage: list.value.coverage,
        at: new Date().toISOString(),
      } satisfies KeptSearch,
    });
  return { ok: true };
}

// ---- the search, read in steps --------------------------------------------------------------------------------

/** What the page shows while a search runs: kept in viewState, so it is there when the student comes back. */
export interface RolesRun {
  phase: 'idle' | 'running';
  run: number;
  error?: string;
  offline?: boolean;
}
export const RUN_KEY = (userId: string) => `roles:run:${userId}`;
const IDLE: RolesRun = { phase: 'idle', run: 0 };

const running = new Map<string, { run: number; abort: AbortController }>();
let runs = 0;

export function searchRunning(userId: string): boolean {
  return running.has(userId);
}

/** Stop the search running for the student (a new profile, or they left for good). Its later answers are dropped. */
export function cancelSearch(userId: string): void {
  const r = running.get(userId);
  if (!r) return;
  r.abort.abort();
  running.delete(userId);
  writeView<RolesRun>(RUN_KEY(userId), (s) => ({ ...s, phase: 'idle' }), IDLE);
}

/**
 * Run the student's search: /roles/search lists what to read (or, with `resume`, the kept search carries on), then
 * /roles/more reads a few at a time until done. Each answer is kept as it comes, so the table fills in. A newer run,
 * or a profile saved meanwhile, makes this one stop and drop what it gets back.
 */
export async function runSearch(
  user: Pick<User, 'id'>,
  opts: { fresh?: boolean; resume?: boolean } = {},
): Promise<{ ok: boolean; message?: string }> {
  const userId = user.id;
  cancelSearch(userId);
  const run = ++runs;
  const abort = new AbortController();
  running.set(userId, { run, abort });
  writeView<RolesRun>(RUN_KEY(userId), { phase: 'running', run }, IDLE);
  const live = () => running.get(userId)?.run === run && !abort.signal.aborted;
  const kept = await keptProfile(userId);
  const key = kept ? profileKey(kept.profile) : undefined;
  const finish = (r: { ok: boolean; message?: string; offline?: boolean }) => {
    if (live()) {
      running.delete(userId);
      writeView<RolesRun>(
        RUN_KEY(userId),
        { phase: 'idle', run, error: r.ok ? undefined : r.message, offline: r.offline },
        IDLE,
      );
    }
    return r;
  };
  try {
    let search = await keptSearch(userId);
    const carryOn =
      opts.resume && search && !search.done && (!search.profileKey || search.profileKey === key);
    if (!carryOn) {
      const r = await rolesCall(userId, '/roles/search', opts.fresh ? { fresh: true } : {});
      if (!live()) return { ok: false };
      if (!r.ok) return finish({ ok: false, message: r.message, offline: r.reason === 'network' });
      search = {
        searchId: r.value.searchId,
        listed: r.value.listed,
        read: r.value.read,
        done: r.value.done,
        coverage: r.value.coverage,
        note: r.value.note,
        at: new Date().toISOString(),
        profileKey: key,
      };
      await keepMatches(userId, r.value.matches, search.searchId);
      await db.kv.put({ key: SEARCH_KEY(userId), value: search });
      void audit(userId, 'roles.search_run', {
        metadata: { listed: search.listed, fresh: !!opts.fresh },
      });
    }
    // carrying on a search that had stopped: the line that said so goes, the reading is on again
    if (carryOn && search?.note === STALLED_NOTE) {
      search = { ...search, note: undefined };
      await db.kv.put({ key: SEARCH_KEY(userId), value: search });
    }
    let retried = false;
    let first = true;
    // when one more role was last read: a search that stops growing is not asked about for ever
    let progressAt = now();
    let lastRead = search?.read ?? 0;
    while (search && !search.done) {
      // the server reads in the background and answers with what it has read so far: the next ask waits a beat
      // (never a tight loop); each answer replaces the rows by id
      if (!first) await pause(pauseFor(userId), abort.signal);
      first = false;
      if (!live()) return { ok: false };
      const r = await rolesCall(userId, '/roles/more', { searchId: search.searchId });
      if (!live()) return { ok: false };
      if (!r.ok) {
        // a newer search took this one's place (another tab or device ran one, or the profile changed there), or the
        // server no longer has it: ask once which search to follow. Not a fresh search: that would replace the newer
        // one in turn, and spend one of the day's searches.
        if (r.status === 404 && r.code !== 'not_offered' && !retried) {
          retried = true;
          const s = await rolesCall(userId, '/roles/search', {});
          if (!live()) return { ok: false };
          if (!s.ok) return finish({ ok: false, message: s.message, offline: s.reason === 'network' });
          search = {
            searchId: s.value.searchId,
            listed: s.value.listed,
            read: s.value.read,
            done: s.value.done,
            coverage: s.value.coverage,
            note: s.value.note,
            at: new Date().toISOString(),
            profileKey: key,
          };
          await keepMatches(userId, s.value.matches, search.searchId);
          await db.kv.put({ key: SEARCH_KEY(userId), value: search });
          progressAt = now();
          lastRead = search.read;
          first = true;
          continue;
        }
        return finish({ ok: false, message: r.message, offline: r.reason === 'network' });
      }
      search = {
        ...search,
        listed: r.value.listed,
        read: r.value.read,
        // done is the server's word alone: a search can end with roles it could not read (they come with the answer)
        done: r.value.done,
        coverage: r.value.coverage ?? search.coverage,
        note: r.value.note ?? search.note,
        at: new Date().toISOString(),
      };
      await keepMatches(userId, r.value.matches, search.searchId);
      await db.kv.put({ key: SEARCH_KEY(userId), value: search });
      if (search.read > lastRead) {
        lastRead = search.read;
        progressAt = now();
      } else if (!search.done && now() - progressAt >= stallMs()) {
        // nothing more was read for a long while: stop asking. What is read stays; the rest are listed as not read
        // closely yet; the search is left open, so the next visit carries on from here.
        await refreshMatches(user, { rest: true });
        if (!live()) return { ok: false };
        search = { ...search, note: STALLED_NOTE, at: new Date().toISOString() };
        await db.kv.put({ key: SEARCH_KEY(userId), value: search });
        void audit(userId, 'roles.search_stalled', {
          metadata: { listed: search.listed, read: search.read },
        });
        return finish({ ok: true });
      }
    }
    return finish({ ok: true });
  } catch (e) {
    return finish({ ok: false, message: e instanceof Error ? e.message : 'The search stopped. Try again.' });
  }
}

/**
 * How long the loop keeps asking while nothing more is read. The server reads ten roles behind each answer, and a
 * slow one can take a minute; past this the reading has stopped (the model is down, the read died), and asking on
 * would only spin.
 */
export const STALL_MS = 90_000;
export const STALLED_NOTE =
  'Orbit is taking longer than usual to read the rest. They are listed without a score for now, and the reading carries on the next time you open Roles.';
let stallOverride: number | undefined;
const stallMs = () => stallOverride ?? STALL_MS;
let now: () => number = () => Date.now();

/** Test hooks: how long without progress before the loop stops, and the clock it measures with. */
export function setRolesStallForTests(ms: number | undefined, clock?: () => number): void {
  stallOverride = ms;
  now = clock ?? (() => Date.now());
}

/** How long the loop waits between /roles/more calls: the server's background read, or the demo filling in. */
let pauseOverride: number | undefined;
export const MORE_PAUSE_MS = 2500;
function pauseFor(userId: string): number {
  if (pauseOverride !== undefined) return pauseOverride;
  if (import.meta.env.MODE === 'test') return 0;
  return rolesMode(userId) === 'demo' ? 350 : MORE_PAUSE_MS;
}

/** Test hook: the wait between /roles/more calls (undefined restores the default). */
export function setRolesPauseForTests(ms: number | undefined): void {
  pauseOverride = ms;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        res();
      },
      { once: true },
    );
  });
}

/** The run as it stands, read outside React. */
export function rolesRun(userId: string): RolesRun {
  return readView<RolesRun>(RUN_KEY(userId)) ?? IDLE;
}

// ---- what the student does with a role ---------------------------------------------------------------------------

export const DISMISS_REASONS: { value: DismissReason; label: string }[] = [
  { value: 'kind', label: 'Wrong kind of role' },
  { value: 'level', label: 'Wrong level' },
  { value: 'place', label: 'Wrong place' },
  { value: 'company', label: 'Not interested in the company' },
];

/** Save, dismiss with a reason, mark applied or interviewing: kept here at once, then on the server. */
export async function actOnMatch(
  user: Pick<User, 'id'>,
  match: RoleMatch,
  status: MatchStatus,
  reason?: DismissReason,
): Promise<{ ok: true; match: RoleMatch } | { ok: false; message: string }> {
  const id = rowId(user.id, match.id);
  const before = (await db.roleMatches.get(id)) as KeptMatchRow | undefined;
  const next: RoleMatch = {
    ...match,
    status,
    dismissReason: status === 'dismissed' ? (reason ?? 'other') : undefined,
  };
  await db.roleMatches.put({
    id,
    userId: user.id,
    match: next,
    keptAt: new Date().toISOString(),
    searchId: before?.searchId,
  } as KeptMatchRow);
  const r = await rolesCall(user.id, '/roles/act', {
    matchId: match.id,
    status,
    ...(status === 'dismissed' ? { dismissReason: reason ?? 'other' } : {}),
  });
  if (!r.ok) {
    // put it back as it was: the server did not take it
    if (before) await db.roleMatches.put(before);
    return { ok: false, message: r.message };
  }
  const out = r.value.match ?? next;
  await db.roleMatches.put({
    id,
    userId: user.id,
    match: out,
    keptAt: new Date().toISOString(),
    searchId: before?.searchId,
  } as KeptMatchRow);
  const meta = { company: match.job.companyName, title: match.job.title, score: match.fit?.score };
  void audit(
    user.id,
    status === 'saved' ? 'roles.saved' : status === 'dismissed' ? 'roles.dismissed' : 'roles.status',
    {
      objectTable: 'roleMatches',
      objectId: match.id,
      metadata: { ...meta, status, ...(status === 'dismissed' ? { reason: reason ?? 'other' } : {}) },
    },
  );
  return { ok: true, match: out };
}

/** The role panel was opened (what the tab is judged on: whether students act on what it lists). */
export function roleOpened(userId: string, match: RoleMatch): void {
  void audit(userId, 'roles.opened', {
    objectTable: 'roleMatches',
    objectId: match.id,
    metadata: { company: match.job.companyName, title: match.job.title, score: match.fit?.score },
  });
}

export async function watching(userId: string): Promise<string[]> {
  return ((await db.kv.get(WATCH_KEY(userId)))?.value as string[] | undefined) ?? [];
}

/** Watch a company: Orbit says when a role there that fits appears. */
export async function watchCompany(
  user: Pick<User, 'id'>,
  companyName: string,
  on: boolean,
): Promise<{ ok: boolean; message?: string }> {
  const r = await rolesCall(user.id, '/roles/act', { watch: { companyName, on } });
  if (!r.ok) return { ok: false, message: r.message };
  const list =
    r.value.watching ??
    (on
      ? [...new Set([...(await watching(user.id)), companyName])]
      : (await watching(user.id)).filter((w) => normalizeCompany(w) !== normalizeCompany(companyName)));
  await db.kv.put({ key: WATCH_KEY(user.id), value: list });
  void audit(user.id, on ? 'roles.watch' : 'roles.unwatch', { metadata: { company: companyName } });
  return { ok: true };
}

/** One posting, by link or pasted text, scored now; kept so its panel opens like any other role. */
export async function scorePosting(
  user: Pick<User, 'id'>,
  input: { url?: string; text?: string },
): Promise<{ ok: true; match: RoleMatch } | { ok: false; message: string }> {
  const r = await rolesCall(user.id, '/roles/score', input);
  if (!r.ok) return { ok: false, message: r.message };
  if (!r.value.match) return { ok: false, message: r.value.problem ?? 'Orbit could not score that posting.' };
  await keepMatches(user.id, [r.value.match], PASTED);
  void audit(user.id, 'roles.scored', {
    metadata: { company: r.value.match.job.companyName, score: r.value.match.fit?.score },
  });
  return { ok: true, match: r.value.match };
}

/**
 * "Find a way in": the company becomes a target with this role and posting (a target already there keeps its own
 * role), and the plan of who to reach is built for this role. Answers the plan and the company's page.
 */
export async function findWayIn(
  user: User,
  match: RoleMatch,
): Promise<{ plan: TargetPlan; orgId?: string; added: boolean }> {
  const job = match.job;
  const posting: PostingInfo = {
    company: job.companyName,
    role: job.title,
    team: job.team,
    location: job.remote === 'remote' ? 'Remote' : job.places[0],
    url: job.url || undefined,
  };
  const { status, target } = await addTarget(user.id, job.companyName, {
    role: job.title,
    team: job.team,
    postingUrl: job.url || undefined,
    postingSeenAt: job.url ? new Date().toISOString() : undefined,
  });
  if (!target) throw new Error('Orbit could not add that company.');
  const plan = await buildTargetPlan(user, target, posting);
  void audit(user.id, 'roles.way_in', {
    objectTable: 'roleMatches',
    objectId: match.id,
    metadata: { company: job.companyName, title: job.title, added: status === 'added' },
  });
  return { plan, orgId: target.organizationId, added: status === 'added' };
}

// ---- who the student knows at each company --------------------------------------------------------------------

/** The Path column: the people the student knows there, alumni there, or no one yet (as the company page reads it). */
export interface RolePath {
  /** people the student has a tie with, closest first */
  known: { id: string; name: string; photoUrl?: string; level: number; title?: string }[];
  alumni: { id: string; name: string; photoUrl?: string; title?: string }[];
  /** 0 to 4: the closest tie there */
  level: number;
  /** the company's page in Orbit, when the student has it */
  orgId?: string;
}

const NO_PATH: RolePath = { known: [], alumni: [], level: 0 };

/** The Path for each company named (keyed by normalizeCompany), from the people in this browser. */
export async function pathsFor(userId: string, companies: string[]): Promise<Map<string, RolePath>> {
  const keys = [...new Set(companies.map((c) => normalizeCompany(c)).filter(Boolean))];
  const out = new Map<string, RolePath>();
  if (!keys.length) return out;
  const [orgs, people] = await Promise.all([
    db.organizations.where('nameNormalized').anyOf(keys).toArray(),
    db.people.where('userId').equals(userId).toArray(),
  ]);
  const orgKey = new Map(orgs.map((o) => [o.id, o.nameNormalized]));
  for (const k of keys)
    out.set(k, { ...NO_PATH, known: [], alumni: [], orgId: orgs.find((o) => o.nameNormalized === k)?.id });
  for (const p of people) {
    if (!p.isHuman || p.hiddenAt) continue;
    const k =
      (p.currentOrganizationId && orgKey.get(p.currentOrganizationId)) ||
      normalizeCompany(p.currentOrganizationRaw);
    const path = k ? out.get(k) : undefined;
    if (!path) continue;
    const knows = (p.tieScore ?? 0) > 0 || p.interactionCount > 0 || p.strength > 0.15;
    if (knows) {
      const level = Math.max(1, barsOfScore(p.tieScore ?? p.strength * 100));
      path.known.push({ id: p.id, name: p.displayName, photoUrl: p.photoUrl, level, title: p.currentTitle });
      path.level = Math.max(path.level, level);
    } else if (p.isAlumni)
      path.alumni.push({ id: p.id, name: p.displayName, photoUrl: p.photoUrl, title: p.currentTitle });
  }
  for (const path of out.values()) {
    path.known.sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
    if (!path.known.length && path.alumni.length) path.level = 1;
  }
  return out;
}

export const pathOf = (paths: Map<string, RolePath> | undefined, company: string): RolePath =>
  paths?.get(normalizeCompany(company)) ?? NO_PATH;

// ---- filters, order and words ---------------------------------------------------------------------------------

export type RolesSort = 'fit' | 'newest' | 'warmest';

export interface RoleFilters {
  /** kinds of role to show (titles from the profile); empty shows every kind */
  kinds: string[];
  level: 'any' | JobLevel;
  /** a place the role is in ("New York"); empty is anywhere */
  place: string;
  remote: boolean;
  noSponsorship: boolean;
  /** the least fit shown */
  minFit: number;
  sort: RolesSort;
}

export const DEFAULT_FILTERS: RoleFilters = {
  kinds: [],
  level: 'any',
  place: '',
  remote: false,
  noSponsorship: false,
  minFit: 6,
  sort: 'fit',
};

/** Whether a role is one of the kinds picked: same family as the kind, or the kind's words in the title. */
export function roleOfKind(job: Job, kind: { title: string; family?: string }): boolean {
  if (kind.family && job.family === kind.family) {
    // two kinds of one family ("Backend engineer", "Software engineer") are told apart by the title's words
    const words = kind.title
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => !/^(engineer|software|manager|analyst)$/.test(w));
    return (
      !words.length || words.some((w) => job.title.toLowerCase().includes(w)) || /software/i.test(kind.title)
    );
  }
  return job.title.toLowerCase().includes(kind.title.toLowerCase());
}

const fitOfMatch = (m: RoleMatch) => m.fit?.score;
const roughOf = (m: RoleMatch) =>
  m.roughFit ? m.roughFit.skills + (m.roughFit.level ? 0.5 : 0) + (m.roughFit.place ? 0.3 : 0) : 0;
const postedAt = (m: RoleMatch) => Date.parse(m.job.postedAt ?? m.job.firstSeenAt ?? '') || 0;

export function filterMatches(
  rows: RoleMatch[],
  f: RoleFilters,
  kinds: { title: string; family?: string }[] = [],
): RoleMatch[] {
  const picked = kinds.filter((k) => f.kinds.includes(k.title));
  const place = f.place.trim().toLowerCase();
  return rows.filter((m) => {
    const j = m.job;
    if (picked.length && !picked.some((k) => roleOfKind(j, k))) return false;
    if (f.level !== 'any' && j.level && j.level !== f.level) return false;
    if (
      place &&
      !j.places.some((p) => p.toLowerCase().includes(place)) &&
      !(j.remote === 'remote' && /remote/.test(place))
    )
      return false;
    if (f.remote && j.remote !== 'remote') return false;
    if (f.noSponsorship && m.fit?.caps.some((c) => c.kind === 'sponsorship')) return false;
    if (f.noSponsorship && j.sponsorship === 'none') return false;
    // a role not read closely has no number: it is not held back by the least fit
    const s = fitOfMatch(m);
    if (s !== undefined && s < f.minFit) return false;
    return true;
  });
}

/** Fit, then the warmest path, then the newest (plan 44 §6.6); or newest first; or warmest first. */
export function sortMatches(rows: RoleMatch[], sort: RolesSort, paths?: Map<string, RolePath>): RoleMatch[] {
  const warm = (m: RoleMatch) => pathOf(paths, m.job.companyName).level;
  const score = (m: RoleMatch) => fitOfMatch(m) ?? -1;
  const by: Record<RolesSort, (a: RoleMatch, b: RoleMatch) => number> = {
    fit: (a, b) =>
      score(b) - score(a) || roughOf(b) - roughOf(a) || warm(b) - warm(a) || postedAt(b) - postedAt(a),
    newest: (a, b) => postedAt(b) - postedAt(a) || score(b) - score(a),
    warmest: (a, b) => warm(b) - warm(a) || score(b) - score(a) || postedAt(b) - postedAt(a),
  };
  return [...rows].sort(by[sort]);
}

/** When nothing scores 6 or more: the best five anyway, marked as stretches. */
export function bestStretches(rows: RoleMatch[]): RoleMatch[] {
  return sortMatches(
    rows.filter((m) => m.fit && m.fit.score >= 3),
    'fit',
  ).slice(0, 5);
}

export const BAND_WORDS: Record<string, string> = {
  strong: 'Strong fit',
  good: 'Good fit',
  stretch: 'A stretch',
  out: 'Out of reach for now',
};

/** "San Francisco" or "Remote", the first place; "and 2 more" kept for the hover. */
export function whereWords(job: Job): { place: string; all: string; term?: string } {
  const places = job.places.map((p) => p.replace(/,\s*[A-Z]{2}$/, '').replace(/^Remote\b.*$/i, 'Remote'));
  const first = job.remote === 'remote' ? 'Remote' : (places[0] ?? (job.remote === 'hybrid' ? 'Hybrid' : ''));
  const rest = [...new Set(places)].filter((p) => p !== first);
  return {
    place: rest.length ? `${first} and ${rest.length} more` : first,
    all: [...new Set([first, ...places])].filter(Boolean).join('; '),
    term: job.term,
  };
}

/** "3 days ago", "today". */
export function postedWords(job: Job, now = new Date()): string {
  const at = Date.parse(job.postedAt ?? job.firstSeenAt ?? '');
  if (!at) return '';
  const days = Math.floor((now.getTime() - at) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

const PART_NAMES = {
  skills: 'Skills',
  experience: 'Experience',
  education: 'Education',
  level: 'Level',
} as const;
export type FitPartName = keyof typeof PART_NAMES;

/** Each part of a score in its own words ("Skills: 3 of 4 the posting asks for. You have Go, SQL. Not on your resume: Kubernetes."). */
export function partWords(
  m: RoleMatch,
  sources: ('resume' | 'linkedin')[] = ['resume'],
): { part: FitPartName; name: string; value?: number; words: string }[] {
  const a = m.answers;
  const p = m.fit?.parts ?? {};
  const doc = sources.includes('resume') ? 'resume' : 'profile';
  if (!a) return [];
  const shown = a.skills.filter((s) => s.answer === 'work' || s.answer === 'project');
  const listed = a.skills.filter((s) => s.answer === 'listed');
  const none = a.skills.filter((s) => s.answer === 'none');
  const skills = a.skills.length
    ? [
        `${shown.length + listed.length} of ${a.skills.length} skills the posting asks for.`,
        shown.length ? `You have ${shown.map((s) => s.name).join(', ')}.` : '',
        listed.length ? `Listed only: ${listed.map((s) => s.name).join(', ')}.` : '',
        none.length ? `Not on your ${doc}: ${none.map((s) => s.name).join(', ')}.` : '',
      ]
        .filter(Boolean)
        .join(' ')
    : 'The posting names no skills.';
  const exp = {
    same: 'You have done this kind of role before.',
    related: 'You have done a related kind of role.',
    projects: 'Projects only, no job of this kind yet.',
    none: 'Nothing related on your profile yet.',
  }[a.experience.answer];
  const edu = {
    fits: 'Your degree and year fit what it asks.',
    close: 'Close: a related field, or a year off.',
    no: 'Your degree does not fit what it asks.',
    unsaid: 'The posting does not say.',
  }[a.education.answer];
  const lvl = {
    at: 'At your level.',
    below: 'Below your level.',
    stretch: 'A step up from where you are.',
    far: 'Far above your level for now.',
  }[a.level.answer];
  return (
    [
      ['skills', skills],
      ['experience', exp],
      ['education', edu],
      ['level', lvl],
    ] as [FitPartName, string][]
  ).map(([part, words]) => ({ part, name: PART_NAMES[part], value: p[part], words }));
}

/** The quotes a score rests on: the posting's lines and the student's, each once. */
export function quotesOf(m: RoleMatch): { posting: string[]; you: string[] } {
  const a = m.answers;
  if (!a) return { posting: [], you: [] };
  const all = [...a.skills, a.experience, a.education, a.level];
  const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x?.trim()))];
  return {
    posting: uniq([...all.map((x) => x.posting), ...a.caps.map((c) => c.quote)]).slice(0, 6),
    you: uniq(all.filter((x) => x.answer !== 'none' && x.answer !== 'unsaid').map((x) => x.you)).slice(0, 6),
  };
}

/** The levels a profile level looks at by default (a student internships; a new grad entry roles). */
export const defaultLevels = (level: ProfileLevel): JobLevel[] => levelsFor(level);

export const LEVEL_WORDS: Record<JobLevel, string> = {
  intern: 'Internships',
  entry: 'Entry level',
  mid: 'Mid level',
  senior: 'Senior',
  lead: 'Lead',
  exec: 'Executive',
};

export const PROFILE_LEVEL_WORDS: Record<ProfileLevel, string> = {
  student: 'Student',
  new_grad: 'New grad',
  early: 'Early career, 1 to 3 years',
  mid: 'Mid career, 3 to 8 years',
  senior: 'Senior, 8 years or more',
};

/** "Roles from 1,240 company boards, SimplifyJobs and your LinkedIn search." */
export function coverageWords(c: RolesCoverage | undefined): string {
  const boards = c?.boards ? `${c.boards.toLocaleString('en-US')} company boards` : 'company job boards';
  const parts = [boards, c?.simplify ? 'SimplifyJobs' : '', c?.linkedin ? 'your LinkedIn search' : ''].filter(
    Boolean,
  );
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  return `Roles from ${list}.`;
}

/** "Read 3 hours ago" for the kept copy. */
export function readWhen(at: string | undefined, now = new Date()): string {
  if (!at) return '';
  const mins = Math.round((now.getTime() - Date.parse(at)) / 60_000);
  if (mins < 2) return 'Read just now';
  if (mins < 60) return `Read ${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Read ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `Read ${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** "Third year, B.S. Computer Science, graduating May 2027" */
export function whereTheyAre(p: RoleProfile): string {
  const grad = p.graduation
    ? new Date(`${p.graduation}-15T12:00:00Z`).toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : undefined;
  const degree = [
    p.degree === 'bachelor' ? 'B.S.' : p.degree === 'master' ? 'M.S.' : p.degree === 'phd' ? 'PhD' : p.degree,
    p.field,
  ]
    .filter(Boolean)
    .join(' ');
  return [
    PROFILE_LEVEL_WORDS[p.level],
    degree || undefined,
    p.school,
    grad ? `${p.level === 'student' ? 'graduating' : 'graduated'} ${grad}` : undefined,
  ]
    .filter(Boolean)
    .join(', ');
}
