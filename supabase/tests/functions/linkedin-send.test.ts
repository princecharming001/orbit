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
  return { send, unipile, personId: p, draftId: c.body.draft.id };
}

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
});
