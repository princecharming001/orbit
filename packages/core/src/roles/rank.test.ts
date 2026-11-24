import { describe, expect, it } from 'vitest';
import { type RankCandidate, type RankContext, rankOf, rankRoles, titleMatch } from './rank';

const NOW = new Date('2026-11-24T12:00:00Z');
const ctx = (over: Partial<RankContext> = {}): RankContext => ({
  kinds: [{ title: 'Software engineer' }],
  levels: ['intern'],
  skills: ['Python', 'Go'],
  places: ['New York'],
  remote: false,
  warm: new Set(),
  now: NOW,
  ...over,
});
const role = (over: Partial<RankCandidate> = {}): RankCandidate => ({
  id: Math.random().toString(36),
  title: 'Software Engineer Intern',
  family: 'engineering',
  level: 'intern',
  places: ['New York, NY'],
  companyKey: 'acme',
  ...over,
});

describe('the free ranking', () => {
  it('title words against the kinds ticked', () => {
    expect(titleMatch('Software Engineer Intern', [{ title: 'Software engineer' }])).toBe(1);
    expect(titleMatch('SWE Intern', [{ title: 'Software engineer' }])).toBe(1);
    expect(titleMatch('Account Executive', [{ title: 'Software engineer' }])).toBe(0);
  });

  it('a matching title, at level, in place, ranks over one that is not', () => {
    const a = rankOf(role(), ctx());
    expect(a).toBeGreaterThan(rankOf(role({ title: 'Sales Intern', family: 'sales' }), ctx()));
    expect(a).toBeGreaterThan(rankOf(role({ level: undefined }), ctx()));
    expect(rankOf(role({ level: undefined }), ctx())).toBeGreaterThan(
      rankOf(role({ level: 'senior' }), ctx()),
    );
    expect(a).toBeGreaterThan(rankOf(role({ places: ['Austin, TX'] }), ctx()));
  });

  it('skills named in the title or team, a warm company and a recent posting lift a role', () => {
    const base = rankOf(role(), ctx());
    expect(rankOf(role({ team: 'Python platform' }), ctx())).toBeGreaterThan(base);
    expect(rankOf(role(), ctx({ warm: new Set(['acme']) }))).toBeGreaterThan(base);
    expect(rankOf(role({ postedAt: '2026-11-22T00:00:00Z' }), ctx())).toBeGreaterThan(
      rankOf(role({ postedAt: '2026-08-01T00:00:00Z' }), ctx()),
    );
  });

  it('remote counts as in place when the student wants remote', () => {
    const c = ctx({ remote: true, places: [] });
    expect(rankOf(role({ remote: 'remote', places: [] }), c)).toBeGreaterThan(
      rankOf(role({ places: [] }), c),
    );
  });

  it('sorts best first and keeps ties in order', () => {
    const list = [
      role({ id: 'a', title: 'Sales' }),
      role({ id: 'b' }),
      role({ id: 'c' }),
      role({ id: 'd', title: 'Sales' }),
    ];
    expect(rankRoles(list, ctx()).map((r) => r.id)).toEqual(['b', 'c', 'a', 'd']);
  });
});
