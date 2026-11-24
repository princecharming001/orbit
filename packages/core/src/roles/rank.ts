/**
 * Plan 44 §5 step 2: the free ranking. Every role that passed the filter gets a number from what can be read without
 * a model, and the top of the list is read closely first. Higher is better; equal numbers keep their order.
 *
 *   title      the role's title against the kinds the student ticked: shared words, and the same job family
 *   level      at the student's level lifts a role over one whose level is not said
 *   skills     the student's skills named in the title or team
 *   place      in a place the student wants, or remote when they want remote
 *   warm       a company where the student knows someone (§6.6: this lifts the reading order, never the score)
 *   recency    newer first, fading over two months
 */
import { titleWords } from '../recommend/title';
import { readTitle, type TitleFamily } from '../search/titles';
import { skillIn } from './skills';
import type { JobLevel, Remote } from './types';

/** How much each signal adds. One constant, so tuning is a diff. */
export const RANK_WEIGHTS = {
  title: 3,
  family: 1.5,
  atLevel: 1,
  levelUnsaid: 0.4,
  /** per skill named in the title or team, at most `skillsMax` */
  skill: 0.5,
  skillsMax: 1,
  place: 0.7,
  /** when the student named no place, every role gets this */
  anyPlace: 0.35,
  warm: 0.8,
  recency: 0.5,
  recencyDays: 60,
} as const;

export interface RankCandidate {
  id: string;
  title: string;
  titleKey?: string;
  team?: string;
  family?: string;
  level?: JobLevel;
  places: string[];
  remote?: Remote;
  companyKey: string;
  postedAt?: string;
  firstSeenAt?: string;
}

export interface RankContext {
  kinds: { title: string; family?: TitleFamily }[];
  /** the levels searched */
  levels: JobLevel[];
  skills: string[];
  places: string[];
  remote: boolean;
  /** company keys where the student knows someone */
  warm: ReadonlySet<string>;
  now: Date;
}

const STOP = new Set([
  'and',
  'of',
  'the',
  'a',
  'an',
  'in',
  'for',
  'at',
  'to',
  'with',
  'on',
  '&',
  'i',
  'ii',
  'iii',
]);
/** words of one job said differently */
const SAME: Record<string, string> = {
  engineering: 'engineer',
  engineers: 'engineer',
  developer: 'engineer',
  swe: 'engineer',
  analytics: 'analyst',
  analysts: 'analyst',
  management: 'manager',
  pm: 'manager',
  designers: 'designer',
  design: 'designer',
  scientists: 'scientist',
  science: 'scientist',
  internship: 'intern',
  interns: 'intern',
  sw: 'software',
};

/** A title's words that say what the role is (level words and filler left out), one form each. */
export function roleTitleWords(title: string): Set<string> {
  const out = new Set<string>();
  for (const w of titleWords(title)) if (!STOP.has(w)) out.add(SAME[w] ?? w);
  return out;
}

/** The families of a kind: its own, and what its title reads as. */
export function kindFamilies(k: { title: string; family?: TitleFamily }): TitleFamily[] {
  const f = new Set<TitleFamily>(readTitle(k.title).families.filter((x) => x !== 'student'));
  if (k.family) f.add(k.family);
  return [...f];
}

/** 0 to 1: the best share of one kind's words found in the role's title. */
export function titleMatch(title: string, kinds: { title: string }[]): number {
  const have = roleTitleWords(title);
  let best = 0;
  for (const k of kinds) {
    const want = roleTitleWords(k.title);
    if (!want.size) continue;
    let hit = 0;
    for (const w of want) if (have.has(w)) hit++;
    best = Math.max(best, hit / want.size);
  }
  return best;
}

const placeMatch = (places: string[], wanted: string[]) =>
  places.some((p) => wanted.some((w) => w.trim() && p.toLowerCase().includes(w.trim().toLowerCase())));

/** The free rank of one role. */
export function rankOf(c: RankCandidate, ctx: RankContext): number {
  const W = RANK_WEIGHTS;
  let r = W.title * titleMatch(c.title, ctx.kinds);
  const families = new Set(ctx.kinds.flatMap(kindFamilies));
  if (c.family && families.has(c.family as TitleFamily)) r += W.family;
  if (c.level && ctx.levels.includes(c.level)) r += W.atLevel;
  else if (!c.level) r += W.levelUnsaid;
  const where = `${c.title} ${c.team ?? ''}`;
  let skills = 0;
  for (const s of ctx.skills) if (skillIn(where, s)) skills += W.skill;
  r += Math.min(W.skillsMax, skills);
  if (!ctx.places.length && !ctx.remote) r += W.anyPlace;
  else if (placeMatch(c.places, ctx.places) || (ctx.remote && c.remote === 'remote')) r += W.place;
  if (ctx.warm.has(c.companyKey)) r += W.warm;
  const at = Date.parse(c.postedAt ?? c.firstSeenAt ?? '');
  if (Number.isFinite(at)) {
    const days = Math.max(0, (ctx.now.getTime() - at) / 86_400_000);
    r += W.recency * Math.max(0, 1 - days / W.recencyDays);
  }
  return Math.round(r * 1000) / 1000;
}

/** Ranked, best first; equal ranks keep the order they came in. */
export function rankRoles<T extends RankCandidate>(cands: T[], ctx: RankContext): (T & { rank: number })[] {
  return cands
    .map((c, i) => ({ c: { ...c, rank: rankOf(c, ctx) }, i }))
    .sort((a, b) => b.c.rank - a.c.rank || a.i - b.i)
    .map((x) => x.c);
}
