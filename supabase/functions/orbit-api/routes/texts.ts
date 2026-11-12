/**
 * Texts for a signed-in student (plan 43 §6, decision 1):
 *   POST /texts/days {days: [{personId? | ref?, day, in, out, group, words}], people: [{ref, name, phones}]}
 *        → {ok: true, days, people: {ref: personId}, created}
 *
 * After the browser reads the Messages file it sends, per person and local day, how many texts went each way, the
 * smallest chat that day (the student included) and whether anything was written. Never the words: a body with any
 * field the contract does not name is refused, and every value is a count, a date, a flag or a name and numbers.
 *
 * A friend known only from texts is sent with a `ref`, a name and their numbers: matched to the student's person who
 * has one of those numbers (identity kind `phone`, E.164, the same key the browser uses), else made, with source
 * `imessage` and the numbers as phone identities. Names never bind two people (plan 17), so a name alone matches
 * nobody. Needs the texts source on (§3.1). The people whose days changed are rescored.
 */
import { phoneRegionFor, toE164 } from '@orbit/core/entity/phone';
import type { TextDaysResponse } from '@orbit/core/server/api';
import { parseName } from '@orbit/core/text/normalize';
import { badRequest, HttpError, json } from '../../_shared/http.ts';
import { sqlQueue } from '../../_shared/queue.ts';
import { sourceIsOn, sourcesFor } from '../../_shared/sources/states.ts';
import type { Ctx, Route } from '../api.ts';
import { addPhoneIdentities } from '../sync.ts';
import { body, UUID } from './body.ts';

export const TEXT_DAYS_MAX = 5000;
export const TEXT_PEOPLE_MAX = 2000;

const DAY_KEYS = new Set(['personId', 'ref', 'day', 'in', 'out', 'group', 'words']);
const PERSON_KEYS = new Set(['ref', 'name', 'phones']);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

interface DayIn {
  personId?: string;
  ref?: string;
  day: string;
  in: number;
  out: number;
  group: number;
  words: boolean;
}
interface PersonIn {
  ref: string;
  name: string;
  phones: string[];
}

const count = (v: unknown, what: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw badRequest(`${what} is a whole number from ${min} to ${max}`);
  return v;
};

function onlyKeys(o: Record<string, unknown>, allowed: Set<string>, what: string) {
  for (const k of Object.keys(o))
    if (!allowed.has(k)) throw badRequest(`${what} has ${k}: only counts are accepted, never the words`);
}

/** The request, checked: counts, days, flags, names and numbers, nothing else. */
export function parseTextDays(b: Record<string, unknown>, now: Date): { days: DayIn[]; people: PersonIn[] } {
  onlyKeys(b, new Set(['days', 'people']), 'the body');
  if (!Array.isArray(b.days)) throw badRequest('days is a list');
  if (b.days.length > TEXT_DAYS_MAX) throw badRequest(`at most ${TEXT_DAYS_MAX} days at once`);
  const peopleRaw = b.people ?? [];
  if (!Array.isArray(peopleRaw)) throw badRequest('people is a list');
  if (peopleRaw.length > TEXT_PEOPLE_MAX) throw badRequest(`at most ${TEXT_PEOPLE_MAX} people at once`);
  const latest = new Date(now.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
  const people: PersonIn[] = peopleRaw.map((x) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw badRequest('each person is an object');
    const p = x as Record<string, unknown>;
    onlyKeys(p, PERSON_KEYS, 'a person');
    if (typeof p.ref !== 'string' || !p.ref.trim() || p.ref.length > 100)
      throw badRequest('ref names the person');
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 200)
      throw badRequest('name is required');
    if (!Array.isArray(p.phones) || !p.phones.length || p.phones.length > 10)
      throw badRequest('phones lists one to ten numbers');
    for (const n of p.phones)
      if (typeof n !== 'string' || n.length > 40 || !/^[+\d\s().-]+$/.test(n))
        throw badRequest('phones are numbers');
    return { ref: p.ref.trim(), name: p.name.trim(), phones: p.phones as string[] };
  });
  const refs = new Set(people.map((p) => p.ref));
  const days: DayIn[] = b.days.map((x) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw badRequest('each day is an object');
    const d = x as Record<string, unknown>;
    onlyKeys(d, DAY_KEYS, 'a day');
    const personId = d.personId;
    const ref = d.ref;
    if (personId !== undefined && (typeof personId !== 'string' || !UUID.test(personId)))
      throw badRequest('personId is a person id');
    if (ref !== undefined && (typeof ref !== 'string' || !refs.has(ref.trim())))
      throw badRequest('ref names a person in people');
    if (!personId === !ref) throw badRequest('each day has a personId or a ref');
    if (typeof d.day !== 'string' || !DAY_RE.test(d.day) || Number.isNaN(Date.parse(`${d.day}T00:00:00Z`)))
      throw badRequest('day is YYYY-MM-DD');
    if (d.day > latest) throw badRequest('day is not in the future');
    if (typeof d.words !== 'boolean') throw badRequest('words is true or false');
    return {
      ...(personId ? { personId: (personId as string).toLowerCase() } : {}),
      ...(ref ? { ref: (ref as string).trim() } : {}),
      day: d.day,
      in: count(d.in, 'in', 0, 100_000),
      out: count(d.out, 'out', 0, 100_000),
      group: count(d.group, 'group', 2, 10_000),
      words: d.words,
    };
  });
  return { days, people };
}

async function upload(ctx: Ctx): Promise<Response> {
  const userId = ctx.userId!;
  const now = ctx.now();
  if (!ctx.offered.includes('imessage')) throw new HttpError(404, 'not_found', 'texts are not offered');
  if (!(await sourceIsOn(ctx.db, userId, 'imessage', ctx.offered)))
    throw new HttpError(409, 'source_off', 'turn Texts on first');
  const { days, people } = parseTextDays(await body(ctx), now);
  const src = await sourcesFor(ctx.db, userId, ctx.offered);
  const [u] = await ctx.db.sql<{ timezone: string | null; current_city: string | null }>`
    select timezone, current_city from orbit.users where id = ${userId}::uuid`;
  const region = phoneRegionFor({
    timezone: u?.timezone ?? undefined,
    currentCity: u?.current_city ?? undefined,
  });

  const out = await ctx.db.begin(async (tx) => {
    const byRef: Record<string, string> = {};
    let created = 0;
    for (const p of people) {
      const numbers = [...new Set(p.phones.map((n) => toE164(n, region)).filter((n): n is string => !!n))];
      if (!numbers.length) continue;
      const [hit] = await tx.sql<{ person_id: string }>`
        select coalesce(q.merged_into, q.id) as person_id from orbit.person_identities i
          join orbit.people q on q.id = i.person_id and q.deleted_at is null
         where i.user_id = ${userId}::uuid and i.kind = 'phone' and i.value_norm = any(${numbers}::text[])
         order by q.merged_into is null desc, i.created_at limit 1`;
      let id = hit?.person_id;
      if (!id) {
        const n = parseName(p.name);
        const [row] = await tx.sql<{ id: string }>`
          insert into orbit.people (user_id, display_name, first_name, last_name, name_norm, sources, first_seen_at)
          values (${userId}::uuid, ${p.name}, ${n.first || p.name.split(/\s+/)[0] || null}, ${n.last || null},
                  ${n.normalized || p.name.toLowerCase()}, array['imessage']::text[], ${now.toISOString()}::timestamptz)
          returning id`;
        id = row!.id;
        created++;
      }
      await addPhoneIdentities(tx, userId, id, p.phones, 'imessage');
      byRef[p.ref] = id;
    }
    // a personId must be one of the student's people, and in use
    const named = [...new Set(days.map((d) => d.personId).filter((x): x is string => !!x))];
    const mine = new Set(
      named.length
        ? (
            await tx.sql<{ id: string }>`
              select p.id from orbit.people p
               where p.user_id = ${userId}::uuid and p.id = any(${named}::uuid[]) and p.deleted_at is null
                 and orbit.person_in_use(p.sources, p.source_account, ${src.hidden}::text[])`
          ).map((r) => r.id)
        : [],
    );
    const rows = days
      .map((d) => ({ ...d, person: d.personId ?? (d.ref ? byRef[d.ref] : undefined) }))
      .filter((d): d is DayIn & { person: string } => !!d.person && (!d.personId || mine.has(d.personId)));
    if (days.some((d) => d.personId && !mine.has(d.personId)))
      throw new HttpError(404, 'not_found', 'a personId is not one of your people');
    // one row per person and day: the last sent wins
    const merged = new Map<string, (typeof rows)[number]>();
    for (const r of rows) merged.set(`${r.person}|${r.day}`, r);
    const list = [...merged.values()];
    if (list.length)
      await tx.sql`
        insert into orbit.text_days (user_id, person_id, day, in_count, out_count, group_size, words)
        select ${userId}::uuid, (r ->> 'person')::uuid, (r ->> 'day')::date, (r ->> 'in')::int, (r ->> 'out')::int,
               (r ->> 'group')::int, (r ->> 'words')::boolean
          from jsonb_array_elements(${JSON.stringify(list)}::jsonb) r
        on conflict (user_id, person_id, day) do update set
          in_count = excluded.in_count, out_count = excluded.out_count, group_size = excluded.group_size,
          words = excluded.words
        where (orbit.text_days.in_count, orbit.text_days.out_count, orbit.text_days.group_size, orbit.text_days.words)
              is distinct from (excluded.in_count, excluded.out_count, excluded.group_size, excluded.words)`;
    await tx.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${userId}::uuid, 'user', 'texts.days', 'text_days', 'imessage',
              ${{ days: list.length, people: people.length, created }}::jsonb)`;
    return { byRef, created, list };
  });
  const touched = [...new Set(out.list.map((r) => r.person))];
  if (touched.length)
    await sqlQueue(ctx.db).enqueue({
      kind: 'score.person',
      userId,
      payload: { personIds: touched, reason: 'texts' },
      dedupeKey: `score.person:${userId}:texts:${now.getTime()}`,
    });
  const res: TextDaysResponse = { ok: true, days: out.list.length, people: out.byRef, created: out.created };
  return json(200, res);
}

export const textsRoutes: Record<string, Route> = {
  '/texts/days': { method: 'POST', auth: true, run: upload },
};
