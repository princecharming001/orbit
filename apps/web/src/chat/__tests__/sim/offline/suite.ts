import { afterAll, beforeAll, expect, it } from 'vitest';
import { clearPrefs } from '../../../../integrations/prefs';
import type { AccountId } from './accounts';
import { CASES } from './cases';
import { KNOWN } from './known';
import { explained, writePart } from './report';
import { type CaseResult, Session } from './runner';
import { THREADS } from './threads';

/** Below this the run fails: the no-key chat must handle what students ask, phrased the ways they ask it. */
export const PASS_FLOOR = 0.98;

/**
 * Run every case and thread for these accounts through the real engine, write this file's part of the scorecard, and
 * hold the floors: nothing sent without an approval, nothing failing that is not explained in known.ts, and the pass
 * rate. `ORBIT_SIM_REPORT_ONLY=1` writes the report without failing, for working through a fresh batch of problems.
 */
export function offlineSuite(name: string, accounts: AccountId[], part?: [number, number]): void {
  const results: CaseResult[] = [];
  const only = process.env.ORBIT_SIM_ONLY?.split(',').map((s) => s.trim());
  // a big account is split across files (part k of n), so vitest runs the halves side by side
  const pick = <T extends { id: string; account: AccountId }>(xs: T[], account: AccountId) =>
    xs
      .filter((x) => x.account === account && (!only || only.some((o) => x.id.startsWith(o))))
      .filter((_, i) => !part || i % part[1] === part[0]);

  beforeAll(async () => {
    await clearPrefs();
    // a hand-off opens a mailto in the real UI; jsdom cannot navigate
    window.open = () => null;
  });

  afterAll(() => {
    if (results.length) writePart(name, results, KNOWN);
  });

  it(`simulates students on ${accounts.join(', ')}`, async () => {
    for (const account of accounts) {
      const cases = pick(CASES, account);
      const threads = pick(THREADS, account);
      if (!cases.length && !threads.length) continue;
      const s = new Session(account);
      await s.open();
      for (const c of cases) results.push(await s.runCase(c));
      for (const t of threads) results.push(await s.runThread(t));
    }
    const failing = results.filter((r) => !r.pass);
    const unsafe = failing.filter((r) =>
      r.steps.some((st) => st.failures.some((f) => /sent without an approval|changed something/.test(f))),
    );
    const unexplained = failing.filter((r) => !explained(r, KNOWN));
    if (process.env.ORBIT_SIM_REPORT_ONLY) return;
    expect(
      unsafe.map((r) => r.id),
      'changed or sent something without an approval',
    ).toEqual([]);
    expect(
      unexplained.map((r) => `${r.id}: ${r.steps.flatMap((st) => st.failures).join('; ')}`),
      'failures not explained in known.ts',
    ).toEqual([]);
    expect(results.filter((r) => r.pass).length / Math.max(1, results.length)).toBeGreaterThanOrEqual(
      PASS_FLOOR,
    );
  }, 1_800_000);
}
