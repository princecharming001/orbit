import type { Person, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../../db/schema';
import { leaveFakeApi, signInToFakeApi } from '../../test/account';
import { type FakeOrbitApi, withReplies } from '../../test/fakeOrbitApi';
import { execute } from '../registry';
import type { ResultEnvelope, ToolContext } from '../types';
import { makeCtx, nextToolUseId } from './helpers';

/**
 * First messages on autopilot in the chat (plan 29 §B5, §C1 phase 5): set_autopilot_mode explains the mode in two
 * sentences with where the first-message rung stands before the confirm, and autopilot_status answers "why didn't you
 * send to Priya" with the one rule, tomorrow's batch with the first messages that wait for a tap, the asks to friends
 * and the week. Against the fake orbit-api's day on autopilot; no dash or exclamation mark in any summary.
 */

const DASH_OR_BANG = /[—–!]/;
const at = '2026-10-06T12:00:00.000Z';

async function run(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ResultEnvelope> {
  const env = await execute(name, input, ctx);
  if (env.kind !== 'needs_confirmation') return env;
  return execute(name, input, { ...ctx, confirmation: env.confirmationId, toolUseId: nextToolUseId() });
}

let api: FakeOrbitApi;
let user: User;
beforeEach(async () => {
  await wipeDatabase();
  const signedIn = await signInToFakeApi();
  api = signedIn.api;
  user = signedIn.user as unknown as User;
  withReplies(api, { id: user.id, firstName: 'Maya' });
  await db.userGoals.put({ ...api.state.goals[0]!, userId: user.id });
  await db.people.put({
    id: 'p_jane',
    userId: user.id,
    displayName: 'Jane Cole',
    firstName: 'Jane',
    lastName: 'Cole',
    nameNormalized: 'jane cole',
    currentOrganizationRaw: 'Acme',
    currentTitle: 'Engineer',
    emails: ['jane@acme.com'],
    primaryEmail: 'jane@acme.com',
    tieScore: 70,
    relationshipType: 'unknown',
    strength: 0.7,
    interactionCount: 2,
    sources: ['manual'],
    isHuman: true,
    tags: [],
    createdAt: at,
    updatedAt: at,
  } as Person);
});
afterEach(async () => {
  await leaveFakeApi();
});

const ctx = () => makeCtx(user, { toolUseId: nextToolUseId() });

describe('autopilot in the chat, phase 5', () => {
  it('set_autopilot_mode says the mode in two sentences and where the rung stands before the confirm', async () => {
    const env = await execute('set_autopilot_mode', { mode: 'autopilot' }, ctx());
    expect(env.kind).toBe('needs_confirmation');
    const text = env.summary;
    expect(text).toContain("Tomorrow's batch");
    expect(text).toContain(
      '14 of 20 first messages approved unchanged. Until 6 more go out as Orbit wrote them, each first message in the evening batch waits for your tap.',
    );
    expect(text).not.toMatch(DASH_OR_BANG);
    // the mode body itself is two sentences
    const { MODE_TEXT } = await import('../tools/autopilot');
    expect(MODE_TEXT.autopilot.body.split(/(?<=\.)\s+(?=[A-Z])/)).toHaveLength(2);
  });

  it("why didn't you send to Priya names the rule that held her, and to Noah the rule that left him out", async () => {
    const priya = await run('autopilot_status', { personName: 'Priya' }, ctx());
    expect(priya.summary).toContain(
      'Priya was held: Kenji Mori at Figma was written to this morning; autopilot never writes to two people at one firm on the same day.',
    );
    const noah = await run('autopilot_status', { personName: 'Noah Kim' }, ctx());
    expect(noah.summary.startsWith('Noah is a recruiter at Linear.')).toBe(true);
    // someone the plan never weighed: the first rule they fail, from this browser's own people
    const jane = await run('autopilot_status', { personName: 'Jane' }, ctx());
    expect(jane.summary.startsWith('Jane is at Acme, which is not one of the companies on your goals.')).toBe(
      true,
    );
    const nobody = await run('autopilot_status', { personName: 'Zed Quinn' }, ctx());
    expect(nobody.summary).toContain('Orbit has no one called Zed Quinn');
    for (const e of [priya, noah, jane, nobody]) expect(e.summary).not.toMatch(DASH_OR_BANG);
  });

  it("the status says tomorrow's batch with the first messages waiting for a tap, and the week", async () => {
    const env = await run('autopilot_status', {}, ctx());
    expect(env.summary).toContain('2 messages queued for the morning (2 waiting for your tap)');
    expect(env.summary).toContain('On autopilot: 9 sent, 4 replies, 2 calls, 1 pushback (paused Ramp).');
    const data = (
      env.data as { ui: { queued: { person: string; status: string }[]; skipped: { rule: string }[] } }
    ).ui;
    expect(data.queued.map((q) => [q.person, q.status])).toEqual([
      ['Grace Liu', 'needs_tap'],
      ['Omar Haddad', 'needs_tap'],
    ]);
    expect(data.skipped.map((x) => x.rule)).toEqual(['recruiter', 'not_target_company']);
    expect(env.summary).not.toMatch(DASH_OR_BANG);
    expect(api.routes()).toContain('/autopilot/status');
  });

  it("a queued first message says the student's clock and the recipient's when the two differ", async () => {
    const grace = api.state.autopilot.queued.find((q) => q.personName === 'Grace Liu')!;
    grace.sendAt = '2026-10-07T12:40:00.000Z';
    grace.recipientTimeZone = 'America/New_York';
    const west = { ...user, timezone: 'America/Los_Angeles' };
    const env = await run('autopilot_status', {}, makeCtx(west, { toolUseId: nextToolUseId() }));
    const queued = (env.data as { ui: { queued: { person: string; when?: string }[] } }).ui.queued;
    expect(queued.find((q) => q.person === 'Grace Liu')?.when).toBe(
      'Wed 5:40 AM your time (8:40 AM their time)',
    );
    // the same zone says one clock
    const east = { ...user, timezone: 'America/New_York' };
    const same = await run('autopilot_status', {}, makeCtx(east, { toolUseId: nextToolUseId() }));
    const q2 = (same.data as { ui: { queued: { person: string; when?: string }[] } }).ui.queued;
    expect(q2.find((q) => q.person === 'Grace Liu')?.when).toBe('Wed 8:40 AM');
  });
});
