import { describe, expect, it } from 'vitest';
import { buildFactsIndex, type CompanyFact, listedFounder } from '../search/companies';
import { buildPersonDoc } from '../search/doc';
import { buildPlaceIndex } from '../search/places';
import { PLACES_DATA } from '../search/places.data';
import type { SearchContext } from '../search/predicates';
import { quotesOnly, runSpec } from '../search/run';
import { buildSchoolIndex } from '../search/schools';
import type { QuerySpec } from '../search/spec';
import { parseYcFounders } from '../search/ycoss';

const page = (founders: unknown) =>
  `<div id="ycdc" data-page="${JSON.stringify({ component: 'Company', props: { company: { founders } } })
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')}"></div>`;

describe('YC founder lists', () => {
  it('reads the founders a YC company page embeds, with titles and who has left', () => {
    expect(
      parseYcFounders(
        page([
          { full_name: 'Alex Mehregan', title: 'Founder/CTO', is_active: true },
          { full_name: 'Sam O’Neil', title: 'CEO & Co', is_active: false },
          { full_name: '', title: 'x' },
        ]),
      ),
    ).toEqual([
      { name: 'Alex Mehregan', title: 'Founder/CTO' },
      { name: 'Sam O’Neil', title: 'CEO & Co', active: false },
    ]);
  });

  it('leaves the old list alone when the page has no data (a changed page or a block page)', () => {
    expect(parseYcFounders('<html>Just a moment...</html>')).toBeUndefined();
    expect(parseYcFounders('<div data-page="{not json"></div>')).toBeUndefined();
    expect(parseYcFounders(page(undefined))).toBeUndefined();
    expect(parseYcFounders(page([]))).toEqual([]);
  });

  it('matches the person by last name and the same or a short first name, never by first name alone', () => {
    const fact = {
      founders: [{ name: 'Alexander Mehregan', title: 'Founder/CTO' }, { name: 'Dr. Jo Park' }],
    };
    expect(listedFounder('Alex Mehregan', fact)?.title).toBe('Founder/CTO');
    expect(listedFounder('alex mehregan (he/him)', fact)).toBeTruthy();
    expect(listedFounder('Jo Park', fact)).toBeTruthy();
    expect(listedFounder('Alex Smith', fact)).toBeUndefined();
    expect(listedFounder('Al Mehregan', fact)).toBeUndefined();
    expect(listedFounder('Mehregan', fact)).toBeUndefined();
    expect(listedFounder('Alex Mehregan', {})).toBeUndefined();
  });
});

describe('YC founders search', () => {
  const places = buildPlaceIndex(PLACES_DATA);
  const schools = buildSchoolIndex([]);
  const opalite: CompanyFact = {
    key: 'opalite health',
    name: 'Opalite Health',
    source: 'yc',
    ycBatch: 'W26',
    teamSize: 3,
  };
  const ctxWith = (facts: CompanyFact[]): SearchContext => ({
    facts: buildFactsIndex(facts),
    places,
    schools,
    rel: () => undefined,
    channels: {
      email: { connected: true },
      meeting: { connected: true },
      text: { connected: false },
      linkedin: { connected: true },
    },
    mySchools: [],
    now: Date.parse('2026-11-08'),
  });
  const alex = buildPersonDoc(
    {
      id: 'alex',
      displayName: 'Alex Mehregan',
      headline: 'CTO at Opalite Health (YC W26) | Helping healthcare providers speak any language',
      currentTitle: 'CTO',
      currentOrganizationRaw: 'Opalite Health (YC W26)',
      tags: [],
    },
    [],
    { isSchool: (t) => schools.lookup(t), places },
  );
  const spec: QuerySpec = {
    ask: 'find me yc founders in my network',
    positions: [{ role: { founder: true }, company: { yc: { any: true } }, when: 'ever' }],
  };

  it('a CTO at a YC company is a likely founder from the title alone', () => {
    expect(runSpec(spec, [alex], ctxWith([opalite])).rows[0]!.band).toBe('likely');
  });

  it("YC's page naming them as a founder makes it a strong match, and says so", () => {
    const row = runSpec(
      spec,
      [alex],
      ctxWith([{ ...opalite, founders: [{ name: 'Alex Mehregan', title: 'Founder/CTO' }] }]),
    ).rows[0]!;
    expect(row.band).toBe('strong');
    expect(row.checks[0]!.evidence).toContain('YC lists Alex as Founder/CTO');
  });

  it('the judge cannot turn a likely founder into a no by quoting the same title Orbit already weighed', () => {
    const judged = new Map([
      ['alex', new Map([['position:0', { answer: 'no' as const, quote: 'CTO at Opalite Health' }]])],
    ]);
    expect(runSpec(spec, [alex], ctxWith([opalite]), { judged }).rows[0]!.band).toBe('likely');
    // a no resting on words Orbit had not weighed still lands
    const other = new Map([
      ['alex', new Map([['position:0', { answer: 'no' as const, quote: 'joined as the first engineer' }]])],
    ]);
    expect(runSpec(spec, [alex], ctxWith([opalite]), { judged: other }).counts.no).toBe(1);
  });

  it('quotesOnly ignores case, curly quotes and spacing', () => {
    expect(quotesOnly('CTO at Opalite Health (YC W26)', '“cto  at opalite”')).toBe(true);
    expect(quotesOnly('CTO at Opalite Health', 'hired as CTO')).toBe(false);
    expect(quotesOnly(undefined, 'x')).toBe(false);
  });
});
