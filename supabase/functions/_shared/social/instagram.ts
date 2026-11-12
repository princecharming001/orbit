/**
 * Instagram through Unipile, signed in as the student (plan 43 §4), behind `SocialAdapter`. Shapes per Unipile's
 * documentation:
 *   GET  /api/v1/users/me?account_id=                         the student's own account
 *   GET  /api/v1/users/{identifier}?account_id=               any account by id or handle: provider_id,
 *        public_identifier, full_name, followers_count, following_count, mutual_followers_count, is_private,
 *        is_verified, biography, external_links, relationship_status, profile_picture_url, category,
 *        business {email, phone_number}
 *   GET  /api/v1/users/followers?account_id=&user_id=&cursor=&limit=   25 a page at most; a verified account returns
 *        only a small sample and closes the cursor
 *   GET  /api/v1/users/following?account_id=&user_id=&cursor=&limit=
 *        items {id, username, name, profile_picture_url, is_private, is_verified}
 *   GET  /api/v1/chats?account_id=&cursor=&limit=, GET /api/v1/chats/{id}/attendees, GET /api/v1/chats/{id}/messages
 *   POST /api/v1/chats/{id}/messages (account_id, text), POST /api/v1/chats (account_id, attendees_ids, text)
 *
 * Every call is paid for first through the budget; a refused call is not made and throws SocialBudgetSpent. There
 * are no retries here: a retry is another action on the student's account, so the job that called decides when to
 * try again. A 401, or a 403 that names credentials, means Instagram wants the student to sign in again
 * (SocialSignInNeeded). Messages are keyed by Instagram's own id (`provider_id`) when Unipile gives it, so a new
 * Unipile account after a reconnect does not store them twice.
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
} from './adapter.ts';

/** Instagram's page size for follower lists (Unipile's maximum); the following list is asked for in larger pages. */
export const INSTAGRAM_PAGE = { followers: 25, following: 100 } as const;
export const INSTAGRAM_CHATS_PAGE = 50;
export const INSTAGRAM_MESSAGES_PAGE = 50;

export interface InstagramOptions {
  fetch: typeof fetch;
  apiKey?: string;
  baseUrl?: string;
  /** the student's Unipile account id */
  accountId: string;
  budget: SocialBudget;
  timeoutMs?: number;
}

/** A failed call that is neither a refused budget nor a sign-in: the caller retries later. */
export class InstagramCallFailed extends Error {
  constructor(
    readonly status: number | 'network',
    readonly path: string,
  ) {
    super(`instagram ${path}: ${status}`);
  }
}

type J = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && /^\d+$/.test(v)
      ? Number(v)
      : undefined;
const bool = (v: unknown) => v === true || v === 1 || v === 'true';

/** Unipile timestamps arrive as ISO strings or epoch milliseconds. */
export function unipileIso(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const d =
    typeof v === 'number' ? new Date(v) : /^\d+$/.test(String(v)) ? new Date(Number(v)) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** relationship_status as following / followed by, whether Unipile gives a word, a list of words or flags. */
export function readRelation(v: unknown): { following: boolean; followedBy: boolean } | undefined {
  if (v == null) return undefined;
  const words =
    typeof v === 'string'
      ? v.toLowerCase().split(/[\s,|]+/)
      : Array.isArray(v)
        ? v.map((x) => String(x).toLowerCase())
        : undefined;
  if (words)
    return {
      following: words.includes('following') || words.includes('mutual'),
      followedBy: words.includes('followed_by') || words.includes('mutual'),
    };
  if (typeof v === 'object') {
    const o = v as J;
    return { following: bool(o.following), followedBy: bool(o.followed_by ?? o.followedBy) };
  }
  return undefined;
}

/** A Unipile Instagram profile as a SocialAccount. */
export function accountFromProfile(p: J): SocialAccount | undefined {
  const id = str(p.provider_id) ?? str(p.id);
  if (!id) return undefined;
  const business = (p.business ?? {}) as J;
  const links = [
    ...(Array.isArray(p.external_links) ? p.external_links : []),
    ...(str(p.external_url) ? [p.external_url] : []),
  ]
    .map((l) => (typeof l === 'string' ? l : str((l as J)?.url)))
    .filter((l): l is string => !!l);
  const first = str(p.first_name);
  const last = str(p.last_name);
  const picture = str(p.profile_picture_url);
  return {
    platform: 'instagram',
    id,
    username: str(p.public_identifier) ?? str(p.username) ?? id,
    name: str(p.full_name) ?? str(p.name) ?? ([first, last].filter(Boolean).join(' ') || undefined),
    bio: str(p.biography) ?? str(p.bio),
    links,
    email: str(business.email) ?? str(p.email),
    phone: str(business.phone_number) ?? str(p.phone_number),
    followers: num(p.followers_count),
    following: num(p.following_count),
    verified: bool(p.is_verified),
    isPrivate: bool(p.is_private),
    business:
      !!str(p.category) || !!str(business.email) || !!str(business.phone_number) || bool(p.is_business),
    category: str(p.category),
    defaultPicture: !picture || /default|anonymous/i.test(picture),
  };
}

function accountFromItem(i: J): SocialAccount | undefined {
  const id = str(i.id) ?? str(i.provider_id);
  if (!id) return undefined;
  return {
    platform: 'instagram',
    id,
    username: str(i.username) ?? str(i.public_identifier) ?? id,
    name: str(i.name) ?? str(i.full_name),
    verified: bool(i.is_verified),
    isPrivate: bool(i.is_private),
    defaultPicture: !str(i.profile_picture_url),
  };
}

export function createInstagramAdapter(o: InstagramOptions): SocialAdapter {
  const base = (o.baseUrl ?? '').replace(/\/+$/, '');
  if (!o.apiKey || !base) throw new InstagramCallFailed(503, 'unconfigured');
  const q = (params: Record<string, string | number | undefined>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v));
    const t = s.toString();
    return t ? `?${t}` : '';
  };

  async function call(kind: SocialCallKind, path: string, init: RequestInit = {}): Promise<J> {
    if (!(await o.budget.spend(kind))) throw new SocialBudgetSpent(kind, await o.budget.retryAt?.(kind));
    let res: Response;
    try {
      res = await o.fetch(`${base}${path}`, {
        ...init,
        headers: { 'X-API-KEY': o.apiKey!, accept: 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
    } catch {
      throw new InstagramCallFailed('network', path.split('?')[0]!);
    }
    const body = (await res.json().catch(() => ({}))) as J;
    if (res.status === 401) throw new SocialSignInNeeded('instagram');
    if (res.status === 403 && /credential|checkpoint|reconnect|login/i.test(JSON.stringify(body)))
      throw new SocialSignInNeeded('instagram');
    if (!res.ok) throw new InstagramCallFailed(res.status, path.split('?')[0]!);
    return body;
  }

  const profileRead = (p: J): SocialProfileRead => {
    const account = accountFromProfile(p);
    if (!account) throw new InstagramCallFailed(502, 'profile');
    const relation = readRelation(p.relationship_status);
    const mutual = num(p.mutual_followers_count);
    return {
      account,
      ...(mutual !== undefined ? { mutualCount: mutual } : {}),
      ...(relation ? { relation } : {}),
    };
  };

  return {
    platform: 'instagram',
    pageSize: (list: SocialList) => INSTAGRAM_PAGE[list],
    async me() {
      return profileRead(await call('profile', `/api/v1/users/me${q({ account_id: o.accountId })}`));
    },
    async profile(ref) {
      return profileRead(
        await call(
          'profile',
          `/api/v1/users/${encodeURIComponent(ref.replace(/^@/, ''))}${q({ account_id: o.accountId })}`,
        ),
      );
    },
    async listPage(accountId, list, cursor): Promise<SocialListPage> {
      const r = await call(
        'list',
        `/api/v1/users/${list}${q({ account_id: o.accountId, user_id: accountId, cursor, limit: INSTAGRAM_PAGE[list] })}`,
      );
      const items = (Array.isArray(r.items) ? r.items : []) as J[];
      const accounts = items.map(accountFromItem).filter((a): a is SocialAccount => !!a);
      return {
        ids: accounts.map((a) => a.id),
        accounts,
        ...(str(r.cursor) ? { cursor: str(r.cursor) } : {}),
        ...(num(r.total_count ?? r.total) !== undefined ? { total: num(r.total_count ?? r.total) } : {}),
      };
    },
    async chats(cursor): Promise<SocialPage<SocialChat>> {
      const r = await call(
        'chats',
        `/api/v1/chats${q({ account_id: o.accountId, cursor, limit: INSTAGRAM_CHATS_PAGE })}`,
      );
      const out: SocialChat[] = [];
      for (const c of (Array.isArray(r.items) ? r.items : []) as J[]) {
        const chatId = str(c.id);
        if (!chatId) continue;
        const oneToOne = c.type === 0 || c.type === '0' || (c.type == null && !!str(c.attendee_provider_id));
        let others: SocialChat['others'] = [];
        let participants = 2;
        if (oneToOne && str(c.attendee_provider_id)) {
          others = [{ accountId: str(c.attendee_provider_id)!, name: str(c.name) }];
        } else {
          // a group: who is in it costs one more call
          const a = await call('chats', `/api/v1/chats/${encodeURIComponent(chatId)}/attendees`);
          const items = (Array.isArray(a.items) ? a.items : []) as J[];
          participants = Math.max(items.length, 2);
          others = items
            .filter((x) => !bool(x.is_self) && str(x.provider_id))
            .map((x) => ({ accountId: str(x.provider_id)!, name: str(x.name) }));
          if (!items.some((x) => bool(x.is_self))) participants = others.length + 1;
        }
        out.push({ chatId, participants, others, lastAt: unipileIso(c.timestamp) });
      }
      return { items: out, ...(str(r.cursor) ? { cursor: str(r.cursor) } : {}) };
    },
    async messages(chatId, cursor): Promise<SocialPage<SocialMessage>> {
      const r = await call(
        'messages',
        `/api/v1/chats/${encodeURIComponent(chatId)}/messages${q({ cursor, limit: INSTAGRAM_MESSAGES_PAGE })}`,
      );
      const out: SocialMessage[] = [];
      for (const m of (Array.isArray(r.items) ? r.items : []) as J[]) {
        const id = str(m.provider_id) ?? str(m.id);
        const at = unipileIso(m.timestamp);
        if (!id || !at || bool(m.is_event) || bool(m.deleted) || bool(m.hidden)) continue;
        const text = str(m.text) ?? '';
        out.push({
          messageId: id,
          chatId,
          at,
          fromStudent: bool(m.is_sender),
          senderAccountId: str(m.sender_id) ?? '',
          text,
          hasWords: !!text,
        });
      }
      return { items: out, ...(str(r.cursor) ? { cursor: str(r.cursor) } : {}) };
    },
    async send(to, text) {
      const form = new FormData();
      form.set('account_id', o.accountId);
      form.set('text', text);
      if (to.chatId) {
        const r = await call('send', `/api/v1/chats/${encodeURIComponent(to.chatId)}/messages`, {
          method: 'POST',
          body: form,
        });
        const id = str(r.message_id) ?? str(r.id);
        if (!id) throw new InstagramCallFailed(502, 'send');
        return { messageId: id, chatId: str(r.chat_id) ?? to.chatId };
      }
      if (!to.accountId) throw new InstagramCallFailed(400, 'send');
      form.set('attendees_ids', to.accountId);
      const r = await call('send', '/api/v1/chats', { method: 'POST', body: form });
      const id = str(r.message_id) ?? str(r.id);
      const chatId = str(r.chat_id);
      if (!id || !chatId) throw new InstagramCallFailed(502, 'send');
      return { messageId: id, chatId };
    },
  };
}
