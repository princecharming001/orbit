/**
 * Plan 43 §4, §3.9, §8.5, §8.6, Instagram on the server against a fake Unipile: connecting (and the different-account
 * flow), the webhook into the personal lane, the first days inside the rolling budget, sending only on a tap, and
 * releasing an account left Off for 21 days.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadGraph } from '../../functions/_shared/paths/find.ts';
import { sqlQueue } from '../../functions/_shared/queue.ts';
import { memoryTake } from '../../functions/_shared/ratelimit.ts';
import { INSTAGRAM_PER_DAY, sendDraft } from '../../functions/_shared/sending/send.ts';
import { makeServices } from '../../functions/_shared/services.ts';
import { sqlSocialBudget } from '../../functions/_shared/social/budget.ts';
import { fillChatWords } from '../../functions/_shared/social/chats.ts';
import { attachAccount } from '../../functions/_shared/social/links.ts';
import { makeApiHandler } from '../../functions/orbit-api/api.ts';
import { makeWebhookHandler } from '../../functions/orbit-webhooks/webhooks.ts';
import { socialHandlers } from '../../functions/orbit-worker/handlers/social.ts';
import { unipileHandlers } from '../../functions/orbit-worker/handlers/unipile.ts';
import type { JobHandler } from '../../functions/orbit-worker/worker.ts';
import { APP, agentConfig, BASE, SECRET, signedInUser } from '../helpers/agents.ts';
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
beforeEach(async () => {
  await clearQueues(t);
});

const HOOK = 'unipile-secret-placeholder';
const WEBHOOKS = 'https://ref.supabase.co/functions/v1/orbit-webhooks';
let clock = Date.now();
const now = () => new Date(clock);
const noop: JobHandler = async () => {};
const UNIPILE_ENV = { apiKey: 'unipile-placeholder' };

function apiFor(fake: FakeInstagram) {
  const handler = makeApiHandler({
    env: {
      googleClientId: 'client-id-placeholder.apps.googleusercontent.com',
      googleClientSecret: 'client-secret-placeholder',
      googleRedirectUri: `${BASE}/auth/google/callback`,
      sessionSecret: SECRET,
      appUrl: APP,
      unipileKey: UNIPILE_ENV.apiKey,
      unipileBase: fake.base,
      unipileWebhookSecret: HOOK,
      // plan 43: Instagram is offered (the shipped default offers nothing)
      extraSources: ['instagram'],
    },
    db: t.db,
    fetch: fake.fetch,
    take: memoryTake(),
    agent: agentConfig({ fetch: fake.fetch, calls: [] } as never, {
      unipileKey: UNIPILE_ENV.apiKey,
      unipileBase: fake.base,
    }),
    now,
  });
  return (method: string, path: string, token: string, body?: unknown) =>
    handler(
      new Request(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, any> }));
}

function webhook(path: string, body: unknown) {
  const h = makeWebhookHandler({ db: t.db, pubsubToken: 'p', unipileSecret: HOOK, offered: ['instagram'] });
  return h(
    new Request(`${WEBHOOKS}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orbit-webhook': HOOK },
      body: JSON.stringify(body),
    }),
  ).then(async (r) => ({ status: r.status, body: (await r.json()) as { ok: boolean; result: string } }));
}

function workers(fake: FakeInstagram, extra: Record<string, JobHandler> = {}) {
  return {
    ...socialHandlers({
      fetch: fake.fetch,
      unipile: { apiKey: UNIPILE_ENV.apiKey, baseUrl: fake.base },
      random: () => 0.5,
      offered: ['instagram'],
    }),
    'score.person': noop,
    friend_shares_refresh: noop,
    'classify.message': noop,
    ...extra,
  };
}

let accSeq = 0;
/** A signed-in student with Instagram connected as `me` and switched on. */
async function connected(me: string) {
  const s = await signedInUser(t);
  const account = `acc-ig-${++accSeq}`;
  await t.db.sql`
    insert into orbit.integration_accounts (user_id, provider, external_account_id, social_account_id, status)
    values (${s.userId}::uuid, 'instagram', ${account}, ${me}, 'active')`;
  await t.db
    .sql`insert into orbit.source_states (user_id, source, state) values (${s.userId}::uuid, 'instagram', 'on')`;
  return { ...s, account };
}

const message = (account: string, o: Record<string, unknown>) => ({
  event: 'message_received',
  account_id: account,
  account_type: 'INSTAGRAM',
  account_info: { type: 'INSTAGRAM', user_id: 'ig-me' },
  chat_id: 'chat-1',
  timestamp: new Date(clock).toISOString(),
  ...o,
});

describe('connecting', () => {
  it('starts Unipile’s sign-in for Instagram and connects the account the notify names', async () => {
    const fake = new FakeInstagram('ig-me');
    const call = apiFor(fake);
    const { userId, token } = await signedInUser(t);
    const r = await call('POST', '/instagram/connect/start', token, {});
    expect(r.body).toEqual({ url: 'https://account.unipile.test/hosted/ig' });
    const link = fake.calls.find((c) => c.path === '/api/v1/hosted/accounts/link')!;
    expect(link).toBeTruthy();
    const [row] = await t.db.sql<{ status: string }>`
      select status from orbit.integration_accounts where user_id = ${userId}::uuid and provider = 'instagram'`;
    expect(row!.status).toBe('connecting');

    const n = await webhook(`/unipile/account?token=${HOOK}&provider=instagram`, {
      status: 'CREATION_SUCCESS',
      account_id: 'acc-new',
      name: userId,
    });
    expect(n.body.result).toBe('connected');
    const [after] = await t.db.sql<{ status: string; external_account_id: string }>`
      select status, external_account_id from orbit.integration_accounts where user_id = ${userId}::uuid and provider = 'instagram'`;
    expect(after).toEqual({ status: 'active', external_account_id: 'acc-new' });
    const [state] = await t.db.sql<{ state: string }>`
      select state from orbit.source_states where user_id = ${userId}::uuid and source = 'instagram'`;
    expect(state!.state).toBe('on');
    const [job] = await t.db.sql<{ kind: string }>`select message->>'kind' as kind from pgmq.q_orbit_sync`;
    expect(job!.kind).toBe('sync.instagram');
    // the LinkedIn row is untouched by an Instagram sign-in
    expect(
      await t.db
        .sql`select 1 from orbit.integration_accounts where user_id = ${userId}::uuid and provider = 'linkedin'`,
    ).toHaveLength(0);

    await drain(t, workers(fake), now, { maxTicks: 1 });
    const st = await call('GET', '/instagram/status', token);
    expect(st.body).toMatchObject({ status: 'active', username: 'me.student' });
    expect(st.body.steps.profile).toBe('done');
  });

  it('holds a different account until the student says to replace the old one, then removes the old rows', async () => {
    const fake = new FakeInstagram('ig-new');
    fake.add({ id: 'ig-new', username: 'new.handle', name: 'Sam Rivera' });
    const call = apiFor(fake);
    const s = await connected('ig-old');
    // what the old account brought
    const p = await (async () => {
      const [x] = await t.db.sql<{ id: string }>`
        insert into orbit.people (user_id, display_name, name_norm) values (${s.userId}::uuid, 'Old Friend', 'old friend') returning id`;
      return x!.id;
    })();
    await attachAccount(t.db, s.userId, {
      platform: 'instagram',
      accountId: 'ig-oldfriend',
      personId: p,
      via: 'student',
      now: now(),
    });
    await t.db.sql`
      insert into orbit.social_follows (platform, follower_id, followed_id, owner_user_id)
      values ('instagram', 'ig-old', 'ig-oldfriend', ${s.userId}::uuid)`;

    const n = await webhook(`/unipile/account?token=${HOOK}&provider=instagram`, {
      status: 'CREATION_SUCCESS',
      account_id: 'acc-other',
      name: s.userId,
    });
    expect(n.body.result).toBe('connected');
    await drain(t, workers(fake), now, { maxTicks: 2 });
    const held = await call('GET', '/instagram/status', s.token);
    expect(held.body).toMatchObject({ status: 'different_account', username: 'new.handle' });
    // nothing was read beyond the profile, and the old rows are all there
    expect(fake.calls.map((c) => c.path.split('?')[0])).toEqual(['/api/v1/users/me']);
    expect(await t.db.sql`select 1 from orbit.social_links where user_id = ${s.userId}::uuid`).toHaveLength(
      1,
    );

    const r = await call('POST', '/instagram/connect/start', s.token, { replace: true });
    expect(r.body).toEqual({ replaced: true });
    expect(await t.db.sql`select 1 from orbit.social_links where user_id = ${s.userId}::uuid`).toHaveLength(
      0,
    );
    expect(
      await t.db.sql`select 1 from orbit.social_follows where owner_user_id = ${s.userId}::uuid`,
    ).toHaveLength(0);
    expect(await t.db.sql`select 1 from orbit.people where id = ${p}::uuid`).toHaveLength(1);
    await drain(t, workers(fake), now, { maxTicks: 1 });
    const [row] = await t.db.sql<{ status: string; social_account_id: string }>`
      select status, social_account_id from orbit.integration_accounts where user_id = ${s.userId}::uuid and provider = 'instagram'`;
    expect(row).toEqual({ status: 'active', social_account_id: 'ig-new' });
  });

  it('tells the student once when Instagram asks them to sign in again', async () => {
    const s = await connected('ig-me');
    for (let i = 0; i < 2; i++)
      await webhook('/unipile', {
        AccountStatus: { account_id: s.account, account_type: 'INSTAGRAM', message: 'CREDENTIALS' },
      });
    const [row] = await t.db.sql<{ status: string }>`
      select status from orbit.integration_accounts where user_id = ${s.userId}::uuid and provider = 'instagram'`;
    expect(row!.status).toBe('needs_reauth');
    const notes = await t.db.sql<{ title: string }>`
      select title from orbit.notifications where user_id = ${s.userId}::uuid and kind = 'instagram_sign_in'`;
    expect(notes).toEqual([{ title: 'Sign in to Instagram again' }]);
  });
});

describe('the personal lane', () => {
  it('keeps no words for a friend outside the pipeline, calls no model, and makes no one owe a reply', async () => {
    const s = await connected('ig-me');
    const friend = { attendee_provider_id: 'ig-friend', attendee_name: 'Ruby Lane' };
    const me = { attendee_provider_id: 'ig-me', attendee_name: 'Sam Rivera' };
    const r1 = await webhook(
      '/unipile',
      message(s.account, {
        message_id: 'u-1',
        provider_message_id: 'ig-m1',
        message: 'are you coming tonight',
        sender: friend,
        attendees: [me, friend],
      }),
    );
    expect(r1.body.result).toBe('stored');
    clock += 60_000;
    await webhook(
      '/unipile',
      message(s.account, {
        message_id: 'u-2',
        provider_message_id: 'ig-m2',
        message: 'yes',
        sender: me,
        attendees: [me, friend],
      }),
    );
    clock += 60_000;
    await webhook(
      '/unipile',
      message(s.account, {
        message_id: 'u-3',
        provider_message_id: 'ig-m3',
        message: 'great see you',
        sender: friend,
        attendees: [me, friend],
      }),
    );
    const dup = await webhook(
      '/unipile',
      message(s.account, {
        message_id: 'u-3',
        provider_message_id: 'ig-m3',
        message: 'great see you',
        sender: friend,
        attendees: [me, friend],
      }),
    );
    expect(dup.body.result).toBe('duplicate');
    const msgs = await t.db.sql<{
      external_id: string;
      body_text: string | null;
      snippet: string | null;
      has_words: boolean;
      social_account_id: string;
      direction: string;
    }>`
      select external_id, body_text, snippet, has_words, social_account_id, direction from orbit.messages
       where user_id = ${s.userId}::uuid order by sent_at`;
    expect(msgs.map((m) => m.external_id)).toEqual(['ig-m1', 'ig-m2', 'ig-m3']);
    expect(msgs.every((m) => m.body_text === null && m.snippet === null && m.has_words)).toBe(true);
    expect(msgs.every((m) => m.social_account_id === 'ig-friend')).toBe(true);
    const [th] = await t.db.sql<{ is_networking: boolean; participant_person_ids: string[] }>`
      select is_networking, participant_person_ids from orbit.threads where user_id = ${s.userId}::uuid`;
    expect(th!.is_networking).toBe(false);
    // they wrote both ways: an unlisted person, offered to matching
    const friendId = th!.participant_person_ids[0]!;
    const [fp] = await t.db.sql<{ listed: boolean; source_account: string }>`
      select listed, source_account from orbit.people where id = ${friendId}::uuid`;
    expect(fp!.source_account).toBe('instagram:ig-friend');
    // no model is asked and nothing is drafted; the last word is theirs, but the student owes nothing
    const classify = await t.db.sql`select 1 from pgmq.q_orbit_classify`;
    expect(classify).toHaveLength(0);
    expect(await t.db.sql`select 1 from orbit.drafts where user_id = ${s.userId}::uuid`).toHaveLength(0);
    const g = await loadGraph(t.db, s.userId, now());
    expect(g.people.get(friendId)?.owesReply ?? false).toBe(false);

    // the friend enters the pipeline: that one chat is read again and its words filled in
    const fake = new FakeInstagram('ig-me', () => clock);
    fake.add({ id: 'ig-friend', username: 'ruby.lane', name: 'Ruby Lane' });
    fake.chats.push({
      id: 'chat-1',
      others: ['ig-friend'],
      messages: [
        {
          id: 'ig-m1',
          sender: 'ig-friend',
          text: 'are you coming tonight',
          at: msgs[0] ? new Date(clock - 120_000).toISOString() : '',
        },
        { id: 'ig-m2', sender: 'ig-me', text: 'yes', at: new Date(clock - 60_000).toISOString() },
        { id: 'ig-m3', sender: 'ig-friend', text: 'great see you', at: new Date(clock).toISOString() },
      ],
    });
    await t.db
      .sql`insert into orbit.chats (user_id, person_id, stage) values (${s.userId}::uuid, ${friendId}::uuid, 'identified')`;
    await fillChatWords(t.db, s.userId, friendId);
    await drain(t, workers(fake), now, { maxTicks: 2 });
    const filled = await t.db.sql<{ body_text: string | null }>`
      select body_text from orbit.messages where user_id = ${s.userId}::uuid order by sent_at`;
    expect(filled.map((m) => m.body_text)).toEqual(['are you coming tonight', 'yes', 'great see you']);
    const [th2] = await t.db.sql<{ is_networking: boolean }>`
      select is_networking from orbit.threads where user_id = ${s.userId}::uuid`;
    expect(th2!.is_networking).toBe(true);
    const [listed] = await t.db.sql<{
      listed: boolean;
    }>`select listed from orbit.people where id = ${friendId}::uuid`;
    expect(listed!.listed).toBe(true);
    // nothing was stored twice
    expect(await t.db.sql`select 1 from orbit.messages where user_id = ${s.userId}::uuid`).toHaveLength(3);
  });

  it('stores small groups with their size, skips large ones, and stores nothing while Instagram is off', async () => {
    const s = await connected('ig-me');
    const me = { attendee_provider_id: 'ig-me' };
    const people = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        attendee_provider_id: `ig-g${i}`,
        attendee_name: `Group Member${i}`,
      }));
    const small = await webhook(
      '/unipile',
      message(s.account, {
        chat_id: 'chat-g4',
        message_id: 'u-g4',
        provider_message_id: 'ig-g4',
        message: 'lol',
        sender: people(3)[0],
        attendees: [me, ...people(3)],
      }),
    );
    expect(small.body.result).toBe('stored');
    const [th] = await t.db.sql<{
      participant_count: number;
      participant_person_ids: string[];
      social_account_id: string | null;
    }>`
      select participant_count, participant_person_ids, social_account_id from orbit.threads
       where user_id = ${s.userId}::uuid and external_id = 'chat-g4'`;
    expect(th).toEqual({ participant_count: 3, participant_person_ids: [], social_account_id: null });
    const big = await webhook(
      '/unipile',
      message(s.account, {
        chat_id: 'chat-g10',
        message_id: 'u-g10',
        provider_message_id: 'ig-g10',
        message: 'hi all',
        sender: people(9)[0],
        attendees: [me, ...people(9)],
      }),
    );
    expect(big.body.result).toBe('group_chat');
    expect(await t.db.sql`select 1 from orbit.threads where external_id = 'chat-g10'`).toHaveLength(0);

    await t.db
      .sql`update orbit.source_states set state = 'off', off_since = now() where user_id = ${s.userId}::uuid`;
    const off = await webhook(
      '/unipile',
      message(s.account, {
        chat_id: 'chat-off',
        message_id: 'u-off',
        provider_message_id: 'ig-off',
        message: 'hello',
        sender: { attendee_provider_id: 'ig-x' },
        attendees: [me],
      }),
    );
    expect(off.body.result).toBe('source_off');
    expect(await t.db.sql`select 1 from orbit.messages where external_id = 'ig-off'`).toHaveLength(0);
    expect(
      await t.db.sql`select 1 from orbit.webhook_events where event_id = 'instagram:u-off'`,
    ).toHaveLength(0);
  });

  it('a reply on a chat the student is waiting on moves it to replied, keeps the words and is classified', async () => {
    const s = await connected('ig-me');
    const [p] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, first_name, last_name, name_norm)
      values (${s.userId}::uuid, 'Nora Quinn', 'Nora', 'Quinn', 'nora quinn') returning id`;
    await attachAccount(t.db, s.userId, {
      platform: 'instagram',
      accountId: 'ig-nora',
      personId: p!.id,
      via: 'student',
      now: now(),
    });
    const [chat] = await t.db.sql<{ id: string }>`
      insert into orbit.chats (user_id, person_id, stage) values (${s.userId}::uuid, ${p!.id}::uuid, 'outreach_sent') returning id`;
    const r = await webhook(
      '/unipile',
      message(s.account, {
        chat_id: 'chat-nora',
        message_id: 'u-n1',
        provider_message_id: 'ig-n1',
        message: 'Happy to chat Thursday',
        sender: { attendee_provider_id: 'ig-nora', attendee_name: 'Nora Quinn' },
        attendees: [{ attendee_provider_id: 'ig-me' }],
      }),
    );
    expect(r.body.result).toBe('replied');
    const [c] = await t.db.sql<{ stage: string }>`select stage from orbit.chats where id = ${chat!.id}::uuid`;
    expect(c!.stage).toBe('replied');
    const [m] = await t.db.sql<{ body_text: string; from_person_id: string }>`
      select body_text, from_person_id from orbit.messages where external_id = 'ig-n1'`;
    expect(m).toEqual({ body_text: 'Happy to chat Thursday', from_person_id: p!.id });
    const q = await t.db.sql<{ kind: string }>`select message->>'kind' as kind from pgmq.q_orbit_classify`;
    expect(q.map((x) => x.kind)).toEqual(['classify.message']);
  });
});

describe('the first days', () => {
  it('reads the profile and chats first, then the lists, never past 60 percent of either window', async () => {
    clock = Date.now();
    const fake = new FakeInstagram('ig-me', () => clock);
    for (let i = 0; i < 230; i++) fake.add({ id: `ig-f${i}`, username: `f${i}`, name: `Friend Number${i}` });
    for (let i = 0; i < 230; i++) fake.follow('ig-me', `ig-f${i}`);
    for (let i = 0; i < 60; i++) fake.follow(`ig-f${i}`, 'ig-me');
    for (let i = 0; i < 5; i++)
      fake.chats.push({
        id: `chat-${i}`,
        others: [`ig-f${i}`],
        messages: [
          { id: `c${i}-1`, sender: `ig-f${i}`, text: 'hey', at: new Date(clock - 86_400_000).toISOString() },
          { id: `c${i}-2`, sender: 'ig-me', text: 'hi', at: new Date(clock - 80_000_000).toISOString() },
        ],
      });
    const { userId } = await signedInUser(t);
    await webhook(`/unipile/account?token=${HOOK}&provider=instagram`, {
      status: 'CREATION_SUCCESS',
      account_id: 'acc-first',
      name: userId,
    });
    const start = clock;
    await drain(t, workers(fake), now, {
      maxTicks: 170,
      onTick: () => {
        clock += 10 * 60_000;
      },
    });
    const at = fake.calls.map((c) => c.at);
    const most = (ms: number) => Math.max(...at.map((x) => at.filter((y) => y >= x && y < x + ms).length));
    expect(most(3_600_000)).toBeLessThanOrEqual(6);
    expect(most(86_400_000)).toBeLessThanOrEqual(60);
    // the profile first, and the chats within the first hour
    expect(fake.calls[0]!.path.startsWith('/api/v1/users/me')).toBe(true);
    const firstHour = fake.calls.filter((c) => c.at < start + 3_600_000).map((c) => c.path.split('?')[0]);
    expect(firstHour).toContain('/api/v1/chats');
    expect(firstHour.some((p) => /\/chats\/chat-\d\/messages$/.test(p!))).toBe(true);
    // then who they follow, then who follows them, 25 at a time
    const lists = fake.calls.filter((c) => c.path.startsWith('/api/v1/users/follow'));
    expect(lists[0]!.path).toContain('/following');
    expect(
      fake.calls
        .filter((c) => c.path.startsWith('/api/v1/users/followers'))
        .every((c) => c.path.includes('limit=25')),
    ).toBe(true);
    const [own] = await t.db.sql<{ following: number; followers: number }>`
      select count(*) filter (where follower_id = 'ig-me')::int as following,
             count(*) filter (where followed_id = 'ig-me')::int as followers
        from orbit.social_follows where owner_user_id = ${userId}::uuid`;
    expect(own).toEqual({ following: 230, followers: 60 });
    const [row] = await t.db.sql<{ stage: string }>`
      select sync_state #>> '{instagram,stage}' as stage from orbit.integration_accounts
       where user_id = ${userId}::uuid and provider = 'instagram'`;
    expect(row!.stage).toBe('refresh');
    // chat history is closeness, not networking mail
    expect(
      await t.db.sql`select 1 from orbit.messages where user_id = ${userId}::uuid and body_text is not null`,
    ).toHaveLength(0);
  }, 120_000);

  it('leaves the student’s own request room when background work has filled its share', async () => {
    const at = new Date(Date.now() + 40 * 86_400_000);
    const bg = sqlSocialBudget(t.db, {
      platform: 'instagram',
      account: 'acc-room',
      caller: 'background',
      now: () => at,
    });
    const me = sqlSocialBudget(t.db, {
      platform: 'instagram',
      account: 'acc-room',
      caller: 'student',
      now: () => at,
    });
    let made = 0;
    while (await bg.spend('list')) made++;
    expect(made).toBe(6);
    let mine = 0;
    while (await me.spend('profile')) mine++;
    expect(mine).toBe(4);
    const retry = await me.retryAt!('profile');
    expect(retry!.getTime()).toBe(at.getTime() + 3_600_000);
    const [calls] = await t.db.sql<{ made: number; refused: number }>`
      select sum(made)::int as made, sum(refused)::int as refused from orbit.social_calls where account = 'acc-room'`;
    expect(calls).toEqual({ made: 10, refused: 2 });
  });
});

describe('sending', () => {
  it('needs the student’s tap, notes when it lands in requests, and writes the touch', async () => {
    clock = Date.now();
    const fake = new FakeInstagram('ig-me', () => clock);
    fake.add({ id: 'ig-pat', username: 'pat.ng', name: 'Pat Ng' });
    const call = apiFor(fake);
    const s = await connected('ig-me');
    const [p] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, first_name, last_name, name_norm)
      values (${s.userId}::uuid, 'Pat Ng', 'Pat', 'Ng', 'pat ng') returning id`;
    await attachAccount(t.db, s.userId, {
      platform: 'instagram',
      accountId: 'ig-pat',
      personId: p!.id,
      via: 'student',
      now: now(),
    });
    // the student's followers list was read to the end, and Pat is not on it
    await t.db.sql`
      insert into orbit.social_list_reads (platform, account_id, list, owner_user_id, read_by, rows_read, ended)
      values ('instagram', 'ig-me', 'followers', ${s.userId}::uuid, ${s.userId}::uuid, 0, true)`;
    const c = await call('POST', '/drafts/compose', s.token, {
      personId: p!.id,
      kind: 'first_touch',
      channel: 'instagram',
    });
    expect(c.status).toBe(200);
    expect(c.body.draft.channel).toBe('instagram');
    expect(c.body.draft.note).toBe(
      'They do not follow you on Instagram, so this lands in their message requests.',
    );
    const id = c.body.draft.id as string;
    const body = 'Hi Pat, loved your post on the climate hackathon. Could I ask you two questions about it?';
    const noTap = await call('POST', '/drafts/approve', s.token, { draftId: id, body });
    expect(noTap.status).toBe(409);
    expect(noTap.body.error.code).toBe('needs_confirmation');
    expect(fake.sent).toHaveLength(0);
    const tap = await call('POST', '/drafts/approve', s.token, { draftId: id, body, confirm: true });
    expect(tap.body.draft.status).toBe('sent');
    expect(fake.sent).toEqual([{ accountId: 'ig-pat', text: body }]);
    // the touch, written at once with its words
    const [m] = await t.db.sql<{ direction: string; body_text: string; to_person_ids: string[] }>`
      select direction, body_text, to_person_ids from orbit.messages where user_id = ${s.userId}::uuid and provider = 'instagram'`;
    expect(m).toEqual({ direction: 'out', body_text: body, to_person_ids: [p!.id] });
    // the webhook's copy of the student's own message is not stored again
    const echo = await webhook(
      '/unipile',
      message(s.account, {
        chat_id: 'chat-new-1',
        message_id: 'sent-1',
        message: body,
        sender: { attendee_provider_id: 'ig-me' },
        attendees: [{ attendee_provider_id: 'ig-pat' }],
      }),
    );
    expect(echo.body.result).toBe('own_message');
    expect(
      await t.db
        .sql`select 1 from orbit.messages where user_id = ${s.userId}::uuid and provider = 'instagram'`,
    ).toHaveLength(1);
  });

  it('never sends what Orbit approved on its own', async () => {
    const fake = new FakeInstagram('ig-me', () => clock);
    const s = await connected('ig-me');
    const [p] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm) values (${s.userId}::uuid, 'Lou Auto', 'lou auto') returning id`;
    await attachAccount(t.db, s.userId, {
      platform: 'instagram',
      accountId: 'ig-lou',
      personId: p!.id,
      via: 'student',
      now: now(),
    });
    const [d] = await t.db.sql<{ id: string; body: string }>`
      insert into orbit.drafts (user_id, person_id, channel, kind, body, status, send_at)
      values (${s.userId}::uuid, ${p!.id}::uuid, 'instagram', 'bump', 'Just checking in', 'approved', now()) returning id, body`;
    const { messageHash } = await import('@orbit/core/safety/rules');
    await t.db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${s.userId}::uuid, 'agent', 'draft.auto_approve', 'drafts', ${d!.id},
              ${{ hash: messageHash({ channel: 'instagram' as never, subject: null, body: d!.body }) }}::jsonb)`;
    const services = makeServices(
      agentConfig({ fetch: fake.fetch, calls: [] } as never, {
        unipileKey: 'k',
        unipileBase: fake.base,
        extraSources: ['instagram'],
      }),
      {
        db: t.db,
        now,
        queue: sqlQueue(t.db),
      },
    );
    const r = await sendDraft(services, d!.id);
    expect(r).toEqual({ status: 'held', reason: 'instagram_never_auto' });
    expect(fake.sent).toHaveLength(0);
  });

  it('sends at most 10 a day, each on its tap; the eleventh waits as a draft', async () => {
    clock = Date.now();
    const fake = new FakeInstagram('ig-me', () => clock);
    fake.add({ id: 'ig-kim', username: 'kim.lee', name: 'Kim Lee' });
    const call = apiFor(fake);
    const s = await connected('ig-me');
    const [p] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, first_name, last_name, name_norm)
      values (${s.userId}::uuid, 'Kim Lee', 'Kim', 'Lee', 'kim lee') returning id`;
    await attachAccount(t.db, s.userId, {
      platform: 'instagram',
      accountId: 'ig-kim',
      personId: p!.id,
      via: 'student',
      now: now(),
    });
    const draft = async (body: string) => {
      const [d] = await t.db.sql<{ id: string }>`
        insert into orbit.drafts (user_id, person_id, channel, kind, body, status)
        values (${s.userId}::uuid, ${p!.id}::uuid, 'instagram', 'bump', ${body}, 'draft') returning id`;
      return d!.id;
    };
    for (let i = 0; i < INSTAGRAM_PER_DAY; i++) {
      const id = await draft(`Hi Kim, a quick question number ${i + 1} about the design club.`);
      const r = await call('POST', '/drafts/approve', s.token, { draftId: id, confirm: true });
      expect(r.body.draft.status).toBe('sent');
    }
    expect(fake.sent).toHaveLength(INSTAGRAM_PER_DAY);
    const eleventh = await draft('Hi Kim, one more question about the design club.');
    const r = await call('POST', '/drafts/approve', s.token, { draftId: eleventh, confirm: true });
    expect(r.body.draft.status).toBe('draft');
    expect(r.body.draft.error).toBe('instagram_daily_cap');
    expect(fake.sent).toHaveLength(INSTAGRAM_PER_DAY);
  });
});

describe('parking', () => {
  it('releases an Instagram account left Off for 21 days, and not one Off for less', async () => {
    const fake = new FakeInstagram('ig-me');
    const idle = await connected('ig-idle');
    const recent = await connected('ig-recent');
    fake.unipileAccounts.set(idle.account, { type: 'INSTAGRAM', name: idle.userId });
    fake.unipileAccounts.set(recent.account, { type: 'INSTAGRAM', name: recent.userId });
    await t.db
      .sql`update orbit.source_states set state = 'off', off_since = now() - interval '22 days' where user_id = ${idle.userId}::uuid`;
    await t.db
      .sql`update orbit.source_states set state = 'off', off_since = now() - interval '20 days' where user_id = ${recent.userId}::uuid`;
    await sqlQueue(t.db).enqueue({
      kind: 'linkedin.park',
      userId: null,
      payload: {},
      dedupeKey: `park:${Math.random()}`,
    });
    await drain(
      t,
      unipileHandlers({
        fetch: fake.fetch,
        unipile: { apiKey: 'k', baseUrl: fake.base },
        park: { days: 21 },
      }),
      () => new Date(),
      { maxTicks: 2 },
    );
    expect(fake.deleted).toEqual([idle.account]);
    const rows = await t.db.sql<{ user_id: string; status: string; external_account_id: string | null }>`
      select user_id, status, external_account_id from orbit.integration_accounts
       where provider = 'instagram' and user_id = any(${[idle.userId, recent.userId]}::uuid[])`;
    expect(rows.find((r) => r.user_id === idle.userId)).toMatchObject({
      status: 'parked',
      external_account_id: null,
    });
    expect(rows.find((r) => r.user_id === recent.userId)).toMatchObject({ status: 'active' });
  });
});
