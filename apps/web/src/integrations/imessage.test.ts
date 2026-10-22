import type { User } from '@orbit/core';
import initSqlJs from 'sql.js';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { createLocalUser } from '../engine/account';
import { importTexts } from '../engine/imessage';
import { appleDate, setSqlJsForTests, textFromAttributedBody } from './imessageDb';
import { normalizePhone, parseVCards } from './vcard';

const appleNs = (iso: string) => (Date.parse(iso) - Date.UTC(2001, 0, 1)) * 1e6;

/** A small Messages database: Ana texts both ways, a verification code texts one way, and a group chat. */
async function fakeChatDb(): Promise<Uint8Array> {
  const SQL = await initSqlJs();
  const d = new SQL.Database();
  d.run(`
    create table handle (ROWID integer primary key, id text);
    create table chat (ROWID integer primary key, chat_identifier text);
    create table chat_handle_join (chat_id integer, handle_id integer);
    create table chat_message_join (chat_id integer, message_id integer);
    create table message (ROWID integer primary key, date integer, is_from_me integer, text text, attributedBody blob,
      associated_message_type integer default 0, item_type integer default 0, handle_id integer);
    insert into handle values (1, '+1 (555) 123-4567'), (2, '28849'), (3, 'bo@icloud.com'), (4, 'cy@icloud.com');
    insert into chat values (1, 'ana'), (2, 'code'), (3, 'group');
    insert into chat_handle_join values (1, 1), (2, 2), (3, 3), (3, 4);
  `);
  const msg = (id: number, chat: number, iso: string, fromMe: 0 | 1, text: string | null, extra = '') => {
    d.run(
      `insert into message (ROWID, date, is_from_me, text${extra ? ', associated_message_type' : ''}) values (?, ?, ?, ?${extra ? ', 2000' : ''})`,
      [id, appleNs(iso), fromMe, text],
    );
    d.run('insert into chat_message_join values (?, ?)', [chat, id]);
  };
  msg(1, 1, '2026-10-01T15:00:00Z', 1, 'Hey Ana, coffee this week?');
  msg(2, 1, '2026-10-01T15:05:00Z', 0, 'Yes! Thursday works');
  msg(3, 1, '2026-10-01T15:06:00Z', 0, null, 'tapback'); // a tapback is not a message
  msg(4, 1, '2026-10-09T18:00:00Z', 0, 'Great seeing you');
  msg(5, 2, '2026-10-02T10:00:00Z', 0, 'Your code is 123456');
  msg(6, 3, '2026-10-03T10:00:00Z', 0, 'group hello');
  return d.export();
}

const VCF = `BEGIN:VCARD
VERSION:3.0
N:Ruiz;Ana;;;
FN:Ana Ruiz
ORG:Stripe;
TEL;type=CELL:(555) 123-4567
EMAIL;type=INTERNET:ana@stripe.com
END:VCARD
BEGIN:VCARD
FN:Mom
TEL:555 000 1111
END:VCARD`;

describe('reading texts from Messages', () => {
  beforeAll(() => setSqlJsForTests(initSqlJs()));
  let user: User;
  beforeEach(async () => {
    await wipeDatabase();
    user = await createLocalUser({ fullName: 'Sam Lee', email: 'sam@cornell.edu' });
  });

  it('dates, phone numbers, contacts and the text inside newer messages', () => {
    expect(appleDate(appleNs('2026-10-01T15:00:00Z'))?.toISOString()).toBe('2026-10-01T15:00:00.000Z');
    expect(appleDate(600_000_000)?.getUTCFullYear()).toBe(2020);
    expect(normalizePhone('(555) 123-4567')).toBe('+15551234567');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('28849')).toBeUndefined();
    const cards = parseVCards(VCF);
    expect(cards[0]).toMatchObject({
      name: 'Ana Ruiz',
      phones: ['+15551234567'],
      emails: ['ana@stripe.com'],
      org: 'Stripe',
    });
    const hello = new TextEncoder().encode('Hello there');
    const blob = new Uint8Array([
      0x04,
      0x0b,
      ...new TextEncoder().encode('streamtyped NSString'),
      0x01,
      0x94,
      0x84,
      0x01,
      0x2b,
      hello.length,
      ...hello,
      0x86,
    ]);
    expect(textFromAttributedBody(blob)).toBe('Hello there');
  });

  it('files two-way texts on named people, counts each day, and proposes "replied" after outreach', async () => {
    const r0 = await importTexts(
      user,
      { messagesDb: await fakeChatDb() },
      { now: new Date('2026-10-20T12:00:00Z') },
    );
    // without Contacts nobody can be named: nothing is guessed (a verification short code is never a person at all)
    expect(r0).toMatchObject({ people: 0, skippedUnnamed: 1, groupChats: 1 });
    const r = await importTexts(
      user,
      { messagesDb: await fakeChatDb(), contactsVcf: VCF },
      { now: new Date('2026-10-20T12:00:00Z') },
    );
    expect(r).toMatchObject({ people: 1, created: 1, conversations: 1, messages: 3 });
    const ana = (await db.people.where('userId').equals(user.id).toArray()).find(
      (p) => p.displayName === 'Ana Ruiz',
    )!;
    expect(ana.phones).toContain('+15551234567');
    expect(ana.primaryEmail).toBe('ana@stripe.com');
    const tps = await db.touchpoints.where('personId').equals(ana.id).toArray();
    expect(tps.map((t) => t.kind).sort()).toEqual(['text_in', 'text_in', 'text_out']);
    expect((await db.people.get(ana.id))!.strength).toBeGreaterThan(0.1);
    const thread = await db.textThreads.get(ana.id);
    expect(thread?.recent.map((m) => m.text)).toEqual([
      'Hey Ana, coffee this week?',
      'Yes! Thursday works',
      'Great seeing you',
    ]);
    // importing again doubles nothing
    await importTexts(
      user,
      { messagesDb: await fakeChatDb(), contactsVcf: VCF },
      { now: new Date('2026-10-20T12:00:00Z') },
    );
    expect(await db.touchpoints.where('personId').equals(ana.id).count()).toBe(3);
    expect(await db.people.where('userId').equals(user.id).count()).toBe(1);
  });

  it('a text back after the student reached out proposes moving that chat to replied', async () => {
    await importTexts(
      user,
      { messagesDb: await fakeChatDb(), contactsVcf: VCF },
      { now: new Date('2026-10-20T12:00:00Z') },
    );
    const ana = (await db.people.where('userId').equals(user.id).toArray())[0]!;
    // the chats and touches the first import made are cleared, and a chat the student wrote in on Sept 30 is set up
    await db.chats.put({
      id: 'c_ana',
      userId: user.id,
      personId: ana.id,
      stage: 'outreach_sent',
      stageEnteredAt: '2026-09-30T12:00:00Z',
      firstOutreachAt: '2026-09-30T12:00:00Z',
      source: 'manual',
      goalTags: [],
      outreachChannel: 'gmail',
      bumpCount: 0,
      priority: 2,
      createdAt: '2026-09-30T12:00:00Z',
      updatedAt: '2026-09-30T12:00:00Z',
    } as never);
    await importTexts(
      user,
      { messagesDb: await fakeChatDb(), contactsVcf: VCF },
      { now: new Date('2026-10-20T12:00:00Z') },
    );
    const events = await db.stageEvents.where('chatId').equals('c_ana').toArray();
    const chat = await db.chats.get('c_ana');
    expect(
      chat?.stage === 'replied' || events.some((e) => e.toStage === 'replied' && e.status === 'proposed'),
    ).toBe(true);
  });
});
