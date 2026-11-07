/**
 * Checks, three answers each (plan 32 §6.2, §18.2): every block of a spec asked of one person's document gives yes,
 * likely, unknown or no, with the text it rests on. "Unknown" is never "no": a person whose headline names no school
 * is not "not at Berkeley", only unchecked, and the card says so.
 */
import type { RelationshipType } from '../types';
import {
  type CompanyFact,
  type FactsIndex,
  industryTerms,
  keysFor,
  kindOfOrg,
  matchFacts,
  parentOf,
  stageOf,
} from './companies';
import { type DocRole, docText, EVIDENCE_RANK, type EvidenceSource, type PersonDoc } from './doc';
import { canonicalBatch } from './headline';
import type { PlaceIndex, PlaceTarget } from './places';
import type { SchoolIndex } from './schools';
import type {
  Channel,
  CompanySpec,
  Need,
  PositionSpec,
  QuerySpec,
  RelationshipSpec,
  RoleSpec,
  SchoolSpec,
} from './spec';
import { WARMTH_RANK } from './spec';
import {
  readQueryTitle,
  SENIORITY_RANK,
  type SearchSeniority,
  type TitleFamily,
  titleHasWords,
} from './titles';

export type Answer = 'yes' | 'likely' | 'unknown' | 'no';

export const ANSWER_RANK: Record<Answer, number> = { no: 0, unknown: 1, likely: 2, yes: 3 };

export interface Check {
  /** which block: 'position:0', 'school:1', 'place:0', 'keywords', 'rel:warmth', 'criterion:2' */
  key: string;
  label: string;
  need: Need;
  answer: Answer;
  evidence?: string;
  source?: EvidenceSource;
  /** for an unknown: is there any clue in the person's text worth judging or checking on LinkedIn */
  signal?: 'hint' | 'none';
  /** a value estimated, not stated (stage from team size) */
  estimated?: boolean;
  /** unknown, but the main thing matched and only a detail is missing ("Berkeley", class year not on file) */
  partial?: boolean;
  /** what is missing for a partial ("class year", "company") */
  missing?: string;
  /** the company facts behind a yes, for the card ("Knowlify, YC S25") */
  fact?: Pick<CompanyFact, 'name' | 'ycBatch' | 'oneLiner' | 'teamSize'>;
}

/** What Orbit knows about the student's tie to one person, joined at query time. */
export interface RelInfo {
  band: 'faint' | 'light' | 'warm' | 'strong' | 'close';
  type?: RelationshipType;
  lastConversationAt?: string;
  touches: Partial<Record<Channel, { lastIn?: string; lastOut?: string; inCount: number; outCount: number }>>;
  connectedOn?: string;
  hasChat?: boolean;
  /** names of the student's friends who also know this person */
  mutualFriends?: string[];
  tags: string[];
}

export interface SearchContext {
  facts: FactsIndex;
  places?: PlaceIndex;
  schools?: SchoolIndex;
  rel(personId: string): RelInfo | undefined;
  /** which channels Orbit can see, and since when (ISO), so silence means something */
  channels: Record<Channel, { connected: boolean; since?: string }>;
  /** the student's own schools, canonical */
  mySchools: string[];
  now: number;
  /** router mode: no model, criteria cannot be checked */
  noJudge?: boolean;
}

interface CompiledPosition {
  spec: PositionSpec;
  index: number;
  keys?: Set<string>;
  families?: Set<TitleFamily>;
  titleWords: string[];
  seniorities?: Set<SearchSeniority>;
  batches?: Set<string>;
  industry?: string[];
  hintWords: string[];
  roleHints: string[];
  companyHints: string[];
  label: string;
}

interface CompiledSchool {
  spec: SchoolSpec;
  index: number;
  names: Set<string>;
  hintWords: string[];
  label: string;
}

export interface CompiledSpec {
  spec: QuerySpec;
  positions: CompiledPosition[];
  schools: CompiledSchool[];
  places: {
    spec: QuerySpec['places'] extends (infer T)[] | undefined ? T : never;
    index: number;
    targets: PlaceTarget[];
    unresolved: string[];
  }[];
  keywords?: { terms: string[]; need: Need; negate: boolean };
  /** words the spec could not resolve, said on the card */
  unresolved: string[];
}

const FIELD_SYNONYMS: Record<string, string[]> = {
  cs: ['cs', 'computer science', 'eecs', 'cse', 'computing', 'software engineering', 'mscs', 'cs+'],
  'computer science': ['cs', 'computer science', 'eecs', 'cse', 'computing'],
  eecs: ['eecs', 'electrical engineering and computer science', 'ece', 'cs', 'electrical engineering'],
  ee: ['ee', 'electrical engineering', 'ece', 'eecs'],
  econ: ['econ', 'economics'],
  economics: ['econ', 'economics'],
  math: ['math', 'mathematics', 'applied math', 'statistics', 'stats'],
  'data science': ['data science', 'ds', 'statistics'],
  business: ['business', 'haas', 'bba', 'business administration', 'commerce', 'mba', 'm e t', 'met'],
  mechanical: ['mechanical engineering', 'meche', 'me'],
  bio: ['bio', 'biology', 'mcb', 'molecular', 'bioengineering', 'neuroscience'],
  physics: ['physics'],
  'cognitive science': ['cognitive science', 'cogsci', 'cog sci'],
};

const DEGREE_RE: Record<string, RegExp> = {
  undergrad: /\b(b\.?s\.?c?|b\.?a\.?|bachelor\w*|undergrad\w*|bba|b\.?tech|b\.?e\.?)\b/i,
  masters: /\b(m\.?s\.?c?|m\.?a\.?|master\w*|m\.?eng|mscs|m\.?tech|mfin|mps)\b/i,
  mba: /\bmba\b/i,
  phd: /\b(ph\.?d|doctor(al|ate)|dphil)\b/i,
  high_school: /\b(high school|secondary school)\b/i,
};

export function compileSpec(spec: QuerySpec, ctx: SearchContext): CompiledSpec {
  const unresolved: string[] = [];
  const positions = (spec.positions ?? []).map((p, index): CompiledPosition => {
    const keys = p.company?.names?.length
      ? new Set(p.company.names.flatMap((n) => keysFor(n, p.company?.withSubsidiaries !== false)))
      : undefined;
    const families = new Set<TitleFamily>(p.role?.families ?? []);
    const titleWords: string[] = [];
    const seniorities = new Set<SearchSeniority>(p.role?.seniority ?? []);
    for (const t of p.role?.titles ?? []) {
      const q = readQueryTitle(t);
      for (const f of q.families) families.add(f);
      if (q.seniority && !p.role?.seniorityAtLeast) seniorities.add(q.seniority);
      if (q.words) titleWords.push(q.words);
    }
    const batches = p.company?.yc?.batches?.length
      ? new Set(p.company.yc.batches.map((b) => canonicalBatch(b) ?? b.toUpperCase()))
      : undefined;
    const companyHints = [
      ...(p.company?.names ?? []),
      ...(p.company?.yc ? ['yc', 'y combinator'] : []),
      ...(p.company?.industries ? industryTerms(p.company.industries) : []),
      ...(p.company?.kinds ?? []).flatMap((k) => KIND_HINTS[k] ?? []),
    ].map((w) => w.toLowerCase());
    const roleHints = [
      ...(p.role?.titles ?? []),
      ...(p.role?.founder || families.has('founder') ? ['founder', 'co-founder', 'cofounder', 'ceo'] : []),
      ...[...families].flatMap((f) => FAMILY_HINTS[f] ?? []),
    ].map((w) => w.toLowerCase());
    // a clue must touch the part of the ask that is hardest to know: the company when one is asked
    const hintWords = companyHints.length ? companyHints : roleHints;
    return {
      spec: p,
      index,
      keys,
      families: families.size ? families : undefined,
      titleWords,
      seniorities: seniorities.size ? seniorities : undefined,
      batches,
      industry: p.company?.industries?.length ? industryTerms(p.company.industries) : undefined,
      hintWords,
      roleHints,
      companyHints,
      label: positionLabel(p),
    };
  });
  const schools = (spec.schools ?? []).map((s, index): CompiledSchool => {
    const names = new Set<string>();
    for (const n of s.names) {
      const c = ctx.schools?.lookup(n);
      if (c) names.add(c);
      else {
        names.add(n);
        unresolved.push(n);
      }
    }
    const hintWords = [...s.names, ...[...names].flatMap((n) => ctx.schools?.namesOf(n) ?? [])].map((w) =>
      w.toLowerCase(),
    );
    return { spec: s, index, names, hintWords, label: s.names.join(' or ') };
  });
  const places = (spec.places ?? []).map((p, index) => {
    const targets: PlaceTarget[] = [];
    const un: string[] = [];
    for (const n of p.names) {
      const t = ctx.places?.target(n);
      if (t) targets.push(t);
      else un.push(n);
    }
    unresolved.push(...un);
    return { spec: p, index, targets, unresolved: un };
  });
  const keywords = spec.keywords?.terms.length
    ? {
        terms: spec.keywords.terms.map((t) => t.toLowerCase()),
        need: spec.keywords.need ?? 'must',
        negate: !!spec.keywords.negate,
      }
    : undefined;
  return { spec, positions, schools, places, keywords, unresolved };
}

const FAMILY_HINTS: Partial<Record<TitleFamily, string[]>> = {
  investing: ['investor', 'vc', 'venture', 'angel', 'partner', 'capital'],
  engineering: ['engineer', 'swe', 'developer', 'software'],
  product: ['product', 'pm'],
  design: ['design'],
  data_ml: ['ml', 'ai', 'data'],
  research: ['research'],
  banking: ['banking', 'ib'],
  consulting: ['consult'],
  student: ['student'],
};

const KIND_HINTS: Partial<Record<string, string[]>> = {
  hedge_fund: ['hedge fund', 'capital management', 'trading', 'quant'],
  vc_firm: ['ventures', 'vc', 'venture'],
  bank: ['bank', 'banking'],
  consulting: ['consulting', 'consultant'],
  big_tech: ['google', 'meta', 'apple', 'amazon', 'microsoft'],
  startup: ['startup', 'founding', 'seed', 'yc'],
};

function positionLabel(p: PositionSpec): string {
  const role = [
    p.role?.founder ? 'founder' : '',
    ...(p.role?.titles ?? []),
    ...(p.role?.families ?? []).map((f) => f.replace(/_/g, ' ')),
  ]
    .filter(Boolean)
    .join(' or ');
  const co = [
    ...(p.company?.names ?? []),
    p.company?.yc
      ? p.company.yc.batches?.length
        ? `YC ${p.company.yc.batches.join('/')}`
        : 'a YC company'
      : '',
    ...(p.company?.kinds ?? []).map((k) => k.replace(/_/g, ' ')),
    ...(p.company?.industries ?? []),
  ]
    .filter(Boolean)
    .join(' or ');
  const when = p.when === 'past' ? 'formerly ' : p.when === 'ever' ? 'ever ' : '';
  return `${p.negate ? 'not ' : ''}${when}${role || 'works'}${co ? ` at ${co}` : ''}`;
}

const andAll = (answers: Answer[]): Answer =>
  answers.includes('no')
    ? 'no'
    : answers.includes('unknown')
      ? 'unknown'
      : answers.includes('likely')
        ? 'likely'
        : 'yes';

const negateAnswer = (a: Answer): Answer =>
  a === 'yes' ? 'no' : a === 'no' ? 'yes' : a === 'likely' ? 'unknown' : 'likely';

function hasWord(text: string, w: string): boolean {
  if (!w) return false;
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(text);
}

interface RoleResult {
  answer: Answer;
  roleAnswer?: Answer;
  companyAnswer?: Answer;
  evidence: string;
  source: EvidenceSource;
  estimated?: boolean;
  fact?: CompanyFact;
}

/** the titles a startup's founders usually hold */
const FOUNDERISH_TITLE = /\b(?:ceo|cto|chief executive officer|chief technology officer)\b/i;

function checkRole(
  role: DocRole,
  spec: RoleSpec | undefined,
  c: CompiledPosition,
  kindHint: ReturnType<typeof kindOfOrg>,
  startup = false,
): Answer {
  if (!spec) return 'yes';
  const parts: Answer[] = [];
  const hasTitle = !!role.title;
  if (c.families) {
    if (role.families.some((f) => c.families!.has(f))) parts.push('yes');
    else if (role.maybe.some((f) => c.families!.has(f))) {
      // "PM" at a hedge fund is a portfolio manager; elsewhere a product manager
      const fin = kindHint === 'hedge_fund' || kindHint === 'pe' || kindHint === 'bank';
      parts.push(c.families.has('finance') && fin ? 'yes' : 'likely');
    } else if (c.titleWords.some((w) => role.title && titleHasWords(role.title, w))) parts.push('yes');
    else parts.push(hasTitle || role.founder ? 'no' : 'unknown');
  } else if (c.titleWords.length) {
    parts.push(
      c.titleWords.some((w) => role.title && titleHasWords(role.title, w))
        ? 'yes'
        : hasTitle
          ? 'no'
          : 'unknown',
    );
  }
  if (c.seniorities || spec.seniorityAtLeast) {
    if (!role.seniority) parts.push(hasTitle ? 'no' : 'unknown');
    else if (c.seniorities?.has(role.seniority)) parts.push('yes');
    else if (spec.seniorityAtLeast)
      parts.push(SENIORITY_RANK[role.seniority] >= SENIORITY_RANK[spec.seniorityAtLeast] ? 'yes' : 'no');
    else parts.push('no');
  }
  if (spec.founder) {
    if (role.founder && !role.club && kindHint !== 'student_org' && kindHint !== 'university')
      parts.push(role.weak ? 'likely' : 'yes');
    else if (startup && !role.club && FOUNDERISH_TITLE.test(role.title ?? '')) parts.push('likely');
    else parts.push(hasTitle || role.earlyEmployee || role.club ? 'no' : 'unknown');
  }
  return andAll(parts);
}

function checkCompany(
  role: DocRole,
  spec: CompanySpec | undefined,
  c: CompiledPosition,
  ctx: SearchContext,
  text: string,
): RoleResult {
  const base: RoleResult = { answer: 'yes', evidence: role.evidence, source: role.source };
  if (!spec) return base;
  const parts: Answer[] = [];
  let estimated = false;
  const fm = role.org
    ? matchFacts(role.org, ctx.facts, { badgeBatch: role.ycBatch, saysYc: role.saysYc })
    : undefined;
  const fact = fm?.fact;
  // a weak name match ("Astro") says nothing about the company's stage, size or industry
  const sureFact = fm && fm.confidence !== 'weak' ? fm.fact : undefined;
  if (c.keys) {
    if (!role.orgKey) parts.push('unknown');
    else if (c.keys.has(role.orgKey)) parts.push('yes');
    else {
      const parent = parentOf(role.orgKey, ctx.facts.byKey);
      parts.push(parent && c.keys.has(parent) && spec.withSubsidiaries !== false ? 'yes' : 'no');
    }
  }
  if (spec.kinds?.length) {
    const kind = role.club ? 'student_org' : kindOfOrg(role.org, fact);
    parts.push(!role.orgKey ? 'unknown' : kind ? (spec.kinds.includes(kind) ? 'yes' : 'no') : 'unknown');
  }
  if (spec.yc) {
    const batch = fact?.ycBatch ?? (role.saysYc ? role.ycBatch : undefined);
    if (!role.orgKey && !role.saysYc) parts.push('unknown');
    else if (fact?.ycBatch || role.saysYc) {
      const inBatch = !c.batches || (batch ? c.batches.has(batch) : false);
      const sure = fm?.confidence === 'strong' || (!fact && role.saysYc && !!role.ycBatch);
      if (c.batches && batch && !c.batches.has(batch)) parts.push('no');
      else if (c.batches && !batch) parts.push('unknown');
      else parts.push(inBatch ? (sure ? 'yes' : 'likely') : 'no');
    } else parts.push('no');
  }
  if (spec.stages?.length) {
    const st = stageOf(sureFact);
    if (!st) parts.push('unknown');
    else {
      estimated = st.estimated;
      parts.push(
        spec.stages.includes(st.stage) ? (st.estimated ? 'likely' : 'yes') : st.estimated ? 'unknown' : 'no',
      );
    }
  }
  if (spec.sizeMin !== undefined || spec.sizeMax !== undefined) {
    const n = sureFact?.teamSize;
    if (n === undefined) parts.push('unknown');
    else
      parts.push(
        (spec.sizeMin === undefined || n >= spec.sizeMin) && (spec.sizeMax === undefined || n <= spec.sizeMax)
          ? 'yes'
          : 'no',
      );
  }
  if (c.industry) {
    const factText = `${(sureFact?.industries ?? []).join(' ')} ${sureFact?.oneLiner ?? ''}`.toLowerCase();
    const hit =
      c.industry.some((t) => hasWord(factText, t)) ||
      c.industry.some((t) => hasWord(`${role.title ?? ''} ${role.org ?? ''}`, t));
    if (hit) parts.push('yes');
    else if (sureFact?.industries?.length) parts.push('no');
    else parts.push(c.industry.some((t) => hasWord(text, t)) ? 'likely' : 'unknown');
  }
  const ev =
    fact?.ycBatch && spec.yc
      ? `${role.evidence}${/\byc\b/i.test(role.evidence) ? '' : ` (YC ${fact.ycBatch})`}`
      : role.evidence;
  return {
    answer: andAll(parts),
    evidence: ev,
    source: role.source,
    estimated,
    fact: sureFact ?? (fm?.confidence === 'weak' ? undefined : fact),
  };
}

function withinYears(date: string | undefined, years: number | undefined, now: number): Answer {
  if (years === undefined) return 'yes';
  if (!date) return 'unknown';
  const t = Date.parse(date);
  if (Number.isNaN(t)) return 'unknown';
  return now - t <= years * 365.25 * 86400_000 ? 'yes' : 'no';
}

export function checkPosition(doc: PersonDoc, c: CompiledPosition, ctx: SearchContext, text: string): Check {
  const p = c.spec;
  const when = p.when ?? 'current';
  let best: (RoleResult & { rank: number }) | undefined;
  for (const role of doc.roles) {
    if (role.future) continue;
    if (when === 'current' && !role.current) continue;
    if (when === 'past' && role.current) continue;
    const fact = role.org
      ? matchFacts(role.org, ctx.facts, { badgeBatch: role.ycBatch, saysYc: role.saysYc })?.fact
      : undefined;
    const kind = role.club ? 'student_org' : kindOfOrg(role.org, fact);
    // a CEO or CTO of a YC company (or a small startup Orbit has facts for) is most often one of its founders
    const startup = role.saysYc || !!fact?.ycBatch || (fact?.teamSize !== undefined && fact.teamSize <= 50);
    const r = checkRole(role, p.role, c, kind, startup);
    const co = checkCompany(role, p.company, c, ctx, text);
    const time = andAll([
      withinYears(role.start, p.startedWithinYears, ctx.now),
      withinYears(role.end, p.endedWithinYears, ctx.now),
    ]);
    const answer = andAll([r, co.answer, time]);
    const rank =
      ANSWER_RANK[answer] * 10 +
      EVIDENCE_RANK[role.source] +
      (r === 'yes' || co.answer === 'yes' ? 1 : 0) * 0.5;
    if (!best || rank > best.rank) best = { ...co, answer, rank, roleAnswer: r, companyAnswer: co.answer };
  }
  let answer: Answer = best?.answer ?? 'unknown';
  if (answer === 'no') {
    // a no is only as good as what Orbit knows of their jobs: no current job on file means unknown, not no
    const knowsWhen =
      when === 'current'
        ? doc.known.current
        : when === 'past'
          ? doc.known.pastJobs || doc.roles.some((r) => !r.current)
          : doc.known.current;
    if (!knowsWhen) answer = 'unknown';
    // a company LinkedIn says they are not at
    const neg = doc.facets.find(
      (f) =>
        !f.positive &&
        (f.kind === 'company' || f.kind === 'past_company') &&
        c.keys?.has(f.value.toLowerCase()),
    );
    if (neg) answer = 'no';
  }
  if (answer === 'unknown' && !doc.roles.some((r) => (when === 'past' ? !r.current : r.current))) {
    const neg = doc.facets.some(
      (f) =>
        !f.positive &&
        f.kind === (when === 'past' ? 'past_company' : 'company') &&
        c.keys?.has(f.value.toLowerCase()),
    );
    if (neg) answer = 'no';
  }
  // partial: one side matched (a founder, company unknown; at Stripe, role unknown)
  let partial = false;
  let missing: string | undefined;
  let hints = c.hintWords;
  if (
    answer === 'unknown' &&
    best &&
    (best.roleAnswer === 'yes' || best.roleAnswer === 'likely') &&
    best.companyAnswer === 'unknown'
  ) {
    partial = !!p.role;
    missing = 'company';
    hints = c.companyHints;
  } else if (
    answer === 'unknown' &&
    best &&
    (best.companyAnswer === 'yes' || best.companyAnswer === 'likely') &&
    best.roleAnswer === 'unknown'
  ) {
    partial = !!p.company;
    missing = 'role';
    hints = c.roleHints.length ? c.roleHints : c.hintWords;
  }
  const signal =
    answer === 'unknown'
      ? partial && missing === 'role'
        ? 'hint'
        : hints.some((w) => hasWord(text, w))
          ? 'hint'
          : 'none'
      : undefined;
  const final = p.negate ? negateAnswer(answer) : answer;
  return {
    key: `position:${c.index}`,
    label: c.label,
    need: p.need ?? 'must',
    answer: final,
    evidence: best && (answer !== 'unknown' || partial) ? best.evidence : undefined,
    source: best && (answer !== 'unknown' || partial) ? best.source : undefined,
    signal,
    partial: partial || undefined,
    missing,
    estimated: best?.estimated,
    fact: best?.fact
      ? {
          name: best.fact.name,
          ycBatch: best.fact.ycBatch,
          oneLiner: best.fact.oneLiner,
          teamSize: best.fact.teamSize,
        }
      : undefined,
  };
}

function fieldMatches(field: string | undefined, wanted: string[]): Answer {
  if (!field) return 'unknown';
  const f = field.toLowerCase();
  for (const w of wanted) {
    const syn = FIELD_SYNONYMS[w.toLowerCase()] ?? [w.toLowerCase()];
    if (syn.some((s) => hasWord(f, s))) return 'yes';
  }
  return 'no';
}

export function checkSchool(doc: PersonDoc, c: CompiledSchool, text: string): Check {
  const s = c.spec;
  let best: { answer: Answer; evidence: string; source: EvidenceSource; missing?: string } | undefined;
  for (const ds of doc.schools) {
    if (!c.names.has(ds.name)) continue;
    const parts: Answer[] = ['yes'];
    const miss: string[] = [];
    if (s.fields?.length) {
      const f = fieldMatches(ds.field, s.fields);
      if (f === 'unknown') miss.push('major');
      parts.push(f);
    }
    if (s.degree?.length) {
      const deg = `${ds.degree ?? ''} ${ds.field ?? ''}`;
      const hits = s.degree.filter((d) => DEGREE_RE[d]?.test(deg));
      parts.push(
        hits.length
          ? 'yes'
          : deg.trim()
            ? s.degree.includes('undergrad') && !/(m\.?s|mba|phd|master)/i.test(deg)
              ? 'likely'
              : 'no'
            : 'unknown',
      );
    }
    if (s.gradFrom !== undefined || s.gradTo !== undefined) {
      if (!ds.gradYear) {
        parts.push('unknown');
        miss.push('class year');
      } else
        parts.push(
          (s.gradFrom === undefined || ds.gradYear >= s.gradFrom) &&
            (s.gradTo === undefined || ds.gradYear <= s.gradTo)
            ? 'yes'
            : 'no',
        );
    }
    const answer = andAll(parts);
    if (!best || ANSWER_RANK[answer] > ANSWER_RANK[best.answer])
      best = {
        answer,
        evidence: ds.evidence,
        source: ds.source,
        missing: miss.length ? miss.join(' and ') : undefined,
      };
  }
  let answer: Answer = best?.answer ?? 'unknown';
  if (!best) {
    // a school list from a full profile or LinkedIn's own school search that lacks this school is a no; a headline
    // naming another school is not (people name one school of several)
    const full = doc.schools.some(
      (x) => x.source === 'affiliation' || x.source === 'profile' || x.source === 'manual',
    );
    const neg = doc.facets.some((f) => f.kind === 'school' && !f.positive && c.names.has(f.value));
    if (full || neg) answer = 'no';
  }
  const signal =
    answer === 'unknown' ? (c.hintWords.some((w) => hasWord(text, w)) ? 'hint' : 'none') : undefined;
  return {
    key: `school:${c.index}`,
    label: `${s.negate ? 'not ' : ''}${c.label}${s.gradFrom ? ` class of ${s.gradFrom}${s.gradTo && s.gradTo !== s.gradFrom ? `-${s.gradTo}` : ''}` : ''}${s.fields?.length ? `, ${s.fields.join('/')}` : ''}`,
    need: s.need ?? 'must',
    answer: s.negate ? negateAnswer(answer) : answer,
    evidence: best?.evidence,
    source: best?.source,
    signal: best && answer === 'unknown' ? 'hint' : signal,
    partial: (best && answer === 'unknown') || undefined,
    missing: best?.missing,
  };
}

export function checkPlace(
  doc: PersonDoc,
  p: CompiledSpec['places'][number],
  ctx: SearchContext,
  text: string,
): Check {
  let answer: Answer = 'unknown';
  if (ctx.places && p.targets.length) {
    const answers = p.targets.map((t) => ctx.places!.matches(doc.place, t));
    answer = answers.includes('yes') ? 'yes' : answers.every((a) => a === 'no') ? 'no' : 'unknown';
    if (
      answer === 'unknown' &&
      doc.facets.some((f) => f.kind === 'place' && !f.positive && p.targets.some((t) => t.label === f.value))
    )
      answer = 'no';
  }
  const names = p.spec.names.map((n) => n.toLowerCase());
  return {
    key: `place:${p.index}`,
    label: `${p.spec.negate ? 'not in ' : 'in '}${p.targets.map((t) => t.label).join(' or ') || p.spec.names.join(' or ')}`,
    need: p.spec.need ?? 'must',
    answer: p.spec.negate ? negateAnswer(answer) : answer,
    evidence: answer !== 'unknown' ? doc.place?.evidence : undefined,
    source: answer !== 'unknown' ? doc.place?.source : undefined,
    signal: answer === 'unknown' ? (names.some((n) => hasWord(text, n)) ? 'hint' : 'none') : undefined,
  };
}

export function checkKeywords(doc: PersonDoc, k: NonNullable<CompiledSpec['keywords']>, text: string): Check {
  const hit = k.terms.find((t) => hasWord(text, t));
  let answer: Answer = hit ? 'yes' : doc.headline ? 'no' : 'unknown';
  if (k.negate) answer = negateAnswer(answer);
  return {
    key: 'keywords',
    label: `${k.negate ? 'not about ' : 'mentions '}${k.terms.slice(0, 4).join(', ')}`,
    need: k.need,
    answer,
    evidence: hit ? snippet(text, hit) : undefined,
    source: hit ? 'headline' : undefined,
    signal: answer === 'unknown' ? 'none' : undefined,
  };
}

function snippet(text: string, word: string): string {
  const i = text.indexOf(word.toLowerCase());
  if (i < 0) return word;
  return text.slice(Math.max(0, i - 40), i + word.length + 40).trim();
}

const days = (n: number) => n * 86400_000;

export function checkRelationship(personId: string, r: RelationshipSpec, ctx: SearchContext): Check[] {
  const info = ctx.rel(personId);
  const out: Check[] = [];
  const add = (key: string, label: string, answer: Answer, evidence?: string) =>
    out.push({
      key: `rel:${key}`,
      label,
      need: 'must',
      answer,
      evidence,
      signal: answer === 'unknown' ? 'none' : undefined,
    });
  const anyChannel = Object.values(ctx.channels).some((c) => c.connected);
  if (r.warmthAtLeast) {
    const band = info?.band ?? 'faint';
    add(
      'warmth',
      `at least ${r.warmthAtLeast}`,
      WARMTH_RANK[band] >= WARMTH_RANK[r.warmthAtLeast] ? 'yes' : 'no',
      band,
    );
  }
  if (r.types?.length)
    add(
      'type',
      r.types.join(' or '),
      info?.type && info.type !== 'unknown' ? (r.types.includes(info.type) ? 'yes' : 'no') : 'unknown',
      info?.type,
    );
  const last = info?.lastConversationAt ? Date.parse(info.lastConversationAt) : undefined;
  const talked = last !== undefined;
  if (r.everTalked !== undefined) {
    const a: Answer = talked ? 'yes' : anyChannel ? 'no' : 'unknown';
    add('ever', r.everTalked ? 'talked before' : 'never talked', r.everTalked ? a : negateAnswer(a));
  }
  if (r.talkedWithinDays !== undefined)
    add(
      'recent',
      `talked in the last ${r.talkedWithinDays} days`,
      talked ? (ctx.now - last! <= days(r.talkedWithinDays) ? 'yes' : 'no') : anyChannel ? 'no' : 'unknown',
      info?.lastConversationAt,
    );
  if (r.quietForDays !== undefined)
    add(
      'quiet',
      `quiet for ${r.quietForDays}+ days`,
      // never talked is quiet too, though less surely what was meant ("people I have lost touch with")
      talked ? (ctx.now - last! >= days(r.quietForDays) ? 'yes' : 'no') : anyChannel ? 'likely' : 'unknown',
      info?.lastConversationAt,
    );
  for (const [i, t] of (r.touched ?? []).entries()) {
    const ch = ctx.channels[t.channel];
    const tc = info?.touches[t.channel];
    const dir = t.direction ?? 'any';
    const dates = [dir !== 'out' ? tc?.lastIn : undefined, dir !== 'in' ? tc?.lastOut : undefined].filter(
      Boolean,
    ) as string[];
    const latest = dates.length ? Math.max(...dates.map((d) => Date.parse(d))) : undefined;
    let a: Answer;
    if (!ch?.connected) a = 'unknown';
    else if (latest === undefined) a = 'no';
    else
      a =
        (t.withinDays === undefined || ctx.now - latest <= days(t.withinDays)) &&
        (t.beforeDays === undefined || ctx.now - latest >= days(t.beforeDays))
          ? 'yes'
          : 'no';
    const label = `${t.negate ? 'no ' : ''}${t.channel}${dir === 'in' ? ' from them' : dir === 'out' ? ' from you' : ''}${t.withinDays ? ` in ${t.withinDays} days` : ''}`;
    add(`touch${i}`, label, t.negate ? negateAnswer(a) : a);
  }
  if (r.connectedWithinDays !== undefined) {
    const on = info?.connectedOn ? Date.parse(info.connectedOn) : undefined;
    add(
      'connected',
      `connected in the last ${r.connectedWithinDays} days`,
      on === undefined ? 'unknown' : ctx.now - on <= days(r.connectedWithinDays) ? 'yes' : 'no',
      info?.connectedOn,
    );
  }
  if (r.hasChat !== undefined)
    add(
      'chat',
      r.hasChat ? 'has a coffee chat' : 'no coffee chat',
      !!info?.hasChat === r.hasChat ? 'yes' : 'no',
    );
  if (r.tags?.length) {
    const tags = (info?.tags ?? []).map((t) => t.toLowerCase());
    add(
      'tags',
      `tagged ${r.tags.join(' or ')}`,
      r.tags.some((t) => tags.includes(t.toLowerCase())) ? 'yes' : 'no',
    );
  }
  if (r.mutualWith) {
    const m = (info?.mutualFriends ?? []).some((n) => n.toLowerCase().includes(r.mutualWith!.toLowerCase()));
    add('mutual', `also knows ${r.mutualWith}`, m ? 'yes' : 'no');
  }
  return out;
}

/** The alum-of-my-school check needs the doc's schools: kept apart from the relationship block's other checks. */
export function checkAlum(doc: PersonDoc, ctx: SearchContext): Check {
  const mine = new Set(ctx.mySchools);
  const hit = doc.schools.find((s) => mine.has(s.name));
  const full = doc.schools.some(
    (x) => x.source === 'affiliation' || x.source === 'profile' || x.source === 'manual',
  );
  return {
    key: 'rel:alum',
    label: 'went to your school',
    need: 'must',
    answer: hit ? 'yes' : full ? 'no' : 'unknown',
    evidence: hit?.evidence,
    source: hit?.source,
    signal:
      hit || full
        ? undefined
        : ctx.mySchools.some((s) => hasWord(docText(doc), s.toLowerCase()))
          ? 'hint'
          : 'none',
  };
}
