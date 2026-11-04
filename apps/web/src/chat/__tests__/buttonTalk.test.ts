import { describe, expect, it } from 'vitest';
import { isButtonTalk, sentenceGate, withoutButtonTalk } from '../agent/buttonTalk';

describe('words about the buttons are never shown', () => {
  it('drops the sentences that only point at the buttons', () => {
    for (const s of [
      'The options are below.',
      'The buttons are below.',
      "I can't post anything after those buttons, they end the reply.",
      "I've put up two quick options: answer Daniel, or look over the four replies waiting for your tap.",
    ])
      expect(isButtonTalk(s)).toBe(true);
  });

  it('keeps sentences that use the same words about something else', () => {
    for (const s of [
      'You have two options: apply now or wait for the referral.',
      'Lena works on the buttons team at Stripe, so ask her about design systems.',
      'Maya is your strongest tie there.',
      'Your recent drafts score 2.6 out of 3.',
    ])
      expect(isButtonTalk(s)).toBe(false);
  });

  it('keeps everything else exactly as written', () => {
    expect(withoutButtonTalk('Chloe asked to stop, so nothing goes to her. The options are below.')).toBe(
      'Chloe asked to stop, so nothing goes to her. ',
    );
    expect(withoutButtonTalk('Dr. Kim replied.\n\nShe can meet Thursday at 2.')).toBe(
      'Dr. Kim replied.\n\nShe can meet Thursday at 2.',
    );
  });

  it('streams a sentence at a time and holds back the button line', () => {
    const out: string[] = [];
    const gate = sentenceGate((t) => out.push(t));
    for (const d of ['Chloe asked ', 'to stop. The opt', 'ions are below. Daniel', ' needs you'])
      gate.push(d);
    expect(out.join('')).toBe('Chloe asked to stop. ');
    gate.flush();
    expect(out.join('')).toBe('Chloe asked to stop. Daniel needs you');
  });
});
