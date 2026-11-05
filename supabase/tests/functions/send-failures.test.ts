/**
 * Sending under failure (production readiness): a provider call that fails after the provider may have taken the
 * message, a retry, a worker that died between claiming a draft and recording it, two sends racing one cap. The rule
 * under test everywhere: the recipient never gets the same message twice, and the student always sees where it stands.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCadence } from '../../functions/_shared/cadence/cadence.ts';
import { fromBase64url } from '../../functions/_shared/crypto.ts';
import { NeedsReauth } from '../../functions/_shared/google.ts';
import { recoverStuckSends, SendRetry, sendDraft } from '../../functions/_shared/sending/send.ts';
import { gmailSend, SEND_TIMEOUT_MS } from '../../functions/_shared/sending/transport.ts';
import { makeServices } from '../../functions/_shared/services.ts';
import {
  addPerson,
  addThread,
  agentConfig,
  api,
  DAY,
  fakeNet,
  iso,
  jsonRes,
  type NetCall,
  signedInUser,
  UNIPILE,
} from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const GMAIL_SEND = `${GMAIL}/send`;

type Mode = 'ok' | 'drop_before' | 'drop_after' | 'timeout' | '503_before' | '503_after' | '400';

/**
 * A Gmail that keeps the student's Sent mail and fails the next sends as told: before taking the message (nothing
 * went) or after (it went, but the caller never heard).
 */
function gmail() {
  const sent: {
    id: string;
    threadId: string;
    to: string;
    draftId: string;
    subject?: string;
    snippet?: string;
  }[] = [];
  const next: Mode[] = [];
  const box = { sent, next, probeDown: false, stripHeader: false };
  const answer = (c: NetCall) => {
    if (c.url === GMAIL_SEND) {
      const raw = new TextDecoder().decode(fromBase64url((c.body as { raw: string }).raw));
      const draftId = /X-Orbit-Draft-Id: (\S+)/.exec(raw)?.[1] ?? '';
      const to = /^To: .*<([^>]+)>/m.exec(raw)?.[1] ?? '';
      const subject = /^Subject: (.*)$/m.exec(raw)?.[1]?.trim() ?? '';
      const b64 = raw
        .split(/\r?\n\r?\n/)
        .slice(1)
        .join('')
        .replace(/\s+/g, '');
      const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
      const deliver = () => {
        const id = `gm-${sent.length + 1}`;
        sent.push({ id, threadId: `gt-${id}`, to, draftId, subject, snippet: text.slice(0, 120) });
        return id;
      };
      const mode = next.shift() ?? 'ok';
      if (mode === 'drop_before') throw new TypeError('connection reset');
      if (mode === 'timeout') throw new DOMException('The signal has been aborted', 'TimeoutError');
      if (mode === 'drop_after') {
        deliver();
        throw new TypeError('connection reset');
      }
      if (mode === '503_before') return jsonRes(503, { error: { message: 'backend error' } });
      if (mode === '503_after') {
        deliver();
        return jsonRes(503, { error: { message: 'backend error' } });
      }
      if (mode === '400') return jsonRes(400, { error: { message: 'invalid to' } });
      const id = deliver();
      return jsonRes(200, { id, threadId: `gt-${id}` });
    }
    if (c.url.startsWith(`${GMAIL}?`)) {
      if (box.probeDown) return jsonRes(500, {});
      const q = new URL(c.url).searchParams.get('q') ?? '';
      const to = /to:(\S+)/.exec(q)?.[1];
      return jsonRes(200, {
        messages: sent.filter((m) => m.to === to).map((m) => ({ id: m.id, threadId: m.threadId })),
      });
    }
    if (c.url.startsWith(`${GMAIL}/`)) {
      const id = decodeURIComponent(c.url.slice(GMAIL.length + 1).split('?')[0]!);
      const m = sent.find((x) => x.id === id);
      if (!m) return jsonRes(404, {});
      const headers = [{ name: 'Subject', value: m.subject ?? '' }];
      if (!box.stripHeader) headers.push({ name: 'X-Orbit-Draft-Id', value: m.draftId });
      return jsonRes(200, { id, snippet: m.snippet ?? '', payload: { headers } });
    }
    return undefined;
  };
  return { box, answer };
}

const posts = (net: ReturnType<typeof fakeNet>) => net.calls.filter((c) => c.url === GMAIL_SEND).length;

async function draftRow(id: string) {
  const [d] = await t.db.sql<{ status: string; error: string | null; provider_message_id: string | null }>`
    select status, error, provider_message_id from orbit.drafts where id = ${id}::uuid`;
  return d!;
}

async function actions(id: string) {
  const rows = await t.db.sql<{ action: string }>`
    select action from orbit.audit_log where target_id = ${id} order by id`;
  return rows.map((r) => r.action);
}

/** A first message the student approved, its time come, ready for the send job. */
async function dueDraft(net: ReturnType<typeof fakeNet>, name: string, email: string) {
  const call = api(t, net, { env: {} });
  const { userId, token } = await signedInUser(t);
  const p = await addPerson(t, userId, { name, email });
  const c = await call<{ draft: { id: string } }>('/drafts/compose', token, {
    personId: p,
    kind: 'first_touch',
    channel: 'gmail',
  });
  expect(c.status).toBe(200);
  const id = c.body.draft.id;
  const a = await call('/drafts/approve', token, {
    draftId: id,
    sendAt: new Date(Date.now() + DAY).toISOString(),
  });
  expect(a.status).toBe(200);
  await t.db.sql`update orbit.drafts set send_at = now() - interval '1 minute' where id = ${id}::uuid`;
  return { id, userId, token, call };
}

describe('Gmail sends that fail after Gmail may have taken them', () => {
  it('a connection dropped after Gmail took the message: the retry finds the copy in Sent and sends nothing more', async () => {
    const g = gmail();
    const net = fakeNet(g.answer);
    const { id } = await dueDraft(net, 'Dana Drop', 'dana@example.com');
    const s = makeServices(agentConfig(net, {}), { db: t.db });
    g.box.next.push('drop_after');
    await expect(sendDraft(s, id)).rejects.toBeInstanceOf(SendRetry);
    expect(await draftRow(id)).toMatchObject({ status: 'approved', error: 'network' });
    expect(await actions(id)).toContain('draft.send_unconfirmed');
    // the queue's retry
    expect(await sendDraft(s, id)).toEqual({ status: 'sent', providerMessageId: 'gm-1' });
    expect(g.box.sent).toHaveLength(1);
    expect(posts(net)).toBe(1);
    expect(await draftRow(id)).toMatchObject({ status: 'sent', provider_message_id: 'gm-1', error: null });
    // a third, late duplicate job claims nothing
    expect(await sendDraft(s, id)).toEqual({ status: 'skipped', reason: 'not_claimed' });
    expect(g.box.sent).toHaveLength(1);
  });

  it('a 503 after Gmail took it is not sent twice; a 503 before it is sent exactly once on the retry', async () => {
    const g = gmail();
    const net = fakeNet(g.answer);
    const s = makeServices(agentConfig(net, {}), { db: t.db });
    const took = await dueDraft(net, 'Ari After', 'ari@example.com');
    g.box.next.push('503_after');
    await expect(sendDraft(s, took.id)).rejects.toBeInstanceOf(SendRetry);
    expect((await sendDraft(s, took.id)).status).toBe('sent');
    expect(g.box.sent.filter((m) => m.draftId === took.id)).toHaveLength(1);

    const lost = await dueDraft(net, 'Bo Before', 'bo@example.com');
    g.box.next.push('503_before');
    await expect(sendDraft(s, lost.id)).rejects.toBeInstanceOf(SendRetry);
    expect(g.box.sent.filter((m) => m.draftId === lost.id)).toHaveLength(0);
    expect((await sendDraft(s, lost.id)).status).toBe('sent');
    expect(g.box.sent.filter((m) => m.draftId === lost.id)).toHaveLength(1);
  });

  it('a Sent copy that came back without the draft id header is still found by its subject and opening words', async () => {
    const g = gmail();
    g.box.stripHeader = true;
    const net = fakeNet(g.answer);
    const s = makeServices(agentConfig(net, {}), { db: t.db });
    const { id } = await dueDraft(net, 'Hal Header', 'hal@example.com');
    g.box.next.push('drop_after');
    await expect(sendDraft(s, id)).rejects.toBeInstanceOf(SendRetry);
    expect(await sendDraft(s, id)).toEqual({ status: 'sent', providerMessageId: 'gm-1' });
    expect(posts(net)).toBe(1);
  });

  it('a 429 is a clean refusal: retried without looking in Sent, sent once', async () => {
    const g = gmail();
    const net = fakeNet(
      (c) => (c.url === GMAIL_SEND && posts(net) === 1 ? jsonRes(429, {}) : undefined),
      g.answer,
    );
    const s = makeServices(agentConfig(net, {}), { db: t.db });
    const { id } = await dueDraft(net, 'Rio Rate', 'rio@example.com');
    await expect(sendDraft(s, id)).rejects.toBeInstanceOf(SendRetry);
    expect(await actions(id)).not.toContain('draft.send_unconfirmed');
    expect((await sendDraft(s, id)).status).toBe('sent');
    expect(net.calls.filter((c) => c.url.startsWith(`${GMAIL}?`))).toHaveLength(0);
    expect(g.box.sent).toHaveLength(1);
  });

  it('a send call that times out counts as unconfirmed, and the send call carries a timeout', async () => {
    const g = gmail();
    const net = fakeNet(g.answer);
    const s = makeServices(agentConfig(net, {}), { db: t.db });
    const { id } = await dueDraft(net, 'Tia Time', 'tia@example.com');
    g.box.next.push('timeout');
    await expect(sendDraft(s, id)).rejects.toBeInstanceOf(SendRetry);
    expect(await actions(id)).toContain('draft.send_unconfirmed');
    expect((await sendDraft(s, id)).status).toBe('sent');
    expect(g.box.sent).toHaveLength(1);
    // the provider call is bounded, so a hung Gmail never holds the worker until the isolate dies mid-send
    let signal: AbortSignal | null | undefined;
    const spy = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return jsonRes(200, { id: 'x' });
    }) as typeof fetch;
    await gmailSend({ ...s, fetch: spy }, 'u', 'raw', null);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(SEND_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it('when Gmail cannot say whether the earlier try went, it waits rather than risk a second copy', async () => {
    const g = gmail();
    const net = fakeNet(g.answer);
    const s = makeServices(agentConfig(net, {}), { db: t.db });
    const { id } = await dueDraft(net, 'Uma Unsure', 'uma@example.com');
    g.box.next.push('drop_after');
    await expect(sendDraft(s, id)).rejects.toBeInstanceOf(SendRetry);
    g.box.probeDown = true;
    await expect(sendDraft(s, id)).rejects.toBeInstanceOf(SendRetry);
    expect(await draftRow(id)).toMatchObject({ status: 'approved', error: 'send_unconfirmed' });
    expect(posts(net)).toBe(1);
    g.box.probeDown = false;
    expect(await sendDraft(s, id)).toEqual({ status: 'sent', providerMessageId: 'gm-1' });
    expect(posts(net)).toBe(1);
  });

  it('a permanent 400 fails once with the reason on the draft, is not retried, and pauses autopilot for the goal', async () => {
    const g = gmail();
    const net = fakeNet(g.answer);
    const s = makeServices(agentConfig(net, {}), { db: t.db });
    const { id, userId } = await dueDraft(net, 'Fay Fail', 'fay@example.com');
    g.box.next.push('400');
    expect(await sendDraft(s, id)).toEqual({ status: 'failed', error: 'gmail_400' });
    expect(await draftRow(id)).toMatchObject({ status: 'failed', error: 'gmail_400' });
    expect(await actions(id)).toContain('draft.failed');
    expect(await sendDraft(s, id)).toEqual({ status: 'skipped', reason: 'not_claimed' });
    expect(posts(net)).toBe(1);
    const trips = await t.db.sql<{ details: Record<string, unknown> }>`
      select details from orbit.audit_log where user_id = ${userId}::uuid and action = 'autopilot.breaker'`;
    expect(trips).toHaveLength(1);
    expect(JSON.stringify(trips[0]!.details)).toContain('send_error');
  });

  it('Google access revoked: the send fails as needs_reauth without a provider call or a retry', async () => {
    const g = gmail();
    const net = fakeNet(g.answer);
    const cfg = {
      ...agentConfig(net, {}),
      tokens: {
        accessToken: async () => {
          throw new NeedsReauth();
        },
        invalidate: () => {},
      },
    };
    const s = makeServices(cfg, { db: t.db });
    const { id } = await dueDraft(net, 'Rex Reauth', 'rex@example.com');
    expect(await sendDraft(s, id)).toEqual({ status: 'failed', error: 'needs_reauth' });
    expect(posts(net)).toBe(0);
  });
});

describe('a worker that died between claiming a draft and recording the send', () => {
  it('the hourly scan puts it back marked unconfirmed; Gmail had taken it, so it is recorded and not resent', async () => {
    const g = gmail();
    const net = fakeNet(g.answer);
    const { id, userId } = await dueDraft(net, 'Sol Stuck', 'sol@example.com');
    // the claim happened and the message went, then the isolate died before the record
    await t.db.sql`update orbit.drafts set status = 'sending' where id = ${id}::uuid`;
    g.box.sent.push({ id: 'gm-early', threadId: 'gt-early', to: 'sol@example.com', draftId: id });
    const s = makeServices(agentConfig(net, {}), { db: t.db });
    // not yet stuck: a send can be in flight for a few seconds
    expect(await recoverStuckSends(s, userId)).toBe(0);
    expect((await draftRow(id)).status).toBe('sending');
    const later = makeServices(agentConfig(net, {}), {
      db: t.db,
      now: () => new Date(Date.now() + 11 * 60_000),
    });
    const sum = await runCadence(later, userId);
    expect(sum.recovered).toBe(1);
    expect(await draftRow(id)).toMatchObject({ status: 'approved', error: 'send_interrupted' });
    const jobs = await t.db.sql<{ message: { dedupeKey: string } }>`
      select message from pgmq.q_orbit_send where message->'payload'->>'draftId' = ${id}`;
    expect(jobs.some((j) => j.message.dedupeKey.startsWith(`send:${id}:recover:`))).toBe(true);
    expect(await sendDraft(later, id)).toEqual({ status: 'sent', providerMessageId: 'gm-early' });
    expect(posts(net)).toBe(0);
  });

  it('it had not gone yet: recovered and sent exactly once', async () => {
    const g = gmail();
    const net = fakeNet(g.answer);
    const { id, userId } = await dueDraft(net, 'Neo Never', 'neo@example.com');
    await t.db.sql`update orbit.drafts set status = 'sending' where id = ${id}::uuid`;
    const later = makeServices(agentConfig(net, {}), {
      db: t.db,
      now: () => new Date(Date.now() + 11 * 60_000),
    });
    expect(await recoverStuckSends(later, userId)).toBe(1);
    expect((await sendDraft(later, id)).status).toBe('sent');
    expect(g.box.sent).toHaveLength(1);
  });
});

describe('LinkedIn sends that fail', () => {
  async function liDraft(net: ReturnType<typeof fakeNet>) {
    const call = api(t, net, { env: { unipileKey: 'unipile-placeholder', unipileBase: UNIPILE } });
    const { userId, token } = await signedInUser(t);
    await t.db.sql`insert into orbit.integration_accounts (user_id, provider, external_account_id, status)
      values (${userId}::uuid, 'linkedin', 'acc-li', 'active')`;
    const p = await addPerson(t, userId, { name: 'Lou Link', memberId: 'ACoAALou', score: 45 });
    await addThread(
      t,
      userId,
      p,
      [{ direction: 'out', at: iso(10 * DAY), body: 'Hi Lou, great to connect.' }],
      {
        provider: 'linkedin',
        externalId: 'chat-lou',
      },
    );
    const c = await call<{ draft: { id: string } }>('/drafts/compose', token, {
      personId: p,
      kind: 'bump',
      channel: 'linkedin',
    });
    return { id: c.body.draft.id, call, token };
  }

  it('a 5xx or dropped connection on LinkedIn is never resent on its own: it fails and asks the student to check', async () => {
    const net = fakeNet((c) => (c.url.startsWith(UNIPILE) ? jsonRes(502, {}) : undefined));
    const { id, call, token } = await liDraft(net);
    const r = await call<{ draft: { status: string } }>('/drafts/approve', token, {
      draftId: id,
      confirm: true,
    });
    expect(r.status).toBe(200);
    expect(r.body.draft.status).toBe('failed');
    expect(await draftRow(id)).toMatchObject({ status: 'failed', error: 'linkedin_unconfirmed' });
    const jobs = await t.db.sql`select 1 from pgmq.q_orbit_send where message->'payload'->>'draftId' = ${id}`;
    expect(jobs).toHaveLength(0);
    expect(net.calls.filter((c) => c.url.startsWith(UNIPILE))).toHaveLength(1);
  });

  it('a LinkedIn 429 is a clean refusal and goes back to the queue', async () => {
    const net = fakeNet((c) => (c.url.startsWith(UNIPILE) ? jsonRes(429, {}) : undefined));
    const { id, call, token } = await liDraft(net);
    const r = await call<{ draft: { status: string } }>('/drafts/approve', token, {
      draftId: id,
      confirm: true,
    });
    expect(r.body.draft.status).toBe('approved');
    const jobs = await t.db.sql`select 1 from pgmq.q_orbit_send where message->'payload'->>'draftId' = ${id}`;
    expect(jobs).toHaveLength(1);
  });
});

describe('caps when sends race', () => {
  it('three due sends at once with one slot left under the daily limit: exactly one goes, the others wait', async () => {
    const g = gmail();
    const net = fakeNet(g.answer);
    const call = api(t, net, { env: {} });
    const { userId, token } = await signedInUser(t, { settings: { daily_send_cap_gmail: 2 } });
    const ids: string[] = [];
    for (const n of ['One', 'Two', 'Three', 'Four']) {
      const p = await addPerson(t, userId, { name: `Cap ${n}`, email: `cap-${n.toLowerCase()}@example.com` });
      const c = await call<{ draft: { id: string } }>('/drafts/compose', token, {
        personId: p,
        kind: 'first_touch',
        channel: 'gmail',
      });
      await call('/drafts/approve', token, {
        draftId: c.body.draft.id,
        sendAt: new Date(Date.now() + DAY).toISOString(),
      });
      ids.push(c.body.draft.id);
    }
    await t.db
      .sql`update orbit.drafts set send_at = now() - interval '1 minute' where id = any(${ids}::uuid[])`;
    const s = makeServices(agentConfig(net, {}), { db: t.db });
    expect((await sendDraft(s, ids[0]!)).status).toBe('sent');
    const results = await Promise.all(ids.slice(1).map((id) => sendDraft(s, id)));
    expect(results.filter((r) => r.status === 'sent')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'held').map((r) => 'reason' in r && r.reason)).toEqual([
      'gmail_daily_cap',
      'gmail_daily_cap',
    ]);
    expect(g.box.sent).toHaveLength(2);
  });
});
