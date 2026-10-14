import { describe, expect, it } from 'vitest';
import { classifyReply, classOfSignal, REPLY_CLASSES, type ReplyClass } from '../email/replyClass';
import { CORPUS_NOW, CORPUS_TZ } from './fixtures/email-corpus';
import { fromEmailCorpus, type SignalExample } from './fixtures/reply-signals';
import { HOLDOUT } from './fixtures/reply-signals-holdout';
import { TRAIN } from './fixtures/reply-signals-train';
import { HOLDOUT_V2 } from './fixtures/reply-signals-v2-holdout';
import { type ReplyClassExample, TRAIN_V2 } from './fixtures/reply-signals-v2-train';

/**
 * Reply classes v2 (plan 16 §8.1, §8.7 test 1). The v1 corpus is scored in the eleven classes through the §8.1
 * mapping, with the v1 labels the new classes split: a soft decline that says when to come back is `not_now`, and
 * the three v1 "decline" examples that ask not to be emailed again are `unsubscribe`.
 */

/** v1 soft declines that invite coming back without a date the reader parses. */
const NOT_NOW_V1 = new Set([
  'ds-semester',
  'ds-baby',
  'bt-ds-fiscal-year',
  'b5v-ds-postpone-new-year',
  'email-corpus/decline-soft-slammed',
  'bt-ds-year-end-close',
  'bt-ds-mentees-next-fall',
]);
const UNSUBSCRIBE_V1 = new Set(['dh-remove-list', 'dh-dont-email', 'email-corpus/decline-remove']);

function goldOf(e: SignalExample): ReplyClass {
  if (UNSUBSCRIBE_V1.has(e.id)) return 'unsubscribe';
  switch (e.label) {
    case 'positive':
      return 'interested';
    case 'proposal':
    case 'confirmation':
    case 'reschedule':
      return 'scheduling';
    case 'question':
    case 'email_only':
      return 'question';
    case 'decline_hard':
      return 'decline';
    case 'decline_soft':
      return e.followUpAfter || NOT_NOW_V1.has(e.id) ? 'not_now' : 'decline';
    case 'ooo':
      return 'out_of_office';
    case 'intro':
    case 'intro_handoff':
    case 'referral':
      return 'referral';
    case 'thank_you':
      return 'thanks';
    case 'neutral':
    case 'other':
      return 'other';
  }
}

interface Case {
  id: string;
  gold: ReplyClass;
  body: string;
  direction?: 'inbound' | 'outbound';
  awaiting?: boolean;
}

const v1 = (examples: SignalExample[]): Case[] =>
  examples.map((e) => ({
    id: e.id,
    gold: goldOf(e),
    body: e.body,
    direction: e.direction,
    awaiting: e.awaiting,
  }));
const v2 = (examples: ReplyClassExample[]): Case[] =>
  examples.map((e) => ({ id: e.id, gold: e.cls, body: e.body, awaiting: e.awaiting }));

const predict = (c: Case) =>
  classifyReply(c.body, {
    now: CORPUS_NOW,
    timeZone: CORPUS_TZ,
    direction: c.direction,
    awaitingAnswer: c.awaiting,
  });

function score(
  name: string,
  cases: Case[],
): { accuracy: number; byClass: Map<ReplyClass, { n: number; ok: number }> } {
  const byClass = new Map<ReplyClass, { n: number; ok: number }>();
  const misses: string[] = [];
  let ok = 0;
  for (const c of cases) {
    const got = predict(c).class;
    const row = byClass.get(c.gold) ?? { n: 0, ok: 0 };
    row.n++;
    if (got === c.gold) {
      row.ok++;
      ok++;
    } else misses.push(`  ${c.id}: ${got}, want ${c.gold}`);
    byClass.set(c.gold, row);
  }
  const accuracy = ok / cases.length;
  console.log(
    [
      `${name}: ${ok}/${cases.length} (${(accuracy * 100).toFixed(1)}%)`,
      ...[...byClass].map(([k, r]) => `  ${k.padEnd(14)} ${r.ok}/${r.n}`),
      ...misses,
    ].join('\n'),
  );
  return { accuracy, byClass };
}

const TUNING = [...v1(TRAIN), ...v1(fromEmailCorpus()), ...v2(TRAIN_V2)];
const HELD_OUT = [...v1(HOLDOUT), ...v2(HOLDOUT_V2)];

describe('reply classes v2 corpus', () => {
  it('has at least 40 examples each of objection, not_now and unsubscribe, about a fifth held out', () => {
    for (const cls of ['objection', 'not_now', 'unsubscribe'] as const) {
      const train = TRAIN_V2.filter((e) => e.cls === cls).length;
      const held = HOLDOUT_V2.filter((e) => e.cls === cls).length;
      expect(train + held, cls).toBeGreaterThanOrEqual(40);
      expect(held / (train + held), cls).toBeGreaterThanOrEqual(0.18);
    }
    const all = [...TUNING, ...HELD_OUT];
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    expect(new Set(all.map((c) => c.body)).size).toBe(all.length);
    expect(new Set(HELD_OUT.map((c) => c.gold))).toEqual(new Set(REPLY_CLASSES));
  });

  it('tuning part: every new-class example right and at least 97% overall', () => {
    const { accuracy } = score('reply classes, tuning', TUNING);
    expect(accuracy).toBeGreaterThanOrEqual(0.97);
    for (const c of v2(TRAIN_V2)) expect(predict(c).class, c.id).toBe(c.gold);
  });

  it('§8.7 test 1: held out at least 95% over the 11 classes, and every unsubscribe and decline right', () => {
    const { accuracy, byClass } = score('reply classes, held out', HELD_OUT);
    expect(accuracy).toBeGreaterThanOrEqual(0.95);
    for (const cls of ['unsubscribe', 'decline'] as const) {
      const row = byClass.get(cls)!;
      expect(row.n).toBeGreaterThan(0);
      expect(row.ok, cls).toBe(row.n);
    }
  });
});

describe('classifyReply', () => {
  const now = CORPUS_NOW;
  it('maps every v1 signal to a class', () => {
    expect(classOfSignal('reply_positive')).toBe('interested');
    expect(classOfSignal('reschedule')).toBe('scheduling');
    expect(classOfSignal('intro_offer')).toBe('referral');
    expect(classOfSignal('reply_neutral')).toBe('other');
  });

  it('returns the extraction with the class', () => {
    const r = classifyReply('Could we do Thursday at 2pm PT?', { now, timeZone: CORPUS_TZ });
    expect(r.class).toBe('scheduling');
    expect(r.proposedTimes.length).toBe(1);
    const nn = classifyReply('Slammed until the holidays. Ping me in January?', { now, timeZone: CORPUS_TZ });
    expect(nn.class).toBe('not_now');
    expect(nn.followUpAfter).toBe('2027-01-01');
    const obj = classifyReply('We already use Gong. How is this different?', { now });
    expect(obj).toMatchObject({ class: 'objection', question: 'How is this different?', confidence: 0.8 });
    const ooo = classifyReply("I'm out of the office until October 20 with limited access to email.", {
      now,
    });
    expect(ooo.class).toBe('out_of_office');
    expect(ooo.returnDate).toBe('2026-10-20');
  });

  it('reads an unsubscribe anywhere in the reply, but not a friendly "don\'t hesitate"', () => {
    expect(classifyReply('Thanks for the note.\n\nPlease remove me from your list.', { now }).class).toBe(
      'unsubscribe',
    );
    expect(
      classifyReply("Happy to help. Don't hesitate to email me again if anything comes up!", { now }).class,
    ).not.toBe('unsubscribe');
    expect(classifyReply('Stop emailing me.', { now, direction: 'outbound' }).class).not.toBe('unsubscribe');
  });

  it('strips quoted history before reading', () => {
    const r = classifyReply(
      'Sounds good, talk then!\n\nOn Mon, Oct 5, 2026 at 9:00 AM Alex wrote:\n> Please remove me',
      {
        now,
      },
    );
    expect(r.class).not.toBe('unsubscribe');
  });
});
