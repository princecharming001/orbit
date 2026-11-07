/**
 * Spec lint (plan 32 §18.13): normalize what the chat model compiled before it runs, and say what changed. The model
 * over-specifies (titles, families and a criterion all saying "founder"); lint keeps one of each and maps synonyms
 * instead of failing validation.
 */
import type { PositionSpec, QuerySpec } from './spec';
import {
  readQueryTitle,
  SENIORITIES,
  type SearchSeniority,
  TITLE_FAMILIES,
  type TitleFamily,
} from './titles';

const FAMILY_SYNONYMS: Record<string, TitleFamily | 'founder_flag'> = {
  founders: 'founder_flag',
  founder: 'founder_flag',
  vc: 'investing',
  vcs: 'investing',
  investor: 'investing',
  investors: 'investing',
  angel: 'investing',
  swe: 'engineering',
  engineer: 'engineering',
  engineers: 'engineering',
  developer: 'engineering',
  pm: 'product',
  pms: 'product',
  ml: 'data_ml',
  ai: 'data_ml',
  data: 'data_ml',
  recruiting: 'people_recruiting',
  recruiter: 'people_recruiting',
  hr: 'people_recruiting',
  ib: 'banking',
  'investment banking': 'banking',
  academia: 'education_academia',
  professor: 'education_academia',
  medicine: 'healthcare',
  government: 'policy_government',
  policy: 'policy_government',
  journalism: 'media',
  biotech: 'life_sciences',
};

const SENIORITY_SYNONYMS: Record<string, SearchSeniority[] | 'founder_flag'> = {
  exec: ['vp', 'c_level'],
  executive: ['vp', 'c_level'],
  executives: ['vp', 'c_level'],
  leadership: ['director_head', 'vp', 'c_level'],
  founder: 'founder_flag',
  junior: ['entry'],
  new_grad: ['entry'],
  lead: ['staff_lead'],
  staff: ['staff_lead'],
  principal: ['staff_lead'],
  director: ['director_head'],
  head: ['director_head'],
  cxo: ['c_level'],
  c_suite: ['c_level'],
};

const STOP = new Set(
  'a an the is are was who which that at in of for to and or works working work person people someone with has have their they from currently now'.split(
    ' ',
  ),
);

export interface LintResult {
  spec: QuerySpec;
  notes: string[];
  error?: string;
}

/** Normalize a compiled spec. `router` drops criteria (no model to check them). */
export function lintSpec(input: QuerySpec, opts: { router?: boolean } = {}): LintResult {
  const notes: string[] = [];
  const spec: QuerySpec = structuredClone(input);
  spec.positions = (spec.positions ?? []).map((p, i) => lintPosition(p, i, notes));
  if (!spec.positions.length) delete spec.positions;

  // criteria that only restate a block
  if (spec.criteria?.length) {
    const blockWords = new Set(
      [
        ...(spec.positions ?? []).flatMap((p) => [
          ...(p.role?.titles ?? []),
          ...(p.role?.families ?? []).map((f) => f.replace(/_/g, ' ')),
          p.role?.founder ? 'founder founders co-founder cofounder startup company' : '',
          ...(p.company?.names ?? []),
          p.company?.yc ? 'yc y combinator ycombinator batch' : '',
          ...(p.company?.yc?.batches ?? []),
          ...(p.company?.industries ?? []),
          ...(p.company?.kinds ?? []).map((k) => k.replace(/_/g, ' ')),
        ]),
        ...(spec.schools ?? []).flatMap((s) => [
          ...s.names,
          ...(s.fields ?? []),
          'school',
          'went',
          'studied',
          'student',
          'students',
        ]),
        ...(spec.places ?? []).flatMap((p) => [...p.names, 'based', 'lives', 'located', 'living']),
        ...(spec.keywords?.terms ?? []),
      ]
        .join(' ')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    );
    const kept = spec.criteria.filter((c) => {
      const words = c.text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w && !STOP.has(w));
      const restates =
        words.length > 0 && words.every((w) => blockWords.has(w) || blockWords.has(w.replace(/s$/, '')));
      if (restates) notes.push(`dropped "${c.text}": the filters already check it`);
      return !restates;
    });
    if (kept.length > 3) notes.push(`kept the first 3 of ${kept.length} judgment checks`);
    spec.criteria = kept.slice(0, 3);
    if (opts.router && spec.criteria.length) {
      notes.push('judgment checks need the AI, which is off right now');
      spec.criteria = [];
    }
    if (!spec.criteria.length) delete spec.criteria;
  }

  // a keyword must alongside a structured must narrows twice; keep it as a ranking hint unless quoted
  if (spec.keywords?.terms.length && (spec.keywords.need ?? 'must') === 'must') {
    const otherMust =
      (spec.positions ?? []).some((p) => (p.need ?? 'must') === 'must') ||
      (spec.schools ?? []).some((s) => (s.need ?? 'must') === 'must') ||
      (spec.places ?? []).some((p) => (p.need ?? 'must') === 'must');
    const quoted = spec.keywords.terms.some((t) => /^".+"$/.test(t.trim()));
    if (otherMust && !quoted) {
      spec.keywords = { ...spec.keywords, need: 'nice' };
      notes.push('topic words rank the results instead of filtering them');
    }
    spec.keywords.terms = spec.keywords.terms.map((t) => t.replace(/^"|"$/g, ''));
  }

  // anyOf needs ids
  if (spec.anyOf?.length && spec.positions) for (const [i, p] of spec.positions.entries()) p.id ??= `p${i}`;
  if (spec.limit !== undefined) spec.limit = Math.max(1, Math.min(50, Math.round(spec.limit)));
  for (const s of spec.schools ?? [])
    if (s.gradFrom && !s.gradTo && /class of/i.test(spec.ask)) s.gradTo = s.gradFrom;

  const hasAny =
    !!spec.positions?.length ||
    !!spec.schools?.length ||
    !!spec.places?.length ||
    !!spec.keywords?.terms.length ||
    !!spec.criteria?.length ||
    !!spec.like ||
    !!spec.relationship ||
    !!spec.refine;
  spec.lint = notes;
  return hasAny ? { spec, notes } : { spec, notes, error: 'empty' };
}

function lintPosition(p: PositionSpec, i: number, notes: string[]): PositionSpec {
  const out: PositionSpec = structuredClone(p);
  if (out.role) {
    const fams = new Set<TitleFamily>();
    for (const f of (out.role.families ?? []) as string[]) {
      const k = f.toLowerCase().replace(/\s+/g, '_');
      if ((TITLE_FAMILIES as readonly string[]).includes(k)) {
        if (k === 'founder') out.role.founder = true;
        else fams.add(k as TitleFamily);
        continue;
      }
      const syn = FAMILY_SYNONYMS[f.toLowerCase()];
      if (syn === 'founder_flag') out.role.founder = true;
      else if (syn) fams.add(syn);
      else {
        const q = readQueryTitle(f);
        if (q.families.length) for (const x of q.families) fams.add(x);
        else (out.role.titles ??= []).push(f);
      }
    }
    const sens = new Set<SearchSeniority>();
    for (const s of (out.role.seniority ?? []) as string[]) {
      const k = s.toLowerCase().replace(/[\s-]+/g, '_');
      if ((SENIORITIES as readonly string[]).includes(k)) sens.add(k as SearchSeniority);
      else {
        const syn = SENIORITY_SYNONYMS[k];
        if (syn === 'founder_flag') out.role.founder = true;
        else if (syn) for (const x of syn) sens.add(x);
      }
    }
    if (out.role.seniorityAtLeast) {
      const k = (out.role.seniorityAtLeast as string).toLowerCase().replace(/[\s-]+/g, '_');
      const syn = SENIORITY_SYNONYMS[k];
      out.role.seniorityAtLeast = (SENIORITIES as readonly string[]).includes(k)
        ? (k as SearchSeniority)
        : Array.isArray(syn)
          ? syn[0]
          : undefined;
    }
    // "founder" said three ways is one check
    if (out.role.founder) {
      fams.delete('founder' as TitleFamily);
      out.role.titles = (out.role.titles ?? []).filter((t) => !/^(co-?)?founders?$/i.test(t.trim()));
      if (sens.has('c_level') && sens.size === 1) sens.clear();
    }
    // a title the families already cover adds nothing
    out.role.titles = (out.role.titles ?? []).filter((t) => {
      const q = readQueryTitle(t);
      const covered = q.families.length > 0 && q.families.every((f) => fams.has(f)) && !q.seniority;
      return !covered || /\s/.test(t.trim());
    });
    out.role.families = fams.size ? [...fams] : undefined;
    out.role.seniority = sens.size ? [...sens] : undefined;
    if (!out.role.titles?.length) delete out.role.titles;
    for (const k of Object.keys(out.role) as (keyof typeof out.role)[])
      if (out.role[k] === undefined) delete out.role[k];
    if (!Object.keys(out.role).length) delete out.role;
  }
  if (out.company) {
    if (out.company.yc && !out.company.yc.any && !out.company.yc.batches?.length) out.company.yc.any = true;
    if (out.company.names) out.company.names = out.company.names.filter((n) => n.trim());
    if (out.company.names && !out.company.names.length) delete out.company.names;
  }
  // "YC founders" means founded a YC company at any point
  if (out.role?.founder && out.company?.yc && !p.when) {
    out.when = 'ever';
    notes.push('counted founders of YC companies whether or not they still run them');
  }
  if (!out.role && !out.company) notes.push(`position ${i + 1} had nothing to check`);
  return out;
}
