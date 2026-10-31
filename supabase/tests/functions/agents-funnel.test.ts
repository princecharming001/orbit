import { messageHash } from '@orbit/core/safety/rules';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { autopilotStatus, holdSend, pauseAutopilot } from '../../functions/_shared/autopilot/autopilot.ts';
import { runCadence } from '../../functions/_shared/cadence/cadence.ts';
import { sqlQueue } from '../../functions/_shared/queue.ts';
import { goalPaused, tripBreaker } from '../../functions/_shared/replies/breaker.ts';
import { matchOfferedSlot, runReplyFunnel } from '../../functions/_shared/replies/funnel.ts';
import { answerReply, DRAFT_CLASSES, maybeAutoReply } from '../../functions/_shared/replies/replies.ts';
import { sendDraft } from '../../functions/_shared/sending/send.ts';
import { makeServices, RESEND_URL } from '../../functions/_shared/services.ts';
import { rollOutcomes } from '../../functions/orbit-worker/handlers/funnel.ts';
import { defaultHandlers, type Job } from '../../functions/orbit-worker/worker.ts';
import {
  addPerson,
  addThread,
  agentConfig,
  anthropic,
  api,
  fakeNet,
  jsonRes,
  type NetCall,
  signedInUser,
} from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

// Tuesday 13 October 2026, 16:00 UTC: noon in New York
const NOW = new Date('2026-10-13T16:00:00Z');
// Thursday 15 October, 14:00 in New York: the slot the student offered
const SLOT = '2026-10-15T18:00:00.000Z';
const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

/** Gmail, Calendar (free, then the created event) and Resend. */
function google(busy: { start: string; end: string }[] = []) {
  let n = 0;
  return (c: NetCall) => {
    if (c.url === GMAIL_SEND) {
      n++;
      return jsonRes(200, { id: `gm-${n}`, threadId: `gt-${n}` });
    }
    if (c.url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/threads/'))
      return jsonRes(200, { messages: [{ id: 'x', labelIds: ['SENT'], internalDate: String(Date.now()) }] });
    if (c.url === 'https://www.googleapis.com/calendar/v3/freeBusy')
      return jsonRes(200, { calendars: { primary: { busy } } });
    if (c.url.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events'))
      return jsonRes(200, { id: `evt-${++n}`, status: 'confirmed' });
    if (c.url === RESEND_URL) return jsonRes(200, { id: 're_1' });
    return undefined;
  };
}

const REPLY = {
  subject: null,
  body: 'Hi Maya,\n\nThat works for me. Thanks for making the time, and I look forward to talking then.\n\nBest,\nSam',
  ask: { kind: 'none', text: '' },
  hooks: [],
};

async function goalFor(userId: string, title = 'Summer internships') {
  const [g] = await t.db.sql<{ id: string }>`
    insert into orbit.goals (user_id, kind, title) values (${userId}::uuid, 'recruiting', ${title}) returning id`;
  return g!.id;
}

async function chatFor(userId: string, personId: string, goalId: string | null, stage = 'outreach_sent') {
  const [c] = await t.db.sql<{ id: string }>`
    insert into orbit.chats (user_id, person_id, goal_id, stage, stage_entered_at, data)
    values (${userId}::uuid, ${personId}::uuid, ${goalId}::uuid, ${stage}, now(), '{}'::jsonb) returning id`;
  return c!.id;
}

/** A level 2 student with a goal, and one person with a two-way Gmail thread whose newest message has `cls`. */
async function replyOf(
  cls: string,
  body: string,
  over: { level?: number; score?: number; name?: string; offered?: string[] } = {},
) {
  const { userId, token } = await signedInUser(t, { scopes: SCOPES });
  await t.db
    .sql`update orbit.users set autonomy_level = ${over.level ?? 2}::smallint where id = ${userId}::uuid`;
  const goalId = await goalFor(userId);
  const name = over.name ?? 'Maya Chen';
  const personId = await addPerson(t, userId, {
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}.${Math.random().toString(36).slice(2, 6)}@example.com`,
    org: 'Ramp',
    score: over.score ?? 55,
    timezone: 'America/New_York',
  });
  const chatId = await chatFor(userId, personId, goalId);
  const th = await addThread(t, userId, personId, [
    { direction: 'out', at: '2026-10-12T15:00:00Z', body: 'Would you have time for a short call next week?' },
    { direction: 'in', at: '2026-10-13T15:00:00Z', body, replyClass: cls },
  ]);
  // the sent draft the reply answers, with the slots it offered when the test says so
  const [sent] = await t.db.sql<{ id: string }>`
    insert into orbit.drafts (user_id, person_id, chat_id, goal_id, channel, kind, body, status, sent_at,
                              thread_external_id, provider_message_id, offered_slots, ask)
    values (${userId}::uuid, ${personId}::uuid, ${chatId}::uuid, ${goalId}::uuid, 'gmail', 'reply',
            'Would any of these times work?', 'sent', '2026-10-12T15:00:00Z'::timestamptz, ${th.externalId},
            ${`${th.externalId}-m0`}, ${over.offered ? JSON.stringify(over.offered) : null}::jsonb,
            ${{ kind: 'call', text: 'times', slots: over.offered ?? [] }}::jsonb)
    returning id`;
  return { userId, token, goalId, personId, chatId, messageId: th.messageIds[1]!, sentDraftId: sent!.id };
}

const drafts = (userId: string) =>
  t.db.sql<{ id: string; status: string; kind: string; needs: string[]; outcome: string | null }>`
    select id, status, kind, needs, outcome from orbit.drafts where user_id = ${userId}::uuid and kind = 'reply'
       and status not in ('sent') order by created_at`;
const cards = (userId: string) =>
  t.db.sql<{ kind: string; status: string; reason_text: string; payload: Record<string, unknown> }>`
    select kind, status, reason_text, payload from orbit.suggestions where user_id = ${userId}::uuid order by created_at`;
const audit = (userId: string) =>
  t.db.sql<{ actor: string; action: string }>`
    select actor, action from orbit.audit_log where user_id = ${userId}::uuid order by id`;

describe('the class table on the server (plan 29 §B2.3)', () => {
  it('DRAFT_CLASSES is every class with a drafted next action', () => {
    expect([...DRAFT_CLASSES].sort()).toEqual(
      ['interested', 'not_now', 'objection', 'referral', 'scheduling', 'thanks'].sort(),
    );
  });

  it('interested without a question: the slots reply drafts and goes on its own at level 2; with a question it waits', async () => {
    const claude = anthropic(() => REPLY);
    const net = fakeNet(claude.answer, google());
    const s = makeServices(agentConfig(net), { db: t.db, now: () => NOW });
    const plain = await replyOf('interested', 'This sounds great, happy to help however I can.');
    const r = await maybeAutoReply(t.db, plain.userId, plain.messageId, { services: s });
    expect(r.action).toBe('auto_sent');
    const [d] = await t.db.sql<{ status: string; offered_slots: string[] | null; auto_rung: string }>`
      select status, offered_slots, auto_rung from orbit.drafts where user_id = ${plain.userId}::uuid and status = 'approved'`;
    expect(d).toMatchObject({ status: 'approved', auto_rung: 'reply' });
    // the slots the reply offered are kept on the draft, so a later scheduling reply can book one
    expect(Array.isArray(d!.offered_slots) && d!.offered_slots.length).toBe(3);
    expect((await audit(plain.userId)).map((a) => a.action)).toEqual(
      expect.arrayContaining(['draft.auto_approve', 'reply.auto']),
    );

    const asking = await replyOf('interested', 'Happy to help. Have you applied through the portal yet?');
    const held = await maybeAutoReply(t.db, asking.userId, asking.messageId, { services: s });
    expect(held).toMatchObject({
      action: 'drafted',
      reasons: expect.arrayContaining(['reply class interested with a question']),
    });
  });

  it('question: no draft, a Needs you card with the question quoted, a notification, and the bumps wait', async () => {
    const net = fakeNet(google());
    const s = makeServices(agentConfig(net), { db: t.db, now: () => NOW });
    const q = await replyOf(
      'question',
      'Happy to. Quick one first: have you applied through the portal yet?',
      {
        name: 'Daniel Okafor',
      },
    );
    const r = await maybeAutoReply(t.db, q.userId, q.messageId, { services: s });
    expect(r.action).toBe('needs_you');
    expect(await drafts(q.userId)).toEqual([]);
    const [card] = await cards(q.userId);
    expect(card).toMatchObject({ kind: 'needs_you', status: 'pending' });
    expect(card!.reason_text).toContain('Daniel Okafor asked: "');
    expect(card!.reason_text).toContain('applied through the portal yet?');
    expect(card!.payload.question).toContain('applied through the portal');
    const notes = await t.db.sql<{ kind: string; title: string; body: string | null }>`
      select kind, title, body from orbit.notifications where user_id = ${q.userId}::uuid`;
    expect(notes).toEqual([
      {
        kind: 'reply_received',
        title: 'Daniel asked one thing',
        body: 'Answer it in one line and Orbit drafts the reply.',
      },
    ]);
    // idempotent: a second pass raises nothing new
    await maybeAutoReply(t.db, q.userId, q.messageId, { services: s });
    expect(await cards(q.userId)).toHaveLength(1);
    // the cadence holds this person's bump while the question is open
    await t.db.sql`update orbit.chats set data = ${{
      lastOutboundAt: '2026-10-01T15:00:00Z',
      firstOutreachAt: '2026-10-01T15:00:00Z',
      outreachChannel: 'email',
    }}::jsonb where id = ${q.chatId}::uuid`;
    await t.db.sql`delete from orbit.messages where user_id = ${q.userId}::uuid and direction = 'in'`;
    const summary = await runCadence(s, q.userId);
    const bumps = await t.db.sql<{ id: string }>`
      select id from orbit.drafts where user_id = ${q.userId}::uuid and kind = 'bump'`;
    expect(bumps).toEqual([]);
    expect(summary.drafted).toBe(0);
  });

  it('objection, not_now and referral draft for approval and never go on their own; thanks goes on its own', async () => {
    const claude = anthropic(() => REPLY);
    const net = fakeNet(claude.answer, google());
    const s = makeServices(agentConfig(net), { db: t.db, now: () => NOW });
    for (const [cls, body] of [
      ['objection', "I'm not sure a referral makes sense before you've applied."],
      ['not_now', 'Swamped until after the launch. Ping me in November and I will make time.'],
      ['referral', 'Not really my area, but my colleague Raj runs that team.'],
    ] as const) {
      const r = await replyOf(cls, body);
      const out = await maybeAutoReply(t.db, r.userId, r.messageId, { services: s });
      expect(out, cls).toMatchObject({
        action: 'drafted',
        reasons: expect.arrayContaining([`reply class ${cls}`]),
      });
      expect(
        (await drafts(r.userId)).map((d) => d.status),
        cls,
      ).toEqual(['draft']);
    }
    const thanks = await replyOf('thanks', 'Thanks for the note, appreciate you reaching out. Good luck.');
    expect((await maybeAutoReply(t.db, thanks.userId, thanks.messageId, { services: s })).action).toBe(
      'auto_sent',
    );
    const ooo = await replyOf('out_of_office', 'I am out of the office until October 20.');
    expect(await maybeAutoReply(t.db, ooo.userId, ooo.messageId, { services: s })).toEqual({
      action: 'none',
      reason: 'class out_of_office',
    });
    const other = await replyOf('other', 'Noted.');
    expect(await maybeAutoReply(t.db, other.userId, other.messageId, { services: s })).toEqual({
      action: 'none',
      reason: 'class other',
    });
    expect(await drafts(other.userId)).toEqual([]);
  });

  it('decline: the chat closes, do not contact, the student is told, no draft; a second decline today trips the breaker', async () => {
    const net = fakeNet(google());
    const s = makeServices(agentConfig(net), { db: t.db, now: () => NOW });
    const first = await replyOf('decline', "I'll pass on this one. Best of luck with the search.", {
      name: 'Jonah Reyes',
    });
    const out = await maybeAutoReply(t.db, first.userId, first.messageId, { services: s });
    expect(out).toEqual({ action: 'closed', reason: 'decline' });
    const [p] = await t.db.sql<{ do_not_contact: boolean }>`
      select do_not_contact from orbit.people where id = ${first.personId}::uuid`;
    expect(p!.do_not_contact).toBe(true);
    const [c] = await t.db.sql<{
      stage: string;
    }>`select stage from orbit.chats where id = ${first.chatId}::uuid`;
    expect(c!.stage).toBe('declined');
    expect(await drafts(first.userId)).toEqual([]);
    const told = await cards(first.userId);
    expect(told.map((x) => x.kind)).toEqual(['needs_you']);
    expect(told[0]!.reason_text).toBe(
      'Jonah Reyes declined. Orbit closed the thread and will not write to them again.',
    );
    const [u] = await t.db.sql<{ settings: Record<string, unknown> }>`
      select settings from orbit.users where id = ${first.userId}::uuid`;
    expect(goalPaused(u!.settings, first.goalId, NOW)).toBe(false);
    // the second decline today, for the same goal
    const second = await addPerson(t, first.userId, {
      name: 'Victor Castro',
      email: 'victor@example.com',
      score: 50,
    });
    await chatFor(first.userId, second, first.goalId);
    const th = await addThread(t, first.userId, second, [
      { direction: 'out', at: '2026-10-12T15:00:00Z', body: 'Could we talk?' },
      { direction: 'in', at: '2026-10-13T15:30:00Z', body: 'No thanks, not for me.', replyClass: 'decline' },
    ]);
    await maybeAutoReply(t.db, first.userId, th.messageIds[1]!, { services: s });
    const [after] = await t.db.sql<{ settings: Record<string, unknown> }>`
      select settings from orbit.users where id = ${first.userId}::uuid`;
    expect(goalPaused(after!.settings, first.goalId, NOW)).toBe(true);
    const breaker = (await cards(first.userId)).find((x) => x.kind === 'breaker')!;
    expect(breaker.reason_text).toBe(
      'Victor Castro declined, the second today. Paused Summer internships first messages. Read it?',
    );
  });

  it('unsubscribe trips the breaker at once and names the company; the paused goal holds an auto send and the cadence', async () => {
    const claude = anthropic(() => REPLY);
    const net = fakeNet(claude.answer, google());
    const s = makeServices(agentConfig(net), { db: t.db, now: () => NOW });
    const r = await replyOf('unsubscribe', 'Please stop emailing me.', { name: 'Chloe Dubois' });
    expect(await maybeAutoReply(t.db, r.userId, r.messageId, { services: s })).toEqual({
      action: 'unsubscribed',
    });
    const breaker = (await cards(r.userId)).find((x) => x.kind === 'breaker')!;
    expect(breaker.reason_text).toBe('Chloe Dubois asked to stop. Paused Ramp first messages. Read it?');
    expect(breaker.payload).toMatchObject({ goalId: r.goalId, reason: 'unsubscribe', company: 'Ramp' });
    expect((await audit(r.userId)).map((a) => a.action)).toContain('autopilot.breaker');
    // an interested reply from someone else on the same goal now waits for the student
    const other = await addPerson(t, r.userId, {
      name: 'Grace Liu',
      email: 'grace@example.com',
      score: 60,
      timezone: 'America/New_York',
    });
    await chatFor(r.userId, other, r.goalId);
    const th = await addThread(t, r.userId, other, [
      { direction: 'out', at: '2026-10-12T15:00:00Z', body: 'Could we talk?' },
      { direction: 'in', at: '2026-10-13T15:30:00Z', body: 'Sure, happy to.', replyClass: 'interested' },
    ]);
    const held = await maybeAutoReply(t.db, r.userId, th.messageIds[1]!, { services: s });
    expect(held).toMatchObject({ action: 'drafted', reasons: ['goal paused by the breaker'] });
    // and the send job holds an agent-approved draft of that goal
    if (held.action !== 'drafted') return;
    const [row] = await t.db.sql<{ channel: 'gmail'; subject: string | null; body: string }>`
      update orbit.drafts set status = 'approved', send_at = ${NOW}::timestamptz, auto_rung = 'reply'
       where id = ${held.draftId}::uuid returning channel, subject, body`;
    await t.db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${r.userId}::uuid, 'agent', 'draft.auto_approve', 'drafts', ${held.draftId},
              ${{ hash: messageHash(row!) }}::jsonb)`;
    const sent = await sendDraft(s, held.draftId);
    expect(sent).toEqual({ status: 'held', reason: 'goal_paused' });
    // the status lists the pause with the breaker's words
    const status = await autopilotStatus(t.db, r.userId, NOW);
    expect(status.pausedGoals).toEqual([
      {
        goalId: r.goalId,
        title: 'Summer internships',
        until: null,
        reason: 'Chloe Dubois asked to stop. Paused Ramp first messages.',
      },
    ]);
    // lifting it from the pause route
    await pauseAutopilot(t.db, r.userId, { until: null, goalId: r.goalId }, NOW);
    expect((await autopilotStatus(t.db, r.userId, NOW)).pausedGoals).toEqual([]);
  });

  it('a Gmail send error trips the breaker too', async () => {
    const net = fakeNet((c) =>
      c.url === GMAIL_SEND ? jsonRes(400, { error: { message: 'Invalid To header' } }) : google()(c),
    );
    const s = makeServices(agentConfig(net), { db: t.db, now: () => NOW });
    const r = await replyOf('interested', 'Sure.', { level: 0 });
    const [d] = await t.db.sql<{ id: string }>`
      insert into orbit.drafts (user_id, person_id, chat_id, goal_id, channel, kind, body, status, send_at, autonomy_level)
      values (${r.userId}::uuid, ${r.personId}::uuid, ${r.chatId}::uuid, ${r.goalId}::uuid, 'gmail', 'bump', 'Hi again',
              'approved', ${NOW}::timestamptz, 0) returning id`;
    const hash = messageHash({ channel: 'gmail', subject: null, body: 'Hi again' });
    await t.db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${r.userId}::uuid, 'user', 'draft.approve', 'drafts', ${d!.id}, ${{ hash }}::jsonb)`;
    const out = await sendDraft(s, d!.id);
    expect(out.status).toBe('failed');
    const [u] = await t.db.sql<{ settings: Record<string, unknown> }>`
      select settings from orbit.users where id = ${r.userId}::uuid`;
    expect(goalPaused(u!.settings, r.goalId, NOW)).toBe(true);
    expect((await cards(r.userId)).find((x) => x.kind === 'breaker')?.reason_text).toContain(
      'could not be sent to',
    );
  });
});

describe('booking from a confirmed slot (plan 29 §B2.3)', () => {
  it('matchOfferedSlot: a named time within fifteen minutes of an offered slot is that slot', () => {
    const ref = new Date('2026-10-13T15:00:00Z');
    expect(matchOfferedSlot('Thursday at 2pm works for me.', [SLOT], ref, 'America/New_York')).toBe(SLOT);
    expect(matchOfferedSlot('Thursday at 2:10pm works for me.', [SLOT], ref, 'America/New_York')).toBe(SLOT);
    expect(matchOfferedSlot('Friday at 2pm works for me.', [SLOT], ref, 'America/New_York')).toBeUndefined();
    expect(matchOfferedSlot('Sounds good, send an invite.', [SLOT], ref, 'America/New_York')).toBeUndefined();
  });

  it('a scheduling reply naming an offered slot books the call, confirms on its own at level 2 and records it', async () => {
    const claude = anthropic(() => REPLY);
    const net = fakeNet(claude.answer, google());
    const cfg = agentConfig(net);
    const s = makeServices(cfg, { db: t.db, now: () => NOW });
    const r = await replyOf('scheduling', 'Thursday at 2pm works for me. Send a calendar invite.', {
      name: 'Lena Novak',
      offered: ['2026-10-14T18:00:00.000Z', SLOT, '2026-10-16T18:00:00.000Z'],
    });
    const out = await runReplyFunnel(s, r.userId, r.messageId);
    expect(out).toMatchObject({ action: 'booked', slotStart: SLOT, eventId: expect.stringMatching(/^evt-/) });
    if (out.action !== 'booked') return;
    expect(out.confirmation.action).toBe('auto_sent');
    const ev = net.calls.find((x) => x.url.includes('/calendar/v3/calendars/primary/events'))!;
    expect(ev.body).toMatchObject({ start: { dateTime: new Date(SLOT).toISOString() } });
    const [event] = await t.db.sql<{ start_at: Date; chat_id: string; attendee_person_ids: string[] }>`
      select start_at, chat_id, attendee_person_ids from orbit.calendar_events where user_id = ${r.userId}::uuid`;
    expect(new Date(event!.start_at).toISOString()).toBe(SLOT);
    expect(event!.chat_id).toBe(r.chatId);
    expect(event!.attendee_person_ids).toEqual([r.personId]);
    const [chat] = await t.db.sql<{
      stage: string;
    }>`select stage from orbit.chats where id = ${r.chatId}::uuid`;
    expect(chat!.stage).toBe('scheduled');
    const [sent] = await t.db.sql<{
      outcome: string;
    }>`select outcome from orbit.drafts where id = ${r.sentDraftId}::uuid`;
    expect(sent!.outcome).toBe('booked');
    const [confirmation] = await t.db.sql<{
      status: string;
      body: string;
      offered_slots: string[];
      ask: { confirms?: unknown };
    }>`
      select status, body, offered_slots, ask from orbit.drafts where id = ${out.draftId}::uuid`;
    expect(confirmation!.status).toBe('approved');
    expect(confirmation!.offered_slots).toEqual([SLOT]);
    expect(confirmation!.ask.confirms).toMatchObject({ start: SLOT });
    const actions = (await audit(r.userId)).map((a) => `${a.actor}:${a.action}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        'agent:calendar.book',
        'agent:call.booked',
        'agent:draft.auto_approve',
        'agent:reply.auto',
      ]),
    );
    // idempotent: the funnel again books nothing twice
    const again = await runReplyFunnel(s, r.userId, r.messageId);
    expect(again).toMatchObject({ action: 'booked', eventId: out.eventId });
    expect(net.calls.filter((x) => x.url.includes('/calendar/v3/calendars/primary/events'))).toHaveLength(1);
    // the status shows the booked confirmation under sent today once the job sends it
    const handlers = defaultHandlers(cfg);
    await handlers['send.draft']!(
      {
        queue: 'orbit_send',
        msgId: 0,
        readCt: 1,
        kind: 'send.draft',
        userId: r.userId,
        payload: { draftId: out.draftId },
      } satisfies Job,
      { db: t.db, queue: sqlQueue(t.db), now: () => NOW },
    );
    const status = await autopilotStatus(t.db, r.userId, NOW);
    expect(status.sentToday.map((x) => [x.personName, x.replyClass, x.autoRung])).toEqual([
      ['Lena Novak', 'scheduling', 'schedule'],
    ]);
  });

  it('a time that matches no offered slot, or a slot the calendar now holds, gets the slots reply instead', async () => {
    const claude = anthropic(() => REPLY);
    const net = fakeNet(claude.answer, google([{ start: SLOT, end: '2026-10-15T18:30:00Z' }]));
    const s = makeServices(agentConfig(net), { db: t.db, now: () => NOW });
    const busy = await replyOf('scheduling', 'Thursday at 2pm works for me.', { offered: [SLOT] });
    const out = await runReplyFunnel(s, busy.userId, busy.messageId);
    expect(out.action).toBe('auto_sent');
    expect(net.calls.filter((x) => x.url.includes('/calendar/v3/calendars/primary/events'))).toHaveLength(0);
    const none = await replyOf('scheduling', 'Friday at 9am works for me.', { offered: [SLOT] });
    const out2 = await runReplyFunnel(s, none.userId, none.messageId);
    expect(out2.action).toBe('auto_sent');
    expect(await t.db.sql`select 1 from orbit.calendar_events where user_id = ${none.userId}::uuid`).toEqual(
      [],
    );
  });

  it('at level 1 the booking still happens and the confirmation waits for a tap', async () => {
    const claude = anthropic(() => REPLY);
    const net = fakeNet(claude.answer, google());
    const s = makeServices(agentConfig(net), { db: t.db, now: () => NOW });
    const r = await replyOf('scheduling', 'Thursday at 2pm works.', { offered: [SLOT], level: 1 });
    const out = await runReplyFunnel(s, r.userId, r.messageId);
    expect(out).toMatchObject({
      action: 'booked',
      confirmation: { action: 'drafted', reasons: ['autonomy level 1'] },
    });
  });
});

describe('Needs you and /replies/answer (plan 29 §B2.3)', () => {
  it('a draft that asks the student cannot be approved (409 needs_input); the answer drafts the reply around it', async () => {
    const asked = anthropic(() => ({
      ...REPLY,
      body: 'Hi Daniel,\n\nThanks for getting back to me, and for the pointer on the portal. [ASK USER: Have you applied through the portal yet?] Either way I would love to compare notes on the team for fifteen minutes next week, whenever suits you.\n\nBest,\nSam',
    }));
    const net = fakeNet(asked.answer, google());
    const call = api(t, net);
    const s = makeServices(agentConfig(net), { db: t.db, now: () => NOW });
    const q = await replyOf('question', 'Quick one first: have you applied through the portal yet?', {
      name: 'Daniel Okafor',
    });
    await maybeAutoReply(t.db, q.userId, q.messageId, { services: s });
    // the student asks for a draft before answering: the model asks, the draft says so as data
    const drafted = await call<{ draft: { id: string; needsInput: string[]; body: string } }>(
      '/replies/draft',
      q.token,
      {
        messageId: q.messageId,
      },
    );
    expect(drafted.body.draft.needsInput).toEqual(['Have you applied through the portal yet?']);
    const [row] = await t.db.sql<{ needs: string[]; ask: { question?: string } }>`
      select needs, ask from orbit.drafts where id = ${drafted.body.draft.id}::uuid`;
    expect(row).toEqual({
      needs: ['answer'],
      ask: expect.objectContaining({ question: 'Have you applied through the portal yet?' }),
    });
    const approve = await call<{ error: { code: string } }>('/drafts/approve', q.token, {
      draftId: drafted.body.draft.id,
    });
    expect(approve.status).toBe(409);
    expect(approve.body.error.code).toBe('needs_input');
    // the answer: the model now writes it in; the old draft steps aside, the card is done
    asked.requests.length = 0;
    net.use((c) =>
      c.url.startsWith('https://api.anthropic.com/')
        ? jsonRes(200, {
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ...REPLY,
                  body: 'Hi Daniel,\n\nYes, I applied on Monday through the portal, so the referral path is open. Thanks for checking, and I would still love fifteen minutes to compare notes on the team next week.\n\nBest,\nSam',
                }),
              },
            ],
            stop_reason: 'end_turn',
            stop_sequence: null,
            stop_details: null,
            usage: {
              input_tokens: 10,
              output_tokens: 10,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          })
        : undefined,
    );
    const answered = await call<{
      draft: { id: string; needsInput: string[]; body: string; status: string };
    }>('/replies/answer', q.token, { draftId: drafted.body.draft.id, answer: 'yes, applied Monday' });
    expect(answered.status).toBe(200);
    expect(answered.body.draft.needsInput).toEqual([]);
    expect(answered.body.draft.body).toContain('applied on Monday');
    expect(answered.body.draft.status).toBe('draft');
    const prompt = net.calls.filter((c) => c.url.startsWith('https://api.anthropic.com/')).at(-1)!;
    expect(JSON.stringify(prompt.body)).toContain(
      "answer to what they asked, in Sam's words: yes, applied Monday",
    );
    const [old] = await t.db.sql<{ status: string; cancel_reason: string }>`
      select status, cancel_reason from orbit.drafts where id = ${drafted.body.draft.id}::uuid`;
    expect(old).toEqual({ status: 'cancelled', cancel_reason: 'answered' });
    const [m] = await t.db.sql<{
      answer: string;
    }>`select answer from orbit.messages where id = ${q.messageId}::uuid`;
    expect(m!.answer).toBe('yes, applied Monday');
    expect((await cards(q.userId)).map((c) => [c.kind, c.status])).toEqual([['needs_you', 'done']]);
    expect((await autopilotStatus(t.db, q.userId, NOW)).needsYou).toEqual([]);
    // by messageId works too, and an empty answer is refused
    const again = await call<{ draft: { body: string } }>('/replies/answer', q.token, {
      messageId: q.messageId,
      answer: 'yes, Monday',
    });
    expect(again.status).toBe(200);
    const empty = await call<{ error: { code: string } }>('/replies/answer', q.token, {
      messageId: q.messageId,
      answer: '  ',
    });
    expect(empty.status).toBe(400);
  });

  it('without a model the answer still carries the reply, and the template never leaves a blank', async () => {
    const net = fakeNet(google());
    const s = makeServices(agentConfig(net, {}), { db: t.db, now: () => NOW });
    const q = await replyOf('question', 'Are you a junior or a senior?', { name: 'Priya Shah' });
    const r = await answerReply(s, q.userId, {
      messageId: q.messageId,
      answer: "I'm a junior, graduating in 2027",
    });
    expect(r.draft.body).toContain("I'm a junior, graduating in 2027");
    expect(r.draft.body).not.toMatch(/\[ASK USER/);
    expect(r.draft.needs).toEqual([]);
  });

  it('the status lists a question under needsYou with the question, and the email goes only when the app has been closed four hours', async () => {
    const net = fakeNet(google());
    const resend = (c: NetCall) => c.url === RESEND_URL;
    const withKey = makeServices(agentConfig(net, { resendKey: 're_test' }), { db: t.db, now: () => NOW });
    const q = await replyOf('question', 'Which team are you aiming for?', { name: 'Omar Haddad' });
    // the session was just used: no email
    await maybeAutoReply(t.db, q.userId, q.messageId, { services: withKey });
    expect(net.calls.filter(resend)).toHaveLength(0);
    const status = await autopilotStatus(t.db, q.userId, NOW);
    expect(status.needsYou).toEqual([
      expect.objectContaining({
        personName: 'Omar Haddad',
        status: 'needs_you',
        question: 'Which team are you aiming for?',
        messageId: q.messageId,
      }),
    ]);
    // the app has been closed for five hours: one email, with the name and nothing of the reply
    await t.db
      .sql`update orbit.sessions set last_used_at = ${new Date(NOW.getTime() - 5 * 3_600_000)}::timestamptz,
                    created_at = ${new Date(NOW.getTime() - 6 * 3_600_000)}::timestamptz where user_id = ${q.userId}::uuid`;
    await t.db.sql`delete from orbit.suggestions where user_id = ${q.userId}::uuid`;
    await maybeAutoReply(t.db, q.userId, q.messageId, { services: withKey });
    const mails = net.calls.filter(resend);
    expect(mails).toHaveLength(1);
    const body = mails[0]!.body as { to: string[]; subject: string; text: string };
    expect(body.subject).toBe('Omar asked one thing');
    expect(body.text).toContain('Omar asked one thing. Reply in Orbit.');
    expect(body.text).not.toContain('team');
    expect(mails[0]!.headers.authorization).toBe('Bearer re_test');
    // without a key, nothing is mailed and nothing fails
    const noKey = makeServices(agentConfig(net, {}), { db: t.db, now: () => NOW });
    expect(noKey.mailer.configured).toBe(false);
    await t.db.sql`delete from orbit.suggestions where user_id = ${q.userId}::uuid`;
    await maybeAutoReply(t.db, q.userId, q.messageId, { services: noKey });
    expect(net.calls.filter(resend)).toHaveLength(1);
  });
});

describe('outcomes and the autopilot routes (plan 29 §B2.5, §B4)', () => {
  it('outcomes.roll marks sent drafts silent after QUIET_DAYS without a reply; classify sets replied or declined', async () => {
    const { userId } = await signedInUser(t);
    const p = await addPerson(t, userId, { name: 'Quiet Person', email: 'quiet@example.com' });
    const chat = await chatFor(userId, p, null);
    const rows = await t.db.sql<{ id: string }>`
      insert into orbit.drafts (user_id, person_id, chat_id, channel, kind, body, status, sent_at)
      values (${userId}::uuid, ${p}::uuid, ${chat}::uuid, 'gmail', 'first_touch', 'old', 'sent', ${new Date(NOW.getTime() - 8 * 86_400_000)}::timestamptz),
             (${userId}::uuid, ${p}::uuid, ${chat}::uuid, 'gmail', 'bump', 'new', 'sent', ${new Date(NOW.getTime() - 2 * 86_400_000)}::timestamptz),
             (${userId}::uuid, ${p}::uuid, ${chat}::uuid, 'gmail', 'bump', 'answered', 'sent', ${new Date(NOW.getTime() - 9 * 86_400_000)}::timestamptz)
      returning id`;
    await t.db
      .sql`update orbit.drafts set replied_at = ${NOW}::timestamptz, outcome = 'replied' where id = ${rows[2]!.id}::uuid`;
    expect(await rollOutcomes(t.db, NOW)).toBeGreaterThanOrEqual(1);
    const after = await t.db.sql<{ body: string; outcome: string | null }>`
      select body, outcome from orbit.drafts where user_id = ${userId}::uuid order by sent_at`;
    expect(after).toEqual([
      { body: 'answered', outcome: 'replied' },
      { body: 'old', outcome: 'silent' },
      { body: 'new', outcome: null },
    ]);
  });

  it('/autopilot/status, /autopilot/hold, /autopilot/pause and /autopilot/mode answer through the api', async () => {
    const net = fakeNet(google());
    const call = api(t, net, { now: () => NOW });
    const r = await replyOf('interested', 'Sure.', { level: 1 });
    // a level 1 approval queued for the morning
    const [d] = await t.db.sql<{ id: string }>`
      insert into orbit.drafts (user_id, person_id, chat_id, goal_id, channel, kind, body, status, send_at, autonomy_level, auto_rung)
      values (${r.userId}::uuid, ${r.personId}::uuid, ${r.chatId}::uuid, ${r.goalId}::uuid, 'gmail', 'bump', 'Hi again',
              'approved', ${new Date(NOW.getTime() + 20 * 3_600_000)}::timestamptz, 1, 'bump') returning id`;
    const status = await call<{
      mode: string;
      queued: { draftId: string; status: string }[];
      rungs: { kind: string }[];
      caps: { autoPerDay: number };
    }>('/autopilot/status', r.token);
    expect(status.status).toBe(200);
    expect(status.body.mode).toBe('assist');
    expect(status.body.queued).toEqual([
      expect.objectContaining({ draftId: d!.id, status: 'queued', personName: 'Maya Chen' }),
    ]);
    expect(status.body.rungs.map((x) => x.kind)).toEqual(['bump', 'thank_you', 'schedule', 'first_touch']);
    expect(status.body.caps.autoPerDay).toBe(5);
    const held = await call<{ item: { status: string; reason: string } }>('/autopilot/hold', r.token, {
      draftId: d!.id,
    });
    expect(held.body.item).toMatchObject({ status: 'held', reason: 'You held it.' });
    const after = await call<{ queued: unknown[]; held: { draftId: string }[] }>(
      '/autopilot/status',
      r.token,
    );
    expect(after.body.queued).toEqual([]);
    expect(after.body.held.map((x) => x.draftId)).toEqual([d!.id]);
    // pause everything: an agent-approved send goes back to a draft and the status says paused
    await t.db
      .sql`update orbit.drafts set status = 'approved', send_at = ${new Date(NOW.getTime() + 20 * 3_600_000)}::timestamptz where id = ${d!.id}::uuid`;
    const until = new Date(NOW.getTime() + 7 * 86_400_000).toISOString();
    const paused = await call<{ pausedUntil: string; cancelled: number }>('/autopilot/pause', r.token, {
      until,
    });
    expect(paused.body).toEqual({ pausedUntil: until, goalId: null, cancelled: 1 });
    const [u] = await t.db.sql<{
      settings: Record<string, unknown>;
    }>`select settings from orbit.users where id = ${r.userId}::uuid`;
    expect(u!.settings.autopilot_paused_until).toBe(until);
    const lifted = await call<{ pausedUntil: null }>('/autopilot/pause', r.token, { until: null });
    expect(lifted.body.pausedUntil).toBeNull();
    // the mode, for the account and for one goal
    const mode = await call<{ mode: string; goalId: string | null }>('/autopilot/mode', r.token, {
      mode: 'autopilot',
    });
    expect(mode.body).toEqual({ mode: 'autopilot', goalId: null });
    const [lvl] = await t.db.sql<{ autonomy_level: number; settings: Record<string, unknown> }>`
      select autonomy_level, settings from orbit.users where id = ${r.userId}::uuid`;
    expect(lvl).toMatchObject({
      autonomy_level: 2,
      settings: expect.objectContaining({ autopilot_mode: 'autopilot' }),
    });
    const goal = await call<{ mode: string; goalId: string }>('/autopilot/mode', r.token, {
      mode: 'off',
      goalId: r.goalId,
    });
    expect(goal.body).toEqual({ mode: 'off', goalId: r.goalId });
    const [g] = await t.db.sql<{
      autonomy_level: number;
    }>`select autonomy_level from orbit.goals where id = ${r.goalId}::uuid`;
    expect(g!.autonomy_level).toBe(0);
    const bad = await call<{ error: { code: string } }>('/autopilot/mode', r.token, { mode: 'turbo' });
    expect(bad.status).toBe(400);
    // holdSend refuses what already went
    await t.db
      .sql`update orbit.drafts set status = 'sent', sent_at = ${NOW}::timestamptz where id = ${d!.id}::uuid`;
    await expect(holdSend(t.db, r.userId, d!.id, NOW)).rejects.toMatchObject({ code: 'too_late' });
  });

  it('tripBreaker is idempotent per goal and falls back to the goal title without a company', async () => {
    const { userId } = await signedInUser(t);
    const goalId = await goalFor(userId, 'Seed round');
    const p = await addPerson(t, userId, { name: 'Marcus Lee', email: 'marcus@example.com' });
    const first = await tripBreaker(t.db, userId, {
      goalId,
      reason: 'declines',
      personId: p,
      personName: 'Marcus Lee',
      now: NOW,
    });
    expect(first).toEqual({
      tripped: true,
      text: 'Marcus Lee declined, the second today. Paused Seed round first messages.',
    });
    const second = await tripBreaker(t.db, userId, {
      goalId,
      reason: 'bounce',
      personId: p,
      personName: 'Marcus Lee',
      now: NOW,
    });
    expect(second.tripped).toBe(false);
    expect((await cards(userId)).filter((c) => c.kind === 'breaker')).toHaveLength(1);
  });
});
