/**
 * Plan 44: the Roles routes answered from sample roles, the way the server answers them (§5, §6): a profile read
 * from the lines the browser sends, a search that lists the roles to read and is read in steps, a score out of 10
 * from answers with quotes and the formula with its caps, Saved, Watch, and a pasted posting scored now.
 *
 * Two places use it. The demo student's Roles tab runs on it in the browser (the demo never calls a server), kept in
 * the browser's database so a reload finds the same matches. The tests' fake orbit-api answers `/roles/*` with it, so
 * the component and end-to-end tests drive the real client against the real shapes.
 *
 * Pure: no database, no network; the caller passes `load` and `save` to keep its state.
 */
import {
  type DismissReason,
  type Fit,
  type FitAnswers,
  type FitBand,
  type FitCapFact,
  type FitParts,
  type Job,
  type JobLevel,
  type MatchStatus,
  normalizeCompany,
  type ProfileLevel,
  type ProfileLines,
  type RoleKind,
  type RoleMatch,
  type RoleProfile,
  type RolesActRequest,
  type RolesCoverage,
  type RolesListRequest,
  type RolesProfileRequest,
  type RolesScoreRequest,
} from '@orbit/core';
import type { TitleFamily } from '@orbit/core/search';
import { mentions, SAMPLE_COVERAGE, SAMPLE_JOBS, type SampleJob, SKILL_WORDS, skillKey } from './rolesSample';

// ---- the score (plan 44 §6.3 and §6.4), as the server's formula has it ------------------------------------------

const WEIGHTS = { skills: 0.4, experience: 0.3, education: 0.15, level: 0.15 } as const;
const SKILL_VALUE = { work: 1, project: 0.8, listed: 0.35, none: 0 } as const;
const EXPERIENCE_VALUE = { same: 1, related: 0.6, projects: 0.35, none: 0 } as const;
const EDUCATION_VALUE = { fits: 1, close: 0.6, no: 0, unsaid: undefined } as const;
const LEVEL_VALUE = { at: 1, below: 0.6, stretch: 0.4, far: 0 } as const;
const CAP_AT: Record<FitCapFact['kind'], number> = {
  degree: 3,
  years: 4,
  graduation: 4,
  sponsorship: 2,
  citizenship_no: 2,
  citizenship_ask: 5,
  place: 5,
  thin: 7,
};

export function bandOf(score: number): FitBand {
  return score >= 9 ? 'strong' : score >= 7 ? 'good' : score >= 5 ? 'stretch' : 'out';
}

/** The answers to the score: four parts (one left out when the posting is silent), the weights shared, the caps. */
export function fitOf(a: FitAnswers): Fit {
  const parts: FitParts = {};
  if (a.skills.length) {
    const w = a.skills.reduce((s, x) => s + (x.need === 'must' ? 2 : 1), 0);
    parts.skills = a.skills.reduce((s, x) => s + (x.need === 'must' ? 2 : 1) * SKILL_VALUE[x.answer], 0) / w;
  }
  parts.experience = EXPERIENCE_VALUE[a.experience.answer];
  const edu = EDUCATION_VALUE[a.education.answer];
  if (edu !== undefined) parts.education = edu;
  parts.level = LEVEL_VALUE[a.level.answer];
  const present = (Object.keys(WEIGHTS) as (keyof FitParts)[]).filter((k) => parts[k] !== undefined);
  const total = present.reduce((s, k) => s + WEIGHTS[k], 0) || 1;
  const weights: FitParts = {};
  for (const k of present) weights[k] = WEIGHTS[k] / total;
  const sum = present.reduce((s, k) => s + (parts[k] ?? 0) * (weights[k] ?? 0), 0);
  const raw = Math.max(1, Math.min(10, Math.round(1 + 9 * sum)));
  const score = a.caps.reduce((s, c) => Math.min(s, CAP_AT[c.kind]), raw);
  return { score, raw, parts, weights, caps: a.caps, band: bandOf(score) };
}

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

const ym = (d?: string): string | undefined => {
  if (!d) return undefined;
  const m = /^(\d{4})(?:-(\d{2}))?/.exec(d.trim());
  if (!m) return undefined;
  return `${m[1]}-${m[2] ?? '05'}`;
};

const months = (from?: string, to?: string): number => {
  if (!from) return 0;
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = (to ?? from).split('-').map(Number);
  return Math.max(0, ((ty ?? 0) - (fy ?? 0)) * 12 + ((tm ?? 1) - (fm ?? 1)));
};

/** Not a job that counts toward years of experience: internships, campus jobs and research assistantships. */
const NOT_FULL_TIME =
  /\b(intern|internship|teaching assistant|\bta\b|research assistant|campus|co-?op|fellow)\b/i;

/** The levels a profile looks at first: a student internships, a new grad entry roles, and so on (plan 44 §14). */
export function levelsFor(level: ProfileLevel): JobLevel[] {
  switch (level) {
    case 'student':
      return ['intern'];
    case 'new_grad':
      return ['entry'];
    case 'early':
      return ['entry', 'mid'];
    case 'mid':
      return ['mid', 'senior'];
    case 'senior':
      return ['senior', 'lead'];
  }
}

/** Read the lines into a proposed profile: dates decide the level, skills come from what is written or used. */
export function proposeProfile(lines: ProfileLines, now: Date): { profile: RoleProfile; note?: string } {
  const today = now.toISOString().slice(0, 7);
  const r = lines.resume;
  const li = lines.linkedin;
  const school = r?.education[0] ?? (li?.schools[0] ? { ...li.schools[0], lines: [] } : undefined);
  const graduation = ym(school?.end);
  const experience: RoleProfile['experience'] = [];
  const seen = new Set<string>();
  const addJob = (j: { title: string; org?: string; start?: string; end?: string; text: string }) => {
    const key = `${j.title.toLowerCase()}|${normalizeCompany(j.org ?? '')}`;
    if (seen.has(key)) {
      // the same job on both: the one with words wins, and the newer end date
      const had = experience.find((x) => `${x.title.toLowerCase()}|${normalizeCompany(x.org ?? '')}` === key);
      if (had && !had.text && j.text) had.text = j.text;
      if (had && j.end && (!had.end || j.end > had.end)) had.end = ym(j.end);
      return;
    }
    seen.add(key);
    const end = ym(j.end);
    experience.push({
      title: j.title,
      org: j.org,
      start: ym(j.start),
      end,
      fullTime: !NOT_FULL_TIME.test(j.title) && !!graduation && (end ?? today) > graduation,
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
  const haveSkill = (n: string) => skills.some((s) => skillKey(s.name) === skillKey(n));
  for (const s of [...(r?.skills ?? []), ...(li?.skills ?? [])].flatMap((x) => x.split(/[,;]\s*/)))
    if (s.trim() && !haveSkill(s.trim())) skills.push({ name: s.trim(), from: 'written' });
  for (const line of [...experience.map((e) => e.text), ...projects.map((p) => p.text)])
    for (const w of SKILL_WORDS)
      if (line && mentions(line, w) && !haveSkill(w)) skills.push({ name: w, from: 'read', line });
  const fullTimeMonths = experience
    .filter((e) => e.fullTime)
    .reduce((s, e) => s + months(e.start, e.end ?? today), 0);
  const level: ProfileLevel =
    graduation && graduation > today
      ? 'student'
      : fullTimeMonths < 12
        ? 'new_grad'
        : fullTimeMonths < 36
          ? 'early'
          : fullTimeMonths < 96
            ? 'mid'
            : 'senior';
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
    wants: { levels: levelsFor(level), places: [], notPlaces: [], remote: true },
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
  const has = (n: string) => skills.some((s) => skillKey(s.name) === skillKey(n));
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
    const work = workLines.find((w) => mentions(w.text, req.name));
    if (work)
      return { name: req.name, need: req.need, answer: 'work' as const, you: work.text, posting: req.quote };
    const proj = projectLines.find((t) => mentions(t, req.name));
    if (proj)
      return { name: req.name, need: req.need, answer: 'project' as const, you: proj, posting: req.quote };
    const listed = p.skills.find((x) => skillKey(x.name) === skillKey(req.name));
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
  const levelAnswer = levelAnswerFor(p.level, s.level);
  const level = { answer: levelAnswer };
  const caps: FitCapFact[] = [];
  for (const c of s.caps ?? []) {
    if (c.kind === 'citizenship_ask') {
      if (p.eligibility.usCitizen === true) continue;
      caps.push(
        p.eligibility.usCitizen === false
          ? { kind: 'citizenship_no', quote: c.quote, label: 'Asks for US citizenship' }
          : { kind: 'citizenship_ask', quote: c.quote, label: 'Asks for US citizenship. Do you hold it?' },
      );
      continue;
    }
    if (c.kind === 'sponsorship' && p.eligibility.needsSponsorship !== true) continue;
    if (c.kind === 'degree' && p.degree === 'phd') continue;
    if (c.kind === 'years' && p.fullTimeMonths >= 72) continue;
    caps.push({ kind: c.kind, quote: c.quote, label: c.label });
  }
  if (
    s.sponsorship === 'none' &&
    p.eligibility.needsSponsorship &&
    !caps.some((c) => c.kind === 'sponsorship')
  )
    caps.push({ kind: 'sponsorship', label: 'Does not sponsor visas' });
  const onSite = s.remote !== 'remote';
  const out = p.wants.notPlaces.find(
    (np) => onSite && s.places.every((pl) => pl.toLowerCase().includes(np.toLowerCase())),
  );
  if (out) caps.push({ kind: 'place', label: `On site in ${out}` });
  if (s.skills.length < 3 && !caps.some((c) => c.kind === 'thin'))
    caps.push({ kind: 'thin', label: 'The posting says little' });
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

function levelAnswerFor(level: ProfileLevel, job: JobLevel | undefined): FitAnswers['level']['answer'] {
  if (!job) return 'at';
  const rank: Record<JobLevel, number> = { intern: 0, entry: 1, mid: 2, senior: 3, lead: 4, exec: 5 };
  const mine: Record<ProfileLevel, number> = { student: 0, new_grad: 1, early: 1.5, mid: 2.5, senior: 3.5 };
  const d = rank[job] - mine[level];
  return Math.abs(d) <= 0.5 ? 'at' : d < 0 ? 'below' : d <= 1 ? 'stretch' : 'far';
}

// ---- the state a student's roles keep --------------------------------------------------------------------------

export interface RolesSimState {
  profile?: RoleProfile;
  profileAt?: string;
  /** the search now running, its roles in the order they are read */
  search?: { id: string; order: string[]; read: number; profileKey: string };
  matches: Record<string, RoleMatch>;
  watching: string[];
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
    if (st.modelOff) {
      const asked = s.skills.length || 1;
      const have = s.skills.filter((r) => p.skills.some((x) => skillKey(x.name) === skillKey(r.name))).length;
      return {
        id,
        job,
        state: 'failed',
        rank,
        status: had?.status ?? 'new',
        dismissReason: had?.dismissReason,
        roughFit: {
          skills: have / asked,
          level: levelAnswerFor(p.level, s.level) === 'at',
          place: !p.wants.places.length || s.remote === 'remote' || placeFits(p, s),
        },
      };
    }
    const answers = answersFor(p, s);
    const fit = fitOf(answers);
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
      .filter((s) => !p.wants.places.length || placeFits(p, s) || (p.wants.remote && s.remote === 'remote'))
      .filter((s) => st.matches[`rm_${s.id}`]?.status !== 'dismissed')
      .sort((a, b) => cheapRank(p, b) - cheapRank(p, a) || a.postedDaysAgo - b.postedDaysAgo);
  };

  /** §5 step 2, without embeddings: the share of the role's skill words the student has, and entry before not said. */
  const cheapRank = (p: RoleProfile, s: SampleJob) =>
    s.skills.filter((r) => p.skills.some((x) => skillKey(x.name) === skillKey(r.name))).length /
      (s.skills.length || 1) +
    (s.level ? 0.2 : 0);

  const listResponse = (st: RolesSimState, ids: string[], extra: { note?: string } = {}) => {
    const search = st.search;
    return {
      searchId: search?.id ?? '',
      matches: ids.map((id) => st.matches[id]).filter((m): m is RoleMatch => !!m),
      listed: search?.order.length ?? 0,
      read: search?.read ?? 0,
      done: !search || search.read >= search.order.length,
      coverage,
      ...(st.modelOff
        ? {
            note: 'Orbit could not read these roles closely just now. They are ranked by what it can read without that.',
          }
        : {}),
      ...extra,
    };
  };

  const readNext = (st: RolesSimState): string[] => {
    const search = st.search;
    if (!search || !st.profile) return [];
    const ids: string[] = [];
    const next = search.order.slice(search.read, search.read + step);
    for (const jobId of next) {
      const s = jobs.find((j) => j.id === jobId);
      if (!s) continue;
      const m = score(st.profile, s, st, search.read + ids.length + 1);
      st.matches[m.id] = m;
      ids.push(m.id);
    }
    search.read += next.length;
    return ids;
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
            return okv({ proposed: profile, note });
          }
          if ('save' in req) {
            st.profile = req.save;
            st.profileAt = now().toISOString();
            await put();
            return okv({ profile: st.profile });
          }
          return okv({ profile: st.profile });
        }
        case '/roles/search': {
          if (!st.profile) return fail(409, 'no_profile', 'Build your profile first.');
          const key = profileKey(st.profile);
          // the same profile and a search that is not done: carry on with it
          if (!body.fresh && st.search && st.search.profileKey === key) {
            const ids = st.search.order
              .map((j) => `rm_${j}`)
              .filter((id) => st.matches[id] && st.matches[id]!.state !== 'to_read');
            return okv(listResponse(st, ids));
          }
          st.searches++;
          const order = candidates(st.profile, st)
            .slice(0, 60)
            .map((s) => s.id);
          st.search = { id: `rs_${key}_${st.searches}`, order, read: 0, profileKey: key };
          await put();
          return okv(listResponse(st, []));
        }
        case '/roles/more': {
          if (!st.search || body.searchId !== st.search.id)
            return fail(404, 'search_gone', 'That search was replaced by a newer one.');
          const ids = readNext(st);
          await put();
          return okv(listResponse(st, ids));
        }
        case '/roles/list': {
          const view = (body as RolesListRequest).view ?? 'matches';
          const all = Object.values(st.matches);
          const matches =
            view === 'saved'
              ? all.filter(
                  (m) => m.status === 'saved' || m.status === 'applied' || m.status === 'interviewing',
                )
              : all.filter(
                  (m) =>
                    m.status !== 'dismissed' &&
                    !m.job.closedAt &&
                    (!st.search || st.search.order.includes(m.job.id)) &&
                    m.state !== 'to_read',
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
          if (!st.profile)
            return okv({ problem: 'Build your profile in Roles first, then Orbit can score postings.' });
          const url = req.url?.trim();
          const known = url ? jobs.find((j) => sameUrl(j.url, url)) : undefined;
          if (known) {
            const m = score(st.profile, known, st, 0);
            st.matches[m.id] = { ...m, status: st.matches[m.id]?.status ?? 'new' };
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
          return okv({ match: next, watching: st.watching });
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
  const skills = SKILL_WORDS.filter((w) => mentions(t, w)).map((w) => {
    const sentence = t.split(/(?<=[.\n])\s*/).find((s) => mentions(s, w)) ?? w;
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
