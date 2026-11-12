/**
 * A stand-in for X's API v2 with the documented shapes (plan 43 §5): OAuth 2.0 with PKCE (token, refresh with
 * rotation, revoke), user lookups, follow lists with connection_status and pagination, DM events, and sending. It holds
 * a known follow graph and DM history, records every call, and bills the way X does (per user or event returned, per
 * DM sent) so tests can hold Orbit's ledger against it. Nothing here touches the network.
 */
import type { XDmEvent, XUser } from '../../functions/_shared/social/x/adapter.ts';

export const FAKE_X_CLIENT_ID = 'fake-x-client-id';
export const FAKE_X_CLIENT_SECRET = 'fake-x-client-secret';

export interface FakeXUser {
  id: string;
  username: string;
  name?: string;
  description?: string;
  url?: string;
  links?: string[];
  location?: string;
  verified?: boolean;
  protected?: boolean;
  suspended?: boolean;
  /** accepts DMs from anyone (else only from accounts it follows) */
  openDms?: boolean;
}

export interface FakeXCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: string;
  auth: string;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export class FakeX {
  users = new Map<string, FakeXUser>();
  /** "a>b": a follows b */
  follows = new Set<string>();
  /** DM events, any order; served newest first */
  events: XDmEvent[] = [];
  calls: FakeXCall[] = [];
  /** what X would bill, in dollars */
  billedUsd = 0;
  /** codes the consent screen would hand back: code → user id */
  codes = new Map<string, string>();
  /** the code_verifier sent with each code */
  verifiers = new Map<string, string>();
  access = new Map<string, string>();
  refresh = new Map<string, string>();
  revoked: string[] = [];
  /** refreshing is refused (a revoked grant) */
  refuseRefresh = false;
  /** X may return fewer users than asked for on a list page: the most one page returns */
  listPageCap = 1000;
  private n = 0;
  private nextEvent = 1_000_000;

  constructor(
    readonly clientId = FAKE_X_CLIENT_ID,
    readonly clientSecret = FAKE_X_CLIENT_SECRET,
  ) {}

  addUser(u: FakeXUser): FakeXUser {
    this.users.set(u.id, u);
    return u;
  }
  follow(a: string, b: string) {
    this.follows.add(`${a}>${b}`);
  }
  mutual(a: string, b: string) {
    this.follow(a, b);
    this.follow(b, a);
  }
  /** a code that signs in as `userId` */
  code(userId: string): string {
    const c = `code-${++this.n}`;
    this.codes.set(c, userId);
    return c;
  }
  /** a token pair for `userId`, as if issued earlier */
  issue(userId: string): { access: string; refresh: string } {
    const access = `xa-${++this.n}`;
    const refresh = `xr-${++this.n}`;
    this.access.set(access, userId);
    this.refresh.set(refresh, userId);
    return { access, refresh };
  }
  /** every access token stops working, as when they expire */
  expireAccess() {
    this.access.clear();
  }
  dm(
    e: Omit<XDmEvent, 'id' | 'event_type'> & { id?: string; event_type?: XDmEvent['event_type'] },
  ): XDmEvent {
    const ev: XDmEvent = { event_type: 'MessageCreate', ...e, id: e.id ?? String(++this.nextEvent) };
    this.events.push(ev);
    return ev;
  }
  /** "<lower>-<higher>", X's id for a one-to-one conversation */
  static pair(a: string, b: string) {
    return BigInt(a) < BigInt(b) ? `${a}-${b}` : `${b}-${a}`;
  }

  get fetch(): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => this.handle(input, init)) as typeof fetch;
  }

  paths(prefix = '') {
    return this.calls.map((c) => `${c.method} ${c.path}`).filter((p) => p.includes(prefix));
  }

  private userObject(u: FakeXUser, me?: string): XUser {
    const status: string[] = [];
    if (me && this.follows.has(`${me}>${u.id}`)) status.push('following');
    if (me && this.follows.has(`${u.id}>${me}`)) status.push('followed_by');
    const followers = [...this.follows].filter((f) => f.endsWith(`>${u.id}`)).length;
    const following = [...this.follows].filter((f) => f.startsWith(`${u.id}>`)).length;
    const out: XUser = {
      id: u.id,
      username: u.username,
      name: u.name,
      description: u.description ?? '',
      verified: !!u.verified,
      protected: !!u.protected,
      public_metrics: {
        followers_count: followers,
        following_count: following,
        tweet_count: 0,
        listed_count: 0,
      },
      profile_image_url: `https://pbs.twimg.example/profile_images/${u.id}.jpg`,
      connection_status: status,
      receives_your_dm: !!me && (!!u.openDms || this.follows.has(`${u.id}>${me}`)),
    };
    if (u.location) out.location = u.location;
    if (u.url) {
      out.url = 'https://t.co/abc';
      out.entities = { url: { urls: [{ url: 'https://t.co/abc', expanded_url: u.url }] } };
    }
    if (u.links?.length)
      out.entities = {
        ...out.entities,
        description: { urls: u.links.map((l, i) => ({ url: `https://t.co/d${i}`, expanded_url: l })) },
      };
    return out;
  }

  private gone(u: FakeXUser | undefined, ref: string) {
    if (u?.suspended)
      return json(200, {
        errors: [
          {
            value: ref,
            detail: `User has been suspended: [${ref}].`,
            title: 'Forbidden',
            type: 'https://api.twitter.com/2/problems/resource-not-found',
          },
        ],
      });
    return json(200, {
      errors: [
        {
          value: ref,
          detail: `Could not find user with id: [${ref}].`,
          title: 'Not Found Error',
          type: 'https://api.twitter.com/2/problems/resource-not-found',
        },
      ],
    });
  }

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : '';
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization') ?? '';
    const query = Object.fromEntries(url.searchParams);
    this.calls.push({ method, path: url.pathname, query, body, auth });
    if (url.hostname !== 'api.x.com') return json(404, { title: 'Not Found' });
    const path = url.pathname;

    // ---- OAuth -------------------------------------------------------------------------------------------------
    if (path === '/2/oauth2/token' || path === '/2/oauth2/revoke') {
      const expected = `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`;
      if (auth !== expected) return json(401, { error: 'unauthorized_client' });
      const form = new URLSearchParams(body);
      if (path === '/2/oauth2/revoke') {
        const t = form.get('token') ?? '';
        this.revoked.push(t);
        this.access.delete(t);
        this.refresh.delete(t);
        return json(200, { revoked: true });
      }
      if (form.get('grant_type') === 'authorization_code') {
        const code = form.get('code') ?? '';
        const who = this.codes.get(code);
        if (!who || !form.get('code_verifier')) return json(400, { error: 'invalid_request' });
        this.codes.delete(code);
        this.verifiers.set(code, form.get('code_verifier')!);
        const t = this.issue(who);
        return json(200, {
          token_type: 'bearer',
          expires_in: 7200,
          access_token: t.access,
          refresh_token: t.refresh,
          scope: 'tweet.read users.read follows.read dm.read dm.write offline.access',
        });
      }
      if (form.get('grant_type') === 'refresh_token') {
        const r = form.get('refresh_token') ?? '';
        const who = this.refresh.get(r);
        if (this.refuseRefresh || !who) return json(400, { error: 'invalid_request' });
        // X rotates the refresh token: the old one stops working
        this.refresh.delete(r);
        const t = this.issue(who);
        return json(200, {
          token_type: 'bearer',
          expires_in: 7200,
          access_token: t.access,
          refresh_token: t.refresh,
        });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }

    const me = this.access.get(auth.replace(/^Bearer /, ''));
    if (!me)
      return json(401, { title: 'Unauthorized', type: 'about:blank', status: 401, detail: 'Unauthorized' });

    // ---- users -------------------------------------------------------------------------------------------------
    if (method === 'GET' && path === '/2/users/me') {
      this.billedUsd += 0.01;
      return json(200, { data: this.userObject(this.users.get(me)!, me) });
    }
    let m = path.match(/^\/2\/users\/by\/username\/([^/]+)$/);
    if (method === 'GET' && m) {
      const name = decodeURIComponent(m[1]!).toLowerCase();
      const u = [...this.users.values()].find((x) => x.username.toLowerCase() === name);
      if (!u || u.suspended) return this.gone(u, m[1]!);
      this.billedUsd += 0.01;
      return json(200, { data: this.userObject(u, me) });
    }
    m = path.match(/^\/2\/users\/(\d+)$/);
    if (method === 'GET' && m) {
      const u = this.users.get(m[1]!);
      if (!u || u.suspended) return this.gone(u, m[1]!);
      this.billedUsd += 0.01;
      return json(200, { data: this.userObject(u, me) });
    }
    m = path.match(/^\/2\/users\/(\d+)\/(followers|following)$/);
    if (method === 'GET' && m) {
      const u = this.users.get(m[1]!);
      if (!u || u.suspended) return this.gone(u, m[1]!);
      if (u.protected && u.id !== me && !this.follows.has(`${me}>${u.id}`))
        return json(200, {
          errors: [
            {
              title: 'Authorization Error',
              detail: `Sorry, you are not authorized to see the user with id: [${u.id}].`,
              type: 'https://api.twitter.com/2/problems/not-authorized-for-resource',
            },
          ],
        });
      const max = Number(query.max_results ?? 100);
      if (!(max >= 1 && max <= 1000)) return json(400, { title: 'Invalid Request', detail: 'max_results' });
      const ids = [...this.follows]
        .map((f) => f.split('>') as [string, string])
        .filter(([a, b]) => (m![2] === 'followers' ? b === u.id : a === u.id))
        .map(([a, b]) => (m![2] === 'followers' ? a : b))
        .sort();
      const start = Number(query.pagination_token ?? 0);
      const take = Math.min(max, this.listPageCap);
      const slice = ids.slice(start, start + take);
      this.billedUsd += 0.01 * slice.length;
      const next = start + take < ids.length ? String(start + take) : undefined;
      return json(200, {
        ...(slice.length ? { data: slice.map((id) => this.userObject(this.users.get(id)!, me)) } : {}),
        meta: { result_count: slice.length, ...(next ? { next_token: next } : {}) },
      });
    }

    // ---- DMs ---------------------------------------------------------------------------------------------------
    const mine = (e: XDmEvent) =>
      e.sender_id === me ||
      (e.dm_conversation_id ?? '').split('-').includes(me) ||
      (e.participant_ids ?? []).includes(me) ||
      this.events.some(
        (o) =>
          o.dm_conversation_id === e.dm_conversation_id &&
          (o.sender_id === me || (o.participant_ids ?? []).includes(me)),
      );
    const page = (all: XDmEvent[]) => {
      const max = Number(query.max_results ?? 100);
      if (!(max >= 1 && max <= 100)) return json(400, { title: 'Invalid Request', detail: 'max_results' });
      const sorted = all.filter(mine).sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
      const start = Number(query.pagination_token ?? 0);
      const slice = sorted.slice(start, start + max);
      this.billedUsd += 0.01 * slice.length;
      const next = start + max < sorted.length ? String(start + max) : undefined;
      return json(200, {
        ...(slice.length ? { data: slice } : {}),
        meta: { result_count: slice.length, ...(next ? { next_token: next } : {}) },
      });
    };
    if (method === 'GET' && path === '/2/dm_events') return page(this.events);
    m = path.match(/^\/2\/dm_conversations\/with\/(\d+)\/dm_events$/);
    if (method === 'GET' && m)
      return page(this.events.filter((e) => e.dm_conversation_id === FakeX.pair(me, m![1]!)));
    m = path.match(/^\/2\/dm_conversations\/([^/]+)\/dm_events$/);
    if (method === 'GET' && m) return page(this.events.filter((e) => e.dm_conversation_id === m![1]));

    m = path.match(/^\/2\/dm_conversations\/(?:with\/(\d+)|([^/]+))\/messages$/);
    if (method === 'POST' && m) {
      const text = (JSON.parse(body || '{}') as { text?: string }).text ?? '';
      let conv = m[2];
      if (m[1]) {
        const to = this.users.get(m[1]);
        if (!to)
          return json(400, {
            title: 'Invalid Request',
            type: 'https://api.twitter.com/2/problems/invalid-request',
          });
        if (!to.openDms && !this.follows.has(`${to.id}>${me}`))
          return json(403, {
            title: 'Forbidden',
            detail: 'You cannot send messages to this user.',
            type: 'https://api.twitter.com/2/problems/dm-recipient-not-accepting',
          });
        conv = FakeX.pair(me, to.id);
      }
      const ev = this.dm({
        dm_conversation_id: conv!,
        sender_id: me,
        text,
        created_at: new Date().toISOString(),
      });
      this.billedUsd += 0.015;
      return json(201, { data: { dm_conversation_id: conv, dm_event_id: ev.id } });
    }
    return json(404, { title: 'Not Found Error' });
  }
}
