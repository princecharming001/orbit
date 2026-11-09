/**
 * The student's whole inbox (POST /inbox/list): every conversation, not only replies to their outreach. Email is read
 * live from Gmail at the time of asking (messages.list on the inbox, then a metadata read of each, in parallel), so it
 * is as current as Gmail itself and costs no Claude; LinkedIn is what the sync stored (the ten-minute poll keeps it
 * current). Each conversation is one row: its newest message from someone else, how many they sent in the window, and
 * the person Orbit knows them as (name, face, LinkedIn page) when the address or member matches.
 * Newsletters and notifications are left out unless asked for. Nothing here logs content, names or addresses.
 */

import type { InboxItem, InboxListRequest, InboxListResponse } from '@orbit/core/server/api';
import { isAtsSender, isAutomatedSender, parseAddress } from '@orbit/core/text/email';
import type { Db } from '../db.ts';
import type { GmailApi, GmailMessage } from '../gmail.ts';
import { headerMap } from '../gmail.ts';
import { NeedsReauth } from '../google.ts';
import { iso, num } from '../rows.ts';

export const INBOX_DEFAULT_DAYS = 7;
export const INBOX_MAX_DAYS = 30;
export const INBOX_DEFAULT_LIMIT = 25;
export const INBOX_MAX_LIMIT = 50;
/** metadata reads in flight at once (Gmail allows 250 quota units a second; a read is 20) */
const PARALLEL_READS = 8;

const DAY = 86_400_000;

export interface InboxDeps {
  db: Db;
  /** the student's Gmail, when Google is connected with gmail.readonly */
  gmail?: GmailApi;
  now: Date;
}

export function inboxOptions(
  b: InboxListRequest,
): Required<Omit<InboxListRequest, 'query'>> & { query: string } {
  const days = Math.min(
    INBOX_MAX_DAYS,
    Math.max(1, Math.round(num(b.days, INBOX_DEFAULT_DAYS)) || INBOX_DEFAULT_DAYS),
  );
  const limit = Math.min(
    INBOX_MAX_LIMIT,
    Math.max(1, Math.round(num(b.limit, INBOX_DEFAULT_LIMIT)) || INBOX_DEFAULT_LIMIT),
  );
  const channel = b.channel === 'email' || b.channel === 'linkedin' ? b.channel : 'all';
  // a search is the student's own words: no quotes or operators beyond Gmail's own syntax, and kept short
  const query =
    typeof b.query === 'string'
      ? b.query
          .replace(/[\r\n]+/g, ' ')
          .trim()
          .slice(0, 200)
      : '';
  return {
    channel,
    days,
    limit,
    unreadOnly: b.unreadOnly === true,
    includeAutomated: b.includeAutomated === true,
    query,
  };
}

/** The Gmail search for the inbox: the window, the primary tab unless notifications are wanted, unread, the words. */
export function gmailQuery(o: ReturnType<typeof inboxOptions>): string {
  return [
    'in:inbox',
    `newer_than:${o.days}d`,
    ...(o.includeAutomated ? [] : ['-category:promotions', '-category:social', '-category:forums']),
    ...(o.unreadOnly ? ['is:unread'] : []),
    ...(o.query ? [o.query] : []),
  ].join(' ');
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

interface Known {
  personId: string;
  name: string | null;
  photoUrl: string | null;
  linkedinUrl: string | null;
}

/** People the student knows by these addresses (person_identities kind email). */
async function peopleByEmail(db: Db, userId: string, emails: string[]): Promise<Map<string, Known>> {
  const out = new Map<string, Known>();
  if (!emails.length) return out;
  const rows = await db.sql<{
    value_norm: string;
    id: string;
    display_name: string | null;
    photo_url: string | null;
    linkedin_url: string | null;
  }>`
    select pi.value_norm, p.id, p.display_name, p.photo_url, p.linkedin_url
      from orbit.person_identities pi join orbit.people p on p.id = pi.person_id
     where pi.user_id = ${userId}::uuid and pi.kind = 'email' and pi.value_norm = any(${emails}::text[])
       and not p.is_self`;
  for (const r of rows)
    if (!out.has(r.value_norm))
      out.set(r.value_norm, {
        personId: r.id,
        name: r.display_name,
        photoUrl: r.photo_url,
        linkedinUrl: r.linkedin_url,
      });
  return out;
}

async function readEmail(
  deps: InboxDeps,
  userId: string,
  o: ReturnType<typeof inboxOptions>,
  self: { email: string | null },
): Promise<{ items: InboxItem[]; status: InboxListResponse['email'] }> {
  if (!deps.gmail) return { items: [], status: 'not_connected' };
  let msgs: GmailMessage[];
  try {
    // a few more than asked, since several messages of one thread fold into one row
    const page = await deps.gmail.list(gmailQuery(o), { maxResults: Math.min(100, o.limit * 2) });
    const ids = page.messages ?? [];
    msgs = (await pool(ids, PARALLEL_READS, (m) => deps.gmail!.metadata(m.id).catch(() => undefined))).filter(
      (m): m is GmailMessage => !!m,
    );
  } catch (e) {
    if (e instanceof NeedsReauth || (e as { name?: string })?.name === 'NeedsReauth')
      return { items: [], status: 'needs_reauth' };
    return { items: [], status: 'error' };
  }
  const own = (self.email ?? '').toLowerCase();
  const parsed = msgs
    .map((m) => {
      const h = headerMap(m.payload);
      const from = parseAddress(h.from ?? '');
      const labels = m.labelIds ?? [];
      const at = Number(m.internalDate);
      const when = Number.isFinite(at) && at > 0 ? new Date(at) : new Date(h.date ?? '');
      return {
        m,
        from,
        subject: h.subject ?? null,
        at: Number.isNaN(when.getTime()) ? deps.now : when,
        unread: labels.includes('UNREAD'),
        sentByMe: labels.includes('SENT') || (!!own && from.email === own),
        automated:
          !from.email || isAutomatedSender(from.email, h, labels, from.name) || isAtsSender(from.email),
      };
    })
    .filter((x) => !x.sentByMe && (o.includeAutomated || !x.automated));
  // one row a thread: its newest message, with how many came in it
  const byThread = new Map<string, { row: (typeof parsed)[number]; n: number; unread: boolean }>();
  for (const x of parsed) {
    const t = byThread.get(x.m.threadId);
    if (!t) byThread.set(x.m.threadId, { row: x, n: 1, unread: x.unread });
    else {
      t.n++;
      t.unread ||= x.unread;
      if (x.at > t.row.at) t.row = x;
    }
  }
  const threads = [...byThread.entries()];
  const known = await peopleByEmail(deps.db, userId, [
    ...new Set(threads.map(([, t]) => t.row.from.email).filter(Boolean)),
  ]);
  const account = own ? `?authuser=${encodeURIComponent(own)}` : '';
  const items = threads.map(([threadId, t]): InboxItem => {
    const p = known.get(t.row.from.email);
    return {
      key: `gmail:${threadId}`,
      channel: 'email',
      fromName: p?.name ?? t.row.from.name ?? t.row.from.email.split('@')[0] ?? 'Someone',
      fromEmail: t.row.from.email || null,
      personId: p?.personId ?? null,
      photoUrl: p?.photoUrl ?? null,
      linkedinUrl: p?.linkedinUrl ?? null,
      subject: t.row.subject,
      snippet: decodeEntities(t.row.m.snippet ?? '').slice(0, 220),
      receivedAt: t.row.at.toISOString(),
      count: t.n,
      unread: t.unread,
      automated: t.row.automated || undefined,
      href: `https://mail.google.com/mail/${account}#inbox/${threadId}`,
    };
  });
  return { items, status: 'ok' };
}

/** Gmail's snippets come HTML-escaped. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readLinkedIn(
  deps: InboxDeps,
  userId: string,
  o: ReturnType<typeof inboxOptions>,
): Promise<{ items: InboxItem[]; status: InboxListResponse['linkedin']; syncedAt: string | null }> {
  const [acct] = await deps.db.sql<{ status: string; last_synced_at: Date | null }>`
    select status, last_synced_at from orbit.integration_accounts
     where user_id = ${userId}::uuid and provider = 'linkedin' and external_account_id is not null`;
  if (acct?.status !== 'active') return { items: [], status: 'not_connected', syncedAt: null };
  const since = new Date(deps.now.getTime() - o.days * DAY);
  const like = o.query ? `%${o.query.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
  const rows = await deps.db.sql<{
    thread_id: string;
    sent_at: Date;
    snippet: string | null;
    body_text: string | null;
    person_id: string | null;
    display_name: string | null;
    photo_url: string | null;
    linkedin_url: string | null;
    n: number;
    wrote: boolean;
  }>`
    select * from (
      select m.thread_id, m.sent_at, m.snippet, m.body_text, p.id as person_id, p.display_name, p.photo_url,
             p.linkedin_url,
             row_number() over (partition by m.thread_id order by m.sent_at desc) as rn,
             (count(*) over (partition by m.thread_id))::int as n,
             exists (select 1 from orbit.messages o where o.thread_id = m.thread_id and o.user_id = m.user_id
                        and o.direction = 'out' and o.sent_at < m.sent_at) as wrote
        from orbit.messages m
        left join orbit.people p on p.id = m.from_person_id
       where m.user_id = ${userId}::uuid and m.provider = 'linkedin' and m.direction = 'in'
         and m.sent_at >= ${since}::timestamptz
         and (${like}::text is null or m.body_text ilike ${like} or m.snippet ilike ${like}
              or p.display_name ilike ${like})
    ) x
    where rn = 1
    order by sent_at desc
    limit ${o.limit}`;
  const items = rows.map(
    (r): InboxItem => ({
      key: `linkedin:${r.thread_id}`,
      channel: 'linkedin',
      fromName: r.display_name ?? 'Someone on LinkedIn',
      personId: r.person_id,
      photoUrl: r.photo_url,
      linkedinUrl: r.linkedin_url,
      snippet: (r.snippet ?? r.body_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 220),
      receivedAt: iso(r.sent_at)!,
      count: num(r.n) || 1,
      replyToYou: r.wrote,
      href: r.person_id ? `/people/${r.person_id}` : 'https://www.linkedin.com/messaging/',
    }),
  );
  return { items, status: 'ok', syncedAt: iso(acct.last_synced_at) };
}

/** Email and LinkedIn read at the same time, merged newest first. */
export async function listInbox(
  deps: InboxDeps,
  userId: string,
  body: InboxListRequest,
): Promise<InboxListResponse> {
  const o = inboxOptions(body);
  const [u] = await deps.db.sql<{
    email: string | null;
  }>`select email from orbit.users where id = ${userId}::uuid`;
  const [email, linkedin] = await Promise.all([
    o.channel === 'linkedin'
      ? Promise.resolve({ items: [], status: 'skipped' as const })
      : readEmail(deps, userId, o, { email: u?.email ?? null }),
    o.channel === 'email'
      ? Promise.resolve({ items: [], status: 'skipped' as const, syncedAt: null })
      : readLinkedIn(deps, userId, o),
  ]);
  const items = [...email.items, ...linkedin.items]
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, o.limit);
  return { items, email: email.status, linkedin: linkedin.status, linkedinSyncedAt: linkedin.syncedAt };
}
