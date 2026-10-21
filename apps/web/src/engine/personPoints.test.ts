import type { User } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { loadDemo } from './demo';
import { loadPointContext, personPoints } from './personPoints';

let user: User;

beforeAll(async () => {
  user = await loadDemo({ reset: true });
}, 90_000);

describe('what a Discover card says about someone', () => {
  it('says what they share, what stands out, what they do and why now, never their current company again', async () => {
    const recs = (await db.recommendations.where('userId').equals(user.id).toArray()).slice(0, 12);
    expect(recs.length).toBeGreaterThan(3);
    const ctx = await loadPointContext(
      user,
      recs.map((r) => r.personId),
    );
    const kinds = new Set<string>();
    for (const r of recs) {
      const p = (await db.people.get(r.personId))!;
      const points = personPoints(p, r, { ...ctx, dossier: ctx.dossiers.get(p.id) });
      expect(points.length).toBeGreaterThan(0);
      for (const pt of points) {
        kinds.add(pt.kind);
        // the logo already says where they work: no line just names it again
        expect(pt.text).not.toMatch(/is on your target list$/);
        expect(pt.text.toLowerCase()).not.toBe((p.currentOrganizationRaw ?? '').toLowerCase());
        expect(pt.text).not.toMatch(/alum$/i);
      }
      // no repeats on one card
      expect(new Set(points.map((x) => x.text)).size).toBe(points.length);
    }
    expect(kinds.has('common')).toBe(true);
    expect(kinds.has('standout') || kinds.has('does')).toBe(true);
  });

  it('only counts people who really know them, not everyone at the same company', async () => {
    const recs = await db.recommendations.where('userId').equals(user.id).toArray();
    const ctx = await loadPointContext(
      user,
      recs.map((r) => r.personId),
    );
    const weak = ctx.edges.filter((e) => e.type === 'same_current_company');
    const onlyWeak = { ...ctx, edges: weak, dossier: undefined };
    for (const r of recs.slice(0, 8)) {
      const p = (await db.people.get(r.personId))!;
      expect(personPoints(p, r, onlyWeak).some((x) => x.text.startsWith('Knows '))).toBe(false);
    }
  });
});
