/**
 * Plan 43, the five server gaps the web build found:
 *   1. pulled social_links carry the handle, whether they follow the student, and (X) whether they accept messages;
 *   2. the student's pick after a 409 pick_person merges the other person into the one kept, and says it cannot be
 *      undone;
 *   3. a different Instagram account can be refused: the old one stays, only the account just linked is released;
 *   4. Instagram and X go out from the draft box the way LinkedIn does: a tap, a confirm under 15 minutes old, the
 *      caps, and the touch written;
 *   5. a "same person" question carries its evidence in plain lines beside the raw signals.
 */
import { messageHash } from '@orbit/core/safety/rules';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../functions/_shared/db.ts';
import { sqlQueue } from '../../functions/_shared/queue.ts';
import { memoryTake } from '../../functions/_shared/ratelimit.ts';
import { sendDraft } from '../../functions/_shared/sending/send.ts';
import { makeServices } from '../../functions/_shared/services.ts';
import type { SocialAdapter } from '../../functions/_shared/social/adapter.ts';
import { storeSocialChat } from '../../functions/_shared/social/chats.ts';
import { askLines } from '../../functions/_shared/social/evidence.ts';
import { readListPage, upsertAccounts } from '../../functions/_shared/social/graph.ts';
import { attachAccount } from '../../functions/_shared/social/links.ts';
import { matchAccount } from '../../functions/_shared/social/people.ts';
import type { XConfig } from '../../functions/_shared/social/x/config.ts';
import { keepAcceptsDms } from '../../functions/_shared/social/x/lists.ts';
import { storeXTokens } from '../../functions/_shared/social/x/oauth.ts';
import { forgetOffered } from '../../functions/_shared/sources/states.ts';
import { sqlVault } from '../../functions/_shared/vault.ts';
import { makeApiHandler } from '../../functions/orbit-api/api.ts';
import { makeWebhookHandler } from '../../functions/orbit-webhooks/webhooks.ts';
import { socialHandlers } from '../../functions/orbit-worker/handlers/social.ts';
import type { JobHandler } from '../../functions/orbit-worker/worker.ts';
import { APP, agentConfig, BASE, SECRET, signedInUser } from '../helpers/agents.ts';
import { FakeInstagram } from '../helpers/fakeInstagram.ts';
import { FAKE_X_CLIENT_ID, FAKE_X_CLIENT_SECRET, FakeX } from '../helpers/fakeX.ts';
import { clearQueues, drain } from '../helpers/ingest.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
  // the owner launched X; ORBIT_EXTRA_SOURCES offers Instagram
  await t.db
    .sql`insert into orbit_private.source_launch (source, offered, changed_at) values ('x', true, now())`;
  forgetOffered(t.db);
});
afterAll(async () => {
  await t.pg.close();
});
beforeEach(async () => {
  await clearQueues(t);
});

const HOOK = 'unipile-secret-placeholder';
const WEBHOOKS = 'https://ref.supabase.co/functions/v1/orbit-webhooks';
const UNIPILE_KEY = 'unipile-placeholder';
const noop: JobHandler = async () => {};
const now = () => new Date();

const xCfg = (): XConfig => ({
  clientId: FAKE_X_CLIENT_ID,
  clientSecret: FAKE_X_CLIENT_SECRET,
  studentMonthlyUsd: 15,
  orbitMonthlyUsd: 500,
  listLimit: 600,
  offered: false,
});

/** One fetch for both fakes: Unipile's host goes to the Instagram fake, everything else to X's. */
function both(ig: FakeInstagram, x: FakeX): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith(ig.base) ? ig.fetch(input, init) : x.fetch(input, init);
  }) as typeof fetch;
}

const env = (ig: FakeInstagram) => ({
  unipileKey: UNIPILE_KEY,
  unipileBase: ig.base,
  extraSources: ['instagram' as const],
  x: xCfg(),
});

function apiFor(ig: FakeInstagram, x = new FakeX()) {
  const fetchFn = both(ig, x);
  const handler = makeApiHandler({
    env: {
      googleClientId: 'client-id-placeholder.apps.googleusercontent.com',
      googleClientSecret: 'client-secret-placeholder',
      googleRedirectUri: `${BASE}/auth/google/callback`,
      sessionSecret: SECRET,
      appUrl: APP,
      unipileWebhookSecret: HOOK,
      ...env(ig),
    },
    db: t.db,
    fetch: fetchFn,
    take: memoryTake(),
    agent: { ...agentConfig({ fetch: fetchFn, calls: [] } as never, env(ig)), fetch: fetchFn },
    now,
    // rows written a moment ago are pulled at once (the lag only guards transactions still open)
    pullLagMs: -5000,
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

function services(ig: FakeInstagram, x: FakeX) {
  const fetchFn = both(ig, x);
  return makeServices(
    { ...agentConfig({ fetch: fetchFn, calls: [] } as never, env(ig)), fetch: fetchFn },
    { db: t.db, now, queue: sqlQueue(t.db) },
  );
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

let accSeq = 0;
/** A signed-in student with Instagram connected as `me` and on. */
async function igStudent(me = 'ig-me', settings?: Record<string, unknown>) {
  const s = await signedInUser(t, settings ? { settings } : {});
  const account = `acc-gap-${++accSeq}`;
  await t.db.sql`
    insert into orbit.integration_accounts (user_id, provider, external_account_id, social_account_id, status)
    values (${s.userId}::uuid, 'instagram', ${account}, ${me}, 'active')`;
  await t.db
    .sql`insert into orbit.source_states (user_id, source, state) values (${s.userId}::uuid, 'instagram', 'on')`;
  return { ...s, account };
}

/** Adds X to a student: tokens in Vault, consent given, X on. */
async function withX(fake: FakeX, userId: string, xId: string) {
  const tok = fake.issue(xId);
  const v = await storeXTokens(
    sqlVault(t.db),
    userId,
    { access_token: tok.access, refresh_token: tok.refresh, expires_in: 7200 },
    new Date(),
  );
  const x = {
    username: fake.users.get(xId)!.username,
    accessSecretId: v.accessSecretId,
    accessExpiresAt: v.accessExpiresAt,
    consent: { version: 'test', at: new Date().toISOString() },
  };
  await t.db.sql`
    insert into orbit.integration_accounts (user_id, provider, status, social_account_id, token_secret_id, sync_state)
    values (${userId}::uuid, 'x', 'active', ${xId}, ${v.refreshSecretId}::uuid, ${{ x }}::jsonb)`;
  await t.db
    .sql`insert into orbit.source_states (user_id, source, state) values (${userId}::uuid, 'x', 'on')`;
}

async function person(
  db: Db,
  userId: string,
  name: string,
  o: { known?: boolean; org?: string; title?: string } = {},
) {
  const [first, ...rest] = name.split(' ');
  const [p] = await db.sql<{ id: string }>`
    insert into orbit.people (user_id, display_name, first_name, last_name, name_norm, sources, linkedin_connected_on,
                              org_raw, title)
    values (${userId}::uuid, ${name}, ${first}, ${rest.join(' ')}, ${name.toLowerCase()}, array['linkedin'],
            ${o.known ? new Date().toISOString() : null}::timestamptz, ${o.org ?? null}, ${o.title ?? null})
    returning id`;
  return p!.id;
}

async function pullLinks(call: ReturnType<typeof apiFor>, token: string) {
  const r = await call('POST', '/sync/pull', token, { tables: ['social_links'] });
  expect(r.status).toBe(200);
  return (r.body.changes.social_links ?? []) as Record<string, unknown>[];
}

/** A one-to-one chat with an account, which gives the account a person of its own. */
async function chatWith(userId: string, account: string, chatId: string, name: string) {
  return storeSocialChat(
    t.db,
    userId,
    'instagram',
    { chatId, participants: 2, others: [{ accountId: account, name }] },
    [0, 1].map((i) => ({
      messageId: `${chatId}-m${i}`,
      chatId,
      at: new Date(Date.now() - (2 - i) * 3_600_000).toISOString(),
      fromStudent: i === 1,
      senderAccountId: i === 1 ? 'ig-me' : account,
      text: `hey ${i}`,
      hasWords: true,
    })),
    { now: new Date() },
  );
}

describe('1. pulled social_links', () => {
  it('carry the handle and whether they follow the student, once the follower list was read to the end', async () => {
    const ig = new FakeInstagram('ig-me');
    const call = apiFor(ig);
    const s = await igStudent();
    await upsertAccounts(
      t.db,
      [
        { platform: 'instagram', id: 'ig-ana', username: 'ana.li', name: 'Ana Li' },
        { platform: 'instagram', id: 'ig-bo', username: 'bo.ng', name: 'Bo Ng' },
      ],
      { full: true, now: now() },
    );
    const ana = await person(t.db, s.userId, 'Ana Li');
    const bo = await person(t.db, s.userId, 'Bo Ng');
    for (const [accountId, personId] of [
      ['ig-ana', ana],
      ['ig-bo', bo],
    ] as const)
      await attachAccount(t.db, s.userId, {
        platform: 'instagram',
        accountId,
        personId,
        via: 'student',
        now: now(),
      });
    // Ana follows the student; the list is not read to the end yet, so for Bo Orbit does not know
    await t.db.sql`
      insert into orbit.social_follows (platform, follower_id, followed_id, owner_user_id)
      values ('instagram', 'ig-ana', 'ig-me', ${s.userId}::uuid)`;
    let links = await pullLinks(call, s.token);
    const by = (rows: Record<string, unknown>[], id: string) => rows.find((r) => r.accountId === id)!;
    expect(by(links, 'ig-ana')).toMatchObject({ username: 'ana.li', followsYou: true, personId: ana });
    expect(by(links, 'ig-bo')).toMatchObject({ username: 'bo.ng', followsYou: null });
    expect(by(links, 'ig-ana').acceptsDms).toBeUndefined();
    expect(by(links, 'ig-ana').acceptsDmsAt).toBeUndefined();
    expect(by(links, 'ig-ana').refreshedAt).toBeUndefined();

    // the follower list read to the end (Ana only) sends the links again, now saying Bo does not follow back
    const first = await call('POST', '/sync/pull', s.token, { tables: ['social_links'] });
    const adapter = {
      platform: 'instagram',
      listPage: async () => ({ ids: ['ig-ana'], cursor: undefined, total: 1 }),
    } as unknown as SocialAdapter;
    const page = await readListPage(t.db, adapter, {
      accountId: 'ig-me',
      list: 'followers',
      owner: s.userId,
      readBy: s.userId,
      now: new Date(Date.now() + 1000),
    });
    expect(page.complete).toBe(true);
    const again = await call('POST', '/sync/pull', s.token, {
      tables: ['social_links'],
      cursor: first.body.cursor,
    });
    links = again.body.changes.social_links ?? [];
    expect(by(links, 'ig-ana')).toMatchObject({ followsYou: true });
    expect(by(links, 'ig-bo')).toMatchObject({ followsYou: false });
  });

  it('on X: follows back from the student’s own following list, and accepts messages from the last read', async () => {
    const ig = new FakeInstagram('ig-me');
    const call = apiFor(ig);
    const s = await signedInUser(t);
    await t.db.sql`
      insert into orbit.integration_accounts (user_id, provider, status, social_account_id)
      values (${s.userId}::uuid, 'x', 'active', '100')`;
    await t.db
      .sql`insert into orbit.source_states (user_id, source, state) values (${s.userId}::uuid, 'x', 'on')`;
    const ids = { mutual: '301', oneWay: '302', notFollowed: '303' };
    for (const [k, id] of Object.entries(ids)) {
      await t.db.sql`
        insert into orbit.social_accounts (platform, account_id, username, name) values ('x', ${id}, ${k}, ${k})
        on conflict do nothing`;
      const p = await person(t.db, s.userId, `Person ${k}`);
      await attachAccount(t.db, s.userId, {
        platform: 'x',
        accountId: id,
        personId: p,
        via: 'proof',
        proof: 'links_back',
        now: now(),
      });
    }
    // the student's following list was read to the end: they follow 301 (who follows back) and 302 (who does not)
    await t.db.sql`
      insert into orbit.social_list_reads (platform, account_id, list, owner_user_id, read_by, rows_read, total, ended)
      values ('x', '100', 'following', ${s.userId}::uuid, ${s.userId}::uuid, 2, 2, true)`;
    await t.db.sql`
      insert into orbit.social_follows (platform, follower_id, followed_id, owner_user_id) values
        ('x', '100', '301', ${s.userId}::uuid), ('x', '301', '100', ${s.userId}::uuid), ('x', '100', '302', ${s.userId}::uuid)`;
    await keepAcceptsDms(t.db, s.userId, '301', true);
    await keepAcceptsDms(t.db, s.userId, '302', false);
    // an answer older than 30 days is not known any more
    await keepAcceptsDms(t.db, s.userId, '303', true, new Date(Date.now() - 31 * 86_400_000));
    const links = await pullLinks(call, s.token);
    const by = (id: string) => links.find((r) => r.accountId === id)!;
    expect(by('301')).toMatchObject({ username: 'mutual', followsYou: true, acceptsDms: true });
    expect(by('302')).toMatchObject({ followsYou: false, acceptsDms: false });
    expect(by('303')).toMatchObject({ followsYou: null, acceptsDms: null });
  });
});

describe('2. the pick after pick_person', () => {
  async function conflict() {
    const ig = new FakeInstagram('ig-me');
    const call = apiFor(ig);
    const s = await igStudent();
    const kim = await person(t.db, s.userId, 'Kim Lee', { known: true });
    const stored = await chatWith(s.userId, 'ig-kim', `chat-kim-${s.userId.slice(0, 6)}`, 'Kim Lee');
    const own = stored.partner!.personId!;
    // both have things of their own: a note on the account's person, a draft on Kim
    await t.db.sql`
      insert into orbit.notes (user_id, person_ids, source, occurred_at, raw_text)
      values (${s.userId}::uuid, ${[own]}::uuid[], 'manual', now(), 'met at the hackathon')`;
    const [d] = await t.db.sql<{ id: string }>`
      insert into orbit.drafts (user_id, person_id, channel, kind, body, status)
      values (${s.userId}::uuid, ${kim}::uuid, 'gmail', 'bump', 'Hi Kim', 'draft') returning id`;
    await t.db.sql`
      insert into orbit.social_match_asks (user_id, platform, account_id, person_id, score, signals)
      values (${s.userId}::uuid, 'instagram', 'ig-kim', ${kim}::uuid, 0.8, '{}'::jsonb)`;
    const asks = await call('GET', '/social/asks', s.token);
    const ask = asks.body.asks.find((a: { accountId: string }) => a.accountId === 'ig-kim');
    const yes = await call('POST', `/social/asks/${ask.id}`, s.token, { answer: 'yes' });
    expect(yes.status).toBe(409);
    expect(yes.body.error.code).toBe('pick_person');
    return { ...s, call, kim, own, draftId: d!.id, askId: ask.id as string };
  }

  it('keeps the account’s own person (as the question card sends it) and merges Kim into it', async () => {
    const c = await conflict();
    const r = await c.call('POST', '/social/links', c.token, {
      platform: 'instagram',
      accountId: 'ig-kim',
      personId: c.own,
      keep: c.own,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kept: c.own, merged: [c.kim], undoable: false });
    expect(r.body.linkId).toBeTruthy();
    expect(r.body.message).toBe('Merged into the one you kept. This cannot be undone.');
    expect(r.body.message).not.toMatch(/[!—]/);
    const [link] = await t.db.sql<{ person_id: string }>`
      select person_id from orbit.social_links where id = ${r.body.linkId}::uuid`;
    expect(link!.person_id).toBe(c.own);
    const [k] = await t.db.sql<{ merged_into: string; listed: boolean }>`
      select merged_into from orbit.people where id = ${c.kim}::uuid`;
    expect(k!.merged_into).toBe(c.own);
    const [kept] = await t.db.sql<{ listed: boolean; source_account: string | null; sources: string[] }>`
      select listed, source_account, sources from orbit.people where id = ${c.own}::uuid`;
    // known from LinkedIn now too: listed, and no longer a person made only from the account
    expect(kept).toMatchObject({ listed: true, source_account: null });
    expect(kept!.sources).toEqual(expect.arrayContaining(['instagram', 'linkedin']));
    const [d] = await t.db.sql<{ person_id: string }>`
      select person_id from orbit.drafts where id = ${c.draftId}::uuid`;
    expect(d!.person_id).toBe(c.own);
    const [ask] = await t.db.sql<{ status: string; person_id: string }>`
      select status, person_id from orbit.social_match_asks where id = ${c.askId}::uuid`;
    expect(ask).toEqual({ status: 'yes', person_id: c.own });
    const [audit] = await t.db.sql<{ actor: string; details: Record<string, unknown> }>`
      select actor, details from orbit.audit_log where user_id = ${c.userId}::uuid and action = 'people.merge'`;
    expect(audit).toMatchObject({ actor: 'user', details: { merged: c.kim, undoable: false } });
  });

  it('keeps Kim, the person the student named, and merges the account’s own person into her', async () => {
    const c = await conflict();
    const r = await c.call('POST', '/social/links', c.token, {
      platform: 'instagram',
      accountId: 'ig-kim',
      personId: c.kim,
      keep: c.kim,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kept: c.kim, merged: [c.own], undoable: false });
    const [o] = await t.db.sql<{
      merged_into: string;
    }>`select merged_into from orbit.people where id = ${c.own}::uuid`;
    expect(o!.merged_into).toBe(c.kim);
    const [note] = await t.db.sql<{ person_ids: string[] }>`
      select person_ids from orbit.notes where user_id = ${c.userId}::uuid`;
    expect(note!.person_ids).toEqual([c.kim]);
    const msgs = await t.db.sql<{
      direction: string;
      from_person_id: string | null;
      to_person_ids: string[];
    }>`
      select direction, from_person_id, to_person_ids from orbit.messages
       where user_id = ${c.userId}::uuid and social_account_id = 'ig-kim'`;
    expect(msgs.filter((m) => m.direction === 'in').every((m) => m.from_person_id === c.kim)).toBe(true);
    expect(msgs.filter((m) => m.direction === 'out').every((m) => m.to_person_ids.includes(c.kim))).toBe(
      true,
    );
    const [link] = await t.db.sql<{ person_id: string }>`
      select person_id from orbit.social_links where user_id = ${c.userId}::uuid and account_id = 'ig-kim'`;
    expect(link!.person_id).toBe(c.kim);
  });

  it('refuses a keep that is neither of the two people', async () => {
    const c = await conflict();
    const other = await person(t.db, c.userId, 'Someone Else');
    const r = await c.call('POST', '/social/links', c.token, {
      platform: 'instagram',
      accountId: 'ig-kim',
      personId: c.kim,
      keep: other,
    });
    expect(r.status).toBe(400);
    expect(
      await t.db
        .sql`select 1 from orbit.people where merged_into is not null and id = any(${[c.kim, c.own]}::uuid[])`,
    ).toHaveLength(0);
  });
});

describe('3. keeping the old Instagram account', () => {
  it('releases only the account just linked, goes back to the old one and clears the held state', async () => {
    const ig = new FakeInstagram('ig-new');
    ig.add({ id: 'ig-new', username: 'new.handle', name: 'Sam Rivera' });
    const call = apiFor(ig);
    const s = await igStudent('ig-old');
    const p = await person(t.db, s.userId, 'Old Friend');
    await attachAccount(t.db, s.userId, {
      platform: 'instagram',
      accountId: 'ig-oldfriend',
      personId: p,
      via: 'student',
      now: now(),
    });
    await t.db.sql`
      update orbit.integration_accounts set sync_state = ${{ instagram: { stage: 'refresh', syncedAt: new Date().toISOString() } }}::jsonb
       where user_id = ${s.userId}::uuid and provider = 'instagram'`;
    ig.unipileAccounts.set(s.account, { type: 'INSTAGRAM', name: s.userId });
    ig.unipileAccounts.set('acc-other', { type: 'INSTAGRAM', name: s.userId });
    // an account of the other product on the shared Unipile workspace
    ig.unipileAccounts.set('acc-not-orbit', { type: 'INSTAGRAM', name: 'someone-else' });

    const n = await webhook(`/unipile/account?token=${HOOK}&provider=instagram`, {
      status: 'CREATION_SUCCESS',
      account_id: 'acc-other',
      name: s.userId,
    });
    expect(n.body.result).toBe('connected');
    await drain(
      t,
      {
        ...socialHandlers({
          fetch: ig.fetch,
          unipile: { apiKey: UNIPILE_KEY, baseUrl: ig.base },
          random: () => 0.5,
          offered: ['instagram'],
        }),
        'score.person': noop,
        friend_shares_refresh: noop,
      },
      now,
      { maxTicks: 2 },
    );
    const held = await call('GET', '/instagram/status', s.token);
    expect(held.body).toMatchObject({ status: 'different_account', username: 'new.handle' });

    const r = await call('POST', '/instagram/connect/keep', s.token, {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(ig.deleted).toEqual(['acc-other']);
    expect(ig.unipileAccounts.has(s.account)).toBe(true);
    expect(ig.unipileAccounts.has('acc-not-orbit')).toBe(true);
    const [row] = await t.db.sql<{
      status: string;
      external_account_id: string;
      social_account_id: string;
      last_error: string | null;
      state: Record<string, unknown>;
    }>`
      select status, external_account_id, social_account_id, last_error, sync_state -> 'instagram' as state
        from orbit.integration_accounts where user_id = ${s.userId}::uuid and provider = 'instagram'`;
    expect(row).toMatchObject({
      status: 'active',
      external_account_id: s.account,
      social_account_id: 'ig-old',
      last_error: null,
    });
    expect(row!.state).toMatchObject({
      pending: null,
      replace: false,
      previousAccountId: null,
      stage: 'refresh',
    });
    // what the old account brought is all there
    expect(await t.db.sql`select 1 from orbit.social_links where user_id = ${s.userId}::uuid`).toHaveLength(
      1,
    );
    const st = await call('GET', '/instagram/status', s.token);
    expect(st.body.status).toBe('active');

    const again = await call('POST', '/instagram/connect/keep', s.token, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('nothing_held');
  });

  it('never releases an account Unipile does not name as this student’s Instagram', async () => {
    const ig = new FakeInstagram('ig-new');
    const call = apiFor(ig);
    const s = await igStudent('ig-old');
    await t.db.sql`
      update orbit.integration_accounts
         set external_account_id = 'acc-shared', status = 'error', last_error = 'different_account',
             sync_state = ${{ instagram: { pending: { socialAccountId: 'ig-new', username: 'new' }, previousAccountId: s.account } }}::jsonb
       where user_id = ${s.userId}::uuid and provider = 'instagram'`;
    ig.unipileAccounts.set('acc-shared', { type: 'LINKEDIN', name: s.userId });
    const r = await call('POST', '/instagram/connect/keep', s.token, {});
    expect(r.status).toBe(200);
    expect(ig.deleted).toEqual([]);
    const [row] = await t.db.sql<{ external_account_id: string; status: string }>`
      select external_account_id, status from orbit.integration_accounts where user_id = ${s.userId}::uuid and provider = 'instagram'`;
    expect(row).toEqual({ external_account_id: s.account, status: 'active' });
  });
});

describe('4. sending from the draft box', () => {
  /** A draft as the browser holds it, approved through the route with the student's words and tap. */
  async function draft(userId: string, personId: string, channel: 'instagram' | 'x', body = 'Hi there') {
    const [d] = await t.db.sql<{ id: string }>`
      insert into orbit.drafts (user_id, person_id, channel, kind, body, status)
      values (${userId}::uuid, ${personId}::uuid, ${channel}, 'bump', ${body}, 'draft') returning id`;
    return d!.id;
  }

  /** A draft approved and tapped long enough ago that the confirm is stale. */
  async function staleTap(userId: string, personId: string, channel: 'instagram' | 'x') {
    const body = 'Hi, one question from earlier today?';
    const [d] = await t.db.sql<{ id: string }>`
      insert into orbit.drafts (user_id, person_id, channel, kind, body, status, send_at)
      values (${userId}::uuid, ${personId}::uuid, ${channel}, 'bump', ${body}, 'approved', now()) returning id`;
    const hash = messageHash({ channel: channel as never, subject: null, body });
    for (const action of ['draft.approve', 'draft.confirm'])
      await t.db.sql`
        insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details, created_at)
        values (${userId}::uuid, 'user', ${action}, 'drafts', ${d!.id}, ${{ hash }}::jsonb, now() - interval '16 minutes')`;
    return d!.id;
  }

  it('Instagram: a tap sends the edited words, writes the touch, and a stale confirm or the cap holds it', async () => {
    const ig = new FakeInstagram('ig-me');
    ig.add({ id: 'ig-pat', username: 'pat.ng', name: 'Pat Ng' });
    const x = new FakeX();
    const call = apiFor(ig, x);
    const s = await igStudent('ig-me', { daily_send_cap_instagram: 1 });
    const pat = await person(t.db, s.userId, 'Pat Ng');
    await attachAccount(t.db, s.userId, {
      platform: 'instagram',
      accountId: 'ig-pat',
      personId: pat,
      via: 'student',
      now: now(),
    });
    const stale = await staleTap(s.userId, pat, 'instagram');
    expect(await sendDraft(services(ig, x), stale)).toEqual({
      status: 'held',
      reason: 'instagram_needs_fresh_approval',
    });
    expect(ig.sent).toHaveLength(0);

    const id = await draft(s.userId, pat, 'instagram');
    const body = 'Hi Pat, loved the climate hackathon post. Could I ask you two questions about it?';
    const noTap = await call('POST', '/drafts/approve', s.token, { draftId: id, body });
    expect(noTap.body.error.code).toBe('needs_confirmation');
    const tap = await call('POST', '/drafts/approve', s.token, { draftId: id, body, confirm: true });
    expect(tap.status).toBe(200);
    expect(tap.body.draft).toMatchObject({ status: 'sent', channel: 'instagram', body });
    expect(ig.sent).toEqual([{ accountId: 'ig-pat', text: body }]);
    const [m] = await t.db.sql<{ direction: string; body_text: string; to_person_ids: string[] }>`
      select direction, body_text, to_person_ids from orbit.messages where user_id = ${s.userId}::uuid and provider = 'instagram'`;
    expect(m).toEqual({ direction: 'out', body_text: body, to_person_ids: [pat] });
    const [confirm] = await t.db.sql<{ hash: string }>`
      select details->>'hash' as hash from orbit.audit_log
       where user_id = ${s.userId}::uuid and action = 'draft.confirm' and target_id = ${id}`;
    expect(confirm!.hash).toBe(messageHash({ channel: 'instagram' as never, subject: null, body }));

    // the student's own cap (1 a day here): the next one waits as a draft
    const next = await draft(s.userId, pat, 'instagram', 'Hi Pat, one more thing about the hackathon.');
    const capped = await call('POST', '/drafts/approve', s.token, { draftId: next, confirm: true });
    expect(capped.body.draft).toMatchObject({ status: 'draft', error: 'instagram_daily_cap' });
    expect(ig.sent).toHaveLength(1);
  });

  it('X: a tap sends after X says they accept it, writes the touch, keeps acceptsDms, and the cap holds the next', async () => {
    const ig = new FakeInstagram('ig-me');
    const x = new FakeX();
    x.addUser({ id: '700', username: 'stu', name: 'Stu Dent' });
    x.addUser({ id: '701', username: 'jo_r', name: 'Jo Ray', openDms: true });
    const call = apiFor(ig, x);
    const s = await signedInUser(t, { settings: { daily_send_cap_x: 1 } });
    await withX(x, s.userId, '700');
    const jo = await person(t.db, s.userId, 'Jo Ray');
    await t.db.sql`
      insert into orbit.social_accounts (platform, account_id, username, name) values ('x', '701', 'jo_r', 'Jo Ray')
      on conflict do nothing`;
    await attachAccount(t.db, s.userId, {
      platform: 'x',
      accountId: '701',
      personId: jo,
      via: 'proof',
      proof: 'links_back',
      now: now(),
    });
    const stale = await staleTap(s.userId, jo, 'x');
    expect(await sendDraft(services(ig, x), stale)).toEqual({
      status: 'held',
      reason: 'x_needs_fresh_approval',
    });
    expect(x.paths('/messages')).toHaveLength(0);

    const id = await draft(s.userId, jo, 'x');
    const body = 'Hi Jo, could I ask you about your time at Linear?';
    const noTap = await call('POST', '/drafts/approve', s.token, { draftId: id, body });
    expect(noTap.body.error.code).toBe('needs_confirmation');
    const tap = await call('POST', '/drafts/approve', s.token, { draftId: id, body, confirm: true });
    expect(tap.status).toBe(200);
    expect(tap.body.draft).toMatchObject({ status: 'sent', channel: 'x', body });
    expect(x.paths('/messages')).toEqual(['POST /2/dm_conversations/with/701/messages']);
    const [m] = await t.db.sql<{ direction: string; body_text: string; to_person_ids: string[] }>`
      select direction, body_text, to_person_ids from orbit.messages where user_id = ${s.userId}::uuid and provider = 'x'`;
    expect(m).toEqual({ direction: 'out', body_text: body, to_person_ids: [jo] });
    // the profile read before the send said they accept messages: the browser is told
    const links = await pullLinks(call, s.token);
    expect(links.find((l) => l.accountId === '701')).toMatchObject({ acceptsDms: true, username: 'jo_r' });

    const next = await draft(s.userId, jo, 'x', 'Hi Jo, one more question about Linear.');
    const capped = await call('POST', '/drafts/approve', s.token, { draftId: next, confirm: true });
    expect(capped.body.draft).toMatchObject({ status: 'draft', error: 'x_daily_cap' });
    expect(x.paths('/messages')).toHaveLength(1);
  });
});

describe('5. the evidence in plain lines', () => {
  it('a question carries for and against in words, beside the raw signals', async () => {
    const s = await igStudent();
    const maya = await person(t.db, s.userId, 'Maya Lopez', { known: true, org: 'Stripe' });
    const r = await matchAccount(
      t.db,
      s.userId,
      {
        platform: 'instagram',
        id: 'ig-maya-l',
        username: 'maya.lopez',
        name: 'Maya Lopez',
        bio: 'PM @stripe',
        following: 4000,
      },
      { now: now() },
    );
    expect(r).toMatchObject({ kind: 'asked', personId: maya });
    const [ask] = await t.db.sql<{
      signals: { name: number; employer: number; for: string[]; against: string[] };
    }>`
      select signals from orbit.social_match_asks where user_id = ${s.userId}::uuid and account_id = 'ig-maya-l'`;
    expect(ask!.signals.name).toBe(1);
    expect(ask!.signals.employer).toBe(1);
    expect(ask!.signals.for).toEqual([
      'The name on the account is Maya Lopez',
      'The handle @maya.lopez spells their name',
      'Their bio names Stripe',
    ]);
    expect(ask!.signals.against).toEqual(['The account follows 4,000 people']);
    for (const line of [...ask!.signals.for, ...ask!.signals.against]) expect(line).not.toMatch(/[!—]/);
    // the browser reads the lines from GET /social/asks as they are
    const call = apiFor(new FakeInstagram('ig-me'));
    const asks = await call('GET', '/social/asks', s.token);
    const a = asks.body.asks.find((x: { accountId: string }) => x.accountId === 'ig-maya-l');
    expect(a.signals.for).toContain('Their bio names Stripe');
  });

  it('names the shared link, a public figure, and another handle already attached', () => {
    const lines = askLines(
      {
        platform: 'instagram',
        id: 'ig-1',
        username: 'mo.okafor',
        name: 'Maya Okafor',
        links: ['https://www.mayaokafor.com/'],
        followers: 52_000,
      },
      {
        person: { id: 'p', displayName: 'Maya Okafor', firstName: 'Maya', lastName: 'Okafor', emails: [] },
        links: ['mayaokafor.com'],
        knownToStudent: true,
        otherHandles: ['maya.ok'],
      },
      { name: 1, same_link: 1, other_handle: 1 },
    );
    expect(lines.for).toEqual(['The name on the account is Maya Okafor', 'Both link to mayaokafor.com']);
    expect(lines.against).toEqual([
      'They already have another Instagram account attached, @maya.ok',
      'The account has 52,000 followers',
    ]);
  });
});
