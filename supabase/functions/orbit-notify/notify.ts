/**
 * orbit-notify (plan 40): is Orbit ready yet, and telling the student when it is.
 *
 *   POST /notify/status   (signed in)  readiness worked out here with @orbit/core's readiness(), the student's contact
 *                                      row, and whether email and texting are set up
 *   POST /notify/contact  (signed in)  { phone?, country?, emailOn?, smsOn? }: a number is checked and kept as E.164
 *   POST /notify/sweep    (pg_cron, x-orbit-cron)  everyone who signed up in the last 7 days and has not been told:
 *                                      when every step of their first import is done, "Orbit is ready" goes out by
 *                                      email (Resend) and by text (Twilio, only with a number and once its keys are
 *                                      saved), once
 *
 * Its own function, so the API and the worker are not redeployed for it. It reads the same rows /sync/status reads.
 * No message text, address or number is ever logged.
 */
import { readiness, type ReadinessInput } from '@orbit/core/sync/readiness';
import { timingSafeEqual } from '../_shared/crypto.ts';
import type { Db } from '../_shared/db.ts';
import { corsHeaders, errorResponse, HttpError, json, preflight, readJson } from '../_shared/http.ts';
import type { QueueName } from '../_shared/queue.ts';
import { checkSession, type SessionConfig, verifyBearer } from '../_shared/session.ts';

export interface NotifyDeps {
  db?: Db;
  origins: (origin: string) => boolean;
  sessionSecret?: string;
  cronSecret?: string;
  /** read when needed, so a key saved later works without a redeploy */
  secret: (name: string) => Promise<string | undefined>;
  appUrl: string;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (line: Record<string, unknown>) => void;
}

/** a student who signed up longer ago than this is past their first import: the sweep leaves them */
export const WAIT_DAYS = 7;
/** readiness reached longer ago than this is not news: no email goes out late for it */
export const LATE_HOURS = 12;
/** the most students one sweep looks at */
export const SWEEP_MAX = 200;

const DAY = 86_400_000;

/** the queues the first import's work runs on; sends and cadence are what Orbit does later, not the import */
export const IMPORT_QUEUES: readonly QueueName[] = ['orbit_sync', 'orbit_classify', 'orbit_score', 'orbit_enrich'];

type ContactRow = {
  phone_e164: string | null;
  phone_country: string | null;
  email_on: boolean;
  sms_on: boolean;
  ready_at: Date | string | null;
  notified_at: Date | string | null;
};

/** What readiness is worked out from, read from the same rows /sync/status reads. */
export async function readinessInput(db: Db, userId: string): Promise<ReadinessInput> {
  const [accounts, counts, pending] = await Promise.all([
    db.sql<{ provider: string; status: string; sync_state: Record<string, Record<string, unknown>> | null }>`
      select provider, status, sync_state from orbit.integration_accounts
       where user_id = ${userId}::uuid and provider in ('google', 'linkedin')`,
    db.sql<{ people: number; messages: number; ties: number }>`
      select
        (select count(*) from orbit.people where user_id = ${userId}::uuid and not is_self
           and deleted_at is null and merged_into is null)::int as people,
        (select count(*) from orbit.messages where user_id = ${userId}::uuid)::int as messages,
        (select count(*) from orbit.ties where user_id = ${userId}::uuid)::int as ties`,
    // the import's own work (reading, classifying, scoring, matching), due now or within a couple of minutes: a send
    // scheduled for tomorrow morning or a cadence check-in next week is not the import, and would keep it waiting
    db.query<{ n: number }>(
      `select (${IMPORT_QUEUES.map(
        (q) =>
          `(select count(*) from pgmq.q_${q} where message->>'userId' = $1 and vt <= now() + interval '2 minutes')`,
      ).join(' + ')})::int as n`,
      [userId],
    ),
  ]);
  const g = accounts.find((a) => a.provider === 'google');
  const li = accounts.find((a) => a.provider === 'linkedin');
  const bf = g?.sync_state?.gmail?.backfill as Record<string, unknown> | undefined;
  const ls = li?.sync_state?.linkedin as Record<string, unknown> | undefined;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    google: g
      ? {
          status: g.status,
          phase: str(bf?.phase) ?? (g.status === 'active' ? 'recent' : null),
          done: Number(bf?.done ?? 0),
          total: bf?.total == null ? null : Number(bf.total),
        }
      : undefined,
    linkedin: li ? { status: li.status, stage: str(ls?.stage), syncedAt: str(ls?.syncedAt) } : undefined,
    pending: pending[0]?.n ?? 0,
    counts: counts[0],
  };
}

async function contactOf(db: Db, userId: string): Promise<ContactRow | undefined> {
  const [row] = await db.sql<ContactRow>`
    select phone_e164, phone_country, email_on, sms_on, ready_at, notified_at
      from orbit.user_notify where user_id = ${userId}::uuid`;
  return row;
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

async function channels(deps: NotifyDeps): Promise<{ email: boolean; sms: boolean }> {
  const [resend, sid, token, from] = await Promise.all([
    deps.secret('RESEND_API_KEY'),
    deps.secret('TWILIO_ACCOUNT_SID'),
    deps.secret('TWILIO_AUTH_TOKEN'),
    deps.secret('TWILIO_FROM'),
  ]);
  return { email: !!resend, sms: !!(sid && token && from) };
}

async function statusOf(deps: NotifyDeps, db: Db, userId: string) {
  const [input, row, user, avail] = await Promise.all([
    readinessInput(db, userId),
    contactOf(db, userId),
    db.sql<{ email: string | null }>`select email from orbit.users where id = ${userId}::uuid`,
    channels(deps),
  ]);
  return {
    readiness: readiness(input),
    contact: {
      email: user[0]?.email ?? null,
      phone: row?.phone_e164 ?? null,
      country: row?.phone_country ?? null,
      emailOn: row?.email_on ?? true,
      smsOn: row?.sms_on ?? false,
    },
    notifiedAt: iso(row?.notified_at),
    emailAvailable: avail.email,
    smsAvailable: avail.sms,
  };
}

/**
 * A number as E.164 with its country, or a plain reason it is not one. The app reads and formats the number with
 * libphonenumber-js and sends E.164 ("+14155550123"); here only the form is checked, so the function carries no phone
 * metadata. A number sent without its "+" is refused rather than guessed at.
 */
export function checkPhone(
  phone: unknown,
  country: unknown,
): { ok: true; e164: string | null; country: string | null } | { ok: false; message: string } {
  if (phone === null || phone === '') return { ok: true, e164: null, country: null };
  if (typeof phone !== 'string' || phone.length > 40) return { ok: false, message: 'That is not a phone number.' };
  const e164 = phone.replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{6,14}$/.test(e164))
    return { ok: false, message: 'That number does not look complete. Check the country code and the digits.' };
  const cc = typeof country === 'string' && /^[A-Z]{2}$/.test(country) ? country : null;
  return { ok: true, e164, country: cc };
}

async function saveContact(db: Db, userId: string, b: Record<string, unknown>, now: Date) {
  const cur = await contactOf(db, userId);
  let phone = cur?.phone_e164 ?? null;
  let country = cur?.phone_country ?? null;
  if ('phone' in b) {
    const p = checkPhone(b.phone, b.country);
    if (!p.ok) throw new HttpError(400, 'bad_phone', p.message);
    phone = p.e164;
    country = p.country;
  }
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const emailOn = bool(b.emailOn, cur?.email_on ?? true);
  // a number given turns texting on unless the student said otherwise; no number, no texts
  const smsOn = phone ? bool(b.smsOn, 'phone' in b && b.phone ? true : (cur?.sms_on ?? false)) : false;
  await db.sql`
    insert into orbit.user_notify (user_id, phone_e164, phone_country, email_on, sms_on, updated_at)
    values (${userId}::uuid, ${phone}, ${country}, ${emailOn}, ${smsOn}, ${now})
    on conflict (user_id) do update set phone_e164 = excluded.phone_e164, phone_country = excluded.phone_country,
      email_on = excluded.email_on, sms_on = excluded.sms_on, updated_at = excluded.updated_at`;
}

// ---- the message ------------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** "Orbit is ready": what was read, and one button back in. Plain words; no em dashes or exclamation marks. */
export function readyEmail(o: { firstName: string | null; people: number; messages: number; appUrl: string }) {
  const hi = o.firstName ? `Hi ${o.firstName},` : 'Hi,';
  const what = [
    o.people ? `${o.people.toLocaleString('en-US')} people` : '',
    o.messages ? `${o.messages.toLocaleString('en-US')} messages` : '',
  ].filter(Boolean);
  const read = what.length
    ? `Orbit finished reading your accounts: ${what.join(' and ')} are in, and your network is mapped.`
    : 'Orbit finished reading your accounts, and your network is mapped.';
  const next = 'Your first suggestions of who to reach out to are waiting.';
  const subject = 'Orbit is ready';
  const text = `${hi}\n\n${read} ${next}\n\nOpen Orbit: ${o.appUrl}\n\nOrbit`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f7f6f3">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f6f3;padding:40px 16px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e9e7e2;border-radius:14px;padding:32px 32px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Helvetica,Arial,sans-serif;color:#1b1b1a">
<tr><td>
<div style="display:inline-block;width:36px;height:36px;border-radius:50%;background:#1b1b1a;color:#ffffff;text-align:center;line-height:36px;font-size:18px">&#10003;</div>
<h1 style="margin:20px 0 8px;font-size:22px;line-height:1.3;font-weight:600">Orbit is ready</h1>
<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#45443f">${esc(hi)}</p>
<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#45443f">${esc(read)} ${esc(next)}</p>
<p style="margin:24px 0 4px"><a href="${esc(o.appUrl)}" style="display:inline-block;background:#1b1b1a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 20px;border-radius:999px">Open Orbit</a></p>
</td></tr></table>
<p style="margin:16px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;color:#8a8780">You asked to hear when Orbit finished setting up. Change this in Settings, Profile.</p>
</td></tr></table></body></html>`;
  return { subject, text, html };
}

export function readySms(o: { firstName: string | null; appUrl: string }): string {
  return `${o.firstName ? `${o.firstName}, ` : ''}Orbit is ready: your network is in and your first suggestions are waiting. ${o.appUrl}`;
}

async function sendEmail(deps: NotifyDeps, to: string, m: { subject: string; text: string; html: string }) {
  const key = await deps.secret('RESEND_API_KEY');
  if (!key) return { ok: false as const, error: 'unconfigured' };
  const from = (await deps.secret('RESEND_FROM')) || 'Orbit <orbit@tryorbit.today>';
  const res = await (deps.fetch ?? fetch)('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject: m.subject, text: m.text, html: m.html }),
  });
  await res.body?.cancel().catch(() => undefined);
  return res.ok ? { ok: true as const } : { ok: false as const, error: `resend ${res.status}` };
}

async function sendSms(deps: NotifyDeps, to: string, body: string) {
  const [sid, token, from] = await Promise.all([
    deps.secret('TWILIO_ACCOUNT_SID'),
    deps.secret('TWILIO_AUTH_TOKEN'),
    deps.secret('TWILIO_FROM'),
  ]);
  if (!sid || !token || !from) return { ok: false as const, error: 'unconfigured' };
  const form = new URLSearchParams({ To: to, Body: body });
  // a Messaging Service id (MG…) or a number
  form.set(from.startsWith('MG') ? 'MessagingServiceSid' : 'From', from);
  const res = await (deps.fetch ?? fetch)(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(`${sid}:${token}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    },
  );
  await res.body?.cancel().catch(() => undefined);
  return res.ok ? { ok: true as const } : { ok: false as const, error: `twilio ${res.status}` };
}

/**
 * One student: when every step is done, note when (ready_at, the first time only) and tell them once. Readiness
 * reached more than LATE_HOURS ago is noted without a message (a key saved days later must not mail old news). A
 * send that fails is retried on the next sweep; one that is not set up (no key) is not.
 */
export async function sweepOne(deps: NotifyDeps, db: Db, userId: string, now: Date) {
  const input = await readinessInput(db, userId);
  const r = readiness(input);
  if (r.state !== 'ready') return { userId, state: r.state, sent: [] as string[] };
  const [row] = await db.sql<ContactRow & { ready_at: Date | null }>`
    insert into orbit.user_notify (user_id, ready_at) values (${userId}::uuid, ${now})
    on conflict (user_id) do update set ready_at = coalesce(orbit.user_notify.ready_at, excluded.ready_at)
    returning phone_e164, phone_country, email_on, sms_on, ready_at, notified_at`;
  if (!row || row.notified_at) return { userId, state: r.state, sent: [] as string[] };
  const readyAt = new Date(row.ready_at ?? now);
  const late = now.getTime() - readyAt.getTime() > LATE_HOURS * 3_600_000;
  const [u] = await db.sql<{ email: string | null; first_name: string | null }>`
    select email, first_name from orbit.users where id = ${userId}::uuid`;
  const sent: string[] = [];
  const errors: string[] = [];
  if (!late) {
    if (row.email_on && u?.email) {
      const m = readyEmail({
        firstName: u.first_name,
        people: input.counts?.people ?? 0,
        messages: input.counts?.messages ?? 0,
        appUrl: deps.appUrl,
      });
      const e = await sendEmail(deps, u.email, m);
      if (e.ok) sent.push('email');
      else errors.push(e.error);
    }
    if (row.sms_on && row.phone_e164) {
      const s = await sendSms(deps, row.phone_e164, readySms({ firstName: u?.first_name ?? null, appUrl: deps.appUrl }));
      if (s.ok) sent.push('sms');
      else errors.push(s.error);
    }
  }
  // told (or too late to tell, or nothing set up to tell with): never again. A real failure is tried next sweep.
  const retry = errors.some((e) => e !== 'unconfigured') && !sent.length;
  if (!retry)
    await db.sql`
      update orbit.user_notify set notified_at = ${now}, notified_via = ${sent}::text[],
             last_error = ${errors.length ? errors.join(', ') : null}, updated_at = ${now}
       where user_id = ${userId}::uuid`;
  else
    await db.sql`update orbit.user_notify set last_error = ${errors.join(', ')}, updated_at = ${now}
                  where user_id = ${userId}::uuid`;
  return { userId, state: r.state, sent, errors };
}

export async function sweep(deps: NotifyDeps, db: Db, now: Date) {
  const since = new Date(now.getTime() - WAIT_DAYS * DAY);
  const users = await db.sql<{ id: string }>`
    select u.id from orbit.users u
     where u.deleted_at is null and u.created_at > ${since}
       and not exists (select 1 from orbit.user_notify n where n.user_id = u.id and n.notified_at is not null)
       and exists (select 1 from orbit.integration_accounts a
                    where a.user_id = u.id and a.status in ('active', 'needs_reauth', 'error')
                      and a.provider in ('google', 'linkedin'))
     order by u.created_at desc
     limit ${SWEEP_MAX}`;
  const out = [];
  for (const u of users) out.push(await sweepOne(deps, db, u.id, now).catch(() => ({ userId: u.id, failed: true })));
  return out;
}

// ---- the handler ------------------------------------------------------------------------------------------------

export function makeNotifyHandler(deps: NotifyDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  return async (req) => {
    const origin = req.headers.get('origin');
    const allowed = !!origin && deps.origins(origin);
    const h = corsHeaders(origin, allowed);
    const path = new URL(req.url).pathname.replace(/^.*\/orbit-notify(?=\/|$)/, '') || '/';
    try {
      if (req.method === 'OPTIONS') {
        if (!allowed) return new Response(null, { status: 403, headers: h });
        return preflight(req, h, 'POST, OPTIONS');
      }
      if (origin && !allowed) throw new HttpError(403, 'forbidden', 'origin not allowed');
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'POST');
      const db = deps.db;
      if (!db) throw new HttpError(503, 'unconfigured', 'no database');

      if (path === '/notify/sweep') {
        if (!deps.cronSecret || !(await timingSafeEqual(req.headers.get('x-orbit-cron'), deps.cronSecret)))
          throw new HttpError(401, 'unauthorized', 'cron only');
        const results = await sweep(deps, db, now());
        const told = results.filter((r) => 'sent' in r && r.sent.length).length;
        deps.log?.({ fn: 'orbit-notify', route: path, looked: results.length, told });
        return json(200, { ok: true, looked: results.length, told }, h);
      }

      if (path !== '/notify/status' && path !== '/notify/contact') throw new HttpError(404, 'not_found', 'no such route');
      if (!deps.sessionSecret) throw new HttpError(503, 'unconfigured', 'no session secret');
      const cfg: SessionConfig = { secret: deps.sessionSecret, now };
      const claims = await verifyBearer(cfg, req.headers.get('authorization'));
      await checkSession(db, cfg, claims);
      if (path === '/notify/contact') await saveContact(db, claims.userId, await readJson(req), now());
      return json(200, await statusOf(deps, db, claims.userId), h);
    } catch (e) {
      return errorResponse(e, h);
    }
  };
}
