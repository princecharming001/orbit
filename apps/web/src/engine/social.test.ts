import type { User } from '@orbit/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { MOCK_TARGET_ID, setSocialMockTimingForTests } from '../integrations/socialMock';
import { loadDemo } from './demo';
import { buildReachGraph, reachPerson, socialBridgesIn } from './graph';
import {
  answerAsk,
  connectInstagram,
  connectX,
  detachLink,
  lookupSummary,
  quoteLine,
  refreshInstagram,
  startCheck,
  switchSocial,
} from './social';
import { inUseNow } from './sources';

/**
 * The sample student's made-up Instagram and X (plan 43 §8.7): connecting reads step by step, a check of the target
 * finds a bridge the routes then carry with the platform named, X shows its price first, Off takes the route away and
 * On brings it back, "Not their account" takes the account off, and Remove deletes what was taken.
 */
const NOW = new Date('2026-10-06T14:00:00');
let user: User;

beforeAll(async () => {
  setSocialMockTimingForTests({ stepMs: 5, lookupMs: 5 });
  user = await loadDemo({ reset: true, now: NOW });
}, 90_000);
afterAll(() => setSocialMockTimingForTests(undefined));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function done(lookupId: string) {
  for (let i = 0; i < 50; i++) {
    const l = await db.socialLookups.get(lookupId);
    if (l?.status === 'done') return l;
    await wait(10);
  }
  throw new Error('lookup never finished');
}
const viaInstagram = async () =>
  (await reachPerson(user.id, MOCK_TARGET_ID, 3)).find((p) =>
    p.hops.some((h) => /on Instagram/.test(h.text)),
  );

describe('the demo on Instagram and X', () => {
  it('connects Instagram, reads it step by step, and switches the source on', async () => {
    expect(await inUseNow(user.id)).not.toContain('instagram');
    const r = await connectInstagram(user.id);
    expect(r.ok).toBe(true);
    expect(await inUseNow(user.id)).toContain('instagram');
    await wait(40);
    const st = await refreshInstagram(user.id);
    expect('status' in st && st.status).toBe('active');
    expect('steps' in st && st.steps.followers).toBe('done');
    // the target, her account by proof, and an open question
    expect(await db.people.get(MOCK_TARGET_ID)).toBeTruthy();
    expect(await db.socialAsks.where('userId').equals(user.id).count()).toBe(1);
  });

  it('a check finds the bridge, and the route says Instagram', async () => {
    expect(await viaInstagram()).toBeUndefined();
    const r = await startCheck(user.id, 'instagram', MOCK_TARGET_ID);
    expect(r.ok && 'lookupId' in r).toBe(true);
    const l = await done((r as { lookupId: string }).lookupId);
    expect(l.result?.bridges).toHaveLength(1);
    expect(lookupSummary(l, 'Jules')).toBeUndefined();
    const route = await viaInstagram();
    expect(route).toBeTruthy();
    expect(route!.hops.at(-1)!.text).toMatch(/follows Jules on Instagram and they follow back/);
    const { g } = await buildReachGraph(user.id);
    const bridges = socialBridgesIn(g, MOCK_TARGET_ID);
    expect(bridges.some((b) => b.mutual && b.platform === 'instagram')).toBe(true);
  });

  it('Off takes the route away and On brings it back', async () => {
    await switchSocial(user.id, 'instagram', 'off');
    expect(await viaInstagram()).toBeUndefined();
    await switchSocial(user.id, 'instagram', 'on');
    expect(await viaInstagram()).toBeTruthy();
  });

  it('X shows the price first and reads nothing until the student says go', async () => {
    await connectX(user.id, true);
    const q = await startCheck(user.id, 'x', MOCK_TARGET_ID);
    expect(q.ok && 'quote' in q).toBe(true);
    if (!q.ok || !('quote' in q)) return;
    expect(quoteLine(q.quote)).toBe('This reads about 400 people on X and costs about $4. Go ahead?');
    expect(await db.socialLookups.filter((l) => l.platform === 'x').count()).toBe(0);
    const go = await startCheck(user.id, 'x', MOCK_TARGET_ID, { confirm: true });
    const l = await done((go as { lookupId: string }).lookupId);
    expect(l.result?.bridges).toHaveLength(1);
    const routes = await reachPerson(user.id, MOCK_TARGET_ID, 5);
    expect(routes.some((p) => p.hops.some((h) => /on X/.test(h.text)))).toBe(true);
  });

  it('answers the question, and "Not their account" takes a wrong one off', async () => {
    const ask = (await db.socialAsks.toArray())[0]!;
    expect((await answerAsk(user.id, ask.id, 'yes')).ok).toBe(true);
    expect(await db.socialLinks.where('personId').equals(ask.personId).count()).toBeGreaterThan(0);
    const wrong = (await db.socialLinks.toArray()).find((l) => l.via === 'score')!;
    await detachLink(user.id, wrong.id);
    expect(await db.socialLinks.get(wrong.id)).toBeUndefined();
  });

  it('Remove deletes what Orbit took', async () => {
    await switchSocial(user.id, 'instagram', 'removed');
    expect(await db.socialLinks.filter((l) => l.platform === 'instagram').count()).toBe(0);
    expect(await db.touchpoints.filter((t) => t.kind === 'instagram_in').count()).toBe(0);
    expect(await db.people.get(MOCK_TARGET_ID)).toBeUndefined();
  });
});
