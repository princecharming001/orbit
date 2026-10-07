import { describe, expect, it } from 'vitest';
import { HOLDOUT_CASES, NAME_CASES, type NameCase, TRAIN_CASES } from './fixtures/suggested-names';
import { readSuggestedNames, type SuggestedName } from './suggested-names';

type Label = 'save' | 'confirm' | 'skip';
const LABELS: Label[] = ['save', 'confirm', 'skip'];
const key = (n: SuggestedName) => (n.org ? `${n.name} | ${n.org}` : n.name);
const nameOf = (k: string) => k.split(' | ')[0]!.toLowerCase();

interface Score {
  cases: number;
  correct: number;
  failures: string[];
  /** confusion[expected][got], counted per person; an answer with no person counts once as skip/skip. */
  confusion: Record<Label, Record<Label, number>>;
  /** Expected nothing saved (a non-answer, a role, a confirm) but something was saved. */
  falseSaves: number;
}

function score(cases: NameCase[]): Score {
  const confusion = Object.fromEntries(
    LABELS.map((l) => [l, Object.fromEntries(LABELS.map((m) => [m, 0]))]),
  ) as Score['confusion'];
  const failures: string[] = [];
  let correct = 0;
  let falseSaves = 0;
  for (const c of cases) {
    const r = readSuggestedNames(c.text);
    const got = { save: r.names.map(key).sort(), confirm: r.confirm.map(key).sort() };
    const want = { save: [...(c.save ?? [])].sort(), confirm: [...(c.confirm ?? [])].sort() };
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) correct++;
    else failures.push(`${JSON.stringify(c.text)}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
    const label = (s: { save: string[]; confirm: string[] }, n: string): Label =>
      s.save.some((k) => nameOf(k) === n)
        ? 'save'
        : s.confirm.some((k) => nameOf(k) === n)
          ? 'confirm'
          : 'skip';
    const people = new Set([...got.save, ...got.confirm, ...want.save, ...want.confirm].map(nameOf));
    if (!people.size) confusion.skip.skip++;
    for (const n of people) {
      const e = label(want, n);
      const g = label(got, n);
      confusion[e][g]++;
      if (g === 'save' && e !== 'save') falseSaves++;
    }
    // a saved person with the wrong company is a wrong save too
    if (!ok && got.save.some((k) => !want.save.includes(k) && want.save.some((w) => nameOf(w) === nameOf(k))))
      falseSaves++;
  }
  return { cases: cases.length, correct, failures, confusion, falseSaves };
}

function summary(title: string, s: Score): string {
  const row = (e: Label) =>
    `  ${e.padEnd(8)}${LABELS.map((g) => String(s.confusion[e][g]).padStart(9)).join('')}`;
  return [
    `${title}: ${s.correct}/${s.cases} answers right (${((100 * s.correct) / s.cases).toFixed(1)}%), ${s.falseSaves} wrong saves`,
    `  ${'want/got'.padEnd(8)}${LABELS.map((g) => g.padStart(9)).join('')}`,
    ...LABELS.map(row),
    ...s.failures.map((f) => `  miss ${f}`),
  ].join('\n');
}

describe('suggested-name corpus', () => {
  it('is large enough and split 80/20', () => {
    expect(NAME_CASES.length).toBeGreaterThanOrEqual(120);
    expect(HOLDOUT_CASES.length).toBe(Math.floor(NAME_CASES.length / 5));
    expect(new Set(NAME_CASES.map((c) => c.text)).size).toBe(NAME_CASES.length);
  });

  it('reads the training answers', () => {
    const s = score(TRAIN_CASES);
    console.log(summary('suggested names, train', s));
    expect(s.falseSaves).toBe(0);
    expect(s.correct / s.cases).toBeGreaterThanOrEqual(0.97);
  });

  it('reads the held-out answers at 97% or better, with no invented person saved', () => {
    const s = score(HOLDOUT_CASES);
    console.log(summary('suggested names, hold-out', s));
    expect(s.falseSaves).toBe(0);
    expect(s.correct / s.cases).toBeGreaterThanOrEqual(0.97);
  });
});
