import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkPhone,
  LATE_HOURS,
  makeNotifyHandler,
  readyEmail,
  readySms,
} from '../../functions/orbit-notify/notify.ts';
import { fakeNet, jsonRes, SECRET, signedInUser } from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
}, 120_000);
afterAll(async () => {
  await t?.pg.close();
});

// the real time (to the second): a session made by the test helper is checked against the handler's clock
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const CRON = 'cron-secret-placeholder-0123456789';
const ORIGIN = 'https://tryorbit.today';

function world(keys: Record<string, string> = {}) {
  const net = fakeNet(
    (c) => (c.url.startsWith('https://api.resend.com/') ? jsonRes(200, { id: 'em_1' }) : undefined),
    (c) => (c.url.startsWith('https://api.twilio.com/') ? jsonRes(201, { sid: 'SM1' }) : undefined),
  );
  let now = NOW;
  const handler = makeNotifyHandler({
    db: t.db,
    origins: (o) => o === ORIGIN,
    sessionSecret: SECRET,
    cronSecret: CRON,
    secret: async (name) => keys[name],
    appUrl: 'https://tryorbit.today',
    fetch: net.fetch,
    now: () => now,
  });
  const call = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await handler(
      new Request(`https://ref.supabase.co/functions/v1/orbit-notify${path}`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { net, call, setNow: (d: Date) => (now = d), handler };
}

/** Google's import at a phase, LinkedIn's first pass at a stage, and jobs still queued. */
async function importAt(
  userId: string,
  o: { gmail?: string | null; linkedin?: 'relations' | 'chats' | 'done' | null; jobs?: number },
) {
  if (o.gmail !== undefined)
    await t.db.sql`update orbit.integration_accounts
                     set sync_state = jsonb_set(coalesce(sync_state, '{}'::jsonb), '{gmail}',
                         jsonb_build_object('backfill', jsonb_build_object('phase', ${o.gmail}::text, 'done', 40, 'total', 100)))
                   where user_id = ${userId}::uuid and provider = 'google'`;
  if (o.linkedin !== undefined) {
    const state =
      o.linkedin === null
        ? null
        : { stage: o.linkedin, ...(o.linkedin === 'done' ? { syncedAt: NOW.toISOString() } : {}) };
    await t.db.sql`
      insert into orbit.integration_accounts (user_id, provider, status, external_account_id, sync_state)
      values (${userId}::uuid, 'linkedin', 'active', ${`li-${userId}`}, ${{ linkedin: state }}::jsonb)
      on conflict (user_id, provider) do update set sync_state = excluded.sync_state, status = 'active'`;
  }
  await t.db.sql`delete from pgmq.q_orbit_score where message->>'userId' = ${userId}`;
  for (let i = 0; i < (o.jobs ?? 0); i++)
    await t.db.sql`select pgmq.send('orbit_score', ${{ kind: 'score.user', userId }}::jsonb)`;
}

describe('orbit-notify: where the first import stands', () => {
  it('answers a signed-in student with the steps, the contact row and what is set up; never without a session', async () => {
    const w = world({ RESEND_API_KEY: 're_placeholder' });
    const u = await signedInUser(t, { firstName: 'Maya' });
    await importAt(u.userId, { gmail: 'recent', linkedin: 'relations', jobs: 3 });
    const r = await w.call('/notify/status', {}, { authorization: `Bearer ${u.token}` });
    expect(r.status).toBe(200);
    expect(r.body.readiness.state).toBe('syncing');
    expect(r.body.readiness.steps.map((s: { key: string; state: string }) => `${s.key}:${s.state}`)).toEqual([
      'linkedin_people:working',
      'linkedin_messages:waiting',
      'email_recent:working',
      'email_older:waiting',
      // jobs are queued, but nothing has come in for them to map yet
      'network:waiting',
    ]);
    expect(r.body.contact).toEqual({
      email: u.email,
      phone: null,
      country: null,
      emailOn: true,
      smsOn: false,
    });
    expect(r.body).toMatchObject({ emailAvailable: true, smsAvailable: false, notifiedAt: null });
    expect((await w.call('/notify/status', {})).status).toBe(401);
    expect((await w.call('/notify/status', {}, { authorization: 'Bearer nope' })).status).toBe(401);
    // another site cannot ask
    const other = await w.handler(
      new Request('https://x/functions/v1/orbit-notify/notify/status', {
        method: 'POST',
        headers: { origin: 'https://evil.test', authorization: `Bearer ${u.token}` },
      }),
    );
    expect(other.status).toBe(403);
  });

  it('keeps a phone number as E.164, turns texting on with it, and refuses a number without its country code', async () => {
    const w = world();
    const u = await signedInUser(t);
    const auth = { authorization: `Bearer ${u.token}` };
    const saved = await w.call('/notify/contact', { phone: '+1 (415) 555-0123', country: 'US' }, auth);
    expect(saved.status).toBe(200);
    expect(saved.body.contact).toMatchObject({
      phone: '+14155550123',
      country: 'US',
      smsOn: true,
      emailOn: true,
    });
    const off = await w.call('/notify/contact', { smsOn: false, emailOn: false }, auth);
    expect(off.body.contact).toMatchObject({ phone: '+14155550123', smsOn: false, emailOn: false });
    const bad = await w.call('/notify/contact', { phone: '4155550123' }, auth);
    expect(bad.status).toBe(400);
    const gone = await w.call('/notify/contact', { phone: null }, auth);
    expect(gone.body.contact).toMatchObject({ phone: null, smsOn: false });
    expect(checkPhone('+44 20 7946 0958', 'GB')).toEqual({ ok: true, e164: '+442079460958', country: 'GB' });
    expect(checkPhone('+0123', 'US').ok).toBe(false);
  });
});

describe('orbit-notify: "Orbit is ready", once', () => {
  it('the sweep is the cron only', async () => {
    const w = world();
    expect((await w.call('/notify/sweep', {})).status).toBe(401);
    expect((await w.call('/notify/sweep', {}, { 'x-orbit-cron': 'wrong' })).status).toBe(401);
    expect((await w.call('/notify/sweep', {}, { 'x-orbit-cron': CRON })).status).toBe(200);
  });

  it('waits while anything is still coming in, then emails and texts once, and never again', async () => {
    const w = world({
      RESEND_API_KEY: 're_placeholder',
      TWILIO_ACCOUNT_SID: 'AC_placeholder',
      TWILIO_AUTH_TOKEN: 'token_placeholder',
      TWILIO_FROM: '+15005550006',
    });
    const u = await signedInUser(t, { firstName: 'Lena' });
    await w.call(
      '/notify/contact',
      { phone: '+14155550199', country: 'US' },
      { authorization: `Bearer ${u.token}` },
    );
    const mine = () =>
      w.net.calls.filter(
        (c) => JSON.stringify(c.body).includes(u.email) || JSON.stringify(c.body).includes('4155550199'),
      );
    // still reading: nothing goes out
    await importAt(u.userId, { gmail: 'deep', linkedin: 'done', jobs: 0 });
    await w.call('/notify/sweep', {}, { 'x-orbit-cron': CRON });
    expect(mine()).toHaveLength(0);
    // everything in, but the network is still being mapped: still nothing
    await importAt(u.userId, { gmail: 'complete', jobs: 2 });
    await w.call('/notify/sweep', {}, { 'x-orbit-cron': CRON });
    expect(mine()).toHaveLength(0);
    // done: one email and one text
    await importAt(u.userId, { jobs: 0 });
    const r = await w.call('/notify/sweep', {}, { 'x-orbit-cron': CRON });
    expect(r.body.told).toBeGreaterThanOrEqual(1);
    const sent = mine();
    expect(sent.map((c) => new URL(c.url).hostname).sort()).toEqual(['api.resend.com', 'api.twilio.com']);
    const email = sent.find((c) => c.url.includes('resend'))!.body as Record<string, any>;
    expect(email).toMatchObject({ to: [u.email], subject: 'Orbit is ready' });
    expect(email.text).toMatch(/^Hi Lena,/);
    expect(email.html).toContain('Open Orbit');
    expect(`${email.text}${email.html.replace(/<[^>]*>/g, ' ')}`).not.toMatch(/[—–!]/);
    const sms = sent.find((c) => c.url.includes('twilio'))!;
    expect(String(sms.body)).toContain('To=%2B14155550199');
    // the status says so, and later sweeps send nothing more
    const s = await w.call('/notify/status', {}, { authorization: `Bearer ${u.token}` });
    expect(s.body.readiness.state).toBe('ready');
    expect(s.body.notifiedAt).toBe(NOW.toISOString());
    await w.call('/notify/sweep', {}, { 'x-orbit-cron': CRON });
    expect(mine()).toHaveLength(2);
  });

  it('with nothing set up to send with, notes it as told without sending; a provider failure is tried again', async () => {
    const quiet = world();
    const u = await signedInUser(t);
    await importAt(u.userId, { gmail: 'complete', linkedin: null, jobs: 0 });
    await t.db
      .sql`delete from orbit.integration_accounts where user_id = ${u.userId}::uuid and provider = 'linkedin'`;
    await quiet.call('/notify/sweep', {}, { 'x-orbit-cron': CRON });
    const [row] = await t.db.sql<{ notified_at: Date | null; notified_via: string[] }>`
      select notified_at, notified_via from orbit.user_notify where user_id = ${u.userId}::uuid`;
    expect(row?.notified_at).not.toBeNull();
    expect(row?.notified_via).toEqual([]);

    // Resend refusing: not marked told, so the next sweep tries again
    const v = await signedInUser(t);
    await importAt(v.userId, { gmail: 'complete', jobs: 0 });
    const failing = world({ RESEND_API_KEY: 're_placeholder' });
    failing.net.use((c) => (c.url.startsWith('https://api.resend.com/') ? jsonRes(500, {}) : undefined));
    await failing.call('/notify/sweep', {}, { 'x-orbit-cron': CRON });
    const [after] = await t.db.sql<{ notified_at: Date | null; last_error: string | null }>`
      select notified_at, last_error from orbit.user_notify where user_id = ${v.userId}::uuid`;
    expect(after?.notified_at).toBeNull();
    expect(after?.last_error).toBe('resend 500');
  });

  it('readiness reached long ago is not news: no late email', async () => {
    const w = world({ RESEND_API_KEY: 're_placeholder' });
    const u = await signedInUser(t);
    await importAt(u.userId, { gmail: 'complete', jobs: 0 });
    await t.db.sql`insert into orbit.user_notify (user_id, ready_at)
                   values (${u.userId}::uuid, ${new Date(NOW.getTime() - (LATE_HOURS + 1) * 3_600_000)})`;
    await w.call('/notify/sweep', {}, { 'x-orbit-cron': CRON });
    expect(w.net.calls.filter((c) => JSON.stringify(c.body).includes(u.email))).toHaveLength(0);
  });

  it('the words: what was read, one button, no em dashes or exclamation marks; the text fits one message', () => {
    const m = readyEmail({
      firstName: 'Ana',
      people: 1240,
      messages: 18_400,
      appUrl: 'https://tryorbit.today',
    });
    expect(m.text).toContain('1,240 people and 18,400 messages are in');
    expect(readyEmail({ firstName: null, people: 0, messages: 0, appUrl: 'https://x' }).text).toMatch(/^Hi,/);
    const sms = readySms({ firstName: 'Ana', appUrl: 'https://tryorbit.today' });
    expect(sms.length).toBeLessThanOrEqual(160);
    expect(`${m.text}${m.html.replace(/<[^>]*>/g, ' ')}${sms}`).not.toMatch(/[—–!]/);
    // a name with markup in it is text in the email, never markup
    expect(
      readyEmail({ firstName: '<b>x</b>', people: 1, messages: 1, appUrl: 'https://x' }).html,
    ).not.toContain('<b>x</b>');
  });
});

describe('orbit-notify: what counts as the import still working', () => {
  it('a send scheduled for later, or one due in an hour, never keeps Orbit from being ready', async () => {
    const w = world();
    const u = await signedInUser(t);
    await importAt(u.userId, { gmail: 'complete', jobs: 0 });
    await t.db.sql`select pgmq.send('orbit_send', ${{ kind: 'send.draft', userId: u.userId }}::jsonb, 0)`;
    await t.db
      .sql`select pgmq.send('orbit_cadence', ${{ kind: 'cadence.user', userId: u.userId }}::jsonb, 0)`;
    await t.db
      .sql`select pgmq.send('orbit_sync', ${{ kind: 'sync.gmail.incremental', userId: u.userId }}::jsonb, 3600)`;
    const s = await w.call('/notify/status', {}, { authorization: `Bearer ${u.token}` });
    expect(s.body.readiness.state).toBe('ready');
    // a read due now is the import still working
    await t.db
      .sql`select pgmq.send('orbit_classify', ${{ kind: 'classify.message', userId: u.userId }}::jsonb, 0)`;
    const busy = await w.call('/notify/status', {}, { authorization: `Bearer ${u.token}` });
    expect(busy.body.readiness.state).toBe('usable');
  });
});
