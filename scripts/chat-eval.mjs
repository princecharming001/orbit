#!/usr/bin/env node
/**
 * Reads a sim scorecard (apps/web/src/chat/__tests__/sim/run.test.ts writes <SIM_DIR>/_scorecard.json) and prints the
 * plan 28 summary: per group, the average of each judged dimension, how many scenarios fell under the bar, the shape
 * problems, and every scenario that failed a floor. Compare two runs by passing both files.
 *
 * usage: node scripts/chat-eval.mjs <scorecard.json> [<earlier scorecard.json>]
 */
import { readFileSync } from 'node:fs';

const DIMS = ['answered', 'friendAhead', 'ownData', 'webSearch', 'rightOutcome', 'shape', 'noOverwhelm', 'honest'];
const SHORT = { answered: 'ans', friendAhead: 'friend', ownData: 'own', webSearch: 'web', rightOutcome: 'outcome', shape: 'shape', noOverwhelm: 'calm', honest: 'honest' };

const [file, before] = process.argv.slice(2);
if (!file) {
  console.log('usage: node scripts/chat-eval.mjs <scorecard.json> [<earlier scorecard.json>]');
  process.exit(1);
}
const rows = JSON.parse(readFileSync(file, 'utf8'));
const earlier = before ? JSON.parse(readFileSync(before, 'utf8')) : undefined;

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmt = (n) => n.toFixed(2);
const under = (r) => DIMS.filter((d) => (r.verdict.dims?.[d] ?? 0) < 2);

const groups = [...new Set(rows.map((r) => r.group))];
console.log(`\n${rows.length} scenarios in ${groups.length} groups\n`);
console.log(['group', 'n', ...DIMS.map((d) => SHORT[d]), 'score', 'under', 'shape✗', 'unsafe', 'invented'].join('\t'));
for (const g of [...groups, 'ALL']) {
  const rs = g === 'ALL' ? rows : rows.filter((r) => r.group === g);
  const cols = DIMS.map((d) => fmt(avg(rs.map((r) => r.verdict.dims?.[d] ?? 0))));
  console.log(
    [
      g,
      rs.length,
      ...cols,
      fmt(avg(rs.map((r) => r.verdict.score))),
      rs.filter((r) => under(r).length).length,
      rs.filter((r) => r.shape && !r.shape.ok).length,
      rs.filter((r) => !r.verdict.safe).length,
      rs.filter((r) => r.verdict.invented).length,
    ].join('\t'),
  );
}

const shapeProblems = new Map();
for (const r of rows) for (const p of r.shape?.problems ?? []) {
  const key = p.replace(/^turn \d+: /, '').replace(/\d+/g, 'N').replace(/\(".*"\)/, '');
  shapeProblems.set(key, (shapeProblems.get(key) ?? 0) + 1);
}
if (shapeProblems.size) {
  console.log('\nshape problems, most common first');
  for (const [k, n] of [...shapeProblems.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${k}`);
}

const webTotal = rows.reduce((a, r) => a + (r.web?.length ?? 0), 0);
console.log(`\nweb searches: ${webTotal} across ${rows.filter((r) => r.web?.length).length} scenarios`);
for (const r of rows.filter((r) => r.web?.length)) console.log(`  ${r.id}: ${r.web.map((q) => `"${q}"`).join(', ')}`);

console.log('\nbelow the bar (any dimension under 2, or unsafe, or invented, or shape problems)');
for (const r of rows) {
  const u = under(r);
  const flags = [
    ...u.map((d) => `${SHORT[d]}=${r.verdict.dims?.[d]}`),
    r.verdict.safe ? '' : 'UNSAFE',
    r.verdict.invented ? 'INVENTED' : '',
    r.shape && !r.shape.ok ? `shape(${r.shape.problems.length})` : '',
  ].filter(Boolean);
  if (!flags.length) continue;
  console.log(`\n  ${r.group}/${r.id}  ${flags.join(' ')}  score ${r.verdict.score}  goal ${r.verdict.goalMet}`);
  if (r.verdict.dimNotes) console.log(`    notes: ${r.verdict.dimNotes}`);
  console.log(`    worst: ${r.verdict.worst}`);
  console.log(`    fix:   ${r.verdict.fix}`);
  for (const p of r.shape?.problems ?? []) console.log(`    shape: ${p}`);
}

if (earlier) {
  console.log('\nchange since the earlier run (ALL)');
  const byId = new Map(earlier.map((r) => [r.id, r]));
  for (const d of DIMS) {
    const now = avg(rows.map((r) => r.verdict.dims?.[d] ?? 0));
    const was = avg(earlier.map((r) => r.verdict.dims?.[d] ?? 0));
    console.log(`  ${SHORT[d]}\t${fmt(was)} -> ${fmt(now)}\t${now >= was ? '+' : ''}${fmt(now - was)}`);
  }
  const worse = rows.filter((r) => {
    const e = byId.get(r.id);
    return e && DIMS.some((d) => (r.verdict.dims?.[d] ?? 0) < (e.verdict.dims?.[d] ?? 0));
  });
  if (worse.length) console.log(`  regressed: ${worse.map((r) => r.id).join(', ')}`);
}
console.log('');
