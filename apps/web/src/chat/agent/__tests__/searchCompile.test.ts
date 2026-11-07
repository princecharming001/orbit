import { describe, expect, it } from 'vitest';
import { compileSearch } from '../searchCompile';

describe('compileSearch', () => {
  it('reads YC founders, with and without a batch', () => {
    const a = compileSearch('YC founders in my network');
    expect(a?.positions?.[0]?.company?.yc).toEqual({ any: true });
    expect(a?.positions?.[0]?.role?.founder).toBe(true);
    expect(a?.positions?.[0]?.when).toBe('ever');
    expect(compileSearch('who do I know from yc w24')?.positions?.[0]?.company?.yc).toEqual({
      batches: ['W24'],
    });
    expect(compileSearch('founders from YC Summer 2023')?.positions?.[0]?.company?.yc).toEqual({
      batches: ['S23'],
    });
  });

  it('reads school, company and place together', () => {
    const s = compileSearch('Berkeley alums at Stripe in SF');
    expect(s?.schools?.[0]?.names).toEqual(['Berkeley']);
    expect(s?.positions?.[0]?.company?.names).toEqual(['Stripe']);
    expect(s?.places?.[0]?.names).toEqual(['SF']);
    expect(compileSearch('any Stanford alumni I know in New York')?.schools?.[0]?.names).toEqual([
      'Stanford',
    ]);
  });

  it('reads a role with how long since the student talked to them', () => {
    const s = compileSearch('PMs I have not talked to in a year');
    expect(s?.positions?.[0]?.role?.families).toEqual(['product']);
    expect(s?.relationship?.quietForDays).toBe(365);
    expect(compileSearch("engineers I haven't talked to in 6 months")?.relationship?.quietForDays).toBe(180);
  });

  it('reads bare batches, trailing "I know", "went to" and ex-companies', () => {
    expect(compileSearch('any W25 founders I know')?.positions?.[0]?.company?.yc).toEqual({
      batches: ['W25'],
    });
    expect(compileSearch('engineers at Stripe I know')?.positions?.[0]?.company?.names).toEqual(['Stripe']);
    expect(compileSearch('who in my network went to Michigan')?.schools).toEqual([{ names: ['Michigan'] }]);
    expect(compileSearch('who do I know that went to YC')?.schools).toBeUndefined();
    const ex = compileSearch('ex-Google founders in my network');
    expect(ex?.positions).toEqual([
      { role: { founder: true } },
      { company: { names: ['Google'] }, when: 'past' },
    ]);
  });

  it('leaves other questions alone', () => {
    for (const t of [
      'who do I know at Stripe',
      'who do I know at Stripe through friends',
      'show only alumni on the map',
      'untick the alumni question',
      'find Lena',
      'routes into McKinsey',
      'write to Ava',
      'who are my friends on orbit',
    ])
      expect(compileSearch(t), t).toBeUndefined();
  });
});
