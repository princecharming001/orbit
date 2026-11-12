/**
 * A fake Unipile serving Instagram (plan 43 §4), over a known follow graph, following the documented shapes: the
 * student's own account, any profile (with the count of accounts the student follows that also follow it, and the
 * relationship status), follower lists 25 a page (a verified account returns only a small sample and closes the
 * cursor), following lists, chats with their attendees and messages, sending, hosted sign-in, and one account's
 * record for parking. Every call is recorded with the fake clock's time. No network.
 */
export interface FakeIgAccount {
  id: string;
  username: string;
  name?: string;
  bio?: string;
  links?: string[];
  email?: string;
  phone?: string;
  isPrivate?: boolean;
  verified?: boolean;
  category?: string;
  /** overrides the counts the profile shows (a big account Orbit should not read whole) */
  followersCount?: number;
  followingCount?: number;
}

export interface FakeIgChat {
  id: string;
  /** the other people, by account id */
  others: string[];
  messages: { id: string; sender: string; text: string; at: string }[];
}

export interface FakeIgCall {
  method: string;
  path: string;
  at: number;
}

const res = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export class FakeInstagram {
  readonly base: string;
  accounts = new Map<string, FakeIgAccount>();
  /** "a>b": a follows b, in the order added */
  follows: string[] = [];
  chats: FakeIgChat[] = [];
  calls: FakeIgCall[] = [];
  sent: { chatId?: string; accountId?: string; text: string }[] = [];
  deleted: string[] = [];
  /** Unipile's own account records, for parking */
  unipileAccounts = new Map<string, { type: string; name: string }>();
  /** what a verified account's follower list returns */
  sampleSize = 5;
  followingPage = 100;
  /** answer every call with this status (a checkpoint: 401) */
  failWith?: number;
  private seq = 0;

  constructor(
    readonly me: string,
    readonly clock: () => number = Date.now,
    base = 'https://api.unipile.test',
  ) {
    this.base = base;
    this.add({ id: me, username: 'me.student', name: 'Sam Rivera' });
  }

  add(a: FakeIgAccount): this {
    this.accounts.set(a.id, a);
    return this;
  }

  follow(a: string, b: string): this {
    if (!this.follows.includes(`${a}>${b}`)) this.follows.push(`${a}>${b}`);
    return this;
  }

  unfollow(a: string, b: string): this {
    this.follows = this.follows.filter((f) => f !== `${a}>${b}`);
    return this;
  }

  mutual(a: string, b: string): this {
    return this.follow(a, b).follow(b, a);
  }

  followersOf(id: string) {
    return this.follows.filter((f) => f.endsWith(`>${id}`)).map((f) => f.split('>')[0]!);
  }

  followingOf(id: string) {
    return this.follows.filter((f) => f.startsWith(`${id}>`)).map((f) => f.split('>')[1]!);
  }

  /** Calls made, optionally only those whose path starts with `prefix`. */
  made(prefix = '') {
    return this.calls.filter((c) => c.path.startsWith(prefix));
  }

  private profile(a: FakeIgAccount) {
    const followers = this.followersOf(a.id);
    const mine = new Set(this.followingOf(this.me));
    const rel = [
      ...(mine.has(a.id) ? ['following'] : []),
      ...(this.followingOf(a.id).includes(this.me) ? ['followed_by'] : []),
    ];
    return {
      object: 'UserProfile',
      provider: 'INSTAGRAM',
      provider_id: a.id,
      public_identifier: a.username,
      full_name: a.name ?? null,
      followers_count: a.followersCount ?? followers.length,
      following_count: a.followingCount ?? this.followingOf(a.id).length,
      mutual_followers_count: followers.filter((f) => mine.has(f)).length,
      is_private: !!a.isPrivate,
      is_verified: !!a.verified,
      biography: a.bio ?? null,
      external_links: a.links ?? [],
      relationship_status: rel,
      profile_picture_url: `https://cdn.test/${a.id}.jpg`,
      category: a.category ?? null,
      business: a.email || a.phone ? { email: a.email ?? null, phone_number: a.phone ?? null } : null,
    };
  }

  private item(id: string) {
    const a = this.accounts.get(id);
    return {
      id,
      username: a?.username ?? id,
      name: a?.name ?? null,
      profile_picture_url: `https://cdn.test/${id}.jpg`,
      is_private: !!a?.isPrivate,
      is_verified: !!a?.verified,
    };
  }

  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    const p = url.searchParams;
    this.calls.push({ method, path: `${path}${url.search}`, at: this.clock() });
    if (path === '/api/v1/hosted/accounts/link' && method === 'POST')
      return res(201, { object: 'HostedAuthURL', url: 'https://account.unipile.test/hosted/ig' });
    const acct = /^\/api\/v1\/accounts\/([^/]+)$/.exec(path);
    if (acct) {
      const id = decodeURIComponent(acct[1]!);
      const rec = this.unipileAccounts.get(id);
      if (method === 'DELETE') {
        this.deleted.push(id);
        this.unipileAccounts.delete(id);
        return rec ? res(200, { object: 'AccountDeleted' }) : res(404, {});
      }
      return rec ? res(200, { object: 'Account', id, ...rec }) : res(404, {});
    }
    if (this.failWith)
      return res(this.failWith, { type: 'errors/disconnected_account', title: 'credentials' });
    if (path === '/api/v1/users/me') return res(200, this.profile(this.accounts.get(this.me)!));
    if (path === '/api/v1/users/followers' || path === '/api/v1/users/following') {
      const id = p.get('user_id') ?? '';
      const a = this.accounts.get(id);
      if (!a) return res(404, {});
      if (a.isPrivate && id !== this.me) return res(403, { title: 'private account' });
      const followers = path.endsWith('followers');
      const all = followers ? this.followersOf(id) : this.followingOf(id);
      const size = Math.min(Number(p.get('limit') ?? 25), followers ? 25 : this.followingPage);
      if (followers && a.verified)
        return res(200, {
          object: 'UserList',
          items: all.slice(0, this.sampleSize).map((x) => this.item(x)),
          cursor: null,
        });
      const start = Number(p.get('cursor') ?? 0);
      const items = all.slice(start, start + size).map((x) => this.item(x));
      return res(200, {
        object: 'UserList',
        items,
        cursor: start + size < all.length ? String(start + size) : null,
      });
    }
    const user = /^\/api\/v1\/users\/([^/]+)$/.exec(path);
    if (user) {
      const ref = decodeURIComponent(user[1]!);
      const a = this.accounts.get(ref) ?? [...this.accounts.values()].find((x) => x.username === ref);
      return a ? res(200, this.profile(a)) : res(404, {});
    }
    if (path === '/api/v1/chats' && method === 'GET')
      return res(200, {
        object: 'ChatList',
        items: this.chats.map((c) => ({
          id: c.id,
          type: c.others.length === 1 ? 0 : 1,
          attendee_provider_id: c.others.length === 1 ? c.others[0] : null,
          name: c.others.length === 1 ? (this.accounts.get(c.others[0]!)?.name ?? null) : 'Group',
          timestamp: c.messages.at(-1)?.at ?? null,
        })),
        cursor: null,
      });
    if (path === '/api/v1/chats' && method === 'POST') {
      const form = init.body as FormData;
      const to = String(form.get('attendees_ids') ?? '');
      const chatId = `chat-new-${++this.seq}`;
      const messageId = `sent-${this.seq}`;
      this.sent.push({ accountId: to, text: String(form.get('text') ?? '') });
      this.chats.push({ id: chatId, others: [to], messages: [] });
      return res(201, { object: 'ChatStarted', chat_id: chatId, message_id: messageId });
    }
    const att = /^\/api\/v1\/chats\/([^/]+)\/attendees$/.exec(path);
    if (att) {
      const c = this.chats.find((x) => x.id === decodeURIComponent(att[1]!));
      return res(200, {
        items: [
          { id: 'self', provider_id: this.me, name: 'Sam Rivera', is_self: 1 },
          ...(c?.others ?? []).map((o) => ({
            id: `att-${o}`,
            provider_id: o,
            name: this.accounts.get(o)?.name,
            is_self: 0,
          })),
        ],
      });
    }
    const msgs = /^\/api\/v1\/chats\/([^/]+)\/messages$/.exec(path);
    if (msgs) {
      const chatId = decodeURIComponent(msgs[1]!);
      const c = this.chats.find((x) => x.id === chatId);
      if (method === 'POST') {
        const form = init.body as FormData;
        const messageId = `sent-${++this.seq}`;
        this.sent.push({ chatId, text: String(form.get('text') ?? '') });
        return res(201, { object: 'MessageSent', message_id: messageId });
      }
      return res(200, {
        object: 'MessageList',
        items: (c?.messages ?? []).map((m) => ({
          id: `unipile-${m.id}`,
          provider_id: m.id,
          chat_id: chatId,
          sender_id: m.sender,
          text: m.text,
          timestamp: m.at,
          is_sender: m.sender === this.me ? 1 : 0,
        })),
        cursor: null,
      });
    }
    return res(404, { error: 'not_found' });
  }) as typeof fetch;
}
