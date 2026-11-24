/**
 * Connect on someone a people search found (POST /source/connect, _shared/sourcing/connect.ts): the person is saved
 * as Save does, one LinkedIn connection request with no note goes from the student's own account, and the chat stands
 * where a sent request belongs. Once per student and person; whatever stops the request, the person is saved and the
 * answer says why. Unipile is stubbed by URL: nothing here reaches LinkedIn.
 */
import { SEND_CAPS } from '@orbit/core/safety/rules';
import type { SourceConnectResponse } from '@orbit/core/server/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addPerson, api, fakeNet, jsonRes, type NetCall, signedInUser, UNIPILE } from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

type Answer = (c: NetCall) => Response | undefined;
const invited: Answer = (c) =>
  c.url.endsWith('/api/v1/users/invite') ? jsonRes(201, { invitation_id: 'inv-1' }) : undefined;

let seq = 0;
async function setup(
  answer: Answer = invited,
  o: {
    /** the student's LinkedIn link: its status, or none at all */
    linkedin?: string | null;
    candidate?: Record<string, unknown>;
    env?: Record<string, unknown>;
  } = {},
) {
  seq++;
  const net = fakeNet((c) => (c.url.startsWith(UNIPILE) ? answer(c) : undefined));
  const call = api(t, net, {
    env: { unipileKey: 'unipile-placeholder', unipileBase: UNIPILE, ...(o.env ?? {}) },
  });
  const { userId, token } = await signedInUser(t);
  if (o.linkedin !== null)
    await t.db.sql`insert into orbit.integration_accounts (user_id, provider, external_account_id, status)
      values (${userId}::uuid, 'linkedin', ${`acc-${seq}`}, ${o.linkedin ?? 'active'})`;
  const candidate = {
    key: `k${seq}`,
    entity: 'person',
    name: 'Maya Chen',
    title: 'Partner',
    org: 'Seed Fund',
    headline: 'Partner at Seed Fund',
    linkedinUrl: `https://www.linkedin.com/in/maya-chen-${seq}`,
    memberId: `ACoAAMaya${seq}`,
    networkDistance: 2,
    // no address lookup: this test is about the request
    emailLookedUp: true,
    sources: ['unipile'],
    externalIds: {},
    ...(o.candidate ?? {}),
  };
  const [rec] = await t.db.sql<{ id: string }>`
    insert into orbit.recommendations (user_id, candidate, source, rank, batch_id)
    values (${userId}::uuid, ${candidate}::jsonb, 'unipile', 0.8, gen_random_uuid()) returning id`;
  const connect = (body: Record<string, unknown> = { recommendationId: rec!.id }) =>
    call<SourceConnectResponse & { error?: string }>('/source/connect', token, body);
  const unipile = () =>
    net.calls
      .filter((x) => x.url.startsWith(UNIPILE))
      .map((c) => `${c.method} ${c.url.slice(UNIPILE.length)}`);
  const invites = () => net.calls.filter((c) => c.url.endsWith('/api/v1/users/invite'));
  const chatOf = async (chatId: string) => {
    const [c] = await t.db.sql<{ stage: string; data: Record<string, unknown> }>`
      select stage, data from orbit.chats where id = ${chatId}::uuid`;
    return c!;
  };
  const markers = () =>
    t.db.sql<{ target: string; status: string; invitation_id: string | null; person_id: string | null }>`
      select target, status, invitation_id, person_id from orbit.linkedin_connects where user_id = ${userId}::uuid`;
  const audits = () =>
    t.db.sql<{
      actor: string;
      action: string;
      target_table: string;
      target_id: string;
      details: Record<string, unknown>;
    }>`
      select actor, action, target_table, target_id, details from orbit.audit_log
       where user_id = ${userId}::uuid and action like 'linkedin.invite%' order by created_at`;
  return {
    connect,
    unipile,
    invites,
    chatOf,
    markers,
    audits,
    userId,
    token,
    call,
    recId: rec!.id,
    account: `acc-${seq}`,
    slug: `maya-chen-${seq}`,
    candidate,
  };
}

describe('POST /source/connect', () => {
  it("saves the person and sends one request, with no note, through the student's own LinkedIn", async () => {
    const s = await setup();
    // another student's LinkedIn is in the same table: it is never the one used
    const other = await signedInUser(t);
    await t.db.sql`insert into orbit.integration_accounts (user_id, provider, external_account_id, status)
      values (${other.userId}::uuid, 'linkedin', 'acc-someone-else', 'active')`;

    const r = await s.connect();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sent: true, person: { displayName: 'Maya Chen' } });
    expect(r.body.code).toBeUndefined();
    expect(r.body.reason).toBeUndefined();

    // one call to LinkedIn, the request itself: no chat, no message, no list of accounts, no webhook
    expect(s.unipile()).toEqual(['POST /api/v1/users/invite']);
    expect(s.invites()[0]!.body).toEqual({ account_id: s.account, provider_id: s.candidate.memberId });

    // saved as Save saves them
    const [p] = await t.db.sql<{
      display_name: string;
      title: string;
      linkedin_slug: string;
      user_id: string;
    }>`
      select display_name, title, linkedin_slug, user_id from orbit.people where id = ${r.body.person.id}::uuid`;
    expect(p).toMatchObject({ display_name: 'Maya Chen', title: 'Partner', user_id: s.userId });
    const [rec] = await t.db.sql<{ status: string; person_id: string }>`
      select status, person_id from orbit.recommendations where id = ${s.recId}::uuid`;
    expect(rec).toEqual({ status: 'added', person_id: r.body.person.id });

    // the chat stands where a sent request belongs, never at "to contact"
    const chat = await s.chatOf(r.body.person.chatId);
    expect(chat.stage).toBe('outreach_sent');
    expect(chat.data.outreachChannel).toBe('linkedin');
    expect(typeof chat.data.connectionRequestedAt).toBe('string');
    // a request is not a message: nothing for a follow-up to count from
    expect(chat.data.lastOutboundAt).toBeUndefined();
    const events = await t.db.sql<{
      from_stage: string | null;
      to_stage: string;
      actor: string;
      reason: string;
    }>`
      select from_stage, to_stage, actor, reason from orbit.stage_events
       where chat_id = ${r.body.person.chatId}::uuid order by created_at, decided_at`;
    expect(events.at(-1)).toMatchObject({
      from_stage: 'identified',
      to_stage: 'outreach_sent',
      actor: 'user',
      reason: 'connection request sent',
    });

    // the record: the row the invite limits count, on the student's own tap
    const audits = await s.audits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: 'user',
      action: 'linkedin.invite',
      target_table: 'people',
      target_id: r.body.person.id,
    });
    expect(audits[0]!.details).toMatchObject({
      via: 'source.connect',
      note: false,
      invitationId: 'inv-1',
      chatId: r.body.person.chatId,
      recommendationId: s.recId,
    });
    expect(await s.markers()).toEqual([
      {
        target: `in:${s.slug}`,
        status: 'sent',
        invitation_id: 'inv-1',
        person_id: r.body.person.id,
      },
    ]);
    // nothing else was made to send: no draft, no queued job
    expect(await t.db.sql`select 1 from orbit.drafts where user_id = ${s.userId}::uuid`).toHaveLength(0);
  });

  it('a second click sends nothing, and says a request is already out', async () => {
    const s = await setup();
    const first = await s.connect();
    expect(first.body.sent).toBe(true);
    const again = await s.connect();
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      sent: false,
      code: 'already_requested',
      reason: 'You already sent them a connection request. Saved to People.',
      person: { id: first.body.person.id, chatId: first.body.person.chatId },
    });
    // by the person too, once they are in People
    const byPerson = await s.connect({ personId: first.body.person.id });
    expect(byPerson.body).toMatchObject({ sent: false, code: 'already_requested' });
    expect(s.invites()).toHaveLength(1);
    expect(await s.audits()).toHaveLength(1);
    expect((await s.chatOf(first.body.person.chatId)).stage).toBe('outreach_sent');
  });

  it('two clicks at the same moment send one request', async () => {
    const s = await setup();
    const both = await Promise.all([s.connect(), s.connect()]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(both.filter((r) => r.body.sent)).toHaveLength(1);
    expect(both.find((r) => !r.body.sent)!.body.code).toBe('already_requested');
    expect(s.invites()).toHaveLength(1);
    expect(await s.markers()).toHaveLength(1);
  });

  it('over the weekly limit it saves the person, sends nothing and says why', async () => {
    const s = await setup();
    for (let i = 0; i < SEND_CAPS.linkedinInvitesPerWeek; i++)
      await t.db.sql`
        insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details, created_at)
        values (${s.userId}::uuid, 'user', 'linkedin.invite', 'drafts', ${`d${i}`}, '{}'::jsonb,
                now() - interval '2 days' - make_interval(mins => ${i}))`;
    const r = await s.connect();
    expect(r.body).toMatchObject({
      sent: false,
      code: 'weekly_limit',
      reason: "LinkedIn's weekly limit on connection requests is reached. Saved to People instead.",
    });
    expect(s.unipile()).toEqual([]);
    // saved, at "to contact", with nothing recorded as sent
    expect(r.body.person.displayName).toBe('Maya Chen');
    expect((await s.chatOf(r.body.person.chatId)).stage).toBe('identified');
    expect(await s.markers()).toEqual([]);
    expect((await s.audits()).filter((a) => a.details.via === 'source.connect')).toEqual([]);
  });

  it('over the daily limit it saves and says so; a later click can still send', async () => {
    const s = await setup();
    for (let i = 0; i < SEND_CAPS.linkedinInvitesPerDay; i++)
      await t.db.sql`
        insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details, created_at)
        values (${s.userId}::uuid, 'user', 'linkedin.invite', 'drafts', ${`d${i}`}, '{}'::jsonb,
                now() - make_interval(mins => ${i + 1}))`;
    const r = await s.connect();
    expect(r.body).toMatchObject({
      sent: false,
      code: 'daily_limit',
      reason: "Today's limit on connection requests is reached. Saved to People instead.",
    });
    expect(s.invites()).toHaveLength(0);
    // the day passes: the same person can be asked again, and the request goes once
    await t.db.sql`update orbit.audit_log set created_at = created_at - interval '2 days'
                    where user_id = ${s.userId}::uuid and action = 'linkedin.invite'`;
    const later = await s.connect({ personId: r.body.person.id });
    expect(later.body).toMatchObject({ sent: true, person: { id: r.body.person.id } });
    expect(s.invites()).toHaveLength(1);
    expect((await s.chatOf(r.body.person.chatId)).stage).toBe('outreach_sent');
  });

  it.each([
    [null, 'LinkedIn is not connected. Saved to People instead.'],
    ['parked', 'LinkedIn is paused because you were away. Saved to People instead.'],
    ['needs_reauth', 'LinkedIn signed Orbit out. Saved to People instead.'],
  ])('LinkedIn %s: not sent, saved, and the reason says so', async (status, reason) => {
    const s = await setup(invited, { linkedin: status });
    const r = await s.connect();
    expect(r.body).toMatchObject({ sent: false, code: 'linkedin_not_active', reason });
    expect(s.unipile()).toEqual([]);
    const [p] = await t.db.sql`select 1 from orbit.people where id = ${r.body.person.id}::uuid`;
    expect(p).toBeTruthy();
    expect((await s.chatOf(r.body.person.chatId)).stage).toBe('identified');
    expect(await s.markers()).toEqual([]);
  });

  it('a 1st-degree connection gets no request', async () => {
    const s = await setup(invited, { candidate: { networkDistance: 1 } });
    const r = await s.connect();
    expect(r.body).toMatchObject({
      sent: false,
      code: 'already_connected',
      reason: 'You are already connected on LinkedIn. Saved to People.',
    });
    expect(s.unipile()).toEqual([]);
  });

  it('someone with no LinkedIn profile is saved, and the answer says there is none', async () => {
    const s = await setup(invited, { candidate: { linkedinUrl: undefined, memberId: undefined } });
    const r = await s.connect();
    expect(r.body).toMatchObject({
      sent: false,
      code: 'no_profile',
      reason: 'Orbit has no LinkedIn profile for them. Saved to People instead.',
    });
    expect(s.unipile()).toEqual([]);
  });

  it('with only a profile address it looks the member up first, keeps the id, then sends', async () => {
    const s = await setup(
      (c) =>
        c.method === 'GET' && c.url.includes('/api/v1/users/maya-chen-')
          ? jsonRes(200, { provider_id: 'ACoAALooked', network_distance: 'DISTANCE_2' })
          : invited(c),
      { candidate: { memberId: undefined } },
    );
    const r = await s.connect();
    expect(r.body.sent).toBe(true);
    expect(s.unipile()).toEqual([
      `GET /api/v1/users/${s.slug}?account_id=${s.account}&notify=false`,
      'POST /api/v1/users/invite',
    ]);
    expect(s.invites()[0]!.body).toEqual({ account_id: s.account, provider_id: 'ACoAALooked' });
    const [p] = await t.db.sql<{ linkedin_member_id: string }>`
      select linkedin_member_id from orbit.people where id = ${r.body.person.id}::uuid`;
    expect(p!.linkedin_member_id).toBe('ACoAALooked');
  });

  it('a profile LinkedIn says is already a connection, or already has a request waiting, gets no second one', async () => {
    const connected = await setup(
      (c) =>
        c.method === 'GET'
          ? jsonRes(200, { provider_id: 'ACoAAX', network_distance: 'FIRST_DEGREE' })
          : invited(c),
      { candidate: { memberId: undefined } },
    );
    expect((await connected.connect()).body).toMatchObject({ sent: false, code: 'already_connected' });
    expect(connected.invites()).toHaveLength(0);

    const waiting = await setup(
      (c) =>
        c.method === 'GET'
          ? jsonRes(200, { provider_id: 'ACoAAY', invitation: { type: 'SENT', status: 'PENDING' } })
          : invited(c),
      { candidate: { memberId: undefined } },
    );
    const r = await waiting.connect();
    expect(r.body).toMatchObject({
      sent: false,
      code: 'already_requested',
      reason: 'LinkedIn says you already have a connection request out to them. Saved to People.',
    });
    expect(waiting.invites()).toHaveLength(0);
    // remembered as waiting, so the next click does not even ask LinkedIn
    expect((await waiting.markers()).map((m) => m.status)).toEqual(['sent']);
    await waiting.connect();
    expect(waiting.unipile()).toHaveLength(1);
  });

  it.each([
    [
      422,
      { type: 'errors/already_invited_recently', detail: 'Should not be reinvited so soon' },
      'already_requested',
      'LinkedIn says you already have a connection request out to them. Saved to People.',
    ],
    [
      422,
      { type: 'errors/cannot_resend_yet', detail: 'Resend not possible yet' },
      'linkedin_limit',
      'LinkedIn says you have reached its limit on connection requests. Saved to People instead.',
    ],
    [
      429,
      { type: 'errors/limit_exceeded', detail: 'Too many invitations' },
      'linkedin_limit',
      'LinkedIn says you have reached its limit on connection requests. Saved to People instead.',
    ],
    [
      404,
      { type: 'errors/resource_not_found', detail: 'Recipient not found' },
      'profile_not_found',
      'LinkedIn could not find their profile. Saved to People instead.',
    ],
    [
      403,
      { type: 'errors/feature_not_subscribed' },
      'refused',
      'LinkedIn would not take the request. Saved to People instead.',
    ],
  ])('LinkedIn refuses with %i %j: saved, and the reason is %s', async (status, body, code, reason) => {
    const s = await setup((c) => (c.url.endsWith('/users/invite') ? jsonRes(status, body) : undefined));
    const r = await s.connect();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sent: false, code, reason });
    expect(r.body.person.displayName).toBe('Maya Chen');
    expect((await s.chatOf(r.body.person.chatId)).stage).toBe('identified');
    // it counts against no limit, and is on record as refused
    const audits = await s.audits();
    expect(audits.map((a) => a.action)).toEqual(['linkedin.invite_refused']);
    // a request already waiting is remembered; any other refusal leaves the way open for a later try
    expect((await s.markers()).map((m) => m.status)).toEqual(code === 'already_requested' ? ['sent'] : []);
  });

  it('a call that breaks off after it left is never sent a second time', async () => {
    const s = await setup((c) => (c.url.endsWith('/users/invite') ? jsonRes(502, {}) : undefined));
    const r = await s.connect();
    expect(r.body).toMatchObject({ sent: false, code: 'unconfirmed' });
    expect(r.body.reason).toMatch(/^LinkedIn did not confirm the request\./);
    expect((await s.markers()).map((m) => m.status)).toEqual(['unconfirmed']);
    const again = await s.connect();
    expect(again.body).toMatchObject({ sent: false, code: 'unconfirmed' });
    expect(s.invites()).toHaveLength(1);
  });

  it('the swarm limit holds the profile look: no call to LinkedIn, saved, and a later click can try again', async () => {
    const s = await setup(
      (c) => (c.method === 'GET' ? jsonRes(200, { provider_id: 'ACoAASwarm' }) : invited(c)),
      {
        candidate: { memberId: undefined },
        env: { linkedinTarget: { accountsPerDay: 3, gapSeconds: 1200 } },
      },
    );
    // another account looked this person up a moment ago
    await t.db.sql`select public.orbit_linkedin_target_take(${s.slug}, 'acc-elsewhere', 3, 1200)`;
    const r = await s.connect();
    expect(r.body).toMatchObject({
      sent: false,
      code: 'busy',
      reason: 'LinkedIn is busy just now, so no request was sent. Saved to People instead.',
    });
    expect(s.unipile()).toEqual([]);
    expect(await s.markers()).toEqual([]);
  });

  it('never asks someone who said not to be contacted, and takes only ids of the student', async () => {
    const s = await setup();
    const p = await addPerson(t, s.userId, {
      name: 'Dee Nott',
      linkedinUrl: 'https://www.linkedin.com/in/dee-nott',
      memberId: 'ACoAADee',
      doNotContact: true,
    });
    const r = await s.connect({ personId: p });
    expect(r.body).toMatchObject({ sent: false, code: 'do_not_contact' });
    expect(s.unipile()).toEqual([]);

    // someone else's person and someone else's recommendation are not found
    const other = await setup();
    expect((await s.connect({ personId: (await other.connect()).body.person.id })).status).toBe(404);
    expect((await s.connect({ recommendationId: other.recId })).status).toBe(404);
    expect((await s.connect({})).status).toBe(400);
    expect((await s.connect({ recommendationId: s.recId, personId: p })).status).toBe(400);
    // and none of those sent anything from this student's account
    expect(s.invites()).toHaveLength(0);
  });

  it('Connect on someone already in People by their id: the newest open chat moves, one already further on stays', async () => {
    const s = await setup();
    const p = await addPerson(t, s.userId, {
      name: 'Rae Further',
      linkedinUrl: 'https://www.linkedin.com/in/rae-further',
      memberId: 'ACoAARae',
    });
    const [chat] = await t.db.sql<{ id: string }>`
      insert into orbit.chats (user_id, person_id, stage, data)
      values (${s.userId}::uuid, ${p}::uuid, 'replied', ${{ outreachChannel: 'email', bumpCount: 0 }}::jsonb)
      returning id`;
    const r = await s.connect({ personId: p });
    expect(r.body).toMatchObject({
      sent: true,
      person: { id: p, chatId: chat!.id, displayName: 'Rae Further' },
    });
    const after = await s.chatOf(chat!.id);
    expect(after.stage).toBe('replied');
    expect(after.data.outreachChannel).toBe('email');
    expect(typeof after.data.connectionRequestedAt).toBe('string');
  });

  it('without Unipile set up it saves and says Orbit cannot send requests', async () => {
    const s = await setup(invited, { env: { unipileKey: undefined, unipileBase: undefined } });
    const r = await s.connect();
    expect(r.body).toMatchObject({
      sent: false,
      code: 'unavailable',
      reason: 'Orbit cannot send connection requests right now. Saved to People instead.',
    });
    expect(await s.markers()).toEqual([]);
  });
});
