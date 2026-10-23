/**
 * The offline simulation's requests and threads (offline/cases.ts, offline/threads.ts), run in Claude mode: the same
 * seeded accounts, the real engine with Claude choosing the tools, the same per-step checks (right tool or a fair
 * question, right card, nothing invented, short replies, chips that route, nothing sent without Approve), plus a
 * Claude judge reading each run against what it was expected to do. Skipped unless a key or Orbit's proxy is set:
 *
 *   ANTHROPIC_API_KEY=... pnpm --filter @orbit/web exec vitest run src/chat/__tests__/sim/claude
 *   ORBIT_SIM_PROXY=https://<project>.supabase.co/functions/v1/orbit-claude pnpm --filter @orbit/web exec vitest run src/chat/__tests__/sim/claude
 *
 * It spends: SIM_LIMIT caps the single requests per account (default 40, threads always run; SIM_LIMIT=all for every
 * one), SIM_ACCOUNTS picks accounts (default student,demo), ORBIT_SIM_ONLY filters by id prefix. The scorecard and the
 * report go to ORBIT_SIM_OUT (default <tmp>/orbit-sim-claude), with the judge's verdict per run in verdicts.json.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearPrefs } from '../../../integrations/prefs';
import { judgeRun, pointChatAtClaude, type RunVerdictT, SIM_ENABLED, teardownSim } from './harness';
import type { AccountId } from './offline/accounts';
import { CASES } from './offline/cases';
import { type CaseResult, type Expect, Session, type Step } from './offline/runner';
import { THREADS } from './offline/threads';

process.env.ORBIT_SIM_OUT ??= join(tmpdir(), 'orbit-sim-claude');
const { SIM_OUT, writePart } = await import('./offline/report');

const accounts = (process.env.SIM_ACCOUNTS ?? 'student,demo').split(',').map((s) => s.trim()) as AccountId[];
const limit =
  process.env.SIM_LIMIT === 'all' ? Number.POSITIVE_INFINITY : Number(process.env.SIM_LIMIT ?? 40);
const only = process.env.ORBIT_SIM_ONLY?.split(',').map((s) => s.trim());
const picked = <T extends { id: string; account: AccountId }>(xs: T[], account: AccountId) =>
  xs.filter((x) => x.account === account && (!only || only.some((o) => x.id.startsWith(o))));

/** An even spread of the single requests: every area and phrasing, not the first N of one capability. */
function spread<T extends { area: string }>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const byArea = new Map<string, T[]>();
  for (const x of xs) byArea.set(x.area, [...(byArea.get(x.area) ?? []), x]);
  const out: T[] = [];
  for (let i = 0; out.length < n; i++) {
    let added = false;
    for (const list of byArea.values())
      if (list[i] && out.length < n) {
        out.push(list[i]!);
        added = true;
      }
    if (!added) break;
  }
  return out;
}

const describeExpect = (e: Expect | undefined): string => {
  if (!e) return 'anything sensible';
  const parts: string[] = [];
  if (e.tool) parts.push(`runs ${[e.tool].flat().join(' or ')}`);
  if (e.kind) parts.push(`shows a ${[e.kind].flat().join(' or ')} card`);
  if (e.ask) parts.push('or asks one clarifying question');
  if (e.answer) parts.push('or answers in words');
  if (e.needsKey) parts.push('or says honestly it cannot judge that');
  if (e.pending) parts.push('leaves a confirmation waiting for Approve (nothing sent)');
  if (e.draftFor) parts.push(`leaves a draft to ${e.draftFor}`);
  if (e.stage) parts.push(`moves ${e.stage[0]} to ${e.stage[1]}`);
  if (e.cold) parts.push('asks what it refers to (nothing came before), changing nothing');
  return parts.join(', ') || 'anything sensible';
};

const stepText = (s: Step) =>
  'say' in s ? s.say : 'tap' in s ? `(tap ${String(s.tap)})` : 'approve' in s ? '(Approve)' : '(Cancel)';

const results: CaseResult[] = [];
const verdicts: { id: string; verdict: RunVerdictT }[] = [];

describe.skipIf(!SIM_ENABLED)('sim: the offline cases and threads in Claude mode', () => {
  beforeAll(async () => {
    await clearPrefs();
    window.open = () => null;
  });

  afterAll(() => {
    teardownSim();
    if (results.length) writePart('claude', results, []);
    if (verdicts.length) writeFileSync(join(SIM_OUT, 'verdicts.json'), JSON.stringify(verdicts, null, 2));
  });

  for (const account of accounts) {
    it(`${account}: single requests and threads`, async () => {
      const session = new Session(account, pointChatAtClaude);
      await session.open();
      const runs: { id: string; expected: string; run: () => Promise<CaseResult> }[] = [
        ...spread(picked(CASES, account), limit).map((c) => ({
          id: c.id,
          expected: `1. "${c.text}": ${describeExpect(c.expect)}`,
          run: () => session.runCase(c),
        })),
        ...picked(THREADS, account).map((t) => ({
          id: t.id,
          expected: t.steps.map((s, i) => `${i + 1}. ${stepText(s)}: ${describeExpect(s.expect)}`).join('\n'),
          run: () => session.runThread(t),
        })),
      ];
      for (const r of runs) {
        const res = await r.run();
        results.push(res);
        const screen = res.steps
          .map(
            (s, i) =>
              `${i + 1}. student: ${s.student}\n   tools: ${s.tools.join(', ') || 'none'}; cards: ${s.kinds.join(', ') || 'none'}\n   orbit says: ${s.lead || s.summary}\n   buttons: ${s.chips.map((c) => c.label).join(' | ') || 'none'}${s.failures.length ? `\n   automatic checks failed: ${s.failures.join('; ')}` : ''}`,
          )
          .join('\n');
        verdicts.push({ id: res.id, verdict: await judgeRun(screen, r.expected) });
      }
      const unsafe = results.filter((r) =>
        r.steps.some((s) => s.failures.some((f) => /sent without an approval|changed something/.test(f))),
      );
      expect(
        unsafe.map((r) => r.id),
        'changed or sent something without an approval',
      ).toEqual([]);
      const mine = verdicts.filter((v) => runs.some((r) => r.id === v.id));
      expect(mine.filter((v) => !v.verdict.stateOk).map((v) => `${v.id}: ${v.verdict.worst}`)).toEqual([]);
      expect(mine.filter((v) => v.verdict.invented).map((v) => `${v.id}: ${v.verdict.worst}`)).toEqual([]);
    }, 3_600_000);
  }
});
