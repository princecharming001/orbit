import { describe, expect, it } from 'vitest';
import {
  INTRO_HOLDOUT,
  INTRO_TRAIN,
  type IntroCase,
  type IntroKind,
  introCaseRight,
  possibleIntroCase,
  readIntroCase,
} from './fixtures/intro-corpus';

const KINDS: IntroKind[] = ['introduction', 'intro_reply', 'none'];

function score(cases: IntroCase[]) {
  const confusion = new Map<string, number>();
  const wrong: string[] = [];
  let right = 0;
  for (const c of cases) {
    const got = readIntroCase(c);
    const key = `${c.expect.kind}->${got.kind}`;
    confusion.set(key, (confusion.get(key) ?? 0) + 1);
    if (introCaseRight(c, got)) right++;
    else
      wrong.push(
        `${c.id}: expected ${c.expect.kind}${c.expect.introduced ? ` [${c.expect.introduced}]` : ''}, got ${got.kind}${got.introduced.length ? ` [${got.introduced}]` : ''} (${got.reason})`,
      );
  }
  return { right, total: cases.length, accuracy: right / cases.length, confusion, wrong };
}

function summary(label: string, s: ReturnType<typeof score>): string {
  const rows = KINDS.map(
    (want) =>
      `  ${want.padEnd(13)}${KINDS.map((got) => String(s.confusion.get(`${want}->${got}`) ?? 0).padStart(14)).join('')}`,
  );
  return [
    `${label}: ${s.right}/${s.total} (${(s.accuracy * 100).toFixed(1)}%)`,
    `  ${'expected \\ got'.padEnd(13)}${KINDS.map((k) => k.padStart(14)).join('')}`,
    ...rows,
    ...s.wrong.map((w) => `  wrong: ${w}`),
  ].join('\n');
}

describe('introduction corpus (detectIntroduction / readIntroduction)', () => {
  const train = score(INTRO_TRAIN);
  const holdout = score(INTRO_HOLDOUT);

  it('is large enough, with a hold-out of at least a fifth, and unique ids', () => {
    const all = [...INTRO_TRAIN, ...INTRO_HOLDOUT];
    expect(all.length).toBeGreaterThanOrEqual(150);
    expect(INTRO_HOLDOUT.length / all.length).toBeGreaterThanOrEqual(0.2);
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    for (const k of KINDS) expect(all.filter((c) => c.expect.kind === k).length).toBeGreaterThan(20);
  });

  it('reads every case it was tuned on correctly', () => {
    console.log(summary('intro corpus, tuning set', train));
    expect(train.wrong).toEqual([]);
  });

  it('reads the hold-out at 97% or better, with every introduction right', () => {
    console.log(summary('intro corpus, hold-out', holdout));
    expect(holdout.accuracy).toBeGreaterThanOrEqual(0.97);
    const missedIntros = INTRO_HOLDOUT.filter(
      (c) => c.expect.kind === 'introduction' && !introCaseRight(c, readIntroCase(c)),
    );
    expect(missedIntros.map((c) => c.id)).toEqual([]);
  });

  it('asks "Did Lena introduce you to Sam?" rarely: on at most 1% of the messages that are not introductions', () => {
    const lines: string[] = [];
    for (const [label, cases] of [
      ['tuning set', INTRO_TRAIN],
      ['hold-out', INTRO_HOLDOUT],
    ] as const) {
      const neither = cases.filter((c) => c.expect.kind === 'none');
      const replies = cases.filter((c) => c.expect.kind === 'intro_reply');
      const intros = cases.filter((c) => c.expect.kind === 'introduction');
      const asked = neither.filter((c) => possibleIntroCase(c));
      const askedReplies = replies.filter((c) => possibleIntroCase(c));
      const caught = intros.filter((c) => {
        const p = possibleIntroCase(c, { ifMissed: true });
        return !!p && p.personIds.some((id) => c.expect.introduced?.includes(id));
      });
      lines.push(
        `fallback, ${label}: asks on ${asked.length}/${neither.length} non-introductions (${((asked.length / neither.length) * 100).toFixed(1)}%), ${askedReplies.length}/${replies.length} replies; would ask about ${caught.length}/${intros.length} introductions (${((caught.length / intros.length) * 100).toFixed(1)}%) if the cues missed them`,
        ...asked.map((c) => `  asks on: ${c.id}`),
      );
      expect(asked.length / neither.length).toBeLessThanOrEqual(0.01);
      expect(askedReplies).toEqual([]);
      expect(caught.length / intros.length).toBeGreaterThanOrEqual(0.6);
    }
    console.log(lines.join('\n'));
  });
});
