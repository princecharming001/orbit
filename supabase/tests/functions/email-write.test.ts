/**
 * An email the student wrote in the app (on a person's page, in Drafts, in the conversation box): the approval says
 * who it is for (`write`), the server keeps it under the draft's own id and sends it from the student's Gmail like one
 * it composed, after the undo window. It never goes to an address other than the one Orbit holds for that person.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendDraft } from '../../functions/_shared/sending/send.ts';
import { makeServices } from '../../functions/_shared/services.ts';
import {
  addPerson,
  agentConfig,
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

const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const WORDS = 'Hi Ivy, thanks again for the call on Tuesday. I sent the notes over this morning.';

function gmail() {
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
    return undefined;
  };
}

type Draft = {
  draft: {
    id: string;
    status: string;
    sendAt?: string | null;
    subject?: string | null;
    error?: string | null;
  };
};
type Refused = { error: { code: string; message: string } };

async function setup(person: { email?: string } = { email: 'ivy@example.com' }) {
  const net = fakeNet(gmail());
  const call = api(t, net, { env: {} });
  const { userId, token } = await signedInUser(t);
  const personId = await addPerson(t, userId, { name: 'Ivy Chen', ...person });
  const sends = () => net.calls.filter((c) => c.url === GMAIL_SEND);
  const approve = <T = Draft>(over: Record<string, unknown> = {}, write: Record<string, unknown> = {}) =>
    call<T>('/drafts/approve', token, {
      draftId: crypto.randomUUID(),
      body: WORDS,
      subject: 'Notes from Tuesday',
      undoSec: 10,
      write: { personId, kind: 'reply', channel: 'gmail', ...write },
      ...over,
    });
  return { net, call, userId, token, personId, sends, approve };
}

describe('an email the student wrote is sent from Orbit', () => {
  it('is kept under its own id with the words, the subject and who wrote it, and waits out the undo window', async () => {
    const s = await setup();
    const id = crypto.randomUUID();
    const r = await s.approve({ draftId: id }, { to: 'ivy@example.com' });
    expect(r.status).toBe(200);
    expect(r.body.draft).toMatchObject({ id, status: 'approved' });
    const wait = new Date(r.body.draft.sendAt!).getTime() - Date.now();
    expect(wait).toBeGreaterThan(5_000);
    expect(wait).toBeLessThanOrEqual(10_500);
    // nothing has gone yet: the student can still stop it
    expect(s.sends()).toHaveLength(0);
    const [d] = await t.db.sql<Record<string, unknown>>`
      select body, subject, generated_by, channel, kind, person_id from orbit.drafts
       where id = ${id}::uuid and user_id = ${s.userId}::uuid`;
    expect(d).toEqual({
      body: WORDS,
      subject: 'Notes from Tuesday',
      generated_by: 'user',
      channel: 'gmail',
      kind: 'reply',
      person_id: s.personId,
    });
    // the student's own words are not an edit of Orbit's
    expect(await t.db.sql`select 1 from orbit.draft_edits where draft_id = ${id}::uuid`).toHaveLength(0);
  });

  it('goes from the student’s Gmail to the address Orbit holds, once', async () => {
    const s = await setup();
    const id = crypto.randomUUID();
    await s.approve({ draftId: id });
    // inside the undo window the job leaves it alone
    expect((await sendDraft(makeServices(agentConfig(s.net, {}), { db: t.db }), id)).status).toBe('skipped');
    expect(s.sends()).toHaveLength(0);
    // the window is over
    await t.db.sql`update orbit.drafts set send_at = now() - interval '1 second' where id = ${id}::uuid`;
    const sent = await sendDraft(makeServices(agentConfig(s.net, {}), { db: t.db }), id);
    expect(sent.status).toBe('sent');
    expect(s.sends()).toHaveLength(1);
    const raw = Buffer.from(String((s.sends()[0]!.body as { raw: string }).raw), 'base64url').toString(
      'utf8',
    );
    expect(raw).toMatch(/^To: .*ivy@example\.com/m);
    expect(raw).toMatch(/^Subject: Notes from Tuesday/m);
    // the words go as written (the body is encoded for the wire)
    expect(
      raw.replace(/=\r?\n/g, '') +
        Buffer.from(
          raw
            .split(/\r?\n\r?\n/)
            .slice(1)
            .join(''),
          'base64',
        ).toString('utf8'),
    ).toContain('thanks again for the call on Tuesday');
    // the job run a second time sends nothing more
    await sendDraft(makeServices(agentConfig(s.net, {}), { db: t.db }), id);
    expect(s.sends()).toHaveLength(1);
  });

  it('Undo stops it; the same draft approved again goes, and no second draft is made', async () => {
    const s = await setup();
    const id = crypto.randomUUID();
    await s.approve({ draftId: id });
    const undo = await s.call<Draft>('/drafts/cancel', s.token, { draftId: id });
    expect(undo.body.draft.status).toBe('cancelled');
    expect((await sendDraft(makeServices(agentConfig(s.net, {}), { db: t.db }), id)).status).toBe('skipped');
    expect(s.sends()).toHaveLength(0);
    // the student changes a word and sends again: the words as they are now
    const again = await s.approve({ draftId: id, body: `${WORDS} Talk soon.`, undoSec: undefined });
    expect(again.status).toBe(200);
    expect(again.body.draft.status).toBe('sent');
    expect(s.sends()).toHaveLength(1);
    const rows = await t.db.sql<{ body: string }>`
      select body from orbit.drafts where user_id = ${s.userId}::uuid`;
    expect(rows).toEqual([{ body: `${WORDS} Talk soon.` }]);
  });

  it('someone Orbit had no address for: the address the student typed is kept on the person and used', async () => {
    const s = await setup({});
    const id = crypto.randomUUID();
    const r = await s.approve({ draftId: id, undoSec: undefined }, { to: 'Ivy.Chen@Example.com' });
    expect(r.status).toBe(200);
    expect(r.body.draft.status).toBe('sent');
    const [p] = await t.db.sql<{ primary_email: string }>`
      select primary_email from orbit.people where id = ${s.personId}::uuid`;
    expect(p!.primary_email.toLowerCase()).toBe('ivy.chen@example.com');
    const raw = Buffer.from(String((s.sends()[0]!.body as { raw: string }).raw), 'base64url').toString(
      'utf8',
    );
    expect(raw.toLowerCase()).toMatch(/^to: .*ivy\.chen@example\.com/m);
  });

  it('never goes to an address other than the one Orbit holds: it says which is which and keeps nothing', async () => {
    const s = await setup();
    const id = crypto.randomUUID();
    const r = await s.approve<Refused>({ draftId: id }, { to: 'someone.else@example.org' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('recipient_differs');
    expect(r.body.error.message).toContain('ivy@example.com');
    expect(r.body.error.message).toContain('someone.else@example.org');
    expect(r.body.error.message).not.toMatch(/[—!]/);
    expect(await t.db.sql`select 1 from orbit.drafts where id = ${id}::uuid`).toHaveLength(0);
    expect(s.sends()).toHaveLength(0);
    // the same address in other capitals is the same address
    const same = await s.approve({ draftId: id }, { to: 'IVY@example.com' });
    expect(same.status).toBe(200);
  });

  it('no address anywhere, or no subject on a new email: refused with the reason, nothing kept', async () => {
    const none = await setup({});
    const a = await none.approve<Refused>();
    expect([a.status, a.body.error.code]).toEqual([409, 'no_email']);
    const s = await setup();
    for (const subject of [undefined, '', '   ']) {
      const r = await s.approve<Refused>({ subject });
      expect([r.status, r.body.error.code]).toEqual([409, 'needs_subject']);
      expect(r.body.error.message).toBe('Add a subject line.');
    }
    expect(await t.db.sql`select 1 from orbit.drafts where user_id = ${s.userId}::uuid`).toHaveLength(0);
    expect(await t.db.sql`select 1 from orbit.drafts where user_id = ${none.userId}::uuid`).toHaveLength(0);
    expect(s.sends()).toHaveLength(0);
  });

  it('an answer in a thread needs no subject: it goes into that thread', async () => {
    const s = await setup();
    const id = crypto.randomUUID();
    const r = await s.approve(
      { draftId: id, subject: undefined, undoSec: undefined },
      { threadId: 'gthread-77', inReplyTo: '<abc@mail.example.com>' },
    );
    expect(r.status).toBe(200);
    const [d] = await t.db.sql<{ thread_external_id: string; in_reply_to: string }>`
      select thread_external_id, in_reply_to from orbit.drafts where id = ${id}::uuid`;
    expect(d).toEqual({ thread_external_id: 'gthread-77', in_reply_to: '<abc@mail.example.com>' });
    if (r.body.draft.status === 'sent')
      expect((s.sends()[0]!.body as { threadId?: string }).threadId).toBe('gthread-77');
  });

  it('only for one of the student’s own people, with a real address, and never over another account’s draft', async () => {
    const s = await setup();
    const other = await setup();
    const theirs = await other.call<Draft>('/drafts/compose', other.token, {
      personId: other.personId,
      kind: 'first_touch',
      channel: 'gmail',
    });
    const tries: [Record<string, unknown>, Record<string, unknown>, number][] = [
      [{}, { personId: other.personId }, 404],
      [{ draftId: theirs.body.draft.id }, {}, 404],
      [{}, { to: 'not an address' }, 400],
      [{}, { to: 'a@b' }, 400],
      [{}, { kind: 'not_a_kind' }, 400],
      [{}, { channel: 'sms' }, 400],
      [{}, { threadId: 'x'.repeat(201) }, 400],
      [{ body: '   ' }, {}, 400],
    ];
    for (const [over, write, status] of tries) {
      const r = await s.approve(over, write);
      expect([JSON.stringify([over, write]).slice(0, 80), r.status]).toEqual([
        JSON.stringify([over, write]).slice(0, 80),
        status,
      ]);
    }
    expect(await t.db.sql`select 1 from orbit.drafts where user_id = ${s.userId}::uuid`).toHaveLength(0);
    expect(s.sends()).toHaveLength(0);
    const [d] = await t.db.sql<{ user_id: string; status: string }>`
      select user_id, status from orbit.drafts where id = ${theirs.body.draft.id}::uuid`;
    expect(d).toEqual({ user_id: other.userId, status: 'draft' });
  });

  it('someone who asked not to be contacted is not written to', async () => {
    const s = await setup();
    await t.db.sql`update orbit.people set do_not_contact = true where id = ${s.personId}::uuid`;
    const id = crypto.randomUUID();
    const r = await s.approve<Draft & Partial<Refused>>({ draftId: id, undoSec: undefined });
    expect(r.body.draft?.status ?? r.body.error?.code).not.toBe('sent');
    expect(s.sends()).toHaveLength(0);
  });
});
