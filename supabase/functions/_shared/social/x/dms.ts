/**
 * Reading a student's X DMs on a schedule (plan 43 §5 "Closeness", §3.9), job kind `x.dms`.
 *
 * X gives the last 30 days of DMs and nothing live, so Orbit asks: every hour for a student waiting on a reply over X
 * (a chat where they wrote on X and no answer came yet), once a day for everyone else. The first read covers the 30
 * days X keeps, capped at 100 events. Later reads first ask for the single newest event ($0.01); only when it is new
 * do they read on, in pages that grow while everything on them is new, until they reach the last event already read
 * (at most 100 a run). Everything is
 * charged through the student's X budget; a refused read stops quietly and the next run tries again.
 *
 * A student's DMs are read only when they gave express consent on the connect screen (sign-in alone is not consent to
 * store DMs, X's rule) and X is on for them. Each new event is handed to the personal-lane writer, which decides what
 * is kept (plan 43 §3.9: words only for people in the student's pipeline).
 */

import type { Db } from '../../db.ts';
import { sqlQueue } from '../../queue.ts';
import { sourcesFor } from '../../sources/states.ts';
import { SocialBudgetSpent, type SocialChat, type SocialMessage } from '../adapter.ts';
import { groupDmEvents, X_DM_PAGE, type XAdapter, type XDmEvent, XRateLimited } from './adapter.ts';
import type { XConfig } from './config.ts';
import { loadXState, saveXState } from './oauth.ts';

/**
 * Writes one DM into the student's personal lane.
 *
 * In the worker this is the personal-lane writer of supabase/functions/_shared/social/chats.ts
 * (`personalLaneXWriter` in orbit-worker/handlers/x.ts); tests pass their own.
 */
export type XDmWriter = (
  db: Db,
  userId: string,
  event: { platform: 'x'; chat: SocialChat; message: SocialMessage },
) => Promise<void>;

export const X_DM_FIRST_DAYS = 30;
export const X_DM_FIRST_MAX = 100;
/** The most events one run reads after the first. */
export const X_DM_RUN_MAX = 100;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/** A run a little early still counts as on time, so an hourly cron does not slip a whole hour. */
const SLACK_MS = 5 * 60_000;

/** Whether the student is waiting on a reply over X: a chat opened on X with no answer yet, or a sent X draft. */
export async function xWaitingOnReply(db: Db, userId: string, now = new Date()): Promise<boolean> {
  const [r] = await db.sql<{ waiting: boolean }>`
    select exists (
      select 1 from orbit.chats c
       where c.user_id = ${userId}::uuid and c.archived_at is null
         and c.data->>'outreachChannel' = 'x'
         and c.stage not in ('declined', 'archived', 'completed')
         and c.data->>'lastOutboundAt' is not null
         and (c.data->>'lastInboundAt' is null or c.data->>'lastInboundAt' < c.data->>'lastOutboundAt')
    ) or exists (
      select 1 from orbit.drafts d
       where d.user_id = ${userId}::uuid and d.channel = 'x' and d.status = 'sent' and d.replied_at is null
         and d.sent_at > ${new Date(now.getTime() - X_DM_FIRST_DAYS * DAY_MS)}::timestamptz
    ) as waiting`;
  return !!r?.waiting;
}

/** When the next read is due: an hour after the last when waiting, a day otherwise, now when never read. */
export function xDmsNextAt(lastReadAt: string | undefined, waiting: boolean): Date {
  if (!lastReadAt) return new Date(0);
  return new Date(Date.parse(lastReadAt) + (waiting ? HOUR_MS : DAY_MS) - SLACK_MS);
}

/** Whether this student's DMs should be read now: X on, consent given, and the cadence above. */
export async function xDmsDue(
  db: Db,
  userId: string,
  cfg: Pick<XConfig, 'offered'>,
  now = new Date(),
): Promise<boolean> {
  if (!cfg.offered) return false;
  const row = await loadXState(db, userId);
  if (row?.status !== 'active' || !row.state.consent) return false;
  const s = await sourcesFor(db, userId, ['x']);
  if (!s.inUse.has('x')) return false;
  const waiting = await xWaitingOnReply(db, userId, now);
  return xDmsNextAt(row.state.dmReadAt, waiting).getTime() <= now.getTime();
}

const newer = (a: string, b: string | undefined) => !b || BigInt(a) > BigInt(b);

export interface XDmRun {
  events: number;
  messages: number;
  first: boolean;
  reason?: 'budget' | 'rate_limited';
}

/**
 * Reads the student's new DM events since the last cursor and hands each message to `writer`, oldest first. The
 * cursor moves only when the read reached what was read before (or the cap), so a run stopped part way leaves no gap.
 */
export async function pollXDms(
  db: Db,
  userId: string,
  deps: { adapter: XAdapter; writer: XDmWriter; now?: () => Date },
): Promise<XDmRun> {
  const now = deps.now ?? (() => new Date());
  const row = await loadXState(db, userId);
  const cursor = row?.state.dmCursor;
  const first = !cursor;
  const picked: XDmEvent[] = [];
  try {
    if (first) {
      // the first read: the 30 days X keeps, at most 100 events, one page
      const page = await deps.adapter.dmEvents({ maxResults: X_DM_FIRST_MAX });
      const since = now().getTime() - X_DM_FIRST_DAYS * DAY_MS;
      for (const e of page.events) if (!e.created_at || Date.parse(e.created_at) >= since) picked.push(e);
    } else {
      // the newest event alone: when it is not new, nothing else is read
      let page = await deps.adapter.dmEvents({ maxResults: 1 });
      let reachedOld = false;
      for (;;) {
        for (const e of page.events) {
          if (!newer(e.id, cursor)) {
            reachedOld = true;
            break;
          }
          picked.push(e);
        }
        if (reachedOld || !page.cursor || picked.length >= X_DM_RUN_MAX) break;
        // pages grow as long as everything on them is new, so a few new events never pay for a hundred old ones
        page = await deps.adapter.dmEvents({
          maxResults: Math.min(X_DM_PAGE, X_DM_RUN_MAX - picked.length, Math.max(4, picked.length * 2)),
          cursor: page.cursor,
        });
      }
    }
  } catch (e) {
    if (e instanceof SocialBudgetSpent) return { events: 0, messages: 0, first, reason: 'budget' };
    if (e instanceof XRateLimited) return { events: 0, messages: 0, first, reason: 'rate_limited' };
    throw e;
  }
  const events = picked.slice(0, first ? X_DM_FIRST_MAX : X_DM_RUN_MAX).reverse();
  const { chats, messages } = groupDmEvents(events, row?.socialAccountId ?? undefined);
  const chatOf = new Map(chats.map((c) => [c.chatId, c]));
  for (const m of messages) {
    const chat = chatOf.get(m.chatId);
    if (chat) await deps.writer(db, userId, { platform: 'x', chat, message: m });
  }
  let newest = cursor;
  for (const e of events) if (newer(e.id, newest)) newest = e.id;
  await saveXState(db, userId, {
    dmReadAt: now().toISOString(),
    ...(newest ? { dmCursor: newest } : {}),
  });
  return { events: events.length, messages: messages.length, first };
}

/**
 * The hourly fan-out (job kind `x.dms` with no user): queues a read for each student whose DMs are due. The per-hour
 * dedupe key keeps a student to one read an hour whatever else queues one.
 */
export async function enqueueDueXDms(
  db: Db,
  cfg: Pick<XConfig, 'offered'>,
  now = new Date(),
): Promise<number> {
  if (!cfg.offered) return 0;
  const rows = await db.sql<{ user_id: string }>`
    select a.user_id from orbit.integration_accounts a
      join orbit.users u on u.id = a.user_id
     where a.provider = 'x' and a.status = 'active' and u.deleted_at is null
       and a.sync_state->'x'->'consent' is not null`;
  const q = sqlQueue(db);
  const hour = now.toISOString().slice(0, 13);
  let n = 0;
  for (const r of rows) {
    if (!(await xDmsDue(db, r.user_id, cfg, now))) continue;
    const id = await q.enqueue(
      { kind: 'x.dms', userId: r.user_id, payload: {}, dedupeKey: `x-dms:${r.user_id}:${hour}` },
      { queue: 'orbit_sync' },
    );
    if (id !== null) n++;
  }
  return n;
}
