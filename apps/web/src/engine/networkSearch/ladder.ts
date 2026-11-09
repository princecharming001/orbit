/**
 * No dead ends (plan 36): when a network search finds nobody who fits, the free rungs of the ladder run here, on the
 * same people the search read, so the answer always shows someone and says honestly what tier they are.
 *   related    people the student knows whose words or company name the field or a neighbour of it
 *   former     the same ask with past jobs (someone who used to work there)
 *   intro      a warm intro path into a named company (Village, or the demo graph)
 *   connector  the people the student knows best who are likeliest to know someone there (said as a guess)
 * The paid rungs (find_people, the web) are the chat model's next step, never run from here.
 */
import type { Organization, Person, User } from '@orbit/core';
import { INDUSTRY_WORDS, industryTerms, type QuerySpec, runSpec } from '@orbit/core/search';
import { db } from '../../db/schema';
import { reachCompany } from '../graph';
import { warmIntrosFor } from '../warmIntros';
import type { SearchWorld } from './docs';
import { rowView, type SearchSet, worldOfSet } from './index';

export type LadderTier = 'related' | 'former' | 'intro' | 'connector';

export interface LadderRow {
  personId: string;
  name: string;
  title?: string;
  company?: string;
  tier: LadderTier;
  /** why they are here, in plain words; never that they match */
  why: string;
  warmth: string;
  /** for an intro: who they lead to */
  via?: string;
}

export interface LadderRung {
  tier: LadderTier;
  /** the section heading on the card */
  label: string;
  rows: LadderRow[];
}

export interface Ladder {
  /** what the ask was about, in the student's words ("climate", "Stripe") */
  topic: string;
  rungs: LadderRung[];
  /** someone in rung 1 or 2 nearly fits; otherwise only people who could introduce the student */
  nearFit: boolean;
}

export const RUNG_LABELS: Record<LadderTier, string> = {
  related: 'Related field',
  former: 'Used to work there',
  intro: 'Can introduce you',
  connector: 'Could know someone',
};

/** Words next to an industry that its own word list leaves out ("climate" also reaches utilities and ESG). */
const NEIGHBOURS: Record<string, string[]> = {
  climate: [
    'renewables',
    'renewable energy',
    'wind',
    'grid',
    'utilities',
    'utility',
    'electric vehicles',
    'electrification',
    'decarbonization',
    'esg',
    'environmental',
    'cleantech',
    'hydrogen',
    'nuclear',
    'geothermal',
    'emissions',
    'net zero',
    'power',
    'energy storage',
    'agtech',
  ],
  fintech: ['investment banking', 'trading', 'wealth', 'asset management', 'markets'],
  ai: ['data science', 'data scientist', 'research scientist', 'deep learning', 'machine learning engineer'],
  health: ['biotech', 'pharma', 'hospital', 'clinical', 'public health'],
  bio: ['healthcare', 'pharma', 'chemistry', 'lab'],
  crypto: ['payments', 'trading', 'fintech'],
  hardware: ['mechanical', 'electrical engineering', 'embedded'],
};

/** Every word a field ask reaches: its own words, the industry's list, then the neighbours. */
export function relatedTerms(words: readonly string[]): string[] {
  const out = new Set(industryTerms(words));
  for (const raw of words) {
    const w = raw.toLowerCase().trim();
    for (const [k, list] of Object.entries(INDUSTRY_WORDS))
      if (k === w || list.includes(w)) for (const t of NEIGHBOURS[k] ?? []) out.add(t);
  }
  return [...out].filter((t) => t.length >= 2);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordIn = (text: string | undefined, w: string) =>
  !!text && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(w)}(?![\\p{L}\\p{N}])`, 'iu').test(text);

/** The field words of an ask: industries, topics and the plain words of its criteria. */
function fieldWords(spec: QuerySpec): string[] {
  const out: string[] = [];
  for (const p of spec.positions ?? []) if (!p.negate) out.push(...(p.company?.industries ?? []));
  out.push(...(spec.keywords && !spec.keywords.negate ? spec.keywords.terms : []));
  for (const c of spec.criteria ?? [])
    out.push(
      ...c.text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3 && !STOP.has(w)),
    );
  return [...new Set(out.map((w) => w.trim()).filter(Boolean))];
}

const STOP = new Set([
  'works',
  'work',
  'working',
  'with',
  'have',
  'from',
  'that',
  'they',
  'into',
  'about',
  'people',
]);

function companyNames(spec: QuerySpec): string[] {
  return (spec.positions ?? []).filter((p) => !p.negate).flatMap((p) => p.company?.names ?? []);
}

/** The thing the ask is about, for the card and the reply. */
export function topicOf(spec: QuerySpec): string {
  return (
    fieldWords(spec)[0] ??
    companyNames(spec)[0] ??
    spec.schools?.[0]?.names[0] ??
    spec.positions?.[0]?.role?.titles?.[0] ??
    spec.positions?.[0]?.role?.families?.[0] ??
    spec.places?.[0]?.names[0] ??
    spec.ask
  );
}

/** An ask about what someone does or where (not only about the tie): the ladder has something to look for. */
export function hasSubject(spec: QuerySpec): boolean {
  return !!(
    spec.positions?.some((p) => !p.negate) ||
    spec.schools?.some((s) => !s.negate) ||
    spec.places?.some((p) => !p.negate) ||
    (spec.keywords && !spec.keywords.negate) ||
    spec.criteria?.length
  );
}

const FIELD_SAYS: [keyof SearchWorld['docs'][number]['text'], string][] = [
  ['headline', 'Headline mentions'],
  ['title', 'Title mentions'],
  ['org', 'Works at a company named for'],
  ['summary', 'Profile mentions'],
  ['topics', 'Profile mentions'],
  ['jobs', 'A past job mentions'],
  ['tags', 'You tagged them'],
  ['notes', 'Your notes mention'],
];

const RELATED_MAX = 8;
/** People the next tiers show in all, so the card stays short. */
export const LADDER_ROWS = 8;

/** Rung 1: people whose own words, or their company's industry, name the field or a neighbour of it. */
function related(
  world: SearchWorld,
  spec: QuerySpec,
  orgs: Map<string, Organization>,
  skip: Set<string>,
): LadderRow[] {
  const words = fieldWords(spec);
  if (!words.length) return [];
  // longer phrases first, so "clean energy" is said rather than "energy"
  const terms = relatedTerms(words).sort((a, b) => b.length - a.length);
  const out: (LadderRow & { score: number })[] = [];
  for (const d of world.docs) {
    if (skip.has(d.id)) continue;
    const p = world.people.get(d.id);
    if (!p) continue;
    let why: string | undefined;
    let score = 0;
    const industry = p.currentOrganizationId ? orgs.get(p.currentOrganizationId)?.industry : undefined;
    const ind = terms.find((t) => wordIn(industry, t));
    if (ind) {
      why = `Works at ${p.currentOrganizationRaw ?? 'a company'}, which is in ${industry}`;
      score = 3;
    }
    for (const [field, says] of FIELD_SAYS) {
      const t = terms.find((x) => wordIn(d.text[field], x));
      if (!t) continue;
      score += field === 'headline' || field === 'title' ? 2 : 1;
      why ??= `${says} ${t}`;
    }
    if (!why) continue;
    const rel = world.ctx.rel(d.id);
    out.push({
      personId: d.id,
      name: p.displayName,
      title: p.currentTitle,
      company: p.currentOrganizationRaw,
      tier: 'related',
      why,
      warmth: rel?.band ?? 'faint',
      score: score + (p.strength ?? 0),
    });
  }
  return out
    .sort((a, b) => b.score - a.score)
    .slice(0, RELATED_MAX)
    .map(({ score: _s, ...r }) => r);
}

/** Rung 2: the same ask with past jobs, for an ask about a company, a kind of company or an industry. */
function former(world: SearchWorld, set: SearchSet, skip: Set<string>): LadderRow[] {
  const spec = set.spec;
  const current = (spec.positions ?? []).filter(
    (p) =>
      !p.negate &&
      (p.when ?? 'current') === 'current' &&
      (p.company?.names?.length || p.company?.kinds?.length || p.company?.industries?.length),
  );
  if (!current.length) return [];
  const past = structuredClone(spec);
  for (const p of past.positions ?? []) if (!p.negate && (p.when ?? 'current') === 'current') p.when = 'past';
  delete past.relationship;
  const r = runSpec(past, world.docs, world.ctx, { judged: set.judged });
  return r.rows
    .filter((x) => (x.band === 'strong' || x.band === 'likely') && !skip.has(x.id))
    .slice(0, 5)
    .map((x) => {
      const v = rowView(x, world.people, world);
      return {
        personId: v.personId,
        name: v.name,
        title: v.title,
        company: v.company,
        tier: 'former' as const,
        why: v.evidence ? `Before: ${v.evidence}` : 'Used to work there',
        warmth: v.warmth,
      };
    });
}

/** Rung 3a: warm intro paths into a named company, through someone the student knows. */
async function intros(
  user: Pick<User, 'id'>,
  world: SearchWorld,
  spec: QuerySpec,
  skip: Set<string>,
  now: Date,
  signal?: AbortSignal,
): Promise<LadderRow[]> {
  const company = companyNames(spec)[0];
  if (!company) return [];
  const out: LadderRow[] = [];
  const add = (p: Person | undefined, why: string, via?: string) => {
    if (!p || skip.has(p.id) || out.some((r) => r.personId === p.id)) return;
    out.push({
      personId: p.id,
      name: p.displayName,
      title: p.currentTitle,
      company: p.currentOrganizationRaw,
      tier: 'intro',
      why,
      warmth: world.ctx.rel(p.id)?.band ?? 'faint',
      via,
    });
  };
  const paths = await warmIntrosFor(user, { company }, { signal, limit: 4 }).catch(() => []);
  for (const w of paths) {
    const p = w.introducer.personId ? world.people.get(w.introducer.personId) : undefined;
    add(p, `A ${w.warmthWord.toLowerCase()} path into ${company}: ${w.hops.join(' > ')}`, company);
  }
  if (out.length < 4) {
    const reach = await reachCompany(user.id, company, now).catch(() => undefined);
    for (const t of reach?.twoHop ?? []) {
      const first = t.path.hops[0]?.toId;
      add(
        first ? world.people.get(first) : undefined,
        `Knows ${t.target.displayName}, who is at ${company}`,
        t.target.displayName,
      );
    }
  }
  return out.slice(0, 4);
}

/** The kinds of work that meet people across fields, and why each is a good person to ask. */
const BROAD: [RegExp, string][] = [
  [/\b(consult|engagement manager|case team)/i, 'consultants work with clients across industries'],
  [/\b(invest|venture|vc\b|principal|partner at)/i, 'investors meet founders across fields'],
  [/\b(banker|banking|m&a|analyst, (?:ib|m&a))/i, 'bankers cover companies across sectors'],
  [/\b(recruit|talent|university relations)/i, 'recruiters know people across teams and companies'],
  [/\b(professor|lecturer|faculty|researcher)/i, 'academics know people across labs and programs'],
  [/\b(founder|ceo|chief of staff)/i, 'founders and operators meet people across the ecosystem'],
  [/\b(business development|partnerships|community)/i, 'their job is meeting people'],
];

const BAND_WORD: Record<string, string> = {
  close: 'You are close',
  strong: 'You know them well',
  warm: 'You know them',
  light: 'You know them a little',
  faint: 'You know them slightly',
};

const CONNECTORS = 3;

/** Rung 3b: the people the student knows best who are likeliest to know someone, said as a guess. */
async function connectors(
  userId: string,
  world: SearchWorld,
  skip: Set<string>,
  max = CONNECTORS,
): Promise<LadderRow[]> {
  const edges = await db.edges
    .where('userId')
    .equals(userId)
    .toArray()
    .catch(() => []);
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.personAId, (degree.get(e.personAId) ?? 0) + 1);
    degree.set(e.personBId, (degree.get(e.personBId) ?? 0) + 1);
  }
  const scored: (LadderRow & { score: number })[] = [];
  for (const p of world.people.values()) {
    if (skip.has(p.id)) continue;
    const band = world.ctx.rel(p.id)?.band ?? 'faint';
    const tie = p.strength || (p.tieScore ?? 0) / 100;
    const words = `${p.currentTitle ?? ''} ${p.headline ?? ''}`;
    const broad = BROAD.find(([re]) => re.test(words));
    const deg = degree.get(p.id) ?? 0;
    const score =
      tie * (1 + (broad ? 0.6 : 0) + (p.isAlumni ? 0.25 : 0) + Math.min(deg, 12) / 24) +
      (band === 'faint' ? -1 : 0);
    const reasons = [BAND_WORD[band] ?? 'You know them'];
    if (broad) reasons.push(broad[1]);
    else if (deg >= 6) reasons.push(`they connect to ${deg} people in your network`);
    else if (p.isAlumni) reasons.push('they went to your school');
    scored.push({
      personId: p.id,
      name: p.displayName,
      title: p.currentTitle,
      company: p.currentOrganizationRaw,
      tier: 'connector',
      why: reasons.join('; '),
      warmth: band,
      score,
    });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(({ score: _s, ...r }) => r);
}

/**
 * The free rungs for a kept set whose answer had nobody who fits. Empty only when the student has nobody in Orbit at
 * all, or the ask was only about the tie ("people I have not talked to in a year").
 */
export async function climbLadder(
  user: Pick<User, 'id'>,
  set: SearchSet,
  opts: { now?: Date; signal?: AbortSignal } = {},
): Promise<Ladder> {
  const topic = topicOf(set.spec);
  const world = worldOfSet(set.id);
  if (!world || !hasSubject(set.spec)) return { topic, rungs: [], nearFit: false };
  const orgs = new Map((await db.organizations.toArray().catch(() => [])).map((o) => [o.id, o]));
  const shown = new Set<string>();
  const rungs: LadderRung[] = [];
  const push = (tier: LadderTier, rows: LadderRow[]) => {
    if (!rows.length) return;
    for (const r of rows) shown.add(r.personId);
    rungs.push({ tier, label: RUNG_LABELS[tier], rows });
  };
  push('related', related(world, set.spec, orgs, shown));
  push('former', former(world, set, shown));
  push('intro', await intros(user, world, set.spec, shown, opts.now ?? new Date(), opts.signal));
  const nearFit = rungs.some((r) => r.tier === 'related' || r.tier === 'former');
  const listed = rungs.reduce((n, r) => n + r.rows.length, 0);
  // someone to ask is always worth a line; fewer when the rungs above already show people
  if (listed < 6) push('connector', await connectors(user.id, world, shown, listed ? 2 : CONNECTORS));
  // a card the student reads at a glance: the best tiers first, LADDER_ROWS people in all
  let room = LADDER_ROWS;
  const kept = rungs
    .map((r) => {
      const rows = r.rows.slice(0, Math.max(0, room));
      room -= rows.length;
      return { ...r, rows };
    })
    .filter((r) => r.rows.length);
  return { topic, rungs: kept, nearFit };
}
