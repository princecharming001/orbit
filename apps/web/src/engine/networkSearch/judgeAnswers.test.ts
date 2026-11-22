/**
 * The judge reads a dozen of the student's people against a search's criteria. Its answers come back as a list, and
 * each must be put on the right person and the right question. The model is asked for the labels it was given (P3,
 * Q1); it often writes the person's name and the question's words instead. Every answer was thrown away then, so a
 * criterion was never applied to anyone in the student's own network: all read "likely".
 */
import type { PersonDoc } from '@orbit/core/search';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wipeDatabase } from '../../db/schema';

const llm = vi.hoisted(() => ({ judge: vi.fn() }));
vi.mock('../../integrations/anthropic', async (orig) => ({
  ...(await orig<typeof import('../../integrations/anthropic')>()),
  claudeReachable: () => true,
  llmSearchJudge: llm.judge,
}));

import { itemSaid, type JudgeItem, judge, questionSaid } from './judge';

const doc = (id: string, name: string, headline: string): PersonDoc =>
  ({
    id,
    name,
    headline,
    roles: [],
    schools: [],
    facets: [],
    known: { current: false, place: false, schools: false, pastJobs: false },
    text: {
      headline,
      title: '',
      org: '',
      location: '',
      tags: '',
      notes: '',
      summary: '',
      topics: '',
      jobs: '',
    },
    tags: [],
  }) as unknown as PersonDoc;

const Q1 = { key: 'criterion:0', text: 'Works at a venture capital firm' };
const Q2 = { key: 'criterion:1', text: 'Invests at seed stage' };
const items: JudgeItem[] = [
  { doc: doc('a', 'Ada Quist', 'Partner at Greywater Capital, a venture capital firm'), questions: [Q1, Q2] },
  { doc: doc('b', 'Bo Lindqvist', 'Engineer at Stripe'), questions: [Q1, Q2] },
  { doc: doc('c', 'Ada Quist', 'Designer'), questions: [Q1] },
];

beforeEach(async () => {
  await wipeDatabase();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('which person and which question an answer is about', () => {
  const labels = new Map([
    [Q1.text, 'Q1'],
    [Q2.text, 'Q2'],
  ]);

  it('the label first: P2, p 2, 2', () => {
    expect(itemSaid(items, 'P2')?.doc.id).toBe('b');
    expect(itemSaid(items, ' p 2 ')?.doc.id).toBe('b');
    expect(itemSaid(items, '2')?.doc.id).toBe('b');
    expect(itemSaid(items, 'P3: Ada Quist')?.doc.id).toBe('c');
    expect(itemSaid(items, 'P9')).toBeUndefined();
  });

  it('a name, when it is one person’s and nobody else’s', () => {
    expect(itemSaid(items, 'Bo Lindqvist')?.doc.id).toBe('b');
    expect(itemSaid(items, 'bo  lindqvist')?.doc.id).toBe('b');
    // two people share it: not guessed
    expect(itemSaid(items, 'Ada Quist')).toBeUndefined();
    expect(itemSaid(items, 'Somebody Else')).toBeUndefined();
    expect(itemSaid(items, '')).toBeUndefined();
  });

  it('a question by its label, by its own words, or as the only one asked', () => {
    expect(questionSaid([Q1, Q2], labels, 'Q2')).toBe(Q2);
    expect(questionSaid([Q1, Q2], labels, 'q1')).toBe(Q1);
    expect(questionSaid([Q1, Q2], labels, 'Q2: Invests at seed stage')).toBe(Q2);
    expect(questionSaid([Q1, Q2], labels, 'Invests at seed stage')).toBe(Q2);
    expect(questionSaid([Q1, Q2], labels, 'works at a venture capital firm.')).toBe(Q1);
    expect(questionSaid([Q1], labels, 'something else entirely')).toBe(Q1);
    expect(questionSaid([Q1, Q2], labels, 'something else entirely')).toBeUndefined();
  });
});

describe('the judge keeps the answers it is given', () => {
  it('an answer that names people and questions by their own words is kept, each on its own person', async () => {
    llm.judge.mockResolvedValue({
      people: [
        {
          person: 'Bo Lindqvist',
          answers: [
            { question: 'Works at a venture capital firm', answer: 'no', quote: 'Engineer at Stripe' },
            { question: 'Invests at seed stage', answer: 'unknown', quote: null },
          ],
        },
        {
          person: 'P1',
          answers: [{ question: 'Q1', answer: 'yes', quote: 'Partner at Greywater Capital' }],
        },
      ],
    });
    const out = await judge('u1', 'investors', items.slice(0, 2));
    expect(out.failed).toBe(0);
    expect(out.judged).toBe(2);
    expect(out.answers.get('a')!.get('criterion:0')).toEqual({
      answer: 'yes',
      quote: 'Partner at Greywater Capital',
    });
    expect(out.answers.get('b')!.get('criterion:0')).toEqual({ answer: 'no', quote: 'Engineer at Stripe' });
    expect(out.answers.get('b')!.get('criterion:1')).toEqual({ answer: 'unknown' });
  });

  it('the model is told to use the labels, and each block carries one', async () => {
    llm.judge.mockResolvedValue({ people: [] });
    await judge('u1', 'investors', items.slice(0, 2));
    const [system, build] = llm.judge.mock.calls[0]! as [
      string,
      (w: (tag: string, text: string) => string) => string,
    ];
    expect(system).toContain('name each person by the label of their block (P1, P2, ...)');
    const user = build((tag, text) => `<${tag}>${text}</${tag}>`);
    expect(user).toContain('Q1: Works at a venture capital firm');
    expect(user).toContain('P1 (answer Q1, Q2):');
    expect(user).toContain('P2 (answer Q1, Q2):');
  });

  it('someone the answer leaves out counts as not judged, and nobody else’s answer is put on them', async () => {
    llm.judge.mockResolvedValue({
      people: [{ person: 'P1', answers: [{ question: 'Q1', answer: 'likely', quote: null }] }],
    });
    const out = await judge('u1', 'investors', items.slice(0, 2));
    expect(out.failed).toBe(1);
    expect(out.answers.has('b')).toBe(false);
    expect(out.answers.get('a')!.get('criterion:0')).toEqual({ answer: 'likely' });
  });
});
