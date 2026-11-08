import type { Person } from '@orbit/core';
import { buildFactsIndex, buildPersonDoc, type RunResult } from '@orbit/core/search';
import { describe, expect, it } from 'vitest';
import type { SearchWorld } from './docs';
import { readingHelps, toRead } from './index';
import { personText } from './judge';

/** Plan 33 in the browser: when a search reads profiles, whom it reads, and what the judge then sees. */

const doc = (id: string, headline: string, profile?: Parameters<typeof buildPersonDoc>[5]) =>
  buildPersonDoc({ id, displayName: id, headline, tags: [] }, [], {}, [], undefined, profile);

describe('reading at ask time', () => {
  it('reads only for what a headline rarely says', () => {
    expect(
      readingHelps({
        ask: 'YC founders',
        positions: [{ role: { founder: true }, company: { yc: { any: true } } }],
      }),
    ).toBe(false);
    expect(
      readingHelps({
        ask: 'seed founders',
        positions: [{ role: { founder: true }, company: { stages: ['seed'] } }],
      }),
    ).toBe(true);
    expect(
      readingHelps({ ask: 'ex-Google', positions: [{ company: { names: ['Google'] }, when: 'past' }] }),
    ).toBe(true);
    expect(readingHelps({ ask: 'works on AI agents', criteria: [{ text: 'works on AI agents' }] })).toBe(
      true,
    );
  });

  it('picks listed people with an open check, unread, with a LinkedIn id, best first', () => {
    const a = doc('a', 'Founder @ Lumen');
    const b = doc('b', 'Founder @ Kite', { experience: [] });
    const c = doc('c', 'Founder @ Nova');
    const people = new Map<string, Person>([
      ['a', { id: 'a', linkedinMemberId: 'ACoA' } as Person],
      ['b', { id: 'b', linkedinMemberId: 'ACoB' } as Person],
      ['c', { id: 'c' } as Person],
    ]);
    const world = { docs: [a, b, c], people } as unknown as SearchWorld;
    const check = (answer: 'likely' | 'yes', estimated = false) => ({
      key: 'position:0',
      label: 'seed stage founder',
      need: 'must' as const,
      answer,
      estimated,
    });
    const result = {
      rows: [
        { id: 'a', band: 'likely', checks: [check('likely', true)] },
        { id: 'b', band: 'likely', checks: [check('likely')] },
        { id: 'c', band: 'likely', checks: [check('likely')] },
      ],
    } as unknown as RunResult;
    // b was read already, c has no LinkedIn id
    expect(toRead(result, world)).toEqual(['a']);
  });

  it('the judge reads the About, job notes, focus and the company page', () => {
    const facts = buildFactsIndex([
      {
        key: 'lumen',
        name: 'Lumen',
        linkedinId: '555',
        teamSize: 9,
        foundedYear: 2025,
        about: 'Lumen builds AI agents for insurance claims.',
        source: 'linkedin',
      },
    ]);
    const d = doc('d', 'Building something new', {
      about: 'Ex-Stripe. Now building.',
      experience: [
        {
          title: 'Founder',
          company: 'Lumen',
          companyId: '555',
          current: true,
          start: '2025-01',
          description: 'Shipping our first agents.',
        },
      ],
      reading: {
        focus: [{ value: 'insurance AI', quote: 'agents for insurance' }],
        signals: [{ value: 'hiring', quote: "we're hiring" }],
      },
    });
    const text = personText(d, facts);
    expect(text).toContain('Role (now): Founder at Lumen (2025-now)');
    expect(text).toContain(
      'Company Lumen: 9 people on LinkedIn; founded 2025. About: Lumen builds AI agents',
    );
    expect(text).toContain('About: Ex-Stripe. Now building.');
    expect(text).toContain('What they wrote under their jobs: Shipping our first agents.');
    expect(text).toContain('Works on: insurance AI');
    expect(text).toContain('Says they are: hiring');
  });
});
