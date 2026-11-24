/**
 * Plan 44 §6: the score out of 10. The model answers fixed questions about a student and a role, each with quoted
 * lines; this file turns the answers into the number. The same answers always give the same score, and a change to
 * any value here is a diff with tests.
 *
 *   fit = round(1 + 9 x weighted sum of the parts), then the caps (§6.4)
 *
 * A part the posting says nothing about is left out and the others share its weight in proportion (§6.3). Silence is
 * not credit. Caps are facts from the posting set against what the student said (`capsFor`), never the model's call.
 */
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

/** Draft 3 numbers (§6.3). Tuning is a diff to this one object. */
export const FIT_WEIGHTS = {
  /** each part's share of the sum before left-out parts are shared out */
  parts: { skills: 0.4, experience: 0.3, education: 0.15, level: 0.15 },
  skill: { work: 1, project: 0.8, listed: 0.35, none: 0 } satisfies Record<SkillAnswer, number>,
  /** how much one skill counts in the skills part */
  need: { must: 2, nice: 1 },
  experience: { same: 1, related: 0.6, projects: 0.35, none: 0 } satisfies Record<ExperienceAnswer, number>,
  /** `unsaid`: the part is left out */
  education: { fits: 1, close: 0.6, no: 0, unsaid: undefined } satisfies Record<
    EducationAnswer,
    number | undefined
  >,
  level: { at: 1, below: 0.6, stretch: 0.4, far: 0 } satisfies Record<LevelAnswer, number>,
  /** the most each fact lets the score be (§6.4) */
  caps: {
    degree: 3,
    years: 4,
    graduation: 4,
    sponsorship: 2,
    citizenship_no: 2,
    citizenship_ask: 5,
    place: 5,
    // §6.4 drafted this at 7. A posting that says little cannot be called a good fit on paper, because there is
    // little paper: at 7 it was the one cap under which a role still showed as a good fit (§6.7: none may)
    thin: 6,
  } satisfies Record<FitCapKind, number>,
  /** fewer requirements than this and the posting "says little" */
  thinBelow: 3,
} as const;

const PART_KEYS = ['skills', 'experience', 'education', 'level'] as const;

/** Score → words (§6.5). */
export function bandOf(score: number): FitBand {
  if (score >= 9) return 'strong';
  if (score >= 7) return 'good';
  if (score >= 5) return 'stretch';
  return 'out';
}

/** What the band says to a student. */
export const BAND_WORDS: Record<FitBand, string> = {
  strong: 'Strong fit',
  good: 'Good fit',
  stretch: 'A stretch',
  out: 'Out of reach for now',
};

export interface FitOptions {
  /** how many requirements the posting gives; fewer than three adds the `thin` cap */
  requirements?: number;
}

/** Each part's value 0 to 1, or undefined when it is left out. */
export function partsOf(a: FitAnswers): FitParts {
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
  return parts;
}

/** The answers → the score, its parts, the weights used and the caps that held it down. */
export function fitOf(answers: FitAnswers, o: FitOptions = {}): Fit {
  const parts = partsOf(answers);
  const present = PART_KEYS.filter((k) => parts[k] !== undefined);
  const share = present.reduce((s, k) => s + FIT_WEIGHTS.parts[k], 0);
  const weights: FitParts = {};
  let sum = 0;
  for (const k of present) {
    const w = share > 0 ? FIT_WEIGHTS.parts[k] / share : 0;
    weights[k] = w;
    sum += w * parts[k]!;
  }
  // floating point: 0.62 must not come out as 0.6199999 and round the wrong way
  const raw = clamp(Math.round(1 + (9 * Math.round(sum * 1e9)) / 1e9), 1, 10);
  const caps = [...(answers.caps ?? [])];
  if (
    o.requirements !== undefined &&
    o.requirements < FIT_WEIGHTS.thinBelow &&
    !caps.some((c) => c.kind === 'thin')
  )
    caps.push(THIN_CAP);
  let score = raw;
  for (const c of caps) score = Math.min(score, FIT_WEIGHTS.caps[c.kind] ?? 10);
  score = clamp(score, 1, 10);
  return { score, raw, parts, weights, caps, band: bandOf(score) };
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
