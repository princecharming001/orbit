import { inWorkingHours, type Person, type User, WARMUP_REFUSAL_WORDS } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import { advanceWarmup, type FakeOrbitApi } from '../test/fakeOrbitApi';
import { createLocalUser } from './account';
import { startWarmUpOrOutreach } from './brief';
import { moveChat } from './move';
import { pullNow, refreshSyncStatus } from './serverSync';
import { updateLimits } from './settings';
import {
  autoWarmUpMode,
  demoRunNextStep,
  opensWarmUpSheet,
  previewAutoWarmUp,
  startAutoWarmUp,
  stopMovedWarmUps,
  stopWarmUp,
  tellWarmUpDone,
  tickDemoWarmUps,
  warmUpsToTell,
} from './warmupAuto';

/**
 * The automated warm-up in the browser: asking Orbit's server for the plan, starting it with the comment the student
 * approved, following the run as the sync brings it, stopping it, and being told once when it is done. The server is
 * the in-memory fake; the demo's own simulation is tested at the end.
 */

const AT = '2026-11-16T15:00:00.000Z';
const BANNED = /[–—!]/;

const person = (id: string, over: Partial<Person> = {}): Person =>
  ({
    id,
    userId: '',
    displayName: 'Priya Rao',
    firstName: 'Priya',
    lastName: 'Rao',
    nameNormalized: 'priya rao',
    emails: [],
    linkedinSlug: 'priya-rao',
    linkedinUrl: 'https://www.linkedin.com/in/priya-rao',
    relationshipType: 'unknown',
    strength: 0.05,
    interactionCount: 0,
    sources: ['linkedin_csv'],
    isHuman: true,
    tags: [],
    createdAt: AT,
    updatedAt: AT,
    currentTitle: 'Head of Analytics',
    currentOrganizationRaw: 'Northwind',
    ...over,
  }) as Person;

const chatOf = async (personId: string) => (await db.chats.where('personId').equals(personId).first())!;
const cards = async (userId: string, kind: string) =>
  (await db.suggestions.where('userId').equals(userId).toArray()).filter(
    (s) => s.kind === kind && s.status === 'pending',
  );

describe('an Orbit account with LinkedIn connected', () => {
  let api: FakeOrbitApi;
  let user: User;
  const P = '7a1d2c3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d';

  beforeEach(async () => {
    await wipeDatabase();
    const signedIn = await signInToFakeApi();
    api = signedIn.api;
    await db.users.update(signedIn.user.id, { onboardingCompletedAt: AT, timezone: 'America/New_York' });
    user = (await db.users.get(signedIn.user.id))!;
    api.state.linkedin.status = 'active';
    api.state.status.marks = { changed: 'm0', linkedin: 'l0', autopilot: 'a0' };
    await refreshSyncStatus();
    await db.people.put({ ...person(P), userId: user.id });
  });
  afterEach(async () => {
    setConnectorsMockForTests(undefined);
    await leaveFakeApi();
  });

  /** preview and start, as the sheet does */
  async function begin(comment?: string | null) {
    const pre = await previewAutoWarmUp(user, P);
    if (!pre.ok) throw new Error(pre.message);
    const r = await startAutoWarmUp(user, pre.preview, comment === undefined ? pre.preview.comment : comment);
    if (!r.ok) throw new Error(r.message);
    return { pre: pre.preview, run: r.run, chat: r.chat };
  }

  it('is offered only where Orbit can run it', async () => {
    expect(await autoWarmUpMode(user)).toBe('server');
    expect(await opensWarmUpSheet(user, P)).toBe(true);
    // someone the student already knows is written to, not warmed up to
    await db.people.put({ ...person('p_warm', { strength: 0.6 }), userId: user.id });
    expect(await opensWarmUpSheet(user, 'p_warm')).toBe(false);
    // the setting off: back to the manual reminders
    await updateLimits(user.id, { warmUpAuto: false });
    expect(await autoWarmUpMode(user)).toBeUndefined();
    expect(await opensWarmUpSheet(user, P)).toBe(false);
    expect(api.calls.find((c) => c.route === '/settings/profile')?.body).toMatchObject({ warmUpAuto: false });
    await updateLimits(user.id, { warmUpAuto: true });
    expect(await autoWarmUpMode(user)).toBe('server');
    // warm-ups off altogether: nothing to run
    await updateLimits(user.id, { warmUpEnabled: false });
    expect(await opensWarmUpSheet(user, P)).toBe(false);
  });

  it('is not offered while LinkedIn is not connected on the server, or in the local copy', async () => {
    for (const status of ['not_connected', 'needs_reauth', 'parked', 'revoked']) {
      await leaveFakeApi();
      await wipeDatabase();
      const s = await signInToFakeApi();
      s.api.state.linkedin.status = status;
      await refreshSyncStatus();
      expect(await autoWarmUpMode(s.user), status).toBeUndefined();
    }
    await leaveFakeApi();
    const local = await createLocalUser({ fullName: 'Local Student', email: 'local@example.edu' });
    expect(await autoWarmUpMode(local)).toBeUndefined();
    await db.people.put({ ...person('p_local'), userId: local.id });
    expect(await opensWarmUpSheet(local, 'p_local')).toBe(false);
    const pre = await previewAutoWarmUp(local, 'p_local');
    expect(pre).toMatchObject({ ok: false, reason: 'not_connected' });
  });

  it('shows the plan and the drafted comment, and nothing is started by looking', async () => {
    const pre = await previewAutoWarmUp(user, P);
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.mode).toBe('server');
    expect(pre.preview).toMatchObject({
      personId: P,
      comment: 'Did the week one rule hold once the team passed twenty people?',
      post: { excerpt: 'New analysts should ship something real in their first week.' },
    });
    expect(pre.preview.steps.map((s) => s.kind)).toEqual(['view_profile', 'react_post', 'comment_post']);
    expect(api.calls.find((c) => c.route === '/warmups/preview')?.body).toMatchObject({
      personId: P,
      warmUpDays: 4,
    });
    expect(await db.chats.count()).toBe(0);
    expect(await db.warmups.count()).toBe(0);
    expect(api.state.warmups.started).toEqual([]);
  });

  it('starts with exactly the words the student approved, and the chat goes to Warming up with Orbit’s plan', async () => {
    const edited =
      'Day two in prod, wow.  Did that hold at 20+ people?\nAsking as a student, très curious 🙂 ';
    const { run, chat } = await begin(edited);
    // the server got the words as they were, to the byte
    expect(api.state.warmups.started).toEqual([{ warmupId: run.id, personId: P, comment: edited }]);
    expect(api.calls.find((c) => c.route === '/warmups/start')?.body).toEqual({
      warmupId: run.id,
      comment: edited,
    });
    expect(chat.stage).toBe('warming');
    expect(chat.warmUp?.auto).toMatchObject({ runId: run.id, status: 'running', comment: edited });
    expect(chat.warmUp?.actions.map((a) => a.label)).toEqual([
      'Orbit views their profile',
      'Orbit likes one recent post',
      'Orbit leaves the comment you approved',
    ]);
    for (const a of chat.warmUp!.actions)
      expect(inWorkingHours(new Date(a.dueAt), 'America/New_York')).toBe(true);
    expect((await db.warmups.get(run.id))?.personId).toBe(P);
    // nothing is asked of the student: no step card, on any day
    expect(await cards(user.id, 'warm_up_engage')).toEqual([]);
    const events = await db.stageEvents.where('chatId').equals(chat.id).toArray();
    expect(events.map((e) => e.reason)).toEqual(['warmup:started']);
  });

  it('leaves the comment out when the student says so', async () => {
    const { run, chat } = await begin(null);
    expect(api.state.warmups.started[0]).toMatchObject({ comment: null });
    expect(run.steps.map((s) => s.kind)).toEqual(['view_profile', 'react_post']);
    expect(chat.warmUp?.auto?.comment).toBeNull();
    expect(chat.warmUp?.actions).toHaveLength(2);
  });

  it('is the profile view only for someone with no recent post', async () => {
    api.state.warmups.post = null;
    const pre = await previewAutoWarmUp(user, P);
    expect(pre.ok && pre.preview).toMatchObject({ post: null, comment: null });
    const { chat } = await begin(null);
    expect(chat.warmUp?.actions.map((a) => a.kind)).toEqual(['view_profile']);
  });

  it('says in words why it cannot start', async () => {
    for (const reason of ['busy', 'sign_in', 'no_profile', 'unconfigured', 'blocked'] as const) {
      api.state.warmups.refuse = reason;
      const pre = await previewAutoWarmUp(user, P);
      expect(pre).toEqual({ ok: false, reason, message: WARMUP_REFUSAL_WORDS[reason] });
    }
    for (const words of Object.values(WARMUP_REFUSAL_WORDS)) expect(words).not.toMatch(BANNED);
    api.state.warmups.refuse = undefined;
    // do not contact, hidden, already written to: refused here, without asking the server
    const before = api.calls.length;
    await db.people.update(P, { doNotContact: true });
    expect(await previewAutoWarmUp(user, P)).toMatchObject({ ok: false, reason: 'blocked' });
    await db.people.update(P, { doNotContact: false, hiddenAt: AT });
    expect(await previewAutoWarmUp(user, P)).toMatchObject({ ok: false, reason: 'blocked' });
    await db.people.update(P, { hiddenAt: undefined });
    await db.chats.put({
      id: 'c_sent',
      userId: user.id,
      personId: P,
      stage: 'outreach_sent',
      stageEnteredAt: AT,
      source: 'manual',
      goalTags: [],
      bumpCount: 0,
      priority: 2,
      createdAt: AT,
      updatedAt: AT,
    });
    const r = await previewAutoWarmUp(user, P);
    expect(r).toMatchObject({
      ok: false,
      message: 'You are already in touch with Priya, so there is nothing to warm up.',
    });
    expect(api.calls.slice(before).filter((c) => c.route.startsWith('/warmups'))).toEqual([]);
  });

  it('follows the run as the sync brings it: each step Orbit ran is done on the chat, once', async () => {
    const { run, chat } = await begin();
    advanceWarmup(api, run.id, { at: '2026-11-16T15:01:00.000Z' });
    await refreshSyncStatus();
    await pullNow(user.id);
    let now = (await db.chats.get(chat.id))!;
    expect(now.warmUp?.actions.map((a) => !!a.doneAt)).toEqual([true, false, false]);
    expect(now.warmUp?.actions[0]?.doneAt).toBe('2026-11-16T15:01:00.000Z');
    expect(now.warmUp?.auto?.status).toBe('running');
    expect(now.stage).toBe('warming');
    // a touch on their timeline, once, however often the run comes down
    advanceWarmup(api, run.id, { steps: 0 });
    await pullNow(user.id);
    await pullNow(user.id);
    const touches = await db.touchpoints.where('personId').equals(P).toArray();
    expect(touches.filter((t) => t.kind === 'linkedin_engaged')).toHaveLength(1);
    expect(touches[0]?.summary).toBe('Orbit viewed their LinkedIn profile for you');
    expect(await cards(user.id, 'warm_up_engage')).toEqual([]);
    expect(await cards(user.id, 'new_outreach')).toEqual([]);
    // the like ran; the post's topic is kept for the first message
    advanceWarmup(api, run.id, { at: '2026-11-18T14:00:00.000Z' });
    await pullNow(user.id);
    now = (await db.chats.get(chat.id))!;
    expect(now.warmUp?.actions[1]).toMatchObject({
      doneAt: '2026-11-18T14:00:00.000Z',
      note: 'new analysts shipping in week one',
    });
  });

  it('when the last step has run: warmed up, told once, and the first message is offered', async () => {
    const { run, chat } = await begin();
    advanceWarmup(api, run.id, { steps: 3, at: '2026-11-19T14:00:00.000Z' });
    await pullNow(user.id);
    const done = (await db.chats.get(chat.id))!;
    expect(done.warmUp?.auto).toMatchObject({ status: 'done', finishedAt: '2026-11-19T14:00:00.000Z' });
    expect(done.warmUp?.actions.every((a) => !!a.doneAt)).toBe(true);
    const toTell = await warmUpsToTell(user.id);
    expect(toTell.map((r) => r.id)).toEqual([run.id]);
    const said = await tellWarmUpDone(user, toTell[0]!);
    expect(said).toEqual({
      text: 'Orbit finished the warm-up for Priya. Your first message is ready to write.',
      personId: P,
    });
    expect(said!.text).not.toMatch(BANNED);
    // once: here, and on the server so no other device says it again
    expect(await tellWarmUpDone(user, toTell[0]!)).toBeUndefined();
    expect(await warmUpsToTell(user.id)).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(api.state.warmups.told).toEqual([run.id]);
    const notes = await db.notifications.where('userId').equals(user.id).toArray();
    expect(notes.map((n) => [n.title, n.link])).toEqual([
      ['Orbit finished the warm-up for Priya.', `/people/${P}`],
    ]);
    // the next step on Drafts: the first message, in Orbit's words, with a draft to review; nothing was sent
    const first = await cards(user.id, 'new_outreach');
    expect(first).toHaveLength(1);
    expect(first[0]!.reasonText).toBe('Orbit finished the warm-up; ready to message Priya');
    expect(first[0]!.outboundMessageId).toBeTruthy();
    const draft = await db.outbound.get(first[0]!.outboundMessageId!);
    expect(draft).toMatchObject({ status: 'draft', kind: 'outreach', channel: 'linkedin' });
    expect((await db.outbound.toArray()).filter((d) => d.status !== 'draft')).toEqual([]);
    // another device told them first: nothing to say here
    const other = await begin2('8b2e3d4f-5c6a-4b7c-9d8e-0f1a2b3c4d5e');
    const r2 = advanceWarmup(api, other.run.id, { steps: 3 });
    r2.toldAt = '2026-11-19T15:00:00.000Z';
    api.state.pages[api.state.pages.length - 1] = { changes: { warmups: [{ ...r2 }] } };
    await pullNow(user.id);
    expect(await warmUpsToTell(user.id)).toEqual([]);
  });

  /** a second person and their warm-up */
  async function begin2(id: string) {
    await db.people.put({
      ...person(id, {
        displayName: 'Omar Haddad',
        firstName: 'Omar',
        lastName: 'Haddad',
        linkedinSlug: 'omar-h',
      }),
      userId: user.id,
    });
    const pre = await previewAutoWarmUp(user, id);
    if (!pre.ok) throw new Error(pre.message);
    const r = await startAutoWarmUp(user, pre.preview, pre.preview.comment);
    if (!r.ok) throw new Error(r.message);
    return r;
  }

  it('says so plainly when no step could run', async () => {
    const { run } = await begin();
    advanceWarmup(api, run.id, { steps: 3, skip: 'failed' });
    await pullNow(user.id);
    const [r] = await warmUpsToTell(user.id);
    const said = await tellWarmUpDone(user, r!);
    expect(said?.text).toBe(
      'Orbit could not run the warm-up for Priya. You can still write to them without it.',
    );
    const first = await cards(user.id, 'new_outreach');
    expect(first[0]?.reasonText).toBe('Orbit could not run the warm-up. Message Priya without it?');
    const chat = await chatOf(P);
    expect(chat.warmUp?.actions.map((a) => a.autoNote)).toEqual([
      'LinkedIn did not take this step, twice. Orbit skipped it.',
      'LinkedIn did not take this step, twice. Orbit skipped it.',
      'LinkedIn did not take this step, twice. Orbit skipped it.',
    ]);
  });

  it('Stop: the server stops first, then the chat leaves the warm-up', async () => {
    const { run, chat } = await begin();
    advanceWarmup(api, run.id);
    await pullNow(user.id);
    expect(await stopWarmUp(user, chat.id)).toEqual({ ok: true });
    expect(api.state.warmups.stopped).toEqual([run.id]);
    expect(api.calls.find((c) => c.route === '/warmups/stop')?.body).toEqual({ warmupId: run.id });
    const after = (await db.chats.get(chat.id))!;
    expect(after.stage).toBe('identified');
    // what ran stays on the chat; nothing is left to do
    expect(after.warmUp?.auto).toMatchObject({ status: 'stopped', stopReason: 'cancelled' });
    expect(after.warmUp?.actions.map((a) => [!!a.doneAt, !!a.skippedAt])).toEqual([
      [true, false],
      [false, true],
      [false, true],
    ]);
    expect((await db.warmups.get(run.id))?.status).toBe('stopped');
    const events = await db.stageEvents.where('chatId').equals(chat.id).toArray();
    expect(events.map((e) => e.reason).sort()).toEqual(['warmup:started', 'warmup:stopped']);
    expect(await cards(user.id, 'warm_up_engage')).toEqual([]);
    expect(await warmUpsToTell(user.id)).toEqual([]);
    // a second Stop does nothing, and a warm-up can be started again
    expect(await stopWarmUp(user, chat.id)).toEqual({ ok: true });
    expect(api.calls.filter((c) => c.route === '/warmups/stop')).toHaveLength(1);
    const again = await begin();
    expect(again.chat.id).toBe(chat.id);
    expect(again.chat.stage).toBe('warming');
    expect(again.chat.warmUp?.auto?.runId).toBe(again.run.id);
  });

  it('does not pretend to have stopped when the server could not be reached', async () => {
    const { chat } = await begin();
    const real = api.fetch;
    const { setOrbitApiFetchForTests } = await import('../integrations/orbitApi');
    setOrbitApiFetchForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/warmups/stop')) throw new TypeError('offline');
      return real(input, init);
    }) as typeof fetch);
    const r = await stopWarmUp(user, chat.id);
    expect(r).toEqual({
      ok: false,
      message: 'Orbit could not stop the warm-up. Check your connection and try again.',
    });
    expect((await db.chats.get(chat.id))?.stage).toBe('warming');
    expect((await db.chats.get(chat.id))?.warmUp?.auto?.status).toBe('running');
  });

  it('a card moved out of Warming up by hand stops the run on the server too', async () => {
    const { run, chat } = await begin();
    // in the pipeline, not with Stop: back to To contact
    await moveChat(user, chat, 'identified', 'user:select');
    expect((await db.chats.get(chat.id))?.warmUp?.auto?.status).toBe('running');
    expect(await stopMovedWarmUps(user)).toBe(1);
    expect(api.state.warmups.stopped).toEqual([run.id]);
    const after = (await db.chats.get(chat.id))!;
    expect(after.stage).toBe('identified');
    expect(after.warmUp?.auto).toMatchObject({ status: 'stopped', stopReason: 'cancelled' });
    // once: nothing is left to stop, and the stopped run coming down changes nothing
    expect(await stopMovedWarmUps(user)).toBe(0);
    advanceWarmup(api, run.id, { steps: 0 });
    await pullNow(user.id);
    expect((await db.chats.get(chat.id))?.stage).toBe('identified');
    expect(api.calls.filter((c) => c.route === '/warmups/stop')).toHaveLength(1);
    // a card still warming up is left alone
    const other = await begin2('9c3f4e5a-6d7b-4c8d-ae9f-1a2b3c4d5e6f');
    expect(await stopMovedWarmUps(user)).toBe(0);
    expect(api.state.warmups.runs.find((r) => r.id === other.run.id)?.status).toBe('running');
  });

  it('a warm-up stopped on another device leaves the warm-up here too', async () => {
    const { run, chat } = await begin();
    advanceWarmup(api, run.id, { stop: 'cancelled' });
    await pullNow(user.id);
    expect((await db.chats.get(chat.id))?.stage).toBe('identified');
  });

  it('a run the server stopped hands the steps left back to the student, with the reason', async () => {
    const { run, chat } = await begin();
    advanceWarmup(api, run.id, { at: '2026-11-16T15:01:00.000Z' });
    advanceWarmup(api, run.id, { stop: 'linkedin_sign_in', at: '2026-11-16T16:00:00.000Z' });
    await pullNow(user.id);
    const after = (await db.chats.get(chat.id))!;
    expect(after.stage).toBe('warming');
    expect(after.warmUp?.auto).toMatchObject({ status: 'stopped', stopReason: 'linkedin_sign_in' });
    // nothing more is run for it, and nobody is told it is done
    expect(await warmUpsToTell(user.id)).toEqual([]);
    expect(await autoWarmUpMode(user)).toBe('server');
  });

  it('turning "Run warm-ups for me" off stops what is under way', async () => {
    const { run, chat } = await begin();
    await updateLimits(user.id, { warmUpAuto: false });
    expect(api.state.warmups.runs.find((r) => r.id === run.id)).toMatchObject({
      status: 'stopped',
      stopReason: 'setting_off',
    });
    await pullNow(user.id);
    const after = (await db.chats.get(chat.id))!;
    expect(after.stage).toBe('warming');
    expect(after.warmUp?.auto?.status).toBe('stopped');
    // the manual labels are back on the steps left
    expect(after.warmUp?.actions[0]?.label).toBe('Look at their profile and what they post about');
  });

  it('hands a manual warm-up already under way to Orbit, on the same card', async () => {
    await updateLimits(user.id, { warmUpAuto: false });
    const manual = await startWarmUpOrOutreach(user, P, 'linkedin', 'manual');
    expect(manual.chat?.stage).toBe('warming');
    expect(manual.chat?.warmUp?.auto).toBeUndefined();
    expect(await cards(user.id, 'warm_up_engage')).toHaveLength(1);
    await updateLimits(user.id, { warmUpAuto: true });
    const { chat, run } = await begin();
    expect(chat.id).toBe(manual.chat!.id);
    expect(chat.warmUp?.auto?.runId).toBe(run.id);
    expect(await db.chats.count()).toBe(1);
    // the reminder card is gone: Orbit does the steps now
    expect(await cards(user.id, 'warm_up_engage')).toEqual([]);
  });

  it('a second Start for someone already being warmed up shows the run under way', async () => {
    const { run } = await begin();
    const pre = await previewAutoWarmUp(user, P);
    expect(pre).toMatchObject({ ok: false, reason: 'running' });
    expect((await db.warmups.get(run.id))?.status).toBe('running');
  });
});

describe('the sample student (the demo simulates the run in this browser)', () => {
  let user: User;
  const NOW = new Date('2026-11-16T15:00:00.000Z'); // Monday 10:00 in New York

  beforeEach(async () => {
    await wipeDatabase();
    setConnectorsMockForTests(true);
    user = await createLocalUser({
      fullName: 'Sam Demo',
      email: 'sam@example.edu',
      timezone: 'America/New_York',
      onboardingCompletedAt: AT,
    });
    await db.people.put({ ...person('p_demo'), userId: user.id });
  });
  afterEach(() => {
    setConnectorsMockForTests(undefined);
  });

  const connect = () =>
    db.integrations.put({
      id: 'int_li',
      userId: user.id,
      provider: 'linkedin_live',
      externalAccountId: 'demo-linkedin-account',
      status: 'active',
      syncState: {},
    } as never);

  it('keeps the manual flow until the sample LinkedIn is connected', async () => {
    expect(await autoWarmUpMode(user)).toBeUndefined();
    const r = await startWarmUpOrOutreach(user, 'p_demo', 'linkedin', 'manual');
    expect(r.chat?.warmUp?.auto).toBeUndefined();
    expect(r.chat?.warmUp?.actions[0]?.url).toBe('https://www.linkedin.com/in/priya-rao/');
  });

  it('simulates the whole run: a step a day, then done and told once', async () => {
    await connect();
    expect(await autoWarmUpMode(user)).toBe('demo');
    // someone the demo gives a post to
    let id = 'p_demo';
    let pre = await previewAutoWarmUp(user, id, NOW);
    for (let i = 0; pre.ok && !pre.preview.post && i < 8; i++) {
      id = `p_demo_${i}`;
      await db.people.put({ ...person(id, { linkedinSlug: `priya-${i}` }), userId: user.id });
      pre = await previewAutoWarmUp(user, id, NOW);
    }
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.mode).toBe('demo');
    expect(pre.preview.post).not.toBeNull();
    expect(pre.preview.comment).toBeTruthy();
    expect(pre.preview.comment).not.toMatch(BANNED);
    const mine = 'My own words for the sample post.';
    const r = await startAutoWarmUp(user, pre.preview, mine, 'manual', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chat.warmUp?.auto).toMatchObject({ status: 'running', comment: mine });
    expect(r.run.steps).toHaveLength(3);
    // nothing has run a second after Start
    expect(await tickDemoWarmUps(user, new Date(NOW.getTime() + 1000))).toBe(0);
    // an hour later the profile view has
    expect(await tickDemoWarmUps(user, new Date(NOW.getTime() + 3_600_000))).toBe(1);
    let chat = (await db.chats.get(r.chat.id))!;
    expect(chat.warmUp?.actions.map((a) => !!a.doneAt)).toEqual([true, false, false]);
    // two weeks on, everything has, each on its own day
    expect(await tickDemoWarmUps(user, new Date(NOW.getTime() + 14 * 86_400_000))).toBe(1);
    chat = (await db.chats.get(r.chat.id))!;
    expect(chat.warmUp?.auto?.status).toBe('done');
    const days = chat.warmUp!.actions.map((a) => a.doneAt!.slice(0, 10));
    expect(new Set(days).size).toBe(3);
    const [toTell] = await warmUpsToTell(user.id);
    expect((await tellWarmUpDone(user, toTell!))?.text).toBe(
      'Orbit finished the warm-up for Priya. Your first message is ready to write.',
    );
    expect(await warmUpsToTell(user.id)).toEqual([]);
  });

  it('can be watched in a minute, stopped, and stops by itself when the setting goes off', async () => {
    await connect();
    const pre = await previewAutoWarmUp(user, 'p_demo', NOW);
    if (!pre.ok) throw new Error(pre.message);
    const r = await startAutoWarmUp(user, pre.preview, pre.preview.comment, 'manual', NOW);
    if (!r.ok) throw new Error(r.message);
    await demoRunNextStep(user, r.run.id, NOW);
    expect((await db.chats.get(r.chat.id))?.warmUp?.actions[0]?.doneAt).toBe(NOW.toISOString());
    expect(await stopWarmUp(user, r.chat.id, NOW)).toEqual({ ok: true });
    expect((await db.chats.get(r.chat.id))?.stage).toBe('identified');
    expect(await db.warmups.get(r.run.id)).toMatchObject({ status: 'stopped', stopReason: 'cancelled' });
    // a new one, then the setting turned off
    const pre2 = await previewAutoWarmUp(user, 'p_demo', NOW);
    if (!pre2.ok) throw new Error(pre2.message);
    const r2 = await startAutoWarmUp(user, pre2.preview, null, 'manual', NOW);
    if (!r2.ok) throw new Error(r2.message);
    await updateLimits(user.id, { warmUpAuto: false });
    await tickDemoWarmUps(user, NOW);
    expect(await db.warmups.get(r2.run.id)).toMatchObject({ status: 'stopped', stopReason: 'setting_off' });
    expect((await db.chats.get(r2.chat.id))?.warmUp?.auto?.status).toBe('stopped');
    expect(await autoWarmUpMode(user)).toBeUndefined();
  });
});
