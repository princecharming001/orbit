/**
 * Gmail messages into orbit rows (§12.3), mirroring the browser's engine/ingest.ts decisions with SQL writes:
 *
 *   1. ids already stored are skipped (unique (user, provider, external id) does the rest);
 *   2. messages.get format=metadata for the others; drafts, spam, trash and chats are dropped;
 *   3. a message is automated when the sender is a bulk, notification, role or applicant-tracking address, it is an
 *      auto-reply or a calendar notice, or it carries List-Unsubscribe / Precedence / Auto-Submitted;
 *   4. a thread is a networking candidate when it has a human message and the user wrote in it, or it has at most 8
 *      other addresses and one is already a known person, or it is already a networking thread; candidates are read
 *      with threads.get format=full and triaged on their text (core heuristicTriage);
 *   5. people from From/To/Cc of human mail (never the user, never automated senders), resolved in one batch;
 *   6. threads are stored when someone in the graph is on them; bodies (quotes stripped) and snippets only for
 *      networking threads; thread aggregates are recounted from the stored messages;
 *   7. introductions in networking threads become introduced_by ties (and move an intro request to intro_made);
 *   8. classify.message for new inbound human mail in networking threads (last 180 days), and one score.person job
 *      for everyone on the touched threads.
 * Nothing here logs content, names or addresses.
 */
import { heuristicTriage, isAutoReplyBody } from '@orbit/core/email/triage';
import { detectIntroduction } from '@orbit/core/pipeline/introductions';
import {
  htmlToText,
  isAtsSender,
  isAutomatedSender,
  isAutoReply,
  isCalendarNotice,
  parseAddress,
  parseAddressList,
  splitSignature,
  stripQuotedReply,
} from '@orbit/core/text/email';
import { normalizeEmail } from '@orbit/core/text/normalize';
import type { Db } from '../db.ts';
import { findBody, type GmailApi, type GmailMessage, headerMap } from '../gmail.ts';
import { GoogleApiError } from '../googleApi.ts';
import type { Queue } from '../queue.ts';
import { type Incoming, resolvePeople } from './people.ts';
import { upsertIntroTie } from './ties.ts';
import { loadSelf, type SelfInfo } from './util.ts';

const SKIP_LABELS = new Set(['DRAFT', 'SPAM', 'TRASH', 'CHAT']);
const IN_FLIGHT = 5;

/** fn over items with at most n running; after the first failure no new item starts, and it is rethrown. */
export async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed: { e: unknown } | undefined;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!);
      } catch (e) {
        failed ??= { e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  if (failed) throw failed.e;
  return out;
}
export const GROUP_MAX = 8;
export const CLASSIFY_WINDOW_DAYS = 180;
const DAY = 86_400_000;

export interface Addr {
  email: string;
  name?: string;
}

export interface ParsedMail {
  id: string;
  threadId: string;
  labels: string[];
  sentAt: string;
  from: Addr;
  to: Addr[];
  cc: Addr[];
  subject?: string;
  rfcMessageId?: string;
  inReplyTo?: string;
  headers: Record<string, string>;
  snippet?: string;
  /** plain text of a full read (HTML converted); undefined on a metadata read */
  body?: string;
  outbound: boolean;
  automated: boolean;
}

const addrs = (raw: string | undefined): Addr[] =>
  parseAddressList(raw)
    .map(parseAddress)
    .filter((a) => a.email.includes('@'));

/** One Gmail message as Orbit reads it; undefined for drafts, spam, trash and chats. */
export function parseMail(m: GmailMessage, self: Pick<SelfInfo, 'emails'>): ParsedMail | undefined {
  const labels = m.labelIds ?? [];
  if (labels.some((l) => SKIP_LABELS.has(l))) return undefined;
  const headers = headerMap(m.payload);
  const fromList = addrs(headers.from);
  const from = fromList[0] ?? { email: '' };
  const internal = Number(m.internalDate);
  const date = Number.isFinite(internal) && internal > 0 ? new Date(internal) : new Date(headers.date ?? '');
  if (Number.isNaN(date.getTime())) return undefined;
  const { text, html } = findBody(m.payload);
  const body = text ?? (html !== undefined ? htmlToText(html) : undefined);
  // only an address the user owns makes a message outbound (a delegate sending "on behalf of" does not, §12.7)
  const outbound = !!from.email && self.emails.has(normalizeEmail(from.email));
  const subject = headers.subject;
  const stripped = body ? stripQuotedReply(body) : '';
  const automated =
    !outbound &&
    (!from.email ||
      isAutomatedSender(from.email, headers, labels, from.name) ||
      isAtsSender(from.email) ||
      isAutoReply(headers, subject) ||
      (!!stripped && isAutoReplyBody(stripped)) ||
      isCalendarNotice(subject, body ?? m.snippet ?? '', headers));
  return {
    id: m.id,
    threadId: m.threadId,
    labels,
    sentAt: date.toISOString(),
    from,
    to: addrs(headers.to),
    cc: addrs(headers.cc),
    subject,
    rfcMessageId: headers['message-id']?.trim(),
    inReplyTo: headers['in-reply-to']?.trim(),
    headers,
    snippet: m.snippet,
    body,
    outbound,
    automated,
  };
}

export interface GmailIngestDeps {
  db: Db;
  queue: Queue;
  api: GmailApi;
  userId: string;
  now: Date;
  /** makes the dedupe key of the score job this batch queues */
  jobKey: string;
}

export interface GmailIngestStats {
  fetched: number;
  stored: number;
  threads: number;
  networking: number;
  people: number;
}

/** Fetches, reads and stores the given messages; see the file comment. */
export async function ingestGmail(
  d: GmailIngestDeps,
  refs: { id: string; threadId?: string }[],
): Promise<GmailIngestStats> {
  const { db, userId } = d;
  const stats: GmailIngestStats = { fetched: 0, stored: 0, threads: 0, networking: 0, people: 0 };
  const ids = [...new Set(refs.map((r) => r.id))];
  if (!ids.length) return stats;
  const self = await loadSelf(db, userId);
  const stored = new Set(
    (
      await db.sql<{ external_id: string }>`
        select external_id from orbit.messages
         where user_id = ${userId}::uuid and provider = 'gmail' and external_id = any(${ids}::text[])`
    ).map((r) => r.external_id),
  );
  const todo = ids.filter((id) => !stored.has(id));
  if (!todo.length) return stats;

  // metadata reads (paced by the client; the first failure stops the rest)
  const metas = await pool(todo, IN_FLIGHT, (id) =>
    d.api.metadata(id).catch((e) => {
      // deleted between the list and the read
      if (e instanceof GoogleApiError && e.status === 404) return undefined;
      throw e;
    }),
  );
  stats.fetched = metas.filter(Boolean).length;
  const byThread = new Map<string, ParsedMail[]>();
  for (const m of metas) {
    const p = m && parseMail(m, self);
    if (!p) continue;
    const arr = byThread.get(p.threadId) ?? [];
    arr.push(p);
    byThread.set(p.threadId, arr);
  }
  if (!byThread.size) return stats;

  // who is already known, and which threads are already networking threads
  const others = (ms: ParsedMail[]) => {
    const s = new Set<string>();
    for (const m of ms)
      for (const a of [m.from, ...m.to, ...m.cc]) {
        const e = normalizeEmail(a.email);
        if (e.includes('@') && !self.emails.has(e)) s.add(e);
      }
    return s;
  };
  const allAddrs = [...new Set([...byThread.values()].flatMap((ms) => [...others(ms)]))];
  const knownAddrs = new Set(
    (
      await db.sql<{ v: string }>`
        select pi.value_norm as v from orbit.person_identities pi join orbit.people p on p.id = pi.person_id
         where pi.user_id = ${userId}::uuid and pi.kind = 'email' and pi.value_norm = any(${allAddrs}::text[])
           and not p.is_self and p.deleted_at is null`
    ).map((r) => r.v),
  );
  const threadKeys = [...byThread.keys()];
  const existingThreads = new Map(
    (
      await db.sql<{ external_id: string; id: string; is_networking: boolean }>`
        select external_id, id, is_networking from orbit.threads
         where user_id = ${userId}::uuid and provider = 'gmail' and external_id = any(${threadKeys}::text[])`
    ).map((t) => [t.external_id, t]),
  );

  // networking candidates are read in full
  const candidates = new Set<string>();
  for (const [tid, ms] of byThread) {
    const human = ms.some((m) => !m.automated);
    const addrsOn = others(ms);
    const candidate =
      existingThreads.get(tid)?.is_networking ||
      (human &&
        (ms.some((m) => m.outbound) ||
          (addrsOn.size <= GROUP_MAX && [...addrsOn].some((a) => knownAddrs.has(a)))));
    if (!candidate) continue;
    candidates.add(tid);
  }
  await pool([...candidates], IN_FLIGHT, async (tid) => {
    let full: { messages?: GmailMessage[] };
    try {
      full = await d.api.thread(tid);
    } catch (e) {
      if (e instanceof GoogleApiError && e.status === 404) return;
      throw e;
    }
    const parsed = (full.messages ?? []).map((m) => parseMail(m, self)).filter((m): m is ParsedMail => !!m);
    if (parsed.length) byThread.set(tid, parsed);
  });

  // people, in one batch
  const items: Incoming[] = [];
  for (const ms of byThread.values())
    for (const m of ms) {
      if (m.automated) continue;
      const sig =
        !m.outbound && m.body ? splitSignature(stripQuotedReply(m.body), { name: m.from.name }) : undefined;
      const add = (a: Addr, sender: boolean) => {
        const e = normalizeEmail(a.email);
        if (!e.includes('@') || self.emails.has(e)) return;
        items.push({
          key: e,
          email: a.email,
          name: a.name,
          source: 'gmail',
          seenAt: m.sentAt,
          ...(sender && sig ? { title: sig.title, companyRaw: sig.company } : {}),
        });
      };
      add(m.from, true);
      for (const a of [...m.to, ...m.cc]) add(a, false);
    }
  // senders first, so a name from a From line wins over the same address bare on a Cc line
  items.sort((a, b) => Number(!!b.title || !!b.name) - Number(!!a.title || !!a.name));
  const resolved = await resolvePeople(db, userId, items, { now: d.now });
  stats.people = resolved.created.size;
  const personOf = (a: Addr): string | undefined => {
    const e = normalizeEmail(a.email);
    return self.emails.has(e) ? undefined : resolved.byKey.get(e);
  };

  const touched = new Set<string>();
  const classify: { id: string; externalId: string }[] = [];
  for (const [tid, raw] of byThread) {
    const ms = [...raw].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    const pids = new Set<string>();
    for (const m of ms) for (const a of [m.from, ...m.to, ...m.cc]) if (personOf(a)) pids.add(personOf(a)!);
    const existing = existingThreads.get(tid);
    // mail that involves no one in the graph is not kept (§14.3)
    if (!pids.size && !existing) continue;

    let category: string | null = null;
    let networking = existing?.is_networking ?? false;
    if (candidates.has(tid)) {
      const tri = heuristicTriage({
        subject: ms[0]?.subject,
        messages: ms.map((m) => ({
          fromEmail: m.from.email,
          direction: m.outbound ? 'outbound' : 'inbound',
          body: stripQuotedReply(m.body ?? m.snippet ?? ''),
          isAutomated: m.automated,
        })),
        userEmails: [...self.emails],
      });
      category = tri.category;
      networking ||= tri.isNetworking;
    } else if (ms.every((m) => m.automated)) category = 'automated';

    // introductions (read before the thread is stored: an introduction makes it a networking thread)
    const intros =
      candidates.has(tid) && pids.size >= 2 ? await findIntroductions(db, userId, self, ms, personOf) : [];
    if (intros.length) networking = true;

    const [thread] = await db.sql<{ id: string }>`
      insert into orbit.threads (user_id, provider, external_id, subject, category, is_networking)
      values (${userId}::uuid, 'gmail', ${tid}, ${ms[0]?.subject ?? null}, ${category}, ${networking})
      on conflict (user_id, provider, external_id) do update set
        subject = coalesce(orbit.threads.subject, excluded.subject),
        category = coalesce(excluded.category, orbit.threads.category),
        is_networking = orbit.threads.is_networking or excluded.is_networking
      returning id`;
    const threadId = thread!.id;
    stats.threads++;
    if (networking) stats.networking++;

    let inserted = 0;
    for (const m of ms) {
      const body = networking && m.body !== undefined ? stripQuotedReply(m.body) : null;
      const toIds = m.to.map(personOf).filter((x): x is string => !!x);
      const ccIds = m.cc.map(personOf).filter((x): x is string => !!x);
      const [row] = await db.sql<{ id: string }>`
        insert into orbit.messages (user_id, thread_id, provider, external_id, rfc_message_id, in_reply_to, direction,
                                    from_person_id, from_addr, to_addrs, cc_addrs, to_person_ids, cc_person_ids,
                                    sent_at, subject, snippet, body_text, is_automated, list_unsubscribe)
        values (${userId}::uuid, ${threadId}::uuid, 'gmail', ${m.id}, ${m.rfcMessageId ?? null},
                ${m.inReplyTo ?? null}, ${m.outbound ? 'out' : 'in'},
                ${m.outbound ? null : (personOf(m.from) ?? null)}::uuid, ${normalizeEmail(m.from.email) || null},
                ${m.to.map((a) => normalizeEmail(a.email))}::text[], ${m.cc.map((a) => normalizeEmail(a.email))}::text[],
                ${toIds}::uuid[], ${ccIds}::uuid[], ${m.sentAt}::timestamptz, ${m.subject ?? null},
                ${networking ? (m.snippet ?? null) : null}, ${body}, ${m.automated},
                ${!!m.headers['list-unsubscribe']})
        on conflict (user_id, provider, external_id) do nothing
        returning id`;
      if (row) {
        inserted++;
        stats.stored++;
        if (
          networking &&
          !m.outbound &&
          !m.automated &&
          d.now.getTime() - new Date(m.sentAt).getTime() < CLASSIFY_WINDOW_DAYS * DAY
        )
          classify.push({ id: row.id, externalId: m.id });
      } else if (body !== null)
        // a thread that became a networking thread keeps the text of its earlier messages
        await db.sql`
          update orbit.messages set body_text = ${body}, snippet = coalesce(snippet, ${m.snippet ?? null})
           where user_id = ${userId}::uuid and provider = 'gmail' and external_id = ${m.id} and body_text is null`;
    }
    await recountThread(db, threadId, self);
    for (const i of intros) {
      for (const introduced of i.introducedIds)
        await upsertIntroTie(
          db,
          userId,
          {
            introducerId: i.introducerId,
            introducedId: introduced,
            threadId,
            messageId: i.messageId,
            at: i.at,
          },
          d.now,
        );
      await db.sql`
        update orbit.intro_requests set status = 'intro_made', outcome_at = ${i.at}::timestamptz
         where user_id = ${userId}::uuid and introducer_person_id = ${i.introducerId}::uuid
           and target_person_id = any(${i.introducedIds}::uuid[]) and status in ('asked', 'agreed')`;
    }
    if (inserted) for (const p of pids) touched.add(p);
  }

  for (const c of classify)
    await d.queue.enqueue({
      kind: 'classify.message',
      userId,
      payload: { messageId: c.id },
      dedupeKey: `classify:gmail:${userId}:${c.externalId}`,
    });
  if (touched.size)
    await d.queue.enqueue({
      kind: 'score.person',
      userId,
      payload: { personIds: [...touched] },
      dedupeKey: `score.person:${userId}:${d.jobKey}`,
    });
  return stats;
}

/** Message count, first/last times, last direction, participants and their count, from the stored messages. */
export async function recountThread(db: Db, threadId: string, self: Pick<SelfInfo, 'selfId' | 'emails'>) {
  await db.sql`
    update orbit.threads t set
      message_count = s.n, first_at = s.first_at, last_at = s.last_at, last_direction = s.dir,
      participant_person_ids = coalesce(s.pids, '{}'),
      participant_count = greatest(coalesce(s.pc, 0), cardinality(coalesce(s.pids, '{}')))
    from (
      select count(*)::int as n, min(m.sent_at) as first_at, max(m.sent_at) as last_at,
             (array_agg(m.direction order by m.sent_at desc))[1] as dir,
             (select array_agg(distinct x) from orbit.messages m2,
                     unnest(array[m2.from_person_id] || m2.to_person_ids || m2.cc_person_ids) x
               where m2.thread_id = ${threadId}::uuid and x is not null and x <> ${self.selfId}::uuid) as pids,
             (select count(distinct a)::int from orbit.messages m3,
                     unnest(array[m3.from_addr] || m3.to_addrs || m3.cc_addrs) a
               where m3.thread_id = ${threadId}::uuid and a is not null
                 and not (a = any(${[...self.emails]}::text[]))) as pc
        from orbit.messages m where m.thread_id = ${threadId}::uuid
    ) s
    where t.id = ${threadId}::uuid`;
}

interface FoundIntro {
  introducerId: string;
  introducedIds: string[];
  messageId: string;
  at: string;
}

/** Introductions in a thread's inbound human mail (core detectIntroduction over the people on it). */
async function findIntroductions(
  db: Db,
  userId: string,
  self: SelfInfo,
  ms: ParsedMail[],
  personOf: (a: Addr) => string | undefined,
): Promise<FoundIntro[]> {
  const ids = [
    ...new Set(ms.flatMap((m) => [m.from, ...m.to, ...m.cc].map(personOf)).filter((x): x is string => !!x)),
  ];
  if (ids.length < 2) return [];
  const rows = await db.sql<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    emails: string[];
  }>`
    select p.id, p.first_name, p.last_name,
           coalesce(array_agg(pi.value_norm) filter (where pi.kind = 'email'), '{}') as emails
      from orbit.people p left join orbit.person_identities pi on pi.person_id = p.id
     where p.user_id = ${userId}::uuid and p.id = any(${ids}::uuid[])
     group by p.id`;
  const people = rows.map((r) => ({
    id: r.id,
    firstName: r.first_name ?? '',
    lastName: r.last_name ?? undefined,
    emails: r.emails,
    isHuman: true,
  }));
  const out: FoundIntro[] = [];
  let prior: { introducerId: string; introducedIds: string[] } | undefined;
  for (const m of ms) {
    if (m.outbound || m.automated || m.body === undefined) continue;
    const fromPersonId = personOf(m.from);
    if (!fromPersonId) continue;
    const intro = detectIntroduction(
      {
        id: m.id,
        direction: 'inbound',
        isAutomated: false,
        fromPersonId,
        fromEmail: normalizeEmail(m.from.email),
        toEmails: m.to.map((a) => normalizeEmail(a.email)),
        ccEmails: m.cc.map((a) => normalizeEmail(a.email)),
        subject: m.subject,
        bodyText: stripQuotedReply(m.body),
        sentAt: m.sentAt,
      },
      people,
      [...self.emails],
      { studentNames: [self.firstName, self.fullName].filter(Boolean), prior },
    );
    if (!intro?.introducedIds.length) continue;
    prior = intro;
    out.push(intro);
  }
  return out;
}
