/**
 * An account's LinkedIn message sent from Orbit on the student's tap: into the chat they have, a new chat with a
 * connection, or a connection request with the message as its note when LinkedIn will not open a chat.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPerson,
  addThread,
  api,
  DAY,
  fakeNet,
  iso,
  jsonRes,
  type NetCall,
  signedInUser,
  UNIPILE,
} from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

type Answer = (c: NetCall) => Response | undefined;

async function setup(answer: Answer, person: { memberId?: string; linkedinUrl?: string; chat?: boolean }) {
  const net = fakeNet((c) => (c.url.startsWith(UNIPILE) ? answer(c) : undefined));
  const call = api(t, net, { env: { unipileKey: 'unipile-placeholder', unipileBase: UNIPILE } });
  const { userId, token } = await signedInUser(t);
  await t.db.sql`insert into orbit.integration_accounts (user_id, provider, external_account_id, status)
    values (${userId}::uuid, 'linkedin', 'acc-li', 'active')`;
  const p = await addPerson(t, userId, {
    name: 'Lou Link',
    memberId: person.memberId,
    linkedinUrl: person.linkedinUrl,
    score: 45,
  });
  if (person.chat)
    await addThread(
      t,
      userId,
      p,
      [{ direction: 'out', at: iso(10 * DAY), body: 'Hi Lou, great to connect.' }],
      {
        provider: 'linkedin',
        externalId: 'chat-lou',
      },
    );
  const c = await call<{ draft: { id: string } }>('/drafts/compose', token, {
    personId: p,
    kind: 'bump',
    channel: 'linkedin',
  });
  const send = (body = 'Hi Lou, would love 15 minutes to hear how you got into product.') =>
    call<{ draft: { status: string; error?: string | null } }>('/drafts/approve', token, {
      draftId: c.body.draft.id,
      body,
      confirm: true,
    });
  const unipile = () => net.calls.filter((x) => x.url.startsWith(UNIPILE));
  return { send, unipile, personId: p, draftId: c.body.draft.id, call, token, userId };
}

type Sent = { draft: { id: string; status: string; error?: string | null; cancelReason?: string | null } };
const OWN_WORDS = 'hey Lou, hope things are good.';

describe('LinkedIn sent from Orbit', () => {
  it('goes into the chat they already have', async () => {
    const s = await setup(
      (c) => (c.url.endsWith('/chats/chat-lou/messages') ? jsonRes(201, { message_id: 'm1' }) : undefined),
      {
        memberId: 'ACoAALou',
        chat: true,
      },
    );
    const r = await s.send();
    expect(r.body.draft.status).toBe('sent');
    expect(s.unipile().map((c) => `${c.method} ${c.url.slice(UNIPILE.length)}`)).toEqual([
      'POST /api/v1/chats/chat-lou/messages',
    ]);
  });

  it('starts a chat with a connection Orbit knows only by their profile address, and keeps the member id', async () => {
    const s = await setup(
      (c) =>
        c.method === 'GET' && c.url.includes('/api/v1/users/loulink')
          ? jsonRes(200, { provider_id: 'ACoAALou' })
          : c.url.endsWith('/api/v1/chats')
            ? jsonRes(201, { message_id: 'm2', chat_id: 'chat-new' })
            : undefined,
      { linkedinUrl: 'https://www.linkedin.com/in/loulink' },
    );
    expect((await s.send()).body.draft.status).toBe('sent');
    const chat = s.unipile().find((c) => c.url.endsWith('/api/v1/chats'))!;
    expect(chat.body).toMatchObject({ account_id: 'acc-li', attendees_ids: 'ACoAALou' });
    const [p] = await t.db.sql<{ linkedin_member_id: string | null }>`
      select linkedin_member_id from orbit.people where id = ${s.personId}::uuid`;
    expect(p!.linkedin_member_id).toBe('ACoAALou');
    const [d] = await t.db.sql<{ thread_external_id: string | null }>`
      select thread_external_id from orbit.drafts where id = ${s.draftId}::uuid`;
    expect(d!.thread_external_id).toBe('chat-new');
  });

  it('sends a connection request with the message as its note when they are not connected', async () => {
    const s = await setup(
      (c) =>
        c.url.endsWith('/api/v1/chats')
          ? jsonRes(422, { detail: 'recipient cannot be reached' })
          : c.url.endsWith('/api/v1/users/invite')
            ? jsonRes(201, { invitation_id: 'inv-1' })
            : undefined,
      { memberId: 'ACoAALou' },
    );
    expect((await s.send()).body.draft.status).toBe('sent');
    const invite = s.unipile().find((c) => c.url.endsWith('/users/invite'))!;
    expect(invite.body).toMatchObject({ account_id: 'acc-li', provider_id: 'ACoAALou' });
    const [d] = await t.db.sql<{ provider_message_id: string | null }>`
      select provider_message_id from orbit.drafts where id = ${s.draftId}::uuid`;
    expect(d!.provider_message_id).toBe('inv-1');
  });

  it('a note over 300 characters is not sent as a request: it fails with the reason', async () => {
    const s = await setup((c) => (c.url.endsWith('/api/v1/chats') ? jsonRes(422, {}) : undefined), {
      memberId: 'ACoAALou',
    });
    const r = await s.send(`Hi Lou, ${'I would love to hear how you think about product. '.repeat(8)}`);
    expect(r.body.draft).toMatchObject({ status: 'failed', error: 'linkedin_note_too_long' });
    expect(s.unipile().some((c) => c.url.endsWith('/users/invite'))).toBe(false);
  });

  it('a connection who will not take a chat is not sent a request instead', async () => {
    const s = await setup((c) => (c.url.endsWith('/api/v1/chats') ? jsonRes(422, {}) : undefined), {
      memberId: 'ACoAALou',
    });
    await t.db.sql`update orbit.people set linkedin_connected_on = now() where id = ${s.personId}::uuid`;
    expect((await s.send()).body.draft).toMatchObject({ status: 'failed', error: 'unipile_422' });
    expect(s.unipile().some((c) => c.url.endsWith('/users/invite'))).toBe(false);
  });

  // ---- a message the student wrote in the app (a person's page, Drafts): the server never composed it -------------

  it('keeps a message the student wrote in the app and sends it on the tap, like one it composed', async () => {
    const s = await setup(
      (c) => (c.url.endsWith('/chats/chat-lou/messages') ? jsonRes(201, { message_id: 'm-own' }) : undefined),
      { memberId: 'ACoAALou', chat: true },
    );
    const id = crypto.randomUUID();
    const r = await s.call<Sent>('/drafts/approve', s.token, {
      draftId: id,
      body: OWN_WORDS,
      confirm: true,
      write: { personId: s.personId, kind: 'reply', channel: 'linkedin' },
    });
    expect(r.status).toBe(200);
    expect(r.body.draft).toMatchObject({ id, status: 'sent' });
    const sent = s.unipile().filter((c) => c.method === 'POST');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ account_id: 'acc-li', text: OWN_WORDS });
    const [d] = await t.db.sql<{ body: string; generated_by: string; channel: string; kind: string }>`
      select body, generated_by, channel, kind from orbit.drafts where id = ${id}::uuid and user_id = ${s.userId}::uuid`;
    expect(d).toEqual({ body: OWN_WORDS, generated_by: 'user', channel: 'linkedin', kind: 'reply' });
    // the student's own words are not an edit of Orbit's
    const edits = await t.db.sql`select 1 from orbit.draft_edits where draft_id = ${id}::uuid`;
    expect(edits).toHaveLength(0);
    // the same tap again (a double click, a retry after a lost answer) never sends a second copy
    const again = await s.call<Sent>('/drafts/approve', s.token, {
      draftId: id,
      body: OWN_WORDS,
      confirm: true,
      write: { personId: s.personId, kind: 'reply', channel: 'linkedin' },
    });
    expect(again.body.draft.status).toBe('sent');
    expect(s.unipile().filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('a first message to someone who is not a connection goes as a request with the words as its note', async () => {
    const s = await setup(
      (c) =>
        c.method === 'GET' && c.url.includes('/api/v1/users/loulink')
          ? jsonRes(200, { provider_id: 'ACoAALou' })
          : c.url.endsWith('/api/v1/chats')
            ? jsonRes(422, { detail: 'recipient cannot be reached' })
            : c.url.endsWith('/api/v1/users/invite')
              ? jsonRes(201, { invitation_id: 'inv-own' })
              : undefined,
      { linkedinUrl: 'https://www.linkedin.com/in/loulink' },
    );
    const id = crypto.randomUUID();
    const r = await s.call<Sent>('/drafts/approve', s.token, {
      draftId: id,
      body: OWN_WORDS,
      confirm: true,
      write: { personId: s.personId, kind: 'outreach', channel: 'linkedin' },
    });
    expect(r.body.draft.status).toBe('sent');
    const invite = s.unipile().find((c) => c.url.endsWith('/users/invite'))!;
    expect(invite.body).toMatchObject({ account_id: 'acc-li', provider_id: 'ACoAALou', message: OWN_WORDS });
  });

  it('nothing is kept or sent without the tap', async () => {
    const s = await setup(() => jsonRes(201, { message_id: 'never' }), { memberId: 'ACoAALou', chat: true });
    const id = crypto.randomUUID();
    for (const extra of [{}, { confirm: false }, { sendAt: new Date().toISOString() }]) {
      const r = await s.call<{ error?: { code?: string } }>('/drafts/approve', s.token, {
        draftId: id,
        body: OWN_WORDS,
        write: { personId: s.personId, kind: 'reply', channel: 'linkedin' },
        ...extra,
      });
      expect(r.status).toBe(409);
    }
    expect(await t.db.sql`select 1 from orbit.drafts where id = ${id}::uuid`).toHaveLength(0);
    expect(s.unipile()).toHaveLength(0);
  });

  it('only for one of the student own people, never another channel, and never over another account draft', async () => {
    const s = await setup(() => jsonRes(201, { message_id: 'never' }), { memberId: 'ACoAALou', chat: true });
    const other = await setup(() => jsonRes(201, { message_id: 'never' }), { memberId: 'ACoAAOther' });
    const write = { personId: s.personId, kind: 'reply', channel: 'linkedin' };
    const tries: [Record<string, unknown>, number][] = [
      // only LinkedIn and email are written this way (an email has its own tests)
      [{ draftId: crypto.randomUUID(), write: { ...write, channel: 'sms' } }, 400],
      [{ draftId: crypto.randomUUID(), write: { ...write, kind: 'not_a_kind' } }, 400],
      // someone in another account
      [{ draftId: crypto.randomUUID(), write: { ...write, personId: other.personId } }, 404],
      // an id another account's draft already has
      [{ draftId: other.draftId, write }, 404],
    ];
    for (const [req, status] of tries) {
      const r = await s.call('/drafts/approve', s.token, { body: OWN_WORDS, confirm: true, ...req });
      expect(r.status).toBe(status);
    }
    expect(s.unipile()).toHaveLength(0);
    expect(other.unipile()).toHaveLength(0);
    const [d] = await t.db.sql<{ user_id: string; status: string }>`
      select user_id, status from orbit.drafts where id = ${other.draftId}::uuid`;
    expect(d).toEqual({ user_id: other.userId, status: 'draft' });
  });

  it('without LinkedIn linked the words are kept and the answer says why they did not go', async () => {
    const s = await setup(() => jsonRes(201, { message_id: 'never' }), { memberId: 'ACoAALou', chat: true });
    await t.db.sql`update orbit.integration_accounts set status = 'parked', external_account_id = null
                    where user_id = ${s.userId}::uuid and provider = 'linkedin'`;
    const id = crypto.randomUUID();
    const r = await s.call<Sent>('/drafts/approve', s.token, {
      draftId: id,
      body: OWN_WORDS,
      confirm: true,
      write: { personId: s.personId, kind: 'reply', channel: 'linkedin' },
    });
    expect(r.body.draft).toMatchObject({ status: 'failed', error: 'linkedin_not_connected' });
    expect(s.unipile()).toHaveLength(0);
  });

  it('a rule that stops the student own words says which, and the next tap is checked afresh', async () => {
    const s = await setup(
      (c) =>
        c.url.endsWith('/chats/chat-lou/messages') ? jsonRes(201, { message_id: 'm-own-2' }) : undefined,
      { memberId: 'ACoAALou', chat: true },
    );
    const id = crypto.randomUUID();
    const write = { personId: s.personId, kind: 'reply', channel: 'linkedin' };
    await t.db
      .sql`update orbit.people set headline = 'Sophomore at Lincoln High School' where id = ${s.personId}::uuid`;
    const stopped = await s.call<Sent>('/drafts/approve', s.token, {
      draftId: id,
      body: OWN_WORDS,
      confirm: true,
      write,
    });
    expect(stopped.body.draft).toMatchObject({ status: 'cancelled', cancelReason: 'minor' });
    expect(s.unipile()).toHaveLength(0);
    // the reason is gone (the profile was read wrong): the same draft, tapped again, goes
    await t.db.sql`update orbit.people set headline = 'Product manager' where id = ${s.personId}::uuid`;
    const again = await s.call<Sent>('/drafts/approve', s.token, {
      draftId: id,
      body: OWN_WORDS,
      confirm: true,
      write,
    });
    expect(again.body.draft.status).toBe('sent');
  });

  it('connection requests are counted, and the day limit stops the next one before it reaches LinkedIn', async () => {
    const s = await setup(
      (c) =>
        c.url.endsWith('/api/v1/chats')
          ? jsonRes(422, { detail: 'recipient cannot be reached' })
          : c.url.endsWith('/api/v1/users/invite')
            ? jsonRes(201, { invitation_id: 'inv-counted' })
            : undefined,
      { memberId: 'ACoAALou' },
    );
    const write = { personId: s.personId, kind: 'outreach', channel: 'linkedin' };
    const first = await s.call<Sent>('/drafts/approve', s.token, {
      draftId: crypto.randomUUID(),
      body: OWN_WORDS,
      confirm: true,
      write,
    });
    expect(first.body.draft.status).toBe('sent');
    const counted = await t.db.sql`
      select 1 from orbit.audit_log where user_id = ${s.userId}::uuid and action = 'linkedin.invite'`;
    expect(counted).toHaveLength(1);
    // fourteen more today: the day is full
    for (let i = 0; i < 14; i++)
      await t.db.sql`
        insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
        values (${s.userId}::uuid, 'user', 'linkedin.invite', 'drafts', ${crypto.randomUUID()}, '{}'::jsonb)`;
    const invitesBefore = s.unipile().filter((c) => c.url.endsWith('/users/invite')).length;
    const next = await s.call<Sent>('/drafts/approve', s.token, {
      draftId: crypto.randomUUID(),
      body: OWN_WORDS,
      confirm: true,
      write,
    });
    expect(next.body.draft).toMatchObject({ status: 'failed', error: 'linkedin_invite_daily_cap' });
    expect(s.unipile().filter((c) => c.url.endsWith('/users/invite'))).toHaveLength(invitesBefore);
  });
});
