/**
 * Plan 43 §5 end to end on the fake X, with X launched by the owner's switch: the first days on connect (the
 * student's own following list read to the end, matching by public proof only), "Check X for Priya" with the price
 * first and the check under it (never charged above the quote, a partial list never stored, nothing shared between
 * students), and sending a DM only on the student's tap.
 */
import { messageHash } from '@orbit/core/safety/rules';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sqlQueue } from '../../functions/_shared/queue.ts';
import { memoryTake } from '../../functions/_shared/ratelimit.ts';
import { sendDraft } from '../../functions/_shared/sending/send.ts';
import { makeServices } from '../../functions/_shared/services.ts';
import { attachAccount } from '../../functions/_shared/social/links.ts';
import type { XConfig } from '../../functions/_shared/social/x/config.ts';
import { heldXList } from '../../functions/_shared/social/x/lists.ts';
import { storeXTokens } from '../../functions/_shared/social/x/oauth.ts';
import { forgetOffered } from '../../functions/_shared/sources/states.ts';
import { sqlVault } from '../../functions/_shared/vault.ts';
import { makeApiHandler } from '../../functions/orbit-api/api.ts';
import { socialHandlers } from '../../functions/orbit-worker/handlers/social.ts';
import { xHandlers } from '../../functions/orbit-worker/handlers/x.ts';
import type { Job, JobContext } from '../../functions/orbit-worker/worker.ts';
import { APP, agentConfig, BASE, SECRET, signedInUser } from '../helpers/agents.ts';
import { FAKE_X_CLIENT_ID, FAKE_X_CLIENT_SECRET, FakeX } from '../helpers/fakeX.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
  // the owner launched X; ORBIT_EXTRA_SOURCES does not name it (cfg.offered is false)
  await t.db
    .sql`insert into orbit_private.source_launch (source, offered, changed_at) values ('x', true, now())`;
  forgetOffered(t.db);
});
afterAll(async () => {
  await t.pg.close();
});
beforeEach(async () => {
  await t.db.sql`delete from orbit.social_follows`;
  await t.db.sql`delete from orbit.social_list_reads`;
  await t.db.sql`delete from orbit.social_accounts`;
});

const cfg = (over: Partial<XConfig> = {}): XConfig => ({
  clientId: FAKE_X_CLIENT_ID,
  clientSecret: FAKE_X_CLIENT_SECRET,
  studentMonthlyUsd: 15,
  orbitMonthlyUsd: 500,
  listLimit: 600,
  offered: false,
  ...over,
});

const S = '100'; // the student
const T = '200'; // Priya, the target
const B1 = '301'; // Jason: follows each other with the student and with Priya, a bridge
const B2 = '302'; // follows each other with the student; follows Priya, who does not follow back
const C = '303'; // follows each other with the student; nothing to do with Priya
const D = '500'; // Dana, a second target

function world(): FakeX {
  const x = new FakeX();
  x.addUser({ id: S, username: 'maya_c', name: 'Maya Chen' });
  x.addUser({ id: T, username: 'priya', name: 'Priya Rao', links: ['https://linkedin.com/in/priya-rao'] });
  x.addUser({ id: B1, username: 'jchen', name: 'Jason Chen', description: 'linkedin.com/in/jason-chen' });
  x.addUser({ id: B2, username: 'sam_k', name: 'Sam Kim' });
  x.addUser({ id: C, username: 'lee_w', name: 'Lee Wong' });
  x.addUser({ id: D, username: 'dana', name: 'Dana Ito' });
  for (const id of [B1, B2, C]) x.mutual(S, id);
  x.mutual(B1, T);
  x.follow(B2, T);
  x.mutual(C, D);
  for (let i = 0; i < 15; i++) {
    const id = String(400 + i);
    x.addUser({ id, username: `fan${i}`, name: `Fan ${i}` });
    x.follow(id, T);
    x.follow(id, D);
    if (i < 6) x.follow(T, id);
    if (i < 8) x.follow(D, id);
  }
  return x;
}

/** A signed-in student with X connected as `xId`: tokens in Vault, consent given, X on. */
async function connected(fake: FakeX, xId = S) {
  const s = await signedInUser(t);
  const tok = fake.issue(xId);
  const v = await storeXTokens(
    sqlVault(t.db),
    s.userId,
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
    values (${s.userId}::uuid, 'x', 'active', ${xId}, ${v.refreshSecretId}::uuid, ${{ x }}::jsonb)`;
  await t.db
    .sql`insert into orbit.source_states (user_id, source, state) values (${s.userId}::uuid, 'x', 'on')`;
  return s;
}

async function person(userId: string, name: string, slug?: string) {
  const [first, ...rest] = name.split(' ');
  const [p] = await t.db.sql<{ id: string }>`
    insert into orbit.people (user_id, display_name, first_name, last_name, name_norm, linkedin_slug, sources)
    values (${userId}::uuid, ${name}, ${first}, ${rest.join(' ')}, ${name.toLowerCase()}, ${slug ?? null},
            array['linkedin']) returning id`;
  return p!.id;
}

function apiFor(fake: FakeX, fetchFn: typeof fetch = fake.fetch) {
  const handler = makeApiHandler({
    env: {
      googleClientId: 'client-id-placeholder.apps.googleusercontent.com',
      googleClientSecret: 'client-secret-placeholder',
      googleRedirectUri: `${BASE}/auth/google/callback`,
      sessionSecret: SECRET,
      appUrl: APP,
      x: cfg(),
    },
    db: t.db,
    fetch: fetchFn,
    take: memoryTake(),
    agent: agentConfig({ fetch: fetchFn, calls: [] } as never, {}),
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

const ctx = (): JobContext => ({ db: t.db, queue: sqlQueue(t.db), now: () => new Date() });
const job = (kind: string, userId: string | null, payload: Record<string, unknown> = {}): Job => ({
  queue: 'orbit_enrich',
  msgId: 1,
  readCt: 1,
  kind,
  userId,
  payload,
});
const ledgerUsd = async (userId: string) => {
  const [r] = await t.db.sql<{ usd: string }>`
    select coalesce(sum(cost_usd), 0)::text as usd from orbit.usage_ledger where user_id = ${userId}::uuid and provider = 'x'`;
  return Number(r!.usd);
};
const cents = (n: number) => Math.round(n * 1000) / 1000;

/** The first days (sync.x), then matching: the circle, and Jason attached by the link on his X profile. */
async function firstDays(fake: FakeX, userId: string, fetchFn: typeof fetch = fake.fetch) {
  await xHandlers({ x: { cfg: cfg(), fetch: fetchFn } })['sync.x']!(job('sync.x', userId), ctx());
  const [m] = await t.db.sql<{ payload: { platform: string; accountIds: string[] } }>`
    select message->'payload' as payload from pgmq.q_orbit_enrich
     where message->>'kind' = 'social.match' and message->>'userId' = ${userId}`;
  await socialHandlers({ fetch: fetchFn, x: { cfg: cfg() } })['social.match']!(
    job('social.match', userId, m!.payload),
    ctx(),
  );
  return m!.payload;
}

async function runLookup(fetchFn: typeof fetch, lookupId: string) {
  await socialHandlers({ fetch: fetchFn, x: { cfg: cfg(), fetch: fetchFn } })['social.lookup']!(
    job('social.lookup', null, { lookupId }),
    ctx(),
  );
  const [l] = await t.db.sql<{
    status: string;
    result: Record<string, any> | null;
    quoted_usd: string;
    cost_usd: string;
  }>`select status, result, quoted_usd::text, cost_usd::text from orbit.social_lookups where id = ${lookupId}::uuid`;
  return { ...l!, quoted: Number(l!.quoted_usd), cost: Number(l!.cost_usd) };
}

describe('X, launched by the owner', () => {
  it('reads the student’s own list on connect and attaches accounts by public proof only', async () => {
    const fake = world();
    const s = await connected(fake);
    const jason = await person(s.userId, 'Jason Chen', 'jason-chen');
    const sam = await person(s.userId, 'Sam Kim');
    const m = await firstDays(fake, s.userId);
    expect(m).toEqual({ platform: 'x', accountIds: [B1, B2, C].sort() });
    // read to the end, as the student's own list; who follows back came with it
    const reads = await t.db.sql<{ list: string; owner_user_id: string; ended: boolean }>`
      select list, owner_user_id, ended from orbit.social_list_reads where platform = 'x' and account_id = ${S}`;
    expect(reads).toEqual([{ list: 'following', owner_user_id: s.userId, ended: true }]);
    const follows = await t.db.sql<{ followed_id: string }>`
      select followed_id from orbit.social_follows
       where platform = 'x' and follower_id = ${S} and owner_user_id = ${s.userId}::uuid order by followed_id`;
    expect(follows.map((f) => f.followed_id)).toEqual([B1, B2, C]);
    expect(fake.paths(`/2/users/${S}/followers`)).toHaveLength(0);
    // Jason's profile links his LinkedIn: attached; Sam shares only a name, which is never enough on X
    const links = await t.db.sql<{ account_id: string; person_id: string }>`
      select account_id, person_id from orbit.social_links where user_id = ${s.userId}::uuid and platform = 'x'`;
    expect(links).toEqual([{ account_id: B1, person_id: jason }]);
    expect(links.some((l) => l.person_id === sam)).toBe(false);
    expect(
      await t.db
        .sql`select 1 from orbit.social_match_asks where user_id = ${s.userId}::uuid and platform = 'x'`,
    ).toHaveLength(0);
  });

  it('quotes first, then checks under the quote and finds the bridge', async () => {
    const fake = world();
    const s = await connected(fake);
    const jason = await person(s.userId, 'Jason Chen', 'jason-chen');
    const priya = await person(s.userId, 'Priya Rao', 'priya-rao');
    await firstDays(fake, s.userId);
    await attachAccount(t.db, s.userId, {
      platform: 'x',
      accountId: T,
      personId: priya,
      via: 'proof',
      proof: 'links_back',
      now: new Date(),
    });
    const call = apiFor(fake);
    // no quote yet: nothing runs
    const early = await call('POST', '/social/lookups', s.token, {
      platform: 'x',
      personId: priya,
      confirm: true,
    });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('quote_first');

    const before = await ledgerUsd(s.userId);
    const q = await call('POST', '/social/lookups', s.token, { platform: 'x', personId: priya });
    expect(q.body).toEqual({ status: 'quote', quoteUsd: 0.44, list: 'following', size: 7 });
    // the quote read the profile, nothing more
    expect(cents((await ledgerUsd(s.userId)) - before)).toBe(0.01);
    expect(fake.paths(`/2/users/${T}/f`)).toHaveLength(0);

    const c = await call('POST', '/social/lookups', s.token, {
      platform: 'x',
      personId: priya,
      confirm: true,
    });
    expect(c.body).toMatchObject({ status: 'queued', quoteUsd: 0.44 });
    const afterQuote = await ledgerUsd(s.userId);
    const out = await runLookup(fake.fetch, c.body.lookupId);
    expect(out.status).toBe('done');
    expect(out.result!.bridges).toEqual([{ personId: jason, accountId: B1, name: 'Jason Chen' }]);
    expect(out.result!.partial).toBe(false);
    // never charged above the quote
    const charged = cents((await ledgerUsd(s.userId)) - afterQuote);
    expect(charged).toBeGreaterThan(0);
    expect(charged).toBeLessThanOrEqual(0.44);
    expect(out.cost).toBe(charged);
    expect(out.quoted).toBe(0.44);
    // the bridge is a tie now
    const [a, b] = [jason, priya].sort();
    expect(
      await t.db.sql`select 1 from orbit.ties where user_id = ${s.userId}::uuid and kind = 'x_mutual'
                       and a_person_id = ${a}::uuid and b_person_id = ${b}::uuid`,
    ).toHaveLength(1);
    const got = await call('GET', `/social/lookups/${c.body.lookupId}`, s.token);
    expect(got.body.status).toBe('done');
    const [n] = await t.db.sql<{ title: string; body: string }>`
      select title, body from orbit.notifications where user_id = ${s.userId}::uuid and kind = 'social_lookup'`;
    expect(n!.title).toBe('Finished checking X for Priya');
    expect(`${n!.title} ${n!.body}`).not.toMatch(/[!—]/);

    // the student's own list answers only them: another student checking Priya never reads or uses it
    const other = await connected(fake, C);
    expect(await heldXList(t.db, S, 'following', s.userId)).toBeDefined();
    expect(await heldXList(t.db, S, 'following', other.userId)).toBeUndefined();
    // and who they follow on X is never shared with friends
    const share = await call('PUT', '/sources/x', s.token, { state: 'on', shareFollows: true });
    expect(share.status).toBe(400);
  });

  it('stops at the price the student agreed to, and keeps no partial list', async () => {
    const fake = world();
    const s = await connected(fake);
    const dana = await person(s.userId, 'Dana Ito');
    await firstDays(fake, s.userId);
    await attachAccount(t.db, s.userId, {
      platform: 'x',
      accountId: D,
      personId: dana,
      via: 'proof',
      proof: 'own_links',
      now: new Date(),
    });
    const call = apiFor(fake);
    const q = await call('POST', '/social/lookups', s.token, { platform: 'x', personId: dana });
    // Dana follows 8 fans and Lee
    expect(q.body).toMatchObject({ status: 'quote', list: 'following', size: 9 });
    // the student agreed to less than the full price: the check stops before the read that would pass it
    const c = await call('POST', '/social/lookups', s.token, {
      platform: 'x',
      personId: dana,
      confirm: true,
      quoteUsd: 0.05,
    });
    expect(c.body.quoteUsd).toBe(0.05);
    const before = await ledgerUsd(s.userId);
    const out = await runLookup(fake.fetch, c.body.lookupId);
    expect(out.status).toBe('done');
    expect(out.result).toMatchObject({ bridges: [], partial: true, reason: 'over_quote' });
    expect(cents((await ledgerUsd(s.userId)) - before)).toBeLessThanOrEqual(0.05);
    expect(fake.paths(`/2/users/${D}/following`)).toHaveLength(0);
    expect(await t.db.sql`select 1 from orbit.social_list_reads where account_id = ${D}`).toHaveLength(0);

    // X slows Orbit down half way through a list: nothing of it is kept, and the check waits to try again
    fake.listPageCap = 3;
    let slow = true;
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input instanceof Request ? input.url : input));
      if (slow && u.pathname === `/2/users/${D}/following` && u.searchParams.get('pagination_token'))
        return new Response(JSON.stringify({ title: 'Too Many Requests' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'x-rate-limit-reset': '9999999999' },
        });
      return fake.fetch(input, init);
    }) as typeof fetch;
    const q2 = await apiFor(fake, flaky)('POST', '/social/lookups', s.token, {
      platform: 'x',
      personId: dana,
    });
    const c2 = await apiFor(fake, flaky)('POST', '/social/lookups', s.token, {
      platform: 'x',
      personId: dana,
      confirm: true,
    });
    const first = await runLookup(flaky, c2.body.lookupId);
    expect(first.status).toBe('waiting');
    expect(fake.paths(`/2/users/${D}/following`).length).toBeGreaterThan(0);
    expect(await t.db.sql`select 1 from orbit.social_list_reads where account_id = ${D}`).toHaveLength(0);
    expect(
      await t.db.sql`select 1 from orbit.social_follows where platform = 'x' and follower_id = ${D}`,
    ).toHaveLength(0);
    // later it goes through, and the whole check still costs no more than its quote
    slow = false;
    const second = await runLookup(flaky, c2.body.lookupId);
    expect(second.status).toBe('done');
    expect(second.cost).toBeLessThanOrEqual(q2.body.quoteUsd);
    expect(second.result!.bridges.map((b: { accountId: string }) => b.accountId)).toEqual([C]);
  });

  it('sends a DM only on the student’s tap, after checking they accept it, and writes the touch', async () => {
    const fake = world();
    const s = await connected(fake);
    const jason = await person(s.userId, 'Jason Chen', 'jason-chen');
    const priya = await person(s.userId, 'Priya Rao', 'priya-rao');
    await firstDays(fake, s.userId);
    await attachAccount(t.db, s.userId, {
      platform: 'x',
      accountId: T,
      personId: priya,
      via: 'proof',
      proof: 'links_back',
      now: new Date(),
    });
    const call = apiFor(fake);
    const c = await call('POST', '/drafts/compose', s.token, { personId: jason, kind: 'bump', channel: 'x' });
    expect(c.status).toBe(200);
    expect(c.body.draft.channel).toBe('x');
    const id = c.body.draft.id as string;
    const body = 'Hi Jason, could I ask you about your time at Linear?';
    const noTap = await call('POST', '/drafts/approve', s.token, { draftId: id, body });
    expect(noTap.status).toBe(409);
    expect(noTap.body.error.code).toBe('needs_confirmation');
    expect(noTap.body.error.message).toBe('every X message needs your tap to send');
    expect(fake.paths('/messages')).toHaveLength(0);

    const tap = await call('POST', '/drafts/approve', s.token, { draftId: id, body, confirm: true });
    expect(tap.body.draft.status).toBe('sent');
    expect(fake.paths('/messages')).toEqual([`POST /2/dm_conversations/with/${B1}/messages`]);
    const [m] = await t.db.sql<{ direction: string; body_text: string; to_person_ids: string[] }>`
      select direction, body_text, to_person_ids from orbit.messages where user_id = ${s.userId}::uuid and provider = 'x'`;
    expect(m).toEqual({ direction: 'out', body_text: body, to_person_ids: [jason] });

    // Priya does not accept DMs from the student: the draft waits with the reason, nothing is sent
    const [d2] = await t.db.sql<{ id: string }>`
      insert into orbit.drafts (user_id, person_id, channel, kind, body, status)
      values (${s.userId}::uuid, ${priya}::uuid, 'x', 'bump', 'Hi Priya, a quick question?', 'draft') returning id`;
    const refused = await call('POST', '/drafts/approve', s.token, { draftId: d2!.id, confirm: true });
    expect(refused.body.draft).toMatchObject({ status: 'draft', error: 'x_not_accepting' });
    expect(fake.paths('/messages')).toHaveLength(1);

    // what Orbit approved on its own never goes on X
    const [d3] = await t.db.sql<{ id: string; body: string }>`
      insert into orbit.drafts (user_id, person_id, channel, kind, body, status, send_at)
      values (${s.userId}::uuid, ${jason}::uuid, 'x', 'bump', 'Just checking in', 'approved', now())
      returning id, body`;
    await t.db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${s.userId}::uuid, 'agent', 'draft.auto_approve', 'drafts', ${d3!.id},
              ${{ hash: messageHash({ channel: 'x' as never, subject: null, body: d3!.body }) }}::jsonb)`;
    const services = makeServices(
      { ...agentConfig({ fetch: fake.fetch, calls: [] } as never, { x: cfg() }), fetch: fake.fetch },
      { db: t.db, now: () => new Date(), queue: sqlQueue(t.db) },
    );
    expect(await sendDraft(services, d3!.id)).toEqual({ status: 'held', reason: 'x_never_auto' });
    expect(fake.paths('/messages')).toHaveLength(1);
  });
});
