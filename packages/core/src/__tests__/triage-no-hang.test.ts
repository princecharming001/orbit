import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractProposedTimes, heuristicSignal } from '../email/triage';
import { CORPUS_NOW, CORPUS_TZ, MESSAGES, THREADS } from './fixtures/email-corpus';
import { INTRO_CASES, INTRO_HOLDOUT, INTRO_TRAIN } from './fixtures/intro-corpus';
import { NOTES } from './fixtures/notes';
import { fromEmailCorpus } from './fixtures/reply-signals';
import { HOLDOUT } from './fixtures/reply-signals-holdout';
import { TRAIN } from './fixtures/reply-signals-train';

/**
 * Reading a reply must always finish. A regular expression that loops (a global regex whose match is empty never moves
 * `lastIndex` on) blocks the whole app, and an in-process timeout cannot stop a synchronous loop. So the corpus sweep
 * runs in a child test run that is killed when it overruns its budget, and the in-process regression tests only run
 * once that child has come back.
 */

const CHILD = process.env.ORBIT_NO_HANG_CHILD === '1';
/** wall-clock limit for the whole child run, startup included */
const CHILD_BUDGET_MS = 120_000;
/** one string may take this long at most; each takes about a millisecond */
const PER_STRING_MS = 1_000;

/** Clauses that start with "pass" and go on as a referral or "pass on a/the …": these used to loop forever. */
const HUNG = [
  "Pass along my best to Professor Chen! And yes, let's find a time — send over your availability.",
  'Pass on a call for now, but happy to answer questions by email.',
  'Sure! Pass my note along to your roommate too.',
  'Pass it to Dr Chen',
  'pass along my best to professor chen',
];

function read(text: string): void {
  for (const direction of ['inbound', 'outbound'] as const) {
    heuristicSignal(text, direction, CORPUS_NOW, { timeZone: CORPUS_TZ });
    heuristicSignal(text, direction, CORPUS_NOW, { timeZone: CORPUS_TZ, awaitingAnswer: true });
  }
  extractProposedTimes(text, CORPUS_NOW, CORPUS_TZ);
}

function corpusStrings(): string[] {
  const all = [
    ...HUNG,
    ...MESSAGES.flatMap((m) => [m.body, m.subject ?? '']),
    ...THREADS.flatMap((t) => [t.subject, ...t.messages.map((m) => m.body)]),
    ...[...TRAIN, ...HOLDOUT, ...fromEmailCorpus()].map((x) => x.body),
    ...[...INTRO_CASES, ...INTRO_TRAIN, ...INTRO_HOLDOUT].flatMap((c) => [c.body, c.subject]),
    ...NOTES.map((n) => n.text),
  ].filter((s) => s.trim());
  // each sentence on its own too, so a clause that hangs only at the start of a text is reached
  const sentences = all.flatMap((s) => s.split(/(?<=[.?!])\s+|\n+/)).filter((s) => s.trim());
  return [...new Set([...all, ...sentences, ...all.map((s) => s.toLowerCase())])];
}

if (CHILD) {
  describe('every corpus string is read within its budget', () => {
    it('heuristicSignal and extractProposedTimes finish on each string', { timeout: CHILD_BUDGET_MS }, () => {
      const slow: string[] = [];
      for (const s of corpusStrings()) {
        const t0 = performance.now();
        read(s);
        const ms = performance.now() - t0;
        if (ms > PER_STRING_MS) slow.push(`${Math.round(ms)} ms: ${s.slice(0, 80)}`);
      }
      expect(slow).toEqual([]);
    });
  });
} else {
  let childOk: boolean | undefined;
  const ensureChild = () => {
    if (childOk === false) throw new Error('not run: the corpus sweep did not finish within its budget');
  };

  describe('reading a reply never hangs', () => {
    it('reads every corpus string within its time budget, in a child run killed if it overruns', {
      timeout: CHILD_BUDGET_MS + 10_000,
    }, async () => {
      const vitest = join(
        dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
        'vitest.mjs',
      );
      const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
      const child = spawn(process.execPath, [vitest, 'run', 'src/__tests__/triage-no-hang.test.ts'], {
        cwd: root,
        env: { ...process.env, ORBIT_NO_HANG_CHILD: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, CHILD_BUDGET_MS);
      const status = await new Promise<number | null>((done) => child.on('close', (code) => done(code)));
      clearTimeout(timer);
      childOk = !timedOut && status === 0;
      expect(timedOut ? `timed out after ${CHILD_BUDGET_MS} ms` : '').toBe('');
      expect(status, out.slice(-4000)).toBe(0);
    });

    for (const text of HUNG)
      it(`reads "${text.slice(0, 48)}"`, { timeout: 2_000 }, () => {
        ensureChild();
        const t0 = performance.now();
        const r = heuristicSignal(text, 'inbound', CORPUS_NOW, { timeZone: CORPUS_TZ, awaitingAnswer: true });
        extractProposedTimes(text, CORPUS_NOW, CORPUS_TZ);
        expect(performance.now() - t0).toBeLessThan(PER_STRING_MS);
        // a "pass" that passes something on is not a no; a pass on a call with an offer of email is email only
        expect(r.signal).not.toBe('reply_decline');
        if (/^pass on a call/i.test(text)) expect(r.extraction.prefersEmail).toBe(true);
      });
  });
}
