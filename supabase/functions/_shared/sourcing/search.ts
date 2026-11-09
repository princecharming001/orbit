/**
 * Sourcing (§6): find people for a goal across providers routed by goal kind (§6.1), merge and dedupe them (LinkedIn
 * URL / member id, email, then normalized name + org; Apollo's obfuscated last names match on the initial), relax
 * the query when nothing comes back (§6.5), and rank `0.45·fit + 0.35·reach + 0.20·responsiveness` (§6.2).
 * Returns rows shaped like `orbit.recommendations` (§11.3) plus the providers that had no key.
 */
import { type Apollo, type ApolloPeopleSearch, type ApolloPerson, apolloName } from '../providers/apollo';
import {
  type Exa,
  type ExaResult,
  type ExaSearchRequest,
  estimateExaSearchUsd,
  exaCostUsd,
} from '../providers/exa';
import { cacheKey, type ProviderResult } from '../providers/request';
import type { S2Author, SemanticScholar } from '../providers/semanticScholar';
import {
  cleanLinkedInUrl,
  hasSalesNavigator,
  linkedInPerson,
  linkedInSlugOf,
  type PeopleSearch,
  type SearchParameterType,
  type UnipileResearch,
} from '../providers/unipileResearch';
import type { BudgetDep, ClaudeDep, Clock } from '../research/deps';
import type { GoalKind } from '../research/dossier';
import { norm, normOrg, orgFromTitle } from '../research/guards';
import type { SharedCache, WebSource } from '../research/web';
import type { EmailConfidence } from './email';
import { FIT_BATCH, type FitCandidate, fitSchema, fitSystem, fitUser } from './prompts';
import { type Warmth, warmRank } from './warmth';
import { sourceFromWeb, type WebAsk, webAsk } from './web';

export type SourceName = 'unipile' | 'apollo' | 'exa' | 'semantic_scholar' | 'web';

export interface SourcingGoal {
  id: string | null;
  kind: GoalKind;
  title: string;
  /** what a good match looks like, in short phrases; drives fit */
  criteria: string[];
  /** target organizations (names) and their domains */
  orgs?: string[];
  domains?: string[];
  /** roles or titles sought */
  roles?: string[];
  skills?: string[];
  keywords?: string[];
  sector?: string;
  stage?: string;
  /** geography or city */
  location?: string;
  /** Apollo seniority values (director, vp, c_suite, manager, ...) */
  seniorities?: string[];
  /** Apollo employee ranges such as "1,10" */
  employeeRanges?: string[];
  pastCompanies?: string[];
  /** research or community topic */
  topic?: string;
  /** the school named in the ask (plan 31: the web provider reads its faculty pages) */
  school?: string;
}

export interface SourcingInput {
  userId: string;
  goal: SourcingGoal;
  user: { firstName: string; school?: string };
  /** the user's connected Unipile LinkedIn account */
  unipileAccountId?: string;
  /** whether the account has a Sales Navigator seat; detected from GET /users/me when undefined */
  salesNavigator?: boolean;
  /** rows to return, default 50 */
  limit?: number;
}

export interface Candidate {
  key: string;
  entity: 'person' | 'organization';
  name: string;
  firstName?: string;
  lastName?: string;
  lastNameObfuscated?: boolean;
  title?: string;
  org?: string;
  headline?: string;
  location?: string;
  linkedinUrl?: string;
  memberId?: string;
  email?: string;
  /** how the email was found: on a page, from the company's pattern, or a guess (email.ts) */
  emailConfidence?: EmailConfidence;
  /** the company domains the search knew them by, kept so a lookup later can use them (ondemand.ts) */
  domains?: string[];
  /** a paid lookup ran for them (plan 35 C3); without it and without an email, nobody has looked yet */
  emailLookedUp?: boolean;
  /** how warm the student is to them, in five tiers (warmth.ts) */
  warmth?: Warmth;
  url?: string;
  /** what a first message can be written from (plan 31): what they work on, the lab, the page it came from */
  evidence?: string[];
  networkDistance?: number;
  sources: SourceName[];
  externalIds: Partial<Record<SourceName, string>>;
}

export interface FitScore {
  fit: number;
  reasons: string[];
}

export type FitScorer = (
  goal: SourcingGoal,
  user: { firstName: string },
  candidates: Candidate[],
) => Promise<Map<string, FitScore>>;

export interface SourcingDeps {
  unipile: UnipileResearch;
  apollo: Apollo;
  exa: Exa;
  semanticScholar: SemanticScholar;
  /** used by the default fit scorer (Haiku, 20 per call) */
  claude?: ClaudeDep;
  /** overrides the default fit scorer */
  fitScorer?: FitScorer;
  /** the public web, for asks that name a place (plan 31): Exa, then Claude's own search; none means no web */
  web?: WebSource[];
  /** plain page fetches for the web provider's profile pass */
  fetch?: typeof fetch;
  /** best path P to the candidate (§4), or null when there is none */
  reachOf: (c: Candidate) => Promise<number | null> | number | null;
  /** the existing responsePrior, 0..1 */
  responsiveness: (c: Candidate) => Promise<number> | number;
  /** the person, when the user already knows them (resolution §2) */
  knownPerson?: (c: Candidate) => Promise<{ personId: string; score?: number } | null>;
  /** already in the pipeline for this goal: dropped */
  inPipeline?: (c: Candidate) => Promise<boolean>;
  /** the warmth tier from the student's own context (warmth.ts); without it every candidate ranks as before */
  warmthOf?: (c: Candidate, known: { personId: string; score?: number } | null) => Warmth;
  /** fills emails for the best candidates who have none (email.ts) */
  fillEmails?: (cands: Candidate[]) => Promise<void>;
  /** one pass over every candidate before ranking, alongside fit: who is known, which orgs have a domain (run.ts) */
  prefetch?: (cands: Candidate[]) => Promise<void>;
  budget?: BudgetDep;
  /**
   * The research cache shared by every student (plan 34 B2): Exa and Apollo searches 7 days, Semantic Scholar 30
   * days, LinkedIn search parameter ids 30 days; the same ask from anyone is asked once.
   */
  cache?: SharedCache;
  clock: Clock;
  newId?: () => string;
}

const DAY_MS = 86_400_000;
export const SOURCING_CACHE_TTL = {
  exa: 7 * DAY_MS,
  apollo: 7 * DAY_MS,
  scholar: 30 * DAY_MS,
  searchParameters: 30 * DAY_MS,
} as const;

/**
 * A provider call through the shared cache: a hit is the stored answer, a miss calls and keeps an ok answer. `call`
 * may answer null (it chose not to call, such as over a budget): nothing is kept then.
 */
async function cachedCall<T>(
  ctx: Ctx,
  kind: string,
  req: unknown,
  ttlMs: number,
  call: () => Promise<ProviderResult<T> | null>,
): Promise<ProviderResult<T> | null> {
  const cache = ctx.deps.cache;
  if (!cache) return call();
  const key = await cacheKey(kind, req);
  const hit = await cache.get(key).catch(() => undefined);
  if (hit !== undefined && hit !== null) return { ok: true, value: hit as T };
  const r = await call();
  if (r?.ok) await cache.put(key, kind, r.value, ttlMs).catch(() => undefined);
  return r;
}

/** An `orbit.recommendations` row (§11.3) without id and timestamps. */
export interface RecommendationRow {
  user_id: string;
  goal_id: string | null;
  person_id: string | null;
  candidate: Omit<Candidate, 'key'>;
  source: string;
  external_id: string | null;
  rank: number;
  fit: number;
  reach: number;
  responsiveness: number;
  reasons: string[];
  status: 'new';
  batch_id: string;
}

export interface SourcingResult {
  results: RecommendationRow[];
  unconfigured: string[];
  /** what was dropped from the query to find anyone, in order; `place` means the web was searched by subject alone */
  relaxed: ('location' | 'seniority' | 'place')[];
  /** the student's school stood in for a place the ask did not name */
  assumedPlace?: string;
  /** providers that answered with an error (the others still count) */
  errors: string[];
  /** what the web pass did (plan 31), for the log */
  notes: string[];
  batchId: string;
}

export const WEIGHTS = { fit: 0.45, reach: 0.35, responsiveness: 0.2 };
/** reach is computed for this many candidates, best fit first (§6.2) */
export const REACH_TOP = 30;
/** LinkedIn search: stop at 100 results per search (§6.5) */
export const LINKEDIN_MAX_RESULTS = 100;
const LINKEDIN_PAGES = 3;
/** candidates sent to fit scoring at most (5 Haiku calls) */
const MAX_SCORED = 100;

interface Relax {
  location: boolean;
  seniority: boolean;
  /** the web may be searched with no place at all */
  place: boolean;
}

interface Ctx {
  deps: SourcingDeps;
  input: SourcingInput;
  unconfigured: Set<string>;
  errors: Set<string>;
  /** what the web pass did, for the log */
  notes: Set<string>;
  idCache: Map<string, string | undefined>;
  salesNav?: boolean;
  seq: number;
  /** some provider was configured and called (relaxing a query nobody ran is pointless) */
  ran: boolean;
  /** the student's school stood in for a place the ask did not name */
  assumedPlace?: string;
  /** the web's answer per ask, so a relaxed pass does not read the same pages twice */
  webDone: Map<string, Candidate[]>;
}

type Call = (relax: Relax) => Promise<Candidate[]>;

/** Search, merge, rank. Never throws for a missing key: the provider is listed in `unconfigured` instead. */
export async function sourcePeople(deps: SourcingDeps, input: SourcingInput): Promise<SourcingResult> {
  const ctx: Ctx = {
    deps,
    input,
    unconfigured: new Set(),
    errors: new Set(),
    notes: new Set(),
    idCache: new Map(),
    seq: 0,
    ran: false,
    webDone: new Map(),
  };
  const batchId = deps.newId?.() ?? crypto.randomUUID();
  const calls = plan(ctx);
  const relax: Relax = { location: false, seniority: false, place: false };
  const relaxed: SourcingResult['relaxed'] = [];

  let merged = await gather(calls, relax);
  const g = input.goal;
  const canDropLocation = !!g.location;
  const canDropSeniority = !!g.seniorities?.length;
  if (merged.length === 0 && canDropLocation && ctx.ran) {
    relax.location = true;
    relaxed.push('location');
    merged = await gather(calls, relax);
  }
  if (merged.length === 0 && canDropSeniority && ctx.ran) {
    relax.seniority = true;
    relaxed.push('seniority');
    merged = await gather(calls, relax);
  }
  // nobody anywhere and no place to search: the web by the subject alone, the last pass (a named or assumed place
  // was searched already in the passes above)
  if (
    merged.length === 0 &&
    deps.web?.length &&
    !askFor(ctx, relax) &&
    askFor(ctx, { ...relax, place: true })
  ) {
    relax.place = true;
    relaxed.push('place');
    // only the web changes in this pass: the other providers already answered
    merged = await gather([(r) => webCall(ctx, r)], relax);
  }

  // dedupe against the pipeline for this goal
  if (deps.inPipeline) {
    const keep: Candidate[] = [];
    for (const c of merged) if (!(await deps.inPipeline(c))) keep.push(c);
    merged = keep;
  }

  const rows = await rank(ctx, merged.slice(0, MAX_SCORED), batchId);
  return {
    results: rows.slice(0, input.limit ?? 50),
    unconfigured: [...ctx.unconfigured].sort(),
    relaxed,
    ...(ctx.assumedPlace ? { assumedPlace: ctx.assumedPlace } : {}),
    errors: [...ctx.errors].sort(),
    notes: [...ctx.notes],
    batchId,
  };
}

async function gather(calls: Call[], relax: Relax): Promise<Candidate[]> {
  const lists = await Promise.all(calls.map((c) => c(relax)));
  return mergeCandidates(lists.flat());
}

// ---- routing (§6.1) -----------------------------------------------------------------------------------------

function plan(ctx: Ctx): Call[] {
  const g = ctx.input.goal;
  const roles = g.roles ?? [];
  const words = (...xs: (string | undefined)[]) => xs.filter((x) => x?.trim()).join(' ');
  const exaPeople =
    (q: string, extra: Partial<ExaSearchRequest> = {}): Call =>
    (r) =>
      exaCall(ctx, { query: q, category: 'people', ...extra }, r, 'person');
  // the public pages of a place (plan 31): the one named, the student's school for advice and collaboration, and by
  // the subject alone only as the last pass (webCall decides from `relax`)
  const web: Call[] = [(r) => webCall(ctx, r)];
  switch (g.kind) {
    case 'recruiting':
    case 'advice':
      return [
        ...web,
        (r) =>
          linkedInCall(ctx, r, {
            keywords: orJoin(roles) || g.keywords?.join(' '),
            companies: g.orgs,
            school: ctx.input.user.school,
            distance: [2, 3],
          }),
        (r) =>
          apolloCall(ctx, r, {
            person_titles: roles.length ? roles : undefined,
            q_organization_domains_list: g.domains?.length ? g.domains : undefined,
            q_keywords: g.domains?.length
              ? g.keywords?.join(' ')
              : words(...(g.orgs ?? []), ...(g.keywords ?? [])),
          }),
      ];
    case 'fundraising':
      return [
        ...web,
        exaPeople(
          words(
            roles[0] ?? 'partner',
            `at a ${words(g.stage) || 'venture'} fund investing in`,
            g.sector ?? g.keywords?.join(' '),
          ),
          {},
        ),
        (r) =>
          exaCall(
            ctx,
            {
              query: words(g.stage, 'venture fund investing in', g.sector ?? g.keywords?.join(' ')),
              category: 'company',
            },
            r,
            'organization',
          ),
        (r) =>
          apolloCall(ctx, r, {
            person_titles: ['Partner', 'Principal', 'General Partner', 'Investor'],
            q_keywords: words(g.sector, g.stage, ...(g.keywords ?? [])) || undefined,
          }),
      ];
    case 'sales':
      return [
        ...web,
        (r) =>
          apolloCall(ctx, r, {
            person_titles: roles.length ? roles : undefined,
            organization_num_employees_ranges: g.employeeRanges,
            q_keywords: words(g.sector, ...(g.keywords ?? [])) || undefined,
            q_organization_domains_list: g.domains?.length ? g.domains : undefined,
          }),
      ];
    case 'hiring': {
      const calls: Call[] = [
        ...web,
        (r) =>
          linkedInCall(ctx, r, {
            keywords: words(orJoin(roles), ...(g.skills ?? [])),
            pastCompanies: g.pastCompanies,
            school: ctx.input.user.school,
            distance: [2, 3],
          }),
        exaPeople(words(roles[0], ...(g.skills ?? []))),
      ];
      if (roles.some((x) => /engineer|developer|programmer|software|ml|data scientist/i.test(x)))
        calls.push((r) =>
          exaCall(
            ctx,
            { query: words(roles[0], ...(g.skills ?? [])), includeDomains: ['github.com'] },
            r,
            'person',
          ),
        );
      return calls;
    }
    case 'cofounder':
      return [
        ...web,
        exaPeople(words(...(g.skills ?? []), g.topic, 'founder')),
        (r) => linkedInCall(ctx, r, { keywords: words(...(g.skills ?? []), g.topic), distance: [2] }),
      ];
    case 'collaboration':
      return [
        ...web,
        (r) => scholarCall(ctx, r),
        (r) =>
          exaCall(
            ctx,
            { query: words(g.topic, ...(g.keywords ?? [])), category: 'publication' },
            r,
            'person',
          ),
      ];
    case 'community':
      return [
        (r) => linkedInCall(ctx, r, { keywords: words(g.topic, ...(g.keywords ?? [])), distance: [1, 2] }),
        ...web,
      ];
  }
}

function orJoin(xs: string[]): string {
  return xs.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' OR ');
}

function locationOf(ctx: Ctx, relax: Relax): string | undefined {
  return relax.location ? undefined : ctx.input.goal.location;
}

function note(ctx: Ctx, r: ProviderResult<unknown>): boolean {
  if (r.ok || r.kind !== 'unconfigured') ctx.ran = true;
  if (r.ok) return true;
  if (r.kind === 'unconfigured') ctx.unconfigured.add(r.provider);
  else ctx.errors.add(`${r.provider}: ${r.message}`);
  return false;
}

// ---- providers ----------------------------------------------------------------------------------------------

/**
 * What the web is asked for: the place the ask names; for advice and collaboration with none named, the student's own
 * school (its people share the student's background, warmth tier 3); with `relax.place`, the subject alone.
 */
function askFor(ctx: Ctx, relax: Relax): WebAsk | undefined {
  const g = ctx.input.goal;
  const named = webAsk(g);
  if (named) return named;
  if ((g.kind === 'advice' || g.kind === 'collaboration') && ctx.input.user.school) {
    const own = webAsk(g, { fallbackPlace: ctx.input.user.school });
    if (own) return own;
  }
  return relax.place ? webAsk(g, { broad: true }) : undefined;
}

/** The web provider (plan 31): the place's faculty or team pages, read for the people they name. */
async function webCall(ctx: Ctx, relax: Relax): Promise<Candidate[]> {
  const { deps, input } = ctx;
  const ask = askFor(ctx, relax);
  if (!ask) return [];
  // no web wired at all (a caller that never built one): nothing to say; wired but keyless: the student is told
  if (!deps.web) return [];
  if (!deps.web.length) {
    ctx.unconfigured.add('web');
    return [];
  }
  ctx.ran = true;
  if (ask.assumedPlace) {
    ctx.assumedPlace = ask.place;
    ctx.notes.add(`web: no place named, searched ${ask.place}`);
  }
  if (ask.broad) ctx.notes.add('web: no place named, searched by subject alone');
  const askKey = JSON.stringify(ask);
  const done = ctx.webDone.get(askKey);
  if (done) return done;
  try {
    const r = await sourceFromWeb({
      ask,
      sources: deps.web,
      claude: deps.claude,
      budget: deps.budget,
      userId: input.userId,
      nextKey: () => `c${++ctx.seq}`,
      clock: deps.clock,
      fetch: deps.fetch,
    });
    for (const n of r.notes) ctx.notes.add(`web: ${n}`);
    if (!r.candidates.length && r.notes.some((n) => /budget_exceeded/.test(n)))
      ctx.errors.add('web: budget_exceeded');
    ctx.webDone.set(askKey, r.candidates);
    return r.candidates;
  } catch (e) {
    ctx.errors.add(`web: ${e instanceof Error ? e.message : 'failed'}`);
    return [];
  }
}

async function exaCall(
  ctx: Ctx,
  base: Omit<ExaSearchRequest, 'numResults' | 'type' | 'contents'>,
  relax: Relax,
  entity: Candidate['entity'],
): Promise<Candidate[]> {
  const { deps, input } = ctx;
  if (!deps.exa.configured) {
    // Exa is optional once the web search is on (it finds the same pages): only say so when neither is
    if (!deps.web?.length) ctx.unconfigured.add('exa');
    return [];
  }
  const loc = locationOf(ctx, relax);
  const req: ExaSearchRequest = {
    ...base,
    query: loc && entity === 'person' ? `${base.query} ${loc}` : base.query,
    type: 'auto',
    numResults: 10,
    contents: { highlights: { query: input.goal.title, maxCharacters: 600 } },
  };
  const est = estimateExaSearchUsd(req);
  let refused = false;
  const r = await cachedCall(ctx, 'sourcing:exa', req, SOURCING_CACHE_TTL.exa, async () => {
    if (deps.budget && !(await deps.budget.check(input.userId, 'exa', est)).ok) {
      refused = true;
      return null;
    }
    const got = await deps.exa.search(req);
    if (got.ok)
      await deps.budget?.record(input.userId, {
        provider: 'exa',
        operation: 'search',
        units: 1,
        costUsd: exaCostUsd(got.value, est),
      });
    return got;
  });
  if (refused || !r) {
    ctx.errors.add('exa: budget_exceeded');
    return [];
  }
  if (!note(ctx, r) || !r.ok) return [];
  return r.value.results.map((x) => fromExa(ctx, x, entity)).filter((c): c is Candidate => !!c);
}

function fromExa(ctx: Ctx, r: ExaResult, entity: Candidate['entity']): Candidate | null {
  const title = (r.title ?? '').replace(/\s*[|·]\s*linkedin.*$/i, '').trim();
  const parts = title.split(/\s+[-–—|·]\s+/).map((p) => p.trim());
  const name = (entity === 'person' ? (parts[0] ?? r.author ?? '') : (parts[0] ?? '')).trim();
  if (!name) return null;
  const org = entity === 'person' ? orgFromTitle(r.title, name) : undefined;
  const role = entity === 'person' && parts.length >= 3 ? parts[1] : undefined;
  const linkedinUrl = cleanLinkedInUrl(r.url);
  return {
    key: `c${++ctx.seq}`,
    entity,
    name,
    ...splitName(name),
    title: role?.replace(/\s+at\s+.+$/i, ''),
    org,
    headline: (r.highlights?.[0] ?? '').slice(0, 300) || undefined,
    linkedinUrl,
    url: r.url,
    sources: ['exa'],
    externalIds: { exa: r.id ?? r.url },
  };
}

async function apolloCall(ctx: Ctx, relax: Relax, params: ApolloPeopleSearch): Promise<Candidate[]> {
  const { deps, input } = ctx;
  if (!deps.apollo.configured) {
    ctx.unconfigured.add('apollo');
    return [];
  }
  const loc = locationOf(ctx, relax);
  const g = input.goal;
  const req: ApolloPeopleSearch = {
    ...params,
    person_locations: loc ? [loc] : undefined,
    person_seniorities: !relax.seniority && g.seniorities?.length ? g.seniorities : undefined,
    per_page: 25,
    page: 1,
  };
  const r = await cachedCall(ctx, 'sourcing:apollo', req, SOURCING_CACHE_TTL.apollo, () =>
    deps.apollo.searchPeople(req),
  );
  if (!r || !note(ctx, r) || !r.ok) return [];
  return r.value.people.map((p) => fromApollo(ctx, p));
}

function fromApollo(ctx: Ctx, p: ApolloPerson): Candidate {
  const n = apolloName(p);
  const name = `${n.first} ${n.last}`.trim();
  return {
    key: `c${++ctx.seq}`,
    entity: 'person',
    name,
    firstName: n.first,
    lastName: n.last,
    lastNameObfuscated: n.obfuscated,
    title: p.title ?? undefined,
    org: p.organization?.name ?? undefined,
    headline: p.headline ?? undefined,
    location: [p.city, p.state, p.country].filter(Boolean).join(', ') || undefined,
    linkedinUrl: cleanLinkedInUrl(p.linkedin_url),
    sources: ['apollo'],
    externalIds: { apollo: p.id },
  };
}

async function paramId(ctx: Ctx, type: SearchParameterType, keywords: string): Promise<string | undefined> {
  const k = `${type}:${norm(keywords)}`;
  if (ctx.idCache.has(k)) return ctx.idCache.get(k);
  // a company's or school's LinkedIn id is the same for every account: shared for 30 days
  const r = await cachedCall(
    ctx,
    'sourcing:li_param',
    { type, keywords: norm(keywords) },
    SOURCING_CACHE_TTL.searchParameters,
    () => ctx.deps.unipile.searchParameters(ctx.input.unipileAccountId!, type, keywords, { limit: 1 }),
  );
  const id = r?.ok ? r.value[0]?.id : undefined;
  ctx.idCache.set(k, id);
  return id;
}

async function linkedInCall(
  ctx: Ctx,
  relax: Relax,
  q: {
    keywords?: string;
    companies?: string[];
    pastCompanies?: string[];
    school?: string;
    distance: (1 | 2 | 3)[];
  },
): Promise<Candidate[]> {
  const { deps, input } = ctx;
  if (!deps.unipile.configured || !input.unipileAccountId) {
    ctx.unconfigured.add('unipile');
    return [];
  }
  const accountId = input.unipileAccountId;
  if (deps.budget) {
    const v = await deps.budget.check(input.userId, 'unipile_search', 1);
    if (!v.ok) {
      ctx.errors.add('unipile: daily search cap reached');
      return [];
    }
  }
  if (ctx.salesNav === undefined) {
    if (input.salesNavigator !== undefined) ctx.salesNav = input.salesNavigator;
    else {
      const me = await deps.unipile.me(accountId);
      ctx.salesNav = me.ok ? hasSalesNavigator(me.value) : false;
    }
  }
  const loc = locationOf(ctx, relax);
  const ids = async (type: SearchParameterType, names: string[] | undefined) =>
    (await Promise.all((names ?? []).slice(0, 3).map((n) => paramId(ctx, type, n)))).filter(
      (x): x is string => !!x,
    );
  const locationIds = loc ? await ids('LOCATION', [loc]) : [];
  const schoolIds = q.school ? await ids('SCHOOL', [q.school]) : [];
  let body: PeopleSearch;
  if (ctx.salesNav) {
    const g = input.goal;
    body = {
      api: 'sales_navigator',
      category: 'people',
      keywords: q.keywords || undefined,
      network_distance: q.distance,
      company: q.companies?.length ? { include: q.companies } : undefined,
      past_company: q.pastCompanies?.length ? { include: q.pastCompanies } : undefined,
      role: g.roles?.length ? { include: g.roles } : undefined,
      school: schoolIds.length ? { include: schoolIds } : undefined,
      location: locationIds.length ? { include: locationIds } : undefined,
    };
  } else {
    const companyIds = await ids('COMPANY', q.companies);
    const pastIds = await ids('COMPANY', q.pastCompanies);
    body = {
      api: 'classic',
      category: 'people',
      keywords: q.keywords || undefined,
      network_distance: q.distance,
      company: companyIds.length ? companyIds : undefined,
      past_company: pastIds.length ? pastIds : undefined,
      school: schoolIds.length ? schoolIds : undefined,
      location: locationIds.length ? locationIds : undefined,
    };
  }
  const out: Candidate[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LINKEDIN_PAGES && out.length < LINKEDIN_MAX_RESULTS; page++) {
    const r = await deps.unipile.searchPeople(accountId, body, { cursor });
    if (!note(ctx, r) || !r.ok) break;
    for (const item of r.value.items) {
      if (item.type && item.type !== 'PEOPLE') continue;
      const p = linkedInPerson(item);
      if (!p.name) continue;
      const h = p.headline ?? '';
      const at = h.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
      out.push({
        key: `c${++ctx.seq}`,
        entity: 'person',
        name: p.name,
        ...splitName(p.name),
        title: at?.[1]?.trim(),
        org: at?.[2]?.trim(),
        headline: p.headline,
        location: p.location,
        linkedinUrl: p.linkedinUrl,
        memberId: p.memberId,
        networkDistance: p.networkDistance,
        sources: ['unipile'],
        externalIds: p.memberId ? { unipile: p.memberId } : {},
      });
    }
    cursor = r.value.cursor ?? undefined;
    if (!cursor) break;
  }
  await deps.budget?.record(input.userId, {
    provider: 'unipile_search',
    operation: 'search',
    units: 1,
    costUsd: 0,
  });
  return out.slice(0, LINKEDIN_MAX_RESULTS);
}

async function scholarCall(ctx: Ctx, _relax: Relax): Promise<Candidate[]> {
  const { deps, input } = ctx;
  if (!deps.semanticScholar.configured) {
    ctx.unconfigured.add('semantic_scholar');
    return [];
  }
  const g = input.goal;
  const q = [g.topic, ...(g.keywords ?? [])].filter(Boolean).join(' ');
  const r = await cachedCall(ctx, 'sourcing:s2_papers', { q, limit: 50 }, SOURCING_CACHE_TTL.scholar, () =>
    deps.semanticScholar.searchPapers(q, { limit: 50 }),
  );
  if (!r || !note(ctx, r) || !r.ok) return [];
  const counts = new Map<string, { name: string; n: number; latest: number }>();
  for (const p of r.value.data)
    for (const a of p.authors ?? []) {
      if (!a.authorId || !a.name) continue;
      const c = counts.get(a.authorId) ?? { name: a.name, n: 0, latest: 0 };
      c.n++;
      c.latest = Math.max(c.latest, p.year ?? 0);
      counts.set(a.authorId, c);
    }
  const top = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || b[1].latest - a[1].latest).slice(0, 10);
  const authors = await Promise.all(
    top.map(([id]) =>
      cachedCall(ctx, 'sourcing:s2_author', { id }, SOURCING_CACHE_TTL.scholar, () =>
        deps.semanticScholar.author(id),
      ),
    ),
  );
  return top.map(([id, c], i) => {
    const got = authors[i];
    const a: S2Author | undefined = got?.ok ? got.value : undefined;
    const name = a?.name ?? c.name;
    return {
      key: `c${++ctx.seq}`,
      entity: 'person' as const,
      name,
      ...splitName(name),
      title: 'Researcher',
      org: a?.affiliations?.[0],
      headline: a
        ? `${a.paperCount ?? '?'} papers · h-index ${a.hIndex ?? '?'} · ${c.n} on this topic`
        : `${c.n} papers on this topic`,
      url: a?.homepage ?? a?.url ?? undefined,
      sources: ['semantic_scholar' as const],
      externalIds: { semantic_scholar: id },
    };
  });
}

// ---- merge and dedupe ---------------------------------------------------------------------------------------

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') };
}

const nameKey = (s: string | undefined) =>
  norm(s)
    .replace(/[^a-z0-9 ]/g, '')
    .trim();

function strongKeys(c: Candidate): string[] {
  const keys: string[] = [];
  const slug = linkedInSlugOf(c.linkedinUrl);
  if (slug) keys.push(`li:${slug}`);
  if (c.memberId) keys.push(`mid:${c.memberId}`);
  if (c.email) keys.push(`em:${c.email.toLowerCase()}`);
  if (!c.lastNameObfuscated && c.org && c.lastName)
    keys.push(`no:${nameKey(c.firstName)}|${nameKey(c.lastName)}|${normOrg(c.org)}`);
  if (c.entity === 'organization') keys.push(`org:${normOrg(c.name)}`);
  return keys;
}

function looseKey(c: Candidate): string | undefined {
  if (c.entity !== 'person' || !c.org || !c.firstName || !c.lastName) return undefined;
  const initial = nameKey(c.lastName).charAt(0);
  return initial ? `lo:${nameKey(c.firstName)}|${initial}|${normOrg(c.org)}` : undefined;
}

function mergeInto(into: Candidate, c: Candidate): void {
  if (into.lastNameObfuscated && !c.lastNameObfuscated && c.lastName) {
    into.name = c.name;
    into.firstName = c.firstName;
    into.lastName = c.lastName;
    into.lastNameObfuscated = false;
  }
  for (const k of [
    'title',
    'org',
    'headline',
    'location',
    'linkedinUrl',
    'memberId',
    'email',
    'url',
  ] as const)
    if (!into[k] && c[k]) into[k] = c[k];
  if (c.networkDistance !== undefined)
    into.networkDistance = Math.min(into.networkDistance ?? c.networkDistance, c.networkDistance);
  for (const s of c.sources) if (!into.sources.includes(s)) into.sources.push(s);
  into.externalIds = { ...c.externalIds, ...into.externalIds };
}

/** Merge candidates that are the same person: LinkedIn URL / member id, email, name + org (initial for Apollo). */
export function mergeCandidates(cands: Candidate[]): Candidate[] {
  const groups: Candidate[] = [];
  const strong = new Map<string, number>();
  const looseFull = new Map<string, number>();
  const looseObf = new Map<string, number>();
  for (const c of cands) {
    const keys = strongKeys(c);
    const loose = looseKey(c);
    let gi: number | undefined;
    for (const k of keys) {
      gi = strong.get(k);
      if (gi !== undefined) break;
    }
    if (gi === undefined && loose) {
      const found = c.lastNameObfuscated
        ? (looseFull.get(loose) ?? looseObf.get(loose))
        : looseObf.get(loose);
      if (found !== undefined && found >= 0) gi = found;
    }
    if (gi === undefined) {
      groups.push({ ...c, sources: [...c.sources], externalIds: { ...c.externalIds } });
      gi = groups.length - 1;
    } else mergeInto(groups[gi]!, c);
    for (const k of [...keys, ...strongKeys(groups[gi]!)]) if (!strong.has(k)) strong.set(k, gi);
    if (loose) {
      // two different people on one initial (Jane Doe, Jane Dunn) make the initial useless: -1 marks it ambiguous
      const map = c.lastNameObfuscated ? looseObf : looseFull;
      const prev = map.get(loose);
      map.set(loose, prev === undefined || prev === gi ? gi : -1);
    }
  }
  return groups;
}

// ---- fit ----------------------------------------------------------------------------------------------------

const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'who',
  'that',
  'are',
  'from',
  'into',
  'any',
  'has',
  'have',
  'a',
  'an',
  'of',
  'in',
  'at',
  'on',
  'or',
  'to',
]);

function candidateText(c: Candidate): string {
  return norm(
    [c.name, c.title, c.org, c.headline, c.location, ...(c.evidence ?? [])].filter(Boolean).join(' '),
  );
}

/** Rule fallback (§6.2): the share of criteria whose words mostly appear in the candidate's fields. */
export function keywordFit(goal: SourcingGoal, c: Candidate): FitScore {
  const criteria = goal.criteria.length
    ? goal.criteria
    : [...(goal.roles ?? []), ...(goal.orgs ?? []), goal.sector, ...(goal.skills ?? []), goal.topic].filter(
        (x): x is string => !!x,
      );
  if (criteria.length === 0) return { fit: 0.5, reasons: [] };
  const text = candidateText(c);
  const matched = criteria.filter((cr) => {
    const ws = norm(cr)
      .split(/[^a-z0-9+#]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w));
    if (ws.length === 0) return false;
    const hits = ws.filter((w) => text.includes(w)).length;
    return hits >= Math.ceil(ws.length / 2);
  });
  return {
    fit: matched.length / criteria.length,
    reasons: matched.slice(0, 2).map((m) => `Matches "${m}"`),
  };
}

/** The default scorer: Haiku in batches of 20 (§6.2), the keyword rule for any batch or candidate it misses. */
export function llmFitScorer(claude: ClaudeDep): FitScorer {
  return async (goal, user, cands) => {
    const out = new Map<string, FitScore>();
    for (let i = 0; i < cands.length; i += FIT_BATCH) {
      const batch = cands.slice(i, i + FIT_BATCH);
      const payload: FitCandidate[] = batch.map((c) => ({
        id: c.key,
        name: c.name,
        title: c.title,
        org: c.org,
        location: c.location,
        headline: c.headline,
        evidence: c.evidence?.slice(0, 3),
        source: c.sources.join('+'),
      }));
      const r = await claude.parse('sourcing_fit', fitSchema, {
        system: fitSystem(user.firstName),
        user: fitUser({ title: goal.title, criteria: goal.criteria }, payload),
      });
      if (r.ok)
        for (const s of r.value.scores) {
          if (!batch.some((c) => c.key === s.id)) continue;
          const fit = Number.isFinite(s.fit) ? Math.max(0, Math.min(1, s.fit)) : 0;
          out.set(s.id, { fit, reasons: s.reasons.slice(0, 2) });
        }
      for (const c of batch) if (!out.has(c.key)) out.set(c.key, keywordFit(goal, c));
    }
    return out;
  };
}

// ---- rank (§6.2) --------------------------------------------------------------------------------------------

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

async function rank(ctx: Ctx, cands: Candidate[], batchId: string): Promise<RecommendationRow[]> {
  const { deps, input } = ctx;
  if (cands.length === 0) return [];
  const scorer: FitScorer =
    deps.fitScorer ??
    (deps.claude
      ? llmFitScorer(deps.claude)
      : async (g, _u, cs) => new Map(cs.map((c) => [c.key, keywordFit(g, c)])));
  // who is already known and which orgs have a domain load while Haiku scores fit
  const [fits] = await Promise.all([
    scorer(input.goal, input.user, cands),
    deps.prefetch?.(cands).catch(() => undefined),
  ]);
  const fitOf = (c: Candidate) => fits.get(c.key) ?? keywordFit(input.goal, c);
  const byFit = [...cands].sort((a, b) => fitOf(b).fit - fitOf(a).fit);
  const reachTop = new Set(byFit.slice(0, REACH_TOP).map((c) => c.key));
  if (deps.fillEmails) await deps.fillEmails(byFit.slice(0, 60)).catch(() => undefined);

  const rows: RecommendationRow[] = [];
  for (const c of byFit) {
    const f = fitOf(c);
    const p = reachTop.has(c.key) ? await deps.reachOf(c) : null;
    const reach = typeof p === 'number' && p > 0 ? Math.min(1, p) : c.networkDistance === 2 ? 0.05 : 0;
    const responsiveness = Math.max(0, Math.min(1, await deps.responsiveness(c)));
    const known = deps.knownPerson ? await deps.knownPerson(c) : null;
    const reasons = [...f.reasons];
    const warmth = deps.warmthOf?.(c, known);
    if (warmth) c.warmth = warmth;
    if (warmth?.why) reasons.unshift(warmth.why);
    else if (known)
      reasons.unshift(known.score !== undefined ? `You know them (${known.score})` : 'You know them');
    else if (c.networkDistance === 2) reasons.push('2nd-degree on LinkedIn');
    const base = WEIGHTS.fit * f.fit + WEIGHTS.reach * reach + WEIGHTS.responsiveness * responsiveness;
    const { key: _key, ...candidate } = c;
    rows.push({
      user_id: input.userId,
      goal_id: input.goal.id,
      person_id: known?.personId ?? null,
      candidate,
      source: c.sources.join('+'),
      external_id:
        c.memberId ??
        c.externalIds.apollo ??
        c.externalIds.semantic_scholar ??
        c.linkedinUrl ??
        c.url ??
        null,
      rank: round4(warmth ? warmRank(base, f.fit, warmth.tier) : base),
      fit: round4(f.fit),
      reach: round4(reach),
      responsiveness: round4(responsiveness),
      reasons,
      status: 'new',
      batch_id: batchId,
    });
  }
  return rows.sort((a, b) => b.rank - a.rank);
}
