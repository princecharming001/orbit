/**
 * Running a spec over the network (plan 32 §6.4, §6.5, §18.2, §18.4, §18.9): every person's checks, a band, an order,
 * and honest counts. Bands:
 *   strong   every must is yes (criteria judged yes)
 *   likely   every must is yes or likely, at least one likely (or a criterion not judged yet)
 *   unchecked a must is unknown and none is no; listed when there is a clue worth checking, counted otherwise
 *   no       a must is no (hidden)
 */
import { docText, EVIDENCE_RANK, type EvidenceSource, type PersonDoc } from './doc';
import {
  ANSWER_RANK,
  type Answer,
  type Check,
  type CompiledSpec,
  checkAlum,
  checkKeywords,
  checkPlace,
  checkPosition,
  checkRelationship,
  checkSchool,
  compileSpec,
  type SearchContext,
} from './predicates';
import type { QuerySpec } from './spec';
import { WARMTH_RANK } from './spec';

export type Band = 'strong' | 'likely' | 'unchecked' | 'no';

export interface Row {
  id: string;
  band: Band;
  checks: Check[];
  /** an unchecked row with a clue (listed and judged) or without one (only counted) */
  signal?: 'hint' | 'none';
  /** unchecked, but every unknown is only a missing detail of something that matched */
  partial?: boolean;
  /** the weakest evidence among the must checks that passed */
  evidenceRank: number;
  niceScore: number;
  /** how many of the must checks it passed: in the unchecked band, the nearest misses come first */
  matched?: number;
  lexical: number;
  warmth: number;
  lastConversationAt?: string;
  name: string;
}

export interface JudgedAnswer {
  answer: Answer;
  /** the words in the person's text the answer rests on (verified to be there before it is kept) */
  quote?: string;
}

export interface RunOptions {
  /** BM25 scores from the lexical index, by person id */
  lexical?: ReadonlyMap<string, number>;
  /**
   * judge answers: person id -> check key ('criterion:0', 'position:1', 'school:0', 'any:0') -> answer. A criterion
   * takes the answer as it is; a structured check only moves on a judge answer when it was not settled by data
   * (likely, or unknown with a clue), so the judge never overrules a stated fact.
   */
  judged?: ReadonlyMap<string, ReadonlyMap<string, JudgedAnswer>>;
  /** "talk to", "help", "intro", "reconnect": warmth ranks before topical fit */
  warmthFirst?: boolean;
  /** restrict to these ids (refine onlyThese) */
  onlyIds?: ReadonlySet<string>;
}

export interface RunResult {
  compiled: CompiledSpec;
  rows: Row[];
  counts: {
    strong: number;
    likely: number;
    uncheckedListed: number;
    uncheckedSilent: number;
    no: number;
    total: number;
  };
  /** per must check: how many people it was unknown for, so the card can say what limited the answer */
  unknownBy: Record<string, number>;
}

function bandOf(checks: Check[]): { band: Band; signal?: 'hint' | 'none' } {
  const musts = checks.filter((c) => c.need === 'must');
  if (musts.some((c) => c.answer === 'no')) return { band: 'no' };
  const unknown = musts.filter((c) => c.answer === 'unknown');
  if (unknown.length)
    return { band: 'unchecked', signal: unknown.every((c) => c.signal === 'none') ? 'none' : 'hint' };
  if (musts.some((c) => c.answer === 'likely')) return { band: 'likely' };
  return { band: 'strong' };
}

const NICE_VALUE: Record<Answer, number> = { yes: 1, likely: 0.5, unknown: 0, no: -0.5 };

export function evaluateDoc(
  doc: PersonDoc,
  compiled: CompiledSpec,
  ctx: SearchContext,
  opts: RunOptions = {},
): Row {
  const text = docText(doc);
  const spec = compiled.spec;
  const checks: Check[] = [];
  const posChecks = compiled.positions.map((p) => checkPosition(doc, p, ctx, text));
  // anyOf groups: the group passes on its best member; members are not musts on their own
  const grouped = new Set<string>();
  for (const [gi, group] of (spec.anyOf ?? []).entries()) {
    const members = posChecks.filter((_c, i) => group.includes(compiled.positions[i]!.spec.id ?? `p${i}`));
    if (!members.length) continue;
    for (const m of members) grouped.add(m.key);
    const best = members.reduce((a, b) => (ANSWER_RANK[b.answer] > ANSWER_RANK[a.answer] ? b : a));
    checks.push({ ...best, key: `any:${gi}`, label: members.map((m) => m.label).join(' or '), need: 'must' });
  }
  for (const c of posChecks) if (!grouped.has(c.key)) checks.push(c);
  for (const s of compiled.schools) checks.push(checkSchool(doc, s, text));
  for (const p of compiled.places) checks.push(checkPlace(doc, p, ctx, text));
  if (compiled.keywords) checks.push(checkKeywords(doc, compiled.keywords, text));
  if (spec.relationship) {
    checks.push(...checkRelationship(doc.id, spec.relationship, ctx));
    if (spec.relationship.alumOfMySchool) checks.push(checkAlum(doc, ctx));
  }
  const judgedHere = opts.judged?.get(doc.id);
  if (judgedHere)
    for (const [i, c] of checks.entries()) {
      const j = judgedHere.get(c.key);
      if (!j || !(c.answer === 'likely' || (c.answer === 'unknown' && c.signal === 'hint'))) continue;
      // a judge yes or no lands as yes or no; its "likely" leaves a likely as it was and lifts an unknown
      if (j.answer === 'unknown') continue;
      // a no that only quotes the words Orbit already weighed for this check ("CTO at Opalite Health (YC W26)",
      // which made "founder" likely) adds nothing but the model's guess, so it cannot overturn the likely
      if (j.answer === 'no' && c.answer === 'likely' && quotesOnly(c.evidence, j.quote)) continue;
      checks[i] = {
        ...c,
        answer: j.answer,
        evidence: j.quote ? `"${j.quote}"` : c.evidence,
        source: c.source ?? 'judge',
        partial: undefined,
        missing: undefined,
        signal: undefined,
      };
    }
  for (const [i, cr] of (spec.criteria ?? []).entries()) {
    const judged = judgedHere?.get(`criterion:${i}`);
    const answer: Answer = judged?.answer ?? (ctx.noJudge ? 'unknown' : 'likely');
    checks.push({
      key: `criterion:${i}`,
      label: cr.text,
      need: cr.need ?? 'must',
      answer,
      signal: answer === 'unknown' ? (judged ? 'hint' : 'none') : undefined,
      source: judged ? 'judge' : undefined,
      evidence: judged
        ? judged.quote
          ? `"${judged.quote}"`
          : undefined
        : ctx.noJudge
          ? 'not checked (no AI right now)'
          : 'not checked yet',
    });
  }
  const { band, signal } = bandOf(checks);
  const unknownMusts = checks.filter((c) => c.need === 'must' && c.answer === 'unknown');
  const partial = band === 'unchecked' && unknownMusts.length > 0 && unknownMusts.every((c) => c.partial);
  const passed = checks.filter(
    (c) => c.need === 'must' && (c.answer === 'yes' || c.answer === 'likely') && c.source,
  );
  const evidenceRank = passed.length
    ? Math.min(
        ...passed.map(
          (c) => EVIDENCE_RANK[c.source as EvidenceSource] - (c.answer === 'likely' || c.estimated ? 1 : 0),
        ),
      )
    : 0;
  const niceScore = checks.filter((c) => c.need === 'nice').reduce((s, c) => s + NICE_VALUE[c.answer], 0);
  // the who-they-are checks passed (relationship checks are left out: "quiet for a year" fits most of a network)
  const matched = checks.filter(
    (c) => c.need === 'must' && !c.key.startsWith('rel:') && (c.answer === 'yes' || c.answer === 'likely'),
  ).length;
  const rel = ctx.rel(doc.id);
  return {
    id: doc.id,
    band,
    checks,
    signal,
    partial: partial || undefined,
    evidenceRank,
    niceScore,
    matched,
    lexical: opts.lexical?.get(doc.id) ?? 0,
    warmth: WARMTH_RANK[rel?.band ?? 'faint'],
    lastConversationAt: rel?.lastConversationAt,
    name: doc.name,
  };
}

const foldQuote = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The judge's quote is (part of) the evidence the check already rests on. */
export function quotesOnly(evidence: string | undefined, quote: string | undefined): boolean {
  if (!evidence || !quote) return false;
  const q = foldQuote(quote);
  return q.length > 0 && foldQuote(evidence).includes(q);
}

const BAND_ORDER: Record<Band, number> = { strong: 0, likely: 1, unchecked: 2, no: 3 };

/** Order rows: bands never mix; inside a band, `sort` or evidence, fit, then warmth. */
export function orderRows(rows: Row[], spec: QuerySpec, opts: RunOptions = {}): Row[] {
  const maxLex = Math.max(1e-9, ...rows.map((r) => r.lexical));
  const fitOf = (r: Row) => r.niceScore + r.lexical / maxLex;
  const recent = (r: Row) => (r.lastConversationAt ? Date.parse(r.lastConversationAt) : 0);
  return [...rows].sort((a, b) => {
    const band = BAND_ORDER[a.band] - BAND_ORDER[b.band];
    if (band) return band;
    // in the unchecked band, people with a clue come before people with none
    if (a.band === 'unchecked' && !!a.partial !== !!b.partial) return a.partial ? -1 : 1;
    if (a.band === 'unchecked' && (a.matched ?? 0) !== (b.matched ?? 0))
      return (b.matched ?? 0) - (a.matched ?? 0);
    if (a.band === 'unchecked' && a.signal !== b.signal) return a.signal === 'hint' ? -1 : 1;
    switch (spec.sort) {
      case 'warmth':
        return (
          b.warmth - a.warmth ||
          b.evidenceRank - a.evidenceRank ||
          fitOf(b) - fitOf(a) ||
          a.name.localeCompare(b.name)
        );
      case 'recent':
        return recent(b) - recent(a) || b.warmth - a.warmth || a.name.localeCompare(b.name);
      case 'name':
        return a.name.localeCompare(b.name);
      default:
        if (opts.warmthFirst)
          return (
            b.evidenceRank - a.evidenceRank ||
            b.warmth - a.warmth ||
            fitOf(b) - fitOf(a) ||
            a.name.localeCompare(b.name)
          );
        // a topic or a free-text criterion ranks by how well it fits; otherwise the people the student actually knows
        // and talks to come first (a list of 77 founders should open with the ones they message, not with "A")
        if (spec.keywords?.terms.length || spec.criteria?.length)
          return (
            b.evidenceRank - a.evidenceRank ||
            fitOf(b) - fitOf(a) ||
            b.warmth - a.warmth ||
            a.name.localeCompare(b.name)
          );
        return (
          b.warmth - a.warmth ||
          recent(b) - recent(a) ||
          b.evidenceRank - a.evidenceRank ||
          fitOf(b) - fitOf(a) ||
          a.name.localeCompare(b.name)
        );
    }
  });
}

export function runSpec(
  spec: QuerySpec,
  docs: readonly PersonDoc[],
  ctx: SearchContext,
  opts: RunOptions = {},
): RunResult {
  const compiled = compileSpec(spec, ctx);
  const exclude = new Set(spec.exclude?.personIds ?? []);
  const rows: Row[] = [];
  const counts = { strong: 0, likely: 0, uncheckedListed: 0, uncheckedSilent: 0, no: 0, total: 0 };
  const unknownBy: Record<string, number> = {};
  for (const d of docs) {
    if (exclude.has(d.id)) continue;
    if (opts.onlyIds && !opts.onlyIds.has(d.id)) continue;
    counts.total++;
    const row = evaluateDoc(d, compiled, ctx, opts);
    if (row.band === 'no') {
      counts.no++;
      continue;
    }
    if (row.band === 'unchecked') {
      for (const c of row.checks)
        if (c.need === 'must' && c.answer === 'unknown') unknownBy[c.label] = (unknownBy[c.label] ?? 0) + 1;
      // a near miss (at Stripe, in SF, school not on file) is listed even with no clue for the rest
      if (row.signal === 'none' && !row.matched) {
        counts.uncheckedSilent++;
        continue;
      }
      counts.uncheckedListed++;
    } else counts[row.band]++;
    rows.push(row);
  }
  return { compiled, rows: orderRows(rows, spec, opts), counts, unknownBy };
}
