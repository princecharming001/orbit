import type { User } from '@orbit/core';
import { newId } from '@orbit/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import type { GmailMessageRaw } from '../integrations/google';
import { createLocalUser } from './account';
import { MAX_FETCH_ATTEMPTS, messageSentAt, syncGoogle } from './sync';

const gmail = vi.hoisted(() => ({
  list: new Map<string, string[]>(),
  failing: new Set<string>(),
  messages: new Map<string, GmailMessageRaw>(),
}));

vi.mock('../integrations/google', async (orig) => ({
  ...(await orig<typeof import('../integrations/google')>()),
  currentGoogleToken: () => ({ accessToken: 't', expiresAt: Date.now() + 3_600_000 }),
  gmailListIds: async (q: string) => gmail.list.get(q.startsWith('in:sent') ? 'sent' : 'inbox') ?? [],
  gmailGet: async (id: string) => {
    if (gmail.failing.has(id)) throw new Error('Google API 500');
    const m = gmail.messages.get(id);
    if (!m) throw new Error('Google API 404');
    return m;
  },
  gcalList: async () => [],
}));

const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function msg(
  id: string,
  from: string,
  to: string,
  body: string,
  opts: { date?: string; internal?: boolean } = {},
) {
  const m: GmailMessageRaw = {
    id,
    threadId: `t-${id}`,
    internalDate: opts.internal === false ? undefined : String(Date.now() - 86_400_000),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: to },
        { name: 'Subject', value: `Coffee chat ${id}` },
        ...(opts.date ? [{ name: 'Date', value: opts.date }] : []),
      ],
      body: { data: b64(body) },
    },
  };
  gmail.messages.set(id, m);
  return m;
}

let user: User;
beforeEach(async () => {
  await wipeDatabase();
  gmail.list.clear();
  gmail.failing.clear();
  gmail.messages.clear();
  user = await createLocalUser({
    email: 'sam@cornell.edu',
    firstName: 'Sam',
    fullName: 'Sam Lee',
    school: 'Cornell',
  });
  await db.integrations.put({
    id: newId('int'),
    userId: user.id,
    provider: 'google',
    status: 'active',
    scopes: [],
    syncState: {},
    connectedAt: new Date().toISOString(),
  });
});

const account = async () => (await db.integrations.where('userId').equals(user.id).first())!;
const syncNotes = async () =>
  (await db.notifications.where('userId').equals(user.id).toArray())
    .filter((n) => n.title === 'Google sync finished')
    .map((n) => n.body ?? '');
const stored = async (id: string) => !!(await db.messages.where('externalMessageId').equals(id).first());

describe('google sync checkpoint', () => {
  it('keeps a message whose download failed and stores it on the next sync', async () => {
    msg('ok1', 'Ana Ruiz <ana@acme.com>', 'sam@cornell.edu', 'Happy to chat Thursday.');
    msg('bad1', 'Bo Kim <bo@acme.com>', 'sam@cornell.edu', 'Sure, send me some times.');
    gmail.list.set('inbox', ['ok1', 'bad1']);
    gmail.failing.add('bad1');

    const first = await syncGoogle(user, { useLlm: false });
    expect(first).toMatchObject({ messages: 1, failed: 1 });
    expect(await stored('ok1')).toBe(true);
    expect(await stored('bad1')).toBe(false);
    expect((await account()).syncState).toMatchObject({ failedIds: { bad1: 1 } });
    expect(await syncNotes()).toEqual([
      expect.stringMatching(
        /1 message could not be downloaded from Gmail and will be retried on the next sync/,
      ),
    ]);

    // next run: the incremental window no longer lists bad1, but it is retried from failedIds
    gmail.list.set('inbox', []);
    gmail.failing.clear();
    const second = await syncGoogle(user, { useLlm: false });
    expect(second).toMatchObject({ messages: 1, failed: 0 });
    expect(await stored('bad1')).toBe(true);
    expect((await account()).syncState).not.toHaveProperty('failedIds');
  });

  it(`gives up on a message after ${MAX_FETCH_ATTEMPTS} failed attempts and says so`, async () => {
    gmail.list.set('inbox', ['gone']);
    gmail.failing.add('gone');
    for (let i = 1; i < MAX_FETCH_ATTEMPTS; i++) {
      await syncGoogle(user, { useLlm: false });
      expect((await account()).syncState).toMatchObject({ failedIds: { gone: i } });
    }
    const last = await syncGoogle(user, { useLlm: false });
    expect(last).toMatchObject({ failed: 0, skipped: 1 });
    expect((await account()).syncState).not.toHaveProperty('failedIds');
    const notes = await syncNotes();
    expect(
      notes.filter((b) => b.includes(`failed ${MAX_FETCH_ATTEMPTS} times and was skipped`)),
    ).toHaveLength(1);
  });

  it('does not abort the sync on an unparsable Date header without internalDate', async () => {
    msg('nodate', 'Ana Ruiz <ana@acme.com>', 'sam@cornell.edu', 'Hi Sam', {
      internal: false,
      date: 'not a date',
    });
    gmail.list.set('inbox', ['nodate']);
    await expect(syncGoogle(user, { useLlm: false })).resolves.toMatchObject({ messages: 1 });
    expect(await stored('nodate')).toBe(true);
  });

  it('resolves message time from internalDate, then the Date header, then now', () => {
    const now = new Date('2026-10-06T12:00:00Z');
    expect(messageSentAt('1767225600000', 'garbage', now)).toBe('2026-01-01T00:00:00.000Z');
    expect(messageSentAt(undefined, 'Tue, 6 Oct 2026 09:00:00 -0400', now)).toBe('2026-10-06T13:00:00.000Z');
    expect(messageSentAt(undefined, 'garbage', now)).toBe(now.toISOString());
    expect(messageSentAt(undefined, undefined, now)).toBe(now.toISOString());
  });
});
