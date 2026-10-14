/**
 * In-memory stand-ins for the provider APIs the sync jobs call: Gmail v1, Calendar v3, People v1 and Unipile. Each
 * answers through one `fetch`, records every call with the virtual time it was made at, and can be told to fail
 * (a 404 history, a 410 sync token, a crash on a given call). Time is virtual: `clock()` reads it and `sleep(ms)`
 * advances it, so pacing tests run instantly.
 */
import type { CalendarApiEvent } from '../../functions/_shared/calendar.ts';
import type { ContactPerson } from '../../functions/_shared/contacts.ts';
import type { GmailMessage } from '../../functions/_shared/gmail.ts';

export interface VirtualTime {
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  advance(ms: number): void;
}

export function virtualTime(start = Date.parse('2026-10-14T12:00:00Z')): VirtualTime {
  let t = start;
  return {
    clock: () => t,
    sleep: async (ms) => {
      t += Math.max(0, ms);
    },
    now: () => new Date(t),
    advance(ms) {
      t += ms;
    },
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const b64url = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

// ---- mail fixtures --------------------------------------------------------------------------------------------------

export interface MailSpec {
  id: string;
  threadId: string;
  from: string;
  to?: string[];
  cc?: string[];
  subject: string;
  body: string;
  /** ISO time */
  at: string;
  labels?: string[];
  headers?: Record<string, string>;
  html?: boolean;
}

export interface Call {
  url: string;
  method: string;
  body: string;
  at: number;
  units: number;
}

/** Quota units of a Google URL, as the plan prices them (§12.5). */
export function unitsOf(url: string, method = 'GET'): number {
  if (url.includes('gmail.googleapis.com')) {
    if (url.includes('/watch')) return 100;
    if (url.includes('/history')) return 2;
    if (url.includes('/threads/')) return 40;
    if (/\/messages\/[^/?]+/.test(url)) return 20;
    if (url.includes('/messages')) return 5;
    return 1;
  }
  return method === 'POST' ? 1 : 1;
}

export class FakeGoogle {
  mails: MailSpec[] = [];
  calls: Call[] = [];
  historyId = 5000;
  /** history records: id and the messages added */
  history: { id: string; messages: string[] }[] = [];
  /** history ids older than this answer 404 */
  historyFloor = 0;
  sendAs = [{ sendAsEmail: 'maya@example.com', isPrimary: true, verificationStatus: 'accepted' }];
  events: CalendarApiEvent[] = [];
  /** events changed since the last sync token (served to syncToken reads) */
  changedEvents: CalendarApiEvent[] = [];
  calendarTokenValid = true;
  otherContacts: ContactPerson[] = [];
  connections: ContactPerson[] = [];
  /** a function that may throw or answer instead, per call (crash injection) */
  intercept?: (c: Call) => Response | undefined;
  /** answers 401 to every Google API call */
  unauthorized = false;

  constructor(
    readonly time: VirtualTime,
    readonly email = 'maya@example.com',
  ) {}

  add(...m: MailSpec[]) {
    this.mails.push(...m);
  }

  private message(m: MailSpec, format: 'metadata' | 'full', wanted?: string[]): GmailMessage {
    const headers: Record<string, string> = {
      From: m.from,
      To: (m.to ?? []).join(', '),
      ...(m.cc?.length ? { Cc: m.cc.join(', ') } : {}),
      Subject: m.subject,
      Date: new Date(m.at).toUTCString(),
      'Message-ID': `<${m.id}@mail.example>`,
      ...(m.headers ?? {}),
    };
    const list = Object.entries(headers)
      .filter(([k]) => !wanted || wanted.some((w) => w.toLowerCase() === k.toLowerCase()))
      .map(([name, value]) => ({ name, value }));
    const body =
      format === 'full'
        ? m.html
          ? {
              mimeType: 'multipart/alternative',
              parts: [{ mimeType: 'text/html', body: { data: b64url(m.body), size: m.body.length } }],
            }
          : { mimeType: 'text/plain', body: { data: b64url(m.body), size: m.body.length } }
        : { mimeType: 'text/plain' };
    return {
      id: m.id,
      threadId: m.threadId,
      labelIds: m.labels ?? ['INBOX'],
      snippet: m.body.slice(0, 80),
      internalDate: String(Date.parse(m.at)),
      payload: { ...body, headers: list },
    };
  }

  private list(q: string, pageToken: string | null, max: number) {
    const now = this.time.clock();
    let from = Number.NEGATIVE_INFINITY;
    let to = Number.POSITIVE_INFINITY;
    const newer = /newer_than:(\d+)d/.exec(q);
    if (newer) from = now - Number(newer[1]) * 86_400_000;
    const after = /after:(\d+)/.exec(q);
    if (after) from = Number(after[1]) * 1000;
    const before = /before:(\d+)/.exec(q);
    if (before) to = Number(before[1]) * 1000;
    const hits = this.mails
      .filter((m) => {
        const t = Date.parse(m.at);
        return t > from && t < to && !(m.labels ?? []).includes('CHAT');
      })
      .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
    const start = pageToken ? Number(pageToken) : 0;
    const page = hits.slice(start, start + max);
    const next = start + max < hits.length ? String(start + max) : undefined;
    return {
      messages: page.map((m) => ({ id: m.id, threadId: m.threadId })),
      ...(next ? { nextPageToken: next } : {}),
      resultSizeEstimate: hits.length,
    };
  }

  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    const call: Call = {
      url,
      method,
      body: typeof init.body === 'string' ? init.body : '',
      at: this.time.clock(),
      units: unitsOf(url, method),
    };
    this.calls.push(call);
    const hijack = this.intercept?.(call);
    if (hijack) return hijack;
    if (this.unauthorized) return json(401, { error: { status: 'UNAUTHENTICATED' } });
    const u = new URL(url);
    const p = u.searchParams;
    const path = u.pathname;
    if (u.host === 'gmail.googleapis.com') {
      if (path.endsWith('/users/me/messages'))
        return json(200, this.list(p.get('q') ?? '', p.get('pageToken'), Number(p.get('maxResults') ?? 100)));
      const msg = /\/users\/me\/messages\/([^/]+)$/.exec(path);
      if (msg) {
        const m = this.mails.find((x) => x.id === decodeURIComponent(msg[1]!));
        if (!m) return json(404, { error: { errors: [{ reason: 'notFound' }] } });
        return json(200, this.message(m, 'metadata', p.getAll('metadataHeaders')));
      }
      const thread = /\/users\/me\/threads\/([^/]+)$/.exec(path);
      if (thread) {
        const tid = decodeURIComponent(thread[1]!);
        const ms = this.mails.filter((x) => x.threadId === tid).sort((a, b) => a.at.localeCompare(b.at));
        if (!ms.length) return json(404, { error: { errors: [{ reason: 'notFound' }] } });
        return json(200, { id: tid, messages: ms.map((m) => this.message(m, 'full')) });
      }
      if (path.endsWith('/history')) {
        const start = Number(p.get('startHistoryId'));
        if (start < this.historyFloor) return json(404, { error: { errors: [{ reason: 'notFound' }] } });
        const recs = this.history.filter((h) => Number(h.id) > start);
        return json(200, {
          history: recs.map((h) => ({
            id: h.id,
            messagesAdded: h.messages.map((id) => {
              const m = this.mails.find((x) => x.id === id)!;
              return { message: { id, threadId: m.threadId, labelIds: m.labels ?? ['INBOX'] } };
            }),
          })),
          historyId: String(this.historyId),
        });
      }
      if (path.endsWith('/profile'))
        return json(200, { emailAddress: this.email, historyId: String(this.historyId) });
      if (path.endsWith('/watch'))
        return json(200, {
          historyId: String(this.historyId),
          expiration: String(this.time.clock() + 7 * 86_400_000),
        });
      if (path.endsWith('/settings/sendAs')) return json(200, { sendAs: this.sendAs });
    }
    if (u.host === 'www.googleapis.com' && path.includes('/calendar/v3/calendars/primary/events')) {
      const token = p.get('syncToken');
      if (token) {
        if (!this.calendarTokenValid || token !== 'cal-sync-1')
          return json(410, { error: { status: 'GONE' } });
        return json(200, { items: this.changedEvents, nextSyncToken: 'cal-sync-1' });
      }
      const min = Date.parse(p.get('timeMin')!);
      const max = Date.parse(p.get('timeMax')!);
      const items = this.events.filter((e) => {
        const t = Date.parse(e.start?.dateTime ?? `${e.start?.date}T00:00:00Z`);
        return t >= min && t <= max;
      });
      this.calendarTokenValid = true;
      return json(200, { items, nextSyncToken: 'cal-sync-1' });
    }
    if (u.host === 'people.googleapis.com') {
      const other = path.endsWith('/otherContacts');
      return json(200, {
        [other ? 'otherContacts' : 'connections']: other ? this.otherContacts : this.connections,
        nextSyncToken: other ? 'other-1' : 'conn-1',
      });
    }
    return json(404, { error: { errors: [{ reason: 'notFound' }] } });
  }) as typeof fetch;

  /** Quota units spent in the busiest rolling second. */
  peakUnitsPerSecond(): number {
    const gmail = this.calls.filter((c) => c.url.includes('googleapis.com'));
    let peak = 0;
    for (const c of gmail) {
      const sum = gmail.filter((x) => x.at > c.at - 1000 && x.at <= c.at).reduce((s, x) => s + x.units, 0);
      peak = Math.max(peak, sum);
    }
    return peak;
  }
}

// ---- Unipile ---------------------------------------------------------------------------------------------------------

export interface FakeChat {
  id: string;
  attendees: { id: string; provider_id: string; name: string; is_self?: number; profile_url?: string }[];
  messages: { id: string; sender_id: string; text: string; timestamp: string; is_sender?: number }[];
}

export class FakeUnipile {
  calls: string[] = [];
  me = { provider_id: 'ACoMaya', public_identifier: 'mayachen', first_name: 'Maya', last_name: 'Chen' };
  relations: Record<string, unknown>[] = [];
  chats: FakeChat[] = [];
  relationsPageSize = 1000;

  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    this.calls.push(`${(init.method ?? 'GET').toUpperCase()} ${url}`);
    const u = new URL(url);
    const p = u.searchParams;
    if (u.pathname === '/api/v1/users/me') return json(200, this.me);
    if (u.pathname === '/api/v1/users/relations') {
      const start = Number(p.get('cursor') ?? 0);
      const items = this.relations.slice(start, start + this.relationsPageSize);
      const next =
        start + this.relationsPageSize < this.relations.length
          ? String(start + this.relationsPageSize)
          : null;
      return json(200, { object: 'UserRelationsList', items, cursor: next });
    }
    if (u.pathname === '/api/v1/chats')
      return json(200, {
        object: 'ChatList',
        items: this.chats.map((c) => ({
          id: c.id,
          type: c.attendees.length <= 2 ? 0 : 1,
          timestamp: c.messages.at(-1)?.timestamp,
        })),
        cursor: null,
      });
    const att = /^\/api\/v1\/chats\/([^/]+)\/attendees$/.exec(u.pathname);
    if (att) {
      const c = this.chats.find((x) => x.id === decodeURIComponent(att[1]!));
      return json(200, { items: c?.attendees ?? [] });
    }
    const msgs = /^\/api\/v1\/chats\/([^/]+)\/messages$/.exec(u.pathname);
    if (msgs) {
      const c = this.chats.find((x) => x.id === decodeURIComponent(msgs[1]!));
      return json(200, { items: (c?.messages ?? []).map((m) => ({ ...m, chat_id: c?.id })), cursor: null });
    }
    if (u.pathname === '/api/v1/hosted/accounts/link' && init.method === 'POST')
      return json(201, { object: 'HostedAuthURL', url: 'https://account.unipile.test/hosted/abc' });
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
}
