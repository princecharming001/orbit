/**
 * Network search, end to end (plan 32 §6): lint the spec the chat model compiled, build the student's people as
 * documents, run the structured checks, let the judge settle what data could not, relax only on real nos, and keep
 * the result set so "more", "why her" and "only the ones in SF" work on it.
 */
import type { Person, User } from '@orbit/core';
import {
  compileSpec,
  evaluateDoc,
  hashString,
  type JudgedAnswer,
  lintSpec,
  type PersonDoc,
  type QuerySpec,
  type Row,
  type RunResult,
  relaxSteps,
  runSpec,
  shouldRelax,
} from '@orbit/core/search';
import MiniSearch from 'minisearch';
import { db } from '../../db/schema';
import { claudeReachable } from '../../integrations/anthropic';
import { callApi, isServerUser } from '../../integrations/orbitApi';
import { companyFacts, refreshFacets, refreshProfiles } from './data';
import { loadWorld, type SearchWorld } from './docs';
import { JUDGE_FIRST, judge, openQuestions } from './judge';
import { lookupsFor, runLookups } from './lookup';

export interface SearchRowView {
  personId: string;
  name: string;
  title?: string;
  company?: string;
  band: Row['band'];
  /** the strongest evidence behind the match, in the person's own words where possible */
  evidence?: string;
  /** what could not be checked ("class year not on file") */
  missing?: string;
  warmth: string;
  lastTalk?: string;
  /** the per-check detail for "why" */
  checks: { label: string; answer: string; evidence?: string }[];
}

export interface SearchSet {
  id: string;
  userId: string;
  ask: string;
  askHash: string;
  spec: QuerySpec;
  notes: string[];
  relaxed?: string;
  result: RunResult;
  judged: Map<string, Map<string, JudgedAnswer>>;
  judgedIds: Set<string>;
  judgeFailed: number;
  judgeUnavailable: boolean;
  /** LinkedIn profiles read while the student waited (plan 33) */
  profilesRead: number;
  at: number;
}

export interface SearchOutcome {
  ok: true;
  set: SearchSet;
  rows: SearchRowView[];
  /** listed rows not judged yet that the judge could settle ("check more") */
  remaining: number;
}

export type SearchFailure = { ok: false; reason: 'empty' | 'unknown_set'; message: string };

const sets = new Map<string, SearchSet>();
let seq = 0;
const MAX_SETS = 20;

export function getSet(id: string): SearchSet | undefined {
  return sets.get(id);
}

function keep(set: SearchSet): void {
  sets.set(set.id, set);
  if (sets.size > MAX_SETS) {
    const oldest = [...sets.values()].sort((a, b) => a.at - b.at)[0];
    if (oldest) sets.delete(oldest.id);
  }
}

/** BM25 over the documents' text, for keyword asks: scores by person id. */
function lexicalScores(docs: readonly PersonDoc[], terms: string[]): Map<string, number> {
  const ms = new MiniSearch<{ id: string; headline: string; title: string; org: string; rest: string }>({
    fields: ['headline', 'title', 'org', 'rest'],
    searchOptions: {
      boost: { headline: 2, title: 2, org: 1.5 },
      prefix: true,
      fuzzy: 0.1,
      combineWith: 'OR',
    },
  });
  ms.addAll(
    docs.map((d) => ({
      id: d.id,
      headline: d.text.headline,
      title: d.text.title,
      org: d.text.org,
      rest: `${d.text.summary} ${d.text.topics} ${d.text.tags} ${d.text.notes}`,
    })),
  );
  const out = new Map<string, number>();
  for (const r of ms.search(terms.join(' '))) out.set(String(r.id), r.score);
  return out;
}

const DAY = 86_400_000;
function lastTalkText(iso: string | undefined, now: number): string | undefined {
  if (!iso) return undefined;
  const days = Math.floor((now - Date.parse(iso)) / DAY);
  if (days < 1) return 'today';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

export function rowView(r: Row, people: Map<string, Person>, world: SearchWorld): SearchRowView {
  const p = people.get(r.id);
  const musts = r.checks.filter((c) => c.need === 'must');
  const passed = musts.filter((c) => (c.answer === 'yes' || c.answer === 'likely') && c.evidence);
  const best = passed.find((c) => c.answer === 'yes') ?? passed[0];
  const unknown = musts.filter((c) => c.answer === 'unknown');
  const missing = unknown.length
    ? unknown.map((c) => (c.missing ? `${c.missing} not on file` : `${c.label}: not on file`)).join('; ')
    : undefined;
  const rel = world.ctx.rel(r.id);
  return {
    personId: r.id,
    name: r.name,
    title: p?.currentTitle,
    company: p?.currentOrganizationRaw,
    band: r.band,
    evidence: best?.evidence?.slice(0, 160),
    missing,
    warmth: rel?.band ?? 'faint',
    lastTalk: lastTalkText(r.lastConversationAt, world.ctx.now),
    checks: r.checks.map((c) => ({ label: c.label, answer: c.answer, evidence: c.evidence?.slice(0, 160) })),
  };
}

const WARMTH_WORDS = /\b(talk to|reach out|intro|introduce|reconnect|help me|ask for|coffee|catch up)\b/i;

function needsTouches(spec: QuerySpec): boolean {
  return !!spec.relationship?.touched?.length;
}

/** The rows the judge should read next: likely first, then unchecked with a clue, in the order shown. */
function toJudge(set: SearchSet, docs: Map<string, PersonDoc>, limit: number) {
  const items: { doc: PersonDoc; questions: ReturnType<typeof openQuestions> }[] = [];
  for (const band of ['strong', 'likely', 'unchecked'] as const)
    for (const r of set.result.rows) {
      if (items.length >= limit) break;
      if (r.band !== band || set.judgedIds.has(r.id)) continue;
      const qs = openQuestions(r);
      const doc = docs.get(r.id);
      if (qs.length && doc) items.push({ doc, questions: qs });
    }
  return items;
}

function remainingFor(set: SearchSet): number {
  return set.result.rows.filter((r) => !set.judgedIds.has(r.id) && openQuestions(r).length).length;
}

async function judgeMore(
  set: SearchSet,
  world: SearchWorld,
  limit: number,
  signal?: AbortSignal,
): Promise<void> {
  const docs = new Map(world.docs.map((d) => [d.id, d]));
  const items = toJudge(set, docs, limit);
  if (!items.length) return;
  const out = await judge(set.userId, set.ask, items, signal, world.ctx.facts);
  for (const [id, m] of out.answers) {
    const merged = set.judged.get(id) ?? new Map<string, JudgedAnswer>();
    for (const [k, v] of m) merged.set(k, v);
    set.judged.set(id, merged);
  }
  for (const it of items) if (out.answers.has(it.doc.id)) set.judgedIds.add(it.doc.id);
  set.judgeFailed += out.failed;
  set.judgeUnavailable ||= !!out.unavailable;
}

function rerun(
  set: SearchSet,
  world: SearchWorld,
  lexical?: Map<string, number>,
  onlyIds?: Set<string>,
): void {
  set.result = runSpec(set.spec, world.docs, world.ctx, {
    lexical,
    judged: set.judged,
    warmthFirst: WARMTH_WORDS.test(set.ask),
    onlyIds,
  });
}

/** Profiles read at ask time per search, and how long a search waits for them. */
export const READ_NOW_MAX = 6;
const READ_NOW_MS = 22_000;
const READ_AGAIN_MS = 7 * DAY;

/**
 * Whether reading profiles could change this ask's answer: it asks something a headline rarely says (a company's
 * stage, size or industry, a past job, a time in a role) or something only words can answer (a criterion, keywords).
 */
export function readingHelps(spec: QuerySpec): boolean {
  if (spec.criteria?.length || spec.keywords?.terms.length) return true;
  return (spec.positions ?? []).some(
    (p) =>
      !!p.company?.stages?.length ||
      p.company?.sizeMin !== undefined ||
      p.company?.sizeMax !== undefined ||
      !!p.company?.industries?.length ||
      p.when === 'past' ||
      p.when === 'ever' ||
      p.startedWithinYears !== undefined ||
      p.endedWithinYears !== undefined,
  );
}

/** The listed people worth reading now: an open check a profile could settle, not read yet, best first. */
export function toRead(result: RunResult, world: SearchWorld, limit = READ_NOW_MAX): string[] {
  const docs = new Map(world.docs.map((d) => [d.id, d]));
  const out: string[] = [];
  for (const band of ['strong', 'likely', 'unchecked'] as const)
    for (const r of result.rows) {
      if (out.length >= limit) return out;
      if (r.band !== band) continue;
      const d = docs.get(r.id);
      const p = world.people.get(r.id);
      if (!d || d.profileRead || !(p?.linkedinMemberId || p?.linkedinSlug)) continue;
      const open = r.checks.some(
        (c) =>
          c.need === 'must' &&
          (c.answer === 'likely' || c.answer === 'unknown' || c.estimated) &&
          (c.key.startsWith('position:') || c.key.startsWith('criterion:') || c.key === 'keywords'),
      );
      if (open) out.push(r.id);
    }
  return out;
}

/**
 * Reads up to six people's LinkedIn profiles and their companies' pages now (an account's server-held LinkedIn), then
 * pulls what was read. Returns how many were read; 0 when nothing could be.
 */
async function readNow(userId: string, ids: string[], signal?: AbortSignal): Promise<number> {
  if (!ids.length || !isServerUser(userId) || signal?.aborted) return 0;
  const now = Date.now();
  const keys = ids.map((id) => `readAsked:${userId}:${id}`);
  const asked = await db.searchCache.bulkGet(keys);
  const todo = ids.filter((_, i) => !asked[i] || now - Date.parse(asked[i]!.at) > READ_AGAIN_MS);
  if (!todo.length) return 0;
  const at = new Date().toISOString();
  await db.searchCache.bulkPut(
    todo.map((id) => ({ key: `readAsked:${userId}:${id}`, userId, at, value: 1 })),
  );
  const r = await Promise.race([
    callApi('/search/read', { personIds: todo }).catch(() => undefined),
    new Promise<undefined>((res) => setTimeout(() => res(undefined), READ_NOW_MS)),
  ]);
  if (!r?.ok || !r.value.ok || !r.value.read.length) return 0;
  await Promise.all([
    refreshProfiles(userId, true).catch(() => null),
    companyFacts(userId, { force: true }).catch(() => undefined),
  ]);
  return r.value.read.length;
}

/**
 * Runs one ask. `caller: 'router'` means no model compiled it and none can judge it: criteria are dropped by lint.
 */
/** "My high school" when Orbit does not know it yet: said plainly, so the answer asks once instead of guessing. */
function ownSchoolNotes(spec: QuerySpec, ctx: SearchWorld['ctx']): string[] {
  const rel = spec.relationship;
  if (!rel?.alumOfMySchool) return [];
  const level = rel.mySchoolLevel;
  const known = level ? (ctx.mySchoolsByLevel?.[level] ?? []) : ctx.mySchools;
  if (known.length)
    return [
      `The student's ${level === 'high_school' ? 'high school' : level === 'graduate' ? 'graduate school' : 'school'}: ${known.join(', ')}.`,
    ];
  return [
    `Orbit does not know the student's ${level === 'high_school' ? 'high school' : 'school'} yet: their own LinkedIn profile has not been read (it is read once LinkedIn is connected). Ask for the school's name once, then search for it.`,
  ];
}

/** The student's own school, named: alumOfMySchool becomes a school by its name when Orbit knows which. */
function withOwnSchools(spec: QuerySpec, ctx: SearchWorld['ctx']): QuerySpec {
  const rel = spec.relationship;
  if (!rel?.alumOfMySchool) return spec;
  const level = rel.mySchoolLevel;
  const known = level ? (ctx.mySchoolsByLevel?.[level] ?? []) : ctx.mySchools;
  if (!known.length) return spec;
  const { alumOfMySchool: _a, mySchoolLevel: _l, ...restRel } = rel;
  return {
    ...spec,
    relationship: Object.keys(restRel).length ? restRel : undefined,
    schools: [...(spec.schools ?? []), { names: known }],
  };
}

export async function runNetworkSearch(
  user: Pick<User, 'id' | 'school'>,
  input: QuerySpec,
  opts: { caller?: 'llm' | 'router' | 'ui'; signal?: AbortSignal; shown?: number } = {},
): Promise<SearchOutcome | SearchFailure> {
  const linted = lintSpec(input, { router: opts.caller === 'router' });
  if (linted.error === 'empty')
    return {
      ok: false,
      reason: 'empty',
      message: 'Say who to look for: a role, company, school, place or topic.',
    };
  let spec = linted.spec;
  // what the server learned since the last search (census, lookups); never waits long
  await Promise.race([
    Promise.all([refreshFacets(user.id).catch(() => null), refreshProfiles(user.id).catch(() => null)]),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
  let world = await loadWorld(user, { touches: needsTouches(spec) });
  // "my high school": the school by its name, once known (their LinkedIn profile names it), so LinkedIn's lookups and
  // the steps beyond the network look for that school, not for people in general
  const ownNotes = ownSchoolNotes(spec, world.ctx);
  spec = withOwnSchools(spec, world.ctx);
  // what LinkedIn lists for the companies, schools and places the ask names (a few searches while the student waits)
  if (await runLookups(user, lookupsFor(compileSpec(spec, world.ctx)), opts.signal).catch(() => false))
    world = await loadWorld(user, { touches: needsTouches(spec) });
  world.ctx.noJudge = opts.caller === 'router' || !claudeReachable('chat', 'judge');
  const prev = spec.refine ? sets.get(spec.refine.resultSetId) : undefined;
  const onlyIds =
    prev && spec.refine?.onlyThese
      ? new Set(prev.result.rows.filter((r) => r.band !== 'no').map((r) => r.id))
      : undefined;
  let lexical = spec.keywords?.terms.length ? lexicalScores(world.docs, spec.keywords.terms) : undefined;
  const set: SearchSet = {
    id: `rs${++seq}`,
    userId: user.id,
    ask: spec.ask,
    askHash: hashString(JSON.stringify({ ...spec, ask: '', refine: undefined, lint: undefined })),
    spec,
    notes: [...linted.notes, ...ownNotes],
    result: runSpec(spec, world.docs, world.ctx, {
      lexical,
      onlyIds,
      warmthFirst: WARMTH_WORDS.test(spec.ask),
    }),
    judged: prev ? new Map(prev.judged) : new Map(),
    judgedIds: new Set(),
    judgeFailed: 0,
    judgeUnavailable: false,
    profilesRead: 0,
    at: Date.now(),
  };
  // read the profiles of the people a profile could settle, then look again with what they say
  if (opts.caller !== 'router' && readingHelps(spec)) {
    const read = await readNow(user.id, toRead(set.result, world), opts.signal).catch(() => 0);
    if (read) {
      set.profilesRead = read;
      world = await loadWorld(user, { touches: needsTouches(spec) });
      world.ctx.noJudge = !claudeReachable('chat', 'judge');
      lexical = spec.keywords?.terms.length ? lexicalScores(world.docs, spec.keywords.terms) : undefined;
      set.result = runSpec(spec, world.docs, world.ctx, {
        lexical,
        onlyIds,
        warmthFirst: WARMTH_WORDS.test(spec.ask),
      });
    }
  }
  // relax only when the network really said no (not when it is merely unchecked)
  if (shouldRelax(set.result)) {
    for (const step of relaxSteps(spec)) {
      const r = runSpec(step.spec, world.docs, world.ctx, { lexical, onlyIds });
      if (r.counts.strong + r.counts.likely > 0) {
        set.spec = step.spec;
        set.result = r;
        set.relaxed = step.label;
        break;
      }
    }
  }
  if (!world.ctx.noJudge) {
    await judgeMore(set, world, JUDGE_FIRST, opts.signal);
    rerun(set, world, lexical, onlyIds);
  }
  keep(set);
  worlds.set(set.id, { world, lexical, onlyIds });
  return {
    ok: true,
    set,
    rows: set.result.rows.slice(0, opts.shown ?? 25).map((r) => rowView(r, world.people, world)),
    remaining: remainingFor(set),
  };
}

const worlds = new Map<
  string,
  { world: SearchWorld; lexical?: Map<string, number>; onlyIds?: Set<string> }
>();

/** The people a kept set ran over, for the next rungs of an empty answer (ladder.ts). */
export function worldOfSet(setId: string): SearchWorld | undefined {
  return worlds.get(setId)?.world;
}

/** "Check more": judges the next people of a kept set and shows the next page. */
export async function moreOfSet(
  setId: string,
  opts: { page?: number; pageSize?: number; signal?: AbortSignal } = {},
): Promise<SearchOutcome | SearchFailure> {
  const set = sets.get(setId);
  const w = worlds.get(setId);
  if (!set || !w)
    return { ok: false, reason: 'unknown_set', message: 'That search is no longer open here. Ask it again.' };
  if (!w.world.ctx.noJudge) {
    await judgeMore(set, w.world, JUDGE_FIRST, opts.signal);
    rerun(set, w.world, w.lexical, w.onlyIds);
  }
  const size = opts.pageSize ?? 25;
  const page = opts.page ?? 1;
  return {
    ok: true,
    set,
    rows: set.result.rows
      .slice(page * size, page * size + size)
      .map((r) => rowView(r, w.world.people, w.world)),
    remaining: remainingFor(set),
  };
}

/**
 * One band of a kept set (Confirmed or Likely), for the card's tabs: the first page lists the confirmed matches first,
 * so the likely ones may not be on it at all. Undefined when the set is no longer open in this tab.
 */
export function bandOfSet(setId: string, band: 'strong' | 'likely', limit = 50): SearchRowView[] | undefined {
  const set = sets.get(setId);
  const w = worlds.get(setId);
  if (!set || !w) return undefined;
  return set.result.rows
    .filter((r) => r.band === band)
    .slice(0, limit)
    .map((r) => rowView(r, w.world.people, w.world));
}

/** Why one person is (or is not) in a kept set: every check with its evidence. */
export function explainInSet(setId: string, personId: string): SearchRowView | undefined {
  const set = sets.get(setId);
  const w = worlds.get(setId);
  if (!set || !w) return undefined;
  const row = set.result.rows.find((r) => r.id === personId);
  if (row) return rowView(row, w.world.people, w.world);
  // not listed: evaluate them alone to say which check said no
  const doc = w.world.docs.find((d) => d.id === personId);
  if (!doc) return undefined;
  const alone = evaluateDoc(doc, compileSpec(set.spec, w.world.ctx), w.world.ctx, { judged: set.judged });
  return rowView(alone, w.world.people, w.world);
}

/** Test hook. */
export function resetSearchSetsForTests(): void {
  sets.clear();
  worlds.clear();
  seq = 0;
}
