import { describe, expect, it } from 'vitest';
import { ANSWER_MIN_CHARS, answerStarted, currentStep, WORKING_WORDS } from './Thread';
import type { Block } from './threadStore';

const tool = (over: Partial<Extract<Block, { type: 'tool' }>> = {}): Block =>
  ({
    type: 'tool',
    toolUseId: 'tu',
    toolName: 'find_people',
    status: 'running',
    progress: 'Looking at Stripe',
    ...over,
  }) as Block;
const text = (t: string): Block => ({ type: 'text', text: t }) as Block;

describe('a working turn reads as one status line until the answer starts', () => {
  it('holds back a lead-in and the cards while a step runs', () => {
    expect(answerStarted([])).toBe(false);
    expect(answerStarted([text('One sec, pulling up Daniel.')])).toBe(false);
    expect(answerStarted([text('One sec.'), tool()])).toBe(false);
    expect(
      answerStarted([tool({ status: 'done', envelope: { kind: 'list', data: {}, summary: 'x' } as never })]),
    ).toBe(false);
  });

  it('starts once the words after the last step are more than a lead-in', () => {
    const answer = 'a'.repeat(ANSWER_MIN_CHARS);
    expect(answerStarted([tool({ status: 'done' }), text(answer)])).toBe(true);
    expect(answerStarted([tool({ status: 'done' }), text(answer.slice(1))])).toBe(false);
  });

  it('never holds back a card that waits on the student', () => {
    expect(answerStarted([tool({ status: 'pending', toolName: 'send_message' })])).toBe(true);
  });

  it('names the step under way, then the last step done', () => {
    expect(currentStep([tool()])).toBe('Looking at Stripe');
    expect(
      currentStep([
        { type: 'web', id: 'w', query: 'Stripe interns', sources: [], status: 'searching' } as Block,
      ]),
    ).toBe('Searching the web for Stripe interns');
    expect(
      currentStep([
        tool({
          status: 'done',
          envelope: { kind: 'list', data: {}, summary: '3 people at Stripe.' } as never,
        }),
      ]),
    ).toBe('3 people at Stripe.');
    expect(currentStep([text('hi')])).toBe('');
    expect(WORKING_WORDS.length).toBeGreaterThan(8);
  });
});
