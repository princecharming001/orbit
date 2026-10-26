/**
 * Unipile (live LinkedIn): an optional way to connect a student's own LinkedIn account through Unipile's hosted
 * login and pull their connections live, instead of uploading the Connections.csv export, plus "who do I know who
 * knows X" (mutual connections) for real second-degree routes. It is reached through Orbit's own server function
 * (supabase/functions/orbit-connectors), which holds the Unipile API key; the browser never sees it. Off unless the
 * build sets VITE_ORBIT_LINKEDIN_PROXY. The CSV import stays as the always-available fallback.
 *
 * Every call returns a typed outcome instead of throwing: `unconfigured` when the proxy answers 503 with
 * x-orbit-connector: unconfigured (the key is not pasted yet), `timeout` when Unipile is slow, `error` otherwise. The
 * sample student never reaches this file: engine/linkedinLive.ts answers it from integrations/connectorsMock.ts.
 *
 * All request and response shapes are mapped here behind one adapter, so a real Unipile key and a live test only
 * ever need changes in this file. Connections come back in the same shape the CSV parser produces.
 */
import {
  automationOverride,
  type ConnectorFailureReason,
  type ConnectorOutcome,
  connectorFailure,
  isUnconfigured,
} from './connectorOutcome';

let override: string | null | undefined;

/** Test hook: a proxy URL to use, null for none, or undefined to restore the build-time setting. */
export function setUnipileUrlForTests(url: string | null | undefined): void {
  override = url;
}

/** Stands in for the proxy when a test asks for the "key not pasted yet" answer; never fetched. */
export const UNCONFIGURED_PROXY = 'unconfigured:';

export function unipileUrl(): string | undefined {
  if (override !== undefined) return override ?? undefined;
  const mode = automationOverride();
  if (mode === 'unconfigured') return UNCONFIGURED_PROXY;
  if (mode !== 'live') return undefined;
  const url = (import.meta.env.VITE_ORBIT_LINKEDIN_PROXY as string | undefined)?.trim();
  return url ? url.replace(/\/+$/, '') : undefined;
}

export function unipileConfigured(): boolean {
  return !!unipileUrl();
}

/** How long one Unipile call may take before Orbit gives up on it. */
export const UNIPILE_TIMEOUT_MS = 20_000;

/** A connection as Unipile returns it, mapped to the fields the CSV import uses. */
export interface LiveConnection {
  firstName: string;
  lastName: string;
  position?: string;
  company?: string;
  url?: string;
  /** YYYY-MM-DD, when Unipile gives the connected date */
  connectedOn?: string;
  /** Unipile's member id, kept so mutual-connection lookups can reference this person */
  memberId?: string;
  /** their LinkedIn photo (a link that expires after a few weeks) */
  photoUrl?: string;
}

/** One mutual connection: someone in the student's network who is connected to the target. */
export interface Mutual {
  name: string;
  headline?: string;
  url?: string;
  memberId?: string;
  /** LinkedIn's photo link, for showing only (it expires) */
  pictureUrl?: string;
}

export interface CallOpts {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** the account token /connect/status gave this browser; the server refuses account calls without it */
  token?: string;
}

/** One POST to the proxy, as an outcome: never throws. */
async function call<T>(path: string, body: unknown, opts: CallOpts = {}): Promise<ConnectorOutcome<T>> {
  const base = unipileUrl();
  if (!base) return connectorFailure('unconfigured', 'Live LinkedIn is not set up in this copy of Orbit.');
  if (base === UNCONFIGURED_PROXY)
    return connectorFailure('unconfigured', 'Live LinkedIn is not switched on yet.', 503);
  const doFetch = opts.fetch ?? fetch;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs ?? UNIPILE_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    if (isUnconfigured(res))
      return connectorFailure('unconfigured', 'Live LinkedIn is not switched on yet.', res.status);
    if (!res.ok) return connectorFailure('error', `LinkedIn did not answer (${res.status}).`, res.status);
    return { ok: true, value: (await res.json()) as T };
  } catch (e) {
    if (timedOut) return connectorFailure('timeout', 'LinkedIn took too long to answer. Try again.');
    if (opts.signal?.aborted) return connectorFailure('error', 'Stopped.');
    return connectorFailure('error', e instanceof Error ? e.message : 'Could not reach LinkedIn.');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** The same proxy call, for the enrichment routes (integrations/enrichmentProxy.ts). */
export { call as unipileProxyCall };

/**
 * Begin connecting a LinkedIn account: the server asks Unipile for a hosted-auth link the student opens to sign in.
 * Gives the URL to open and an opaque reference to poll for the account to become ready.
 */
export async function startLinkedInConnect(
  opts: CallOpts = {},
): Promise<ConnectorOutcome<{ url: string; ref: string }>> {
  const r = await call<{ url?: string; ref?: string }>('/connect/start', {}, opts);
  if (!r.ok) return r;
  if (!r.value.url || !r.value.ref)
    return connectorFailure('error', 'Could not start the LinkedIn connection.');
  return { ok: true, value: { url: r.value.url, ref: r.value.ref } };
}

export interface ConnectStatus {
  status: 'pending' | 'connected' | 'error';
  accountId?: string;
  /** proof this browser finished the sign-in: sent with every later call about the account */
  token?: string;
  message?: string;
}

/** Whether a started connection has finished signing in, and the account id once it has. */
export async function linkedInConnectStatus(
  ref: string,
  opts: CallOpts = {},
): Promise<ConnectorOutcome<ConnectStatus>> {
  const r = await call<ConnectStatus>('/connect/status', { ref }, opts);
  if (!r.ok) return r;
  const status = r.value.status;
  return {
    ok: true,
    value: {
      status: status === 'connected' || status === 'error' ? status : 'pending',
      accountId: r.value.accountId,
      token: r.value.token,
      message: r.value.message,
    },
  };
}

interface RelationsResponse {
  items?: {
    first_name?: string;
    last_name?: string;
    headline?: string;
    position?: string;
    company?: string;
    public_profile_url?: string;
    profile_url?: string;
    /** ISO text from Orbit's server (older servers passed Unipile's value through, sometimes a number) */
    connected_at?: string | number;
    picture_url?: string;
    member_id?: string;
  }[];
  cursor?: string | null;
}

/** "2026-03-27" from an ISO date, or from epoch milliseconds or seconds. */
export function connectedDay(v: string | number | undefined): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : /^\d+$/.test(v) ? Number(v) : Number.NaN;
  const t = Number.isFinite(n) ? (n > 1e12 ? n : n * 1000) : Date.parse(String(v));
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

/** At most this many pages (200 connections each) per sync: a runaway cursor never loops for ever. */
const MAX_PAGES = 200;

/** Pull every connection for a connected account, mapped to the CSV import shape. Pages until done. */
export async function linkedInConnections(
  accountId: string,
  opts: CallOpts & {
    onProgress?: (count: number) => void;
    /** a connection already stored: LinkedIn lists the newest first, so the pull ends with the page that has one */
    known?: (c: LiveConnection) => boolean;
  } = {},
): Promise<ConnectorOutcome<LiveConnection[]>> {
  const out: LiveConnection[] = [];
  let cursor: string | null | undefined;
  let pages = 0;
  let reached = false;
  do {
    const r = await call<RelationsResponse>('/relations', { accountId, token: opts.token, cursor }, opts);
    if (!r.ok) return r;
    for (const it of r.value.items ?? []) {
      const name = `${it.first_name ?? ''} ${it.last_name ?? ''}`.trim();
      if (!name) continue;
      const c: LiveConnection = {
        firstName: it.first_name ?? name.split(' ')[0] ?? '',
        lastName: it.last_name ?? name.split(' ').slice(1).join(' '),
        position: it.position ?? it.headline,
        company: it.company,
        url: it.public_profile_url ?? it.profile_url,
        connectedOn: connectedDay(it.connected_at),
        memberId: it.member_id,
        photoUrl: it.picture_url,
      };
      out.push(c);
      if (opts.known?.(c)) reached = true;
    }
    opts.onProgress?.(out.length);
    cursor = r.value.cursor ?? undefined;
    pages++;
  } while (cursor && !reached && pages < MAX_PAGES);
  return { ok: true, value: out };
}

interface MutualResponse {
  mutuals?: { name?: string; headline?: string; url?: string; member_id?: string; picture_url?: string }[];
  count?: number;
  /** the list matched what LinkedIn says the two share; without that it is not shown as mutual connections */
  verified?: boolean;
  /** false with reason "limit" when today's LinkedIn reads are spent */
  ok?: boolean;
  reason?: string;
  message?: string;
}

/** Who the student knows who is connected to a target LinkedIn member. */
export async function mutualConnections(
  accountId: string,
  targetMemberId: string,
  opts: CallOpts = {},
): Promise<ConnectorOutcome<Mutual[]>> {
  const r = await call<MutualResponse>('/mutuals', { accountId, token: opts.token, targetMemberId }, opts);
  if (!r.ok) return r;
  // today's LinkedIn reads are spent: said as such (the status searches use), not as LinkedIn failing
  if (r.value.ok === false && r.value.reason === 'limit')
    return connectorFailure(
      'error',
      r.value.message ?? 'Orbit has read as much from LinkedIn as it allows today.',
      SEARCH_LIMIT_STATUS,
    );
  // an answer LinkedIn did not filter is the student's own connections, never shown as someone else's
  if (r.value.verified !== true)
    return {
      ok: false,
      reason: 'error',
      message: "LinkedIn didn't confirm who you both know, so Orbit isn't guessing. Try again later.",
    };
  return {
    ok: true,
    value: (r.value.mutuals ?? [])
      .filter((m) => m.name)
      .map((m) => ({
        name: m.name!,
        headline: m.headline,
        url: m.url,
        memberId: m.member_id,
        pictureUrl: m.picture_url?.startsWith('https://') ? m.picture_url : undefined,
      })),
  };
}

/** Unlink the account at Unipile. People already imported stay in Orbit. */
export async function disconnectLinkedInAccount(
  accountId: string,
  opts: CallOpts = {},
): Promise<ConnectorOutcome<{ disconnected: boolean }>> {
  const r = await call<{ ok?: boolean }>('/disconnect', { accountId, token: opts.token }, opts);
  if (!r.ok) return r;
  return { ok: true, value: { disconnected: r.value.ok !== false } };
}

export interface LinkedInSent {
  /** a connection request went out with the text as its note, rather than a message */
  invited: boolean;
  messageId?: string;
  chatId?: string;
  /** their LinkedIn member id, as Unipile resolved it */
  memberId?: string;
}

/**
 * Send one approved message from the student's own LinkedIn: a message to a connection, or, with `invite`, a
 * connection request carrying the text as its note. Who it goes to is their member id when Orbit has it, else their
 * public profile name.
 */
export async function sendLinkedInMessage(
  accountId: string,
  to: { memberId?: string; slug?: string },
  text: string,
  invite: boolean,
  opts: CallOpts = {},
): Promise<ConnectorOutcome<LinkedInSent>> {
  const r = await call<{
    ok?: boolean;
    message?: string;
    invited?: boolean;
    messageId?: string;
    chatId?: string;
    memberId?: string;
  }>('/send', { accountId, token: opts.token, memberId: to.memberId, slug: to.slug, text, invite }, opts);
  if (!r.ok) return r;
  if (r.value.ok === false) return connectorFailure('error', r.value.message ?? 'LinkedIn did not send it.');
  return {
    ok: true,
    value: {
      invited: !!r.value.invited,
      messageId: r.value.messageId,
      chatId: r.value.chatId,
      memberId: r.value.memberId,
    },
  };
}

/** One message in the student's 1:1 LinkedIn chats, and who the other person is. */
export interface LinkedInInboxMessage {
  id: string;
  chatId: string;
  text: string;
  at?: string;
  /** the student wrote it */
  fromMe: boolean;
  counterpart: { providerId?: string; name?: string };
}

interface InboxResponse {
  messages?: Partial<LinkedInInboxMessage>[];
  latest?: string | null;
  /** more messages wait: send `cursor` back for them (an older proxy only says `more`) */
  more?: boolean;
  cursor?: string | null;
  /** false when some messages could not be tied to their chat */
  complete?: boolean;
}

/** At most this many /inbox calls per read (each reads up to 1,000 messages); past that the read is incomplete. */
export const INBOX_MAX_CALLS = 10;

/**
 * The student's LinkedIn messages since `after`, both ways, from 1:1 chats only (groups are not one person's reply),
 * read to the end through the proxy's cursor. `latest` is the newest message time LinkedIn returned; `complete` is
 * false when the read stopped early or some messages could not be placed, and then `latest` must not become the
 * next read's checkpoint (the unread messages are older than the ones read).
 */
export async function linkedInInbox(
  accountId: string,
  after: Date,
  opts: CallOpts = {},
): Promise<ConnectorOutcome<{ messages: LinkedInInboxMessage[]; latest?: string; complete: boolean }>> {
  const messages: LinkedInInboxMessage[] = [];
  const seen = new Set<string>();
  let latest: string | undefined;
  let complete = true;
  let cursor: string | undefined;
  for (let i = 0; i < INBOX_MAX_CALLS; i++) {
    const r = await call<InboxResponse>(
      '/inbox',
      { accountId, token: opts.token, after: after.toISOString(), ...(cursor ? { cursor } : {}) },
      { timeoutMs: 45_000, ...opts },
    );
    if (!r.ok) return r;
    for (const m of r.value.messages ?? []) {
      if (!(typeof m.text === 'string' && m.text.trim() && m.id && m.chatId) || seen.has(String(m.id)))
        continue;
      seen.add(String(m.id));
      messages.push({
        id: String(m.id),
        chatId: String(m.chatId),
        text: m.text.trim(),
        at: m.at,
        fromMe: !!m.fromMe,
        counterpart: { providerId: m.counterpart?.providerId, name: m.counterpart?.name },
      });
    }
    if (r.value.latest && (!latest || r.value.latest > latest)) latest = r.value.latest;
    if (r.value.complete === false) complete = false;
    cursor = r.value.cursor ?? undefined;
    if (!cursor) {
      // an older proxy says only that more were left
      if (r.value.more) complete = false;
      return { ok: true, value: { messages, latest, complete } };
    }
  }
  return { ok: true, value: { messages, latest, complete: false } };
}

/**
 * The messages the student sent on LinkedIn since `after` (1:1 chats only): what Orbit learns the student's own
 * voice from. Only the text and time come back; who they were to is not needed here.
 */
export async function linkedInSentMessages(
  accountId: string,
  after: Date,
  opts: CallOpts = {},
): Promise<ConnectorOutcome<{ text: string; at?: string }[]>> {
  const r = await linkedInInbox(accountId, after, opts);
  if (!r.ok) return r;
  return {
    ok: true,
    value: r.value.messages.filter((m) => m.fromMe).map((m) => ({ text: m.text, at: m.at })),
  };
}

/** One person a LinkedIn search found. */
export interface LinkedInFound {
  memberId: string;
  name: string;
  headline?: string;
  location?: string;
  profileUrl?: string;
  /** 1 = a connection, 2 = a friend of a friend, 3 = further out */
  distance?: number;
  /** their LinkedIn photo (a link that expires after a few weeks) */
  pictureUrl?: string;
  /** how many connections the student shares with them, when LinkedIn says */
  mutualCount?: number;
}

export interface LinkedInSearchQuery {
  keywords?: string;
  title?: string;
  company?: string;
  school?: string;
  location?: string;
  /** which degrees to search; second and third by default, so the results are people the student does not know */
  distance?: (1 | 2 | 3)[];
  /** the cursor the previous page of the same search returned: the next page */
  cursor?: string;
}

/** The proxy's answer when the account has run all the searches Orbit allows today: a failure with this status. */
export const SEARCH_LIMIT_STATUS = 429;

/**
 * Search LinkedIn people from the student's own account, beyond their connections. A page at a time: pass the
 * returned cursor for the next page. The day's search limit comes back as a failure with SEARCH_LIMIT_STATUS.
 */
export async function searchLinkedIn(
  accountId: string,
  q: LinkedInSearchQuery,
  opts: CallOpts = {},
): Promise<ConnectorOutcome<{ people: LinkedInFound[]; cursor?: string; total?: number }>> {
  const r = await call<{
    ok?: boolean;
    reason?: string;
    message?: string;
    people?: LinkedInFound[];
    cursor?: string | null;
    total?: number;
  }>('/search', { accountId, token: opts.token, ...q }, { timeoutMs: 30_000, ...opts });
  if (!r.ok) return r;
  if (r.value.ok === false)
    return connectorFailure(
      'error',
      r.value.message ?? 'LinkedIn did not search.',
      r.value.reason === 'limit' ? SEARCH_LIMIT_STATUS : undefined,
    );
  return {
    ok: true,
    value: { people: r.value.people ?? [], cursor: r.value.cursor ?? undefined, total: r.value.total },
  };
}

/** The student's own LinkedIn profile; `picture` is the photo itself (a data: URL), since LinkedIn's links expire. */
export interface LinkedInMe {
  firstName?: string;
  lastName?: string;
  headline?: string;
  publicIdentifier?: string;
  /** their own LinkedIn member id */
  providerId?: string;
  picture?: string;
}

export function linkedInMe(accountId: string, opts: CallOpts = {}): Promise<ConnectorOutcome<LinkedInMe>> {
  return call<LinkedInMe>('/me', { accountId, token: opts.token }, opts);
}

/** One message of a 1:1 LinkedIn chat, as the history read gives it: when, which way, and a short snippet. */
export interface LinkedInDm {
  id: string;
  at: string;
  /** the student sent it */
  out: boolean;
  text: string;
}

/** One 1:1 chat's messages (or the part of them one call read), with the other person's member id. */
export interface LinkedInDmChat {
  chatId: string;
  memberId: string;
  name?: string;
  messages: LinkedInDm[];
}

/**
 * One call of the 1:1 chat history read: the whole history, or since `after`. `cursor` is null once everything was
 * read; otherwise pass it back for the rest (a chat cut off mid-way continues in the next call).
 */
export async function linkedInChatHistory(
  accountId: string,
  q: { after?: string; cursor?: string },
  opts: CallOpts = {},
): Promise<ConnectorOutcome<{ chats: LinkedInDmChat[]; latest?: string; cursor: string | null }>> {
  const r = await call<{
    ok?: boolean;
    message?: string;
    chats?: Partial<LinkedInDmChat>[];
    latest?: string | null;
    cursor?: string | null;
  }>('/chats/history', { accountId, token: opts.token, ...q }, { timeoutMs: 45_000, ...opts });
  if (!r.ok) return r;
  if (r.value.ok === false)
    return connectorFailure('error', r.value.message ?? 'LinkedIn did not read the chats.');
  return {
    ok: true,
    value: {
      chats: (r.value.chats ?? [])
        .filter((c): c is LinkedInDmChat => !!c.chatId && !!c.memberId && Array.isArray(c.messages))
        .map((c) => ({
          chatId: String(c.chatId),
          memberId: String(c.memberId),
          name: c.name,
          messages: c.messages
            .filter((m) => m?.id && m.at && !Number.isNaN(Date.parse(m.at)))
            .map((m) => ({ id: String(m.id), at: m.at, out: !!m.out, text: String(m.text ?? '') })),
        })),
      latest: r.value.latest ?? undefined,
      cursor: r.value.cursor ?? null,
    },
  };
}

/** A comment or reaction on a LinkedIn post, between the student and one other member. */
export interface LinkedInPostItem {
  kind: 'comment_in' | 'reaction_in' | 'comment_out';
  memberId: string;
  at: string;
  id: string;
  postId: string;
  text?: string;
}

export interface LinkedInPostPage {
  items: LinkedInPostItem[];
  /** the student's posts read to the end in this call, with the counters to pass as `seen` next time */
  postsRead: { socialId: string; seen: string }[];
  /** the student's own comments were read back to `commentsSince` */
  ownDone: boolean;
  cursor: string | null;
  /** LinkedIn has posts older than the recent ones read */
  olderPosts?: boolean;
  /** the account reached today's post reads */
  limited?: boolean;
}

/** One call of the post engagement read (see orbit-connectors /posts/activity). */
export async function linkedInPostActivity(
  accountId: string,
  q: { cursor?: string; seen?: Record<string, string>; commentsSince?: string },
  opts: CallOpts = {},
): Promise<ConnectorOutcome<LinkedInPostPage>> {
  const r = await call<{
    ok?: boolean;
    reason?: string;
    message?: string;
    items?: Partial<LinkedInPostItem>[];
    postsRead?: { socialId?: string; seen?: string }[];
    ownDone?: boolean;
    olderPosts?: boolean;
    cursor?: string | null;
  }>('/posts/activity', { accountId, token: opts.token, ...q }, { timeoutMs: 45_000, ...opts });
  if (!r.ok) return r;
  if (r.value.ok === false) {
    if (r.value.reason === 'limit')
      return {
        ok: true,
        value: { items: [], postsRead: [], ownDone: false, cursor: null, limited: true },
      };
    return connectorFailure('error', r.value.message ?? 'LinkedIn did not read the posts.');
  }
  const kinds = new Set(['comment_in', 'reaction_in', 'comment_out']);
  return {
    ok: true,
    value: {
      items: (r.value.items ?? [])
        .filter(
          (i): i is LinkedInPostItem =>
            !!i.kind &&
            kinds.has(i.kind) &&
            !!i.memberId &&
            !!i.id &&
            !!i.at &&
            !Number.isNaN(Date.parse(i.at)),
        )
        .map((i) => ({ ...i, postId: String(i.postId ?? '') })),
      postsRead: (r.value.postsRead ?? [])
        .filter((p): p is { socialId: string; seen: string } => !!p.socialId && typeof p.seen === 'string')
        .map((p) => ({ socialId: p.socialId, seen: p.seen })),
      ownDone: !!r.value.ownDone,
      olderPosts: r.value.olderPosts,
      cursor: r.value.cursor ?? null,
    },
  };
}

/** What one /engagement call reads about a person (plan 21): one upstream page each. */
export type EngagementWant = 'posts' | 'reactions' | 'comments' | 'thread';

/** One of a person's posts: when, how much engagement it drew, what it reposts, and whom it mentions. */
export interface EngagementPost {
  /** the activity number when LinkedIn gives one, so reactions and comments on it match */
  id: string;
  socialId?: string;
  at?: string;
  reactions: number;
  comments: number;
  /** the member id of the original author, for a repost */
  repostOf?: string;
  /** member ids of the people it mentions (those LinkedIn gave an id for) */
  mentions: string[];
  /** how many people it tags in all */
  tagged: number;
}

/** A post (or a comment on it) the person reacted to, and who wrote that post. LinkedIn gives no date. */
export interface EngagementReaction {
  postId: string;
  authorId: string;
  onComment: boolean;
}

/** A comment the person wrote: on which post, and when. Never its text. */
export interface EngagementComment {
  id: string;
  postId: string;
  at?: string;
  /** the comment it replies to, for a reply */
  threadId?: string;
}

/** A comment under one post: who wrote it, and when. Never its text. */
export interface EngagementThreadComment {
  id: string;
  commenterId: string;
  at?: string;
}

export interface EngagementItems {
  posts: EngagementPost;
  reactions: EngagementReaction;
  comments: EngagementComment;
  thread: EngagementThreadComment;
}

export interface EngagementPage<W extends EngagementWant = EngagementWant> {
  want: W;
  items: EngagementItems[W][];
  /** the next page of the same read, or null at the end */
  cursor: string | null;
}

/**
 * An engagement read's outcome: `limit` when today's LinkedIn reads are spent (it carries on tomorrow),
 * `unavailable` when LinkedIn would not show this person's activity, else the usual connector failures.
 */
export type EngagementOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: 'limit' | 'unavailable' | 'bad_request' | ConnectorFailureReason;
      message: string;
      status?: number;
    };

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const nonNegative = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

function engagementItem<W extends EngagementWant>(want: W, raw: unknown): EngagementItems[W] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const at = str(r.at) && !Number.isNaN(Date.parse(String(r.at))) ? String(r.at) : undefined;
  let out: EngagementItems[EngagementWant] | undefined;
  if (want === 'posts') {
    out = str(r.id)
      ? {
          id: String(r.id),
          ...(str(r.socialId) ? { socialId: String(r.socialId) } : {}),
          ...(at ? { at } : {}),
          reactions: nonNegative(r.reactions),
          comments: nonNegative(r.comments),
          ...(str(r.repostOf) ? { repostOf: String(r.repostOf) } : {}),
          mentions: (Array.isArray(r.mentions) ? r.mentions : []).filter((m): m is string => !!str(m)),
          tagged: nonNegative(r.tagged),
        }
      : undefined;
  } else if (want === 'reactions') {
    out =
      str(r.postId) && str(r.authorId)
        ? { postId: String(r.postId), authorId: String(r.authorId), onComment: r.onComment === true }
        : undefined;
  } else if (want === 'comments') {
    out =
      str(r.id) && str(r.postId)
        ? {
            id: String(r.id),
            postId: String(r.postId),
            ...(at ? { at } : {}),
            ...(str(r.threadId) ? { threadId: String(r.threadId) } : {}),
          }
        : undefined;
  } else {
    out =
      str(r.id) && str(r.commenterId)
        ? { id: String(r.id), commenterId: String(r.commenterId), ...(at ? { at } : {}) }
        : undefined;
  }
  return out as EngagementItems[W] | undefined;
}

/**
 * One page of a person's public LinkedIn activity (orbit-connectors /engagement): their posts, what they reacted to,
 * their comments, or the comments under one of their posts (`thread`, which needs `postId`). Each call is one
 * LinkedIn read out of the day's posts ledger; pass `cursor` back for the next page.
 */
export async function linkedInEngagement<W extends EngagementWant>(
  accountId: string,
  q: { memberId: string; want: W; postId?: string; cursor?: string },
  opts: CallOpts = {},
): Promise<EngagementOutcome<EngagementPage<W>>> {
  const r = await call<{
    ok?: boolean;
    reason?: string;
    message?: string;
    want?: string;
    items?: unknown[];
    cursor?: string | null;
  }>(
    '/engagement',
    {
      accountId,
      token: opts.token,
      memberId: q.memberId,
      want: q.want,
      ...(q.postId ? { postId: q.postId } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
    },
    // the server waits up to 1.5 s before LinkedIn is asked
    { timeoutMs: 30_000, ...opts },
  );
  if (!r.ok) return r;
  if (r.value.ok === false) {
    const reason = r.value.reason;
    return {
      ok: false,
      reason: reason === 'limit' || reason === 'unavailable' || reason === 'bad_request' ? reason : 'error',
      message: r.value.message ?? "LinkedIn didn't answer.",
    };
  }
  if (r.value.want !== undefined && r.value.want !== q.want)
    return connectorFailure('error', 'LinkedIn answered a different question.');
  return {
    ok: true,
    value: {
      want: q.want,
      items: (Array.isArray(r.value.items) ? r.value.items : [])
        .map((x) => engagementItem(q.want, x))
        .filter((x): x is EngagementItems[W] => !!x),
      cursor: str(r.value.cursor) ?? null,
    },
  };
}

/** One LinkedIn ledger's use today. */
export interface LedgerUse {
  used: number;
  limit: number;
}

/** Today's LinkedIn reads for the account, per ledger (Settings: "LinkedIn reads today: 31 of 100"). */
export interface LinkedInLedger {
  /** the UTC day the counts are for (YYYY-MM-DD) */
  day: string;
  profile: LedgerUse;
  posts: LedgerUse;
  search: LedgerUse;
}

/** How much of today's LinkedIn reads the account has used, without using any. */
export async function linkedInLedger(
  accountId: string,
  opts: CallOpts = {},
): Promise<ConnectorOutcome<LinkedInLedger>> {
  const r = await call<
    Partial<Record<'profile' | 'posts' | 'search', Partial<LedgerUse>>> & {
      ok?: boolean;
      day?: string;
      message?: string;
    }
  >('/ledger', { accountId, token: opts.token }, opts);
  if (!r.ok) return r;
  if (r.value.ok === false || !r.value.day)
    return connectorFailure('error', r.value.message ?? "LinkedIn's reads could not be counted.");
  const use = (u: Partial<LedgerUse> | undefined): LedgerUse => ({
    used: nonNegative(u?.used),
    limit: nonNegative(u?.limit),
  });
  return {
    ok: true,
    value: {
      day: r.value.day,
      profile: use(r.value.profile),
      posts: use(r.value.posts),
      search: use(r.value.search),
    },
  };
}

/** Whether the connected account still works: signed in, signed out by LinkedIn, still finishing, or gone. */
export type LinkedInAccountHealth = 'connected' | 'signin' | 'pending' | 'gone';

/** Ask Unipile whether the student's LinkedIn account is still signed in (Settings checks it when it opens). */
export async function linkedInAccountHealth(
  accountId: string,
  opts: CallOpts = {},
): Promise<ConnectorOutcome<LinkedInAccountHealth>> {
  const r = await call<{ status?: string }>('/account', { accountId, token: opts.token }, opts);
  if (!r.ok) return r;
  const s = r.value.status;
  return s === 'connected' || s === 'signin' || s === 'pending' || s === 'gone'
    ? { ok: true, value: s }
    : connectorFailure('error', 'LinkedIn did not say how the account is.');
}
