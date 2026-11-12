/**
 * Plan 43 §3.3, §3.4, §8.2: Instagram accounts and people. Hard proof attaches, a middle score about someone the
 * student knows becomes a question, a stranger is never asked about; attaching folds an account's own person unless
 * it has things of its own; "Not their account" undoes an attach row by row; and a person who owns an account is
 * never merged the old way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../functions/_shared/db.ts';
import { mergePeople } from '../../functions/_shared/ingest/people.ts';
import { sqlQueue } from '../../functions/_shared/queue.ts';
import { memoryTake } from '../../functions/_shared/ratelimit.ts';
import { afterInbound, storeSocialChat } from '../../functions/_shared/social/chats.ts';
import { upsertAccounts } from '../../functions/_shared/social/graph.ts';
import { attachAccount, SocialMergeRefused } from '../../functions/_shared/social/links.ts';
import { ensureAccountPerson, matchAccount } from '../../functions/_shared/social/people.ts';
import { makeApiHandler } from '../../functions/orbit-api/api.ts';
import { socialHandlers } from '../../functions/orbit-worker/handlers/social.ts';
import type { JobHandler } from '../../functions/orbit-worker/worker.ts';
import { APP, agentConfig, BASE, fakeNet, SECRET, signedInUser } from '../helpers/agents.ts';
import { FakeInstagram } from '../helpers/fakeInstagram.ts';
import { clearQueues, drain } from '../helpers/ingest.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

const now = () => new Date();
const noop: JobHandler = async () => {};

function call(method: string, path: string, token: string, body?: unknown) {
  const handler = makeApiHandler({
    env: {
      googleClientId: 'client-id-placeholder.apps.googleusercontent.com',
      googleClientSecret: 'client-secret-placeholder',
      googleRedirectUri: `${BASE}/auth/google/callback`,
      sessionSecret: SECRET,
      appUrl: APP,
    },
    db: t.db,
    fetch: fakeNet().fetch,
    take: memoryTake(),
    agent: agentConfig(fakeNet(), {}),
  });
  return handler(
    new Request(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  ).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, any> }));
}

async function person(db: Db, userId: string, name: string, o: { known?: boolean; slug?: string } = {}) {
  const [first, ...rest] = name.split(' ');
  const [p] = await db.sql<{ id: string }>`
    insert into orbit.people (user_id, display_name, first_name, last_name, name_norm, sources, linkedin_connected_on,
                              linkedin_slug, linkedin_url)
    values (${userId}::uuid, ${name}, ${first}, ${rest.join(' ')}, ${name.toLowerCase()}, ${['test']}::text[],
            ${o.known ? new Date().toISOString() : null}::timestamptz, ${o.slug ?? null},
            ${o.slug ? `https://www.linkedin.com/in/${o.slug}` : null})
    returning id`;
  return p!.id;
}

async function igStudent() {
  const s = await signedInUser(t);
  await t.db.sql`
    insert into orbit.integration_accounts (user_id, provider, external_account_id, social_account_id, status)
    values (${s.userId}::uuid, 'instagram', ${`acc-${s.userId.slice(0, 8)}`}, 'ig-me', 'active')`;
  await t.db
    .sql`insert into orbit.source_states (user_id, source, state) values (${s.userId}::uuid, 'instagram', 'on')`;
  return s;
}

const ig = (id: string, username: string, name: string, more: Record<string, unknown> = {}) => ({
  platform: 'instagram' as const,
  id,
  username,
  name,
  ...more,
});

/** One-to-one messages both ways with an account, through the personal lane. */
async function chatWith(userId: string, account: string, chatId: string, n = 2, name = 'Some One') {
  const at = (i: number) => new Date(Date.now() - (n - i) * 3_600_000).toISOString();
  return storeSocialChat(
    t.db,
    userId,
    'instagram',
    { chatId, participants: 2, others: [{ accountId: account, name }] },
    Array.from({ length: n }, (_, i) => ({
      messageId: `${chatId}-m${i}`,
      chatId,
      at: at(i),
      fromStudent: i % 2 === 1,
      senderAccountId: i % 2 === 1 ? 'ig-me' : account,
      text: `hey ${i}`,
      hasWords: true,
    })),
    { now: new Date() },
  );
}

describe('matching an account to the student’s people', () => {
  it('attaches on hard proof, asks about someone the student knows, and never asks about a stranger', async () => {
    const { userId } = await igStudent();
    const jason = await person(t.db, userId, 'Jason Chen', { known: true, slug: 'jasonchen-stripe' });
    const maya = await person(t.db, userId, 'Maya Lopez', { known: true });
    await person(t.db, userId, 'Riley Stranger');

    const proof = await matchAccount(
      t.db,
      userId,
      ig('ig-jason', 'jchen_22', 'Jason Chen', { links: ['https://www.linkedin.com/in/jasonchen-stripe'] }),
      { now: now() },
    );
    expect(proof).toMatchObject({ kind: 'attached', personId: jason });
    const [link] = await t.db.sql<{ via: string; proof: string }>`
      select via, proof from orbit.social_links where user_id = ${userId}::uuid and account_id = 'ig-jason'`;
    expect(link).toEqual({ via: 'proof', proof: 'links_back' });
    const [ident] = await t.db.sql<{ person_id: string; social_account_id: string }>`
      select person_id, social_account_id from orbit.person_identities
       where user_id = ${userId}::uuid and kind = 'instagram_id' and value_norm = 'ig-jason'`;
    expect(ident).toEqual({ person_id: jason, social_account_id: 'ig-jason' });

    const asked = await matchAccount(t.db, userId, ig('ig-maya', 'maya.lopez', 'Maya Lopez'), { now: now() });
    expect(asked).toMatchObject({ kind: 'asked', personId: maya });

    const stranger = await matchAccount(t.db, userId, ig('ig-riley', 'riley.stranger', 'Riley Stranger'), {
      now: now(),
    });
    expect(stranger.kind).toBe('none');
    const asks = await t.db.sql<{ account_id: string }>`
      select account_id from orbit.social_match_asks where user_id = ${userId}::uuid order by account_id`;
    expect(asks.map((a) => a.account_id)).toEqual(['ig-maya']);

    const brand = await matchAccount(
      t.db,
      userId,
      ig('ig-shop', 'mayashop', 'Maya Lopez Studio', { business: true }),
      {
        now: now(),
      },
    );
    expect(brand.kind).toBe('none');
  });

  it('reads the profile of a chat partner someone in People could be, and attaches on the proof it shows', async () => {
    await clearQueues(t);
    const { userId } = await igStudent();
    const lee = await person(t.db, userId, 'Lee Okafor', { known: true, slug: 'lee-okafor' });
    const fake = new FakeInstagram('ig-me');
    fake.add({
      id: 'ig-lee',
      username: 'lee.okafor',
      name: 'Lee Okafor',
      bio: 'PM. linkedin.com/in/lee-okafor',
    });
    await chatWith(userId, 'ig-lee', 'chat-lee', 1);
    await sqlQueue(t.db).enqueue({
      kind: 'social.match',
      userId,
      payload: { platform: 'instagram', accountIds: ['ig-lee'] },
      dedupeKey: `m:${userId}`,
    });
    await drain(
      t,
      {
        ...socialHandlers({
          fetch: fake.fetch,
          unipile: { apiKey: 'k', baseUrl: fake.base },
          random: () => 0.5,
        }),
        'score.person': noop,
        friend_shares_refresh: noop,
      },
      now,
      { maxTicks: 3 },
    );
    expect(fake.made('/api/v1/users/ig-lee')).toHaveLength(1);
    const [l] = await t.db.sql<{ person_id: string }>`
      select person_id from orbit.social_links where user_id = ${userId}::uuid and account_id = 'ig-lee'`;
    expect(l!.person_id).toBe(lee);
    // the message stored before the account had a person is now the person's
    const [m] = await t.db.sql<{ from_person_id: string }>`
      select from_person_id from orbit.messages where user_id = ${userId}::uuid and external_id = 'chat-lee-m0'`;
    expect(m!.from_person_id).toBe(lee);
  });
});

describe('attach', () => {
  it('folds the account’s own person into the one the student names, then deletes it', async () => {
    const { userId, token } = await igStudent();
    const sam = await person(t.db, userId, 'Sam Park', { known: true });
    const stored = await chatWith(userId, 'ig-sam', 'chat-sam', 4, 'Sam Park');
    const own = stored.partner!.personId!;
    expect(own).toBeTruthy();
    const r = await call('POST', '/social/links', token, {
      platform: 'instagram',
      accountId: 'ig-sam',
      personId: sam,
    });
    expect(r.status).toBe(200);
    const gone = await t.db.sql`select 1 from orbit.people where id = ${own}::uuid`;
    expect(gone).toHaveLength(0);
    const msgs = await t.db.sql<{
      direction: string;
      from_person_id: string | null;
      to_person_ids: string[];
    }>`
      select direction, from_person_id, to_person_ids from orbit.messages where user_id = ${userId}::uuid
         and social_account_id = 'ig-sam'`;
    expect(msgs.filter((m) => m.direction === 'in').every((m) => m.from_person_id === sam)).toBe(true);
    expect(msgs.filter((m) => m.direction === 'out').every((m) => m.to_person_ids.includes(sam))).toBe(true);
  });

  it('asks the student to pick when the account’s own person has a note of its own', async () => {
    const { userId, token } = await igStudent();
    const kim = await person(t.db, userId, 'Kim Lee', { known: true });
    const stored = await chatWith(userId, 'ig-kim', 'chat-kim', 2, 'Kim Lee');
    const own = stored.partner!.personId!;
    await t.db.sql`
      insert into orbit.notes (user_id, person_ids, source, occurred_at, raw_text)
      values (${userId}::uuid, ${[own]}::uuid[], 'manual', now(), 'met at the hackathon')`;
    const r = await call('POST', '/social/links', token, {
      platform: 'instagram',
      accountId: 'ig-kim',
      personId: kim,
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('pick_person');
    expect(r.body.people.map((p: { id: string }) => p.id).sort()).toEqual([kim, own].sort());
    expect(r.body.error.message).not.toMatch(/[!—]/);
    const still = await t.db.sql`select 1 from orbit.people where id = ${own}::uuid`;
    expect(still).toHaveLength(1);
  });

  it('never attaches an X account on the student’s say-so', async () => {
    const { userId, token } = await igStudent();
    const p = await person(t.db, userId, 'Ana X', { known: true });
    const r = await call('POST', '/social/links', token, { platform: 'x', accountId: '12345', personId: p });
    expect(r.status).toBe(403);
  });
});

describe('Not their account', () => {
  it('undoes the attach row by row', async () => {
    await clearQueues(t);
    const { userId, token } = await igStudent();
    const p = await person(t.db, userId, 'Jordan Wu', { known: true });
    const q = await person(t.db, userId, 'Quinn Moss', { known: true });
    await t.db
      .sql`insert into orbit.tie_labels (user_id, person_id, closeness) values (${userId}::uuid, ${p}::uuid, 4)`;
    await upsertAccounts(
      t.db,
      [
        ig('ig-jw', 'jordan.wu', 'Jordan Wu', { bio: 'Designer in Brooklyn', email: 'jordan@wu.design' }),
        ig('ig-quinn', 'quinn.moss', 'Quinn Moss'),
        ig('ig-alt', 'jw.studio', 'Jordan Wu', { email: 'jordan@wu.design' }),
      ],
      { full: true, now: now() },
    );
    // Jordan and Quinn follow each other on Instagram
    await t.db.sql`
      insert into orbit.social_follows (platform, follower_id, followed_id) values
        ('instagram', 'ig-jw', 'ig-quinn'), ('instagram', 'ig-quinn', 'ig-jw')`;
    await attachAccount(t.db, userId, {
      platform: 'instagram',
      accountId: 'ig-quinn',
      personId: q,
      via: 'student',
      now: now(),
    });
    const r1 = await call('POST', '/social/links', token, {
      platform: 'instagram',
      accountId: 'ig-jw',
      personId: p,
    });
    expect(r1.status).toBe(200);
    // a second account the email proved, a chat in the pipeline, a message, a reply, a draft and an open question
    await attachAccount(t.db, userId, {
      platform: 'instagram',
      accountId: 'ig-alt',
      personId: p,
      via: 'proof',
      proof: 'contact',
      now: now(),
    });
    const [chat] = await t.db.sql<{ id: string }>`
      insert into orbit.chats (user_id, person_id, stage) values (${userId}::uuid, ${p}::uuid, 'outreach_sent') returning id`;
    await chatWith(userId, 'ig-jw', 'chat-jw', 1);
    const stored = await storeSocialChat(
      t.db,
      userId,
      'instagram',
      { chatId: 'chat-jw', participants: 2, others: [{ accountId: 'ig-jw' }] },
      [
        {
          messageId: 'chat-jw-reply',
          chatId: 'chat-jw',
          at: new Date().toISOString(),
          fromStudent: false,
          senderAccountId: 'ig-jw',
          text: 'sure, Tuesday works',
          hasWords: true,
        },
      ],
      { now: now() },
    );
    const moved = await afterInbound(t.db, sqlQueue(t.db), userId, 'instagram', stored, now());
    expect(moved.replied).toEqual([chat!.id]);
    const [draft] = await t.db.sql<{ id: string }>`
      insert into orbit.drafts (user_id, person_id, channel, kind, body, status)
      values (${userId}::uuid, ${p}::uuid, 'instagram', 'bump', 'Following up', 'approved') returning id`;
    const other = await person(t.db, userId, 'Jordan Wuu');
    await t.db.sql`
      insert into orbit.social_match_asks (user_id, platform, account_id, person_id, score)
      values (${userId}::uuid, 'instagram', 'ig-jw', ${other}::uuid, 0.7)`;
    const [link] = await t.db.sql<{ id: string }>`
      select id from orbit.social_links where user_id = ${userId}::uuid and account_id = 'ig-jw'`;
    // what the attach brought
    expect(
      (
        await t.db
          .sql`select 1 from orbit.facts where person_id = ${p}::uuid and source_table = 'social:instagram:ig-jw'`
      ).length,
    ).toBe(1);
    expect(
      (
        await t.db.sql`select 1 from orbit.person_identities where person_id = ${p}::uuid and kind = 'email'
                        and social_account_id = 'ig-jw'`
      ).length,
    ).toBe(1);
    const tie = async (a: string, b: string) =>
      t.db.sql`select 1 from orbit.ties where user_id = ${userId}::uuid and kind = 'instagram_mutual'
                 and a_person_id = ${a < b ? a : b}::uuid and b_person_id = ${a < b ? b : a}::uuid`;
    expect(await tie(p, q)).toHaveLength(1);
    await clearQueues(t);

    const r = await call('DELETE', `/social/links/${link!.id}`, token);
    expect(r.status).toBe(200);
    const fresh = r.body.accountPersonId as string;
    // messages, touches and thread membership move to a new unlisted person for the account
    const [np] = await t.db.sql<{ listed: boolean; source_account: string }>`
      select listed, source_account from orbit.people where id = ${fresh}::uuid`;
    expect(np).toEqual({ listed: false, source_account: 'instagram:ig-jw' });
    const msgs = await t.db.sql<{
      from_person_id: string | null;
      to_person_ids: string[];
      direction: string;
    }>`
      select from_person_id, to_person_ids, direction from orbit.messages
       where user_id = ${userId}::uuid and social_account_id = 'ig-jw'`;
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs)
      if (m.direction === 'in') expect(m.from_person_id).toBe(fresh);
      else expect(m.to_person_ids).toEqual([fresh]);
    const [th] = await t.db.sql<{ participant_person_ids: string[] }>`
      select participant_person_ids from orbit.threads where user_id = ${userId}::uuid and external_id = 'chat-jw'`;
    expect(th!.participant_person_ids).toEqual([fresh]);
    // follow ties deleted and rebuilt for the right person
    expect(await tie(p, q)).toHaveLength(0);
    expect(await tie(fresh, q)).toHaveLength(1);
    // facts read from the account deleted
    expect(
      (await t.db.sql`select 1 from orbit.facts where source_table = 'social:instagram:ig-jw'`).length,
    ).toBe(0);
    // the email it added is taken off, and the match that email proved is offered for review
    expect(
      (
        await t.db
          .sql`select 1 from orbit.person_identities where person_id = ${p}::uuid and value_norm = 'jordan@wu.design'`
      ).length,
    ).toBe(0);
    expect(
      (
        await t.db
          .sql`select 1 from orbit.social_links where account_id = 'ig-alt' and user_id = ${userId}::uuid`
      ).length,
    ).toBe(0);
    const [review] = await t.db.sql<{ status: string; person_id: string }>`
      select status, person_id from orbit.social_match_asks where user_id = ${userId}::uuid and account_id = 'ig-alt'`;
    expect(review).toEqual({ status: 'open', person_id: p });
    // the draft queued to the account is paused with a note
    const [d] = await t.db.sql<{
      status: string;
      error: string;
    }>`select status, error from orbit.drafts where id = ${draft!.id}::uuid`;
    expect(d).toEqual({ status: 'draft', error: 'account_detached' });
    // the chat that moved to replied on its message: Orbit proposes moving it back, the student decides
    const [prop] = await t.db.sql<{ from_stage: string; to_stage: string; status: string }>`
      select from_stage, to_stage, status from orbit.stage_events where chat_id = ${chat!.id}::uuid and status = 'proposed'`;
    expect(prop).toEqual({ from_stage: 'replied', to_stage: 'outreach_sent', status: 'proposed' });
    const [c] = await t.db.sql<{ stage: string }>`select stage from orbit.chats where id = ${chat!.id}::uuid`;
    expect(c!.stage).toBe('replied');
    // the student's own closeness rating is kept
    expect((await t.db.sql`select 1 from orbit.tie_labels where person_id = ${p}::uuid`).length).toBe(1);
    // open questions about the account close
    const [ask] = await t.db.sql<{ status: string }>`
      select status from orbit.social_match_asks where user_id = ${userId}::uuid and account_id = 'ig-jw'`;
    expect(ask!.status).toBe('stale');
    // both people rescored, the friend projection rebuilt
    const jobs = await t.db.sql<{ kind: string; payload: { personIds?: string[] } }>`
      select message->>'kind' as kind, message->'payload' as payload from pgmq.q_orbit_score`;
    expect(jobs.find((j) => j.kind === 'score.person')!.payload.personIds!.sort()).toEqual([p, fresh].sort());
    expect(jobs.some((j) => j.kind === 'friend_shares_refresh')).toBe(true);
    // and remembered: never proposed again
    expect(
      (
        await t.db
          .sql`select 1 from orbit.social_not_same where account_id = 'ig-jw' and person_id = ${p}::uuid`
      ).length,
    ).toBe(1);
    const again = await matchAccount(
      t.db,
      userId,
      ig('ig-jw', 'jordan.wu', 'Jordan Wu', { email: 'jordan@wu.design' }),
      { now: now() },
    );
    expect(again.kind === 'attached' && again.personId === p).toBe(false);
  });
});

describe('targets', () => {
  it('attaches the account of someone the student is going after only on hard proof, from a small daily share', async () => {
    const { userId } = await igStudent();
    const priya = await person(t.db, userId, 'Priya Raman');
    const dev = await person(t.db, userId, 'Dev Shah');
    for (const p of [priya, dev])
      await t.db
        .sql`insert into orbit.chats (user_id, person_id, stage) values (${userId}::uuid, ${p}::uuid, 'identified')`;
    // research confirmed Priya's own page, which names her handle; Dev has none
    await t.db.sql`
      insert into orbit.dossiers (user_id, person_id, status, sources)
      values (${userId}::uuid, ${priya}::uuid, 'ready', ${JSON.stringify([{ url: 'https://instagram.com/priya.raman' }])}::jsonb)`;
    const fake = new FakeInstagram('ig-me');
    fake.add({ id: 'ig-priya', username: 'priya.raman', name: 'Priya Raman' });
    const { createInstagramAdapter } = await import('../../functions/_shared/social/instagram.ts');
    const { sqlSocialBudget } = await import('../../functions/_shared/social/budget.ts');
    const { matchTargets } = await import('../../functions/_shared/social/firstDays.ts');
    const adapter = createInstagramAdapter({
      fetch: fake.fetch,
      apiKey: 'k',
      baseUrl: fake.base,
      accountId: `acc-${userId.slice(0, 8)}`,
      budget: sqlSocialBudget(t.db, {
        platform: 'instagram',
        account: `acc-${userId.slice(0, 8)}`,
        caller: 'targets',
        now,
      }),
    });
    expect(await matchTargets(t.db, adapter, userId, { now: now() })).toBe(1);
    const links = await t.db.sql<{ person_id: string; via: string; proof: string }>`
      select person_id, via, proof from orbit.social_links where user_id = ${userId}::uuid`;
    expect(links).toEqual([{ person_id: priya, via: 'proof', proof: 'own_links' }]);
    // no handle, no read: a target is never searched for by name where the platform has no search
    expect(fake.calls.map((c) => c.path.split('?')[0])).toEqual(['/api/v1/users/priya.raman']);
    void dev;
  });
});

describe('questions', () => {
  it('lists open questions; yes attaches, no is remembered', async () => {
    const { userId, token } = await igStudent();
    const a = await person(t.db, userId, 'Tara Singh', { known: true });
    const b = await person(t.db, userId, 'Omar Haddad', { known: true });
    await t.db.sql`
      insert into orbit.social_match_asks (user_id, platform, account_id, person_id, score) values
        (${userId}::uuid, 'instagram', 'ig-tara', ${a}::uuid, 0.8), (${userId}::uuid, 'instagram', 'ig-omar', ${b}::uuid, 0.7)`;
    const list = await call('GET', '/social/asks', token);
    expect(list.body.asks.map((x: { accountId: string }) => x.accountId)).toEqual(['ig-tara', 'ig-omar']);
    const yes = await call('POST', `/social/asks/${list.body.asks[0].id}`, token, { answer: 'yes' });
    expect(yes.body).toEqual({ status: 'yes' });
    expect(
      (
        await t.db
          .sql`select 1 from orbit.social_links where account_id = 'ig-tara' and person_id = ${a}::uuid`
      ).length,
    ).toBe(1);
    const no = await call('POST', `/social/asks/${list.body.asks[1].id}`, token, { answer: 'no' });
    expect(no.body).toEqual({ status: 'no' });
    expect((await t.db.sql`select 1 from orbit.social_not_same where account_id = 'ig-omar'`).length).toBe(1);
  });
});

describe('the old merge', () => {
  it('refuses to merge a person who owns an attached account', async () => {
    const { userId } = await igStudent();
    const a = await person(t.db, userId, 'Lena Fox', { known: true });
    const b = await person(t.db, userId, 'Lena Fox', {});
    await attachAccount(t.db, userId, {
      platform: 'instagram',
      accountId: 'ig-lena',
      personId: a,
      via: 'student',
      now: now(),
    });
    await expect(mergePeople(t.db, userId, b, a)).rejects.toBeInstanceOf(SocialMergeRefused);
    await expect(mergePeople(t.db, userId, a, b)).rejects.toThrow(/Attach the account/);
    const made = await ensureAccountPerson(t.db, userId, ig('ig-unlisted', 'u.one', 'Una One'), now());
    await expect(mergePeople(t.db, userId, b, made.personId)).rejects.toBeInstanceOf(SocialMergeRefused);
    const [p] = await t.db.sql<{
      merged_into: string | null;
    }>`select merged_into from orbit.people where id = ${b}::uuid`;
    expect(p!.merged_into).toBeNull();
  });
});
