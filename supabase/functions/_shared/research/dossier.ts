/**
 * The `enrich.dossier` pipeline (§5.2 steps 1–7) as one orchestration function over injected dependencies:
 * internal history → LinkedIn profile and posts → three Exa searches → identity check (or stop and ask) → contents
 * for the top 6 kept pages → Opus synthesis with source-id validation (one retry) → cache.
 *
 * Money: everything paid counts toward a $0.25 cap per dossier; a step that would cross it is skipped and the
 * dossier is marked partial. Exa responses are cached by request hash for 7 days, the dossier for 30.
 */
import {
  EXA_PAGE_USD,
  type Exa,
  type ExaResult,
  type ExaSearchRequest,
  estimateExaSearchUsd,
  exaCostUsd,
} from '../providers/exa';
import { cacheKey } from '../providers/request';
import {
  linkedInSlugOf,
  type UnipilePost,
  type UnipileProfile,
  type UnipileResearch,
} from '../providers/unipileResearch';
import type { BudgetDep, ClaudeDep, Clock, DossierRow, InternalHistory, ResearchDb } from './deps';
import {
  appearsMinor,
  norm,
  normOrg,
  orgFromTitle,
  passesIdentity,
  sensitiveCategory,
  stripSensitiveSentences,
  workDomains,
} from './guards';
import {
  type DossierContent,
  dossierSchema,
  dossierSystem,
  dossierUser,
  PROMPT_VERSION,
  retryNote,
} from './prompts';

export const DOSSIER_CAP_USD = 0.25;
export const DOSSIER_REUSE_MS = 30 * 86_400_000;
export const EXA_CACHE_MS = 7 * 86_400_000;
export const DOSSIER_MODEL = 'claude-opus-5-5';
/** Opus 5.5 list prices (§13.4) for the pre-call estimate: $4/M in, $20/M out, ~2k tokens out */
const SYNTH_OUT_USD = 2000 * 20e-6;
const synthEstimateUsd = (promptChars: number) => (promptChars / 4) * 4e-6 + SYNTH_OUT_USD;

export interface DossierDeps {
  exa: Exa;
  unipile: UnipileResearch;
  claude: ClaudeDep;
  db: ResearchDb;
  budget: BudgetDep;
  clock: Clock;
}

export type GoalKind =
  | 'recruiting'
  | 'fundraising'
  | 'sales'
  | 'hiring'
  | 'advice'
  | 'cofounder'
  | 'collaboration'
  | 'community';

export interface DossierInput {
  userId: string;
  personId: string;
  goalId?: string | null;
  goalKind?: GoalKind;
  /** completes "who wants to …", e.g. "raise a seed round for a climate software company" */
  goalSentence: string;
  /** the highlights question; defaults to one built from the goal */
  goalQuestion?: string;
  /** research field, for collaboration goals */
  field?: string;
  user: { firstName: string; context: string };
  person: {
    name: string;
    title?: string;
    org?: string;
    location?: string;
    linkedinMemberId?: string;
    linkedinUrl?: string;
    emails?: string[];
  };
  /** the user's connected Unipile LinkedIn account, when there is one */
  unipileAccountId?: string;
  /** rebuild even if a dossier from the last 30 days exists (cached Exa pages stay free) */
  refresh?: boolean;
}

export interface DossierSource {
  id: string;
  kind: 'linkedin_profile' | 'linkedin_post' | 'web';
  url: string;
  title?: string;
  published?: string | null;
}

export interface DisambiguationCandidate {
  name: string;
  org?: string;
  title?: string;
  url: string;
  snippet?: string;
}

export type DossierOutcome =
  | {
      status: 'ready' | 'partial';
      dossier: DossierContent;
      sources: DossierSource[];
      costUsd: number;
      cached: boolean;
      model: string | null;
      promptVersion: string;
      /** what was skipped or degraded, for the chat to say */
      notes: string[];
    }
  | { status: 'needs_disambiguation'; candidates: DisambiguationCandidate[]; costUsd: number; cached: false }
  | { status: 'failed'; error: 'minor'; costUsd: number; cached: false };

interface Run {
  deps: DossierDeps;
  input: DossierInput;
  spent: number;
  notes: string[];
  partial: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Build (or reuse) the research brief on one person. */
export async function buildDossier(deps: DossierDeps, input: DossierInput): Promise<DossierOutcome> {
  const now = deps.clock();

  // reuse: a dossier from the last 30 days, unless the user asked for a refresh
  const prior = await deps.db.getDossier(input.userId, input.personId);
  if (
    prior &&
    !input.refresh &&
    (prior.status === 'ready' || prior.status === 'partial') &&
    prior.content &&
    Date.parse(prior.expires_at) > now
  ) {
    return {
      status: prior.status,
      dossier: prior.content as DossierContent,
      sources: prior.sources as DossierSource[],
      costUsd: 0,
      cached: true,
      model: prior.model,
      promptVersion: prior.prompt_version ?? PROMPT_VERSION,
      notes: [],
    };
  }

  const run: Run = { deps, input, spent: 0, notes: [], partial: false };

  // 1. internal history (free)
  const history = await deps.db.internalHistory(input.userId, input.personId);

  // 2. LinkedIn profile and posts
  const linkedin = await linkedInStep(run);

  // 3. three Exa searches in parallel
  const searches = exaSearches(input, now);
  const answers = await Promise.all(searches.map((s) => cachedExaSearch(run, s)));
  const [peopleResults, ...otherResults] = answers.map((a) => a ?? []);

  // 4. identity check, or stop and ask
  const identity = identityStep(input, linkedin.profile, peopleResults ?? []);
  if (identity.kind === 'ambiguous') {
    await save(run, { status: 'needs_disambiguation', candidates: identity.candidates }, now);
    return {
      status: 'needs_disambiguation',
      candidates: identity.candidates,
      costUsd: run.spent,
      cached: false,
    };
  }
  const keep = (r: ExaResult) =>
    identity.kind === 'anchored' && passesIdentity(resultText(r), identity.anchors);
  const keptPeople = (peopleResults ?? []).filter(keep);
  const keptOther = otherResults.flat().filter(keep);

  // §5.5: a person who appears to be in high school gets no dossier at all
  if (
    appearsMinor({
      title: input.person.title,
      headline: linkedin.profile?.headline,
      education: linkedin.profile?.education,
      profileTexts: keptPeople.map((r) => `${r.title ?? ''} ${(r.highlights ?? []).join(' ')}`),
      year: new Date(now).getUTCFullYear(),
    })
  ) {
    await save(run, { status: 'failed', error: 'minor' }, now);
    return { status: 'failed', error: 'minor', costUsd: run.spent, cached: false };
  }

  // 5. contents for the top 6 kept pages
  const kept = dedupeByUrl([...keptPeople, ...keptOther]).slice(0, 8);
  const texts = await contentsStep(
    run,
    kept.map((r) => r.url),
  );

  // 6. synthesis over numbered sources
  const sources: (DossierSource & { text: string })[] = [];
  let n = 0;
  const nextId = () => `S${++n}`;
  const linkedinLines: string[] = [];
  if (linkedin.profile) {
    const id = nextId();
    const url =
      linkedin.profile.public_profile_url ??
      input.person.linkedinUrl ??
      `https://www.linkedin.com/in/${linkedin.profile.public_identifier ?? input.person.linkedinMemberId ?? ''}`;
    const text = formatProfile(linkedin.profile);
    sources.push({ id, kind: 'linkedin_profile', url, title: 'LinkedIn profile', text });
    linkedinLines.push(`[${id}] profile\n${text}`);
  }
  for (const p of linkedin.posts.slice(0, 10)) {
    if (!p.text) continue;
    const id = nextId();
    const text = p.text.slice(0, 1500);
    sources.push({
      id,
      kind: 'linkedin_post',
      url: p.share_url ?? '',
      title: 'LinkedIn post',
      published: p.parsed_datetime ?? p.date ?? null,
      text,
    });
    linkedinLines.push(`[${id}] post ${p.parsed_datetime ?? p.date ?? ''}\n${text}`);
  }
  for (const r of kept) {
    const text = (texts.get(r.url) ?? r.text ?? (r.highlights ?? []).join(' … ')).slice(0, 6000);
    sources.push({
      id: nextId(),
      kind: 'web',
      url: r.url,
      title: r.title ?? undefined,
      published: r.publishedDate,
      text,
    });
  }

  const allowed = sources.map((s) => s.id);
  const prompt = {
    system: dossierSystem(input.user.firstName, input.goalSentence),
    user: dossierUser({
      userContext: input.user.context,
      person: {
        name: input.person.name,
        title: input.person.title,
        org: input.person.org,
        location: input.person.location,
        identities: {
          linkedin: input.person.linkedinUrl,
          emails: input.person.emails,
        },
      },
      internalHistory: formatHistory(history),
      linkedin: linkedinLines.join('\n\n'),
      sources: sources.filter((s) => s.kind === 'web'),
    }),
  };

  const thin = sources.filter((s) => s.kind === 'web').length === 0;
  let dossier = await synthesize(run, prompt, allowed);
  let model: string | null = DOSSIER_MODEL;
  if (!dossier) {
    dossier = fallbackDossier(input, linkedin.profile, history);
    model = null;
    run.partial = true;
  }
  dossier = finish(dossier, history, thin && !linkedin.profile);

  const storedSources: DossierSource[] = sources.map(({ text: _t, ...s }) => s);
  const status = run.partial ? 'partial' : 'ready';
  await save(run, { status, content: dossier, sources: storedSources, model }, now);
  return {
    status,
    dossier,
    sources: storedSources,
    costUsd: round4(run.spent),
    cached: false,
    model,
    promptVersion: PROMPT_VERSION,
    notes: run.notes,
  };
}

// ---- step 2: LinkedIn ---------------------------------------------------------------------------------------

async function linkedInStep(run: Run): Promise<{ profile: UnipileProfile | null; posts: UnipilePost[] }> {
  const { deps, input } = run;
  const memberId = input.person.linkedinMemberId;
  const empty = { profile: null, posts: [] as UnipilePost[] };
  if (!deps.unipile.configured || !input.unipileAccountId || !memberId) return empty;
  const key = await cacheKey('unipile', { op: 'profile+posts', accountId: input.unipileAccountId, memberId });
  const hit = (await deps.db.get(input.userId, key)) as
    | { profile: UnipileProfile; posts: UnipilePost[] }
    | undefined;
  if (hit) return hit;
  const verdict = await deps.budget.check(input.userId, 'unipile_profile', 1);
  if (!verdict.ok) {
    run.notes.push('LinkedIn profile skipped: daily profile-view cap reached');
    return empty;
  }
  const [profile, posts] = await Promise.all([
    deps.unipile.profile(input.unipileAccountId, memberId),
    deps.unipile.posts(input.unipileAccountId, memberId, { limit: 10 }),
  ]);
  if (!profile.ok) {
    run.partial = true;
    run.notes.push(`LinkedIn unavailable (${profile.message})`);
    return empty;
  }
  await deps.budget.record(input.userId, {
    provider: 'unipile_profile',
    operation: 'profile',
    units: 1,
    costUsd: 0,
  });
  const value = { profile: profile.value, posts: posts.ok ? posts.value : [] };
  if (!posts.ok) run.notes.push('LinkedIn posts unavailable');
  await deps.db.put(input.userId, {
    key,
    provider: 'unipile',
    response: value,
    expiresAt: new Date(deps.clock() + EXA_CACHE_MS),
  });
  return value;
}

// ---- step 3: Exa --------------------------------------------------------------------------------------------

function monthsAgoMonthStart(now: number, months: number): string {
  const d = new Date(now);
  const m = d.getUTCFullYear() * 12 + d.getUTCMonth() - months;
  return new Date(Date.UTC(Math.floor(m / 12), m % 12, 1)).toISOString();
}

export function exaSearches(input: DossierInput, now: number): ExaSearchRequest[] {
  const { name, org, title } = input.person;
  const q = (...parts: (string | undefined)[]) => parts.filter((p) => p?.trim()).join(' ');
  const contents = {
    highlights: {
      query:
        input.goalQuestion ??
        `What has ${name} worked on, said or published recently that matters to someone who wants to ${input.goalSentence}?`,
      maxCharacters: 1200,
    },
  };
  const base = { type: 'auto' as const, numResults: 5, contents };
  const third: ExaSearchRequest =
    input.goalKind === 'collaboration'
      ? { ...base, category: 'publication', query: q(`"${name}"`, input.field ?? org) }
      : {
          ...base,
          query: q(`"${name}"`, org, 'podcast OR talk OR interview OR blog OR GitHub OR personal website'),
        };
  return [
    { ...base, category: 'people', query: q(`"${name}"`, org, title) },
    {
      ...base,
      category: 'news',
      query: q(`"${name}"`, org),
      startPublishedDate: monthsAgoMonthStart(now, 18),
    },
    third,
  ];
}

async function cachedExaSearch(run: Run, req: ExaSearchRequest): Promise<ExaResult[] | null> {
  const { deps, input } = run;
  const key = await cacheKey('exa', { op: 'search', req });
  const hit = (await deps.db.get(input.userId, key)) as { results?: ExaResult[] } | undefined;
  if (hit) return hit.results ?? [];
  if (!deps.exa.configured) {
    if (!run.notes.includes('Exa is not configured')) run.notes.push('Exa is not configured');
    run.partial = true;
    return null;
  }
  const est = estimateExaSearchUsd(req);
  if (!(await reserve(run, 'exa', est))) return null;
  const r = await deps.exa.search(req);
  run.spent -= est;
  if (!r.ok) {
    run.partial = true;
    run.notes.push(`Exa search failed (${r.message})`);
    return null;
  }
  const cost = exaCostUsd(r.value, est);
  run.spent += cost;
  await deps.budget.record(input.userId, { provider: 'exa', operation: 'search', units: 1, costUsd: cost });
  await deps.db.put(input.userId, {
    key,
    provider: 'exa',
    response: { results: r.value.results },
    expiresAt: new Date(deps.clock() + EXA_CACHE_MS),
  });
  return r.value.results;
}

/**
 * Within the per-dossier cap and the user's own daily cap for this provider. On success the estimate is reserved
 * in `run.spent` (synchronously, so the parallel searches cannot overshoot together); the caller swaps it for the
 * actual cost once the call returns.
 */
async function reserve(run: Run, provider: 'exa', est: number): Promise<boolean> {
  if (run.spent + est > DOSSIER_CAP_USD) {
    run.partial = true;
    if (!run.notes.includes('cost cap reached')) run.notes.push('cost cap reached');
    return false;
  }
  run.spent += est;
  const v = await run.deps.budget.check(run.input.userId, provider, est);
  if (!v.ok) {
    run.spent -= est;
    run.partial = true;
    if (!run.notes.includes(`${provider} budget exceeded`)) run.notes.push(`${provider} budget exceeded`);
    return false;
  }
  return true;
}

// ---- step 4: identity ---------------------------------------------------------------------------------------

function resultText(r: ExaResult): string {
  return [r.url, r.title, r.author, r.text, ...(r.highlights ?? [])].filter(Boolean).join(' \n ');
}

type IdentityVerdict =
  | { kind: 'anchored'; anchors: { fullName: string; anchors: string[] } }
  | { kind: 'ambiguous'; candidates: DisambiguationCandidate[] }
  | { kind: 'none' };

export function identityStep(
  input: DossierInput,
  profile: UnipileProfile | null,
  people: ExaResult[],
): IdentityVerdict {
  const fullName = input.person.name;
  const anchors = new Set<string>();
  const org = normOrg(input.person.org);
  if (org) anchors.add(org);
  const slug = linkedInSlugOf(input.person.linkedinUrl) ?? profile?.public_identifier?.toLowerCase();
  if (slug) anchors.add(norm(slug));
  for (const d of workDomains(input.person.emails)) anchors.add(d);
  const current = profile?.work_experience?.find((w) => w.current) ?? profile?.work_experience?.[0];
  if (current?.company) anchors.add(normOrg(current.company));

  const named = people.filter((r) => norm(resultText(r)).includes(norm(fullName)));
  const byOrg = new Map<string, DisambiguationCandidate>();
  for (const r of named) {
    const o = orgFromTitle(r.title, fullName);
    const k = o ? normOrg(o) : norm(r.url);
    if (!byOrg.has(k))
      byOrg.set(k, {
        name: fullName,
        org: o,
        title: r.title ?? undefined,
        url: r.url,
        snippet: (r.highlights?.[0] ?? r.text ?? '').slice(0, 240) || undefined,
      });
  }

  const a = { fullName, anchors: [...anchors].filter(Boolean) };
  if (a.anchors.length > 0) {
    if (named.some((r) => passesIdentity(resultText(r), a))) return { kind: 'anchored', anchors: a };
    if (byOrg.size >= 2) return { kind: 'ambiguous', candidates: [...byOrg.values()].slice(0, 5) };
    return { kind: 'anchored', anchors: a };
  }
  if (byOrg.size >= 2) return { kind: 'ambiguous', candidates: [...byOrg.values()].slice(0, 5) };
  const only = [...byOrg.values()][0];
  if (only?.org) return { kind: 'anchored', anchors: { fullName, anchors: [normOrg(only.org)] } };
  return { kind: 'none' };
}

function dedupeByUrl(rs: ExaResult[]): ExaResult[] {
  const seen = new Set<string>();
  return rs.filter((r) => {
    const k = r.url
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '')
      .toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---- step 5: contents ---------------------------------------------------------------------------------------

async function contentsStep(run: Run, urls: string[]): Promise<Map<string, string>> {
  const { deps, input } = run;
  const out = new Map<string, string>();
  const missing: { url: string; key: string }[] = [];
  for (const url of urls) {
    const key = await cacheKey('exa', { op: 'contents', url, text: 6000 });
    const hit = (await deps.db.get(input.userId, key)) as { text?: string } | undefined;
    if (hit?.text) out.set(url, hit.text);
    else missing.push({ url, key });
  }
  if (missing.length === 0 || !deps.exa.configured) return out;
  const est = missing.length * EXA_PAGE_USD;
  if (!(await reserve(run, 'exa', est))) return out;
  const r = await deps.exa.contents({
    urls: missing.map((m) => m.url),
    text: { maxCharacters: 6000 },
    maxAgeHours: 720,
  });
  run.spent -= est;
  if (!r.ok) {
    run.partial = true;
    run.notes.push(`Exa contents failed (${r.message})`);
    return out;
  }
  const cost = exaCostUsd(r.value, est);
  run.spent += cost;
  await deps.budget.record(input.userId, {
    provider: 'exa',
    operation: 'contents',
    units: missing.length,
    costUsd: cost,
  });
  for (const res of r.value.results) {
    if (!res.text) continue;
    const m = missing.find((x) => x.url === res.url) ?? missing.find((x) => x.url === res.id);
    if (!m) continue;
    out.set(m.url, res.text);
    await deps.db.put(input.userId, {
      key: m.key,
      provider: 'exa',
      response: { text: res.text },
      expiresAt: new Date(deps.clock() + EXA_CACHE_MS),
    });
  }
  return out;
}

// ---- step 6: synthesis --------------------------------------------------------------------------------------

/** Every `source_ids` entry in the output that is not one of the input's ids. */
export function invalidSourceIds(d: DossierContent, allowed: string[]): string[] {
  const ok = new Set(allowed);
  const all = [
    ...d.now.source_ids,
    ...d.recently.flatMap((x) => x.source_ids),
    ...d.in_common.flatMap((x) => x.source_ids),
    ...d.openers.flatMap((x) => x.source_ids),
    ...(d.career ?? []).flatMap((x) => x.source_ids),
    ...(d.education ?? []).flatMap((x) => x.source_ids),
    ...(d.highlights ?? []).flatMap((x) => x.source_ids),
  ];
  return [...new Set(all.filter((id) => !ok.has(id)))];
}

async function synthesize(
  run: Run,
  prompt: { system: string; user: string },
  allowed: string[],
): Promise<DossierContent | null> {
  const { deps } = run;
  let user = prompt.user;
  for (let attempt = 0; attempt < 2; attempt++) {
    const est = synthEstimateUsd(prompt.system.length + user.length);
    if (run.spent + est > DOSSIER_CAP_USD) {
      run.notes.push(attempt === 0 ? 'synthesis skipped: cost cap' : 'source-id retry skipped: cost cap');
      return null;
    }
    const r = await deps.claude.parse('dossier', dossierSchema, { system: prompt.system, user });
    run.spent += r.costUsd ?? 0;
    if (!r.ok) {
      run.notes.push(`synthesis unavailable (${r.reason})`);
      return null;
    }
    const bad = invalidSourceIds(r.value, allowed);
    if (bad.length === 0) return r.value;
    if (attempt === 1) {
      run.partial = true;
      run.notes.push('uncited claims removed');
      return dropUncited(r.value, allowed);
    }
    user = prompt.user + retryNote(bad, allowed);
  }
  return null;
}

/** Remove ids that are not in the input; claims left with no source go too. */
export function dropUncited(d: DossierContent, allowed: string[]): DossierContent {
  const ok = new Set(allowed);
  const f = (ids: string[]) => ids.filter((i) => ok.has(i));
  return {
    ...d,
    now: { ...d.now, source_ids: f(d.now.source_ids) },
    recently: d.recently
      .map((x) => ({ ...x, source_ids: f(x.source_ids) }))
      .filter((x) => x.source_ids.length),
    in_common: d.in_common
      .map((x) => ({ ...x, source_ids: f(x.source_ids) }))
      .filter((x) => x.source_ids.length),
    openers: d.openers.map((x) => ({ ...x, source_ids: f(x.source_ids) })).filter((x) => x.source_ids.length),
    career: (d.career ?? [])
      .map((x) => ({ ...x, source_ids: f(x.source_ids) }))
      .filter((x) => x.source_ids.length),
    education: (d.education ?? [])
      .map((x) => ({ ...x, source_ids: f(x.source_ids) }))
      .filter((x) => x.source_ids.length),
    highlights: (d.highlights ?? [])
      .map((x) => ({ ...x, source_ids: f(x.source_ids) }))
      .filter((x) => x.source_ids.length),
    confidence: 'low',
  };
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Limits, sensitive categories and the "no web presence" rule, applied to every dossier before it is stored. */
export function finish(
  d: DossierContent,
  history: InternalHistory,
  noOutsideSources: boolean,
): DossierContent {
  const clean = <T extends { text: string }>(xs: T[]) => xs.filter((x) => !sensitiveCategory(x.text));
  return {
    ...d,
    who: stripSensitiveSentences(d.who),
    recently: clean(d.recently).slice(0, 3),
    in_common: clean(d.in_common),
    openers: clean(d.openers)
      .filter((o) => words(o.text) <= 25)
      .slice(0, 3),
    careful: d.careful.filter((c) => !sensitiveCategory(c)),
    career: (d.career ?? []).slice(0, 12),
    education: (d.education ?? []).slice(0, 6),
    // a profile link has to be a web address, never anything a page could run
    profiles: (d.profiles ?? []).filter((p) => /^https?:\/\//i.test(p.url)).slice(0, 6),
    highlights: (d.highlights ?? [])
      .filter((h) => !sensitiveCategory(`${h.title} ${h.summary ?? ''}`))
      .map((h) => ({ ...h, url: h.url && /^https?:\/\//i.test(h.url) ? h.url : null }))
      .slice(0, 8),
    topics: (d.topics ?? []).filter((t) => !sensitiveCategory(t)).slice(0, 6),
    history: {
      first_contact: d.history.first_contact ?? history.firstContact ?? null,
      last_contact: d.history.last_contact ?? history.lastContact ?? null,
      summary: d.history.summary ? stripSensitiveSentences(d.history.summary) || null : null,
    },
    confidence: noOutsideSources ? 'low' : d.confidence,
  };
}

/** §13.1 fallback: internal + LinkedIn summary without web or model. */
function fallbackDossier(
  input: DossierInput,
  profile: UnipileProfile | null,
  history: InternalHistory,
): DossierContent {
  const current = profile?.work_experience?.find((w) => w.current) ?? profile?.work_experience?.[0];
  const role = current?.position ?? input.person.title ?? '';
  const org = current?.company ?? input.person.org ?? '';
  const who = [input.person.name, role && org ? `${role} at ${org}` : role || org].filter(Boolean).join(', ');
  const last = history.messages[history.messages.length - 1];
  return {
    who: `${who}.`,
    now: {
      role,
      org,
      since: null,
      // the profile, when there is one, is always the first source
      source_ids: profile ? ['S1'] : [],
    },
    recently: [],
    in_common: [],
    history: {
      first_contact: history.firstContact ?? history.messages[0]?.at ?? null,
      last_contact: history.lastContact ?? last?.at ?? null,
      summary: last
        ? `Last ${last.direction === 'outbound' ? 'you wrote' : 'they wrote'}: ${last.subject ?? ''}`.trim()
        : null,
    },
    openers: [],
    careful: ['This brief was assembled without web research; check it before relying on it.'],
    confidence: 'low',
    // the profile's own history, when there is a profile (always source S1)
    career: profile
      ? (profile.work_experience ?? []).slice(0, 12).map((w) => ({
          role: w.position ?? '',
          org: w.company ?? '',
          start: fmtDate(w.start) || null,
          end: w.current ? null : fmtDate(w.end) || null,
          source_ids: ['S1'],
        }))
      : [],
    education: profile
      ? (profile.education ?? []).slice(0, 6).map((e) => ({
          school: e.school ?? '',
          degree: e.degree ?? null,
          years: [fmtDate(e.start), fmtDate(e.end)].filter(Boolean).join('–') || null,
          source_ids: ['S1'],
        }))
      : [],
  };
}

// ---- formatting ---------------------------------------------------------------------------------------------

function fmtDate(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  const o = v as { year?: number; month?: number };
  return o.year ? `${o.year}${o.month ? `-${String(o.month).padStart(2, '0')}` : ''}` : '';
}

export function formatProfile(p: UnipileProfile): string {
  const lines = [
    `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim(),
    p.headline ?? '',
    p.location ? `Location: ${p.location}` : '',
    p.summary ? `About: ${p.summary.slice(0, 1500)}` : '',
  ];
  for (const w of p.work_experience ?? [])
    lines.push(
      `Experience: ${w.position ?? ''} at ${w.company ?? ''} (${fmtDate(w.start)}–${w.current ? 'present' : fmtDate(w.end)})`,
    );
  for (const e of p.education ?? [])
    lines.push(
      `Education: ${e.school ?? ''}${e.degree ? `, ${e.degree}` : ''}${e.field_of_study ? ` in ${e.field_of_study}` : ''} (${fmtDate(e.start)}–${fmtDate(e.end)})`,
    );
  return lines.filter(Boolean).join('\n');
}

export function formatHistory(h: InternalHistory): string {
  const lines: string[] = [];
  for (const m of h.messages.slice(-20))
    lines.push(
      `${m.at.slice(0, 10)} ${m.direction === 'outbound' ? 'user → them' : 'them → user'}${m.subject ? ` · ${m.subject}` : ''}: ${m.body.slice(0, 600)}`,
    );
  for (const n of h.notes) lines.push(`note ${n.at.slice(0, 10)}: ${n.text.slice(0, 600)}`);
  for (const f of h.facts) lines.push(`fact (${f.type}): ${f.text}`);
  for (const e of h.events) lines.push(`event ${e.at.slice(0, 10)}: ${e.title}`);
  return lines.join('\n') || '(none)';
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

// ---- step 7: store ------------------------------------------------------------------------------------------

async function save(
  run: Run,
  r: {
    status: DossierRow['status'];
    content?: DossierContent;
    sources?: DossierSource[];
    candidates?: DisambiguationCandidate[];
    model?: string | null;
    error?: string;
  },
  now: number,
): Promise<void> {
  const { deps, input } = run;
  await deps.db.putDossier({
    user_id: input.userId,
    person_id: input.personId,
    goal_id: input.goalId ?? null,
    status: r.status,
    content: r.content ?? null,
    sources: r.sources ?? [],
    candidates: r.candidates ?? null,
    cost_usd: round4(run.spent),
    model: r.model ?? null,
    prompt_version: r.content ? PROMPT_VERSION : null,
    error: r.error ?? null,
    created_at: iso(now),
    updated_at: iso(now),
    expires_at: iso(now + DOSSIER_REUSE_MS),
  });
}
