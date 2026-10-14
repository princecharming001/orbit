import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accountStatus, decodePubSub, makeWebhookHandler } from '../../functions/orbit-webhooks/webhooks.ts';
import { freshDb, makeUser, type TestDb } from '../helpers/pglite.ts';

const BASE = 'https://ref.supabase.co/functions/v1/orbit-webhooks';
const PUBSUB = 'pubsub-token-placeholder';
const UNIPILE = 'unipile-secret-placeholder';

let t: TestDb;
let handler: (r: Request) => Promise<Response>;
beforeAll(async () => {
  t = await freshDb();
  handler = makeWebhookHandler({ db: t.db, pubsubToken: PUBSUB, unipileSecret: UNIPILE });
});
afterAll(async () => {
  await t.pg.close();
});
beforeEach(async () => {
  await t.pg.exec(
    'delete from pgmq.q_orbit_sync; delete from pgmq.q_orbit_classify; delete from pgmq.q_orbit_score;',
  );
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const envelope = (data: unknown) => ({
  message: { data: btoa(JSON.stringify(data)), messageId: '1', publishTime: new Date().toISOString() },
  subscription: 'projects/p/subscriptions/orbit-gmail',
});

const jobs = (queue: string) =>
  t.db.query<{
    message: { kind: string; userId: string; payload: Record<string, unknown>; dedupeKey: string };
  }>(`select message from pgmq.q_${queue} order by msg_id`);

async function googleUser(email: string) {
  const u = await makeUser(t.db, { email });
  await t.db
    .sql`insert into orbit.integration_accounts (user_id, provider, email) values (${u}::uuid, 'google', ${email})`;
  return u;
}

async function linkedinUser(accountId: string) {
  const u = await makeUser(t.db);
  await t.db.sql`insert into orbit.integration_accounts (user_id, provider, external_account_id)
    values (${u}::uuid, 'linkedin', ${accountId})`;
  return u;
}

describe('configuration and secrets', () => {
  it('answers unconfigured without the secrets', async () => {
    const h = makeWebhookHandler({ db: t.db, pubsubToken: undefined, unipileSecret: undefined });
    for (const path of ['/gmail?token=x', '/unipile', '/unipile/account?token=x']) {
      const r = await h(post(path, {}));
      expect(r.status).toBe(503);
      expect(r.headers.get('x-orbit-connector')).toBe('unconfigured');
    }
  });

  it('refuses wrong tokens and signatures, other methods and routes', async () => {
    expect((await handler(post('/gmail?token=wrong', envelope({})))).status).toBe(403);
    expect((await handler(post('/gmail', envelope({})))).status).toBe(403);
    expect((await handler(post('/unipile', {}, { 'x-orbit-webhook': 'wrong' }))).status).toBe(401);
    expect((await handler(post('/unipile/account?token=wrong', {}))).status).toBe(403);
    expect((await handler(new Request(`${BASE}/gmail?token=${PUBSUB}`))).status).toBe(405);
    expect((await handler(post('/other', {}))).status).toBe(404);
  });
});

describe('Gmail push', () => {
  it('decodes the Pub/Sub envelope', () => {
    expect(decodePubSub(envelope({ emailAddress: 'a@b.c', historyId: 12345 }))).toEqual({
      emailAddress: 'a@b.c',
      historyId: '12345',
    });
    expect(decodePubSub({ message: { data: 'not base64 json' } })).toBeUndefined();
    expect(decodePubSub(envelope({ emailAddress: 'a@b.c', historyId: 'x; drop' }))).toBeUndefined();
  });

  it('queues one incremental sync per user per historyId', async () => {
    const u = await googleUser('Maya.Push@Example.com');
    const send = () =>
      handler(
        post(`/gmail?token=${PUBSUB}`, envelope({ emailAddress: 'maya.push@example.com', historyId: '777' })),
      );
    expect((await send()).status).toBe(204);
    expect((await send()).status).toBe(204);
    const q = await jobs('orbit_sync');
    expect(q).toHaveLength(1);
    expect(q[0]!.message).toMatchObject({
      kind: 'sync.gmail.incremental',
      userId: u,
      payload: { historyId: '777' },
      dedupeKey: `gmail:${u}:777`,
    });
  });

  it('acknowledges pushes for unknown addresses and malformed bodies without queueing', async () => {
    expect(
      (
        await handler(
          post(`/gmail?token=${PUBSUB}`, envelope({ emailAddress: 'nobody@example.com', historyId: '1' })),
        )
      ).status,
    ).toBe(204);
    expect((await handler(post(`/gmail?token=${PUBSUB}`, '{not json'))).status).toBe(204);
    expect(await jobs('orbit_sync')).toHaveLength(0);
  });
});

describe('Unipile webhooks', () => {
  const hdr = { 'x-orbit-webhook': UNIPILE };
  const message = (over: Record<string, unknown> = {}) => ({
    event: 'message_received',
    account_id: 'acc_msg',
    account_type: 'LINKEDIN',
    account_info: { type: 'LINKEDIN', user_id: 'me-provider-id' },
    chat_id: 'chat_1',
    message_id: `msg_${Math.random()}`,
    message: 'Happy to chat next week',
    timestamp: new Date().toISOString(),
    sender: { attendee_id: 'att_1', attendee_name: 'Priya', attendee_provider_id: 'priya-provider-id' },
    ...over,
  });

  it('queues a classification for a message from someone else, once', async () => {
    const u = await linkedinUser('acc_msg');
    const m = message();
    const r = await handler(post('/unipile', m, hdr));
    expect(await r.json()).toEqual({ ok: true, result: 'queued' });
    expect(await (await handler(post('/unipile', m, hdr))).json()).toEqual({ ok: true, result: 'duplicate' });
    const q = await jobs('orbit_classify');
    expect(q).toHaveLength(1);
    expect(q[0]!.message).toMatchObject({
      kind: 'classify.message',
      userId: u,
      payload: { provider: 'linkedin', chatId: 'chat_1', messageId: m.message_id },
    });
  });

  it('drops the user’s own messages and messages for unknown accounts', async () => {
    await linkedinUser('acc_own');
    const own = message({ account_id: 'acc_own', sender: { attendee_provider_id: 'me-provider-id' } });
    expect(await (await handler(post('/unipile', own, hdr))).json()).toEqual({
      ok: true,
      result: 'own_message',
    });
    const stranger = message({ account_id: 'acc_unknown' });
    expect(await (await handler(post('/unipile', stranger, hdr))).json()).toEqual({
      ok: true,
      result: 'unknown_account',
    });
    expect(await jobs('orbit_classify')).toHaveLength(0);
  });

  it('stores a new relation as a person with LinkedIn identities, once, and re-scores them', async () => {
    const u = await linkedinUser('acc_rel');
    const rel = {
      event: 'new_relation',
      account_id: 'acc_rel',
      account_type: 'LINKEDIN',
      user_full_name: 'Sam Rivera',
      user_provider_id: 'sam-provider-id',
      user_public_identifier: 'samrivera',
      user_profile_url: 'https://www.linkedin.com/in/samrivera',
    };
    const r = await handler(post('/unipile', rel, hdr));
    expect(await r.json()).toEqual({ ok: true, result: 'stored' });
    expect(await (await handler(post('/unipile', rel, hdr))).json()).toEqual({
      ok: true,
      result: 'duplicate',
    });
    const people = await t.db.sql<{ id: string; display_name: string; linkedin_member_id: string }>`
      select id, display_name, linkedin_member_id from orbit.people where user_id = ${u}::uuid and not is_self`;
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ display_name: 'Sam Rivera', linkedin_member_id: 'sam-provider-id' });
    const ids = await t.db.sql<{ kind: string; value_norm: string; source: string }>`
      select kind, value_norm, source from orbit.person_identities
       where user_id = ${u}::uuid and person_id = ${people[0]!.id}::uuid order by kind`;
    expect(ids).toEqual([
      { kind: 'linkedin_member', value_norm: 'sam-provider-id', source: 'linkedin_relation' },
      { kind: 'linkedin_slug', value_norm: 'samrivera', source: 'linkedin_relation' },
    ]);
    const q = await jobs('orbit_score');
    expect(q.map((j) => j.message)).toEqual([
      expect.objectContaining({ kind: 'score.person', userId: u, payload: { personIds: [people[0]!.id] } }),
    ]);
  });

  it('applies account status changes to the integration row', async () => {
    const u = await linkedinUser('acc_status');
    const r = await handler(
      post(
        '/unipile',
        { AccountStatus: { account_id: 'acc_status', account_type: 'LINKEDIN', message: 'CREDENTIALS' } },
        hdr,
      ),
    );
    expect(await r.json()).toEqual({ ok: true, result: 'status:needs_reauth' });
    const [row] = await t.db.sql<{ status: string }>`
      select status from orbit.integration_accounts where user_id = ${u}::uuid and provider = 'linkedin'`;
    expect(row!.status).toBe('needs_reauth');
    expect(accountStatus('OK')).toBe('active');
    expect(accountStatus('STOPPED')).toBe('error');
    expect(accountStatus('whatever')).toBeUndefined();
  });

  it('ignores events it does not handle', async () => {
    const r = await handler(post('/unipile', { event: 'message_read', account_id: 'acc_msg' }, hdr));
    expect(await r.json()).toEqual({ ok: true, result: 'ignored' });
  });
});

describe('Unipile hosted-auth notify', () => {
  it('links the account to the user named in the payload and queues the backfill', async () => {
    const u = await makeUser(t.db);
    const r = await handler(
      post(`/unipile/account?token=${UNIPILE}`, {
        status: 'CREATION_SUCCESS',
        account_id: 'acc_new',
        name: u,
      }),
    );
    expect(await r.json()).toEqual({ ok: true, result: 'connected' });
    const [row] = await t.db.sql<{ external_account_id: string; status: string }>`
      select external_account_id, status from orbit.integration_accounts where user_id = ${u}::uuid and provider = 'linkedin'`;
    expect(row).toEqual({ external_account_id: 'acc_new', status: 'active' });
    const q = await jobs('orbit_sync');
    expect(q[0]!.message).toMatchObject({
      kind: 'sync.linkedin',
      userId: u,
      payload: { mode: 'backfill', accountId: 'acc_new' },
    });

    // reconnecting updates the same row
    await handler(
      post(`/unipile/account?token=${UNIPILE}`, { status: 'RECONNECTED', account_id: 'acc_new2', name: u }),
    );
    const rows = await t.db.sql<{ external_account_id: string }>`
      select external_account_id from orbit.integration_accounts where user_id = ${u}::uuid and provider = 'linkedin'`;
    expect(rows).toEqual([{ external_account_id: 'acc_new2' }]);
  });

  it('ignores failures, unknown users, and an account already linked to someone else', async () => {
    const u = await makeUser(t.db);
    const other = await linkedinUser('acc_taken');
    const send = (b: unknown) => handler(post(`/unipile/account?token=${UNIPILE}`, b)).then((r) => r.json());
    expect(await send({ status: 'CREATION_FAIL', account_id: 'x', name: u })).toEqual({
      ok: true,
      result: 'ignored',
    });
    expect(await send({ status: 'CREATION_SUCCESS', account_id: 'x', name: 'not-a-uuid' })).toEqual({
      ok: true,
      result: 'ignored',
    });
    expect(await send({ status: 'CREATION_SUCCESS', account_id: 'x', name: crypto.randomUUID() })).toEqual({
      ok: true,
      result: 'unknown_user',
    });
    expect(await send({ status: 'CREATION_SUCCESS', account_id: 'acc_taken', name: u })).toEqual({
      ok: true,
      result: 'account_in_use',
    });
    expect(other).toBeTruthy();
  });
});
