/**
 * Plan 44: the Roles routes answered from sample roles, the way the server answers them (§5, §6): a profile read
 * from the lines the browser sends, a search that lists the roles to read and is read in steps, a score out of 100
 * from answers with quotes and the formula with its caps, Saved, Watch, and a pasted posting scored now.
 *
 * Two places use it. The demo student's Roles tab runs on it in the browser (the demo never calls a server), kept in
 * the browser's database so a reload finds the same matches. The tests' fake orbit-api answers `/roles/*` with it, so
 * the component and end-to-end tests drive the real client against the real shapes.
 *
 * The arithmetic is the server's own, from `packages/core/src/roles`: `fitOf` turns the answers into the score,
 * `capsFor` reads the caps from the posting's requirements and what the student said, the level comes from dates
 * (`profileLevelOf`, `fullTimeMonthsOf`), and skills are matched by name on whole words (`skillShownIn`,
 * `showsSkill`). Only the answers themselves are made up here, where the server asks the model: this file reads them
 * from the student's lines by word. So the same answers give the same score here, in the fake API and on the server.
 *
 * Pure: no database, no network; the caller passes `load` and `save` to keep its state.
 */
import {
  capsFor,
  type DismissReason,
  type FitAnswers,
  type FitCapFact,
  fitOf,
  fullTimeMonthsOf,
  fullTimeTitle,
  type Job,
  type JobRequirement,
  levelAnswerOf,
  levelsFor,
  type MatchStatus,
  normalizeCompany,
  type ProfileLines,
  profileLevelOf,
  type RoleKind,
  type RoleMatch,
  type RoleProfile,
  type RolesActRequest,
  type RolesCoverage,
  type RolesListRequest,
  type RolesProfileRequest,
  type RolesScoreRequest,
  sameSkill,
  showsSkill,
  skillShownIn,
  yearMonth,
} from '@orbit/core';
import type { TitleFamily } from '@orbit/core/search';
import { SAMPLE_COVERAGE, SAMPLE_JOBS, type SampleJob, SKILL_WORDS } from './rolesSample';

/** What the server says when it could not read roles closely (supabase/functions/_shared/roles/score.ts). */
export const NOT_READ_NOTE =
  'Orbit could not read some of these roles closely just now. They are ranked by what it can read without that.';
/** What the server says of a search a newer one replaced (search.ts SEARCH_REPLACED), with 404 `search_replaced`. */
export const SEARCH_REPLACED = 'That search was replaced by a newer one.';
/** What /roles/score says when there is no profile yet (search.ts NO_PROFILE). */
export const NO_PROFILE = 'Read your resume or LinkedIn profile first, so Orbit has something to match.';

// ---- reading a profile --------------------------------------------------------------------------------------------

const FAMILY_OF_KIND: [RegExp, TitleFamily][] = [
  [/\b(data|analytics|analyst)\b/i, 'data_ml'],
  [/\b(machine learning|ml|research)\b/i, 'research'],
  [/\b(product manager|product management|\bpm\b)/i, 'product'],
  [/\b(design|designer)\b/i, 'design'],
  [/\b(banking|investment|finance|analyst)\b/i, 'finance'],
  [/\b(engineer|developer|software|swe)\b/i, 'engineering'],
];

export function familyOfTitle(title: string): TitleFamily | undefined {
  // a product engineer is an engineer; a data engineer works with data
  if (/\bdata engineer/i.test(title)) return 'data_ml';
  if (/\b(engineer|developer)\b/i.test(title)) return 'engineering';
  return FAMILY_OF_KIND.find(([re]) => re.test(title))?.[1];
}

/** Read the lines into a proposed profile: dates decide the level, skills come from what is written or used. */
export function proposeProfile(lines: ProfileLines, now: Date): { profile: RoleProfile; note?: string } {
  const r = lines.resume;
  const li = lines.linkedin;
  const school = r?.education[0] ?? (li?.schools[0] ? { ...li.schools[0], lines: [] } : undefined);
  const graduation = yearMonth(school?.end);
  const experience: RoleProfile['experience'] = [];
  const seen = new Set<string>();
  const addJob = (j: { title: string; org?: string; start?: string; end?: string; text: string }) => {
    const key = `${j.title.toLowerCase()}|${normalizeCompany(j.org ?? '')}`;
    if (seen.has(key)) {
      // the same job on both: the one with words wins, and the newer end date
      const had = experience.find((x) => `${x.title.toLowerCase()}|${normalizeCompany(x.org ?? '')}` === key);
      if (had && !had.text && j.text) had.text = j.text;
      const end = yearMonth(j.end);
      if (had && end && (!had.end || end > had.end)) had.end = end;
      return;
    }
    seen.add(key);
    const start = yearMonth(j.start);
    const end = yearMonth(j.end);
    experience.push({
      title: j.title,
      org: j.org,
      start,
      end,
      // full-time work after school, as the server reads it: by its title, and starting at or after graduation
      fullTime:
        fullTimeTitle(j.title) &&
        (!graduation || (!!start && start >= graduation) || (!start && !!end && end > graduation)),
      family: familyOfTitle(j.title),
      text: j.text,
    });
  };
  for (const e of r?.experience ?? []) addJob({ ...e, text: e.lines.join(' ') });
  for (const p of li?.positions ?? []) addJob({ ...p, text: p.description ?? '' });
  const projects = [
    ...(r?.projects ?? []).map((p) => ({ title: p.title, text: p.lines.join(' ') })),
    ...(li?.projects ?? []).map((p) => ({ title: p.name, text: p.description ?? '' })),
  ];
  const skills: RoleProfile['skills'] = [];
  const haveSkill = (n: string) => skills.some((s) => sameSkill(s.name, n));
  for (const s of [...(r?.skills ?? []), ...(li?.skills ?? [])].flatMap((x) => x.split(/[,;]\s*/)))
    if (s.trim() && !haveSkill(s.trim())) skills.push({ name: s.trim(), from: 'written' });
  for (const line of [...experience.map((e) => e.text), ...projects.map((p) => p.text)])
    for (const w of SKILL_WORDS)
      if (line && skillShownIn(line, w) && !haveSkill(w)) skills.push({ name: w, from: 'read', line });
  const fullTimeMonths = fullTimeMonthsOf(experience, graduation, now);
  const level = profileLevelOf({ graduation, fullTimeMonths }, now);
  const kinds = proposeKinds(experience, projects, skills);
  const degree = /\b(ph\.?d|doctor)/i.test(school?.degree ?? '')
    ? 'phd'
    : /\b(m\.?s|master|mba)/i.test(school?.degree ?? '')
      ? 'master'
      : school
        ? 'bachelor'
        : undefined;
  const profile: RoleProfile = {
    level,
    graduation,
    degree,
    field:
      school?.field ??
      (school?.degree?.replace(/^(b\.?s\.?|b\.?a\.?|bachelor of \w+)\s*(in\s*)?/i, '') || undefined),
    school: school?.school,
    courses: r?.courses ?? [],
    experience,
    projects,
    skills,
    kinds,
    // as the server proposes it: no levels picked means the ones that fit the profile's level
    wants: { levels: [], places: [], notPlaces: [], remote: false },
    eligibility: {},
    sources: [...(r ? (['resume'] as const) : []), ...(li ? (['linkedin'] as const) : [])],
    fullTimeMonths,
  };
  const bare = !r && !!li && experience.length > 0 && experience.every((e) => !e.text.trim());
  return {
    profile,
    note: bare
      ? 'Your LinkedIn profile lists your roles but not what you did in them. Add a resume for a closer read.'
      : undefined,
  };
}

function proposeKinds(
  experience: RoleProfile['experience'],
  projects: RoleProfile['projects'],
  skills: RoleProfile['skills'],
): RoleKind[] {
  const out: RoleKind[] = [];
  const eng = experience.find((e) => e.family === 'engineering');
  const lineOf = (x?: { text: string }) => x?.text.split(/(?<=\.)\s+/)[0]?.slice(0, 140);
  const has = (n: string) => skills.some((s) => sameSkill(s.name, n));
  const where = (e?: { title: string; org?: string }) =>
    e
      ? `your ${e.org ? `${e.org} ` : ''}${/intern/i.test(e.title) ? 'internship' : e.title.toLowerCase()}`
      : '';
  if (eng || projects.length) {
    out.push({
      title: 'Software engineer',
      family: 'engineering',
      why: eng ? `From ${where(eng)}` : 'From your projects',
      line: lineOf(eng ?? projects[0]),
      on: true,
    });
    if (has('Go') || has('Postgres') || has('SQL'))
      out.push({
        title: 'Backend engineer',
        family: 'engineering',
        why: `Go and databases in ${where(eng) || 'your projects'}`,
        line: lineOf(eng),
        on: true,
      });
    if (has('React') || has('TypeScript'))
      out.push({
        title: 'Full stack engineer',
        family: 'engineering',
        why: projects[0]
          ? `React in ${projects[0].title ?? 'your project'}`
          : 'React and TypeScript on your resume',
        line: lineOf(projects[0]),
        on: true,
      });
  }
  if (has('SQL') || has('Python'))
    out.push({
      title: 'Data analyst',
      family: 'data_ml',
      why: 'SQL and Python on your resume',
      on: false,
    });
  if (projects.length)
    out.push({
      title: 'Product manager',
      family: 'product',
      why: `You built ${projects[0]!.title ?? 'a project'} people use`,
      line: lineOf(projects[0]),
      on: false,
    });
  if (!out.length)
    out.push(
      { title: 'Analyst', family: 'finance', on: true },
      { title: 'Operations associate', family: 'operations', on: true },
      { title: 'Business analyst', family: 'operations', on: false },
    );
  return out.slice(0, 6);
}

// ---- answering the questions about one student and one role ------------------------------------------------------

function answersFor(p: RoleProfile, s: SampleJob): FitAnswers {
  const workLines = p.experience.filter((e) => e.text).map((e) => ({ e, text: e.text }));
  const projectLines = [
    ...p.projects.map((x) => x.text),
    ...(p.courses.length ? [`Courses: ${p.courses.join(', ')}`] : []),
  ];
  const skills = s.skills.map((req) => {
    const work = workLines.find((w) => skillShownIn(w.text, req.name));
    if (work)
      return { name: req.name, need: req.need, answer: 'work' as const, you: work.text, posting: req.quote };
    const proj = projectLines.find((t) => skillShownIn(t, req.name));
    if (proj)
      return { name: req.name, need: req.need, answer: 'project' as const, you: proj, posting: req.quote };
    const listed = p.skills.find((x) => showsSkill(x.name, req.name));
    if (listed)
      return {
        name: req.name,
        need: req.need,
        answer: 'listed' as const,
        you: listed.line ?? `Skills: ${listed.name}`,
        posting: req.quote,
      };
    return { name: req.name, need: req.need, answer: 'none' as const, posting: req.quote };
  });
  const sameKind = p.experience.find((e) => e.family === s.family);
  const related = p.experience.find(
    (e) =>
      e.family &&
      ((e.family === 'engineering' && s.family === 'data_ml') ||
        (e.family === 'data_ml' && s.family === 'engineering') ||
        (e.family === 'engineering' && s.family === 'product')),
  );
  const experience = sameKind
    ? {
        answer: 'same' as const,
        you: `${sameKind.title}${sameKind.org ? `, ${sameKind.org}` : ''}`,
        posting: s.experienceQuote,
      }
    : related
      ? {
          answer: 'related' as const,
          you: `${related.title}${related.org ? `, ${related.org}` : ''}`,
          posting: s.experienceQuote,
        }
      : p.projects.length
        ? { answer: 'projects' as const, you: p.projects[0]!.text, posting: s.experienceQuote }
        : { answer: 'none' as const, posting: s.experienceQuote };
  const education = !s.education
    ? { answer: 'unsaid' as const }
    : p.field && new RegExp(s.education.field.split(' ')[0]!, 'i').test(p.field)
      ? {
          answer: 'fits' as const,
          you: [p.degree === 'bachelor' ? 'BS' : p.degree, p.field].filter(Boolean).join(' '),
          posting: s.education.quote,
        }
      : p.field
        ? { answer: 'close' as const, you: p.field, posting: s.education.quote }
        : { answer: 'no' as const, posting: s.education.quote };
  // a posting that says its level: read against the student's, as the server does; one that does not is at level
  const level = { answer: levelAnswerOf(p.level, s.level) ?? ('at' as const) };
  // the caps are facts from the posting's requirements set against what the student said: the server's own rule
  const caps: FitCapFact[] = capsFor(requirementsOf(s), p, {
    level: s.level,
    places: s.places,
    remote: s.remote,
    sponsorship: s.sponsorship,
  });
  for (const c of s.caps ?? [])
    if (c.kind === 'thin' && !caps.some((x) => x.kind === 'thin'))
      caps.push({ kind: 'thin', label: c.label });
  const shown = skills.filter((x) => x.answer === 'work' || x.answer === 'project');
  const from = sameKind ?? related;
  const reason = shown.length
    ? `${shown
        .slice(0, 2)
        .map((x) => x.name)
        .join(' and ')} from your ${
        shown[0]!.answer === 'work' && from
          ? `${from.org ?? ''} ${/intern/i.test(from.title) ? 'internship' : 'work'}`.trim()
          : 'projects'
      }`
    : sameKind
      ? `You have done this kind of work at ${sameKind.org ?? 'a past job'}`
      : skills.some((x) => x.answer === 'listed')
        ? `${skills.find((x) => x.answer === 'listed')!.name} is on your resume`
        : 'Little of what it asks is on your profile';
  const gaps = [
    ...skills
      .filter((x) => x.answer === 'none')
      .map(
        (x) =>
          `${x.name} is asked for and not on your ${p.sources.includes('resume') ? 'resume' : 'profile'}`,
      ),
    ...skills
      .filter((x) => x.answer === 'listed')
      .slice(0, 2)
      .map(
        (x) => `${x.name} is listed but not shown in your work: a line about where you used it would count`,
      ),
  ];
  return { skills, experience, education, level, caps, reason, gaps };
}

/** A sample posting's facts as the requirements the server reads from a posting (plan 44 §6.2). */
export function requirementsOf(s: SampleJob): JobRequirement[] {
  const out: JobRequirement[] = s.skills.map((r) => ({
    kind: 'skill',
    need: r.need,
    name: r.name,
    quote: r.quote,
  }));
  if (s.education)
    out.push({ kind: 'education', need: 'must', name: s.education.field, quote: s.education.quote });
  for (const c of s.caps ?? []) {
    const quote = c.quote ?? c.label;
    if (c.kind === 'degree') out.push({ kind: 'education', need: 'must', name: 'PhD', quote, degree: 'phd' });
    if (c.kind === 'years')
      out.push({
        kind: 'experience',
        need: 'must',
        name: c.label,
        quote,
        years: Number(/\d+/.exec(c.label)?.[0] ?? 5),
      });
    if (c.kind === 'sponsorship')
      out.push({
        kind: 'eligibility',
        need: 'must',
        name: 'No visa sponsorship',
        quote,
        eligibility: 'no_sponsorship',
      });
    if (c.kind === 'citizenship_ask' || c.kind === 'citizenship_no')
      out.push({
        kind: 'eligibility',
        need: 'must',
        name: 'US citizenship',
        quote,
        eligibility: 'citizenship',
      });
  }
  return out;
}

/** The score of one sample posting's answers: the server's formula, thin when the posting asks for little. */
function fitFor(answers: FitAnswers, s: SampleJob) {
  return fitOf(answers, { requirements: s.skills.length });
}

// ---- the state a student's roles keep --------------------------------------------------------------------------

export interface RolesSimState {
  /** the profile the student confirmed */
  profile?: RoleProfile;
  /** what the last read proposed */
  proposed?: RoleProfile;
  profileAt?: string;
  /** the search now running, its roles in the order they are read */
  search?: { id: string; order: string[]; read: number; profileKey: string };
  matches: Record<string, RoleMatch>;
  watching: string[];
  /** postings the student scored on their own (a link or pasted text): listed with every search, as the server does */
  loose?: string[];
  /** test switches: the model cannot be reached; postings taken down */
  modelOff?: boolean;
  closed: string[];
  searches: number;
}

export interface RolesSim {
  state: () => RolesSimState;
  /** answer one route; the body is what the server would answer, or an error with its status */
  handle: (
    route: string,
    body: Record<string, unknown>,
  ) => Promise<{ ok: true; value: unknown } | { ok: false; status: number; code: string; message: string }>;
  /** a posting is taken down */
  close: (jobId: string) => Promise<void>;
  setModelOff: (off: boolean) => Promise<void>;
}

const emptyState = (): RolesSimState => ({ matches: {}, watching: [], closed: [], searches: 0 });

/** A short key for a profile: a change to it starts a new search. */
export function profileKey(p: RoleProfile): string {
  const s = JSON.stringify({
    k: p.kinds.filter((k) => k.on).map((k) => k.title),
    w: p.wants,
    e: p.eligibility,
    s: p.skills.map((x) => x.name),
    l: p.level,
    x: p.experience.map((e) => e.text),
  });
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function createRolesSim(
  opts: {
    now?: () => Date;
    /** how many roles one /roles/more reads (the server reads 10) */
    step?: number;
    jobs?: SampleJob[];
    load?: () => Promise<RolesSimState | undefined>;
    save?: (s: RolesSimState) => Promise<void>;
  } = {},
): RolesSim {
  const now = opts.now ?? (() => new Date());
  const step = opts.step ?? 10;
  const jobs = opts.jobs ?? SAMPLE_JOBS;
  let state: RolesSimState | undefined;
  const get = async (): Promise<RolesSimState> => {
    state ??= { ...emptyState(), ...((await opts.load?.()) ?? {}) };
    return state;
  };
  const put = async () => {
    if (state) await opts.save?.(state);
  };
  const coverage: RolesCoverage = { ...SAMPLE_COVERAGE };

  const jobOf = (s: SampleJob, st: RolesSimState): Job => {
    const posted = new Date(now().getTime() - s.postedDaysAgo * 86_400_000).toISOString();
    return {
      id: s.id,
      source: s.source,
      externalId: s.id,
      companyKey: normalizeCompany(s.company),
      companyName: s.company,
      companyDomain: s.domain,
      title: s.title,
      team: s.team,
      family: s.family,
      level: s.level,
      employment: s.level === 'intern' ? 'internship' : 'full_time',
      places: s.places,
      countries: ['US'],
      remote: s.remote,
      term: s.term,
      pay: s.pay,
      sponsorship: s.sponsorship,
      degrees: s.education ? ['bachelor'] : [],
      url: s.url,
      postedAt: posted,
      firstSeenAt: posted,
      ...(st.closed.includes(s.id) ? { closedAt: now().toISOString() } : {}),
    };
  };

  const score = (p: RoleProfile, s: SampleJob, st: RolesSimState, rank: number): RoleMatch => {
    const id = `rm_${s.id}`;
    const had = st.matches[id];
    const job = jobOf(s, st);
    if (st.modelOff) return rough(p, s, st, rank);
    const answers = answersFor(p, s);
    const fit = fitFor(answers, s);
    return {
      id,
      job,
      state: st.closed.includes(s.id) ? 'gone' : 'read',
      rank,
      fit,
      answers,
      reason: answers.reason,
      gaps: answers.gaps,
      status: had?.status ?? 'new',
      dismissReason: had?.dismissReason,
      readAt: now().toISOString(),
    };
  };

  /**
   * A role not read closely, as the server sends it: still to be read, with the parts it can read without the model
   * (the share of the student's skills the listing names, the level, the place) and never a number.
   */
  const rough = (p: RoleProfile, s: SampleJob, st: RolesSimState, rank: number): RoleMatch => {
    const had = st.matches[`rm_${s.id}`];
    const where = `${s.title}\n${s.team ?? ''}\n${s.skills.map((r) => r.quote).join('\n')}`;
    const mine = p.skills.map((x) => x.name);
    const hits = mine.filter((x) => skillShownIn(where, x)).length;
    const levels = p.wants.levels.length ? p.wants.levels : levelsFor(p.level);
    return {
      id: `rm_${s.id}`,
      job: jobOf(s, st),
      state: 'to_read',
      rank,
      status: had?.status ?? 'new',
      dismissReason: had?.dismissReason,
      roughFit: {
        skills: mine.length ? Math.round(Math.min(1, hits / Math.min(5, mine.length)) * 100) / 100 : 0,
        level: !!s.level && levels.includes(s.level),
        place:
          (!p.wants.places.length && !p.wants.remote) ||
          placeFits(p, s) ||
          (p.wants.remote && s.remote === 'remote'),
      },
    };
  };

  const placeFits = (p: RoleProfile, s: SampleJob) =>
    s.places.some((pl) => p.wants.places.some((w) => pl.toLowerCase().includes(w.toLowerCase())));

  /** Plan 44 §5 step 1: open roles at the profile's levels, in its kinds, in its places, not dismissed. */
  const candidates = (p: RoleProfile, st: RolesSimState): SampleJob[] => {
    const families = new Set(p.kinds.filter((k) => k.on).map((k) => k.family ?? familyOfTitle(k.title)));
    const levels = new Set(p.wants.levels.length ? p.wants.levels : levelsFor(p.level));
    const companies = p.wants.companies?.map((c) => normalizeCompany(c));
    return jobs
      .filter((s) => !st.closed.includes(s.id))
      .filter((s) => !s.level || levels.has(s.level))
      .filter((s) => families.size === 0 || families.has(s.family))
      .filter((s) => !companies?.length || companies.includes(normalizeCompany(s.company)))
      .filter(
        (s) =>
          (!p.wants.places.length && !p.wants.remote) ||
          !s.places.length ||
          placeFits(p, s) ||
          (p.wants.remote && s.remote === 'remote'),
      )
      .filter((s) => st.matches[`rm_${s.id}`]?.status !== 'dismissed')
      .sort((a, b) => cheapRank(p, b) - cheapRank(p, a) || a.postedDaysAgo - b.postedDaysAgo);
  };

  /** §5 step 2, without embeddings: the share of the role's skill words the student has, and entry before not said. */
  const cheapRank = (p: RoleProfile, s: SampleJob) =>
    s.skills.filter((r) => p.skills.some((x) => showsSkill(x.name, r.name))).length / (s.skills.length || 1) +
    (s.level ? 0.2 : 0);

  /** The ids of a search's roles that are read closely, in the order they were listed. */
  const readIds = (st: RolesSimState): string[] =>
    (st.search?.order ?? []).map((j) => `rm_${j}`).filter((id) => st.matches[id]?.state === 'read');

  /**
   * The search's roles not read closely, each kept as still to be read with its rough parts (what the server sends
   * when a search is over without them, and what /roles/list adds with `rest`).
   */
  const restIds = (st: RolesSimState): string[] => {
    const search = st.search;
    if (!search || !st.profile) return [];
    const ids: string[] = [];
    for (const [i, jobId] of search.order.entries()) {
      const s = jobs.find((j) => j.id === jobId);
      const had = st.matches[`rm_${jobId}`];
      if (!s || had?.state === 'read' || had?.state === 'gone' || st.closed.includes(jobId)) continue;
      if (had?.status === 'dismissed') continue;
      const m = rough(st.profile, s, st, search.order.length - i);
      st.matches[m.id] = m;
      ids.push(m.id);
    }
    return ids;
  };

  /**
   * What /roles/search and /roles/more answer, as the server does: every role read so far for the search. When the
   * model is off the search is over for now: `done`, with the roles not read closely as rough rows and a note.
   */
  const listResponse = (st: RolesSimState, extra: { note?: string } = {}) => {
    const search = st.search;
    const left = search ? search.order.length - search.read : 0;
    const ids = readIds(st);
    if (st.modelOff && left > 0) ids.push(...restIds(st));
    const read = search ? readIds(st).length : 0;
    return {
      searchId: search?.id ?? '',
      matches: ids.map((id) => st.matches[id]).filter((m): m is RoleMatch => !!m),
      listed: search?.order.length ?? 0,
      read,
      done: !search || left <= 0 || !!st.modelOff,
      coverage,
      ...(st.modelOff && left > 0 ? { note: NOT_READ_NOTE } : {}),
      ...extra,
    };
  };

  /** Reads the next few of the search closely (nothing while the model is off: those stay to be read). */
  const readNext = (st: RolesSimState): void => {
    const search = st.search;
    if (!search || !st.profile || st.modelOff) return;
    const next = search.order.slice(search.read, search.read + step);
    for (const [i, jobId] of next.entries()) {
      const s = jobs.find((j) => j.id === jobId);
      if (!s) continue;
      const m = score(st.profile, s, st, search.order.length - search.read - i);
      st.matches[m.id] = m;
    }
    search.read += next.length;
  };

  const fail = (status: number, code: string, message: string) =>
    ({ ok: false, status, code, message }) as const;
  const okv = (value: unknown) => ({ ok: true, value }) as const;

  return {
    state: () => state ?? emptyState(),
    close: async (jobId) => {
      const st = await get();
      if (!st.closed.includes(jobId)) st.closed.push(jobId);
      const m = st.matches[`rm_${jobId}`];
      if (m) st.matches[m.id] = { ...m, state: 'gone', job: { ...m.job, closedAt: now().toISOString() } };
      await put();
    },
    setModelOff: async (off) => {
      const st = await get();
      st.modelOff = off;
      await put();
    },
    async handle(route, body) {
      const st = await get();
      switch (route) {
        case '/roles/profile': {
          const req = body as RolesProfileRequest;
          if ('read' in req) {
            const lines = req.read;
            if (!lines?.resume && !lines?.linkedin)
              return fail(400, 'nothing_to_read', 'Add a resume or connect LinkedIn first.');
            const { profile, note } = proposeProfile(lines, now());
            // kept as proposed, as the server keeps it: the student's profile only once they save it
            st.proposed = profile;
            await put();
            return okv({ proposed: profile, note });
          }
          if ('save' in req) {
            st.profile = req.save;
            st.profileAt = now().toISOString();
            await put();
            return okv({ profile: st.profile, ...(st.proposed ? { proposed: st.proposed } : {}) });
          }
          return okv({
            ...(st.profile ? { profile: st.profile } : {}),
            ...(st.proposed ? { proposed: st.proposed } : {}),
          });
        }
        case '/roles/search': {
          if (!st.profile) return fail(409, 'no_profile', 'Build your profile first.');
          const key = profileKey(st.profile);
          // the same profile: the search it has, with what is read so far
          if (!body.fresh && st.search && st.search.profileKey === key) {
            const out = listResponse(st);
            await put();
            return okv(out);
          }
          st.searches++;
          const order = candidates(st.profile, st)
            .slice(0, 60)
            .map((s) => s.id);
          // a role read for this profile before keeps its reading; the others are to be read
          const read = order.filter(
            (j) => st.matches[`rm_${j}`]?.state === 'read' && st.search?.profileKey === key,
          );
          st.search = {
            id: `rs_${key}_${st.searches}`,
            order: [...read, ...order.filter((j) => !read.includes(j))],
            read: read.length,
            profileKey: key,
          };
          for (const j of order)
            if (!read.includes(j) && st.matches[`rm_${j}`]) {
              const had = st.matches[`rm_${j}`]!;
              st.matches[had.id] = {
                id: had.id,
                job: had.job,
                state: 'to_read',
                rank: had.rank,
                status: had.status,
              };
            }
          const out = listResponse(st);
          await put();
          return okv(out);
        }
        case '/roles/more': {
          // a search a newer one replaced, as the server answers it; an id that never was is not found
          if (!st.search || body.searchId !== st.search.id)
            return typeof body.searchId === 'string' && body.searchId.startsWith('rs_')
              ? fail(404, 'search_replaced', SEARCH_REPLACED)
              : fail(404, 'not_found', 'no such search');
          readNext(st);
          const out = listResponse(st);
          await put();
          return okv(out);
        }
        case '/roles/list': {
          const req = body as RolesListRequest;
          const view = req.view ?? 'matches';
          const rest = new Set(view === 'matches' && req.rest ? restIds(st) : []);
          if (rest.size) await put();
          const all = Object.values(st.matches);
          const loose = new Set(st.loose ?? []);
          const matches =
            view === 'saved'
              ? // Saved keeps a role that has since closed, with job.closedAt
                all.filter(
                  (m) => m.status === 'saved' || m.status === 'applied' || m.status === 'interviewing',
                )
              : // the search's roles read closely and the postings scored on their own; with `rest`, also the
                // search's roles not read closely yet (they carry their rough parts)
                all.filter(
                  (m) =>
                    m.status !== 'dismissed' &&
                    !m.job.closedAt &&
                    (!st.search || st.search.order.includes(m.job.id) || loose.has(m.id)) &&
                    (m.state === 'read' || rest.has(m.id)),
                );
          return okv({
            matches: matches.sort((a, b) => (b.fit?.score ?? 0) - (a.fit?.score ?? 0) || a.rank - b.rank),
            searchId: st.search?.id,
            coverage,
            profileAt: st.profileAt,
          });
        }
        case '/roles/score': {
          const req = body as RolesScoreRequest;
          if (!st.profile) return okv({ problem: NO_PROFILE });
          const url = req.url?.trim();
          const known = url ? jobs.find((j) => sameUrl(j.url, url)) : undefined;
          const keepLoose = (id: string) => {
            if (!st.search?.order.includes(id.replace(/^rm_/, '')))
              st.loose = [...new Set([...(st.loose ?? []), id])];
          };
          if (known) {
            const m = score(st.profile, known, st, 0);
            st.matches[m.id] = { ...m, status: st.matches[m.id]?.status ?? 'new' };
            keepLoose(m.id);
            await put();
            return okv({ match: st.matches[m.id] });
          }
          if (url && !/greenhouse\.io|lever\.co|ashbyhq\.com/i.test(url))
            return okv({ problem: "Orbit cannot read this site. Paste the posting's text." });
          const pasted = url ? postingFromBoardUrl(url) : postingFromText(req.text ?? '', req);
          if (!pasted)
            return okv({ problem: 'That does not read like a job posting. Paste the whole posting.' });
          const m = score(st.profile, pasted, st, 0);
          st.matches[m.id] = m;
          keepLoose(m.id);
          await put();
          return okv({ match: m });
        }
        case '/roles/act': {
          const req = body as RolesActRequest;
          if ('watch' in req) {
            const name = req.watch.companyName.trim();
            st.watching = req.watch.on
              ? [...new Set([...st.watching, name])]
              : st.watching.filter((w) => normalizeCompany(w) !== normalizeCompany(name));
            await put();
            return okv({ watching: st.watching });
          }
          const m = st.matches[req.matchId];
          if (!m) return fail(404, 'not_found', 'That role is not in your matches.');
          const next: RoleMatch = {
            ...m,
            status: req.status as MatchStatus,
            dismissReason:
              req.status === 'dismissed' ? ((req.dismissReason ?? 'other') as DismissReason) : undefined,
          };
          st.matches[m.id] = next;
          await put();
          return okv({ match: next });
        }
        default:
          return fail(404, 'not_found', 'No such route.');
      }
    },
  };
}

const sameUrl = (a: string, b: string) =>
  a
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase() ===
  b
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();

/** A board link Orbit does not have: the company from the link, a posting that says little. */
function postingFromBoardUrl(url: string): SampleJob | undefined {
  const m = /(?:greenhouse\.io|lever\.co|ashbyhq\.com)\/([^/]+)\/(?:jobs\/)?([^/?#]+)/i.exec(url);
  if (!m) return undefined;
  const company = m[1]!.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    id: `pasted_${m[1]}_${m[2]}`.slice(0, 80),
    company,
    title: 'Software Engineer',
    family: 'engineering',
    places: [],
    url,
    source: 'posting',
    postedDaysAgo: 0,
    skills: [],
  };
}

/** Pasted text: the role and company from its first lines, the skills it names as requirements. */
function postingFromText(text: string, hint: { title?: string; company?: string }): SampleJob | undefined {
  const t = text.trim();
  if (t.length < 40) return undefined;
  const first = t.split(/\n+/)[0]!.trim();
  const at = /^(.+?)\s+(?:at|@|-|,)\s+(.+)$/.exec(first);
  const title = hint.title ?? at?.[1] ?? first.slice(0, 80);
  const company = hint.company ?? at?.[2] ?? 'The company';
  const skills = SKILL_WORDS.filter((w) => skillShownIn(t, w)).map((w) => {
    const sentence = t.split(/(?<=[.\n])\s*/).find((s) => skillShownIn(s, w)) ?? w;
    return {
      name: w,
      need: /prefer|plus|bonus|nice/i.test(sentence) ? ('nice' as const) : ('must' as const),
      quote: sentence.trim().slice(0, 160),
    };
  });
  return {
    id: `pasted_${normalizeCompany(company)}_${title.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`.slice(0, 80),
    company,
    title,
    family: familyOfTitle(title) ?? 'engineering',
    level: /\bintern/i.test(title) ? 'intern' : /new grad|entry/i.test(title) ? 'entry' : undefined,
    places: [],
    url: '',
    source: 'posting',
    postedDaysAgo: 0,
    skills,
    experienceQuote: undefined,
  };
}
