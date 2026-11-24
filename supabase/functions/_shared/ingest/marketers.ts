/**
 * Marketers set aside (the student asked for it: "a lot of them send promo-looking messages on LinkedIn and emails
 * that are easy to spot"). Someone who has only ever written to the student to sell something, and whom the student
 * never answered, is hidden the way a person hidden by hand is: out of People, the map, Discover, searches and
 * suggestions, and listed under People, Hidden, where they can be brought back.
 *
 * Who is even looked at: people the student has had nothing to do with beyond receiving their messages. Never anyone
 * the student wrote to, met, put on their pipeline, noted something about, tagged or rated, and never anyone the
 * student brought back before. What their messages say is read by core `marketerVerdict`, which is strict: asking
 * for a call is not selling.
 *
 * Off when users.settings.hide_marketers is false; turning it off brings everyone Orbit set aside back.
 */
import { marketerVerdict } from '@orbit/core/text/marketer';
import type { Db } from '../db.ts';

/** people looked at in one run, and the newest messages read of each */
const SWEEP_PEOPLE = 3000;
const SWEEP_MESSAGES = 5;

export async function marketersOn(db: Db, userId: string): Promise<boolean> {
  const [u] = await db.sql<{ settings: Record<string, unknown> | null }>`
    select settings from orbit.users where id = ${userId}::uuid`;
  return u?.settings?.hide_marketers !== false;
}

/** Everyone Orbit set aside comes back (the setting was turned off). Returns how many. */
export async function bringMarketersBack(db: Db, userId: string): Promise<number> {
  const rows = await db.sql`
    update orbit.people set hidden_at = null, hidden_reason = null
     where user_id = ${userId}::uuid and hidden_reason = 'marketer' and hidden_at is not null
    returning id`;
  return rows.length;
}

export async function setAsideMarketers(
  db: Db,
  userId: string,
  now: Date,
): Promise<{ looked: number; setAside: number }> {
  if (!(await marketersOn(db, userId))) return { looked: 0, setAside: 0 };
  // someone Orbit hid whom the student has since unhidden: their call, kept for good
  await db.sql`
    update orbit.people set hidden_reason = 'kept'
     where user_id = ${userId}::uuid and hidden_reason = 'marketer' and hidden_at is null`;
  const rows = await db.sql<{ id: string; texts: (string | null)[]; unsub: boolean }>`
    select p.id,
           (array_agg(left(coalesce(m.subject || E'\n', '') || coalesce(m.body_text, m.snippet, ''), 4000)
                      order by m.sent_at desc))[1:${SWEEP_MESSAGES}] as texts,
           bool_or(m.list_unsubscribe) as unsub
      from orbit.people p
      join orbit.messages m on m.user_id = p.user_id and m.from_person_id = p.id and m.direction = 'in'
     where p.user_id = ${userId}::uuid and not p.is_self and p.deleted_at is null and p.merged_into is null
       and p.hidden_at is null and p.hidden_reason is distinct from 'kept'
       and cardinality(p.tags) = 0 and coalesce(p.notes, '') = ''
       -- the student never wrote to them
       and not exists (select 1 from orbit.messages o
                        where o.user_id = p.user_id and o.direction = 'out'
                          and (p.id = any(o.to_person_ids) or p.id = any(o.cc_person_ids)))
       -- never met them, never put them on the pipeline, never noted or rated them
       and not exists (select 1 from orbit.calendar_events e
                        where e.user_id = p.user_id and p.id = any(e.attendee_person_ids))
       and not exists (select 1 from orbit.chats c where c.user_id = p.user_id and c.person_id = p.id)
       and not exists (select 1 from orbit.notes n where n.user_id = p.user_id and p.id = any(n.person_ids))
       and not exists (select 1 from orbit.tie_labels l where l.user_id = p.user_id and l.person_id = p.id)
     group by p.id
     limit ${SWEEP_PEOPLE}`;
  const ids: string[] = [];
  for (const r of rows) {
    const texts = (r.texts ?? []).filter((t): t is string => !!t);
    const v = marketerVerdict([
      ...texts.map((text) => ({ text })),
      ...(r.unsub ? [{ text: '', unsubscribe: true }] : []),
    ]);
    if (v.marketer) ids.push(r.id);
  }
  if (ids.length)
    await db.sql`
      update orbit.people set hidden_at = ${now}::timestamptz, hidden_reason = 'marketer'
       where user_id = ${userId}::uuid and id = any(${ids}::uuid[]) and hidden_at is null`;
  return { looked: rows.length, setAside: ids.length };
}
