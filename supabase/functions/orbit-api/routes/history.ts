/**
 * Everything with one person, for their page (account mode):
 *   POST /people/history {personId} → {threads, messages, events}, shaped as /sync/pull shapes them
 *
 * /sync/pull keeps the browser's copy small: networking threads of the last 180 days only. A person's page needs the
 * whole story with them: every thread they are on whatever its category or age (a recruiting email from a founder
 * is still them), the messages in it, and the meetings they were in. The newest 40 threads and 400 messages, and 40
 * meetings, are plenty for a page; the browser stores them like pulled rows and builds the timeline from them.
 */

import { HttpError, json } from '../../_shared/http.ts';
import type { Ctx, Route } from '../api.ts';
import { PULL_BY_NAME, shapeRow } from '../tables.ts';
import { body, uuid } from './body.ts';

export const HISTORY_THREADS = 40;
export const HISTORY_MESSAGES = 400;
export const HISTORY_EVENTS = 40;

type Row = Record<string, unknown>;

async function history(ctx: Ctx): Promise<Response> {
  const personId = uuid(await body(ctx), 'personId');
  const userId = ctx.userId!;
  const [p] = await ctx.db.sql`
    select 1 from orbit.people where id = ${personId}::uuid and user_id = ${userId}::uuid and deleted_at is null`;
  if (!p) throw new HttpError(404, 'not_found', 'no such person');
  const threads = await ctx.db.query<{ row: Row }>(
    `select to_jsonb(t) as row from orbit.threads t
      where t.user_id = $1::uuid and $2::uuid = any(t.participant_person_ids)
      order by coalesce(t.last_at, t.created_at) desc limit $3`,
    [userId, personId, HISTORY_THREADS],
  );
  const ids = threads.map((t) => String(t.row.id));
  const [messages, events] = await Promise.all([
    ids.length
      ? ctx.db.query<{ row: Row }>(
          `select to_jsonb(m) - 'embedding' as row from orbit.messages m
            where m.user_id = $1::uuid and m.thread_id = any($2::uuid[])
            order by m.sent_at desc limit $3`,
          [userId, ids, HISTORY_MESSAGES],
        )
      : Promise.resolve([] as { row: Row }[]),
    ctx.db.query<{ row: Row }>(
      `select to_jsonb(e) as row from orbit.calendar_events e
        where e.user_id = $1::uuid and $2::uuid = any(e.attendee_person_ids)
        order by e.start_at desc limit $3`,
      [userId, personId, HISTORY_EVENTS],
    ),
  ]);
  const shape = (table: string, rows: { row: Row }[]) =>
    rows.map((r) => shapeRow(PULL_BY_NAME.get(table)!, r.row));
  return json(200, {
    threads: shape('threads', threads),
    messages: shape('messages', messages),
    events: shape('calendar_events', events),
  });
}

export const historyRoutes: Record<string, Route> = {
  '/people/history': { method: 'POST', auth: true, run: history },
};
