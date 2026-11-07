import { describe, expect, it } from 'vitest';
import { buildFactsIndex } from '../search/companies';
import { buildPersonDoc, type DocPerson } from '../search/doc';
import { lintSpec } from '../search/lint';
import { buildPlaceIndex } from '../search/places';
import { PLACES_DATA } from '../search/places.data';
import type { RelInfo, SearchContext } from '../search/predicates';
import { relaxSteps, shouldRelax } from '../search/relax';
import { runSpec } from '../search/run';
import { buildSchoolIndex } from '../search/schools';
import type { QuerySpec } from '../search/spec';

const schools = buildSchoolIndex([
  { name: 'University of California, Berkeley', aliases: ['Cal', 'UC Berkeley', 'Berkeley'], kind: 1 },
  { name: 'Stanford University', aliases: ['Stanford'], kind: 1 },
]);
const places = buildPlaceIndex(PLACES_DATA);
const facts = buildFactsIndex([
  { key: 'knowlify', name: 'Knowlify', ycBatch: 'S25', teamSize: 6, industries: ['Education'], source: 'yc' },
  { key: 'weave', name: 'Weave', ycBatch: 'W25', teamSize: 12, source: 'yc' },
  { key: 'turnstone', name: 'Turnstone', ycBatch: 'W26', teamSize: 3, industries: ['Climate'], source: 'yc' },
]);
const rel = new Map<string, RelInfo>();
const ctx: SearchContext = {
  facts,
  places,
  schools,
  rel: (id) => rel.get(id),
  channels: {
    email: { connected: true },
    meeting: { connected: true },
    text: { connected: false },
    linkedin: { connected: false },
  },
  mySchools: ['University of California, Berkeley'],
  now: Date.parse('2026-11-07'),
};
let n = 0;
const person = (over: Partial<DocPerson>): DocPerson => ({
  id: `p${++n}`,
  displayName: `Person ${n}`,
  tags: [],
  ...over,
});
const doc = (over: Partial<DocPerson>) =>
  buildPersonDoc(person(over), [], { isSchool: (t) => schools.lookup(t), places });

const ritvik = doc({
  displayName: 'Ritvik',
  headline: 'Co-founder & CTO @ Knowlify (YC S25) | EECS @ UC Berkeley',
});
const mixed = doc({ displayName: 'Mixed', headline: 'Founder, Berkeley Blockchain | SWE @ Weave (YC W25)' });
const jai = doc({
  displayName: 'Jai',
  headline: 'Co-Founder @ Turnstone (YC W26)',
  location: 'San Francisco, California, United States',
});
const incoming = doc({ displayName: 'Incoming', headline: 'Incoming SWE @ Google | CS @ Stanford' });
const exGoogle = doc({ displayName: 'ExGoogle', headline: 'Founder @ Lumen | ex-Google' });
const blank = doc({ displayName: 'Blank', headline: 'Building something new' });
const founding = doc({ displayName: 'Founding', headline: 'Founding Engineer @ Knowlify (YC S25)' });
const docs = [ritvik, mixed, jai, incoming, exGoogle, blank, founding];
const run = (spec: Omit<QuerySpec, 'ask'>) => runSpec({ ask: 'test', ...spec }, docs, ctx);
const band = (r: ReturnType<typeof run>, id: string) => r.rows.find((x) => x.id === id)?.band ?? 'hidden';

describe('network search engine', () => {
  it('binds role to company: a club founder who is a YC engineer is not a YC founder', () => {
    const r = run({ positions: [{ role: { founder: true }, company: { yc: { any: true } }, when: 'ever' }] });
    expect(band(r, ritvik.id)).toBe('strong');
    expect(band(r, jai.id)).toBe('strong');
    expect(band(r, mixed.id)).toBe('hidden');
    expect(band(r, founding.id)).toBe('hidden');
  });
  it('filters by batch', () => {
    const r = run({
      positions: [{ role: { founder: true }, company: { yc: { batches: ['W26'] } }, when: 'ever' }],
    });
    expect(r.counts.strong).toBe(1);
    expect(r.rows[0]!.id).toBe(jai.id);
  });
  it('does not count an incoming job as a past one', () => {
    const r = run({ positions: [{ company: { names: ['Google'] }, when: 'past' }] });
    expect(band(r, exGoogle.id)).toBe('strong');
    expect(band(r, incoming.id)).not.toBe('strong');
  });
  it('treats a missing current job as unknown, not no', () => {
    const r = run({ positions: [{ company: { names: ['Stripe'] } }] });
    expect(r.rows.find((x) => x.id === blank.id)).toBeUndefined();
    expect(r.counts.uncheckedSilent).toBeGreaterThan(0);
    expect(r.counts.no).toBeGreaterThan(0);
  });
  it('marks a school match with a missing class year as partial', () => {
    const r = run({ schools: [{ names: ['Berkeley'], gradFrom: 2027, gradTo: 2027 }] });
    const row = r.rows.find((x) => x.id === ritvik.id)!;
    expect(row.band).toBe('unchecked');
    expect(row.partial).toBe(true);
    expect(row.checks[0]!.missing).toBe('class year');
  });
  it('reads places three ways', () => {
    const r = run({ places: [{ names: ['SF'] }] });
    expect(band(r, jai.id)).toBe('strong');
    expect(r.counts.uncheckedSilent).toBe(docs.length - 1);
  });
  it('uses the facts of a sure match for industry', () => {
    const r = run({ positions: [{ role: { founder: true }, company: { industries: ['climate'] } }] });
    expect(band(r, jai.id)).toBe('strong');
    expect(band(r, ritvik.id)).toBe('hidden');
  });
  it('orders warm people first when asked', () => {
    rel.set(jai.id, { band: 'close', touches: {}, tags: [] });
    const r = runSpec(
      {
        ask: 't',
        sort: 'warmth',
        positions: [{ role: { founder: true }, company: { yc: { any: true } }, when: 'ever' }],
      },
      docs,
      ctx,
    );
    expect(r.rows[0]!.id).toBe(jai.id);
    rel.clear();
  });
  it('relaxes only on real nos and never on named entities', () => {
    const r = run({ schools: [{ names: ['Stanford'], gradFrom: 2030, gradTo: 2030 }] });
    const steps = relaxSteps({ ask: 't', schools: [{ names: ['Stanford'], gradFrom: 2030, gradTo: 2030 }] });
    expect(steps[0]!.label).toBe('class year ±1');
    expect(steps[0]!.spec.schools![0]!.names).toEqual(['Stanford']);
    expect(typeof shouldRelax(r)).toBe('boolean');
  });
});

describe('lint', () => {
  it('folds founder said three ways into one check and drops a restating criterion', () => {
    const { spec, notes } = lintSpec({
      ask: 'yc founders',
      positions: [
        {
          role: { titles: ['founder'], families: ['founder' as never], seniority: ['founder' as never] },
          company: { yc: {} },
        },
      ],
      criteria: [{ text: 'is a founder of a YC company' }],
    });
    expect(spec.positions![0]!.role).toEqual({ founder: true });
    expect(spec.positions![0]!.when).toBe('ever');
    expect(spec.positions![0]!.company!.yc!.any).toBe(true);
    expect(spec.criteria).toBeUndefined();
    expect(notes.length).toBeGreaterThan(0);
  });
  it('maps "exec" to levels', () => {
    const { spec } = lintSpec({
      ask: 'execs at big tech',
      positions: [{ role: { seniority: ['exec' as never] }, company: { kinds: ['big_tech'] } }],
    });
    expect(spec.positions![0]!.role!.seniority).toEqual(['vp', 'c_level']);
  });
  it('refuses an empty spec', () => {
    expect(lintSpec({ ask: 'cool people' }).error).toBe('empty');
  });
  it('drops criteria in router mode', () => {
    const { spec } = lintSpec(
      {
        ask: 'x',
        positions: [{ role: { families: ['investing'] } }],
        criteria: [{ text: 'invests in climate' }],
      },
      { router: true },
    );
    expect(spec.criteria).toBeUndefined();
  });
});

// found running real asks over a 7,540-person network (plan 32 step 9)
describe('network search, real-network fixes', () => {
  it('reads a founder title and its YC company split into neighbouring parts', () => {
    const r = run({ positions: [{ role: { founder: true }, company: { yc: { any: true } }, when: 'ever' }] });
    const split = doc({ headline: 'Founder | Archal (YC S26)' });
    const dot = doc({ headline: 'Co-founder • Tuneloop (YC W25)' });
    const both = runSpec(
      { ask: 't', positions: [{ role: { founder: true }, company: { yc: { any: true } }, when: 'ever' }] },
      [split, dot],
      ctx,
    );
    expect(both.rows.map((x) => x.band)).toEqual(['strong', 'strong']);
    expect(r.counts.strong).toBeGreaterThan(0);
  });
  it('does not read a bare badge as a company, and gives it to the current job', () => {
    const ceo = doc({ headline: 'CEO at Kita | Underwrite anyone | Stanford HAI, ex-Apple, YC W26' });
    expect(ceo.roles.some((x) => /yc w26/i.test(x.org ?? ''))).toBe(false);
    const r = runSpec(
      { ask: 't', positions: [{ role: { founder: true }, company: { yc: { any: true } }, when: 'ever' }] },
      [ceo],
      ctx,
    );
    // a CEO of a YC company is likely a founder, not surely
    expect(r.rows[0]?.band).toBe('likely');
  });
  it('reads "<field> at <school>" as a school', () => {
    const d = doc({ headline: 'Economics & Engineering at UC Berkeley | Policy research' });
    expect(d.schools[0]?.name).toBe('University of California, Berkeley');
  });
  it('treats a title field that says "prev" as a past job', () => {
    const d = doc({ currentTitle: 'prev swe intern', currentOrganizationRaw: 'Stripe' });
    const r = runSpec({ ask: 't', positions: [{ company: { names: ['Stripe'] } }] }, [d], ctx);
    expect(r.rows.find((x) => x.id === d.id)?.band ?? 'no').not.toBe('strong');
  });
  it('lists a near miss (company and place matched, school not on file) ahead of rows with nothing matched', () => {
    const near = doc({
      currentTitle: 'Program Manager',
      currentOrganizationRaw: 'Stripe',
      location: 'San Francisco, California, United States',
    });
    const none = doc({ headline: 'Student @ Somewhere' });
    const r = runSpec(
      {
        ask: 't',
        positions: [{ company: { names: ['Stripe'] } }],
        schools: [{ names: ['Berkeley'] }],
        places: [{ names: ['SF'] }],
      },
      [none, near],
      ctx,
    );
    expect(r.rows[0]?.id).toBe(near.id);
    expect(r.rows[0]?.band).toBe('unchecked');
  });
  it('counts never talked as likely quiet, behind people who went quiet', () => {
    const p = doc({ currentTitle: 'Product Manager', currentOrganizationRaw: 'Figma' });
    const r = runSpec(
      { ask: 't', positions: [{ role: { families: ['product'] } }], relationship: { quietForDays: 365 } },
      [p],
      ctx,
    );
    expect(r.rows[0]?.band).toBe('likely');
  });
});
