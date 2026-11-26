/**
 * The fit score out of 100 (plan 44 §6, made finer in plan 46). The model answers fixed questions about a student and
 * a role, each with quoted lines; this file turns the answers into the number. The same answers always give the same
 * score, and a change to any value here is a diff with tests.
 *
 *   fit = round(100 x weighted sum of the parts) - a missing must-have skill's share of MISSING_MUST, then the caps
 *
 * Five parts, as the research on what predicts a callback weighs them (skills and the kind of experience first, the
 * degree and field next, the level, and whether the role is the kind of work the student is after):
 *   skills 35, experience 25, education 15, level 10, goals 15.
 * A part the posting says nothing about is left out and the others share its weight in proportion. Silence is not
 * credit. Caps are facts from the posting set against what the student said (`capsFor`), never the model's call. The
 * way in (who the student knows there) is never part of the fit: it is shown beside it and ranks the list.
 */
import { kindFamilies, titleMatch } from './rank';
import type {
  EducationAnswer,
  ExperienceAnswer,
  Fit,
  FitAnswers,
  FitBand,
  FitCapFact,
  FitCapKind,
  FitParts,
  Job,
  JobRequirement,
  LevelAnswer,
  RoleProfile,
  SkillAnswer,
} from './types';

/** Tuning is a diff to this one object. */
export const FIT_WEIGHTS = {
  /** each part's share of the sum before left-out parts are shared out */
  parts: { skills: 0.35, experience: 0.25, education: 0.15, level: 0.1, goals: 0.15 },
  skill: { work: 1, project: 0.75, listed: 0.35, none: 0 } satisfies Record<SkillAnswer, number>,
  /** how much one skill counts in the skills part */
  need: { must: 2, nice: 1 },
  /** points off when must-have skills show nowhere, scaled by the share of must-haves missing */
  missingMust: 15,
  experience: { same: 1, related: 0.6, projects: 0.35, none: 0 } satisfies Record<ExperienceAnswer, number>,
  /** `unsaid`: the part is left out */
  education: { fits: 1, close: 0.6, no: 0, unsaid: undefined } satisfies Record<
    EducationAnswer,
    number | undefined
  >,
  level: { at: 1, below: 0.6, stretch: 0.45, far: 0 } satisfies Record<LevelAnswer, number>,
  /** goals: how much of the part is the kind of work, and how much the place */
  goals: { kind: 0.75, place: 0.25, sameFamily: 0.6 },
  /** the most each fact lets the score be */
  caps: {
    degree: 30,
    years: 40,
    graduation: 40,
    sponsorship: 20,
    citizenship_no: 20,
    citizenship_ask: 50,
    place: 50,
    // a posting that says little cannot be called a good fit on paper, because there is little paper
    thin: 60,
  } satisfies Record<FitCapKind, number>,
  /** fewer requirements than this and the posting "says little" */
  thinBelow: 3,
  /** the bands' lower bounds */
  bands: { strong: 80, good: 65, stretch: 50 },
} as const;

const PART_KEYS = ['skills', 'experience', 'education', 'level', 'goals'] as const;

/** Score → words. */
export function bandOf(score: number): FitBand {
  if (score >= FIT_WEIGHTS.bands.strong) return 'strong';
  if (score >= FIT_WEIGHTS.bands.good) return 'good';
  if (score >= FIT_WEIGHTS.bands.stretch) return 'stretch';
  return 'out';
}

/** What the band says to a student. */
export const BAND_WORDS: Record<FitBand, string> = {
  strong: 'Strong fit',
  good: 'Good fit',
  stretch: 'A stretch',
  out: 'Out of reach for now',
};

/** What each part is called where its bar is shown. */
export const PART_WORDS: Record<(typeof PART_KEYS)[number], string> = {
  skills: 'Skills',
  experience: 'Experience',
  education: 'Education',
  level: 'Level',
  goals: 'Your goals',
};

export interface FitOptions {
  /** how many requirements the posting gives; fewer than three adds the `thin` cap */
  requirements?: number;
  /** 0 to 1: how well the role is the kind of work and the place the student is after (`goalsOf`) */
  goals?: number;
}

/** Each part's value 0 to 1, or undefined when it is left out. */
export function partsOf(a: FitAnswers, goals?: number): FitParts {
  const parts: FitParts = {};
  let total = 0;
  let got = 0;
  for (const s of a.skills ?? []) {
    const w = FIT_WEIGHTS.need[s.need] ?? 1;
    total += w;
    got += w * (FIT_WEIGHTS.skill[s.answer] ?? 0);
  }
  if (total > 0) parts.skills = got / total;
  const exp = a.experience?.answer;
  if (exp !== undefined) parts.experience = FIT_WEIGHTS.experience[exp] ?? 0;
  const edu = a.education?.answer;
  const eduValue = edu === undefined ? undefined : FIT_WEIGHTS.education[edu];
  if (eduValue !== undefined) parts.education = eduValue;
  const lvl = a.level?.answer;
  if (lvl !== undefined) parts.level = FIT_WEIGHTS.level[lvl] ?? 0;
  if (goals !== undefined) parts.goals = clamp(goals, 0, 1);
  return parts;
}

/** The share of must-have skills the student's lines show nowhere, 0 to 1. */
export function missingMustOf(a: FitAnswers): number {
  const musts = (a.skills ?? []).filter((s) => s.need === 'must');
  if (!musts.length) return 0;
  return musts.filter((s) => s.answer === 'none').length / musts.length;
}

/** The answers → the score out of 100, its parts, the weights used and the caps that held it down. */
export function fitOf(answers: FitAnswers, o: FitOptions = {}): Fit {
  const parts = partsOf(answers, o.goals);
  const present = PART_KEYS.filter((k) => parts[k] !== undefined);
  const share = present.reduce((s, k) => s + FIT_WEIGHTS.parts[k], 0);
  const weights: FitParts = {};
  let sum = 0;
  for (const k of present) {
    const w = share > 0 ? FIT_WEIGHTS.parts[k] / share : 0;
    weights[k] = w;
    sum += w * parts[k]!;
  }
  // floating point: 0.625 must not come out as 0.62499999 and round the wrong way
  const exact = Math.round(sum * 1e9) / 1e9;
  const raw = clamp(Math.round(100 * exact - FIT_WEIGHTS.missingMust * missingMustOf(answers)), 0, 100);
  const caps = [...(answers.caps ?? [])];
  if (
    o.requirements !== undefined &&
    o.requirements < FIT_WEIGHTS.thinBelow &&
    !caps.some((c) => c.kind === 'thin')
  )
    caps.push(THIN_CAP);
  let score = raw;
  for (const c of caps) score = Math.min(score, FIT_WEIGHTS.caps[c.kind] ?? 100);
  score = clamp(score, 0, 100);
  return { score, raw, parts, weights, caps, band: bandOf(score), scale: 100 };
}

const placeIn = (places: string[], wanted: string[]) =>
  places.some((p) => wanted.some((w) => w.trim() && p.toLowerCase().includes(w.trim().toLowerCase())));

/**
 * The goals part, 0 to 1: is the role the kind of work the student ticked (its title's words, or at least its
 * family), and where they want to be (a place they named, or remote when they asked for it). Undefined when the
 * student ticked no kind and named no place: nothing to measure against, so the part is left out.
 */
export function goalsOf(
  job: Pick<Job, 'title' | 'places' | 'remote'> & Partial<Pick<Job, 'family'>>,
  profile: Pick<RoleProfile, 'kinds' | 'wants'>,
): number | undefined {
  const kinds = (profile.kinds ?? []).filter((k) => k.on);
  const wants = profile.wants ?? { places: [], remote: false };
  const placed = (wants.places?.length ?? 0) > 0 || !!wants.remote;
  if (!kinds.length && !placed) return undefined;
  let kind: number | undefined;
  if (kinds.length) {
    kind = titleMatch(job.title, kinds);
    if (job.family && kinds.some((k) => kindFamilies(k).includes(job.family!)))
      kind = Math.max(kind, FIT_WEIGHTS.goals.sameFamily);
  }
  const place = placed
    ? (wants.remote && job.remote === 'remote') || placeIn(job.places, wants.places ?? [])
      ? 1
      : 0
    : undefined;
  if (kind === undefined) return place;
  if (place === undefined) return kind;
  return FIT_WEIGHTS.goals.kind * kind + FIT_WEIGHTS.goals.place * place;
}

/**
 * A fit as it is kept on any row, on the scale of 100. Rows read before the score went out of 100 hold a score out of
 * 10 (no `scale`): with their answers kept, they are scored again here (the same answers always give the same score);
 * without, the old number is carried over at ten times.
 */
export function fitOnHundred(
  fit: Fit | undefined,
  answers?: FitAnswers,
  o: FitOptions = {},
): Fit | undefined {
  if (!fit) return undefined;
  if (fit.scale === 100) return fit;
  if (answers) return fitOf(answers, o);
  const score = clamp(Math.round(fit.score * 10), 0, 100);
  return { ...fit, score, raw: clamp(Math.round(fit.raw * 10), 0, 100), band: bandOf(score), scale: 100 };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export const THIN_CAP: FitCapFact = { kind: 'thin', label: 'The posting says little' };

const DEGREE_RANK: Record<NonNullable<JobRequirement['degree']>, number> = {
  high_school: 0,
  associate: 1,
  bachelor: 2,
  master: 3,
  mba: 3,
  jd: 4,
  md: 4,
  phd: 5,
};

const DEGREE_WORDS: Record<NonNullable<JobRequirement['degree']>, string> = {
  high_school: 'a high school diploma',
  associate: "an associate's degree",
  bachelor: "a bachelor's degree",
  master: "a master's degree",
  mba: 'an MBA',
  jd: 'a JD',
  md: 'an MD',
  phd: 'a PhD',
};

/** "2027-05" → "2027". */
const yearOf = (ym?: string) => (ym ? ym.slice(0, 4) : undefined);

/** The place words a role lists, lowercased, for matching against what the student excluded. */
const placeHits = (places: string[], words: string[]) =>
  places.length > 0 &&
  words.length > 0 &&
  places.every((p) => words.some((w) => w.trim() && p.toLowerCase().includes(w.trim().toLowerCase())));

/**
 * The caps (§6.4) for one student and one role, from the requirements read from the posting and the role's own
 * fields, set against what the student said. Unknown is never a cap: a posting silent on sponsorship holds nobody
 * down, and neither does a student who was never asked, except for citizenship, which is asked once. One cap comes
 * from the role itself: an internship, for someone who is no longer a student or a new graduate.
 */
export function capsFor(
  reqs: JobRequirement[],
  profile: Pick<RoleProfile, 'degree' | 'graduation' | 'fullTimeMonths' | 'eligibility' | 'wants' | 'level'>,
  job?: Pick<Job, 'places' | 'remote' | 'sponsorship'> & Partial<Pick<Job, 'level'>>,
): FitCapFact[] {
  const caps: FitCapFact[] = [];
  const add = (c: FitCapFact) => {
    if (!caps.some((x) => x.kind === c.kind)) caps.push(c);
  };
  const studying = profile.level === 'student' || profile.level === 'new_grad';
  const have = profile.degree ? DEGREE_RANK[profile.degree] : studying ? DEGREE_RANK.bachelor : -1;
  for (const r of reqs) {
    if (r.need !== 'must') continue;
    if (r.kind === 'education' && r.degree) {
      // a doctorate or professional degree the student does not have and is not working toward
      const asked = DEGREE_RANK[r.degree];
      if (asked >= DEGREE_RANK.jd && have < asked)
        add({ kind: 'degree', quote: r.quote, label: `Asks for ${DEGREE_WORDS[r.degree]}` });
    }
    if (r.kind === 'experience' && r.years !== undefined && r.years > 0) {
      const theirs = Math.floor((profile.fullTimeMonths ?? 0) / 12);
      if (r.years - theirs >= 3) add({ kind: 'years', quote: r.quote, label: `Asks for ${r.years} years` });
    }
    if (r.kind === 'eligibility') {
      if (r.eligibility === 'graduation_window' && profile.graduation && (r.gradFrom || r.gradTo)) {
        const g = profile.graduation;
        const outside = (r.gradFrom && g < r.gradFrom) || (r.gradTo && g > r.gradTo);
        if (outside) {
          const from = yearOf(r.gradFrom);
          const to = yearOf(r.gradTo);
          add({
            kind: 'graduation',
            quote: r.quote,
            label:
              from && to && from !== to ? `For ${from} to ${to} graduates` : `For ${to ?? from} graduates`,
          });
        }
      }
      if (r.eligibility === 'no_sponsorship' && profile.eligibility.needsSponsorship === true)
        add({ kind: 'sponsorship', quote: r.quote, label: 'Does not sponsor visas' });
      if (r.eligibility === 'citizenship' || r.eligibility === 'clearance') {
        const words = r.eligibility === 'clearance' ? 'a security clearance' : 'US citizenship';
        if (profile.eligibility.usCitizen === false)
          add({ kind: 'citizenship_no', quote: r.quote, label: `Asks for ${words}` });
        else if (profile.eligibility.usCitizen === undefined)
          add({ kind: 'citizenship_ask', quote: r.quote, label: `Asks for ${words}. Do you hold it?` });
      }
    }
  }
  // an internship is for people still studying (or just finishing): someone a year or more into full-time work is
  // outside it whatever the posting says of dates, as they are outside a graduation window
  if (job?.level === 'intern' && !studying)
    add({ kind: 'graduation', label: 'An internship, for current students' });
  if (job?.sponsorship === 'none' && profile.eligibility.needsSponsorship === true)
    add({ kind: 'sponsorship', label: 'Does not sponsor visas' });
  if (job && job.remote !== 'remote' && placeHits(job.places, profile.wants.notPlaces))
    add({ kind: 'place', label: `On site in ${job.places[0]}` });
  // two caps of one kind of fact: keep the stricter
  if (caps.some((c) => c.kind === 'citizenship_no')) return caps.filter((c) => c.kind !== 'citizenship_ask');
  return caps;
}
