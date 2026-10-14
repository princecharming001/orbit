/**
 * orbit-webhooks: inbound pushes from Google Pub/Sub (Gmail) and Unipile (LinkedIn), §12.2 and §12.4. Each one is
 * authenticated by a shared secret compared in constant time, answered fast, and turned into a queued job; nothing
 * slow happens here.
 *
 *   POST /gmail?token=ORBIT_PUBSUB_TOKEN                Pub/Sub push → sync.gmail.incremental (gmail:<user>:<historyId>)
 *   POST /unipile          x-orbit-webhook: secret      message_received → the message stored in its LinkedIn thread
 *                                                        + classify.message (the user's own: stored outbound only),
 *                                                        new_relation → the person and identities + score.person,
 *                                                        account status → the account row
 *   POST /unipile/account?token=ORBIT_UNIPILE_WEBHOOK_SECRET
 *                                                        hosted-auth notify: CREATION_SUCCESS | RECONNECTED → the
 *                                                        user's linkedin account (user id = payload.name) + backfill
 */
import { isUuid, timingSafeEqual } from '../_shared/crypto.ts';
import type { Db } from '../_shared/db.ts';
import {
  HttpError,
  json,
  type Logger,
  readJson,
  requestId,
  silentLogger,
  unconfigured,
} from '../_shared/http.ts';
import {
  CHAT_MAX_ATTENDEES,
  type ChatAttendeeInput,
  ingestRelations,
  storeChat,
} from '../_shared/ingest/linkedin.ts';
import { loadSelf } from '../_shared/ingest/util.ts';
import { type Queue, sqlQueue } from '../_shared/queue.ts';

export interface WebhookDeps {
  db: Db | undefined;
  pubsubToken: string | undefined;
  unipileSecret: string | undefined;
  queue?: Queue;
  log?: Logger;
}

export function makeWebhookHandler(deps: WebhookDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? silentLogger;
  return async (req) => {
    const started = Date.now();
    const rid = requestId(req);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^.*\/orbit-webhooks(?=\/|$)/, '') || '/';
    let res: Response;
    let userId: string | null = null;
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'POST only');
      const queue = () => deps.queue ?? sqlQueue(deps.db!);
      if (path === '/gmail') {
        if (!deps.pubsubToken || !deps.db) return unconfigured();
        if (!(await timingSafeEqual(url.searchParams.get('token'), deps.pubsubToken)))
          throw new HttpError(403, 'forbidden', 'bad token');
        userId = await gmailPush(deps.db, queue(), await body(req, 100_000));
        res = new Response(null, { status: 204 });
      } else if (path === '/unipile') {
        if (!deps.unipileSecret || !deps.db) return unconfigured();
        if (!(await timingSafeEqual(req.headers.get('x-orbit-webhook'), deps.unipileSecret)))
          throw new HttpError(401, 'unauthorized', 'bad signature');
        const out = await unipileEvent(deps.db, (db) => deps.queue ?? sqlQueue(db), await body(req));
        userId = out.userId;
        res = json(200, { ok: true, result: out.result });
      } else if (path === '/unipile/account') {
        if (!deps.unipileSecret || !deps.db) return unconfigured();
        if (!(await timingSafeEqual(url.searchParams.get('token'), deps.unipileSecret)))
          throw new HttpError(403, 'forbidden', 'bad token');
        const out = await unipileAccount(deps.db, queue(), await body(req));
        userId = out.userId;
        res = json(200, { ok: true, result: out.result });
      } else throw new HttpError(404, 'not_found', 'no such route');
    } catch (e) {
      // a provider retries on 5xx: worth it when the database hiccups, never for a bad secret or route
      res =
        e instanceof HttpError
          ? json(e.status, { error: { code: e.code, message: e.message } })
          : json(503, { error: { code: 'unavailable', message: 'try again' } });
    }
    await log.log({
      fn: 'orbit-webhooks',
      route: path,
      request_id: rid,
      status: res.status,
      duration_ms: Date.now() - started,
      userId,
    });
    return res;
  };
}

/** The JSON body; one that can never parse is acknowledged as empty so the provider stops retrying it. */
async function body(req: Request, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  try {
    return await readJson(req, { optional: true, maxBytes });
  } catch {
    return {};
  }
}

/** Decodes a Pub/Sub push envelope's `message.data` into Gmail's notification. */
export function decodePubSub(
  body: Record<string, unknown>,
): { emailAddress: string; historyId: string } | undefined {
  const message = body.message as { data?: unknown } | undefined;
  if (!message || typeof message.data !== 'string') return undefined;
  try {
    const bin = atob(message.data.replace(/-/g, '+').replace(/_/g, '/'));
    const text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const data = JSON.parse(text) as { emailAddress?: unknown; historyId?: unknown };
    if (
      typeof data.emailAddress !== 'string' ||
      (typeof data.historyId !== 'string' && typeof data.historyId !== 'number')
    )
      return undefined;
    const historyId = String(data.historyId);
    if (!/^\d{1,30}$/.test(historyId)) return undefined;
    return { emailAddress: data.emailAddress, historyId };
  } catch {
    return undefined;
  }
}

/** Gmail push → one incremental sync per user per historyId. Unknown or malformed pushes are acknowledged. */
export async function gmailPush(db: Db, queue: Queue, body: Record<string, unknown>): Promise<string | null> {
  const n = decodePubSub(body);
  if (!n) return null;
  const [acct] = await db.sql<{ user_id: string }>`
    select a.user_id from orbit.integration_accounts a join orbit.users u on u.id = a.user_id
     where a.provider = 'google' and lower(a.email) = lower(${n.emailAddress}) and a.status = 'active'
       and u.deleted_at is null
     limit 1`;
  if (!acct) return null;
  await queue.enqueue({
    kind: 'sync.gmail.incremental',
    userId: acct.user_id,
    payload: { historyId: n.historyId, reason: 'push' },
    dedupeKey: `gmail:${acct.user_id}:${n.historyId}`,
  });
  return acct.user_id;
}

/** Unipile account status → Orbit's integration status. */
export function accountStatus(
  message: string,
): 'active' | 'needs_reauth' | 'error' | 'connecting' | 'revoked' | undefined {
  const m = message.toUpperCase();
  if (['OK', 'SYNC_SUCCESS', 'RECONNECTED', 'CREATION_SUCCESS'].includes(m)) return 'active';
  if (m === 'CREDENTIALS') return 'needs_reauth';
  if (m === 'CONNECTING') return 'connecting';
  if (m === 'DELETED') return 'revoked';
  if (['ERROR', 'STOPPED', 'PERMISSIONS'].includes(m)) return 'error';
  return undefined;
}

/**
 * A message_received event: the message is stored in its LinkedIn thread (chats with more than 3 people are not
 * relationships and are skipped). The user's own message is stored as outbound and nothing else happens; a message
 * from someone else is classified and its sender re-scored.
 */
async function storeLinkedinMessage(
  db: Db,
  queue: Queue,
  userId: string,
  body: Record<string, unknown>,
  chatId: string,
  messageId: string,
): Promise<string> {
  const accountUser = str((body.account_info as { user_id?: unknown } | undefined)?.user_id);
  const sender = (body.sender ?? {}) as Record<string, unknown>;
  const senderId = str(sender.attendee_provider_id);
  const self = await loadSelf(db, userId);
  const ownIds = new Set([...self.memberIds, ...(accountUser ? [accountUser] : [])]);
  // the user's own messages come through this hook too (§12.3)
  const own = !!senderId && ownIds.has(senderId);
  const raw = Array.isArray(body.attendees) ? (body.attendees as Record<string, unknown>[]) : [];
  const attendees: ChatAttendeeInput[] = [];
  for (const a of [sender, ...raw]) {
    const providerId = str(a.attendee_provider_id);
    if (!providerId || attendees.some((x) => x.providerId === providerId)) continue;
    attendees.push({
      providerId,
      attendeeId: str(a.attendee_id) ?? null,
      name: str(a.attendee_name) ?? null,
      profileUrl: str(a.attendee_profile_url) ?? null,
      isSelf: ownIds.has(providerId),
    });
  }
  const people = attendees.filter((a) => !a.isSelf).length + 1;
  if (people > CHAT_MAX_ATTENDEES) return own ? 'own_message' : 'group_chat';
  const stored = await storeChat(
    db,
    userId,
    self,
    { id: chatId, attendees },
    [
      {
        id: messageId,
        text: str(body.message) ?? null,
        senderId: senderId ?? null,
        timestamp: str(body.timestamp) ?? new Date().toISOString(),
        isSender: own,
      },
    ],
    new Date(),
    ownIds,
  );
  if (own) return 'own_message';
  const row = stored.inbound[0];
  await queue.enqueue({
    kind: 'classify.message',
    userId,
    payload: {
      provider: 'linkedin',
      accountId: body.account_id,
      chatId,
      messageId,
      messageRowId: row?.id ?? null,
      timestamp: str(body.timestamp) ?? null,
    },
    dedupeKey: `classify:linkedin:${userId}:${messageId}`,
  });
  if (stored.personIds.length)
    await queue.enqueue({
      kind: 'score.person',
      userId,
      payload: { personIds: stored.personIds },
      dedupeKey: `score.person:${userId}:message:${messageId}`,
    });
  return 'queued';
}

async function firstSeen(db: Db, eventId: string): Promise<boolean> {
  const rows = await db.sql`
    insert into orbit.webhook_events (provider, event_id) values ('unipile', ${eventId})
    on conflict do nothing returning event_id`;
  return rows.length > 0;
}

async function linkedinUser(db: Db, accountId: unknown): Promise<string | null> {
  if (typeof accountId !== 'string' || !accountId) return null;
  const [row] = await db.sql<{ user_id: string }>`
    select a.user_id from orbit.integration_accounts a join orbit.users u on u.id = a.user_id
     where a.provider = 'linkedin' and a.external_account_id = ${accountId} and u.deleted_at is null
     limit 1`;
  return row?.user_id ?? null;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

export async function unipileEvent(
  db: Db,
  queueFor: (db: Db) => Queue,
  body: Record<string, unknown>,
): Promise<{ result: string; userId: string | null }> {
  // account status webhooks wrap their fields in AccountStatus
  const status = body.AccountStatus as Record<string, unknown> | undefined;
  if (status && typeof status === 'object') {
    const userId = await linkedinUser(db, status.account_id);
    const next = accountStatus(String(status.message ?? ''));
    if (!userId || !next) return { result: 'ignored', userId };
    await db.sql`
      update orbit.integration_accounts
         set status = ${next}, last_error = ${next === 'active' ? null : String(status.message).slice(0, 40)}
       where user_id = ${userId}::uuid and provider = 'linkedin'`;
    return { result: `status:${next}`, userId };
  }

  const event = str(body.event);
  if (event === 'message_received') {
    const messageId = str(body.message_id);
    const chatId = str(body.chat_id);
    if (!messageId || !chatId) return { result: 'ignored', userId: null };
    const userId = await linkedinUser(db, body.account_id);
    if (!userId) return { result: 'unknown_account', userId: null };
    // the event id is recorded in the same transaction as the message, so a failed write is retried, not lost
    const result = await db.begin(async (tx) => {
      if (!(await firstSeen(tx, messageId))) return 'duplicate';
      return storeLinkedinMessage(tx, queueFor(tx), userId, body, chatId, messageId);
    });
    return { result, userId };
  }

  if (event === 'new_relation') {
    const providerId = str(body.user_provider_id);
    const userId = await linkedinUser(db, body.account_id);
    if (!providerId || !userId) return { result: userId ? 'ignored' : 'unknown_account', userId };
    const result = await db.begin(async (tx) => {
      if (!(await firstSeen(tx, `relation:${body.account_id}:${providerId}`))) return 'duplicate';
      const now = new Date();
      const r = await ingestRelations(
        tx,
        userId,
        [
          {
            memberId: providerId,
            publicIdentifier: str(body.user_public_identifier) ?? null,
            profileUrl: str(body.user_profile_url) ?? null,
            fullName: str(body.user_full_name) ?? null,
            headline: str(body.user_headline) ?? null,
            photoUrl: str(body.user_picture_url) ?? null,
            connectedAt: now.toISOString(),
          },
        ],
        now,
      );
      const personIds = [...r.byMember.values()];
      if (personIds.length)
        await queueFor(tx).enqueue({
          kind: 'score.person',
          userId,
          payload: { personIds },
          dedupeKey: `score.person:${userId}:relation:${providerId}`,
        });
      return 'stored';
    });
    return { result, userId };
  }

  return { result: 'ignored', userId: null };
}

/** Unipile's hosted-auth notify_url: the account was created (or reconnected) for the Orbit user named in `name`. */
export async function unipileAccount(
  db: Db,
  queue: Queue,
  body: Record<string, unknown>,
): Promise<{ result: string; userId: string | null }> {
  const status = String(body.status ?? '').toUpperCase();
  const accountId = str(body.account_id);
  const userId = isUuid(body.name) ? body.name : null;
  if (!['CREATION_SUCCESS', 'RECONNECTED'].includes(status) || !accountId || !userId)
    return { result: 'ignored', userId };
  const [user] = await db.sql`select 1 from orbit.users where id = ${userId}::uuid and deleted_at is null`;
  if (!user) return { result: 'unknown_user', userId: null };
  const taken = await db.sql`
    select 1 from orbit.integration_accounts
     where provider = 'linkedin' and external_account_id = ${accountId} and user_id <> ${userId}::uuid`;
  if (taken.length) return { result: 'account_in_use', userId };
  await db.sql`
    insert into orbit.integration_accounts (user_id, provider, external_account_id, status, last_error)
    values (${userId}::uuid, 'linkedin', ${accountId}, 'active', null)
    on conflict (user_id, provider) do update set
      external_account_id = excluded.external_account_id, status = 'active', last_error = null`;
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, details)
    values (${userId}::uuid, 'system', 'linkedin.connected', 'integration_accounts', ${{ status }}::jsonb)`;
  await queue.enqueue({
    kind: 'sync.linkedin',
    userId,
    payload: { mode: 'backfill', accountId },
    dedupeKey: `linkedin-backfill:${userId}:${accountId}`,
  });
  return { result: 'connected', userId };
}
