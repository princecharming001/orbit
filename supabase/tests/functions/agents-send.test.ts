import { messageHash } from '@orbit/core/safety/rules';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromBase64url } from '../../functions/_shared/crypto.ts';
import { sqlQueue } from '../../functions/_shared/queue.ts';
import { maybeAutoReply } from '../../functions/_shared/replies/replies.ts';
import { pickSlots } from '../../functions/_shared/slots/slots.ts';
import { defaultHandlers, type Job, runTick } from '../../functions/orbit-worker/worker.ts';
import {
  ALL_KEYS,
  addPerson,
  addThread,
  agentConfig,
  anthropic,
  api,
  DAY,
  fakeNet,
  iso,
  jsonRes,
  type NetCall,
  signedInUser,
  UNIPILE,
  userText,
} from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const CONFIRM_REPLY = {
  subject: null,
  body: 'Hi Maya,\n\nThat works for me. I will send a calendar invite for the time you picked, and I look forward to talking then.\n\nBest,\nSam',
  ask: { kind: 'none', text: '' },
  hooks: [],
};

/** Gmail (send + thread), Calendar (free/busy + events) and Unipile chats. */
function google(busy: { start: string; end: string }[] = []) {
  let n = 0;
  return (c: NetCall) => {
    if (c.url === GMAIL_SEND) {
      n++;
      return jsonRes(200, {
        id: `gm-${n}`,
        threadId: (c.body as { threadId?: string }).threadId ?? `gt-${n}`,
      });
    }
    if (c.url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/threads/'))
      return jsonRes(200, { messages: [{ id: 'x', labelIds: ['SENT'], internalDate: String(Date.now()) }] });
    if (c.url === 'https://www.googleapis.com/calendar/v3/freeBusy')
      return jsonRes(200, { calendars: { primary: { busy } } });
    if (c.url.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events'))
      return jsonRes(200, { id: 'evt-1', status: 'confirmed' });
    if (c.url.startsWith(`${UNIPILE}/api/v1/chats`))
      return jsonRes(201, { object: 'MessageSent', message_id: 'li-msg-1', chat_id: 'chat-new' });
    return undefined;
  };
}

const sends = (net: ReturnType<typeof fakeNet>) => net.calls.filter((c) => c.url === GMAIL_SEND);
const decodeRaw = (c: NetCall) => new TextDecoder().decode(fromBase64url((c.body as { raw: string }).raw));

async function chatFor(userId: string, personId: string, stage = 'identified') {
  const [c] = await t.db.sql<{ id: string }>`
    insert into orbit.chats (user_id, person_id, stage, stage_entered_at, data)
    values (${userId}::uuid, ${personId}::uuid, ${stage}, now(), '{}'::jsonb) returning id`;
  return c!.id;
}

describe('sending (§8.5, §14.6, §16)', () => {
  it('§16.8 test 1: two concurrent approves of one draft make exactly one Gmail send', async () => {
    const net = fakeNet(google());
    const call = api(t, net, { env: {} });
    const { userId, token, email } = await signedInUser(t);
    const jane = await addPerson(t, userId, {
      name: 'Jane Doe',
      email: 'jane@northwind.example',
      title: 'Engineer',
    });
    const chat = await chatFor(userId, jane);
    const c = await call<{ draft: { id: string; chatId: string } }>('/drafts/compose', token, {
      personId: jane,
      kind: 'first_touch',
      channel: 'gmail',
    });
    expect(c.body.draft.chatId).toBe(chat);
    const now = new Date().toISOString();
    const [a, b] = await Promise.all([
      call<{ draft: { status: string } }>('/drafts/approve', token, {
        draftId: c.body.draft.id,
        sendAt: now,
      }),
      call<{ draft: { status: string } }>('/drafts/approve', token, {
        draftId: c.body.draft.id,
        sendAt: now,
      }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(sends(net)).toHaveLength(1);
    const raw = decodeRaw(sends(net)[0]!);
    expect(raw).toContain(`X-Orbit-Draft-Id: ${c.body.draft.id}`);
    expect(raw).toContain('To: "Jane Doe" <jane@northwind.example>');
    expect(raw).toContain(`From: "Sam Rivera" <${email}>`);
    const [d] = await t.db.sql<{ status: string; provider_message_id: string; sent_at: Date | null }>`
      select status, provider_message_id, sent_at from orbit.drafts where id = ${c.body.draft.id}::uuid`;
    expect(d).toMatchObject({ status: 'sent', provider_message_id: 'gm-1' });
    expect(d!.sent_at).toBeTruthy();
    // the job that a later approve or cadence queued finds nothing left to claim
    await runTick({ db: t.db, handlers: defaultHandlers(agentConfig(net, {})) });
    expect(sends(net)).toHaveLength(1);
    const [ch] = await t.db.sql<{
      stage: string;
      data: { lastOutboundAt?: string; firstOutreachAt?: string };
    }>`
      select stage, data from orbit.chats where id = ${chat}::uuid`;
    expect(ch!.stage).toBe('outreach_sent');
    expect(ch!.data.firstOutreachAt).toBeTruthy();
    const events = await t.db.sql<{
      to_stage: string;
    }>`select to_stage from orbit.stage_events where chat_id = ${chat}::uuid`;
    expect(events.map((e) => e.to_stage)).toEqual(['outreach_sent']);
    const audit = await t.db.sql<{ action: string }>`
      select action from orbit.audit_log where target_id = ${c.body.draft.id} order by id`;
    expect(audit.map((x) => x.action)).toEqual(
      expect.arrayContaining(['draft.compose', 'draft.approve', 'draft.sent']),
    );
  });

  it('schedules for the next send window when no time is given, and the job sends it once due', async () => {
    const net = fakeNet(google());
    const call = api(t, net, { env: {} });
    const { userId, token } = await signedInUser(t);
    const p = await addPerson(t, userId, {
      name: 'Omar Hale',
      email: 'omar@example.com',
      timezone: 'America/Chicago',
    });
    const c = await call<{ draft: { id: string } }>('/drafts/compose', token, {
      personId: p,
      kind: 'first_touch',
      channel: 'gmail',
    });
    const r = await call<{ draft: { status: string; sendAt: string } }>('/drafts/approve', token, {
      draftId: c.body.draft.id,
    });
    expect(r.body.draft.status).toBe('approved');
    const at = new Date(r.body.draft.sendAt);
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'short',
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(at);
    expect(['Tue', 'Wed', 'Thu']).toContain(local.find((x) => x.type === 'weekday')!.value);
    expect(Number(local.find((x) => x.type === 'hour')!.value)).toBeGreaterThanOrEqual(8);
    expect(sends(net)).toHaveLength(0);
    const [job] = await t.db.sql<{ message: { kind: string; payload: { draftId: string } } }>`
      select message from pgmq.q_orbit_send where message->>'userId' = ${userId}`;
    expect(job!.message).toMatchObject({ kind: 'send.draft', payload: { draftId: c.body.draft.id } });
    // time passes
    await t.db
      .sql`update orbit.drafts set send_at = now() - interval '1 minute' where id = ${c.body.draft.id}::uuid`;
    await t.db.sql`update pgmq.q_orbit_send set vt = now()`;
    await runTick({ db: t.db, handlers: defaultHandlers(agentConfig(net, {})) });
    expect(sends(net)).toHaveLength(1);
    // cancel and discard
    const c2 = await call<{ draft: { id: string } }>('/drafts/compose', token, {
      personId: p,
      kind: 'thank_you',
      channel: 'gmail',
    });
    await call('/drafts/approve', token, { draftId: c2.body.draft.id });
    expect(
      (await call<{ draft: { status: string } }>('/drafts/cancel', token, { draftId: c2.body.draft.id })).body
        .draft.status,
    ).toBe('cancelled');
    expect(
      (await call<{ draft: { status: string } }>('/drafts/discard', token, { draftId: c2.body.draft.id }))
        .body.draft.status,
    ).toBe('discarded');
    expect((await call('/drafts/cancel', token, { draftId: c.body.draft.id })).status).toBe(409);
  });

  it('a reply goes out in its Gmail thread with In-Reply-To and References', async () => {
    const claude = anthropic(() => CONFIRM_REPLY);
    const net = fakeNet(claude.answer, google());
    const call = api(t, net);
    const { userId, token } = await signedInUser(t);
    const maya = await addPerson(t, userId, { name: 'Maya Chen', email: 'maya@example.com', score: 50 });
    const th = await addThread(
      t,
      userId,
      maya,
      [
        {
          direction: 'out',
          at: iso(3 * DAY),
          body: 'Hi Maya, would you have time for a short call next week?',
        },
        {
          direction: 'in',
          at: iso(DAY),
          body: 'Sure, Thursday at 2pm works for me.',
          replyClass: 'scheduling',
          rfc: '<maya-1@mail.test>',
        },
      ],
      { subject: 'Coffee chat', externalId: 'gthread-1' },
    );
    const d = await call<{ draft: { id: string; subject: string | null } }>('/replies/draft', token, {
      messageId: th.messageIds[1],
    });
    expect(d.status).toBe(200);
    expect(d.body.draft.subject).toBeNull();
    await call('/drafts/approve', token, { draftId: d.body.draft.id, sendAt: new Date().toISOString() });
    expect(sends(net)).toHaveLength(1);
    expect((sends(net)[0]!.body as { threadId: string }).threadId).toBe('gthread-1');
    const raw = decodeRaw(sends(net)[0]!);
    expect(raw).toContain('In-Reply-To: <maya-1@mail.test>');
    expect(raw).toContain('References: <maya-1@mail.test>');
    expect(raw).toContain('Subject: Re: Coffee chat');
  });

  it('§14.8 test 4: LinkedIn needs a fresh tap; without one the function sends nothing', async () => {
    const net = fakeNet(google());
    const call = api(t, net, { env: { unipileKey: 'unipile-placeholder', unipileBase: UNIPILE } });
    const { userId, token } = await signedInUser(t);
    await t.db.sql`insert into orbit.integration_accounts (user_id, provider, external_account_id, status)
      values (${userId}::uuid, 'linkedin', 'acc-li', 'active')`;
    const p = await addPerson(t, userId, { name: 'Lena Cho', memberId: 'ACoAALena', score: 45 });
    await addThread(
      t,
      userId,
      p,
      [{ direction: 'out', at: iso(10 * DAY), body: 'Hi Lena, great to connect here.' }],
      {
        provider: 'linkedin',
        externalId: 'chat-1',
      },
    );
    const c = await call<{ draft: { id: string } }>('/drafts/compose', token, {
      personId: p,
      kind: 'bump',
      channel: 'linkedin',
    });
    expect(c.status).toBe(200);
    const no = await call<{ error: { code: string } }>('/drafts/approve', token, {
      draftId: c.body.draft.id,
    });
    expect(no.status).toBe(409);
    expect(no.body.error.code).toBe('needs_confirmation');
    // an approval older than 15 minutes is not fresh: the send job holds it
    const [d] = await t.db.sql<{ channel: 'linkedin'; subject: string | null; body: string }>`
      select channel, subject, body from orbit.drafts where id = ${c.body.draft.id}::uuid`;
    const hash = messageHash({ channel: 'linkedin', subject: d!.subject, body: d!.body });
    await t.db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details, created_at)
      values (${userId}::uuid, 'user', 'draft.approve', 'drafts', ${c.body.draft.id}, ${{ hash }}::jsonb, now() - interval '20 minutes'),
             (${userId}::uuid, 'user', 'draft.confirm', 'drafts', ${c.body.draft.id}, ${{ hash }}::jsonb, now() - interval '20 minutes')`;
    await t.db
      .sql`update orbit.drafts set status = 'approved', send_at = now() where id = ${c.body.draft.id}::uuid`;
    await t.db
      .sql`select orbit.enqueue('orbit_send', ${JSON.stringify({ kind: 'send.draft', userId, payload: { draftId: c.body.draft.id } })}::jsonb, 0)`;
    await runTick({ db: t.db, handlers: defaultHandlers(agentConfig(net, ALL_KEYS)) });
    const [held] = await t.db.sql<{
      status: string;
      error: string;
    }>`select status, error from orbit.drafts where id = ${c.body.draft.id}::uuid`;
    expect(held).toEqual({ status: 'draft', error: 'linkedin_needs_fresh_approval' });
    expect(net.calls.filter((x) => x.url.startsWith(UNIPILE))).toHaveLength(0);
    // a tap sends it at once through the existing chat
    const ok = await call<{ draft: { status: string } }>('/drafts/approve', token, {
      draftId: c.body.draft.id,
      confirm: true,
    });
    expect(ok.body.draft.status).toBe('sent');
    const li = net.calls.filter((x) => x.url.startsWith(UNIPILE));
    expect(li).toHaveLength(1);
    expect(li[0]!.url).toBe(`${UNIPILE}/api/v1/chats/chat-1/messages`);
    expect(li[0]!.body).toMatchObject({ account_id: 'acc-li', text: d!.body });
    expect(li[0]!.headers['x-api-key']).toBe('unipile-placeholder');

    // no chat yet with a 1st-degree connection: POST /api/v1/chats with the attendee
    const n = await addPerson(t, userId, { name: 'Nia Fox', memberId: 'ACoAANia', score: 30 });
    const nc = await call<{ draft: { id: string } }>('/drafts/compose', token, {
      personId: n,
      kind: 'first_touch',
      channel: 'linkedin',
    });
    const sent = await call<{ draft: { status: string } }>('/drafts/approve', token, {
      draftId: nc.body.draft.id,
      confirm: true,
    });
    expect(sent.body.draft.status).toBe('sent');
    const start = net.calls.filter((x) => x.url === `${UNIPILE}/api/v1/chats`);
    expect(start).toHaveLength(1);
    expect(start[0]!.body).toMatchObject({ account_id: 'acc-li', attendees_ids: 'ACoAANia' });
    const [row] = await t.db.sql<{ thread_external_id: string }>`
      select thread_external_id from orbit.drafts where id = ${nc.body.draft.id}::uuid`;
    expect(row!.thread_external_id).toBe('chat-new');
  });

  it('§14.8 test 1: hard rules at send time: do-not-contact and a fourth unanswered message are cancelled', async () => {
    const net = fakeNet(google());
    const call = api(t, net, { env: {} });
    const { userId, token } = await signedInUser(t);
    const p = await addPerson(t, userId, { name: 'Ivy Ross', email: 'ivy@example.com' });
    const c = await call<{ draft: { id: string } }>('/drafts/compose', token, {
      personId: p,
      kind: 'first_touch',
      channel: 'gmail',
    });
    await call('/drafts/approve', token, {
      draftId: c.body.draft.id,
      sendAt: new Date(Date.now() + DAY).toISOString(),
    });
    await t.db.sql`update orbit.people set do_not_contact = true where id = ${p}::uuid`;
    await t.db.sql`update orbit.drafts set send_at = now() where id = ${c.body.draft.id}::uuid`;
    await t.db.sql`update pgmq.q_orbit_send set vt = now()`;
    await runTick({ db: t.db, handlers: defaultHandlers(agentConfig(net, {})) });
    const [d1] = await t.db.sql<{
      status: string;
      cancel_reason: string;
    }>`select status, cancel_reason from orbit.drafts where id = ${c.body.draft.id}::uuid`;
    expect(d1).toEqual({ status: 'cancelled', cancel_reason: 'do_not_contact' });

    const q = await addPerson(t, userId, { name: 'Quinn Hart', email: 'quinn@example.com' });
    const c2 = await call<{ draft: { id: string } }>('/drafts/compose', token, {
      personId: q,
      kind: 'first_touch',
      channel: 'gmail',
    });
    await addThread(t, userId, q, [
      { direction: 'out', at: iso(30 * DAY), body: 'one' },
      { direction: 'out', at: iso(20 * DAY), body: 'two' },
      { direction: 'out', at: iso(10 * DAY), body: 'three' },
    ]);
    const blocked = await call<{ error: { code: string } }>('/drafts/compose', token, {
      personId: q,
      kind: 'bump',
      channel: 'gmail',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('unanswered_limit');
    await call('/drafts/approve', token, { draftId: c2.body.draft.id, sendAt: new Date().toISOString() });
    const [d2] = await t.db.sql<{
      status: string;
      cancel_reason: string;
    }>`select status, cancel_reason from orbit.drafts where id = ${c2.body.draft.id}::uuid`;
    expect(d2).toEqual({ status: 'cancelled', cancel_reason: 'unanswered_limit' });
    expect(sends(net)).toHaveLength(0);
  });

  it('holds sales first touches past 30 a day and LinkedIn messages past 25 a day', async () => {
    const net = fakeNet(google());
    const call = api(t, net, { env: { unipileKey: 'k', unipileBase: UNIPILE } });
    const { userId, token } = await signedInUser(t, {
      settings: { postal_address: '1 Main St', company: 'Orbitly' },
    });
    const g = await call<{ goal: { id: string } }>('/goals/upsert', token, {
      goal: { kind: 'sales', title: 'Pilots' },
    });
    const p = await addPerson(t, userId, { name: 'Ray Diaz', email: 'ray@example.com' });
    for (let i = 0; i < 30; i++)
      await t.db.sql`
        insert into orbit.drafts (user_id, person_id, goal_id, channel, kind, body, status, sent_at)
        values (${userId}::uuid, ${p}::uuid, ${g.body.goal.id}::uuid, 'gmail', 'first_touch', 'x', 'sent', now())`;
    const fresh = await addPerson(t, userId, { name: 'Tia Wong', email: 'tia@example.com' });
    const c = await call<{ draft: { id: string } }>('/drafts/compose', token, {
      personId: fresh,
      kind: 'first_touch',
      channel: 'gmail',
      goalId: g.body.goal.id,
    });
    await call('/drafts/approve', token, { draftId: c.body.draft.id, sendAt: new Date().toISOString() });
    const [d] = await t.db.sql<{ status: string; error: string; send_at: Date }>`
      select status, error, send_at from orbit.drafts where id = ${c.body.draft.id}::uuid`;
    expect(d!.status).toBe('approved');
    expect(d!.error).toBe('gmail_sales_daily_cap');
    expect(new Date(d!.send_at).getTime()).toBeGreaterThan(Date.now() + 6 * 3_600_000);
    expect(sends(net)).toHaveLength(0);

    await t.db.sql`insert into orbit.integration_accounts (user_id, provider, external_account_id, status)
      values (${userId}::uuid, 'linkedin', 'acc-2', 'active')`;
    for (let i = 0; i < 25; i++)
      await t.db.sql`
        insert into orbit.drafts (user_id, person_id, channel, kind, body, status, sent_at)
        values (${userId}::uuid, ${p}::uuid, 'linkedin', 'reply', 'x', 'sent', now())`;
    const l = await addPerson(t, userId, { name: 'Lu Park', memberId: 'ACoAALu' });
    const lc = await call<{ draft: { id: string } }>('/drafts/compose', token, {
      personId: l,
      kind: 'first_touch',
      channel: 'linkedin',
    });
    const r = await call<{ draft: { status: string } }>('/drafts/approve', token, {
      draftId: lc.body.draft.id,
      confirm: true,
    });
    expect(r.body.draft.status).toBe('draft');
    expect(net.calls.filter((x) => x.url.startsWith(UNIPILE))).toHaveLength(0);
  });
});

describe('replies (§8)', () => {
  it('lists classified inbound replies of the last 30 days, newest first, with the draft that answers them', async () => {
    const call = api(t, fakeNet(), { env: {} });
    const { userId, token } = await signedInUser(t);
    const maya = await addPerson(t, userId, { name: 'Maya Chen', email: 'maya@example.com' });
    const th = await addThread(t, userId, maya, [
      { direction: 'out', at: iso(40 * DAY), body: 'Hello there' },
      { direction: 'in', at: iso(35 * DAY), body: 'Old answer', replyClass: 'interested' },
      {
        direction: 'in',
        at: iso(3 * DAY),
        body: 'Can you tell me more about the role?',
        replyClass: 'question',
      },
      { direction: 'in', at: iso(2 * DAY), body: 'Not classified yet' },
      { direction: 'in', at: iso(DAY), body: 'Happy to chat, what times work?', replyClass: 'interested' },
    ]);
    const r = await call<{
      replies: {
        messageId: string;
        replyClass: string;
        personName: string;
        draftId: string | null;
        snippet: string;
      }[];
    }>('/replies/list', token);
    expect(r.body.replies.map((x) => x.replyClass)).toEqual(['interested', 'question']);
    expect(r.body.replies[0]).toMatchObject({
      personName: 'Maya Chen',
      draftId: null,
      snippet: 'Happy to chat, what times work?',
    });
    const d = await call<{ draft: { id: string } }>('/replies/draft', token, { messageId: th.messageIds[4] });
    const again = await call<{ replies: { draftId: string | null }[] }>('/replies/list', token);
    expect(again.body.replies[0]!.draftId).toBe(d.body.draft.id);
  });

  it('§8.8 test 2: a scheduling reply gets three free slots on three days, clear of the calendar, in the recipient’s zone', async () => {
    const now = Date.now();
    // busy every working day from 9:00 to 12:00 New York time over the next two weeks
    const busy: { start: string; end: string }[] = [];
    for (let i = 0; i < 16; i++) {
      const day = new Date(now + i * DAY).toISOString().slice(0, 10);
      busy.push({ start: `${day}T13:00:00Z`, end: `${day}T16:00:00Z` });
    }
    const claude = anthropic(() => CONFIRM_REPLY);
    const net = fakeNet(claude.answer, google(busy));
    const call = api(t, net);
    const { userId, token } = await signedInUser(t);
    const maya = await addPerson(t, userId, {
      name: 'Maya Chen',
      email: 'maya@example.com',
      timezone: 'America/Los_Angeles',
    });
    const th = await addThread(t, userId, maya, [
      { direction: 'out', at: iso(3 * DAY), body: 'Would you have time for a short call?' },
      { direction: 'in', at: iso(DAY), body: 'Yes! When works for you?', replyClass: 'scheduling' },
    ]);
    const d = await call<{ draft: { id: string } }>('/replies/draft', token, { messageId: th.messageIds[1] });
    expect(d.status).toBe(200);
    const prompt = userText(claude.requests[0]!);
    const slotBlock = prompt.split('<free_slots>')[1]!.split('</free_slots>')[0]!;
    const lines = slotBlock.trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l).toMatch(/ PT$/);
    const [row] = await t.db.sql<{
      ask: { slots: string[] };
    }>`select ask from orbit.drafts where id = ${d.body.draft.id}::uuid`;
    const starts = row!.ask.slots.map((s) => new Date(s));
    expect(starts).toHaveLength(3);
    expect(new Set(starts.map((s) => s.toISOString().slice(0, 10))).size).toBe(3);
    for (const s of starts) {
      const e = s.getTime() + 30 * 60_000;
      for (const b of busy) expect(e <= Date.parse(b.start) || s.getTime() >= Date.parse(b.end)).toBe(true);
      expect(s.getTime()).toBeGreaterThan(now + 18 * 3_600_000);
    }
    // the slots route answers the same way, labelled in the zone asked for
    const sl = await call<{ slots: { label: string }[]; tz: string }>('/calendar/slots', token, {
      tz: 'Europe/London',
    });
    expect(sl.body.tz).toBe('Europe/London');
    expect(sl.body.slots).toHaveLength(3);
  });

  it('picks slots that never touch an event, skipping weekends and holidays', () => {
    // Wed 2026-11-25 10:00 ET; Thu 26 (Thanksgiving) and Fri 27 are holidays, then the weekend
    const now = new Date('2026-11-24T15:00:00Z');
    const busy = [{ start: Date.parse('2026-11-25T14:00:00Z'), end: Date.parse('2026-11-25T14:30:00Z') }];
    const s = pickSlots(busy, { now, userTz: 'America/New_York', labelTz: 'America/New_York' });
    expect(s.map((x) => x.start)).toEqual([
      '2026-11-25T15:00:00.000Z',
      '2026-11-30T14:00:00.000Z',
      '2026-12-01T14:00:00.000Z',
    ]);
    expect(s[0]!.label).toBe('Wed, Nov 25, 10:00 to 10:30 ET');
  });

  it('§8.8 test 3: level 2 auto-sends a confirmation in a two-way Gmail thread, and only there', async () => {
    const claude = anthropic(() => CONFIRM_REPLY);
    const net = fakeNet(claude.answer, google());
    const { userId } = await signedInUser(t);
    await t.db.sql`update orbit.users set autonomy_level = 2 where id = ${userId}::uuid`;
    const at = new Date('2026-10-15T15:00:00Z'); // 11:00 in New York
    const cfg = agentConfig(net);
    const two = async (provider: 'gmail' | 'linkedin', tz: string, outFirst = true) => {
      const p = await addPerson(t, userId, {
        name: 'Maya Chen',
        email: `maya${Math.random()}@example.com`,
        score: 55,
        timezone: tz,
      });
      const msgs = [
        ...(outFirst
          ? [
              {
                direction: 'out' as const,
                at: '2026-10-12T15:00:00Z',
                body: 'Would you have time for a short call?',
              },
            ]
          : []),
        {
          direction: 'in' as const,
          at: '2026-10-13T15:00:00Z',
          body: 'Thursday at 2pm works for me.',
          replyClass: 'scheduling',
        },
      ];
      const th = await addThread(t, userId, p, msgs, { provider });
      return th.messageIds[th.messageIds.length - 1]!;
    };
    const ok = await maybeAutoReply(t.db, userId, await two('gmail', 'America/New_York'), {
      config: cfg,
      now: () => at,
    });
    expect(ok.action).toBe('auto_sent');
    if (ok.action !== 'auto_sent') return;
    const [d] = await t.db.sql<{
      status: string;
      autonomy_level: number;
    }>`select status, autonomy_level from orbit.drafts where id = ${ok.draftId}::uuid`;
    expect(d).toEqual({ status: 'approved', autonomy_level: 2 });
    const cold = await maybeAutoReply(t.db, userId, await two('gmail', 'America/New_York', false), {
      config: cfg,
      now: () => at,
    });
    expect(cold).toMatchObject({
      action: 'drafted',
      reasons: expect.arrayContaining(['not a reply in a two-way thread']),
    });
    const li = await maybeAutoReply(t.db, userId, await two('linkedin', 'America/New_York'), {
      config: cfg,
      now: () => at,
    });
    expect(li).toMatchObject({ action: 'drafted', reasons: expect.arrayContaining(['not Gmail']) });
    const late = await maybeAutoReply(t.db, userId, await two('gmail', 'Asia/Tokyo'), {
      config: cfg,
      now: () => at,
    });
    expect(late).toMatchObject({ action: 'drafted' });
    if (late.action === 'drafted')
      expect(late.reasons.some((r) => r.includes('in their time zone'))).toBe(true);
    // idempotent per message, and the queued send goes out as an auto-send
    const again = await maybeAutoReply(
      t.db,
      userId,
      (
        await t.db.sql<{ id: string }>`
      select ask->>'replyToMessageId' as id from orbit.drafts where id = ${ok.draftId}::uuid`
      )[0]!.id,
      { config: cfg, now: () => at },
    );
    expect(again).toEqual({ action: 'auto_sent', draftId: ok.draftId });
    await runTick({ db: t.db, handlers: defaultHandlers(cfg), now: () => at });
    expect(sends(net)).toHaveLength(1);
    const audit = await t.db.sql<{ action: string; actor: string }>`
      select action, actor from orbit.audit_log where target_id = ${ok.draftId} order by id`;
    expect(audit.map((a) => `${a.actor}:${a.action}`)).toEqual(
      expect.arrayContaining(['agent:draft.auto_approve', 'agent:draft.auto_sent']),
    );
  });

  it('classify.message leads to the reply: level 2 approves and queues a scheduling answer, level 0 only drafts', async () => {
    const claude = anthropic(() => CONFIRM_REPLY);
    const net = fakeNet(claude.answer, google());
    const cfg = agentConfig(net);
    const at = new Date('2026-10-15T15:00:00Z'); // 11:00 in New York
    const handlers = defaultHandlers({ agents: cfg });
    const queue = sqlQueue(t.db);
    const classify = (userId: string, messageId: string) =>
      handlers['classify.message']!(
        {
          queue: 'orbit_classify',
          msgId: 0,
          readCt: 1,
          kind: 'classify.message',
          userId,
          payload: { messageId },
        } satisfies Job,
        { db: t.db, queue, now: () => at },
      );
    const scheduling = async (level: 0 | 2) => {
      const { userId } = await signedInUser(t);
      await t.db.sql`update orbit.users set autonomy_level = ${level}::smallint where id = ${userId}::uuid`;
      const p = await addPerson(t, userId, {
        name: 'Maya Chen',
        email: `maya${Math.random()}@example.com`,
        score: 55,
        timezone: 'America/New_York',
      });
      const th = await addThread(t, userId, p, [
        {
          direction: 'out',
          at: '2026-10-12T15:00:00Z',
          body: 'Would you have time for a short call next week?',
        },
        { direction: 'in', at: '2026-10-13T15:00:00Z', body: 'Thursday at 2pm works for me.' },
      ]);
      const messageId = th.messageIds[1]!;
      await classify(userId, messageId);
      const [m] = await t.db.sql<{ reply_class: string }>`
        select reply_class from orbit.messages where id = ${messageId}::uuid`;
      expect(m!.reply_class).toBe('scheduling');
      const drafts = await t.db.sql<{ id: string; status: string; kind: string }>`
        select id, status, kind from orbit.drafts where user_id = ${userId}::uuid`;
      const queued = await t.db.sql<{ message: { kind: string; payload: { draftId: string } } }>`
        select message from pgmq.q_orbit_send where message->>'userId' = ${userId}`;
      return { userId, drafts, queued };
    };

    const auto = await scheduling(2);
    expect(auto.drafts).toEqual([{ id: expect.any(String), status: 'approved', kind: 'reply' }]);
    expect(auto.queued.map((q) => q.message)).toEqual([
      expect.objectContaining({ kind: 'send.draft', payload: { draftId: auto.drafts[0]!.id } }),
    ]);
    const audit = await t.db.sql<{ actor: string; action: string }>`
      select actor, action from orbit.audit_log where target_id = ${auto.drafts[0]!.id} order by id`;
    expect(audit.map((a) => `${a.actor}:${a.action}`)).toContain('agent:draft.auto_approve');
    await runTick({ db: t.db, handlers, now: () => at });
    expect(sends(net)).toHaveLength(1);

    const manual = await scheduling(0);
    expect(manual.drafts).toEqual([{ id: expect.any(String), status: 'draft', kind: 'reply' }]);
    expect(manual.queued).toEqual([]);
    // classified again (a retried job): still one draft
    const [msg] = await t.db.sql<{ id: string }>`
      select id from orbit.messages where user_id = ${manual.userId}::uuid and direction = 'in'`;
    await classify(manual.userId, msg!.id);
    const [n] = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.drafts where user_id = ${manual.userId}::uuid`;
    expect(n!.n).toBe(1);
  });

  it('a reply read from the history is listed but not drafted; an unsubscribe there still counts', async () => {
    const claude = anthropic(() => CONFIRM_REPLY);
    const withClaude = defaultHandlers({ agents: agentConfig(fakeNet(claude.answer, google())) });
    const rulesOnly = defaultHandlers({ agents: agentConfig(fakeNet(google()), {}) });
    const { userId } = await signedInUser(t);
    const classify = (messageId: string, handlers = withClaude) =>
      handlers['classify.message']!(
        {
          queue: 'orbit_classify',
          msgId: 0,
          readCt: 1,
          kind: 'classify.message',
          userId,
          payload: { messageId, history: true },
        },
        { db: t.db, queue: sqlQueue(t.db), now: () => new Date() },
      );
    const ann = await addPerson(t, userId, { name: 'Ann Diaz', email: 'ann@example.com' });
    const asked = await addThread(t, userId, ann, [
      { direction: 'out', at: iso(40 * DAY), body: 'Hi Ann, would you have time for a short call?' },
      { direction: 'in', at: iso(39 * DAY), body: 'Thursday at 2pm works for me.' },
    ]);
    await classify(asked.messageIds[1]!);
    const [m] = await t.db.sql<{ reply_class: string | null }>`
      select reply_class from orbit.messages where id = ${asked.messageIds[1]!}::uuid`;
    expect(m!.reply_class).toBe('scheduling');
    const [n] = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.drafts where user_id = ${userId}::uuid`;
    expect(n!.n).toBe(0);

    const bo = await addPerson(t, userId, { name: 'Bo Lin', email: 'bo@example.com' });
    const removed = await addThread(t, userId, bo, [
      { direction: 'out', at: iso(30 * DAY), body: 'Hi Bo, would you have time for a call?' },
      { direction: 'in', at: iso(29 * DAY), body: 'Please remove me from your list.' },
    ]);
    await classify(removed.messageIds[1]!, rulesOnly);
    const [person] = await t.db.sql<{ do_not_contact: boolean }>`
      select do_not_contact from orbit.people where id = ${bo}::uuid`;
    expect(person!.do_not_contact).toBe(true);
  });

  it('a newer message in the thread retires the untouched draft answering an earlier one, never an edited one', async () => {
    const net = fakeNet(google());
    const cfg = agentConfig(net, {});
    const { userId } = await signedInUser(t);
    const twoReplies = async (name: string) => {
      const p = await addPerson(t, userId, {
        name,
        email: `${name.split(' ')[0]!.toLowerCase()}@example.com`,
      });
      return addThread(t, userId, p, [
        { direction: 'out', at: iso(4 * DAY), body: 'Would you have time for a short call next week?' },
        {
          direction: 'in',
          at: iso(3 * DAY),
          body: 'Thursday at 2pm works for me.',
          replyClass: 'scheduling',
        },
        {
          direction: 'in',
          at: iso(2 * DAY),
          body: 'Actually, could we do Friday instead?',
          replyClass: 'scheduling',
        },
      ]);
    };
    const status = async (id: string) =>
      (
        await t.db.sql<{ status: string; cancel_reason: string | null }>`
          select status, cancel_reason from orbit.drafts where id = ${id}::uuid`
      )[0];

    const th = await twoReplies('Cy Moss');
    const first = await maybeAutoReply(t.db, userId, th.messageIds[1]!, { config: cfg });
    expect(first.action).toBe('drafted');
    const second = await maybeAutoReply(t.db, userId, th.messageIds[2]!, { config: cfg });
    expect(second.action).toBe('drafted');
    if (first.action !== 'drafted' || second.action !== 'drafted') return;
    expect(await status(first.draftId)).toEqual({ status: 'cancelled', cancel_reason: 'superseded' });
    expect(await status(second.draftId)).toEqual({ status: 'draft', cancel_reason: null });

    // a draft the user changed stays: the newer message gets its own draft beside it
    const edited = await twoReplies('Di Park');
    const mine = await maybeAutoReply(t.db, userId, edited.messageIds[1]!, { config: cfg });
    if (mine.action !== 'drafted') throw new Error('expected a draft');
    await t.db.sql`
      update orbit.drafts set body = 'Thursday is great, talk then.', created_at = now() - interval '1 minute'
       where id = ${mine.draftId}::uuid`;
    await maybeAutoReply(t.db, userId, edited.messageIds[2]!, { config: cfg });
    expect(await status(mine.draftId)).toEqual({ status: 'draft', cancel_reason: null });
  });

  it('classify.message on an unsubscribe closes the chat and cancels pending drafts', async () => {
    const net = fakeNet(google());
    const handlers = defaultHandlers({ agents: agentConfig(net, {}) });
    const { userId } = await signedInUser(t);
    const p = await addPerson(t, userId, { name: 'Uma Bell', email: 'uma2@example.com' });
    const chat = await chatFor(userId, p, 'outreach_sent');
    const [d] = await t.db.sql<{ id: string }>`
      insert into orbit.drafts (user_id, person_id, channel, kind, body, status)
      values (${userId}::uuid, ${p}::uuid, 'gmail', 'bump', 'Just bumping this.', 'draft') returning id`;
    const th = await addThread(t, userId, p, [
      { direction: 'out', at: iso(3 * DAY), body: 'Hi Uma, would you have time for a call?' },
      { direction: 'in', at: iso(DAY), body: 'Please remove me from your list.' },
    ]);
    await handlers['classify.message']!(
      {
        queue: 'orbit_classify',
        msgId: 0,
        readCt: 1,
        kind: 'classify.message',
        userId,
        payload: { messageId: th.messageIds[1] },
      },
      { db: t.db, queue: sqlQueue(t.db), now: () => new Date() },
    );
    const [person] = await t.db.sql<{ do_not_contact: boolean }>`
      select do_not_contact from orbit.people where id = ${p}::uuid`;
    expect(person!.do_not_contact).toBe(true);
    const [c] = await t.db.sql<{ stage: string }>`select stage from orbit.chats where id = ${chat}::uuid`;
    expect(c!.stage).toBe('declined');
    const [draft] = await t.db.sql<{
      status: string;
    }>`select status from orbit.drafts where id = ${d!.id}::uuid`;
    expect(draft!.status).toBe('cancelled');
  });

  it('§8.8 tests 4 and 5: unsubscribe sets do-not-contact and later composes fail; a blank cannot be approved', async () => {
    const net = fakeNet(google());
    const call = api(t, net, { env: {} });
    const { userId, token } = await signedInUser(t);
    const p = await addPerson(t, userId, { name: 'Uma Bell', email: 'uma@example.com' });
    const chat = await chatFor(userId, p, 'outreach_sent');
    const pending = await call<{ draft: { id: string } }>('/drafts/compose', token, {
      personId: p,
      kind: 'thank_you',
      channel: 'gmail',
    });
    const th = await addThread(t, userId, p, [
      { direction: 'out', at: iso(3 * DAY), body: 'Hi Uma, would you have time for a call?' },
      { direction: 'in', at: iso(DAY), body: 'Please remove me from your list.', replyClass: 'unsubscribe' },
    ]);
    const r = await maybeAutoReply(t.db, userId, th.messageIds[1]!, { config: agentConfig(net, {}) });
    expect(r).toEqual({ action: 'unsubscribed' });
    const [person] = await t.db.sql<{
      do_not_contact: boolean;
    }>`select do_not_contact from orbit.people where id = ${p}::uuid`;
    expect(person!.do_not_contact).toBe(true);
    const [c] = await t.db.sql<{ stage: string }>`select stage from orbit.chats where id = ${chat}::uuid`;
    expect(c!.stage).toBe('declined');
    const [old] = await t.db.sql<{
      status: string;
    }>`select status from orbit.drafts where id = ${pending.body.draft.id}::uuid`;
    expect(old!.status).toBe('cancelled');
    const compose = await call<{ error: { code: string; message: string } }>('/drafts/compose', token, {
      personId: p,
      kind: 'bump',
      channel: 'gmail',
    });
    expect(compose.status).toBe(409);
    expect(compose.body.error.code).toBe('do_not_contact');
    const reply = await call<{ error: { code: string } }>('/replies/draft', token, {
      messageId: th.messageIds[1],
    });
    expect(reply.status).toBe(409);

    // §8.8 test 5: a question with no model still drafts a whole reply (never a blank to fill); a draft that does
    // hold a blank (a model's [ASK USER: …], or what is left of one) cannot be approved
    const q = await addPerson(t, userId, { name: 'Quentin Ames', email: 'q@example.com' });
    const qt = await addThread(t, userId, q, [
      { direction: 'out', at: iso(3 * DAY), body: 'Hi Quentin, could we talk?' },
      { direction: 'in', at: iso(DAY), body: 'What is your budget?', replyClass: 'question' },
    ]);
    const qd = await call<{ draft: { id: string; body: string; needsInput: string[] } }>(
      '/replies/draft',
      token,
      { messageId: qt.messageIds[1] },
    );
    expect(qd.body.draft.needsInput).toEqual([]);
    expect(qd.body.draft.body).not.toMatch(/\[|\]/);
    await t.db.sql`update orbit.drafts set body = body || ' [ASK USER: your budget]'
                    where id = ${qd.body.draft.id}::uuid`;
    const ap = await call<{ error: { code: string } }>('/drafts/approve', token, {
      draftId: qd.body.draft.id,
    });
    expect(ap.status).toBe(409);
    expect(ap.body.error.code).toBe('needs_input');
  });
});

describe('calendar booking (§8.3)', () => {
  it('asks for calendar.events the first time, then creates the event with invites', async () => {
    const net = fakeNet(google());
    const call = api(t, net, { env: {} });
    const { userId, token } = await signedInUser(t);
    const p = await addPerson(t, userId, { name: 'Maya Chen', email: 'maya@example.com' });
    const chat = await chatFor(userId, p, 'scheduling');
    const c = await call<{ draft: { id: string } }>('/drafts/compose', token, {
      personId: p,
      kind: 'thank_you',
      channel: 'gmail',
    });
    const start = new Date(Date.now() + 3 * DAY).toISOString();
    const first = await call<{ needsConsent?: { url: string }; eventId?: string }>('/calendar/book', token, {
      draftId: c.body.draft.id,
      slotStart: start,
    });
    expect(first.status).toBe(200);
    const url = new URL(first.body.needsConsent!.url);
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    const [st] = await t.db.sql<{ user_id: string; scopes: string[] }>`
      select user_id, scopes from orbit.oauth_states where state = ${url.searchParams.get('state')!}`;
    expect(st!.user_id).toBe(userId);
    expect(net.calls.filter((x) => x.url.includes('/events'))).toHaveLength(0);

    await t.db
      .sql`update orbit.integration_accounts set scopes = array_append(scopes, 'https://www.googleapis.com/auth/calendar.events')
      where user_id = ${userId}::uuid and provider = 'google'`;
    const booked = await call<{ eventId: string }>('/calendar/book', token, {
      draftId: c.body.draft.id,
      slotStart: start,
    });
    expect(booked.body.eventId).toBe('evt-1');
    const ev = net.calls.find((x) => x.url.includes('/events'))!;
    expect(ev.url).toContain('sendUpdates=all');
    expect(ev.body).toMatchObject({ attendees: [{ email: 'maya@example.com' }], start: { dateTime: start } });
    const [row] = await t.db.sql<{
      external_id: string;
    }>`select external_id from orbit.calendar_events where user_id = ${userId}::uuid`;
    expect(row!.external_id).toBe('evt-1');
    const [ch] = await t.db.sql<{ stage: string }>`select stage from orbit.chats where id = ${chat}::uuid`;
    expect(ch!.stage).toBe('scheduled');
  });
});
