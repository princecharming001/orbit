/**
 * The timeline of an Orbit account, built in the browser from what the server sends. A browser account records a
 * touchpoint as it reads each email, meeting and LinkedIn message (engine/ingest, engine/linkedinActivity); an Orbit
 * account reads those on the server, so its browser never did, and every person's page said "Not in touch yet" with
 * an empty timeline however much they had written. This makes the same touchpoints from the pulled rows: an email
 * from them or to them (or a copy), a LinkedIn message either way, a meeting they were in. Each is keyed to its row,
 * so building again (the next pull, their page loading their whole history) never doubles one. They stay in this
 * browser: touchpoints are not sent up, and the server keeps its own tie scores.
 */
import { TOUCHPOINT_WEIGHTS, type TouchpointKind } from '@orbit/core';
import { addTouchpoint } from '../db/repo';
import { db } from '../db/schema';

/** A pulled message: the browser's fields, plus the recipients' person ids the server sends with it. */
type ServerMessage = {
  id?: unknown;
  threadId?: unknown;
  channel?: unknown;
  direction?: unknown;
  fromPersonId?: unknown;
  toPersonIds?: unknown;
  ccPersonIds?: unknown;
  isAutomated?: unknown;
  sentAt?: unknown;
  subject?: unknown;
};
type ServerEvent = {
  id?: unknown;
  title?: unknown;
  startAt?: unknown;
  endAt?: unknown;
  status?: unknown;
  attendeePersonIds?: unknown;
};

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Touchpoints for these pulled messages and meetings. Returns how many were new. */
export async function touchpointsFromServer(
  userId: string,
  rows: { messages?: ServerMessage[]; events?: ServerEvent[] },
  now = new Date(),
): Promise<number> {
  const messages = (rows.messages ?? []).filter((m) => !m.isAutomated && str(m.id) && str(m.sentAt));
  const events = (rows.events ?? []).filter((e) => str(e.id) && str(e.startAt) && e.status !== 'cancelled');
  if (!messages.length && !events.length) return 0;
  const threadIds = [...new Set(messages.map((m) => str(m.threadId)).filter((x): x is string => !!x))];
  const threads = new Map((await db.threads.bulkGet(threadIds)).filter((t) => !!t).map((t) => [t!.id, t!]));
  const personIds = new Set<string>();
  for (const m of messages) {
    const t = threads.get(str(m.threadId) ?? '');
    for (const id of [
      str(m.fromPersonId),
      ...ids(m.toPersonIds),
      ...ids(m.ccPersonIds),
      ...(t?.participantPersonIds ?? []),
    ])
      if (id) personIds.add(id);
  }
  for (const e of events) for (const id of ids(e.attendeePersonIds)) personIds.add(id);
  const people = new Map(
    (await db.people.bulkGet([...personIds]))
      .filter((p) => !!p && p.userId === userId)
      .map((p) => [p!.id, p!]),
  );
  const first = (id: string) => people.get(id)?.firstName || people.get(id)?.displayName || 'them';
  let added = 0;
  const add = async (
    personId: string,
    kind: TouchpointKind,
    occurredAt: string,
    refTable: string,
    refId: string,
    summary: string,
    weight = TOUCHPOINT_WEIGHTS[kind],
  ) => {
    if (!people.has(personId)) return;
    if (await addTouchpoint({ userId, personId, kind, occurredAt, refTable, refId, summary, weight }))
      added++;
  };
  for (const m of messages) {
    const id = m.id as string;
    const at = m.sentAt as string;
    const thread = threads.get(str(m.threadId) ?? '');
    const inbound = m.direction === 'inbound' || m.direction === 'in';
    const linkedIn = m.channel === 'linkedin' || thread?.channel === 'linkedin';
    if (linkedIn) {
      // a LinkedIn conversation is between the student and the people on it (a one-to-one chat, nearly always)
      const them =
        inbound && str(m.fromPersonId) ? [m.fromPersonId as string] : (thread?.participantPersonIds ?? []);
      for (const pid of them.slice(0, 3))
        await add(
          pid,
          inbound ? 'linkedin_in' : 'linkedin_out',
          at,
          'messages',
          id,
          inbound ? `LinkedIn message from ${first(pid)}` : `LinkedIn message to ${first(pid)}`,
        );
      continue;
    }
    const subject = str(m.subject) ?? str(thread?.subject) ?? '';
    // outside networking threads only a direct email counts in full, as when a browser account reads its mail
    const light = thread && !thread.isNetworking;
    if (inbound) {
      const pid = str(m.fromPersonId);
      if (pid) await add(pid, 'email_in', at, 'messages', id, `Email from ${first(pid)}: ${subject}`.trim());
      continue;
    }
    for (const pid of ids(m.toPersonIds))
      await add(pid, 'email_out', at, 'messages', id, `Email to ${first(pid)}: ${subject}`.trim());
    for (const pid of ids(m.ccPersonIds))
      await add(
        pid,
        'email_cc',
        at,
        'threads',
        str(m.threadId) ?? id,
        `Copied on: ${subject}`.trim(),
        light ? 0.1 : undefined,
      );
  }
  for (const e of events) {
    const end = str(e.endAt) ?? (e.startAt as string);
    // a meeting counts once it has happened, and only a small one: a talk with forty people is not time together
    const who = ids(e.attendeePersonIds);
    if (Date.parse(end) > now.getTime() || !who.length || who.length > 3) continue;
    for (const pid of who)
      await add(
        pid,
        'meeting',
        e.startAt as string,
        'events',
        e.id as string,
        `Meeting: ${str(e.title) ?? 'Meeting'}`,
        who.length === 1 ? 1 : 0.5,
      );
  }
  return added;
}

const BACKFILL_KEY = (userId: string) => `touchpoints:fromServer:v1:${userId}`;

/**
 * Once per account in this browser: the timeline for everything pulled before this was built (a pull only sends rows
 * that changed since, so they would otherwise never get one). In pages, so a big mailbox never holds the tab.
 */
export async function backfillServerTouchpoints(userId: string, now = new Date()): Promise<number> {
  if ((await db.kv.get(BACKFILL_KEY(userId)))?.value) return 0;
  let added = 0;
  const PAGE = 500;
  const messages = await db.messages.where('userId').equals(userId).toArray();
  for (let i = 0; i < messages.length; i += PAGE)
    added += await touchpointsFromServer(userId, { messages: messages.slice(i, i + PAGE) as never }, now);
  const events = await db.events.where('userId').equals(userId).toArray();
  added += await touchpointsFromServer(userId, { events: events as never }, now);
  await db.kv.put({ key: BACKFILL_KEY(userId), value: now.toISOString() });
  return added;
}
