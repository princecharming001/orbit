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

import {
  itemSaid,
  type JudgeItem,
  judge,
  questionSaid,
  SCREEN_BATCH,
  SCREEN_MAX,
  screen,
  screenLine,
} from './judge';

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
    // a likely to one of the student's own criteria with no words behind it is not an answer
    expect(out.answers.get('a')!.get('criterion:0')).toEqual({ answer: 'unknown' });
  });

  it('a likely to a criterion stands only on words from the person’s own text', async () => {
    llm.judge.mockResolvedValue({
      people: [
        {
          person: 'P1',
          answers: [
            { question: 'Q1', answer: 'likely', quote: 'Greywater Capital' },
            { question: 'Q2', answer: 'likely', quote: 'a seed fund everyone knows' },
          ],
        },
      ],
    });
    const out = await judge('u1', 'investors', items.slice(0, 1));
    expect(out.answers.get('a')!.get('criterion:0')).toEqual({
      answer: 'likely',
      quote: 'Greywater Capital',
    });
    // words that are not in their text: no thumb
    expect(out.answers.get('a')!.get('criterion:1')).toEqual({ answer: 'unknown' });
  });

  it('a filter the reader is asked about keeps its likely without words (the rules already pointed that way)', async () => {
    llm.judge.mockResolvedValue({
      people: [{ person: 'P1', answers: [{ question: 'Q1', answer: 'likely', quote: null }] }],
    });
    const out = await judge('u1', 'investors', [
      { doc: items[0]!.doc, questions: [{ key: 'position:0', text: 'investor or investing' }] },
    ]);
    expect(out.answers.get('a')!.get('position:0')).toEqual({ answer: 'likely' });
  });

  it('who someone is may be read from their name, as a likely that quotes the name, and nothing else may', async () => {
    llm.judge.mockResolvedValue({
      people: [
        {
          person: 'P1',
          answers: [
            { question: 'Q1', answer: 'likely', quote: 'Ada Quist' },
            { question: 'Q2', answer: 'yes', quote: 'she/her' },
          ],
        },
      ],
    });
    const who = [
      { key: 'criterion:0', text: 'Is a woman' },
      { key: 'criterion:1', text: 'Has a Danish name' },
    ];
    const out = await judge('u1', 'danish women', [{ doc: items[0]!.doc, questions: who }]);
    // the name is in what the reader was given, so a likely resting on it stands
    expect(out.answers.get('a')!.get('criterion:0')).toEqual({ answer: 'likely', quote: 'Ada Quist' });
    // words that are not in their text do not make a yes
    expect(out.answers.get('a')!.get('criterion:1')).toEqual({ answer: 'unknown' });
    const system = llm.judge.mock.calls[0]![0] as string;
    expect(system).toMatch(/answer likely, never yes, and quote the name exactly as it is written/);
    expect(system).toMatch(/A name answers nothing else/);
    expect(system).toMatch(/never guess someone's work, employer, school or place from a name/);
  });

  it('the reader is told a founder says nothing of what the company is worth, and how a known company may count', async () => {
    llm.judge.mockResolvedValue({ people: [] });
    await judge('u1', 'unicorn founders', items.slice(0, 1));
    const system = llm.judge.mock.calls[0]![0] as string;
    expect(system).toMatch(/only when every part holds/);
    expect(system).toMatch(/Being a founder says nothing about what the company is worth/);
    expect(system).toMatch(/answer likely, never yes, and quote the company's name/);
    expect(system).toMatch(/A company you do not recognise is unknown/);
  });
});

describe('the first pass over a long list', () => {
  const many = Array.from({ length: SCREEN_BATCH + 5 }, (_, i) =>
    doc(`p${i}`, `Person ${i}`, i === 3 ? 'Co-founder at PostHog' : `Founder at Tiny Co ${i}`),
  );
  const said = (call: unknown[]) =>
    (call[1] as (w: (tag: string, t: string) => string) => string)((_t, t) => t);

  it('one line a person: their name, then their work', () => {
    const d = {
      ...doc('a', 'Ada Quist', 'Building things'),
      roles: [
        { title: 'Co-founder', org: 'PostHog', current: true },
        { title: 'Engineer', org: 'Arachnys', current: false },
      ],
    } as unknown as PersonDoc;
    const line = screenLine(d);
    expect(line).toBe(
      'name: Ada Quist | Co-founder at PostHog | before: Engineer at Arachnys | says: Building things',
    );
  });

  it('everyone is looked at, a batch a call; only the people picked go on', async () => {
    llm.judge.mockImplementation(async (_s: string, build: unknown) => {
      const text = (build as (w: (tag: string, t: string) => string) => string)((_t, t) => t);
      return { keep: text.includes('P4: name: Person 3 | says: Co-founder at PostHog') ? ['P4'] : [] };
    });
    const kept = await screen(
      'u1',
      'unicorn founders',
      ['Founded a company valued at over $1 billion'],
      many,
    );
    expect(llm.judge).toHaveBeenCalledTimes(2);
    expect([...kept!.keep]).toEqual(['p3']);
    expect(kept!.looked.size).toBe(many.length);
    const first = said(llm.judge.mock.calls[0]!);
    expect(first).toContain('- Founded a company valued at over $1 billion');
    expect(first).toContain(`P${SCREEN_BATCH}: `);
    // a name is there for "who someone is" only, and the pass is told so
    expect(llm.judge.mock.calls[0]![0]).toMatch(/A name says nothing about anyone's work/);
    expect(llm.judge.mock.calls[0]![0]).toMatch(
      /pick the people whose first and last name plainly point that way/,
    );
    expect(llm.judge.mock.calls[0]![0]).toMatch(
      /A company you do not recognise is not a reason to pick someone/,
    );
  });

  it('the same people and the same criteria are not looked at twice; new criteria are', async () => {
    llm.judge.mockResolvedValue({ keep: ['P4'] });
    const few = many.slice(0, 10);
    expect([...(await screen('u1', 'x', ['Runs a robotics company'], few))!.keep]).toEqual(['p3']);
    expect([...(await screen('u1', 'x', ['Runs a robotics company'], few))!.keep]).toEqual(['p3']);
    expect(llm.judge).toHaveBeenCalledTimes(1);
    await screen('u1', 'x', ['Works on batteries'], few);
    expect(llm.judge).toHaveBeenCalledTimes(2);
  });

  it('a pass that could not be made says so, so nobody is left out on it', async () => {
    llm.judge.mockResolvedValue(undefined);
    expect(await screen('u1', 'x', ['Runs a robotics company'], many.slice(0, 5))).toBeUndefined();
    llm.judge.mockRejectedValue(new Error('down'));
    expect(await screen('u1', 'x', ['Works on batteries'], many.slice(0, 5))).toBeUndefined();
  });

  it('a call that failed looked at nobody: those people are not answered for, the others are', async () => {
    llm.judge.mockResolvedValueOnce({ keep: [] }).mockResolvedValueOnce(undefined);
    const pass = await screen('u1', 'x', ['Runs a robotics company'], many);
    expect(pass!.looked.size).toBe(SCREEN_BATCH);
    expect(pass!.looked.has(`p${SCREEN_BATCH}`)).toBe(false);
    // asked again, only the people it did not reach are looked at
    llm.judge.mockResolvedValue({ keep: ['P1'] });
    const again = await screen('u1', 'x', ['Runs a robotics company'], many);
    expect(llm.judge).toHaveBeenCalledTimes(3);
    expect(again!.looked.size).toBe(many.length);
    expect([...again!.keep]).toEqual([`p${SCREEN_BATCH}`]);
  });

  it('at most so many people are looked at anew in one search; the next search carries on from there', async () => {
    const crowd = Array.from({ length: SCREEN_MAX + 30 }, (_, i) =>
      doc(`c${i}`, `Crowd ${i}`, `Founder ${i}`),
    );
    llm.judge.mockResolvedValue({ keep: [] });
    const first = await screen('u1', 'x', ['Is a woman'], crowd);
    expect(first!.looked.size).toBe(SCREEN_MAX);
    expect(llm.judge).toHaveBeenCalledTimes(SCREEN_MAX / SCREEN_BATCH);
    const second = await screen('u1', 'x', ['Is a woman'], crowd);
    expect(second!.looked.size).toBe(crowd.length);
    expect(llm.judge).toHaveBeenCalledTimes(SCREEN_MAX / SCREEN_BATCH + 1);
  });

  it('nothing to ask picks nobody and asks nothing', async () => {
    expect((await screen('u1', 'x', [], many.slice(0, 5)))!.keep.size).toBe(0);
    expect(llm.judge).not.toHaveBeenCalled();
  });
});
