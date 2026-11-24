/**
 * "unicorn founders" over a network with far more founders than one search reads closely. The table used to answer
 * with sixty founders nobody had read, each with a pale thumbs up under "Founded a company valued at over $1
 * billion": the reader got through eighty, confirmed none, and the unread ones (still "likely" by default) were
 * listed above them. Now everyone is looked at in a first pass, the close read goes to the ones with a reason, and
 * nobody is listed on a check nobody made.
 */
import type { Person } from '@orbit/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../../db/schema';

const llm = vi.hoisted(() => ({ judge: vi.fn() }));
vi.mock('../../integrations/anthropic', async (orig) => ({
  ...(await orig<typeof import('../../integrations/anthropic')>()),
  claudeReachable: () => true,
  llmSearchJudge: llm.judge,
}));

import { EMPTY_FILTERS, newCriterion, runPeopleSearch, type SearchForm } from '../peopleSearch';

const USER = { id: 'u_first_pass', school: 'University of California, Berkeley' };
const FOUNDERS = 200;
const CRITERION = 'Founded a company valued at over $1 billion';

beforeAll(async () => {
  await wipeDatabase();
  const at = '2026-11-20T12:00:00.000Z';
  const person = (id: string, name: string, headline: string, title: string, org: string, strength: number) =>
    ({
      id,
      userId: USER.id,
      displayName: name,
      firstName: name.split(' ')[0],
      lastName: name.split(' ')[1],
      nameNormalized: name.toLowerCase(),
      emails: [],
      relationshipType: 'unknown',
      strength,
      interactionCount: 0,
      sources: ['linkedin'],
      isHuman: true,
      tags: [],
      createdAt: at,
      updatedAt: at,
      headline,
      currentTitle: title,
      currentOrganizationRaw: org,
    }) as unknown as Person;
  const rows: Person[] = [];
  // founders of small companies, the closest people the student has
  for (let i = 0; i < FOUNDERS; i++)
    rows.push(
      person(`f${i}`, `Founder Number${i}`, `Founder @ Tiny Co ${i}`, 'Founder', `Tiny Co ${i}`, 0.9),
    );
  // the one real answer, a faint tie far down the list
  rows.push(person('hog', 'James Far', 'cofounder at posthog', 'Co-founder', 'PostHog', 0.05));
  // works at a famous company, did not found it
  rows.push(person('emp', 'Nia Staff', 'Head of Talent @ Whop', 'Head of Talent', 'Whop', 0.95));
  await db.people.bulkPut(rows);
});
afterEach(() => vi.clearAllMocks());

const text = (call: unknown[]) =>
  (call[1] as (w: (tag: string, t: string) => string) => string)((_t, t) => t);
const isPass = (call: unknown[]) => (call[0] as string).startsWith('You make a first pass');

/** A model that knows PostHog and nothing else. */
function model(opts: { passFails?: boolean } = {}) {
  llm.judge.mockImplementation(async (system: string, build: unknown) => {
    const said = text([system, build]);
    if (system.startsWith('You make a first pass')) {
      if (opts.passFails) return undefined;
      const keep = said
        .split('\n')
        .filter((l) => /posthog/i.test(l))
        .map((l) => l.slice(0, l.indexOf(':')));
      return { keep };
    }
    // the close read: a block per person, P1..Pn
    const blocks = said.split(/\n(?=P\d+ \(answer )/).filter((b) => /^P\d+ \(answer /.test(b));
    return {
      people: blocks.map((b) => {
        const label = /^P\d+/.exec(b)![0];
        const hog = /posthog/i.test(b);
        return {
          person: label,
          answers: [
            hog
              ? { question: 'Q1', answer: 'likely', quote: 'posthog' }
              : { question: 'Q1', answer: 'unknown', quote: null },
          ],
        };
      }),
    };
  });
}

const form = (): SearchForm => ({
  ask: 'unicorn founders',
  filters: { ...EMPTY_FILTERS, titles: ['founder'], reach: 'mine' },
  criteria: [newCriterion(CRITERION, 'must')],
});

describe('a criterion over more people than one search reads', () => {
  it('everyone is looked at, only the one with a reason is read closely, and only they are listed', async () => {
    model();
    const r = await runPeopleSearch(USER, form());
    expect(r.rows.map((x) => x.name)).toEqual(['James Far']);
    expect(r.rows[0]!.checks[0]).toMatchObject({ answer: 'likely', evidence: '"posthog"' });
    // a likely is never a full match
    expect(r.rows[0]!.match).toBeLessThanOrEqual(85);
    // someone who only works at a famous company is not a founder: never in the running
    expect(r.rows.some((x) => x.name === 'Nia Staff')).toBe(false);
    const calls = llm.judge.mock.calls;
    const passes = calls.filter(isPass);
    const reads = calls.filter((c) => !isPass(c));
    // two hundred and one founders in two calls, then one close read of one person
    expect(passes).toHaveLength(2);
    expect(reads).toHaveLength(1);
    expect(text(reads[0]!)).toContain('cofounder at posthog');
    expect(text(reads[0]!)).not.toContain('Tiny Co');
    // the first pass sees each name, and is told what a name may and may not answer
    expect(passes.map(text).join('\n')).toContain('name: James Far | Co-founder at PostHog');
    expect(passes[0]![0]).toMatch(/A name says nothing about anyone's work/);
    expect(r.notes).toEqual([
      `${FOUNDERS} more of your people pass the filters, but nothing Orbit has on them says "${CRITERION}". Make it a nice to have to list them too.`,
    ]);
    expect(r.unchecked).toBe(false);
  });

  it('the same search again asks the model nothing: the pass and the read are both remembered', async () => {
    model();
    const r = await runPeopleSearch(USER, form());
    expect(r.rows.map((x) => x.name)).toEqual(['James Far']);
    expect(llm.judge).not.toHaveBeenCalled();
  });

  it('a first pass that could not be made: nobody unread is listed, and the table says how many were not read', async () => {
    await db.searchCache.clear();
    model({ passFails: true });
    const r = await runPeopleSearch(USER, form());
    // the close read took the first eighty in the order shown (the small founders), and confirmed none
    expect(r.rows).toEqual([]);
    expect(r.rows.every((x) => x.checks.every((c) => c.answer !== 'likely' && c.answer !== 'yes'))).toBe(
      true,
    );
    expect(r.notes).toEqual([
      `80 of your people pass the filters, but nothing Orbit has on them says "${CRITERION}". Make it a nice to have to list them.`,
      `Orbit has read 80 of ${FOUNDERS + 1} people who pass the filters against "${CRITERION}" so far. Search again to read more.`,
    ]);
  });

  it('as a nice to have, everyone who passes the filters is listed and the unread say "Not checked yet"', async () => {
    await db.searchCache.clear();
    model();
    const f = form();
    const r = await runPeopleSearch(USER, { ...f, criteria: [newCriterion(CRITERION, 'nice')] });
    expect(r.rows.length).toBeGreaterThan(1);
    // no first pass for a nice to have: it leaves nobody out
    expect(llm.judge.mock.calls.filter(isPass)).toHaveLength(0);
    const answers = r.rows.flatMap((x) => x.checks);
    expect(answers.some((c) => c.answer === 'likely' && c.evidence === 'not checked yet')).toBe(false);
    for (const c of answers) if (c.evidence === 'Not checked yet') expect(c.answer).toBe('unknown');
  });
});
