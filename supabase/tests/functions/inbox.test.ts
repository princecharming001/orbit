import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GmailApi, GmailMessage } from '../../functions/_shared/gmail.ts';
import { NeedsReauth } from '../../functions/_shared/google.ts';
import { gmailQuery, inboxOptions, listInbox } from '../../functions/_shared/inbox/inbox.ts';
import { addPerson, addThread, api, DAY, fakeNet, iso, signedInUser } from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

const now = new Date();

function mail(
  id: string,
  threadId: string,
  from: string,
  msAgo: number,
  o: { subject?: string; snippet?: string; labels?: string[]; headers?: Record<string, string> } = {},
): GmailMessage {
  return {
    id,
    threadId,
    labelIds: o.labels ?? ['INBOX'],
    snippet: o.snippet ?? `Hello from ${from}`,
    internalDate: String(now.getTime() - msAgo),
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: o.subject ?? 'Hi' },
        ...Object.entries(o.headers ?? {}).map(([name, value]) => ({ name, value })),
      ],
    },
  };
}

function fakeGmail(msgs: GmailMessage[], fail?: Error): GmailApi & { queries: string[] } {
  const queries: string[] = [];
  const g = {
    queries,
    async list(q: string) {
      queries.push(q);
      if (fail) throw fail;
      return { messages: msgs.map((m) => ({ id: m.id, threadId: m.threadId })) };
    },
    async metadata(id: string) {
      return msgs.find((m) => m.id === id)!;
    },
  };
  return g as unknown as GmailApi & { queries: string[] };
}

describe('the whole inbox (POST /inbox/list)', () => {
  it('asks Gmail for the primary inbox in the window, unread and the words when asked', () => {
    expect(gmailQuery(inboxOptions({}))).toBe(
      'in:inbox newer_than:7d -category:promotions -category:social -category:forums',
    );
    expect(
      gmailQuery(inboxOptions({ days: 90, unreadOnly: true, query: 'from:maya', includeAutomated: true })),
    ).toBe('in:inbox newer_than:30d is:unread from:maya');
    expect(inboxOptions({ limit: 500 }).limit).toBe(50);
  });

  it('lists email and LinkedIn together, one row a conversation, with the face of a known sender', async () => {
    const { userId, email } = await signedInUser(t);
    const maya = await addPerson(t, userId, {
      name: 'Maya Chen',
      email: 'maya@example.com',
      linkedinUrl: 'https://www.linkedin.com/in/mayachen',
    });
    await t.db.sql`update orbit.people set photo_url = 'https://img.test/maya.jpg' where id = ${maya}::uuid`;
    await t.db
      .sql`insert into orbit.integration_accounts (user_id, provider, external_account_id, status, last_synced_at)
      values (${userId}::uuid, 'linkedin', 'acc-inbox', 'active', now())`;
    const tom = await addPerson(t, userId, { name: 'Tom Dee' });
    const pitch = await addPerson(t, userId, { name: 'Rob Pitch' });
    // Tom: a conversation the student started, three messages back
    await addThread(
      t,
      userId,
      tom,
      [
        { direction: 'out', at: iso(3 * DAY), body: 'Hi Tom' },
        { direction: 'in', at: iso(2 * DAY), body: 'one' },
        { direction: 'in', at: iso(DAY), body: 'two' },
        { direction: 'in', at: iso(3_600_000), body: 'Latest from Tom' },
      ],
      { provider: 'linkedin' },
    );
    // a pitch out of the blue
    await addThread(
      t,
      userId,
      pitch,
      [{ direction: 'in', at: iso(2 * 3_600_000), body: 'Need help with UX?' }],
      {
        provider: 'linkedin',
      },
    );
    const gmail = fakeGmail([
      mail('m1', 't1', 'Maya Chen <maya@example.com>', 30 * 60_000, {
        subject: 'Coffee next week',
        labels: ['INBOX', 'UNREAD'],
      }),
      mail('m0', 't1', 'Maya Chen <maya@example.com>', 5 * 3_600_000),
      mail('m2', 't2', 'Stranger <new@corp.test>', 4 * 3_600_000, { snippet: 'It&#39;s me' }),
      mail('m3', 't3', 'Deals <news@shop.test>', 60 * 60_000, {
        headers: { 'List-Unsubscribe': '<mailto:x@shop.test>' },
      }),
      mail('m4', 't4', `Sam Rivera <${email}>`, 10 * 60_000, { labels: ['INBOX', 'SENT'] }),
    ]);
    const r = await listInbox({ db: t.db, gmail, now }, userId, {});
    expect(r.email).toBe('ok');
    expect(r.linkedin).toBe('ok');
    expect(r.items.map((x) => x.fromName)).toEqual(['Maya Chen', 'Tom Dee', 'Rob Pitch', 'Stranger']);
    expect(r.items[0]).toMatchObject({
      channel: 'email',
      personId: maya,
      photoUrl: 'https://img.test/maya.jpg',
      subject: 'Coffee next week',
      count: 2,
      unread: true,
    });
    expect(r.items[0]!.href).toContain('#inbox/t1');
    expect(r.items[1]).toMatchObject({
      channel: 'linkedin',
      count: 3,
      snippet: 'Latest from Tom',
      replyToYou: true,
    });
    expect(r.items[2]).toMatchObject({ replyToYou: false });
    expect(r.items[3]!.snippet).toBe("It's me");

    const li = await listInbox({ db: t.db, gmail, now }, userId, { channel: 'linkedin' });
    expect(li.email).toBe('skipped');
    expect(li.items.every((x) => x.channel === 'linkedin')).toBe(true);
    const found = await listInbox({ db: t.db, gmail, now }, userId, { channel: 'linkedin', query: 'ux' });
    expect(found.items.map((x) => x.fromName)).toEqual(['Rob Pitch']);
  });

  it('says what it could not read: Google wants a new sign-in, LinkedIn not connected', async () => {
    const { userId } = await signedInUser(t);
    const r = await listInbox({ db: t.db, gmail: fakeGmail([], new NeedsReauth()), now }, userId, {});
    expect(r).toMatchObject({ items: [], email: 'needs_reauth', linkedin: 'not_connected' });
    const none = await listInbox({ db: t.db, now }, userId, { channel: 'email' });
    expect(none.email).toBe('not_connected');
  });

  it('answers through the API for a signed-in student', async () => {
    const call = api(t, fakeNet(), { env: {} });
    const { token } = await signedInUser(t, { scopes: ['openid'] });
    const r = await call<{ items: unknown[]; email: string; linkedin: string }>('/inbox/list', token, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ items: [], email: 'not_connected', linkedin: 'not_connected' });
  });
});
