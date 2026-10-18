import { describe, expect, it } from 'vitest';
import { companyResult, routesTo, SAMPLE_PEOPLE, sampleId, suggest } from './sampleNetwork';

describe('the landing page sample network', () => {
  it('finds the warmest routes to a person, each first hop once, best first', () => {
    const r = routesTo(sampleId('Priya Ahmed'));
    expect(r.map((x) => x.hops.map((h) => h.id))).toEqual([
      [sampleId('Theo Lindqvist'), sampleId('Priya Ahmed')],
      [sampleId('Hannah Brooks'), sampleId('Priya Ahmed')],
      [sampleId('Sofia Bennett'), sampleId('Hannah Brooks'), sampleId('Priya Ahmed')],
    ]);
    expect(r[0]!.band).toBe('Strong route');
    expect(r.map((x) => x.score)).toEqual([...r.map((x) => x.score)].sort((a, b) => b - a));
    // a three-step route through a roommate
    expect(routesTo(sampleId('Arjun Cohen'))[0]!.hops.map((h) => h.id)).toEqual([
      sampleId('Jonah Reyes'),
      sampleId('Kai Tanaka'),
      sampleId('Arjun Cohen'),
    ]);
  });

  it('answers a company with its people, the warm ones counted, warmest way in first', () => {
    const s = companyResult('Stripe')!;
    expect(s.people).toHaveLength(7);
    expect(s.warm).toBe(2);
    expect(s.intros[0]!.person.displayName).toBe('Maya Chen');
  });

  it('suggests companies before people, and every person has somewhere to be reached from', () => {
    expect(suggest('stri')[0]).toMatchObject({ kind: 'company', name: 'Stripe' });
    expect(suggest('elena').map((x) => x.kind)).toEqual(['person', 'person']);
    expect(suggest('')).toEqual([]);
    for (const p of SAMPLE_PEOPLE) expect(routesTo(p.id).length).toBeGreaterThan(0);
  });
});
