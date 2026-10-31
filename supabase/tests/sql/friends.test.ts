import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, makeUser, type TestDb } from '../helpers/pglite.ts';

/**
 * The friends migration (plan 29 §A3, §A7): the one cross-tenant predicate, the rules on what is never projected,
 * the expiry, the nightly refresh and the account deletion, all held in the database itself.
 */

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

const FRIEND_TABLES = [
  'friend_invites',
  'friendships',
  'friend_share_settings',
  'friend_shares',
  'friend_intro_asks',
];

async function friendship(a: string, b: string, status = 'active'): Promise<string> {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const [f] = await t.db.sql<{ id: string }>`
    insert into orbit.friendships (a, b, status, requested_by, accepted_at)
    values (${lo}::uuid, ${hi}::uuid, ${status}, ${a}::uuid, case when ${status} = 'active' then now() end)
    returning id`;
  return f!.id;
}

async function share(friendshipId: string, owner: string, mode: string, domains: string[] = []) {
  await t.db.sql`
    insert into orbit.friend_share_settings (friendship_id, owner_user_id, mode, company_domains)
    values (${friendshipId}::uuid, ${owner}::uuid, ${mode}, ${domains}::text[])
    on conflict (friendship_id, owner_user_id) do update set mode = excluded.mode,
      company_domains = excluded.company_domains`;
}

async function visible(viewer: string, owner: string): Promise<boolean> {
  const [r] = await t.db.sql<{
    v: boolean;
  }>`select orbit.friend_visible(${viewer}::uuid, ${owner}::uuid) as v`;
  return r!.v;
}

async function person(
  userId: string,
  name: string,
  over: { private?: boolean; slug?: string; doNotContact?: boolean } = {},
): Promise<string> {
  const [p] = await t.db.sql<{ id: string }>`
    insert into orbit.people (user_id, display_name, name_norm, linkedin_slug, private, do_not_contact)
    values (${userId}::uuid, ${name}, ${name.toLowerCase()}, ${over.slug ?? null}, ${over.private ?? false},
            ${over.doNotContact ?? false})
    returning id`;
  return p!.id;
}

const project = (
  owner: string,
  personId: string,
  over: { slug?: string | null; email?: string | null } = {},
) =>
  t.db.sql`
    insert into orbit.friend_shares (owner_user_id, person_id, display_name, linkedin_slug, email_hash, closeness)
    values (${owner}::uuid, ${personId}::uuid, 'Someone', ${over.slug === undefined ? 'someone' : over.slug},
            ${over.email ?? null}, 1)`;

describe('the friends tables', () => {
  it('exist with row security on and no policies, people.private and tie_scores.share_score beside them', async () => {
    const tables = await t.db.sql<{ table_name: string; rls: boolean }>`
      select c.relname as table_name, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'orbit' and c.relkind = 'r'`;
    for (const name of FRIEND_TABLES) {
      const row = tables.find((r) => r.table_name === name);
      expect(row, name).toBeDefined();
      expect(row!.rls, name).toBe(true);
    }
    expect(await t.db.sql`select 1 from pg_policies where schemaname = 'orbit'`).toHaveLength(0);
    const cols = await t.db.sql<{ table_name: string; column_name: string }>`
      select table_name, column_name from information_schema.columns
       where table_schema = 'orbit' and ((table_name = 'people' and column_name = 'private')
          or (table_name = 'tie_scores' and column_name = 'share_score'))`;
    expect(cols).toHaveLength(2);
    // the share score is 0 to 100 or not computed yet
    const u = await makeUser(t.db);
    const p = await person(u, 'Scored One');
    await expect(
      t.db
        .sql`insert into orbit.tie_scores (user_id, person_id, score, share_score, band, features, contributions, model_version)
               values (${u}::uuid, ${p}::uuid, 50, 140, 'warm', '{}', '{}', 'tie-v2')`,
    ).rejects.toThrow();
  });

  it('friend_visible: true both ways once both accepted and share; none, pending or ended turns it off', async () => {
    const a = await makeUser(t.db);
    const b = await makeUser(t.db);
    const c = await makeUser(t.db);
    expect(await visible(a, b)).toBe(false);
    const f = await friendship(a, b, 'pending');
    await share(f, a, 'all');
    await share(f, b, 'all');
    // a request not yet accepted shares nothing
    expect(await visible(a, b)).toBe(false);
    await t.db.sql`update orbit.friendships set status = 'active', accepted_at = now() where id = ${f}::uuid`;
    expect(await visible(a, b)).toBe(true);
    expect(await visible(b, a)).toBe(true);
    // a stranger sees neither
    expect(await visible(c, a)).toBe(false);
    expect(await visible(c, b)).toBe(false);
    // each side's choice is its own: b stops sharing, a still shares with b
    await share(f, b, 'none');
    expect(await visible(a, b)).toBe(false);
    expect(await visible(b, a)).toBe(true);
    await share(f, b, 'companies', ['stripe.com']);
    expect(await visible(a, b)).toBe(true);
    // ending it is immediate and both ways, within the one statement
    await t.db.begin(async (tx) => {
      await tx.sql`update orbit.friendships set status = 'ended', ended_at = now(), ended_by = ${a}::uuid where id = ${f}::uuid`;
      const [r] = await tx.sql<{ v: boolean }>`select orbit.friend_visible(${a}::uuid, ${b}::uuid) as v`;
      expect(r!.v).toBe(false);
    });
    expect(await visible(b, a)).toBe(false);
  });

  it('a private, hidden or do-not-contact person, or one with nothing to join on, is never projected', async () => {
    const u = await makeUser(t.db);
    const other = await makeUser(t.db);
    const open = await person(u, 'Open Person', { slug: 'open-person' });
    const hidden = await person(u, 'Private Person', { private: true, slug: 'private-person' });
    const dnc = await person(u, 'No Contact', { doNotContact: true, slug: 'no-contact' });
    await project(u, open);
    await expect(project(u, hidden)).rejects.toThrow(/private, hidden or asked not to be contacted/);
    await expect(project(u, dnc)).rejects.toThrow(/private, hidden or asked not to be contacted/);
    // no member id, slug or email hash: no row
    await expect(project(u, open, { slug: null })).rejects.toThrow();
    // somebody else's person never lands in this owner's projection
    const theirs = await person(other, 'Their Person', { slug: 'their-person' });
    await expect(project(u, theirs)).rejects.toThrow(/not one of the owner's people/);
    // marking a shared person private removes the row in the same transaction, as does hiding them
    expect(await t.db.sql`select 1 from orbit.friend_shares where person_id = ${open}::uuid`).toHaveLength(1);
    await t.db.begin(async (tx) => {
      await tx.sql`update orbit.people set private = true where id = ${open}::uuid`;
      expect(await tx.sql`select 1 from orbit.friend_shares where person_id = ${open}::uuid`).toHaveLength(0);
    });
    const later = await person(u, 'Later Hidden', { slug: 'later-hidden' });
    await project(u, later);
    await t.db.sql`update orbit.people set hidden_at = now() where id = ${later}::uuid`;
    expect(await t.db.sql`select 1 from orbit.friend_shares where person_id = ${later}::uuid`).toHaveLength(
      0,
    );
  });

  it('asks and invites expire after 14 days; the nightly refresh queues one job per user with a friend', async () => {
    const a = await makeUser(t.db);
    const b = await makeUser(t.db);
    const alone = await makeUser(t.db);
    const f = await friendship(a, b);
    await share(f, a, 'all');
    await share(f, b, 'all');
    const target = await person(b, 'Target Person', { slug: 'target-person' });
    await t.db.sql`
      insert into orbit.friend_intro_asks (friendship_id, asker_user_id, friend_user_id, target_person_id, note, created_at)
      values (${f}::uuid, ${a}::uuid, ${b}::uuid, ${target}::uuid, 'old ask', now() - interval '15 days'),
             (${f}::uuid, ${a}::uuid, ${b}::uuid, ${target}::uuid, 'fresh ask', now() - interval '2 days')`;
    await t.db.sql`
      insert into orbit.friend_invites (from_user_id, to_email, code, expires_at)
      values (${alone}::uuid, 'late@example.com', 'codeexpired000000000000', now() - interval '1 day'),
             (${alone}::uuid, 'soon@example.com', 'codefresh00000000000000', now() + interval '13 days')`;
    const [n] = await t.db.sql<{ n: number }>`select orbit.expire_friend_asks() as n`;
    expect(n!.n).toBe(2);
    const asks = await t.db.sql<{ note: string; status: string }>`
      select note, status from orbit.friend_intro_asks where friendship_id = ${f}::uuid order by note`;
    expect(asks).toEqual([
      { note: 'fresh ask', status: 'asked' },
      { note: 'old ask', status: 'expired' },
    ]);
    const invites = await t.db.sql<{ to_email: string; status: string }>`
      select to_email, status from orbit.friend_invites where from_user_id = ${alone}::uuid order by to_email`;
    expect(invites).toEqual([
      { to_email: 'late@example.com', status: 'expired' },
      { to_email: 'soon@example.com', status: 'pending' },
    ]);
    await t.pg.exec('delete from pgmq.q_orbit_score');
    const [q] = await t.db.sql<{ n: number }>`select orbit.enqueue_friend_refresh() as n`;
    const queued = await t.db.sql<{ message: { kind: string; userId: string } }>`
      select message from pgmq.q_orbit_score`;
    const users = queued.map((m) => m.message.userId).sort();
    expect(queued.every((m) => m.message.kind === 'friend_shares_refresh')).toBe(true);
    expect(users).toEqual(expect.arrayContaining([a, b]));
    expect(users).not.toContain(alone);
    expect(q!.n).toBe(users.length);
    // the job is on the schedule
    const jobs = await t.db.sql<{
      jobname: string;
    }>`select jobname from cron.job where jobname = 'orbit-friends-nightly'`;
    expect(jobs).toHaveLength(1);
  });

  it('delete_user takes the invites, the friendship on either side, the settings, the projection and the asks', async () => {
    const a = await makeUser(t.db);
    const b = await makeUser(t.db);
    const f = await friendship(a, b);
    await share(f, a, 'all');
    await share(f, b, 'all');
    const mine = await person(a, 'Mine', { slug: 'mine' });
    const theirs = await person(b, 'Theirs', { slug: 'theirs' });
    await project(a, mine);
    await project(b, theirs);
    await t.db.sql`
      insert into orbit.friend_intro_asks (friendship_id, asker_user_id, friend_user_id, target_person_id, note)
      values (${f}::uuid, ${a}::uuid, ${b}::uuid, ${theirs}::uuid, 'please'),
             (${f}::uuid, ${b}::uuid, ${a}::uuid, ${mine}::uuid, 'and you')`;
    await t.db.sql`insert into orbit.friend_invites (from_user_id, to_email, code, expires_at)
      values (${a}::uuid, 'x@example.com', 'codeinvite0000000000000', now() + interval '14 days')`;
    await t.db.sql`select orbit.delete_user(${a}::uuid)`;
    expect(
      await t.db.sql`select 1 from orbit.friendships where a = ${a}::uuid or b = ${a}::uuid`,
    ).toHaveLength(0);
    expect(await t.db.sql`select 1 from orbit.friendships where id = ${f}::uuid`).toHaveLength(0);
    expect(
      await t.db.sql`select 1 from orbit.friend_share_settings where friendship_id = ${f}::uuid`,
    ).toHaveLength(0);
    expect(
      await t.db.sql`select 1 from orbit.friend_intro_asks where friendship_id = ${f}::uuid`,
    ).toHaveLength(0);
    expect(await t.db.sql`select 1 from orbit.friend_invites where from_user_id = ${a}::uuid`).toHaveLength(
      0,
    );
    expect(await t.db.sql`select 1 from orbit.friend_shares where owner_user_id = ${a}::uuid`).toHaveLength(
      0,
    );
    // b's own projection row stays: it is b's, and b is still here
    expect(await t.db.sql`select 1 from orbit.friend_shares where owner_user_id = ${b}::uuid`).toHaveLength(
      1,
    );
    expect(await visible(b, a)).toBe(false);
  });
});
