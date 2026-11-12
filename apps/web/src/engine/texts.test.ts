/**
 * Texts, plan 43 §6: group chats up to eight, days with only tapbacks, days in the student's own time zone, handles
 * from Contacts, the student's switch (off hides texts from closeness, on gives back the same scores, remove deletes
 * them), the owner's switch (nothing offered, nothing changes) and what a signed-in student's browser sends (never the
 * words).
 */
import type { User } from '@orbit/core';
import { readiness } from '@orbit/core';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recomputeAllStrengths } from '../db/repo';
import { db, wipeDatabase } from '../db/schema';
import { setSqlJsForTests } from '../integrations/imessageDb';
import { parseVCards } from '../integrations/vcard';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import type { FakeOrbitApi } from '../test/fakeOrbitApi';
import { createLocalUser } from './account';
import { forgetTexts, importTexts, setTextsOn, textsStatus } from './imessage';
import { textsReadiness, withTextsStep } from './notify';
import { addPersonByHand } from './people';
import { writeFromServer } from './serverSync';
import { inUseNow, loadSources, setExtraSourcesForTests, sourceState } from './sources';

const NOW = new Date('2026-10-20T12:00:00Z');
const appleNs = (iso: string) => (Date.parse(iso) - Date.UTC(2001, 0, 1)) * 1e6;

interface Msg {
  chat: number;
  at: string;
  fromMe?: boolean;
  /** the sender's handle row in a group */
  from?: number;
  text?: string | null;
  /** 2000: a tapback */
  assoc?: number;
}

/** Every word any fixture message carries, to prove none of them leaves the browser. */
const ALL_WORDS: string[] = [];

let SQL: SqlJsStatic;
function chatDb(handles: [number, string][], chats: [number, string, number[]][], msgs: Msg[]): Uint8Array {
  const d = new SQL.Database();
  d.run(`
    create table handle (ROWID integer primary key, id text);
    create table chat (ROWID integer primary key, chat_identifier text);
    create table chat_handle_join (chat_id integer, handle_id integer);
    create table chat_message_join (chat_id integer, message_id integer);
    create table message (ROWID integer primary key, date integer, is_from_me integer, text text, attributedBody blob,
      associated_message_type integer default 0, item_type integer default 0, handle_id integer);`);
  for (const [id, h] of handles) d.run('insert into handle values (?, ?)', [id, h]);
  for (const [id, ident, members] of chats) {
    d.run('insert into chat values (?, ?)', [id, ident]);
    for (const m of members) d.run('insert into chat_handle_join values (?, ?)', [id, m]);
  }
  msgs.forEach((m, i) => {
    if (m.text) ALL_WORDS.push(m.text);
    d.run(
      'insert into message (ROWID, date, is_from_me, text, associated_message_type, handle_id) values (?, ?, ?, ?, ?, ?)',
      [i + 1, appleNs(m.at), m.fromMe ? 1 : 0, m.text ?? null, m.assoc ?? 0, m.from ?? 0],
    );
    d.run('insert into chat_message_join values (?, ?)', [m.chat, i + 1]);
  });
  const out = d.export();
  d.close();
  return out;
}

const VCF = `BEGIN:VCARD
VERSION:3.0
N:Ruiz;Ana;;;
FN:Ana Ruiz
TEL;type=CELL:(555) 123-4567
item1.X-SOCIALPROFILE;type=instagram;x-user=ana.ruiz:x-apple:ana.ruiz
item2.X-SOCIALPROFILE;type=twitter:http://twitter.com/AnaRuiz
END:VCARD
BEGIN:VCARD
FN:Bo Chen
TEL:(555) 222-0002
URL:https://www.instagram.com/bo.chen_22/
NOTE:x: @bochen
END:VCARD
BEGIN:VCARD
FN:Cy Diaz
TEL:(555) 222-0003
IMPP;X-SERVICE-TYPE=Instagram:x-apple:cy.d
END:VCARD
BEGIN:VCARD
FN:Di Evans
TEL:(555) 222-0004
END:VCARD`;

/**
 * Ana texts one to one (one evening that is two days in UTC, and a day of only a tapback); Bo, Cy and Di are with the
 * student in a group of four (Cy never writes); a group of nine is too big to count.
 */
function fixture(): Uint8Array {
  const big = Array.from({ length: 8 }, (_, i) => 20 + i);
  return chatDb(
    [
      [1, '+1 (555) 123-4567'],
      [2, '+15552220002'],
      [3, '+15552220003'],
      [4, '+15552220004'],
      ...big.map((id) => [id, `+1555333${String(id).padStart(4, '0')}`] as [number, string]),
    ],
    [
      [1, 'ana', [1]],
      [2, 'chat-four', [2, 3, 4]],
      [3, 'chat-nine', big],
    ],
    [
      // 7pm and 10pm in New York on Oct 1: one local day, two days in UTC
      { chat: 1, at: '2026-10-01T23:00:00Z', fromMe: true, text: 'Hey Ana, dinner Thursday?' },
      { chat: 1, at: '2026-10-02T02:00:00Z', text: 'Yes, see you then' },
      // Oct 5: only a tapback from her
      { chat: 1, at: '2026-10-05T15:00:00Z', text: 'Loved "see you then"', assoc: 2000 },
      { chat: 2, at: '2026-10-03T15:00:00Z', fromMe: true, text: 'Study group at 6?' },
      { chat: 2, at: '2026-10-03T15:10:00Z', from: 2, text: 'In, see you there' },
      { chat: 2, at: '2026-10-03T15:20:00Z', from: 4, text: 'Same' },
      { chat: 2, at: '2026-10-03T15:30:00Z', from: 3, text: null, assoc: 2001 },
      { chat: 3, at: '2026-10-04T15:00:00Z', fromMe: true, text: 'Team dinner?' },
      { chat: 3, at: '2026-10-04T15:05:00Z', from: 20, text: 'Sure thing' },
    ],
  );
}

let user: User;
beforeAll(async () => {
  SQL = await initSqlJs();
  setSqlJsForTests(Promise.resolve(SQL));
});

async function person(name: string) {
  return (await db.people.where('userId').equals(user.id).toArray()).find((p) => p.displayName === name);
}
async function scores() {
  const people = await db.people.where('userId').equals(user.id).toArray();
  return Object.fromEntries(people.map((p) => [p.displayName, p.strength]));
}

describe('texts in local mode (plan 43 §6)', () => {
  beforeAll(() => setExtraSourcesForTests('imessage'));
  afterAll(() => setExtraSourcesForTests(undefined));
  beforeEach(async () => {
    await wipeDatabase();
    user = await createLocalUser({ fullName: 'Sam Lee', email: 'sam@cornell.edu' });
    await db.users.update(user.id, { timezone: 'America/New_York' });
    user = (await db.users.get(user.id))!;
  });

  it('reads groups up to eight, keeps the chat size, and needs both the member and the student to have written', async () => {
    const r = await importTexts(user, { messagesDb: fixture(), contactsVcf: VCF }, { now: NOW });
    expect(r.groupChats).toBe(2);
    // the group of four is read; the group of nine is not
    expect(r.groupsRead).toBe(1);
    // Ana one to one, and the group of four
    expect(r.conversations).toBe(2);
    expect(r.people).toBe(3);
    const bo = (await person('Bo Chen'))!;
    const di = (await person('Di Evans'))!;
    // Cy only reacted: never wrote, so never filed
    expect(await person('Cy Diaz')).toBeUndefined();
    for (const p of [bo, di]) {
      const tps = await db.touchpoints.where('personId').equals(p.id).toArray();
      expect(tps.map((t) => [t.kind, t.group]).sort()).toEqual([
        ['text_in', 4],
        ['text_out', 4],
      ]);
    }
    const ana = (await person('Ana Ruiz'))!;
    const anaTps = await db.touchpoints.where('personId').equals(ana.id).toArray();
    expect(anaTps.every((t) => t.group === 2)).toBe(true);
    // a group weighs half: Ana, texted one to one, is closer than Bo
    expect(ana.strength).toBeGreaterThan(bo.strength);
    expect(bo.strength).toBeGreaterThan(0);
    // a group's words are never kept on a person's page
    expect((await db.textThreads.get(bo.id))?.recent).toEqual([]);
    expect((await db.textThreads.get(bo.id))?.groups).toBe(1);
  });

  it('counts a day in the student own time zone, and a day of only tapbacks is light', async () => {
    await importTexts(user, { messagesDb: fixture(), contactsVcf: VCF }, { now: NOW });
    const ana = (await person('Ana Ruiz'))!;
    const tps = (await db.touchpoints.where('personId').equals(ana.id).toArray()).sort((a, b) =>
      a.refId.localeCompare(b.refId),
    );
    // Oct 1 evening in New York holds both texts (in UTC they would be Oct 1 and Oct 2)
    expect(tps.map((t) => [t.refId.split(':').slice(1).join(':'), t.words])).toEqual([
      ['2026-10-01:in', undefined],
      ['2026-10-01:out', undefined],
      ['2026-10-05:in', false],
    ]);
    // the same file read for a student in UTC splits the evening
    await wipeDatabase();
    user = await createLocalUser({ fullName: 'Sam Lee', email: 'sam@cornell.edu' });
    await db.users.update(user.id, { timezone: 'UTC' });
    user = (await db.users.get(user.id))!;
    await importTexts(user, { messagesDb: fixture(), contactsVcf: VCF }, { now: NOW });
    const ana2 = (await person('Ana Ruiz'))!;
    const days = (await db.touchpoints.where('personId').equals(ana2.id).toArray())
      .map((t) => t.refId)
      .sort();
    expect(days.map((d) => d.split(':')[1])).toEqual(['2026-10-01', '2026-10-02', '2026-10-05']);
  });

  it('keeps Instagram and X handles from Contacts on the person', async () => {
    const cards = parseVCards(VCF);
    expect(cards.find((c) => c.name === 'Ana Ruiz')!.handles).toEqual({
      instagram: ['ana.ruiz'],
      x: ['anaruiz'],
    });
    expect(cards.find((c) => c.name === 'Bo Chen')!.handles).toEqual({
      instagram: ['bo.chen_22'],
      x: ['bochen'],
    });
    expect(cards.find((c) => c.name === 'Cy Diaz')!.handles).toEqual({ instagram: ['cy.d'], x: [] });
    const r = await importTexts(user, { messagesDb: fixture(), contactsVcf: VCF }, { now: NOW });
    expect((await person('Ana Ruiz'))!.contactHandles).toEqual({ instagram: ['ana.ruiz'], x: ['anaruiz'] });
    expect((await person('Bo Chen'))!.contactHandles).toEqual({ instagram: ['bo.chen_22'], x: ['bochen'] });
    expect((await person('Di Evans'))!.contactHandles).toBeUndefined();
    expect(r.handles).toBe(2);
  });

  it('off leaves texts out of closeness without deleting them; on gives back the same scores', async () => {
    // someone with email history, so texts change their score rather than make them
    const hand = await addPersonByHand(user.id, { name: 'Ana Ruiz', email: 'ana@stripe.com' });
    await db.people.update(hand!.person.id, { phones: ['+15551234567'] });
    await recomputeAllStrengths(user.id, NOW);
    const before = await scores();
    await importTexts(user, { messagesDb: fixture(), contactsVcf: VCF }, { now: NOW });
    await recomputeAllStrengths(user.id, NOW);
    const on = await scores();
    expect(on['Ana Ruiz']).toBeGreaterThan(before['Ana Ruiz']!);
    const touches = await db.touchpoints.count();
    await setTextsOn(user, false, NOW);
    expect(await sourceState('imessage', user.id)).toBe('off');
    expect([...(await inUseNow(user.id))]).toEqual([]);
    const off = await scores();
    expect(off['Ana Ruiz']).toBe(before['Ana Ruiz']);
    // people only texts know are no one's tie while it is off
    expect(off['Bo Chen']).toBe(0);
    // nothing deleted
    expect(await db.touchpoints.count()).toBe(touches);
    expect((await textsStatus(user)).imported).toBe(true);
    await setTextsOn(user, true, NOW);
    expect(await scores()).toEqual(on);
  });

  it('remove deletes what texts brought, and people only texts knew', async () => {
    const hand = await addPersonByHand(user.id, { name: 'Ana Ruiz', email: 'ana@stripe.com' });
    await db.people.update(hand!.person.id, { phones: ['+15551234567'] });
    await importTexts(user, { messagesDb: fixture(), contactsVcf: VCF }, { now: NOW });
    expect(await person('Bo Chen')).toBeDefined();
    await forgetTexts(user, NOW);
    expect(await sourceState('imessage', user.id)).toBe('removed');
    expect(await db.touchpoints.filter((t) => t.refTable === 'texts').count()).toBe(0);
    expect(await db.textThreads.count()).toBe(0);
    expect(await person('Bo Chen')).toBeUndefined();
    const ana = (await person('Ana Ruiz'))!;
    expect(ana).toBeDefined();
    expect(ana.contactHandles).toBeUndefined();
    expect(await textsStatus(user)).toMatchObject({ state: 'removed', imported: false, people: 0 });
  });
});

describe('texts while the owner offers nothing', () => {
  beforeEach(async () => {
    setExtraSourcesForTests('');
    await wipeDatabase();
    user = await createLocalUser({ fullName: 'Sam Lee', email: 'sam@cornell.edu' });
  });
  afterAll(() => setExtraSourcesForTests(undefined));

  it('changes no one: texts are kept but count for nothing', async () => {
    const hand = await addPersonByHand(user.id, { name: 'Ana Ruiz', email: 'ana@stripe.com' });
    await db.people.update(hand!.person.id, { phones: ['+15551234567'] });
    await recomputeAllStrengths(user.id, NOW);
    const before = await scores();
    await importTexts(user, { messagesDb: fixture(), contactsVcf: VCF }, { now: NOW });
    await recomputeAllStrengths(user.id, NOW);
    const after = await scores();
    expect(after['Ana Ruiz']).toBe(before['Ana Ruiz']);
    expect(after['Bo Chen']).toBe(0);
  });
});

describe('texts for a signed-in student (decision 1)', () => {
  let api: FakeOrbitApi;
  beforeEach(async () => {
    await wipeDatabase();
    ({ api, user } = await signInToFakeApi());
    api.state.sources.offered = ['imessage'];
  });
  afterEach(() => leaveFakeApi());

  it('sends per person and day how many texts each way, names only text-only friends, and never a word', async () => {
    // someone the server already knows (a uuid id, as pulled)
    const known = '0c0ffee0-0000-4000-8000-000000000001';
    await db.people.put({
      id: known,
      userId: user.id,
      displayName: 'Ana Ruiz',
      firstName: 'Ana',
      lastName: 'Ruiz',
      nameNormalized: 'ana ruiz',
      emails: [],
      phones: ['+15551234567'],
      relationshipType: 'unknown',
      strength: 0,
      interactionCount: 0,
      sources: ['gmail'],
      isHuman: true,
      tags: [],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const r = await importTexts(user, { messagesDb: fixture(), contactsVcf: VCF }, { now: NOW });
    expect(r.uploaded).toBe(true);
    // the switch went on at the server first
    expect(api.calls.find((c) => c.route === '/sources/imessage')?.body).toEqual({ state: 'on' });
    expect(api.state.sources.states.imessage).toBe('on');
    expect(api.state.textDays).toHaveLength(1);
    const body = api.state.textDays[0]!;
    // Ana by her server id; Bo and Di, whom only texts know, by reference with their names and numbers
    const anaDays = body.days.filter((d) => d.personId === known);
    expect(anaDays.map((d) => [d.day, d.in, d.out, d.group, d.words])).toEqual([
      ['2026-10-01', 1, 1, 2, true],
      ['2026-10-05', 1, 0, 2, false],
    ]);
    expect(body.people.map((p) => p.name).sort()).toEqual(['Bo Chen', 'Di Evans']);
    expect(body.people.find((p) => p.name === 'Bo Chen')!.phones).toEqual(['+15552220002']);
    const bo = body.people.find((p) => p.name === 'Bo Chen')!;
    expect(body.days.filter((d) => d.ref === bo.ref).map((d) => [d.day, d.in, d.out, d.group])).toEqual([
      ['2026-10-03', 1, 1, 4],
    ]);
    // every field of every request: no word of any message, ever
    const sent = JSON.stringify(api.calls.map((c) => c.body));
    for (const w of ALL_WORDS) expect(sent).not.toContain(w);
    for (const d of body.days)
      expect(Object.keys(d).sort()).toEqual(
        [...(d.personId ? ['personId'] : ['ref']), 'day', 'group', 'in', 'out', 'words'].sort(),
      );
    for (const p of body.people) expect(Object.keys(p).sort()).toEqual(['name', 'phones', 'ref']);
  });

  it('a second device gets the counts and days from the server, never the words', async () => {
    api.state.sources.states.imessage = 'on';
    expect([...(await loadSources(user.id)).inUse]).toEqual(['imessage']);
    const pid = '0c0ffee0-0000-4000-8000-000000000002';
    await writeFromServer(
      'text_days',
      [
        { personId: pid, day: '2026-10-01', inCount: 3, outCount: 2, groupSize: 2, words: true },
        {
          personId: pid,
          day: '2026-10-04T00:00:00.000Z',
          inCount: 1,
          outCount: 0,
          groupSize: 4,
          words: false,
        },
      ],
      user.id,
    );
    const rows = await db.textDays.where('personId').equals(pid).sortBy('day');
    expect(rows.map((r) => [r.id, r.day, r.inCount, r.outCount, r.groupSize, r.words])).toEqual([
      [`${pid}:2026-10-01`, '2026-10-01', 3, 2, 2, true],
      [`${pid}:2026-10-04`, '2026-10-04', 1, 0, 4, false],
    ]);
    // nothing of a message's words is in what came down
    expect(await db.textThreads.count()).toBe(0);
    await writeFromServer('text_days', [], user.id, [`${pid}:2026-10-01`]);
    expect(await db.textDays.count()).toBe(1);
  });

  it('readiness gains a Texts step that never holds up "ready"', async () => {
    await importTexts(user, { messagesDb: fixture(), contactsVcf: VCF }, { now: NOW });
    const texts = await textsReadiness(user.id);
    expect(texts).toMatchObject({ state: 'on', people: 3 });
    const ready = readiness({ google: { status: 'active', phase: 'complete' }, pending: 0 });
    const withTexts = withTextsStep(ready, texts);
    expect(withTexts.state).toBe('ready');
    expect(withTexts.steps.at(-1)).toMatchObject({ key: 'texts', state: 'done', detail: '3 people' });
    await setTextsOn(user, false, NOW);
    expect(await textsReadiness(user.id)).toBeUndefined();
  });

  it('off and remove go to the server', async () => {
    await importTexts(user, { messagesDb: fixture(), contactsVcf: VCF }, { now: NOW });
    await setTextsOn(user, false, NOW);
    expect(api.state.sources.states.imessage).toBe('off');
    await forgetTexts(user, NOW);
    expect(api.state.sources.states.imessage).toBe('removed');
    expect(api.calls.filter((c) => c.route === '/sources/imessage').map((c) => c.body.state)).toEqual([
      'on',
      'off',
      'removed',
    ]);
  });
});
