/**
 * Unipile for the automated LinkedIn warm-up (packages/core/src/warmup/auto.ts), always through one student's own
 * LinkedIn account: every call names that account's id and nothing here lists, reads or changes any other account or
 * any webhook on the key (the key is shared with another product).
 *
 * Checked against the public reference (https://developer.unipile.com/reference) on 2026-11-24:
 *
 * - `GET /api/v1/users/{identifier}?account_id=&notify=` (userscontroller_getprofilebyidentifier): `notify` is a
 *   boolean, "whether the profile visit should be notified to the viewee", default false. With `notify=true` the
 *   person sees the student in "who viewed your profile". `identifier` is the provider's internal id or the public
 *   id. The answer carries `provider_id` (the internal id, "ACo…") and `public_identifier`.
 * - `GET /api/v1/users/{identifier}/posts?account_id=&limit=` (userscontroller_listallposts): `identifier` must be
 *   the internal id ("starts with ACo/ADo for users"), so the profile is read first when only the public name is
 *   known. Items carry `social_id` ("a unique identifier to be used to add a comment or a reaction to the post"),
 *   `share_url`, `text`, `date`, `parsed_datetime`, `is_repost`.
 * - `POST /api/v1/posts/reaction` (postscontroller_addpostreaction), JSON `{account_id, post_id, reaction_type}`:
 *   `post_id` is the post's `social_id`; `reaction_type` is one of like, celebrate, support, love, insightful, funny
 *   (like when left out). 201 `{object: "ReactionAdded"}`.
 * - `POST /api/v1/posts/{post_id}/comments` (postscontroller_sendcomment), `multipart/form-data` with `account_id`
 *   and `text` (1 to 1,250 characters); `post_id` in the path is the `social_id`. 201 `{object: "CommentSent",
 *   comment_id?}`. (The guide's example posts the same two fields as JSON; the reference names the form, which is
 *   what Orbit's other Unipile posts use.) In `text`, `{{0}}` would be read as a mention marker: Orbit never sends
 *   `mentions`, and refuses text that carries one before it gets here.
 * - `GET /api/v1/posts/{post_id}/comments?account_id=&limit=&sort_by=MOST_RECENT` (postscontroller_listallcomments):
 *   items `{id, text, author_details: {id}, …}`. Used only to see whether a comment whose first try gave no answer
 *   is already on the post, so it is never posted twice.
 * - Errors: 401 (`errors/disconnected_account`, `expired_credentials`, …) and 403 (`account_restricted`, …) mean the
 *   account needs the student; 404 `errors/resource_not_found` "Post not found" / "User not found"; 422 with a type
 *   such as `errors/action_already_performed`, `errors/invalid_post`, `errors/limit_exceeded`; 429
 *   `errors/too_many_requests`; 500/503/504 for the provider being down or slow.
 *
 * A call is made once: no retry in here. A like or a comment that timed out may have gone through, so the caller
 * decides what a second try is allowed to do. Failures come back typed, never as a throw.
 */
import { normTarget, type TargetTake } from '../linkedinTargets';
import { query, trimBase } from './request';
import { z } from './zod';

export type WarmupFailureKind =
  /** no Unipile key or base URL */
  | 'unconfigured'
  /** the owner switched LinkedIn calls off (switches.ts): no call was made */
  | 'off'
  /** the swarm limit (linkedinTargets.ts): other accounts looked this person up lately; no call was made */
  | 'busy'
  /** the person or the post is not there any more */
  | 'not_found'
  /** the account needs a new sign-in, a checkpoint, or is restricted */
  | 'account'
  /** LinkedIn (or Unipile) says slow down */
  | 'rate_limited'
  /** LinkedIn will not take this action (422) */
  | 'refused'
  /** the provider was down, slow or unreachable: the action may or may not have happened */
  | 'unavailable'
  /** an answer that could not be read */
  | 'invalid';

export interface WarmupFailure {
  ok: false;
  kind: WarmupFailureKind;
  status?: number;
  /** Unipile's error type, e.g. "errors/invalid_post" */
  type?: string;
  message: string;
  /** with `busy`: when to try again (ISO) */
  retryAt?: string;
  /** the request left this machine and no answer said whether it was carried out */
  ambiguous?: boolean;
}

export type WarmupResult<T> = { ok: true; value: T } | WarmupFailure;

export interface WarmupProfile {
  /** LinkedIn's internal id ("ACo…"), what the posts route needs */
  memberId?: string;
  slug?: string;
  /** FIRST_DEGREE … OUT_OF_NETWORK */
  distance?: string;
}

export interface WarmupPost {
  /** the `social_id`: what a like or a comment is sent to */
  id: string;
  url?: string;
  text: string;
  /** ISO */
  at?: string;
  isRepost: boolean;
}

export interface UnipileWarmup {
  readonly configured: boolean;
  /** The person's profile. `visible: true` leaves a visit they can see; false reads without one. */
  profile(
    accountId: string,
    identifier: string,
    o: { visible: boolean },
  ): Promise<WarmupResult<WarmupProfile>>;
  /** Their latest posts, newest first. `memberId` is the internal id from `profile`. */
  posts(accountId: string, memberId: string, o?: { limit?: number }): Promise<WarmupResult<WarmupPost[]>>;
  /** A like on a post. `already`: LinkedIn says the account had reacted to it before. */
  react(accountId: string, postId: string): Promise<WarmupResult<{ already: boolean }>>;
  /** One comment on a post, with exactly `text`. */
  comment(accountId: string, postId: string, text: string): Promise<WarmupResult<{ commentId?: string }>>;
  /** Whether a comment with exactly this text is already on the post. */
  hasComment(accountId: string, postId: string, text: string): Promise<WarmupResult<boolean>>;
}

export interface UnipileWarmupOptions {
  fetch: typeof fetch;
  apiKey?: string;
  baseUrl?: string;
  /** per-call timeout, default 20 s */
  timeoutMs?: number;
  /** the owner's switch for LinkedIn calls: false answers `off` and makes no call */
  gate?: () => Promise<boolean>;
  /** the swarm limit, asked before a read aimed at one person (their profile, their posts) */
  targetTake?: TargetTake;
}

const profileSchema = z.looseObject({
  provider_id: z.string().nullish(),
  public_identifier: z.string().nullish(),
  network_distance: z.string().nullish(),
});

const postSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).nullish(),
  social_id: z.string().nullish(),
  share_url: z.string().nullish(),
  text: z.string().nullish(),
  date: z.string().nullish(),
  parsed_datetime: z.string().nullish(),
  is_repost: z.boolean().nullish(),
});
const postsSchema = z.looseObject({ items: z.array(postSchema).default([]) });

const commentsSchema = z.looseObject({
  items: z.array(z.looseObject({ text: z.string().nullish() })).default([]),
});

const errorSchema = z.looseObject({ type: z.string().nullish(), title: z.string().nullish() });

/** How many comments are read to look for one already posted (one page, newest first). */
export const COMMENT_CHECK_LIMIT = 100;

export function createUnipileWarmup(opts: UnipileWarmupOptions): UnipileWarmup {
  const configured = !!opts.apiKey && !!opts.baseUrl;
  const base = trimBase(opts.baseUrl ?? '');
  const timeoutMs = opts.timeoutMs ?? 20_000;

  const fail = (
    kind: WarmupFailureKind,
    message: string,
    more: Partial<WarmupFailure> = {},
  ): WarmupFailure => ({
    ok: false,
    kind,
    message: `unipile: ${message}`,
    ...more,
  });

  /** unconfigured, switched off, or (for a read aimed at a person) refused by the swarm limit; undefined: go ahead */
  async function blocked(accountId: string, target?: { id: string; caller: string }) {
    if (!configured) return fail('unconfigured', 'no API key or base URL configured');
    if (!accountId) return fail('account', 'no LinkedIn account to act through');
    if (opts.gate && !(await opts.gate().catch(() => true))) return fail('off', 'switched off');
    if (target && opts.targetTake) {
      const v = await opts.targetTake(accountId, normTarget(target.id), target.caller);
      if (!v.allowed)
        return fail('busy', 'other accounts looked this person up lately', {
          ...(v.retryAt ? { retryAt: v.retryAt } : {}),
        });
    }
    return undefined;
  }

  /** One request, one answer: the parsed JSON, or the failure it maps to. */
  async function call(
    path: string,
    init: { method: 'GET' | 'POST'; json?: unknown; form?: FormData },
  ): Promise<{ ok: true; body: unknown } | WarmupFailure> {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    const sent = init.method === 'POST';
    let res: Response;
    try {
      res = await opts.fetch(`${base}${path}`, {
        method: init.method,
        headers: {
          accept: 'application/json',
          'X-API-KEY': opts.apiKey ?? '',
          ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      return fail('unavailable', timedOut ? 'timed out' : e instanceof Error ? e.message : 'network error', {
        ambiguous: sent,
      });
    }
    clearTimeout(timer);
    if (res.ok) {
      try {
        return { ok: true, body: await res.json() };
      } catch {
        // a 2xx is a yes even when its body is not JSON
        return { ok: true, body: {} };
      }
    }
    let type: string | undefined;
    try {
      const parsed = errorSchema.safeParse(await res.json());
      if (parsed.success) type = parsed.data.type ?? undefined;
    } catch {
      await res.body?.cancel().catch(() => undefined);
    }
    const more = { status: res.status, ...(type ? { type } : {}) };
    if (res.status === 401 || res.status === 403) return fail('account', `${res.status}`, more);
    if (res.status === 404) return fail('not_found', '404', more);
    if (res.status === 429) return fail('rate_limited', '429', more);
    if (res.status === 422) {
      if (type === 'errors/invalid_post') return fail('not_found', '422 invalid post', more);
      if (type === 'errors/invalid_account' || type === 'errors/disconnected_account')
        return fail('account', '422', more);
      if (type === 'errors/limit_exceeded') return fail('rate_limited', '422 limit exceeded', more);
      return fail('refused', '422', more);
    }
    if (res.status >= 500) return fail('unavailable', `${res.status}`, { ...more, ambiguous: sent });
    return fail('refused', `${res.status}`, more);
  }

  const id = (s: string) => encodeURIComponent(s);

  return {
    configured,
    async profile(accountId, identifier, o) {
      const no = await blocked(accountId, { id: identifier, caller: 'warmup' });
      if (no) return no;
      const r = await call(
        `/api/v1/users/${id(identifier)}${query({ account_id: accountId, notify: o.visible ? 'true' : 'false' })}`,
        { method: 'GET' },
      );
      if (!r.ok) return r;
      const p = profileSchema.safeParse(r.body);
      if (!p.success) return fail('invalid', 'unexpected profile');
      return {
        ok: true,
        value: {
          ...(p.data.provider_id ? { memberId: p.data.provider_id } : {}),
          ...(p.data.public_identifier ? { slug: p.data.public_identifier } : {}),
          ...(p.data.network_distance ? { distance: p.data.network_distance } : {}),
        },
      };
    },
    async posts(accountId, memberId, o = {}) {
      const no = await blocked(accountId, { id: memberId, caller: 'warmup' });
      if (no) return no;
      const r = await call(
        `/api/v1/users/${id(memberId)}/posts${query({ account_id: accountId, limit: o.limit ?? 10 })}`,
        { method: 'GET' },
      );
      if (!r.ok) return r;
      const p = postsSchema.safeParse(r.body);
      if (!p.success) return fail('invalid', 'unexpected posts');
      const out: WarmupPost[] = [];
      for (const it of p.data.items) {
        // only a post with a social id can be liked or commented on
        if (!it.social_id) continue;
        const t = it.parsed_datetime ? Date.parse(it.parsed_datetime) : Number.NaN;
        out.push({
          id: it.social_id,
          ...(it.share_url ? { url: it.share_url } : {}),
          text: it.text ?? '',
          ...(Number.isFinite(t) ? { at: new Date(t).toISOString() } : {}),
          isRepost: it.is_repost === true,
        });
      }
      return { ok: true, value: out };
    },
    async react(accountId, postId) {
      const no = await blocked(accountId);
      if (no) return no;
      const r = await call('/api/v1/posts/reaction', {
        method: 'POST',
        json: { account_id: accountId, post_id: postId, reaction_type: 'like' },
      });
      if (r.ok) return { ok: true, value: { already: false } };
      if (r.type === 'errors/action_already_performed') return { ok: true, value: { already: true } };
      return r;
    },
    async comment(accountId, postId, text) {
      const no = await blocked(accountId);
      if (no) return no;
      const form = new FormData();
      form.append('account_id', accountId);
      form.append('text', text);
      const r = await call(`/api/v1/posts/${id(postId)}/comments`, { method: 'POST', form });
      if (!r.ok) return r;
      const cid = (r.body as { comment_id?: unknown } | null)?.comment_id;
      return { ok: true, value: typeof cid === 'string' && cid ? { commentId: cid } : {} };
    },
    async hasComment(accountId, postId, text) {
      const no = await blocked(accountId);
      if (no) return no;
      const r = await call(
        `/api/v1/posts/${id(postId)}/comments${query({
          account_id: accountId,
          limit: COMMENT_CHECK_LIMIT,
          sort_by: 'MOST_RECENT',
        })}`,
        { method: 'GET' },
      );
      if (!r.ok) return r;
      const p = commentsSchema.safeParse(r.body);
      if (!p.success) return fail('invalid', 'unexpected comments');
      const want = text.trim();
      return { ok: true, value: p.data.items.some((c) => (c.text ?? '').trim() === want) };
    },
  };
}
