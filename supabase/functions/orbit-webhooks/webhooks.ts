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
 *   POST /unipile/account?token=ORBIT_UNIPILE_WEBHOOK_SECRET[&provider=instagram]
 *                                                        hosted-auth notify: CREATION_SUCCESS | RECONNECTED → the
 *                                                        user's linkedin (or instagram) account (user id =
 *                                                        payload.name) + backfill (or the first days)
 *
 * Instagram (plan 43): a message on an Instagram account goes to the personal lane (_shared/social/chats.ts), never
 * to the LinkedIn chat writer, and only while the student has Instagram on; account status events update whichever
 * account they name.
 */
import type { OptionalSource } from '@orbit/core/sources';
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
import type { SocialMessage } from '../_shared/social/adapter.ts';
import { afterInbound, storeSocialChat } from '../_shared/social/chats.ts';
import { isOffered, sourceIsOn } from '../_shared/sources/states.ts';

export interface WebhookDeps {
  db: Db | undefined;
  pubsubToken: string | undefined;
  unipileSecret: string | undefined;
  queue?: Queue;
  log?: Logger;
  /**
   * ORBIT_EXTRA_SOURCES (plan 43 §3.1), read once at cold start: the owner's env list. A writer for an optional source
   * asks `sourceIsOn(db, userId, source, offered)` before it stores anything; the owner's launch switches are joined
   * to this list there (`offeredNow`), so a source launched or stopped from Settings takes effect within a minute.
   */
  offered?: OptionalSource[];
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
        const out = await unipileEvent(
          deps.db,
          (db) => deps.queue ?? sqlQueue(db),
          await body(req),
          deps.offered ?? [],
        );
        userId = out.userId;
        res = json(200, { ok: true, result: out.result });
      } else if (path === '/unipile/account') {
        if (!deps.unipileSecret || !deps.db) return unconfigured();
        if (!(await timingSafeEqual(url.searchParams.get('token'), deps.unipileSecret)))
          throw new HttpError(403, 'forbidden', 'bad token');
        const provider = url.searchParams.get('provider') === 'instagram' ? 'instagram' : 'linkedin';
        const out = await unipileAccount(deps.db, queue(), await body(req), provider, deps.offered ?? []);
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
  const a = await unipileOwner(db, accountId);
  return a?.provider === 'linkedin' ? a.userId : null;
}

/** Whose Unipile account an event names, and which of their accounts it is (LinkedIn or Instagram). */
async function unipileOwner(
  db: Db,
  accountId: unknown,
): Promise<{ userId: string; provider: 'linkedin' | 'instagram'; socialAccountId: string | null } | null> {
  if (typeof accountId !== 'string' || !accountId) return null;
  const [row] = await db.sql<{
    user_id: string;
    provider: 'linkedin' | 'instagram';
    social_account_id: string | null;
  }>`
    select a.user_id, a.provider, a.social_account_id from orbit.integration_accounts a
      join orbit.users u on u.id = a.user_id
     where a.provider in ('linkedin', 'instagram') and a.external_account_id = ${accountId} and u.deleted_at is null
     order by (a.provider = 'linkedin') desc
     limit 1`;
  return row ? { userId: row.user_id, provider: row.provider, socialAccountId: row.social_account_id } : null;
}

/**
 * An Instagram message_received (plan 43 §3.9, §4 "Replies"): into the personal lane, keyed by Instagram's own id.
 * The student's own messages come through this hook too (the sender is the account's own user); one Orbit already
 * recorded when it sent it is not stored twice. A chat partner is offered to matching; a message on a chat the
 * student is waiting on moves it to "replied".
 */
async function storeInstagramMessage(
  db: Db,
  queue: Queue,
  owner: { userId: string; socialAccountId: string | null },
  body: Record<string, unknown>,
  chatId: string,
  messageId: string,
): Promise<string> {
  const userId = owner.userId;
  const me =
    str((body.account_info as { user_id?: unknown } | undefined)?.user_id) ?? owner.socialAccountId ?? '';
  const sender = (body.sender ?? {}) as Record<string, unknown>;
  const senderId = str(sender.attendee_provider_id) ?? '';
  const fromStudent = !!senderId && senderId === me;
  const external = str(body.provider_message_id) ?? messageId;
  if (fromStudent) {
    const sent = await db.sql`
      select 1 from orbit.messages where user_id = ${userId}::uuid and provider = 'instagram'
         and external_id in (${messageId}, ${external})`;
    if (sent.length) return 'own_message';
  }
  const raw = Array.isArray(body.attendees) ? (body.attendees as Record<string, unknown>[]) : [];
  const others: { accountId: string; name?: string }[] = [];
  const everyone = new Set<string>(me ? [me] : []);
  for (const a of [sender, ...raw]) {
    const id = str(a.attendee_provider_id);
    if (!id) continue;
    everyone.add(id);
    if (id === me || others.some((o) => o.accountId === id)) continue;
    others.push({ accountId: id, name: str(a.attendee_name) });
  }
  const text = (str(body.message) ?? '').trim();
  const at = str(body.timestamp);
  const m: SocialMessage = {
    messageId: external,
    chatId,
    at: at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString(),
    fromStudent,
    senderAccountId: senderId,
    text,
    hasWords: !!text,
  };
  const now = new Date();
  const stored = await storeSocialChat(
    db,
    userId,
    'instagram',
    { chatId, participants: Math.max(everyone.size, others.length + 1), others },
    [m],
    { now },
  );
  if (stored.skipped) return 'group_chat';
  if (stored.partner && !stored.partner.personId)
    await queue.enqueue({
      kind: 'social.match',
      userId,
      payload: { platform: 'instagram', accountIds: [stored.partner.accountId] },
      dedupeKey: `social.match:${userId}:instagram:${stored.partner.accountId}`,
    });
  if (fromStudent) return 'own_message';
  const r = await afterInbound(db, queue, userId, 'instagram', stored, now);
  return r.replied.length ? 'replied' : 'stored';
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

export async function unipileEvent(
  db: Db,
  queueFor: (db: Db) => Queue,
  body: Record<string, unknown>,
  /** the owner's env list (ORBIT_EXTRA_SOURCES); the launch switches are joined to it */
  offered: readonly OptionalSource[] = [],
): Promise<{ result: string; userId: string | null }> {
  // account status webhooks wrap their fields in AccountStatus
  const status = body.AccountStatus as Record<string, unknown> | undefined;
  if (status && typeof status === 'object') {
    const owner = await unipileOwner(db, status.account_id);
    const userId = owner?.userId ?? null;
    const next = accountStatus(String(status.message ?? ''));
    if (!owner || !next) return { result: 'ignored', userId };
    // a parked link (plan 35 E5) has no account at Unipile: only its student's reconnect brings it back; an
    // Instagram account held as a different account waits for the student, whatever Unipile says about it
    const changed = await db.sql`
      update orbit.integration_accounts
         set status = ${next}, last_error = ${next === 'active' ? null : String(status.message).slice(0, 40)}
       where user_id = ${owner.userId}::uuid and provider = ${owner.provider} and status <> 'parked'
         and not (status = 'error' and coalesce(last_error, '') = 'different_account')
      returning id`;
    // Instagram asked the student to confirm it is them: told once, everything else carries on (plan 43 §4)
    if (owner.provider === 'instagram' && next === 'needs_reauth' && changed.length)
      await db.sql`
        insert into orbit.notifications (user_id, kind, title, body, link)
        select ${owner.userId}::uuid, 'instagram_sign_in', 'Sign in to Instagram again',
               'Instagram asked to confirm it is you. Orbit carries on with everything else meanwhile.', '/settings'
         where not exists (select 1 from orbit.notifications where user_id = ${owner.userId}::uuid
                             and kind = 'instagram_sign_in' and read_at is null)`;
    return { result: `status:${next}`, userId };
  }

  const event = str(body.event);
  if (event === 'message_received') {
    const messageId = str(body.message_id);
    const chatId = str(body.chat_id);
    if (!messageId || !chatId) return { result: 'ignored', userId: null };
    const owner = await unipileOwner(db, body.account_id);
    if (owner?.provider === 'instagram') {
      // nothing is stored while Instagram is not offered or the student has it off; the sync reads what arrived once
      // it is back on
      if (!(await sourceIsOn(db, owner.userId, 'instagram', offered)))
        return { result: 'source_off', userId: owner.userId };
      const result = await db.begin(async (tx) => {
        if (!(await firstSeen(tx, `instagram:${messageId}`))) return 'duplicate';
        return storeInstagramMessage(tx, queueFor(tx), owner, body, chatId, messageId);
      });
      return { result, userId: owner.userId };
    }
    const userId = owner?.provider === 'linkedin' ? owner.userId : null;
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

/**
 * A parked link (plan 35 E5) coming back. Its Unipile account was deleted, so the new one has new chat and message
 * ids: the next pass resumes from where the last finished pass ended (`since`) instead of walking everything again.
 * It reads relations only back to `since` and chats with activity after it, and `floor` keeps any message from before
 * `since` out for good (those are stored already, under the old account's ids), so nothing is doubled.
 */
export function unparkState(li: Record<string, unknown>): Record<string, unknown> | undefined {
  const parked = li.parked as { since?: unknown; at?: unknown } | undefined;
  const since = typeof parked?.since === 'string' && parked.since ? parked.since : undefined;
  if (!since) return undefined;
  const { parked: _drop, ...rest } = li;
  return {
    ...rest,
    stage: 'relations',
    cursor: null,
    chatsCursor: null,
    chatIndex: 0,
    short: true,
    chatsAfter: since,
    resume: true,
    floor: typeof li.floor === 'string' && li.floor > since ? li.floor : since,
    unparkedAt: new Date().toISOString(),
  };
}

/** Unipile's hosted-auth notify_url: the account was created (or reconnected) for the Orbit user named in `name`. */
export async function unipileAccount(
  db: Db,
  queue: Queue,
  body: Record<string, unknown>,
  provider: 'linkedin' | 'instagram' = 'linkedin',
  offered: readonly OptionalSource[] = [],
): Promise<{ result: string; userId: string | null }> {
  const status = String(body.status ?? '').toUpperCase();
  const accountId = str(body.account_id);
  const userId = isUuid(body.name) ? body.name : null;
  if (!['CREATION_SUCCESS', 'RECONNECTED'].includes(status) || !accountId || !userId)
    return { result: 'ignored', userId };
  const [user] = await db.sql`select 1 from orbit.users where id = ${userId}::uuid and deleted_at is null`;
  if (!user) return { result: 'unknown_user', userId: null };
  if (provider === 'instagram') {
    // Instagram not offered: nothing is stored (connecting is not offered either, so this is a stray notify)
    if (!(await isOffered(db, 'instagram', offered))) return { result: 'not_offered', userId };
    return instagramAccount(db, queue, userId, accountId, status);
  }
  const taken = await db.sql`
    select 1 from orbit.integration_accounts
     where provider = 'linkedin' and external_account_id = ${accountId} and user_id <> ${userId}::uuid`;
  if (taken.length) return { result: 'account_in_use', userId };
  const [prior] = await db.sql<{ status: string; linkedin: Record<string, unknown> | null }>`
    select status, sync_state -> 'linkedin' as linkedin from orbit.integration_accounts
     where user_id = ${userId}::uuid and provider = 'linkedin'`;
  await db.sql`
    insert into orbit.integration_accounts (user_id, provider, external_account_id, status, last_error)
    values (${userId}::uuid, 'linkedin', ${accountId}, 'active', null)
    on conflict (user_id, provider) do update set
      external_account_id = excluded.external_account_id, status = 'active', last_error = null`;
  const resumed = prior?.status === 'parked' ? unparkState(prior.linkedin ?? {}) : undefined;
  if (resumed)
    await db.sql`
      update orbit.integration_accounts
         set sync_state = coalesce(sync_state, '{}'::jsonb) || jsonb_build_object('linkedin', ${resumed}::jsonb)
       where user_id = ${userId}::uuid and provider = 'linkedin'`;
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, details)
    values (${userId}::uuid, 'system', ${resumed ? 'linkedin.unparked' : 'linkedin.connected'}, 'integration_accounts',
            ${{ status, ...(resumed ? { since: resumed.floor } : {}) }}::jsonb)`;
  await queue.enqueue({
    kind: 'sync.linkedin',
    userId,
    payload: { mode: 'backfill', accountId },
    dedupeKey: `linkedin-backfill:${userId}:${accountId}`,
  });
  return { result: 'connected', userId };
}

/**
 * An Instagram account connected (or reconnected) through Unipile's hosted sign-in (plan 43 §4 "Connect"). One account
 * per student: the row is the student's `instagram` integration, and connecting switches Instagram on for them. The
 * first days begin with a read of the profile, which also checks it is the same Instagram account as before: a
 * different one is held until the student says to replace the old one (orbit-api POST /instagram/connect/start
 * {replace: true}). Messages are keyed by Instagram's own ids, so a reconnect stores nothing twice.
 */
async function instagramAccount(
  db: Db,
  queue: Queue,
  userId: string,
  accountId: string,
  status: string,
): Promise<{ result: string; userId: string | null }> {
  const taken = await db.sql`
    select 1 from orbit.integration_accounts
     where provider = 'instagram' and external_account_id = ${accountId} and user_id <> ${userId}::uuid`;
  if (taken.length) return { result: 'account_in_use', userId };
  await db.sql`
    insert into orbit.integration_accounts (user_id, provider, external_account_id, status, last_error)
    values (${userId}::uuid, 'instagram', ${accountId}, 'active', null)
    on conflict (user_id, provider) do update set
      external_account_id = excluded.external_account_id, status = 'active', last_error = null`;
  await db.sql`
    update orbit.integration_accounts
       set sync_state = coalesce(sync_state, '{}'::jsonb)
             || jsonb_build_object('instagram', coalesce(sync_state -> 'instagram', '{}'::jsonb)
                  || ${{ stage: 'profile', pending: null }}::jsonb)
     where user_id = ${userId}::uuid and provider = 'instagram'`;
  await db.sql`
    insert into orbit.source_states (user_id, source, state, off_since)
    values (${userId}::uuid, 'instagram', 'on', null)
    on conflict (user_id, source) do update set state = 'on', off_since = null`;
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, details)
    values (${userId}::uuid, 'system', 'instagram.connected', 'integration_accounts', ${{ status }}::jsonb)`;
  await queue.enqueue({
    kind: 'sync.instagram',
    userId,
    payload: {},
    dedupeKey: `sync.instagram:${userId}:${accountId}:connect`,
  });
  return { result: 'connected', userId };
}
