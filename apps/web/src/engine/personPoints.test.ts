import type { User } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { loadDemo } from './demo';
import { loadPointContext, personPoints, whySignalsFor, whyThemFor } from './personPoints';

let user: User;

beforeAll(async () => {
  user = await loadDemo({ reset: true });
}, 90_000);

describe('what a Discover card says about someone', () => {
  it('says what stands out, what they do and why now, never their current company again', async () => {
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
    expect(kinds.has('standout') || kinds.has('does')).toBe(true);
  });
});

describe('why someone on the demo account is suggested', () => {
  it('gives most cards two or more real reasons, each from the account, strongest first', async () => {
    const recs = await db.recommendations.where('userId').equals(user.id).toArray();
    expect(recs.length).toBeGreaterThan(5);
    const ctx = await loadPointContext(
      user,
      recs.map((r) => r.personId),
    );
    let rich = 0;
    const kinds = new Set<string>();
    for (const r of recs) {
      const p = (await db.people.get(r.personId))!;
      const why = whyThemFor(p, r, ctx);
      expect(why.length).toBeGreaterThan(0);
      expect(why.length).toBeLessThanOrEqual(5);
      const real = why.filter((w) => w.kind !== 'thin');
      if (real.length >= 2) rich++;
      for (const w of real) kinds.add(w.kind);
      // strongest first; the honest line, when there is one, last and only when there is little
      for (let i = 1; i < real.length; i++)
        expect(real[i]!.strength).toBeLessThanOrEqual(real[i - 1]!.strength);
      const thin = why.filter((w) => w.kind === 'thin');
      expect(thin.length).toBeLessThanOrEqual(1);
      if (thin.length) {
        expect(why[why.length - 1]!.kind).toBe('thin');
        expect(real.length).toBeLessThan(2);
      }
      // no repeats
      expect(new Set(why.map((x) => x.text)).size).toBe(why.length);
    }
    expect(rich / recs.length).toBeGreaterThanOrEqual(0.7);
    // the demo shows the range: goals, the school, people in common, a reply or a meeting
    expect(kinds.has('goal')).toBe(true);
    expect(kinds.has('school')).toBe(true);
    expect(kinds.has('history')).toBe(true);
  });

  it('names the people you both know, and reads the school year from their education', async () => {
    const recs = await db.recommendations.where('userId').equals(user.id).toArray();
    const ctx = await loadPointContext(
      user,
      recs.map((r) => r.personId),
    );
    const all = recs.map((r) => ({ r, p: ctx.people.get(r.personId)! }));
    const signals = all.map(({ r, p }) => whySignalsFor(p, r, ctx));
    const named = signals.find((s) => s.mutuals?.names?.length);
    expect(named?.mutuals?.names?.every((n) => /^[A-Z][a-z]+/.test(n))).toBe(true);
    const line = whyThemFor(all[signals.indexOf(named!)]!.p, all[signals.indexOf(named!)]!.r, ctx).find(
      (w) => w.kind === 'mutuals',
    );
    expect(line?.text).toMatch(/^You both know [A-Z]/);
    const alum = signals.find((s) => s.school?.gradYear);
    expect(alum?.school?.myGradYear).toBe(user.graduationYear);
    // an introducer is a way in, named
    const withIntro = all.find(({ r }) => r.bestPath && r.bestPath.hops.length >= 2);
    if (withIntro) {
      const intro = ctx.people.get(withIntro.r.bestPath!.hops[0]!.toId)!;
      const why = whyThemFor(withIntro.p, withIntro.r, ctx, intro);
      expect(why.some((w) => w.text === `${intro.firstName} could introduce you`)).toBe(true);
    }
  });

  it('says so when the account holds little about someone', async () => {
    const recs = await db.recommendations.where('userId').equals(user.id).toArray();
    const ctx = await loadPointContext(user, []);
    const p = ctx.people.get(recs[0]!.personId)!;
    const stranger = {
      ...p,
      id: 'p-stranger',
      isAlumni: false,
      school: undefined,
      location: undefined,
      currentOrganizationRaw: 'Acme Widgets',
      currentOrganizationId: undefined,
      currentTitle: 'Analyst',
      headline: undefined,
      strength: 0,
      linkedinConnectedOn: undefined,
    };
    const why = whyThemFor(
      stranger,
      { reasons: [] },
      { ...ctx, edges: [], touchpoints: [], affiliations: [] },
    );
    expect(why.map((w) => w.text)).toEqual(['Only their title and company so far']);
  });
});
