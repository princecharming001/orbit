/**
 * X through its own API v2 (plan 43 §5), as a `SocialAdapter`.
 *
 * - Every call is priced and reserved through the budget before it is made, and settled with what X returned: a
 *   list page is reserved for `max_results` users and the difference is given back once the page arrives.
 * - Follow lists ask for `connection_status`, X's word on each account's relation to the signed-in student, so the
 *   student's own follow-back list never needs reading (`relations` on each page).
 * - DMs come from /2/dm_events (the last 30 days, X's limit), grouped by conversation. Only event ids, the sender and
 *   the participants are asked for: no user expansions, so nothing comes back that was not priced.
 * - There is no `search`: on X, accounts are tied to people by public proof only (match.ts), never by a name search.
 * - A 401 is answered by one token refresh and one retry; a refused refresh throws `SocialSignInNeeded('x')`.
 */
import type { SocialAccount } from '@orbit/core/entity/social';
import {
  type SocialAdapter,
  type SocialBudget,
  SocialBudgetSpent,
  type SocialCallKind,
  type SocialChat,
  type SocialList,
  type SocialListPage,
  type SocialMessage,
  type SocialPage,
  type SocialProfileRead,
  SocialSignInNeeded,
} from '../adapter.ts';
import { X_API } from './config.ts';
import type { XTokens } from './oauth.ts';

export const X_USER_FIELDS = [
  'username',
  'name',
  'description',
  'entities',
  'location',
  'verified',
  'protected',
  'public_metrics',
  'profile_image_url',
  'url',
  'connection_status',
  'receives_your_dm',
].join(',');

export const X_DM_FIELDS = 'id,text,event_type,created_at,dm_conversation_id,sender_id,participant_ids';

/** The largest page X returns: follow lists 1000, DM events 100. */
export const X_LIST_PAGE = 1000;
export const X_DM_PAGE = 100;

interface XUrlEntity {
  url?: string;
  expanded_url?: string;
  display_url?: string;
}

export interface XUser {
  id: string;
  username: string;
  name?: string;
  description?: string;
  location?: string;
  url?: string;
  verified?: boolean;
  protected?: boolean;
  profile_image_url?: string;
  public_metrics?: {
    followers_count?: number;
    following_count?: number;
    tweet_count?: number;
    listed_count?: number;
  };
  entities?: { url?: { urls?: XUrlEntity[] }; description?: { urls?: XUrlEntity[] } };
  connection_status?: string[];
  receives_your_dm?: boolean;
}

export interface XDmEvent {
  id: string;
  event_type: 'MessageCreate' | 'ParticipantsJoin' | 'ParticipantsLeave' | string;
  created_at?: string;
  dm_conversation_id?: string;
  text?: string;
  sender_id?: string;
  participant_ids?: string[];
}

export interface XProblem {
  title?: string;
  detail?: string;
  type?: string;
  resource_id?: string;
  value?: string;
}

/** X answered with an error: a problem type such as dm-recipient-not-accepting, or an HTTP status. */
export class XApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly detail?: string,
  ) {
    super(`x ${status} ${type}`);
  }
  /** the short name at the end of X's problem type URL ("dm-recipient-not-accepting") */
  get problem(): string {
    return this.type.split('/').pop() ?? this.type;
  }
}

/** The account is suspended, deleted or not there: what Orbit holds of it is dropped (lists.ts). */
export class XAccountGone extends Error {
  constructor(
    readonly ref: string,
    readonly why: 'suspended' | 'not_found',
  ) {
    super(`x account ${why}`);
  }
}

/** The account is protected: its lists are never read and what Orbit holds of it is dropped. */
export class XAccountProtected extends Error {
  constructor(readonly accountId: string) {
    super('x account protected');
  }
}

/** X's rate limit for this endpoint and student is used up; `resetAt` is when it frees. */
export class XRateLimited extends Error {
  constructor(readonly resetAt?: Date) {
    super('x rate limited');
  }
}

/** A reserved price: settle with how many units really came back (0 when the call failed). */
export interface XReservation {
  settle(unitsUsed: number): Promise<void>;
}

/** The X budget: SocialBudget, plus reserve-then-settle so a page can be priced for its most and refunded after. */
export interface XBudget extends SocialBudget {
  reserve(kind: SocialCallKind, units: number): Promise<XReservation | undefined>;
}

/** A profile read, with what X says about messaging them. */
export interface XProfileRead extends SocialProfileRead {
  /** the account accepts DMs from the student */
  receivesYourDm?: boolean;
  location?: string;
}

/** One raw page of DM events, already grouped, for polling. */
export interface XDmPage {
  /** the events on the page, newest first, as X returns them */
  events: XDmEvent[];
  chats: SocialChat[];
  messages: SocialMessage[];
  cursor?: string;
}

export interface XAdapter extends SocialAdapter {
  platform: 'x';
  profile(ref: string): Promise<XProfileRead>;
  listPage(
    accountId: string,
    list: SocialList,
    cursor?: string,
    maxResults?: number,
  ): Promise<SocialListPage>;
  dmEvents(opts?: { maxResults?: number; cursor?: string }): Promise<XDmPage>;
}

export interface XAdapterOptions {
  tokens: XTokens;
  budget: XBudget;
  /** the student's own X id, to tell their messages from the other side's */
  meId?: string;
  fetch?: typeof fetch;
  base?: string;
}

/** X's user object as Orbit's account. Links come from the profile's url and the links in the bio. */
export function mapXUser(u: XUser): SocialAccount {
  const links = new Set<string>();
  for (const e of [...(u.entities?.url?.urls ?? []), ...(u.entities?.description?.urls ?? [])]) {
    const l = e.expanded_url ?? e.display_url ?? e.url;
    if (l) links.add(l);
  }
  if (!u.entities?.url?.urls?.length && u.url) links.add(u.url);
  const a: SocialAccount = { platform: 'x', id: u.id, username: u.username };
  if (u.name) a.name = u.name;
  if (u.description) a.bio = u.description;
  if (links.size) a.links = [...links];
  if (typeof u.public_metrics?.followers_count === 'number') a.followers = u.public_metrics.followers_count;
  if (typeof u.public_metrics?.following_count === 'number') a.following = u.public_metrics.following_count;
  if (typeof u.verified === 'boolean') a.verified = u.verified;
  if (typeof u.protected === 'boolean') a.isPrivate = u.protected;
  if (u.profile_image_url) a.defaultPicture = /default_profile_images/.test(u.profile_image_url);
  return a;
}

/** connection_status → the relation to the signed-in student. */
export function xRelation(u: Pick<XUser, 'connection_status'>): { following: boolean; followedBy: boolean } {
  const s = new Set(u.connection_status ?? []);
  return { following: s.has('following'), followedBy: s.has('followed_by') };
}

/**
 * Participants of a one-to-one conversation are in its id ("<lower id>-<higher id>"); a group's id is a single number,
 * so its participants come from the events.
 */
export function oneToOneIds(conversationId: string): [string, string] | undefined {
  const m = conversationId.match(/^(\d+)-(\d+)$/);
  return m ? [m[1]!, m[2]!] : undefined;
}

/** Groups DM events into chats and messages. `meId` is the student. */
export function groupDmEvents(
  events: XDmEvent[],
  meId: string | undefined,
): Pick<XDmPage, 'chats' | 'messages'> {
  const byChat = new Map<string, { people: Set<string>; lastAt?: string }>();
  const messages: SocialMessage[] = [];
  for (const e of events) {
    const chatId = e.dm_conversation_id;
    if (!chatId) continue;
    let c = byChat.get(chatId);
    if (!c) {
      c = { people: new Set(oneToOneIds(chatId) ?? []) };
      byChat.set(chatId, c);
    }
    if (e.sender_id) c.people.add(e.sender_id);
    for (const p of e.participant_ids ?? []) c.people.add(p);
    if (e.created_at && (!c.lastAt || e.created_at > c.lastAt)) c.lastAt = e.created_at;
    if (e.event_type !== 'MessageCreate') continue;
    const text = e.text ?? '';
    messages.push({
      messageId: e.id,
      chatId,
      at: e.created_at ?? '',
      fromStudent: !!meId && e.sender_id === meId,
      senderAccountId: e.sender_id ?? '',
      text,
      hasWords: text.trim().length > 0,
    });
  }
  const chats: SocialChat[] = [...byChat].map(([chatId, c]) => {
    if (meId) c.people.add(meId);
    const others = [...c.people].filter((p) => p !== meId).map((accountId) => ({ accountId }));
    return { chatId, participants: c.people.size, others, ...(c.lastAt ? { lastAt: c.lastAt } : {}) };
  });
  return { chats, messages };
}

export function createXAdapter(o: XAdapterOptions): XAdapter {
  const base = (o.base ?? X_API).replace(/\/+$/, '');
  const doFetch = o.fetch ?? fetch;

  async function call(
    method: 'GET' | 'POST',
    path: string,
    query?: Record<string, string | number | undefined>,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') q.set(k, String(v));
    const url = `${base}${path}${q.size ? `?${q}` : ''}`;
    const send = (token: string) =>
      doFetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    let res = await send(await o.tokens.accessToken());
    if (res.status === 401) {
      await res.body?.cancel();
      res = await send(await o.tokens.refreshed());
      if (res.status === 401) {
        await res.body?.cancel();
        throw new SocialSignInNeeded('x');
      }
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    if (res.status === 429) {
      const reset = Number(res.headers.get('x-rate-limit-reset'));
      throw new XRateLimited(Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : undefined);
    }
    if (!res.ok) {
      const errs = parsed.errors as XProblem[] | undefined;
      const type = String(parsed.type ?? errs?.[0]?.type ?? `http_${res.status}`);
      throw new XApiError(res.status, type, String(parsed.detail ?? errs?.[0]?.detail ?? ''));
    }
    return { status: res.status, body: parsed };
  }

  /** Reserve, call, settle with what came back; nothing is settled above what was reserved. */
  async function priced<T>(
    kind: SocialCallKind,
    units: number,
    run: () => Promise<{ value: T; used: number }>,
  ): Promise<T> {
    const r = await o.budget.reserve(kind, units);
    if (!r) throw new SocialBudgetSpent(kind, (await o.budget.retryAt?.(kind)) ?? undefined);
    let used = 0;
    try {
      const out = await run();
      used = Math.min(units, out.used);
      return out.value;
    } finally {
      await r.settle(used);
    }
  }

  /** A user lookup's errors: suspended or missing accounts come back as a 200 with `errors`. */
  function gone(ref: string, b: Record<string, unknown>): XAccountGone {
    const err = (b.errors as XProblem[] | undefined)?.[0];
    const text = `${err?.title ?? ''} ${err?.detail ?? ''}`.toLowerCase();
    return new XAccountGone(ref, text.includes('suspend') ? 'suspended' : 'not_found');
  }

  function profileRead(u: XUser): XProfileRead {
    const out: XProfileRead = { account: mapXUser(u), relation: xRelation(u) };
    if (typeof u.receives_your_dm === 'boolean') out.receivesYourDm = u.receives_your_dm;
    if (u.location) out.location = u.location;
    return out;
  }

  const userPath = (ref: string) => {
    const r = ref.trim().replace(/^@/, '');
    return /^\d+$/.test(r) ? `/2/users/${r}` : `/2/users/by/username/${encodeURIComponent(r)}`;
  };

  async function dmPage(path: string, maxResults: number, cursor?: string): Promise<XDmPage> {
    const n = Math.max(1, Math.min(X_DM_PAGE, Math.floor(maxResults)));
    return priced('messages', n, async () => {
      const { body } = await call('GET', path, {
        max_results: n,
        pagination_token: cursor,
        event_types: 'MessageCreate,ParticipantsJoin,ParticipantsLeave',
        'dm_event.fields': X_DM_FIELDS,
      });
      const events = (body.data as XDmEvent[] | undefined) ?? [];
      const meta = (body.meta as { next_token?: string; result_count?: number } | undefined) ?? {};
      const grouped = groupDmEvents(events, o.meId);
      return {
        value: { events, ...grouped, ...(meta.next_token ? { cursor: meta.next_token } : {}) },
        used: meta.result_count ?? events.length,
      };
    });
  }

  return {
    platform: 'x',
    pageSize: () => X_LIST_PAGE,

    me: () =>
      priced('profile', 1, async () => {
        const { body } = await call('GET', '/2/users/me', { 'user.fields': X_USER_FIELDS });
        const u = body.data as XUser | undefined;
        if (!u?.id) throw gone('me', body);
        return { value: profileRead(u), used: 1 };
      }),

    profile: (ref) =>
      priced('profile', 1, async () => {
        const { body } = await call('GET', userPath(ref), { 'user.fields': X_USER_FIELDS });
        const data = body.data as XUser | undefined;
        // a suspended or missing account is returned as an error and is not billed as a user
        if (!data?.id) throw gone(ref, body);
        return { value: profileRead(data), used: 1 };
      }),

    listPage: (accountId, list, cursor, maxResults = X_LIST_PAGE) => {
      const n = Math.max(1, Math.min(X_LIST_PAGE, Math.floor(maxResults)));
      return priced('list', n, async () => {
        const { body } = await call('GET', `/2/users/${encodeURIComponent(accountId)}/${list}`, {
          max_results: n,
          pagination_token: cursor,
          'user.fields': X_USER_FIELDS,
        });
        const users = body.data as XUser[] | undefined;
        if (!users && (body.errors as XProblem[] | undefined)?.length) {
          const err = (body.errors as XProblem[])[0]!;
          const text = `${err.title ?? ''} ${err.detail ?? ''} ${err.type ?? ''}`.toLowerCase();
          if (text.includes('suspend')) throw new XAccountGone(accountId, 'suspended');
          if (text.includes('not-found') || text.includes('not found'))
            throw new XAccountGone(accountId, 'not_found');
          throw new XAccountProtected(accountId);
        }
        const meta = (body.meta as { next_token?: string; result_count?: number } | undefined) ?? {};
        const page: SocialListPage = {
          ids: (users ?? []).map((u) => u.id),
          accounts: (users ?? []).map(mapXUser),
          relations: Object.fromEntries((users ?? []).map((u) => [u.id, xRelation(u)])),
        };
        if (meta.next_token) page.cursor = meta.next_token;
        return { value: page, used: meta.result_count ?? page.ids.length };
      });
    },

    dmEvents: (opts = {}) => dmPage('/2/dm_events', opts.maxResults ?? X_DM_PAGE, opts.cursor),

    async chats(cursor) {
      const page = await dmPage('/2/dm_events', X_DM_PAGE, cursor);
      return { items: page.chats, ...(page.cursor ? { cursor: page.cursor } : {}) };
    },

    async messages(chatId, cursor): Promise<SocialPage<SocialMessage>> {
      const pair = oneToOneIds(chatId);
      const other = pair && o.meId ? pair.find((p) => p !== o.meId) : undefined;
      const path = other
        ? `/2/dm_conversations/with/${other}/dm_events`
        : `/2/dm_conversations/${encodeURIComponent(chatId)}/dm_events`;
      const page = await dmPage(path, X_DM_PAGE, cursor);
      return {
        items: page.messages.filter((m) => m.chatId === chatId),
        ...(page.cursor ? { cursor: page.cursor } : {}),
      };
    },

    send: (to, text) =>
      priced('send', 1, async () => {
        const path = to.accountId
          ? `/2/dm_conversations/with/${encodeURIComponent(to.accountId)}/messages`
          : to.chatId
            ? `/2/dm_conversations/${encodeURIComponent(to.chatId)}/messages`
            : undefined;
        if (!path) throw new Error('send needs a chat or an account');
        const { body } = await call('POST', path, undefined, { text });
        const d = body.data as { dm_conversation_id?: string; dm_event_id?: string } | undefined;
        return {
          value: { messageId: d?.dm_event_id ?? '', chatId: d?.dm_conversation_id ?? to.chatId ?? '' },
          used: 1,
        };
      }),
  };
}
