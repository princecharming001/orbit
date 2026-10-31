import type { Person, Suggestion, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import { type FakeOrbitApi, withReplies } from '../test/fakeOrbitApi';
import { createLocalUser } from './account';
import {
  answerReply,
  autopilotBriefLine,
  autopilotLine,
  autopilotStatus,
  holdSend,
  LOCAL_AUTOPILOT_NOTE,
  localAutopilotStatus,
  pauseAutopilot,
  setMode,
  syncAutopilotCards,
} from './autopilotMode';
import { runAccountFunnel, runLocalFunnel } from './replyFunnel';

// Tuesday Oct 6 2026, 10:00 in New York
const NOW = new Date('2026-10-06T14:00:00.000Z');
let user: User;

const person = (id: string, name: string, org = 'Ramp'): Person =>
  ({
    id,
    userId: user.id,
    displayName: name,
    firstName: name.split(' ')[0],
    lastName: name.split(' ')[1],
    nameNormalized: name.toLowerCase(),
    primaryEmail: `${name.split(' ')[0]!.toLowerCase()}@x.com`,
    emails: [`${name.split(' ')[0]!.toLowerCase()}@x.com`],
    currentOrganizationRaw: org,
    relationshipType: 'unknown',
    strength: 0.5,
    tieScore: 55,
    interactionCount: 3,
    sources: ['gmail'],
    isHuman: true,
    tags: [],
    createdAt: '',
    updatedAt: '',
    timezone: 'America/New_York',
  }) as Person;

async function chatWith(personId: string, replyBody: string, goalId?: string) {
  const sent = '2026-10-05T14:00:00.000Z';
  const got = '2026-10-06T13:00:00.000Z';
  await db.threads.put({
    id: `t_${personId}`,
    userId: user.id,
    externalThreadId: `x_${personId}`,
    subject: 'Coffee chat',
    participantPersonIds: [personId],
    firstMessageAt: sent,
    lastMessageAt: got,
    messageCount: 2,
    isNetworking: true,
    createdAt: sent,
    updatedAt: got,
  } as never);
  await db.messages.put({
    id: `m_out_${personId}`,
    userId: user.id,
    threadId: `t_${personId}`,
    externalMessageId: `xo_${personId}`,
    direction: 'outbound',
    fromEmail: user.email,
    toEmails: ['x@x.com'],
    ccEmails: [],
    sentAt: sent,
    bodyText: 'Would Thursday Oct 8 at 11am or Friday Oct 9 at 2pm work for a quick call?',
    headers: {},
    isAutomated: false,
  } as never);
  await db.messages.put({
    id: `m_in_${personId}`,
    userId: user.id,
    threadId: `t_${personId}`,
    externalMessageId: `xi_${personId}`,
    direction: 'inbound',
    fromEmail: 'x@x.com',
    fromPersonId: personId,
    toEmails: [user.email],
    ccEmails: [],
    sentAt: got,
    bodyText: replyBody,
    headers: {},
    isAutomated: false,
  } as never);
  await db.chats.put({
    id: `c_${personId}`,
    userId: user.id,
    personId,
    goalId,
    stage: 'outreach_sent',
    stageEnteredAt: sent,
    source: 'manual',
    goalTags: [],
    bumpCount: 0,
    priority: 2,
    threadId: `t_${personId}`,
    lastOutboundAt: sent,
    lastInboundAt: got,
    createdAt: sent,
    updatedAt: got,
  });
}

describe('autopilot in local mode (plan 29 §B5)', () => {
  beforeEach(async () => {
    await wipeDatabase();
    user = await createLocalUser({
      fullName: 'Ravi Jain',
      email: 'ravi@umich.edu',
      timezone: 'America/New_York',
    });
    setConnectorsMockForTests(true);
    await db.people.bulkPut([
      person('p_dan', 'Daniel Okafor', 'Goldman Sachs'),
      person('p_chloe', 'Chloe Dubois'),
      person('p_lena', 'Lena Novak'),
    ]);
    await db.userGoals.put({
      id: 'g1',
      userId: user.id,
      kind: 'recruiting',
      title: 'Summer internships',
      targets: { organizations: [], roles: [], geographies: [], people: [] },
      criteria: {},
      priority: 2,
      status: 'active',
      source: 'user',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  });

  it('the status is read from this browser, with the honest line', async () => {
    await db.settings.update(user.id, { autopilotMode: 'assist', autoKinds: ['bump'] });
    await db.outbound.put({
      id: 'o_q',
      userId: user.id,
      personId: 'p_lena',
      channel: 'gmail',
      kind: 'bump',
      bodyDraft: 'Hi again',
      status: 'queued',
      autopilot: true,
      autoSent: true,
      autoRung: 'bump',
      sendAt: '2026-10-07T12:40:00.000Z',
      generatedBy: 'template',
      createdAt: NOW.toISOString(),
    });
    await db.outbound.put({
      id: 'o_s',
      userId: user.id,
      personId: 'p_dan',
      channel: 'gmail',
      kind: 'thank_you',
      bodyDraft: 'Thanks',
      status: 'sent',
      autoSent: true,
      autoRung: 'thank_you',
      sentAt: '2026-10-06T12:41:00.000Z',
      generatedBy: 'template',
      createdAt: NOW.toISOString(),
    });
    const r = await autopilotStatus(user, NOW);
    expect(r.ok && r.local).toBe(true);
    if (!r.ok) return;
    expect(r.note).toBe(LOCAL_AUTOPILOT_NOTE);
    expect(r.status.mode).toBe('assist');
    expect(r.status.queued.map((q) => [q.personName, q.kind, q.sendAt])).toEqual([
      ['Lena Novak', 'bump', '2026-10-07T12:40:00.000Z'],
    ]);
    expect(r.status.sentToday.map((q) => [q.personName, q.autoRung])).toEqual([
      ['Daniel Okafor', 'thank_you'],
    ]);
    expect(r.status.rungs.find((x) => x.kind === 'bump')).toMatchObject({ unlocked: true, needed: 10 });
    expect(r.status.rungs.find((x) => x.kind === 'first_touch')).toMatchObject({
      needed: 20,
      unlocked: false,
    });
    expect(r.status.caps.usedToday).toBe(1);
    // a hold puts the queued one back as a draft
    expect(await holdSend(user, 'o_q')).toEqual({ ok: true });
    expect((await db.outbound.get('o_q'))!).toMatchObject({ status: 'draft', error: 'held' });
    expect((await localAutopilotStatus(user, NOW)).held.map((h) => h.personName)).toEqual(['Lena Novak']);
  });

  it('a pause holds everything and puts the planned sends back; a goal pause is the breaker key', async () => {
    await db.outbound.put({
      id: 'o_q',
      userId: user.id,
      personId: 'p_lena',
      channel: 'gmail',
      kind: 'bump',
      bodyDraft: 'Hi again',
      status: 'queued',
      autopilot: true,
      sendAt: '2026-10-07T12:40:00.000Z',
      generatedBy: 'template',
      createdAt: NOW.toISOString(),
    });
    const until = '2026-10-13T14:00:00.000Z';
    expect(await pauseAutopilot(user, { until }, NOW)).toEqual({
      ok: true,
      pausedUntil: until,
      cancelled: 1,
    });
    expect((await db.settings.get(user.id))!.autopilotPausedUntil).toBe(until);
    expect((await db.outbound.get('o_q'))!.status).toBe('draft');
    expect(await pauseAutopilot(user, { until: null, goalId: 'g1' }, NOW)).toMatchObject({ ok: true });
    await pauseAutopilot(user, { until: '2026-10-20T00:00:00.000Z', goalId: 'g1' }, NOW);
    const s = await localAutopilotStatus(user, NOW);
    expect(s.pausedUntil).toBe(until);
    expect(s.pausedGoals).toEqual([
      {
        goalId: 'g1',
        title: 'Summer internships',
        until: '2026-10-20T00:00:00.000Z',
        reason: 'You paused it',
      },
    ]);
    expect(await setMode(user, 'autopilot')).toEqual({ ok: true, mode: 'autopilot', goalId: null });
    expect((await db.settings.get(user.id))!.autopilotMode).toBe('autopilot');
    expect(await setMode(user, 'off', 'g1')).toEqual({ ok: true, mode: 'off', goalId: 'g1' });
    expect((await db.userGoals.get('g1'))!.autonomyLevel).toBe(0);
  });

  it('the local funnel: a question raises Needs you, the answer drafts the reply, and an unsubscribe trips the breaker', async () => {
    await chatWith('p_dan', 'Happy to. Quick one first: have you applied through the portal yet?', 'g1');
    await chatWith('p_chloe', 'Please stop emailing me.', 'g1');
    const out = await runLocalFunnel(user, NOW);
    expect(out).toMatchObject({ handled: 2, needsYou: 1, closed: 1, breakers: 1 });
    const cards = await db.suggestions.where('userId').equals(user.id).toArray();
    const q = cards.find((c) => c.kind === 'needs_you' && !c.payload.closed)!;
    expect(q.reasonText).toBe(
      'Daniel Okafor asked: "Quick one first: have you applied through the portal yet?" What should I say?',
    );
    expect(q.payload).toMatchObject({
      question: 'Quick one first: have you applied through the portal yet?',
      messageId: 'm_in_p_dan',
    });
    const closed = cards.find((c) => c.kind === 'needs_you' && c.payload.closed)!;
    expect(closed.reasonText).toBe(
      'Chloe Dubois asked to stop. Orbit closed the thread and will not write to them again.',
    );
    expect((await db.people.get('p_chloe'))!.doNotContact).toBe(true);
    expect((await db.chats.get('c_p_chloe'))!.stage).toBe('declined');
    const breaker = cards.find((c) => c.kind === 'breaker')!;
    expect(breaker.reasonText).toBe('Chloe Dubois asked to stop. Paused Ramp first messages. Read it?');
    expect((await db.settings.get(user.id))!.autopilotPausedGoals).toMatchObject({
      g1: { reason: 'unsubscribe', until: null },
    });
    // the status lists the question, and the brief line counts it
    const status = await localAutopilotStatus(user, NOW);
    expect(status.needsYou.map((n) => [n.personName, n.question])).toEqual([
      ['Daniel Okafor', 'Quick one first: have you applied through the portal yet?'],
    ]);
    expect(await autopilotBriefLine(user.id, NOW)).toBe(
      'Autopilot: sent 0, answered 0 replies, booked 0 calls, 1 needs you',
    );
    // a second pass changes nothing
    expect(await runLocalFunnel(user, NOW)).toMatchObject({ handled: 0 });
    // the answer: a reply draft in the thread, the card done, nothing sent
    const a = await answerReply(user, { suggestionId: q.id, answer: 'yes, applied Monday' }, NOW);
    expect(a.ok && a.local).toBe(true);
    if (!a.ok || !a.local) return;
    expect(a.draft.bodyDraft).toContain('yes, applied Monday');
    expect(a.draft).toMatchObject({
      kind: 'reply',
      status: 'draft',
      personId: 'p_dan',
      chatId: 'c_p_dan',
      externalThreadId: 'x_p_dan',
    });
    expect((await db.suggestions.get(q.id))!.status).toBe('done');
    expect(await answerReply(user, { suggestionId: q.id, answer: '  ' }, NOW)).toMatchObject({ ok: false });
  });

  it('the local funnel books a named slot through the calendar invite and raises the prep card', async () => {
    await db.integrations.put({
      id: 'int_demo',
      userId: user.id,
      provider: 'demo',
      status: 'active',
      scopes: [],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    } as never);
    await chatWith(
      'p_lena',
      'Thursday Oct 8 at 11 works for me. Send a calendar invite and I will be there.',
      'g1',
    );
    const out = await runLocalFunnel(user, NOW);
    expect(out.booked).toBe(1);
    const events = await db.events.where('userId').equals(user.id).toArray();
    expect(events).toHaveLength(1);
    expect(events[0]!.startAt).toBe('2026-10-08T15:00:00.000Z');
    expect(events[0]!.inviteSentAt).toBeTruthy();
    const cards = await db.suggestions.where('userId').equals(user.id).toArray();
    expect(cards.map((c) => c.kind).sort()).toEqual(['prep_brief', 'schedule_confirm']);
    const confirm = cards.find((c) => c.kind === 'schedule_confirm')!;
    const draft = await db.outbound.get(confirm.outboundMessageId!);
    expect(draft).toMatchObject({ kind: 'schedule', status: 'draft', personId: 'p_lena' });
    expect(draft!.bodyDraft).toContain('works for me, and the calendar invite is on its way');
  });

  it('autopilotLine counts sends, answered replies, bookings and open questions', () => {
    expect(autopilotLine({ sentToday: [], needsYou: [] })).toBeUndefined();
    const item = (over: Record<string, unknown>) =>
      ({
        draftId: 'd',
        personId: null,
        personName: 'x',
        company: null,
        kind: 'bump',
        subject: null,
        sendAt: null,
        sentAt: null,
        status: 'sent',
        ...over,
      }) as never;
    expect(
      autopilotLine({
        sentToday: [
          item({}),
          item({ kind: 'reply', replyClass: 'interested' }),
          item({ kind: 'schedule', replyClass: 'scheduling', outcome: 'booked' }),
        ],
        needsYou: [item({ status: 'needs_you' }), item({ status: 'needs_you' })],
      }),
    ).toBe('Autopilot: sent 3, answered 2 replies, booked 1 call, 2 need you');
  });
});

describe('autopilot with an account (plan 29 §B5, fake orbit-api)', () => {
  let api: FakeOrbitApi;
  beforeEach(async () => {
    await wipeDatabase();
    ({ api, user } = await signInToFakeApi({ now: NOW.getTime() }));
    await db.people.bulkPut([
      person('p_dan', 'Daniel Okafor', 'Goldman Sachs'),
      person('p_lena', 'Lena Novak'),
    ]);
    withReplies(
      api,
      { id: user.id, firstName: user.firstName ?? 'Maya' },
      [
        { id: 'p_dan', displayName: 'Daniel Okafor', currentOrganizationRaw: 'Goldman Sachs' },
        { id: 'p_lena', displayName: 'Lena Novak', currentOrganizationRaw: 'Ramp' },
      ],
      NOW.getTime(),
    );
  });
  afterEach(async () => {
    await leaveFakeApi();
  });

  it("the server's status is read and its cards written here; hold, pause and answer are one call each", async () => {
    const r = await autopilotStatus(user, NOW);
    expect(r.ok && !r.local).toBe(true);
    if (!r.ok) return;
    expect(r.status.queued.map((q) => q.personName)).toEqual(['Grace Liu', 'Omar Haddad']);
    const cards = await db.suggestions.where('userId').equals(user.id).toArray();
    expect(cards.map((c) => [c.kind, c.payload.personName])).toEqual([['needs_you', 'Daniel Okafor']]);
    expect(cards[0]!.payload.question).toBe('Have you applied through the portal yet?');
    const held = await holdSend(user, 'draft_ap_grace');
    expect(held.ok && held.item?.status).toBe('held');
    expect(api.state.autopilot.held.map((h) => h.personName)).toEqual(['Priya Shah', 'Grace Liu']);
    const a = await answerReply(user, { suggestionId: cards[0]!.id, answer: 'yes, applied Monday' }, NOW);
    expect(a.ok && !a.local && a.draft.body.includes('yes, applied Monday')).toBe(true);
    expect(api.state.autopilot.needsYou).toEqual([]);
    expect((await db.suggestions.get(cards[0]!.id))!.status).toBe('done');
    const paused = await pauseAutopilot(user, { until: '2026-10-20T00:00:00.000Z' }, NOW);
    expect(paused).toMatchObject({ ok: true, pausedUntil: '2026-10-20T00:00:00.000Z' });
    expect(api.state.autopilot.pausedUntil).toBe('2026-10-20T00:00:00.000Z');
    expect(api.state.autopilot.queued).toEqual([]);
    expect(await setMode(user, 'assist')).toEqual({ ok: true, mode: 'assist', goalId: null });
    expect(api.state.autopilot.mode).toBe('assist');
    // the brief line reads the cached status when the server is not asked again
    const line = await autopilotBriefLine(user.id, NOW);
    expect(line).toMatch(/^Autopilot: sent 3, answered 1 reply, booked 0 calls, 1 needs you$/);
  });

  it("the account funnel mirrors the server's replies: Needs you, the closed threads, the breaker, and a booked slot", async () => {
    const out = await runAccountFunnel(user, NOW);
    expect(out).toMatchObject({ needsYou: 1, closed: 2, booked: 1 });
    expect(api.routes()).toContain('/calendar/book');
    const book = api.calls.find((c) => c.route === '/calendar/book')!;
    expect(book.body).toEqual({ draftId: 'draft_lena_slots', slotStart: '2026-10-08T15:00:00Z' });
    expect(api.state.replies.find((r) => r.personName === 'Lena Novak')!.outcome).toBe('booked');
    expect(api.state.autopilot.sentToday.find((i) => i.personName === 'Lena Novak')!.outcome).toBe('booked');
    const cards = await db.suggestions.where('userId').equals(user.id).toArray();
    const kinds = cards
      .map((c) => `${c.kind}:${c.payload.personName ?? ''}${c.payload.closed ? ':closed' : ''}`)
      .sort();
    expect(kinds).toEqual(
      [
        'breaker:Chloe Dubois',
        'needs_you:Chloe Dubois:closed',
        'needs_you:Daniel Okafor',
        'needs_you:Jonah Reyes:closed',
        'prep_brief:Lena Novak',
      ].sort(),
    );
    expect(cards.find((c) => c.kind === 'breaker')!.reasonText).toBe(
      'Chloe Dubois asked to stop. Paused Ramp first messages. Read it?',
    );
    expect(api.state.autopilot.pausedGoals.map((g) => g.goalId)).toEqual(['goal_internships']);
    const prep = cards.find((c) => c.kind === 'prep_brief')!;
    expect(prep.signals.startAt).toBe('2026-10-08T15:00:00Z');
    expect(prep.chatId).toBeUndefined();
    // once is enough: the second pass books nothing and raises nothing
    expect(await runAccountFunnel(user, NOW)).toMatchObject({ handled: 0, booked: 0 });
    expect(api.calls.filter((c) => c.route === '/calendar/book')).toHaveLength(1);
  });

  it('syncAutopilotCards marks a question done once the server no longer lists it', async () => {
    const r = await autopilotStatus(user, NOW);
    if (!r.ok) throw new Error('status');
    const [card] = await db.suggestions.where('userId').equals(user.id).toArray();
    await syncAutopilotCards(user.id, { ...r.status, needsYou: [] }, NOW);
    expect((await db.suggestions.get(card!.id))!.status).toBe('done');
    const again = (await db.suggestions.where('userId').equals(user.id).toArray()).filter(
      (s) => s.status === 'pending',
    );
    expect(again).toEqual([] as Suggestion[]);
  });
});
