import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addPerson, api, fakeNet, jsonRes, signedInUser } from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

/**
 * Finding friends (plan 37 follow-up): people on Orbit the student may know, ranked by their ties and never without
 * one; their LinkedIn connections worth inviting (by email, or a LinkedIn message when Orbit has no address), never
 * anyone on Orbit already, a recruiter, an address-book entry or a handle; a search by
 * name among people with a tie, and by exact address among everyone; a request by id; one standing link for a group
 * chat that more than one friend can use, and a reset that ends it. No address crosses.
 */

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

type Suggestion = {
  userId: string;
  name: string;
  reason: string;
  state: string;
  connections: number;
  friendshipId?: string;
};
type Invitee = { personId: string; name: string; reason: string; via: string };

async function world() {
  const call = api(t, fakeNet(), { env: {} });
  const maya = await signedInUser(t, { firstName: 'Maya' });
  const ana = await signedInUser(t, { firstName: 'Ana' });
  const ben = await signedInUser(t, { firstName: 'Ben' });
  const cara = await signedInUser(t, { firstName: 'Cara' });
  const dina = await signedInUser(t, { firstName: 'Dina' });
  const frank = await signedInUser(t, { firstName: 'Frank' });
  // nobody shares a school but Ana, so school alone ties no one else
  for (const u of [ben, cara, dina, frank])
    await t.db
      .sql`update orbit.users set school = ${`School of ${u.userId.slice(0, 6)}`} where id = ${u.userId}::uuid`;
  await t.db
    .sql`update orbit.users set school = 'Stanford' where id = any(${[maya.userId, ana.userId]}::uuid[])`;
  await t.db.sql`update orbit.users set school = 'Elsewhere' where id = ${frank.userId}::uuid`;
  // Ana is in Maya's contacts and close; Ben has Maya in his; Dina is Maya's friend, and Cara is Dina's
  await addPerson(t, maya.userId, { name: 'Ana Rivera', email: ana.email, score: 75 });
  await addPerson(t, ben.userId, { name: 'Maya Rivera', email: maya.email, score: 30 });
  for (const [a, b] of [
    [maya, dina],
    [cara, dina],
  ] as const) {
    const [lo, hi] = a.userId < b.userId ? [a.userId, b.userId] : [b.userId, a.userId];
    await t.db.sql`insert into orbit.friendships (a, b, status, requested_by, accepted_at)
                   values (${lo}::uuid, ${hi}::uuid, 'active', ${a.userId}::uuid, now())`;
  }
  // Maya's LinkedIn connections not on Orbit: Gail she knows well, Hal a recruiter, Ivy barely, Jo an alum she
  // barely knows, Nia with no address; and two that are not LinkedIn people: an address-book entry, and a handle
  const gail = await addPerson(t, maya.userId, {
    name: 'Gail Park',
    email: 'gail@example.org',
    memberId: 'ACoGail',
    score: 82,
  });
  await addPerson(t, maya.userId, {
    name: 'Hal Recruiter',
    email: 'hal@example.org',
    memberId: 'ACoHal',
    score: 90,
  });
  await t.db
    .sql`update orbit.people set relationship_type = 'recruiter' where display_name = 'Hal Recruiter'`;
  await addPerson(t, maya.userId, {
    name: 'Ivy Faint',
    email: 'ivy@example.org',
    memberId: 'ACoIvy',
    score: 5,
  });
  const jo = await addPerson(t, maya.userId, {
    name: 'Jo Alum',
    email: 'jo@example.org',
    memberId: 'ACoJo',
    score: 10,
  });
  await t.db.sql`update orbit.people set is_alumni = true where id = ${jo}::uuid`;
  const nia = await addPerson(t, maya.userId, { name: 'Nia Noaddress', memberId: 'ACoNia', score: 95 });
  await addPerson(t, maya.userId, { name: 'Book Only', email: 'book@example.org', score: 85 });
  await addPerson(t, maya.userId, {
    name: 'jeff',
    email: 'jeff@example.org',
    memberId: 'ACoJeff',
    score: 88,
  });
  return { call, maya, ana, ben, cara, dina, frank, gail, jo, nia };
}

describe('finding friends over orbit-api', () => {
  it('suggests people on Orbit with a tie, strongest first, with the reason and no address', async () => {
    const w = await world();
    const r = await w.call<{ onOrbit: Suggestion[]; toInvite: Invitee[] }>(
      '/friends/suggest',
      w.maya.token,
      {},
    );
    expect(r.status).toBe(200);
    const names = r.body.onOrbit.map((s) => s.name);
    // Ana: in her contacts, close, and the same school; Ben has her; Cara is a friend of a friend
    expect(names[0]).toBe('Ana Rivera');
    expect(names).toEqual(expect.arrayContaining(['Ben Rivera', 'Cara Rivera']));
    // a friend already, and someone with no tie at all, never
    expect(names).not.toContain('Dina Rivera');
    expect(names).not.toContain('Frank Rivera');
    const by = (n: string) => r.body.onOrbit.find((s) => s.name === n)!;
    expect(by('Ana Rivera').reason).toBe('You know them well');
    expect(by('Ben Rivera').reason).toBe('Has you in their network');
    expect(by('Cara Rivera').reason).toBe('1 mutual friend');
    expect(by('Ben Rivera').connections).toBe(1);
    expect(JSON.stringify(r.body)).not.toMatch(/@example\.(com|org)/);
  });

  it('suggests LinkedIn connections to invite, closest first: never a recruiter, an address book entry or a handle', async () => {
    const w = await world();
    const r = await w.call<{ toInvite: Invitee[] }>('/friends/suggest', w.maya.token, {});
    const names = r.body.toInvite.map((s) => s.name);
    expect(names[0]).toBe('Gail Park');
    expect(names).toContain('Jo Alum');
    expect(names).toContain('Ivy Faint');
    // Nia has no address and Maya has no LinkedIn linked: nothing could reach her
    for (const n of ['Hal Recruiter', 'Nia Noaddress', 'Ana Rivera', 'Book Only', 'jeff'])
      expect(names).not.toContain(n);
    expect(r.body.toInvite.every((s) => s.via === 'email')).toBe(true);
    expect(r.body.toInvite[0]!.reason).toBe('You know them well');
    expect(r.body.toInvite.find((s) => s.name === 'Jo Alum')!.reason).toBe('Stanford alum');
    // inviting by id sends to the address Orbit has; Gail is no longer suggested once invited
    const inv = await w.call<{ status: string }>('/friends/invite', w.maya.token, { personId: w.gail });
    expect(inv.status).toBe(200);
    const [row] = await t.db.sql<{ to_email: string }>`
      select to_email from orbit.friend_invites where from_user_id = ${w.maya.userId}::uuid and to_email is not null`;
    expect(row!.to_email).toBe('gail@example.org');
    const again = await w.call<{ toInvite: Invitee[] }>('/friends/suggest', w.maya.token, {});
    expect(again.body.toInvite.map((s) => s.name)).not.toContain('Gail Park');
    // someone else's person cannot be invited by id
    const other = await w.call('/friends/invite', w.ana.token, { personId: w.gail });
    expect(other.status).toBe(404);
  });

  it('someone with no address is invited on LinkedIn from the student’s account, once', async () => {
    const w = await world();
    await t.db.sql`insert into orbit.integration_accounts (user_id, provider, external_account_id, status)
      values (${w.maya.userId}::uuid, 'linkedin', 'acc-maya', 'active')`;
    const r = await w.call<{ toInvite: Invitee[] }>('/friends/suggest', w.maya.token, {});
    const nia = r.body.toInvite.find((s) => s.name === 'Nia Noaddress');
    expect(nia).toMatchObject({ via: 'linkedin' });
    expect(r.body.toInvite.find((s) => s.name === 'Gail Park')!.via).toBe('email');
    const net = fakeNet((c) =>
      c.url.endsWith('/api/v1/chats') && c.method === 'POST'
        ? jsonRes(201, { chat_id: 'chat-nia', message_id: 'msg-1' })
        : undefined,
    );
    const call = api(t, net, {
      env: { unipileKey: 'unipile-placeholder', unipileBase: 'https://unipile.test' },
    });
    const inv = await call<{ status: string; link: string }>('/friends/invite', w.maya.token, {
      personId: w.nia,
    });
    expect(inv.status).toBe(200);
    expect(inv.body.status).toBe('linkedin');
    const sent = net.calls.find((c) => c.url.endsWith('/api/v1/chats'))!;
    expect(sent.body).toMatchObject({ account_id: 'acc-maya', attendees_ids: 'ACoNia' });
    expect(String((sent.body as { text: string }).text)).toContain(inv.body.link);
    expect(String((sent.body as { text: string }).text)).toMatch(/^Hi Nia, /);
    expect(String((sent.body as { text: string }).text)).not.toMatch(/[!—–]/);
    const again = await w.call<{ toInvite: Invitee[] }>('/friends/suggest', w.maya.token, {});
    expect(again.body.toInvite.map((s) => s.name)).not.toContain('Nia Noaddress');
  });

  it('a LinkedIn invite LinkedIn did not send is not left waiting, and says so', async () => {
    const w = await world();
    await t.db.sql`insert into orbit.integration_accounts (user_id, provider, external_account_id, status)
      values (${w.maya.userId}::uuid, 'linkedin', 'acc-maya2', 'active')`;
    const call = api(
      t,
      fakeNet((c) => (c.url.endsWith('/api/v1/chats') ? jsonRes(422, {}) : undefined)),
      {
        env: { unipileKey: 'unipile-placeholder', unipileBase: 'https://unipile.test' },
      },
    );
    const inv = await call('/friends/invite', w.maya.token, { personId: w.nia });
    expect(inv.status).toBe(502);
    const rows = await t.db.sql<{ status: string }>`
      select status from orbit.friend_invites where from_user_id = ${w.maya.userId}::uuid and to_person_id = ${w.nia}::uuid`;
    expect(rows.map((x) => x.status)).toEqual(['revoked']);
    const r = await w.call<{ toInvite: Invitee[] }>('/friends/suggest', w.maya.token, {});
    expect(r.body.toInvite.map((s) => s.name)).toContain('Nia Noaddress');
  });

  it('search: by name among people with a tie, by exact address among everyone', async () => {
    const w = await world();
    const byName = await w.call<{ results: Suggestion[] }>('/friends/search', w.maya.token, { q: 'ana' });
    // this Ana first (in her contacts); other Anas at her school follow, a school being a tie too
    expect(byName.body.results[0]!.userId).toBe(w.ana.userId);
    expect(byName.body.results.every((s) => s.name === 'Ana Rivera')).toBe(true);
    const noTie = await w.call<{ results: Suggestion[] }>('/friends/search', w.maya.token, { q: 'Frank' });
    expect(noTie.body.results).toEqual([]);
    const frankEmail = (
      await t.db.sql<{ email: string }>`select email from orbit.users where id = ${w.frank.userId}::uuid`
    )[0]!.email;
    const exact = await w.call<{ results: Suggestion[] }>('/friends/search', w.maya.token, {
      q: frankEmail.toUpperCase(),
    });
    expect(exact.body.results.map((s) => s.userId)).toEqual([w.frank.userId]);
    expect((await w.call('/friends/search', w.maya.token, { q: 'a' })).status).toBe(400);
    // a % or _ is a letter, not a wildcard
    const wild = await w.call<{ results: Suggestion[] }>('/friends/search', w.maya.token, { q: '%%' });
    expect(wild.body.results).toEqual([]);
  });

  it('request by id: pending for them as incoming, requested for the student, and never twice to a friend', async () => {
    const w = await world();
    const r = await w.call<{ friendshipId: string; name: string }>('/friends/request', w.maya.token, {
      userId: w.ana.userId,
    });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Ana Rivera');
    const mine = await w.call<{ onOrbit: Suggestion[] }>('/friends/suggest', w.maya.token, {});
    expect(mine.body.onOrbit.find((s) => s.name === 'Ana Rivera')!.state).toBe('requested');
    // for Ana, Maya is a request to answer, not a suggestion
    const anas = await w.call<{ onOrbit: Suggestion[] }>('/friends/suggest', w.ana.token, {});
    expect(anas.body.onOrbit.map((s) => s.userId)).not.toContain(w.maya.userId);
    const theirs = await w.call<{ results: Suggestion[] }>('/friends/search', w.ana.token, { q: 'Maya' });
    const maya = theirs.body.results.find((s) => s.name === 'Maya Rivera')!;
    expect(maya.state).toBe('incoming');
    expect(maya.friendshipId).toBe(r.body.friendshipId);
    expect((await w.call('/friends/request', w.maya.token, { userId: w.dina.userId })).status).toBe(409);
    expect((await w.call('/friends/request', w.maya.token, { userId: w.maya.userId })).status).toBe(400);
  });

  it('the standing link: the same link each time, open to more than one friend, and reset ends it', async () => {
    const w = await world();
    const a = await w.call<{ code: string; link: string }>('/friends/link', w.maya.token, {});
    const b = await w.call<{ code: string }>('/friends/link', w.maya.token, {});
    expect(a.status).toBe(200);
    expect(b.body.code).toBe(a.body.code);
    expect(a.body.link).toMatch(/\/friends\/join\//);
    for (const who of [w.ben, w.frank]) {
      const acc = await w.call('/friends/accept', who.token, { code: a.body.code, mode: 'all' });
      expect(acc.status).toBe(200);
    }
    const reset = await w.call<{ code: string }>('/friends/link', w.maya.token, { reset: true });
    expect(reset.body.code).not.toBe(a.body.code);
    const late = await w.call('/friends/accept', w.cara.token, { code: a.body.code, mode: 'all' });
    expect(late.status).toBe(404);
  });
});
