/**
 * The offline simulation's scorecard: each test file writes its part (`part-<name>.json`) to the output folder, and
 * every write rebuilds `scorecard.json` and `report.md` from all the parts there, so the last file to finish leaves
 * the whole picture: pass rates per capability, area, phrasing and account, the most common problems, and every
 * failing transcript.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CaseResult } from './runner';

export const SIM_OUT = process.env.ORBIT_SIM_OUT ?? join(tmpdir(), 'orbit-sim-offline');

/** Failures that are understood and owned elsewhere: the case id (or a prefix) and why. */
export interface Known {
  id: string;
  why: string;
  /** only failures whose every line matches this are explained (a new kind of failure on the same case is not) */
  match?: string;
}

/** The explanation for a failing run, when every one of its failures is the known one. */
export function explained(r: CaseResult, known: Known[]): Known | undefined {
  const lines = r.steps.flatMap((s) => s.failures);
  return known.find(
    (k) =>
      (r.id === k.id || r.id.startsWith(k.id)) &&
      (!k.match || lines.every((l) => new RegExp(k.match!).test(l))),
  );
}

interface Rate {
  pass: number;
  total: number;
}
const rate = (r: Rate) => (r.total ? r.pass / r.total : 1);
const pct = (r: Rate) => `${(rate(r) * 100).toFixed(1)}% (${r.pass}/${r.total})`;

function tally<K extends string>(results: CaseResult[], key: (r: CaseResult) => K | undefined) {
  const out = new Map<K, Rate>();
  for (const r of results) {
    const k = key(r);
    if (k === undefined) continue;
    const t = out.get(k) ?? { pass: 0, total: 0 };
    t.total++;
    if (r.pass) t.pass++;
    out.set(k, t);
  }
  return out;
}

/** The kind of problem a failure line is, for the histogram: "wrong tool", "refused", "too long"... */
export function problemKind(line: string): string {
  return line
    .split(':')[0]!
    .replace(/ \d+.*$/, '')
    .trim();
}

export function writePart(name: string, results: CaseResult[], known: Known[]): void {
  mkdirSync(SIM_OUT, { recursive: true });
  writeFileSync(join(SIM_OUT, `part-${name}.json`), JSON.stringify({ name, results, known }, null, 1));
  writeReport();
}

export function writeReport(): { passRate: number; total: number } {
  const parts = readdirSync(SIM_OUT)
    .filter((f) => /^part-.*\.json$/.test(f))
    .map(
      (f) =>
        JSON.parse(readFileSync(join(SIM_OUT, f), 'utf8')) as {
          name: string;
          results: CaseResult[];
          known: Known[];
        },
    );
  const results = parts.flatMap((p) => p.results);
  const known = parts.flatMap((p) => p.known);
  const knownFor = (id: string) => {
    const r = results.find((x) => x.id === id);
    return r ? explained(r, known) : undefined;
  };
  const all: Rate = { pass: results.filter((r) => r.pass).length, total: results.length };
  const single = results.filter((r) => !r.thread);
  const threads = results.filter((r) => r.thread);
  const steps = threads.flatMap((t) => t.steps);
  const byCap = tally(single, (r) => r.cap);
  const byArea = tally(results, (r) => r.area);
  const byVariant = tally(single, (r) => r.variant);
  const byAccount = tally(results, (r) => r.account);
  const problems = new Map<string, number>();
  for (const r of results)
    for (const s of r.steps)
      for (const f of s.failures) problems.set(problemKind(f), (problems.get(problemKind(f)) ?? 0) + 1);
  const failing = results.filter((r) => !r.pass);
  const unexplained = failing.filter((r) => !knownFor(r.id));

  const scorecard = {
    generatedAt: new Date().toISOString(),
    total: all.total,
    passed: all.pass,
    passRate: rate(all),
    singleTurn: { total: single.length, passed: single.filter((r) => r.pass).length },
    threads: { total: threads.length, passed: threads.filter((r) => r.pass).length, steps: steps.length },
    explainedFailures: failing.length - unexplained.length,
    unexplainedFailures: unexplained.length,
    byCapability: Object.fromEntries([...byCap].map(([k, v]) => [k, { ...v, rate: rate(v) }])),
    byArea: Object.fromEntries([...byArea].map(([k, v]) => [k, { ...v, rate: rate(v) }])),
    byVariant: Object.fromEntries([...byVariant].map(([k, v]) => [k, { ...v, rate: rate(v) }])),
    byAccount: Object.fromEntries([...byAccount].map(([k, v]) => [k, { ...v, rate: rate(v) }])),
    problems: Object.fromEntries([...problems].sort((a, b) => b[1] - a[1])),
    failing: failing.map((r) => ({
      id: r.id,
      known: knownFor(r.id)?.why,
      failures: r.steps.flatMap((s) => s.failures),
    })),
  };
  writeFileSync(join(SIM_OUT, 'scorecard.json'), JSON.stringify(scorecard, null, 2));

  const ms = results.flatMap((r) => r.steps.map((s) => s.ms));
  const lines: string[] = [
    '# Orbit chat simulation (offline, router mode)',
    '',
    `Generated ${scorecard.generatedAt}. The real chat engine with no Claude key, over the real tools, on seeded accounts.`,
    '',
    `- **Overall: ${pct(all)}** of ${all.total} runs (${single.length} single requests, ${threads.length} threads with ${steps.length} steps)`,
    `- Single requests: ${pct({ pass: scorecard.singleTurn.passed, total: single.length })}`,
    `- Threads: ${pct({ pass: scorecard.threads.passed, total: threads.length })}`,
    `- Failures explained (owned elsewhere or by design): ${scorecard.explainedFailures}; unexplained: ${unexplained.length}`,
    `- Time per step: median ${median(ms)} ms, slowest ${Math.max(0, ...ms)} ms`,
    '',
    '## By account',
    '',
    '| account | pass rate |',
    '|---|---|',
    ...[...byAccount].map(([k, v]) => `| ${k} | ${pct(v)} |`),
    '',
    '## By area',
    '',
    '| area | pass rate |',
    '|---|---|',
    ...[...byArea].sort((a, b) => rate(a[1]) - rate(b[1])).map(([k, v]) => `| ${k} | ${pct(v)} |`),
    '',
    '## By phrasing',
    '',
    '| phrasing | pass rate |',
    '|---|---|',
    ...[...byVariant].map(([k, v]) => `| ${k} | ${pct(v)} |`),
    '',
    '## Problems found (count of failed checks)',
    '',
    ...[...problems].sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Capabilities below 100%',
    '',
    '| capability | pass rate |',
    '|---|---|',
    ...[...byCap]
      .filter(([, v]) => v.pass < v.total)
      .sort((a, b) => rate(a[1]) - rate(b[1]))
      .map(([k, v]) => `| ${k} | ${pct(v)} |`),
    '',
    `## Failing transcripts (${failing.length})`,
    '',
  ];
  for (const r of failing) {
    const k = knownFor(r.id);
    lines.push(
      `### ${r.id}${r.thread ? `: ${r.thread}` : ''} (${r.account})${k ? ` [explained: ${k.why}]` : ''}`,
    );
    lines.push('');
    for (const s of r.steps) {
      lines.push(`- **student:** ${s.student}`);
      lines.push(`  - tools: ${s.tools.join(', ') || 'none'}; cards: ${s.kinds.join(', ') || 'none'}`);
      if (s.lead) lines.push(`  - says: ${s.lead.replace(/\s+/g, ' ')}`);
      if (s.summary) lines.push(`  - summary: ${s.summary.replace(/\s+/g, ' ').slice(0, 300)}`);
      if (s.chips.length)
        lines.push(`  - chips: ${s.chips.map((c) => `${c.label} -> ${c.routes}`).join(' | ')}`);
      for (const f of s.failures) lines.push(`  - FAIL ${f}`);
    }
    lines.push('');
  }
  writeFileSync(join(SIM_OUT, 'report.md'), lines.join('\n'));
  return { passRate: rate(all), total: all.total };
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
