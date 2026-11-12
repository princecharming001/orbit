/**
 * Plan 43 §5 on the server, against a fake X with a known graph and DM history: the adapter's mapping, spending by
 * money with both limits and the quote, lists read to the end or not at all, 30-day expiry and deletion on request,
 * DM polling and its cadence, sending, and matching by public proof only.
 */
import type { SocialCandidate } from '@orbit/core/entity/social';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sqlQueue } from '../../functions/_shared/queue.ts';
import { SocialBudgetSpent } from '../../functions/_shared/social/adapter.ts';
import {
  createXAdapter,
  mapXUser,
  type XBudget,
  type XUser,
} from '../../functions/_shared/social/x/adapter.ts';
import { type XClient, xAdapterFor } from '../../functions/_shared/social/x/client.ts';
import type { XConfig } from '../../functions/_shared/social/x/config.ts';
import { enqueueDueXDms, pollXDms, type XDmWriter, xDmsDue } from '../../functions/_shared/social/x/dms.ts';
import {
  expireX,
  forgetXAccount,
  heldXList,
  readXListToEnd,
  readXProfile,
  upsertXAccount,
} from '../../functions/_shared/social/x/lists.ts';
import {
  matchXAccount,
  matchXTarget,
  X_PRIVATE_PROOF_ALLOWED,
} from '../../functions/_shared/social/x/match.ts';
import { loadXState, saveXState, storeXTokens } from '../../functions/_shared/social/x/oauth.ts';
import { sendXMessage } from '../../functions/_shared/social/x/send.ts';
import { quoteXCheck, xSpend, xSpendThisMonth } from '../../functions/_shared/social/x/spend.ts';
import { sqlVault } from '../../functions/_shared/vault.ts';
import { JobSkipped } from '../../functions/orbit-worker/handlers/deps.ts';
import { defaultHandlers, type Job, type JobContext } from '../../functions/orbit-worker/worker.ts';
import { FAKE_X_CLIENT_ID, FAKE_X_CLIENT_SECRET, FakeX } from '../helpers/fakeX.ts';
import { freshDb, makeUser, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});
// the shared graph is shared across students: each test starts it empty
beforeEach(async () => {
  await t.db.sql`delete from orbit.social_follows`;
  await t.db.sql`delete from orbit.social_list_reads`;
  await t.db.sql`delete from orbit.social_accounts`;
  await t.db.sql`delete from orbit.social_suppressed`;
});

const NOW = new Date('2026-11-12T12:00:00Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;

const cfg = (over: Partial<XConfig> = {}): XConfig => ({
  clientId: FAKE_X_CLIENT_ID,
  clientSecret: FAKE_X_CLIENT_SECRET,
  studentMonthlyUsd: 15,
  orbitMonthlyUsd: 500,
  listLimit: 600,
  offered: true,
  ...over,
});

const S = '100'; // the student
const T = '200'; // the target
const B1 = '301'; // follows each other with the student and with the target: a bridge
const B2 = '302'; // follows each other with the student; follows the target, who does not follow back
const C = '303'; // follows each other with the student; nothing to do with the target

/** The known graph: the student's circle, the target's two lists (7 following, 17 followers). */
function world(): FakeX {
  const x = new FakeX();
  x.addUser({ id: S, username: 'maya_c', name: 'Maya Chen' });
  x.addUser({
    id: T,
    username: 'priya',
    name: 'Priya Rao',
    description: 'Design at Linear. linkedin.com/in/priya-rao',
    url: 'https://priya.design',
    links: ['https://linkedin.com/in/priya-rao'],
    location: 'San Francisco',
  });
  x.addUser({ id: B1, username: 'jchen', name: 'Jason Chen' });
  x.addUser({ id: B2, username: 'sam_k', name: 'Sam Kim' });
  x.addUser({ id: C, username: 'lee_w', name: 'Lee Wong' });
  for (const id of [B1, B2, C]) x.mutual(S, id);
  x.mutual(B1, T);
  x.follow(B2, T);
  for (let i = 0; i < 15; i++) {
    const id = String(400 + i);
    x.addUser({ id, username: `fan${i}`, name: `Fan ${i}` });
    x.follow(id, T);
    if (i < 6) x.follow(T, id);
  }
  return x;
}

/** A student with X connected as `xId`, tokens in Vault, consent given, X on. */
async function connected(fake: FakeX, xId = S, at = NOW): Promise<string> {
  const userId = await makeUser(t.db);
  const tok = fake.issue(xId);
  const s = await storeXTokens(
    sqlVault(t.db),
    userId,
    { access_token: tok.access, refresh_token: tok.refresh, expires_in: 7200 },
    at,
  );
  const x = {
    username: fake.users.get(xId)!.username,
    accessSecretId: s.accessSecretId,
    accessExpiresAt: s.accessExpiresAt,
    consent: { version: 'test', at: at.toISOString() },
  };
  await t.db.sql`
    insert into orbit.integration_accounts (user_id, provider, status, social_account_id, token_secret_id, sync_state)
    values (${userId}::uuid, 'x', 'active', ${xId}, ${s.refreshSecretId}::uuid, ${{ x }}::jsonb)`;
  await t.db
    .sql`insert into orbit.source_states (user_id, source, state) values (${userId}::uuid, 'x', 'on')`;
  return userId;
}

async function client(
  fake: FakeX,
  userId: string,
  over: Partial<XConfig> = {},
  opts: { caller?: string; ceilingUsd?: number; now?: Date } = {},
): Promise<XClient> {
  const at = opts.now ?? NOW;
  return (await xAdapterFor(
    t.db,
    userId,
    { cfg: cfg(over), fetch: fake.fetch, now: () => at },
    { caller: opts.caller, ceilingUsd: opts.ceilingUsd },
  ))!;
}

const ledger = async (userId: string) =>
  t.db.sql<{ operation: string; units: string; cost: string }>`
    select operation, units::text as units, cost_usd::text as cost from orbit.usage_ledger
     where user_id = ${userId}::uuid and provider = 'x' order by id`;
const ledgerUsd = async (userId: string) => {
  const [r] = await t.db.sql<{ usd: string }>`
    select coalesce(sum(cost_usd), 0)::text as usd from orbit.usage_ledger where user_id = ${userId}::uuid and provider = 'x'`;
  return Number(r!.usd);
};
const callsOf = async (userId: string) => {
  const [r] = await t.db.sql<{ made: number; refused: number; usd: string }>`
    select coalesce(sum(made), 0)::int as made, coalesce(sum(refused), 0)::int as refused,
           coalesce(sum(cost_usd), 0)::text as usd
      from orbit.social_calls where platform = 'x' and account = ${userId}`;
  return { made: r!.made, refused: r!.refused, usd: Number(r!.usd) };
};
const cents = (n: number) => Math.round(n * 1000) / 1000;

// ---- the adapter -------------------------------------------------------------------------------------------------

describe('the X adapter', () => {
  it('maps a user to a SocialAccount and reads the relation, by id or by handle', async () => {
    const fake = world();
    const userId = await connected(fake);
    const { adapter } = await client(fake, userId);
    const byId = await adapter.profile(T);
    const byName = await adapter.profile('@Priya');
    expect(byName.account).toEqual(byId.account);
    expect(byId.account).toEqual({
      platform: 'x',
      id: T,
      username: 'priya',
      name: 'Priya Rao',
      bio: 'Design at Linear. linkedin.com/in/priya-rao',
      links: ['https://priya.design', 'https://linkedin.com/in/priya-rao'],
      followers: 17,
      following: 7,
      verified: false,
      isPrivate: false,
      defaultPicture: false,
    });
    expect(byId.relation).toEqual({ following: false, followedBy: false });
    expect(byId.receivesYourDm).toBe(false);
    expect(byId.location).toBe('San Francisco');
    const b1 = await adapter.profile(B1);
    expect(b1.relation).toEqual({ following: true, followedBy: true });
    expect(b1.receivesYourDm).toBe(true);
    expect((await adapter.me()).account.id).toBe(S);
    // X matching is by public proof only: there is no search
    expect(adapter.search).toBeUndefined();
    const raw: XUser = { id: '9', username: 'p', protected: true, verified: true, public_metrics: {} };
    expect(mapXUser(raw)).toEqual({ platform: 'x', id: '9', username: 'p', verified: true, isPrivate: true });
  });

  it('reads a list page with each account s relation to the student, and pages on', async () => {
    const fake = world();
    fake.listPageCap = 2;
    const userId = await connected(fake);
    const { adapter } = await client(fake, userId);
    const p1 = await adapter.listPage(S, 'following', undefined, 2);
    expect(p1.ids).toEqual([B1, B2]);
    expect(p1.relations).toEqual({
      [B1]: { following: true, followedBy: true },
      [B2]: { following: true, followedBy: true },
    });
    expect(p1.accounts!.map((a) => a.username)).toEqual(['jchen', 'sam_k']);
    expect(p1.cursor).toBeDefined();
    const p2 = await adapter.listPage(S, 'following', p1.cursor, 2);
    expect(p2.ids).toEqual([C]);
    expect(p2.cursor).toBeUndefined();
    expect(adapter.pageSize('followers')).toBe(1000);
    const q = fake.calls.find((c) => c.path === `/2/users/${S}/following`)!.query;
    expect(q['user.fields']).toContain('connection_status');
    expect(q.max_results).toBe('2');
  });

  it('builds chats and messages from DM events: one to one, groups, words', async () => {
    const fake = world();
    const userId = await connected(fake);
    const one = FakeX.pair(S, B1);
    fake.dm({
      dm_conversation_id: one,
      sender_id: B1,
      text: 'hey, coffee next week?',
      created_at: '2026-11-10T10:00:00Z',
    });
    fake.dm({ dm_conversation_id: one, sender_id: S, text: 'yes', created_at: '2026-11-10T11:00:00Z' });
    fake.dm({ dm_conversation_id: one, sender_id: B1, text: '', created_at: '2026-11-10T12:00:00Z' });
    fake.dm({
      dm_conversation_id: '9001',
      event_type: 'ParticipantsJoin',
      participant_ids: [S, B2, C],
      created_at: '2026-11-11T09:00:00Z',
    });
    fake.dm({
      dm_conversation_id: '9001',
      sender_id: C,
      text: 'group plans',
      created_at: '2026-11-11T10:00:00Z',
    });
    const { adapter } = await client(fake, userId);
    const chats = await adapter.chats();
    const byId = Object.fromEntries(chats.items.map((c) => [c.chatId, c]));
    expect(byId[one]).toEqual({
      chatId: one,
      participants: 2,
      others: [{ accountId: B1 }],
      lastAt: '2026-11-10T12:00:00Z',
    });
    expect(byId['9001']!.participants).toBe(3);
    expect(byId['9001']!.others.map((o) => o.accountId).sort()).toEqual([B2, C]);
    const msgs = await adapter.messages(one);
    expect(msgs.items.map((m) => [m.text, m.fromStudent, m.hasWords, m.senderAccountId])).toEqual([
      ['', false, false, B1],
      ['yes', true, true, S],
      ['hey, coffee next week?', false, true, B1],
    ]);
    expect(fake.paths(`/2/dm_conversations/with/${B1}/dm_events`)).toHaveLength(1);
    const group = await adapter.messages('9001');
    expect(group.items.map((m) => m.text)).toEqual(['group plans']);
    // no user expansions are asked for: nothing comes back that was not priced
    expect(fake.calls.every((c) => !c.query.expansions)).toBe(true);
  });
});

// ---- spending ----------------------------------------------------------------------------------------------------

describe('spending', () => {
  it('Orbit s default limit of 0 blocks every read before it is made', async () => {
    const fake = world();
    const userId = await connected(fake);
    const { adapter } = await client(fake, userId, { orbitMonthlyUsd: 0 });
    await expect(adapter.profile(T)).rejects.toBeInstanceOf(SocialBudgetSpent);
    await expect(adapter.listPage(T, 'following')).rejects.toBeInstanceOf(SocialBudgetSpent);
    await expect(adapter.dmEvents()).rejects.toBeInstanceOf(SocialBudgetSpent);
    expect(fake.calls.filter((c) => c.path.startsWith('/2/') && !c.path.includes('oauth2'))).toHaveLength(0);
    expect(await ledger(userId)).toEqual([]);
    expect(await callsOf(userId)).toEqual({ made: 0, refused: 3, usd: 0 });
  });

  it('the student s monthly limit stops the call that would pass it, before it is made', async () => {
    const fake = world();
    const userId = await connected(fake);
    const { adapter } = await client(fake, userId, { studentMonthlyUsd: 0.03 });
    for (const id of [T, B1, B2]) await adapter.profile(id);
    await expect(adapter.profile(C)).rejects.toBeInstanceOf(SocialBudgetSpent);
    expect(fake.paths('/2/users/')).toHaveLength(3);
    // a list page priced for 1000 users would pass it too
    await expect(adapter.listPage(T, 'following')).rejects.toBeInstanceOf(SocialBudgetSpent);
    expect((await xSpendThisMonth(t.db, userId, NOW)).studentUsd).toBe(0.03);
    expect(await callsOf(userId)).toEqual({ made: 3, refused: 2, usd: 0.03 });
  });

  it('Orbit s monthly limit holds across students, and a new month starts again', async () => {
    const fake = world();
    const march = new Date('2027-03-10T12:00:00Z');
    const a = await connected(fake, S, march);
    const b = await connected(fake, B1, march);
    const over = { orbitMonthlyUsd: 0.03 };
    const ca = await client(fake, a, over, { now: march });
    const cb = await client(fake, b, over, { now: march });
    await ca.adapter.profile(T);
    await ca.adapter.profile(B2);
    await cb.adapter.profile(T);
    await expect(cb.adapter.profile(C)).rejects.toBeInstanceOf(SocialBudgetSpent);
    await expect(ca.adapter.profile(C)).rejects.toBeInstanceOf(SocialBudgetSpent);
    expect((await xSpendThisMonth(t.db, a, march)).orbitUsd).toBe(0.03);
    const april = new Date('2027-04-01T00:05:00Z');
    const next = await client(fake, a, over, { now: april });
    await next.adapter.profile(C);
    expect((await xSpendThisMonth(t.db, a, april)).studentUsd).toBe(0.01);
  });

  it('a list page is charged for max_results and the difference refunded; every cent is recorded', async () => {
    const fake = world();
    const userId = await connected(fake);
    const { adapter, spend } = await client(fake, userId);
    const page = await adapter.listPage(T, 'following', undefined, 50);
    expect(page.ids).toHaveLength(7);
    expect(await ledger(userId)).toEqual([{ operation: 'list', units: '7', cost: '0.07000' }]);
    expect(spend.chargedUsd()).toBe(0.07);
    // and the rest: a profile, DM events, a send
    fake.dm({
      dm_conversation_id: FakeX.pair(S, B1),
      sender_id: B1,
      text: 'hi',
      created_at: '2026-11-11T10:00:00Z',
    });
    await adapter.profile(B1);
    await adapter.dmEvents({ maxResults: 20 });
    await adapter.send({ accountId: B1 }, 'hello');
    const usd = await ledgerUsd(userId);
    expect(cents(usd)).toBe(cents(fake.billedUsd));
    expect(cents(usd)).toBe(cents(0.07 + 0.01 + 0.01 + 0.015));
    expect(cents((await callsOf(userId)).usd)).toBe(cents(usd));
    // a call X refused is not charged
    await expect(adapter.send({ accountId: '401' }, 'hello')).rejects.toThrow();
    expect(cents(await ledgerUsd(userId))).toBe(cents(usd));
  });

  it('a search is never made', async () => {
    const fake = world();
    const userId = await connected(fake);
    const budget = xSpend(t.db, { userId, limits: cfg(), now: () => NOW });
    expect(await budget.spend('search')).toBe(false);
    expect(await budget.spend('profile')).toBe(true);
  });
});

// ---- lists, the quote and the check --------------------------------------------------------------------------------

describe('lists to the end or not at all, and the quote', () => {
  it('quotes a check, and the check run under the quote never charges more', async () => {
    const fake = world();
    const userId = await connected(fake);
    // the student's own list first: the circle (B1, B2, C), and who follows back from connection_status
    const own = await client(fake, userId, {}, { caller: 'own' });
    const mine = await readXListToEnd(t.db, own.adapter, {
      accountId: S,
      list: 'following',
      limit: 600,
      ownerUserId: userId,
      readBy: userId,
      meId: S,
      now: () => NOW,
    });
    expect(mine.ok && mine.ids.sort()).toEqual([B1, B2, C]);
    expect(fake.paths(`/2/users/${S}/followers`)).toHaveLength(0);
    const back = await t.db.sql`
      select 1 from orbit.social_follows where platform = 'x' and owner_user_id = ${userId}::uuid and followed_id = ${S}`;
    expect(back).toHaveLength(3);

    const quote = await quoteXCheck(t.db, userId, '@priya', {
      cfg: cfg(),
      fetch: fake.fetch,
      now: () => NOW,
    });
    // following (7) is shorter: 17 users priced; confirming via the target's followers (17 + 10) beats the circle's lists
    expect(quote).toMatchObject({
      list: 'following',
      size: 7,
      targetAccountId: T,
      quoteUsd: 0.44,
      confirmUsd: 0.27,
    });

    const check = await client(fake, userId, {}, { caller: 'check', ceilingUsd: quote.quoteUsd });
    const first = await readXListToEnd(t.db, check.adapter, {
      accountId: T,
      list: quote.list!,
      size: quote.size,
      limit: 600,
      readBy: userId,
      now: () => NOW,
    });
    const second = await readXListToEnd(t.db, check.adapter, {
      accountId: T,
      list: 'followers',
      size: 17,
      limit: 600,
      readBy: userId,
      now: () => NOW,
    });
    expect(first.ok && second.ok).toBe(true);
    expect(check.spend.chargedUsd()).toBe(0.24);
    expect(check.spend.chargedUsd()).toBeLessThanOrEqual(quote.quoteUsd);
    // B1 follows the target and the target follows B1: the bridge
    const tf = new Set(first.ok ? first.ids : []);
    const fol = new Set(second.ok ? second.ids : []);
    expect([B1, B2, C].filter((id) => tf.has(id) && fol.has(id))).toEqual([B1]);

    // a second student asking about the same target this month pays nothing for the lists
    const other = await connected(fake, C);
    const again = await quoteXCheck(t.db, other, T, { cfg: cfg(), fetch: fake.fetch, now: () => NOW });
    expect(again).toMatchObject({ quoteUsd: 0, list: null, reason: 'held' });
  });

  it('stops a check at its quote before the call that would pass it', async () => {
    const fake = world();
    const userId = await connected(fake);
    const check = await client(fake, userId, {}, { ceilingUsd: 0.1 });
    const r = await readXListToEnd(t.db, check.adapter, {
      accountId: B1,
      list: 'followers',
      size: 2,
      limit: 600,
      readBy: userId,
      now: () => NOW,
    });
    expect(r.ok).toBe(false);
    expect(fake.paths('/followers')).toHaveLength(0);
    expect(check.spend.chargedUsd()).toBe(0);
  });

  it('refuses a list over the limit before spending anything on it', async () => {
    const fake = world();
    const userId = await connected(fake);
    const q = await quoteXCheck(t.db, userId, T, {
      cfg: cfg({ listLimit: 5 }),
      fetch: fake.fetch,
      now: () => NOW,
    });
    expect(q).toMatchObject({ quoteUsd: 0, list: null, size: 7, reason: 'too_big' });
    const { adapter } = await client(fake, userId);
    const r = await readXListToEnd(t.db, adapter, {
      accountId: T,
      list: 'followers',
      limit: 5,
      readBy: userId,
      now: () => NOW,
    });
    expect(r).toEqual({ ok: false, reason: 'too_big', size: 17 });
    expect(fake.paths(`/2/users/${T}/f`)).toHaveLength(0);
    // the two profile reads are all that was charged
    expect(await ledgerUsd(userId)).toBe(0.02);
  });

  it('never stores a partial list', async () => {
    const fake = world();
    fake.listPageCap = 5;
    const userId = await connected(fake);
    const c = await client(fake, userId);
    // the budget runs out after the first page of the target's followers
    let pages = 0;
    const budget: XBudget = {
      ...c.spend,
      reserve: async (kind, units) =>
        kind === 'list' && ++pages > 1 ? undefined : c.spend.reserve(kind, units),
    };
    const adapter = createXAdapter({ tokens: c.tokens, budget, meId: S, fetch: fake.fetch });
    const partial = await readXListToEnd(t.db, adapter, {
      accountId: T,
      list: 'followers',
      size: 17,
      limit: 600,
      readBy: userId,
      now: () => NOW,
    });
    expect(partial).toEqual({ ok: false, reason: 'budget' });
    expect(fake.paths(`/2/users/${T}/followers`)).toHaveLength(1);
    const stored = async () => [
      ...(await t.db.sql`select 1 from orbit.social_follows where platform = 'x' and followed_id = ${T}`),
      ...(await t.db.sql`select 1 from orbit.social_list_reads where platform = 'x' and account_id = ${T}`),
    ];
    expect(await stored()).toHaveLength(0);
    expect(await heldXList(t.db, T, 'followers', userId, NOW)).toBeUndefined();

    // a list that grew past what it was priced for (2 on the profile, 17 now) is dropped too
    const grown = await readXListToEnd(t.db, c.adapter, {
      accountId: T,
      list: 'followers',
      size: 2,
      limit: 600,
      readBy: userId,
      now: () => NOW,
    });
    expect(grown).toMatchObject({ ok: false, reason: 'too_big' });
    expect(await stored()).toHaveLength(0);
    // and what it cost stayed within the 2 + 10 users it was priced for
    // (5 on the first page, then 12 on the grown read)
    expect(cents(await ledgerUsd(userId))).toBeLessThanOrEqual(0.17);
  });
});

// ---- keeping current ---------------------------------------------------------------------------------------------

describe('keeping X data current', () => {
  async function stored(fake: FakeX) {
    const userId = await connected(fake);
    const { adapter } = await client(fake, userId);
    await upsertXAccount(t.db, (await adapter.profile(B1)).account, NOW);
    const r = await readXListToEnd(t.db, adapter, {
      accountId: B1,
      list: 'following',
      limit: 600,
      readBy: userId,
      now: () => NOW,
    });
    expect(r.ok).toBe(true);
    return { userId, adapter };
  }
  const held = async (id: string) => {
    const [r] = await t.db.sql<{ a: number; f: number; l: number }>`
      select (select count(*) from orbit.social_accounts where platform = 'x' and account_id = ${id})::int as a,
             (select count(*) from orbit.social_follows where platform = 'x' and (follower_id = ${id} or followed_id = ${id}))::int as f,
             (select count(*) from orbit.social_list_reads where platform = 'x' and account_id = ${id})::int as l`;
    return r!;
  };

  it('deletes X rows 30 days after they were read', async () => {
    const fake = world();
    await stored(fake);
    expect(await held(B1)).toMatchObject({ a: 1, l: 1 });
    expect(await expireX(t.db, new Date(NOW.getTime() + 29 * DAY))).toEqual({
      follows: 0,
      lists: 0,
      accounts: 0,
    });
    const gone = await expireX(t.db, new Date(NOW.getTime() + 31 * DAY));
    expect(gone.lists).toBeGreaterThan(0);
    expect(await held(B1)).toEqual({ a: 0, f: 0, l: 0 });
  });

  it('drops an account that went protected, and one suspended, when next seen', async () => {
    const fake = world();
    const { userId, adapter } = await stored(fake);
    fake.users.get(B1)!.protected = true;
    const p = await readXProfile(t.db, adapter, B1);
    expect(p.ok && p.profile.account.isPrivate).toBe(true);
    expect(await held(B1)).toMatchObject({ a: 0, l: 0 });
    // and its lists are never read again
    const r = await readXListToEnd(t.db, adapter, {
      accountId: B1,
      list: 'followers',
      limit: 600,
      readBy: userId,
    });
    expect(r).toEqual({ ok: false, reason: 'protected' });
    expect(fake.paths(`/2/users/${B1}/followers`)).toHaveLength(0);

    await upsertXAccount(t.db, (await adapter.profile(C)).account, NOW);
    fake.users.get(C)!.suspended = true;
    expect(await readXProfile(t.db, adapter, C)).toEqual({ ok: false, reason: 'gone' });
    expect(await held(C)).toEqual({ a: 0, f: 0, l: 0 });
  });

  it('forgetXAccount deletes everything about an account and keeps it out', async () => {
    const fake = world();
    const { userId, adapter } = await stored(fake);
    const [p] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm, source_account)
      values (${userId}::uuid, 'Jason Chen', 'jason chen', ${`x:${B1}`}) returning id`;
    await t.db.sql`
      insert into orbit.social_links (user_id, platform, account_id, person_id, via, proof)
      values (${userId}::uuid, 'x', ${B1}, ${p!.id}::uuid, 'proof', 'own_links')`;
    await t.db.sql`
      insert into orbit.person_identities (user_id, person_id, kind, value_norm, source)
      values (${userId}::uuid, ${p!.id}::uuid, 'x_id', ${B1}, 'x')`;
    const [th] = await t.db.sql<{ id: string }>`
      insert into orbit.threads (user_id, provider, external_id, social_account_id)
      values (${userId}::uuid, 'x', ${FakeX.pair(S, B1)}, ${B1}) returning id`;
    await t.db.sql`
      insert into orbit.messages (user_id, thread_id, provider, external_id, direction, sent_at, social_account_id, has_words)
      values (${userId}::uuid, ${th!.id}::uuid, 'x', 'e1', 'in', now(), ${B1}, true)`;
    await forgetXAccount(t.db, B1);
    expect(await held(B1)).toEqual({ a: 0, f: 0, l: 0 });
    for (const q of [
      t.db.sql`select 1 from orbit.social_links where account_id = ${B1}`,
      t.db.sql`select 1 from orbit.person_identities where kind = 'x_id' and value_norm = ${B1}`,
      t.db.sql`select 1 from orbit.messages where provider = 'x' and social_account_id = ${B1}`,
      t.db.sql`select 1 from orbit.threads where provider = 'x' and social_account_id = ${B1}`,
    ])
      expect(await q).toHaveLength(0);
    const [sup] = await t.db.sql<{ reason: string }>`
      select reason from orbit.social_suppressed where platform = 'x' and account_id = ${B1}`;
    expect(sup!.reason).toBe('request');
    // a later read does not store it again
    await upsertXAccount(t.db, (await adapter.profile(B1)).account, NOW);
    const r = await readXListToEnd(t.db, adapter, {
      accountId: S,
      list: 'following',
      limit: 600,
      readBy: userId,
    });
    expect(r.ok).toBe(true);
    expect(await held(B1)).toEqual({ a: 0, f: 0, l: 0 });
  });
});

// ---- DMs ---------------------------------------------------------------------------------------------------------

describe('DM polling', () => {
  const collect = () => {
    const got: { chatId: string; text: string; at: string; participants: number }[] = [];
    const writer: XDmWriter = async (_db, _u, e) => {
      got.push({
        chatId: e.chat.chatId,
        text: e.message.text,
        at: e.message.at,
        participants: e.chat.participants,
      });
    };
    return { got, writer };
  };

  it('the first read covers 30 days and at most 100 events; later reads only what is new', async () => {
    const fake = world();
    const userId = await connected(fake);
    const conv = FakeX.pair(S, B1);
    for (let i = 0; i < 5; i++)
      fake.dm({
        dm_conversation_id: conv,
        sender_id: B1,
        text: `old ${i}`,
        created_at: new Date(NOW.getTime() - (40 - i) * DAY).toISOString(),
      });
    for (let i = 0; i < 20; i++)
      fake.dm({
        dm_conversation_id: conv,
        sender_id: i % 2 ? S : B1,
        text: `new ${i}`,
        created_at: new Date(NOW.getTime() - (20 - i) * HOUR).toISOString(),
      });
    const { adapter } = await client(fake, userId);
    const { got, writer } = collect();
    const first = await pollXDms(t.db, userId, { adapter, writer, now: () => NOW });
    expect(first).toMatchObject({ first: true, messages: 20 });
    expect(got.map((g) => g.text)).toEqual(Array.from({ length: 20 }, (_, i) => `new ${i}`));
    expect(fake.calls.filter((c) => c.path === '/2/dm_events').map((c) => c.query.max_results)).toEqual([
      '100',
    ]);
    const state = (await loadXState(t.db, userId))!.state;
    expect(state.dmReadAt).toBe(NOW.toISOString());
    expect(state.dmCursor).toBe(fake.events.at(-1)!.id);

    // nothing new: one event read
    fake.calls.length = 0;
    const before = await ledgerUsd(userId);
    const idle = await pollXDms(t.db, userId, { adapter, writer, now: () => NOW });
    expect(idle).toMatchObject({ first: false, events: 0 });
    expect(fake.calls.map((c) => c.query.max_results)).toEqual(['1']);
    expect(cents((await ledgerUsd(userId)) - before)).toBe(0.01);

    // three new: read until what was read before, without paying for a hundred old ones
    for (let i = 0; i < 3; i++)
      fake.dm({
        dm_conversation_id: conv,
        sender_id: B1,
        text: `later ${i}`,
        created_at: new Date(NOW.getTime() + (i + 1) * HOUR).toISOString(),
      });
    got.length = 0;
    fake.calls.length = 0;
    await pollXDms(t.db, userId, { adapter, writer, now: () => new Date(NOW.getTime() + 5 * HOUR) });
    expect(got.map((g) => g.text)).toEqual(['later 0', 'later 1', 'later 2']);
    expect(fake.calls.map((c) => c.query.max_results)).toEqual(['1', '4']);
  });

  it('caps the first read at 100 events', async () => {
    const fake = world();
    const userId = await connected(fake);
    for (let i = 0; i < 130; i++)
      fake.dm({
        dm_conversation_id: FakeX.pair(S, B2),
        sender_id: B2,
        text: `m${i}`,
        created_at: new Date(NOW.getTime() - (130 - i) * 60_000).toISOString(),
      });
    const { adapter } = await client(fake, userId);
    const { got, writer } = collect();
    await pollXDms(t.db, userId, { adapter, writer, now: () => NOW });
    expect(got).toHaveLength(100);
    expect(got[0]!.text).toBe('m30');
    expect(await ledgerUsd(userId)).toBe(1);
  });

  it('reads hourly while a chat waits on a reply over X, daily otherwise', async () => {
    const fake = world();
    const userId = await connected(fake);
    const due = (at: Date) => xDmsDue(t.db, userId, cfg(), at);
    expect(await due(NOW)).toBe(true); // never read
    await saveXState(t.db, userId, { dmReadAt: NOW.toISOString() });
    expect(await due(new Date(NOW.getTime() + 61 * 60_000))).toBe(false);
    expect(await due(new Date(NOW.getTime() + 23 * HOUR))).toBe(false);
    expect(await due(new Date(NOW.getTime() + 24 * HOUR))).toBe(true);
    const [p] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm) values (${userId}::uuid, 'Jason Chen', 'jason chen')
      returning id`;
    await t.db.sql`
      insert into orbit.chats (user_id, person_id, stage, data)
      values (${userId}::uuid, ${p!.id}::uuid, 'outreach_sent',
              ${{ outreachChannel: 'x', lastOutboundAt: NOW.toISOString() }}::jsonb)`;
    expect(await due(new Date(NOW.getTime() + 30 * 60_000))).toBe(false);
    expect(await due(new Date(NOW.getTime() + 61 * 60_000))).toBe(true);
    // not without consent, not with X off, not when the owner has not listed X
    expect(await xDmsDue(t.db, userId, cfg({ offered: false }), new Date(NOW.getTime() + 2 * HOUR))).toBe(
      false,
    );
    await t.db
      .sql`update orbit.source_states set state = 'off' where user_id = ${userId}::uuid and source = 'x'`;
    expect(await due(new Date(NOW.getTime() + 2 * HOUR))).toBe(false);
    await t.db
      .sql`update orbit.source_states set state = 'on' where user_id = ${userId}::uuid and source = 'x'`;

    // the hourly fan-out queues a read for this student, once an hour
    await t.db.sql`delete from pgmq.q_orbit_sync`;
    const at = new Date(NOW.getTime() + 2 * HOUR);
    await enqueueDueXDms(t.db, cfg(), at);
    await enqueueDueXDms(t.db, cfg(), at);
    const q = await t.db.sql<{ kind: string }>`
      select message->>'kind' as kind from pgmq.q_orbit_sync where message->>'userId' = ${userId}`;
    expect(q.map((r) => r.kind)).toEqual(['x.dms']);
  });

  it('the worker skips x.dms without a writer, and queues both kinds hourly from SQL', async () => {
    const h = defaultHandlers({ x: { cfg: cfg() } });
    const ctx: JobContext = { db: t.db, queue: sqlQueue(t.db), now: () => NOW };
    const userId = await makeUser(t.db);
    const job: Job = { queue: 'orbit_sync', msgId: 1, readCt: 1, kind: 'x.dms', userId, payload: {} };
    await expect(h['x.dms']!(job, ctx)).rejects.toBeInstanceOf(JobSkipped);
    await expect(defaultHandlers({})['x.dms']!(job, ctx)).rejects.toBeInstanceOf(JobSkipped);
    await h['x.expire']!({ ...job, kind: 'x.expire', userId: null }, ctx);
    await t.db.sql`delete from pgmq.q_orbit_enrich`;
    await t.db.sql`delete from pgmq.q_orbit_sync`;
    await t.db.sql`select orbit.enqueue_x()`;
    const kinds = await t.db.sql<{ kind: string }>`
      select message->>'kind' as kind from pgmq.q_orbit_sync where message->>'kind' like 'x.%'
      union all select message->>'kind' from pgmq.q_orbit_enrich where message->>'kind' like 'x.%'`;
    expect(kinds.map((k) => k.kind).sort()).toEqual(['x.dms', 'x.expire']);
  });
});

// ---- sending -----------------------------------------------------------------------------------------------------

describe('sendXMessage', () => {
  it('checks receives_your_dm first and says why it will not send', async () => {
    const fake = world();
    const userId = await connected(fake);
    const r = await sendXMessage(t.db, userId, '405', 'Hi there', {
      cfg: cfg(),
      fetch: fake.fetch,
      now: () => NOW,
    });
    expect(r).toEqual({
      ok: false,
      code: 'not_accepting',
      reason: 'They do not accept messages from you on X. Try another way to reach them.',
    });
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path.includes('messages'))).toHaveLength(0);
    expect(await ledgerUsd(userId)).toBe(0.01);
  });

  it('sends to someone who accepts, and charges $0.015', async () => {
    const fake = world();
    const userId = await connected(fake);
    const r = await sendXMessage(t.db, userId, B1, 'Hi Jason, could we talk?', {
      cfg: cfg(),
      fetch: fake.fetch,
      now: () => NOW,
    });
    expect(r).toMatchObject({ ok: true, chatId: FakeX.pair(S, B1), costUsd: 0.015 });
    expect(fake.events.at(-1)).toMatchObject({ sender_id: S, text: 'Hi Jason, could we talk?' });
    expect(cents(await ledgerUsd(userId))).toBe(0.025);
    expect(cents(fake.billedUsd)).toBe(0.025);
    expect((await sendXMessage(t.db, userId, B1, '   ', { cfg: cfg(), fetch: fake.fetch })).ok).toBe(false);
  });
});

// ---- matching ----------------------------------------------------------------------------------------------------

describe('matching on X: public proof only', () => {
  const account = mapXUser({
    id: T,
    username: 'priya',
    name: 'Priya Rao',
    description: 'Design at Linear',
    entities: { url: { urls: [{ expanded_url: 'https://www.linkedin.com/in/priya-rao' }] } },
  });
  const cand = (over: Partial<SocialCandidate> = {}, person: Partial<SocialCandidate['person']> = {}) =>
    ({
      person: {
        id: 'p1',
        displayName: 'Priya Rao',
        firstName: 'Priya',
        lastName: 'Rao',
        emails: [],
        currentOrganizationRaw: 'Linear',
        currentTitle: 'Designer',
        ...person,
      },
      knownToStudent: true,
      ...over,
    }) as SocialCandidate;

  it('attaches by the person s own links or by a link back to their LinkedIn', () => {
    expect(matchXAccount(account, [cand({ links: ['https://x.com/priya'] })])).toMatchObject({
      kind: 'attach',
      via: 'proof',
      proof: 'own_links',
    });
    expect(
      matchXAccount(account, [cand({}, { linkedinUrl: 'https://linkedin.com/in/priya-rao' })]),
    ).toMatchObject({
      kind: 'attach',
      proof: 'links_back',
    });
    expect(matchXTarget(account, cand({ links: ['https://twitter.com/priya'] }))).toMatchObject({
      kind: 'attach',
    });
  });

  it('never attaches by the address book or a score, and never asks the student', () => {
    expect(X_PRIVATE_PROOF_ALLOWED).toBe(false);
    expect(matchXAccount(account, [cand({ contactHandles: ['@priya'] })]).kind).toBe('none');
    expect(matchXTarget(account, cand({ contactHandles: ['@priya'] })).kind).toBe('none');
    // a name, an employer and the same personal site would score high elsewhere; on X it is not proof
    const strong = cand({ links: ['https://priya.design'], employerSize: 200 });
    const withSite = { ...account, links: ['https://priya.design'] };
    const m = matchXAccount(withSite, [strong]);
    expect(m.kind).toBe('none');
    expect(
      matchXAccount(account, [
        cand({ links: ['https://x.com/priya'] }),
        cand({ links: ['https://x.com/priya'] }, { id: 'p2' }),
      ]),
    ).toEqual({ kind: 'none', reason: 'ambiguous' });
  });
});
