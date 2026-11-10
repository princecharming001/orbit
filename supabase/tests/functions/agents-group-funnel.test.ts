/**
 * Plan 38 §E, §G on the server: "Answer simple replies for me" without Autopilot mode, and a group's funnel (an
 * interested reply gets the booking link or the student's own words; a follow-up gets the group's words).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maybeAutoReply } from '../../functions/_shared/replies/replies.ts';
import { makeServices, RESEND_URL } from '../../functions/_shared/services.ts';
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

const NOW = new Date('2026-10-13T16:00:00Z');
const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];
const LINK = 'https://cal.com/maya/15min';

function google() {
  let n = 0;
  return (c: NetCall) => {
    if (c.url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
      return jsonRes(200, { id: `gm-${++n}`, threadId: `gt-${n}` });
    if (c.url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/threads/'))
      return jsonRes(200, { messages: [{ id: 'x', labelIds: ['SENT'], internalDate: String(Date.now()) }] });
    if (c.url === 'https://www.googleapis.com/calendar/v3/freeBusy')
      return jsonRes(200, { calendars: { primary: { busy: [] } } });
    if (c.url.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events'))
      return jsonRes(200, { id: `evt-${++n}`, status: 'confirmed' });
    if (c.url === RESEND_URL) return jsonRes(200, { id: 're_1' });
    return undefined;
  };
}

const REPLY = {
  subject: null,
  body: 'Hi Priya,\n\nThanks so much. Would any of these times work for a short call?\n\nBest,\nMaya',
  ask: { kind: 'none', text: '' },
  hooks: [],
};

/** A level 0 student (no Autopilot mode) who wrote first to a cold recruiter (score 10), who replied with `cls`. */
async function coldReply(cls: string, body: string) {
  const { userId, token } = await signedInUser(t, { scopes: SCOPES });
  const personId = await addPerson(t, userId, {
    name: 'Priya Shah',
    email: `priya.${Math.random().toString(36).slice(2, 7)}@stripe.com`,
    org: 'Stripe',
    score: 10,
    timezone: 'America/New_York',
  });
  const [chat] = await t.db.sql<{ id: string }>`
    insert into orbit.chats (user_id, person_id, stage, stage_entered_at, data)
    values (${userId}::uuid, ${personId}::uuid, 'outreach_sent', now(), '{}'::jsonb) returning id`;
  const th = await addThread(t, userId, personId, [
    {
      direction: 'out',
      at: '2026-10-12T15:00:00Z',
      body: 'Would you have 15 minutes to talk about the PM internship?',
    },
    { direction: 'in', at: '2026-10-13T15:00:00Z', body, replyClass: cls },
  ]);
  await t.db.sql`
    insert into orbit.drafts (user_id, person_id, chat_id, channel, kind, body, status, sent_at, thread_external_id,
                              provider_message_id)
    values (${userId}::uuid, ${personId}::uuid, ${chat!.id}::uuid, 'gmail', 'outreach',
            'Would you have 15 minutes?', 'sent', '2026-10-12T15:00:00Z'::timestamptz, ${th.externalId},
            ${`${th.externalId}-m0`})`;
  return { userId, token, personId, messageId: th.messageIds[1]! };
}

async function setSettings(token: string, body: Record<string, unknown>) {
  const call = api(t, fakeNet(google()));
  const r = await call('/settings/profile', token, body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

describe('Answer simple replies for me (plan 38 §E)', () => {
  it('off and without Autopilot mode: a cold recruiter who is interested gets nothing on its own', async () => {
    const s = makeServices(agentConfig(fakeNet(anthropic(() => REPLY).answer, google())), {
      db: t.db,
      now: () => NOW,
    });
    const x = await coldReply('interested', 'Happy to chat, this sounds great.');
    const r = await maybeAutoReply(t.db, x.userId, x.messageId, { services: s });
    expect(r).toEqual({ action: 'none', reason: 'autopilot_off' });
  });

  it('on: the same reply is drafted and goes, though the score is low and the mode is off', async () => {
    const s = makeServices(agentConfig(fakeNet(anthropic(() => REPLY).answer, google())), {
      db: t.db,
      now: () => NOW,
    });
    const x = await coldReply('interested', 'Happy to chat, this sounds great.');
    await setSettings(x.token, { autoReplies: true });
    const r = await maybeAutoReply(t.db, x.userId, x.messageId, { services: s });
    expect(r.action).toBe('auto_sent');
  });

  it('on, but a question still waits for the student', async () => {
    const s = makeServices(agentConfig(fakeNet(anthropic(() => REPLY).answer, google())), {
      db: t.db,
      now: () => NOW,
    });
    const x = await coldReply('question', 'Sure. What role are you applying for, and when do you graduate?');
    await setSettings(x.token, { autoReplies: true });
    const r = await maybeAutoReply(t.db, x.userId, x.messageId, { services: s });
    expect(r.action).toBe('needs_you');
  });
});

describe("a group's funnel (plan 38 §G)", () => {
  it('an interested reply from someone in a booking-link group gets the link, not three times', async () => {
    const s = makeServices(agentConfig(fakeNet(anthropic(() => REPLY).answer, google())), {
      db: t.db,
      now: () => NOW,
    });
    const x = await coldReply('interested', 'Happy to chat, this sounds great.');
    await setSettings(x.token, {
      schedulingLink: LINK,
      autoReplies: true,
      replyFunnels: [
        {
          id: 'g1',
          name: 'Recruiters, Nov 10',
          personIds: [x.personId],
          interested: 'link',
          createdAt: '2026-10-12T00:00:00.000Z',
        },
      ],
    });
    const r = await maybeAutoReply(t.db, x.userId, x.messageId, { services: s });
    expect(r.action).toBe('auto_sent');
    const [d] = await t.db.sql<{ body: string; ask: Record<string, unknown> }>`
      select body, ask from orbit.drafts where user_id = ${x.userId}::uuid and kind = 'reply' order by created_at desc limit 1`;
    expect(d!.body).toContain(LINK);
    expect(d!.body).toContain('Hi Priya');
    expect(d!.ask?.slots).toBeUndefined();
  });

  it("the student's own words for a group, drafted for approval when replies are not on", async () => {
    const s = makeServices(agentConfig(fakeNet(anthropic(() => REPLY).answer, google())), {
      db: t.db,
      now: () => NOW,
    });
    const x = await coldReply('interested', 'Sounds good, glad to help.');
    await setSettings(x.token, {
      replyFunnels: [
        {
          id: 'g2',
          name: 'Alumni',
          personIds: [x.personId],
          interested: 'own',
          reply: 'Hi {first}, thank you. Could I send you my resume for the {company} PM role first?',
          createdAt: '2026-10-12T00:00:00.000Z',
        },
      ],
    });
    const r = await maybeAutoReply(t.db, x.userId, x.messageId, { services: s });
    expect(r.action).toBe('drafted');
    const [d] = await t.db.sql<{ body: string; status: string }>`
      select body, status from orbit.drafts where user_id = ${x.userId}::uuid and kind = 'reply' order by created_at desc limit 1`;
    expect(d!.status).toBe('draft');
    expect(d!.body).toContain('Could I send you my resume for the Stripe PM role first?');
  });

  it('the settings refuse a bad group', async () => {
    const x = await coldReply('interested', 'ok');
    const r = await api(t, fakeNet(google()))('/settings/profile', x.token, {
      replyFunnels: [{ id: 'g', name: 'n', personIds: [], interested: 'maybe' }],
    });
    expect(r.status).toBe(400);
  });
});
