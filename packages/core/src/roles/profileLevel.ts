/**
 * Plan 44 §3 and §14: the student's level from dates, never from a guess, and the role levels it searches.
 *
 *   graduation more than a year away        student   → internships
 *   graduation within a year either side    new_grad  → entry roles
 *   full-time months after school < 36      early     → entry and mid
 *                                 < 84      mid       → mid and senior
 *                                 else      senior    → senior, lead and executive
 *
 * Internships, co-ops, campus jobs, research and teaching assistantships never count as months of full-time work. A
 * role whose level the posting does not say is searched at every level (the filter keeps "not said").
 */
import type { JobLevel, LevelAnswer, ProfileExperience, ProfileLevel, RoleProfile } from './types';

/** Titles that are never full-time work after school. */
const NOT_FULL_TIME =
  /\b(intern|interns|internship|co-?op|apprentice|trainee|research assistant|teaching assistant|undergraduate|graduate student|student|fellow(ship)?|tutor|ta|ra|campus|summer analyst|summer associate|volunteer|part[- ]time)\b/i;

/** Whether a job, by its title, can be full-time work. */
export function fullTimeTitle(title: string): boolean {
  return !NOT_FULL_TIME.test(title);
}

/** "2027-05", "2027-05-15", "May 2027", "2027" → YYYY-MM; anything else undefined. */
export function yearMonth(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (/^(present|current|now|today)$/i.test(s)) return undefined;
  let m = /^(\d{4})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}`;
  m = /^(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[2]}-${m[1]!.padStart(2, '0')}`;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = /^([a-z]{3})[a-z]*\.?\s+(\d{4})$/i.exec(s);
  if (m) {
    const i = months.indexOf(m[1]!.toLowerCase());
    if (i >= 0) return `${m[2]}-${String(i + 1).padStart(2, '0')}`;
  }
  // a season: spring ends in May, summer in August, fall and winter in December
  m = /^(spring|summer|fall|autumn|winter)\s+(\d{4})$/i.exec(s);
  if (m) {
    const end = { spring: '05', summer: '08', fall: '12', autumn: '12', winter: '12' }[
      m[1]!.toLowerCase() as 'spring'
    ];
    return `${m[2]}-${end}`;
  }
  m = /^(\d{4})$/.exec(s);
  // a bare year of graduation is the spring of that year
  if (m) return `${m[1]}-05`;
  return undefined;
}

const monthIndex = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const nowYm = (now: Date) => `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * Months of full-time work after school: full-time jobs only, counted from graduation (or their start, when later),
 * overlapping jobs counted once. With no graduation date, every full-time job counts.
 */
export function fullTimeMonthsOf(
  experience: Pick<ProfileExperience, 'start' | 'end' | 'fullTime'>[],
  graduation: string | undefined,
  now: Date,
): number {
  const today = monthIndex(nowYm(now));
  const from = graduation ? monthIndex(graduation) : undefined;
  const months = new Set<number>();
  for (const e of experience) {
    if (!e.fullTime) continue;
    const s = yearMonth(e.start);
    if (!s) continue;
    const end = yearMonth(e.end);
    let a = monthIndex(s);
    const b = Math.min(end ? monthIndex(end) : today, today);
    if (from !== undefined) a = Math.max(a, from);
    for (let m = a; m <= b && months.size < 1200; m++) months.add(m);
  }
  return months.size;
}

/** The student's level from their dates (§3). */
export function profileLevelOf(
  p: Pick<RoleProfile, 'graduation' | 'fullTimeMonths'>,
  now: Date,
): ProfileLevel {
  const months = p.fullTimeMonths ?? 0;
  if (p.graduation) {
    const away = monthIndex(p.graduation) - monthIndex(nowYm(now));
    if (away > 12) return 'student';
    if (away >= -12 && months < 12) return 'new_grad';
  }
  if (!p.graduation && months === 0) return 'new_grad';
  if (months < 36) return 'early';
  if (months < 84) return 'mid';
  return 'senior';
}

/** The role levels a profile level searches (plan 44 §14). "Not said" is kept at every level by the filter. */
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
      return ['senior', 'lead', 'exec'];
  }
}

const JOB_RANK: Record<JobLevel, number> = { intern: 0, entry: 1, mid: 2, senior: 3, lead: 4, exec: 5 };

/**
 * How a role's level sits against the student's (§6.3), as a hint for the close read and the answer when the posting
 * says its level: at their level, below them, a stretch (one step up), far above. Undefined when the role does not say.
 */
export function levelAnswerOf(
  profile: ProfileLevel,
  job: JobLevel | undefined | null,
): LevelAnswer | undefined {
  if (!job) return undefined;
  const home = levelsFor(profile).map((l) => JOB_RANK[l]);
  const r = JOB_RANK[job];
  const lo = Math.min(...home);
  const hi = Math.max(...home);
  if (r >= lo && r <= hi) return 'at';
  if (r < lo) return 'below';
  return r - hi === 1 ? 'stretch' : 'far';
}
