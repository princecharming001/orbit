import type { Person, User } from '@orbit/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import { createLocalUser } from './account';
import { localAutopilotStatus, tapBatchItem } from './autopilotMode';
import {
  LOCAL_SKIPS_KV,
  localFirstTouchGate,
  raiseLocalBatchCard,
  runLocalAutopilotPlan,
} from './autopilotPlan';
import { sendDueQueued } from './send';

/**
 * Local mode's plan step (plan 29 §B4, §C1 phase 5): the same rules as the server's, over this browser's people,
 * queued in this browser's outbox behind the evening review, sent while a tab is open.
 */

// Tuesday 13 October 2026, noon in New York
const NOW = new Date('2026-10-13T16:00:00Z');
// Wednesday 14 October, the morning window in New York
const MORNING = new Date('2026-10-14T12:30:00Z');
let user: User;

const person = (id: string, name: string, org: string, extra: Partial<Person> = {}): Person =>
  ({
    id,
    userId: user.id,
    displayName: name,
    firstName: name.split(' ')[0],
    lastName: name.split(' ')[1] ?? '',
    nameNormalized: name.toLowerCase(),
    primaryEmail: `${id}@${org.toLowerCase()}.com`,
    emails: [`${id}@${org.toLowerCase()}.com`],
    currentOrganizationRaw: org,
    currentTitle: 'Product Manager',
    relationshipType: 'unknown',
    strength: 0.6,
    tieScore: 60,
    interactionCount: 3,
    sources: ['gmail'],
    isHuman: true,
    tags: [],
    createdAt: '',
    updatedAt: '',
    location: 'New York, NY',
    ...extra,
  }) as Person;

async function hook(personId: string, text: string) {
  await db.facts.add({
    id: `f_${personId}`,
    userId: user.id,
    personId,
    type: 'role_detail',
    text,
    sourceTable: 'manual',
    sourceId: 'manual',
    confidence: 1,
    createdAt: NOW.toISOString(),
  });
}

beforeEach(async () => {
  await wipeDatabase();
  user = await createLocalUser({
    fullName: 'Ravi Jain',
    email: 'ravi@umich.edu',
    timezone: 'America/New_York',
  });
  setConnectorsMockForTests(true);
  await db.settings.update(user.id, { autopilotMode: 'autopilot', weeklyOutreachTarget: 12 });
  await db.userGoals.put({
    id: 'g1',
    userId: user.id,
    kind: 'recruiting',
    title: 'PM internships',
    targets: {
      organizations: ['Ramp', 'Figma', 'Linear'],
      roles: ['PM intern'],
      geographies: [],
      people: [],
    },
    criteria: {},
    priority: 2,
    status: 'active',
    source: 'user',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  await db.people.bulkPut([
    person('p_ada', 'Ada Lin', 'Ramp', { isAlumni: true, tieScore: 10 }),
    person('p_cal', 'Cal Reyes', 'Figma', { tieScore: 70 }),
    person('p_ben', 'Ben Ortiz', 'Figma', { tieScore: 60 }),
    person('p_dee', 'Dee Park', 'Linear', { tieScore: 80, currentTitle: 'University Recruiter' }),
    person('p_ivy', 'Ivy Moss', 'Acme', { tieScore: 90 }),
  ]);
  for (const [id, text] of [
    ['p_ada', 'Ada leads the card issuing team at Ramp'],
    ['p_cal', 'Cal leads the onboarding redesign at Figma'],
    ['p_ben', 'Ben runs the growth experiments at Figma'],
    ['p_dee', 'Dee runs the intern program at Linear'],
    ['p_ivy', 'Ivy leads pricing at Acme'],
  ])
    await hook(id!, text!);
});

describe('the plan step in this browser (plan 29 §B4)', () => {
  it('queues first messages behind the evening review, one per firm, never to a recruiter or outside the goal', async () => {
    const r = await runLocalAutopilotPlan(user, NOW);
    expect(r).toMatchObject({
      goals: 1,
      queued: 2,
      note: 'Sends while Orbit is open; sign in for always-on.',
    });
    const queued = (await db.outbound.toArray()).filter((o) => o.autoRung === 'first_touch');
    expect(queued.map((o) => o.personId).sort()).toEqual(['p_ada', 'p_cal']);
    for (const o of queued) {
      expect(o).toMatchObject({ status: 'queued', autopilot: true, autoSent: true, channel: 'gmail' });
      expect(o.reviewUntil).toBe(o.sendAt);
      // a full review window ahead, in the recipient's Wednesday morning
      expect(Date.parse(o.sendAt!)).toBeGreaterThan(NOW.getTime() + 8 * 3_600_000);
      expect(o.sendAt!.slice(0, 10)).toBe('2026-10-14');
    }
    const status = await localAutopilotStatus(user, NOW);
    expect(status.queued.map((q) => q.status)).toEqual(['needs_tap', 'needs_tap']);
    const rules = Object.fromEntries((status.skipped ?? []).map((x) => [x.personName, x.rule]));
    expect(rules).toEqual({ 'Ben Ortiz': 'same_firm_today', 'Dee Park': 'recruiter' });
    expect((await db.kv.get(`${LOCAL_SKIPS_KV}${user.id}`))?.value).toBeTruthy();
  });

  it('plans nothing while paused, in assist, or with no way to send by Gmail', async () => {
    await db.settings.update(user.id, {
      autopilotPausedUntil: new Date(NOW.getTime() + 86_400_000).toISOString(),
    });
    expect(await runLocalAutopilotPlan(user, NOW)).toMatchObject({ reason: 'paused', queued: 0 });
    await db.settings.update(user.id, { autopilotPausedUntil: undefined, autopilotMode: 'assist' });
    expect(await runLocalAutopilotPlan(user, NOW)).toMatchObject({ reason: 'no_autopilot_goal', queued: 0 });
    await db.settings.update(user.id, { autopilotMode: 'autopilot' });
    setConnectorsMockForTests(false);
    expect(await runLocalAutopilotPlan(user, NOW)).toMatchObject({ reason: 'no_gmail', queued: 0 });
    expect(await db.outbound.count()).toBe(0);
  });

  it('before the rung, silence keeps a first message back and a tap sends it at its time', async () => {
    await runLocalAutopilotPlan(user, NOW);
    const [a, b] = (await db.outbound.toArray()).filter((o) => o.autoRung === 'first_touch');
    expect(await tapBatchItem(user, { draftId: b!.id, sendAt: b!.sendAt! })).toEqual({ ok: true });
    expect((await localAutopilotStatus(user, NOW)).queued.find((q) => q.draftId === b!.id)?.status).toBe(
      'queued',
    );
    const gate = await localFirstTouchGate(user, (await db.outbound.get(a!.id))!, MORNING);
    expect(gate).toMatchObject({ ok: false });
    for (const at of [a!.sendAt!, b!.sendAt!].sort())
      await sendDueQueued(user, new Date(Date.parse(at) + 1000));
    const after = await db.outbound.bulkGet([a!.id, b!.id]);
    expect(after[0]).toMatchObject({ status: 'draft' });
    expect(after[0]!.error).toContain('It waited for your tap');
    expect(after[1]!.status).toBe('sent');
  });

  it('after the rung, silence is consent, but only once the voice judge has read it: without a key it waits', async () => {
    for (let i = 0; i < 20; i++) {
      const at = new Date(NOW.getTime() - (40 - i) * 86_400_000).toISOString();
      await db.outbound.put({
        id: `o_past_${i}`,
        userId: user.id,
        personId: 'p_ivy',
        channel: 'gmail',
        kind: 'outreach',
        bodyDraft: 'x',
        status: 'sent',
        sentAt: at,
        generatedBy: 'template',
        createdAt: at,
      });
      await db.feedback.put({
        id: `f_past_${i}`,
        userId: user.id,
        kind: 'approve',
        outboundMessageId: `o_past_${i}`,
        createdAt: at,
      });
    }
    // Ivy was written to, so she is out; the plan writes to Ada and Cal
    await runLocalAutopilotPlan(user, NOW);
    const queued = (await db.outbound.toArray()).filter((o) => o.autoRung === 'first_touch');
    expect((await localAutopilotStatus(user, NOW)).queued.map((q) => q.status)).toEqual(['queued', 'queued']);
    const gate = await localFirstTouchGate(user, queued[0]!, MORNING, { judge: false });
    expect(gate).toEqual({ ok: true });
    await sendDueQueued(user, new Date(Date.parse(queued[0]!.sendAt!) + 1000));
    const after = await db.outbound.get(queued[0]!.id);
    expect(after).toMatchObject({
      status: 'draft',
      error: "It didn't sound like you, so it waits for your tap.",
    });
  });

  it('raises the batch card once at 18:00 their time', async () => {
    await runLocalAutopilotPlan(user, NOW);
    expect(await raiseLocalBatchCard(user, new Date('2026-10-13T21:30:00Z'))).toBe(false);
    expect(await raiseLocalBatchCard(user, new Date('2026-10-13T22:10:00Z'))).toBe(true);
    expect(await raiseLocalBatchCard(user, new Date('2026-10-13T23:10:00Z'))).toBe(false);
    const [card] = await db.suggestions.where('kind').equals('batch_ready').toArray();
    expect(card!.reasonText).toBe(
      "Tomorrow's batch is ready: 2 first messages wait for your tap tonight. Until 20 go out as Orbit wrote them, only the ones you tap are sent.",
    );
    expect((await localAutopilotStatus(user, new Date('2026-10-13T22:10:00Z'))).batch?.firstTouches).toBe(2);
  });
});
