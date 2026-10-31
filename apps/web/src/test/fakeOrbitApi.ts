/**
 * An in-memory orbit-api for tests and the user simulation: every route the client calls, with sessions that expire
 * and rotate, sync pages, goals, scores, dossiers, sourcing, routes, replies, memory and settings. It answers through
 * a `fetch` the client is pointed at (setOrbitApiFetchForTests), so no test ever reaches a real server.
 */
import type {
  AutopilotItem,
  AutopilotStatus,
  Dossier,
  DueItem,
  Friend,
  FriendCloseness,
  FriendIntroAsk,
  FriendInvite,
  FriendShare,
  FriendShareMode,
  Goal,
  MemoryItem,
  MemoryKind,
  ProposedGoal,
  ReplyClass,
  ReplyItem,
  ServerDraft,
  SourcedCandidate,
  VoiceNote,
  WarmHop,
  WarmPath,
} from '@orbit/core';
import type { AccountUser } from '../integrations/orbitApi';

export const FAKE_API_BASE = 'https://orbit-api.test/functions/v1/orbit-api';

export interface FakeCall {
  route: string;
  body: Record<string, unknown>;
  auth?: string;
}

export interface FakeState {
  user: AccountUser;
  /** access tokens and when they expire (ms) */
  access: Map<string, number>;
  /** the refresh token that is currently valid (rotates on every refresh) */
  refresh: string | undefined;
  /** /sync/pull pages, served in order; the cursor is the index of the next page */
  pages: { changes: Record<string, Record<string, unknown>[]>; deleted?: Record<string, string[]> }[];
  pushed: { table: string; op: string; id: string; row?: Record<string, unknown> }[];
  /** push ids the server refuses, with the code */
  rejectPush: Map<string, string>;
  status: {
    counts: Record<string, number>;
    google: { status: string; backfill: { phase: string | null; done: number; total: number | null } | null };
  };
  goals: Goal[];
  scores: Map<string, { score: number; band: string; explanation: string[] }>;
  labels: Map<string, number>;
  dossiers: Map<string, Dossier>;
  /** dossiers asked for that become ready on the next /research/get */
  researchQueue: Map<string, Dossier>;
  sourced: SourcedCandidate[];
  paths: Map<string, (WarmPath & { id: string; names: Record<string, string> })[]>;
  replies: ReplyItem[];
  drafts: Map<string, ServerDraft>;
  memories: MemoryItem[];
  autonomy: { level: number; goalId?: string }[];
  pausedUntil: string | null | undefined;
  /** what /settings/profile keeps (users.settings and users.timezone on the server) */
  profile: {
    postalAddress: string | null;
    schedulingLink: string | null;
    timezone: string;
    /** the student's own words (plan 24), as users.settings.about keeps them */
    about?: Record<string, unknown> | null;
  };
  /** what the next /memory/extract finds (each added like /memory/add) */
  extractable: { text: string; kind: MemoryKind }[];
  /** what /goals/infer proposes */
  proposals: ProposedGoal[];
  due: DueItem[];
  linkedin: { status: string; relations: number };
  /** what /people/history answers per person (empty lists otherwise) */
  history: Map<
    string,
    {
      threads: Record<string, unknown>[];
      messages: Record<string, unknown>[];
      events: Record<string, unknown>[];
    }
  >;
  deleted: boolean;
  /** routes that answer 503 unconfigured */
  unconfigured: Set<string>;
  /** the student's target companies, for a friend's "at your targets" count (plan 29 A1) */
  targets: string[];
  /** friends (plan 29 A): each with the people they share with the student */
  friends: FakeFriend[];
  friendInvites: FriendInvite[];
  /** what the student shares back with every friend, unless a friend has their own setting */
  friendShareMode: FriendShareMode;
  friendCompanyDomains: string[];
  /** the student's own projection, as a friend would see it (/friends/preview) */
  ownShares: FriendShare[];
  /** intros asked of friends and asked by them, both directions */
  friendAsks: FriendIntroAsk[];
  /** what /autopilot/status answers (plan 29 B) */
  autopilot: AutopilotStatus;
  /** per-goal autopilot modes set through /autopilot/mode */
  goalModes: Map<string, AutopilotStatus['mode']>;
  /** what /voice answers; relearnRequests counts /voice/relearn calls */
  voice: {
    cardProse: string[];
    notes: VoiceNote[];
    soundsLikeYou: number | null;
    relearnedAt: string | null;
    relearnRequests: number;
  };
}

/** One of a friend's shared people in the fake, plus the student's own row for the same human when they have one. */
export interface FakeFriendShare extends FriendShare {
  /** the identity join of plan 29 A2.6: the student's person id for the same human */
  matchesPersonId?: string;
}

/** A friend in the fake: the row the tab shows, with the people behind the counts and what the friend shares. */
export interface FakeFriend extends Omit<Friend, 'shares' | 'atTargets' | 'knowsAt'> {
  people: FakeFriendShare[];
  /** what the friend shares with the student */
  theirMode: FriendShareMode;
  theirCompanyDomains: string[];
}

export interface FakeOrbitApi {
  base: string;
  fetch: typeof fetch;
  calls: FakeCall[];
  state: FakeState;
  /** the routes called, in order */
  routes(): string[];
  /** move the fake clock (access tokens expire by it) */
  advance(ms: number): void;
  /** a login code /auth/session accepts */
  code: string;
}

const uuid = () => crypto.randomUUID();
const iso = (ms: number) => new Date(ms).toISOString();

export function fakeAccountUser(over: Partial<AccountUser> = {}): AccountUser {
  return {
    id: '7d0c4a52-6c38-4a8e-9a55-1f2e3d4c5b6a',
    email: 'maya@cornell.edu',
    fullName: 'Maya Lin',
    firstName: 'Maya',
    lastName: 'Lin',
    avatarUrl: null,
    school: 'Cornell University',
    gradYear: 2027,
    timezone: 'America/New_York',
    autonomyLevel: 0,
    settings: {},
    onboarding: {},
    createdAt: '2026-10-01T12:00:00.000Z',
    ...over,
  };
}

export function createFakeOrbitApi(
  opts: { base?: string; user?: AccountUser; now?: number; accessTtlMs?: number } = {},
): FakeOrbitApi {
  const base = opts.base ?? FAKE_API_BASE;
  // the client checks expiry against Date.now(), so the fake's clock starts there (tests move both together)
  let clock = opts.now ?? Date.now();
  const ttl = opts.accessTtlMs ?? 60 * 60_000;
  const calls: FakeCall[] = [];
  const state: FakeState = {
    user: opts.user ?? fakeAccountUser(),
    access: new Map(),
    refresh: undefined,
    pages: [],
    pushed: [],
    rejectPush: new Map(),
    status: {
      counts: { people: 0, messages: 0, threads: 0, ties: 0, goals: 0, chats: 0, drafts: 0 },
      google: { status: 'active', backfill: { phase: 'recent', done: 0, total: null } },
    },
    goals: [],
    scores: new Map(),
    labels: new Map(),
    dossiers: new Map(),
    researchQueue: new Map(),
    sourced: [],
    paths: new Map(),
    replies: [],
    drafts: new Map(),
    memories: [],
    autonomy: [],
    pausedUntil: undefined,
    profile: { postalAddress: null, schedulingLink: null, timezone: 'America/New_York' },
    extractable: [],
    proposals: [],
    due: [],
    linkedin: { status: 'not_connected', relations: 0 },
    history: new Map(),
    deleted: false,
    unconfigured: new Set(),
    targets: [],
    friends: [],
    friendInvites: [],
    friendShareMode: 'all',
    friendCompanyDomains: [],
    ownShares: [],
    friendAsks: [],
    autopilot: emptyAutopilot(),
    goalModes: new Map(),
    voice: { cardProse: [], notes: [], soundsLikeYou: null, relearnedAt: null, relearnRequests: 0 },
  };
  const code = 'good-code';

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  const error = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
    json(status, { error: { code, message } }, headers);

  const issue = () => {
    const accessToken = `at_${uuid()}`;
    const refreshToken = `rt_${uuid()}`;
    state.access.set(accessToken, clock + ttl);
    state.refresh = refreshToken;
    return { accessToken, refreshToken, expiresAt: iso(clock + ttl) };
  };

  const authed = (req: Request): boolean => {
    const h = req.headers.get('authorization') ?? '';
    const t = h.replace(/^Bearer /, '');
    const exp = state.access.get(t);
    return !!exp && exp > clock;
  };

  const addMemory = (text: string, kind: MemoryKind, personId?: string) => {
    const dup = state.memories.find((m) => m.text.toLowerCase() === text.toLowerCase());
    if (dup) {
      dup.lastSeenAt = iso(clock);
      return { memory: dup, deduped: true };
    }
    const m: MemoryItem = {
      id: uuid(),
      kind,
      text,
      personId: personId ?? null,
      importance: 0.5,
      createdAt: iso(clock),
      lastSeenAt: iso(clock),
    };
    state.memories.push(m);
    return { memory: m, deduped: false };
  };

  const handle = async (route: string, body: Record<string, unknown>, req: Request): Promise<Response> => {
    if (state.unconfigured.has(route))
      return json(
        503,
        { error: { code: 'unconfigured', message: 'not configured', missing: ['EXA_API_KEY'] } },
        { 'x-orbit-connector': 'unconfigured' },
      );
    // sign-in and sessions
    if (route === '/auth/session') {
      if (body.code !== code)
        return error(401, 'unauthorized', 'that sign-in link has expired; sign in again');
      return json(200, { ...issue(), user: state.user });
    }
    if (route === '/auth/refresh') {
      if (!state.refresh || body.refreshToken !== state.refresh)
        return error(401, 'unauthorized', 'the session has ended; sign in again');
      return json(200, issue());
    }
    if (!authed(req)) return error(401, 'unauthorized', 'sign in again');
    // plan 29: routes with a path parameter, matched before the table
    const friendShares = route.match(/^\/friends\/shares\/([^/]+)$/);
    if (friendShares) {
      const f = state.friends.find((x) => x.userId === decodeURIComponent(friendShares[1]!));
      if (!f || f.theirMode === 'none') return error(403, 'forbidden', 'not a friend who shares with you');
      const company = new URL(req.url).searchParams.get('company')?.toLowerCase() ?? '';
      const all = visibleShares(f).filter(
        (s) => !company || s.company?.toLowerCase() === company || s.companyDomain?.toLowerCase() === company,
      );
      return json(200, {
        friendUserId: f.userId,
        shares: all.slice(0, 50).map(publicShare),
        total: all.length,
        nextCursor: all.length > 50 ? 'c50' : null,
      });
    }
    const askRespond = route.match(/^\/friends\/asks\/([^/]+)\/respond$/);
    if (askRespond) {
      const ask = state.friendAsks.find((a) => a.id === askRespond[1] && a.friendUserId === state.user.id);
      if (!ask) return error(404, 'not_found', 'no such ask');
      if (ask.status !== 'asked') return error(409, 'already_answered', 'that ask was answered');
      ask.answeredAt = iso(clock);
      if (body.action === 'decline') {
        ask.status = 'declined';
        return json(200, { ask, draft: null });
      }
      if (body.action !== 'forward') return error(400, 'bad_request', 'action is forward or decline');
      const id = uuid();
      const d = draftRow(
        id,
        ask.targetPersonId,
        'gmail',
        typeof body.body === 'string' && body.body.trim()
          ? body.body
          : `Hi ${ask.targetName.split(' ')[0]},\n\n${ask.askerName} asked me to put you two in touch. In their words:\n\n${ask.note}\n\nCc'ing ${ask.askerName.split(' ')[0]} so you two can take it from here. No pressure either way.\n\n${state.user.firstName ?? ''}`,
        clock,
      );
      d.subject = `Intro: ${ask.askerName.split(' ')[0]} <> ${ask.targetName.split(' ')[0]}`;
      state.drafts.set(id, d);
      ask.status = 'forwarded';
      ask.forwardedDraftId = id;
      return json(200, { ask, draft: d });
    }
    switch (route) {
      // friends (plan 29 Part A)
      case '/friends':
        return json(200, {
          friends: state.friends.map((f) => friendView(f, state.targets)),
          pending: state.friendInvites.filter((i) => i.status === 'pending'),
        });
      case '/friends/invite': {
        const today = state.friendInvites.filter(
          (i) => i.direction === 'out' && clock - Date.parse(i.createdAt) < 24 * 3600_000,
        );
        if (today.length >= 20) return error(429, 'rate_limited', 'at most 20 invites a day');
        const email =
          typeof body.email === 'string' && body.email.trim() ? body.email.trim().toLowerCase() : null;
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
          return error(400, 'bad_request', 'that is not an email address');
        const inviteCode = uuid().replace(/-/g, '').slice(0, 22);
        const invite: FriendInvite = {
          id: uuid(),
          direction: 'out',
          email,
          name: null,
          status: 'pending',
          createdAt: iso(clock),
        };
        state.friendInvites.push(invite);
        return json(200, {
          code: inviteCode,
          link: `https://tryorbit.today/friends/join/${inviteCode}`,
          status: email ? 'sent' : 'link',
          invite,
        });
      }
      case '/friends/accept': {
        const invite = state.friendInvites.find(
          (i) =>
            i.direction === 'in' &&
            i.status === 'pending' &&
            (i.id === body.friendshipId || i.id === body.code),
        );
        if (!invite) return error(404, 'not_found', 'no such request');
        const mode = body.mode as FriendShareMode;
        if (!['all', 'companies', 'none'].includes(mode)) return error(400, 'bad_request', 'mode');
        invite.status = 'accepted';
        const f = fakeFriend({
          friendshipId: invite.id,
          userId: uuid(),
          name: invite.name ?? invite.email ?? 'A friend',
          myMode: mode,
          myCompanyDomains: (body.companyDomains as string[]) ?? [],
          since: iso(clock),
        });
        state.friends.push(f);
        return json(200, { friend: friendView(f, state.targets) });
      }
      case '/friends/decline': {
        const invite = state.friendInvites.find(
          (i) => i.status === 'pending' && (i.id === body.friendshipId || i.id === body.code),
        );
        if (!invite) return error(404, 'not_found', 'no such request');
        invite.status = 'declined';
        return json(200, { ok: true });
      }
      case '/friends/end': {
        const n = state.friends.length;
        state.friends = state.friends.filter((f) => f.friendshipId !== body.friendshipId);
        if (state.friends.length === n) return error(404, 'not_found', 'no such friend');
        for (const a of state.friendAsks)
          if (a.friendshipId === body.friendshipId && a.status === 'asked') a.status = 'expired';
        return json(200, { ok: true });
      }
      case '/friends/settings': {
        const mode = body.mode as FriendShareMode;
        if (!['all', 'companies', 'none'].includes(mode)) return error(400, 'bad_request', 'mode');
        const domains = Array.isArray(body.companyDomains) ? (body.companyDomains as string[]) : [];
        if (body.friendshipId) {
          const f = state.friends.find((x) => x.friendshipId === body.friendshipId);
          if (!f) return error(404, 'not_found', 'no such friend');
          f.myMode = mode;
          f.myCompanyDomains = domains;
        } else {
          state.friendShareMode = mode;
          state.friendCompanyDomains = domains;
          for (const f of state.friends) {
            f.myMode = mode;
            f.myCompanyDomains = domains;
          }
        }
        return json(200, { mode, companyDomains: domains, shares: ownVisible(state).length });
      }
      case '/friends/preview':
        return json(200, {
          mode: state.friendShareMode,
          companyDomains: state.friendCompanyDomains,
          shares: ownVisible(state),
          total: ownVisible(state).length,
        });
      case '/friends/asks': {
        if (req.method === 'GET' || !('friendUserId' in body))
          return json(200, {
            asked: state.friendAsks.filter((a) => a.askerUserId === state.user.id),
            received: state.friendAsks.filter((a) => a.friendUserId === state.user.id),
          });
        const f = state.friends.find((x) => x.userId === body.friendUserId);
        if (!f || f.theirMode === 'none') return error(403, 'forbidden', 'not a friend who shares with you');
        const target = visibleShares(f).find((s) => s.personId === body.targetPersonId);
        if (!target) return error(404, 'not_found', 'that person is not one your friend shares');
        const note = typeof body.note === 'string' ? body.note.trim() : '';
        if (!note) return error(400, 'bad_request', 'a note to forward is needed');
        const todays = state.friendAsks.filter(
          (a) =>
            a.friendshipId === f.friendshipId &&
            a.askerUserId === state.user.id &&
            clock - Date.parse(a.createdAt) < 24 * 3600_000,
        );
        if (todays.length >= 10) return error(429, 'rate_limited', 'at most 10 asks a day per friend');
        const ask: FriendIntroAsk = {
          id: uuid(),
          friendshipId: f.friendshipId,
          askerUserId: state.user.id,
          askerName: state.user.fullName ?? state.user.firstName ?? 'You',
          friendUserId: f.userId,
          friendName: f.name,
          targetPersonId: target.personId,
          targetName: target.displayName,
          targetCompany: target.company,
          askerPersonId: target.matchesPersonId ?? null,
          note,
          status: 'asked',
          createdAt: iso(clock),
          answeredAt: null,
          forwardedDraftId: null,
        };
        state.friendAsks.push(ask);
        return json(200, { ask });
      }
      // autopilot and voice (plan 29 Part B)
      case '/autopilot/mode': {
        const mode = body.mode as AutopilotStatus['mode'];
        if (!['off', 'assist', 'autopilot'].includes(mode)) return error(400, 'bad_request', 'mode');
        const level = mode === 'off' ? 0 : mode === 'assist' ? 1 : 2;
        if (typeof body.goalId === 'string') {
          state.goalModes.set(body.goalId, mode);
          state.autonomy.push({ level, goalId: body.goalId });
          return json(200, { mode, goalId: body.goalId });
        }
        state.autopilot.mode = mode;
        state.autonomy.push({ level });
        return json(200, { mode, goalId: null });
      }
      case '/autopilot/status':
        return json(200, state.autopilot);
      case '/autopilot/hold': {
        const i = state.autopilot.queued.findIndex((x) => x.draftId === body.draftId);
        if (i < 0) return error(404, 'not_found', 'nothing queued with that id');
        const [item] = state.autopilot.queued.splice(i, 1);
        const held: AutopilotItem = { ...item!, status: 'held', reason: 'You held it' };
        state.autopilot.held.push(held);
        const d = state.drafts.get(held.draftId);
        if (d) d.status = 'draft';
        return json(200, { item: held });
      }
      case '/autopilot/pause': {
        const until = (body.until as string | null) ?? null;
        if (typeof body.goalId === 'string') {
          const g = state.goals.find((x) => x.id === body.goalId);
          state.autopilot.pausedGoals = state.autopilot.pausedGoals.filter((p) => p.goalId !== body.goalId);
          if (until)
            state.autopilot.pausedGoals.push({
              goalId: body.goalId,
              title: g?.title ?? 'this goal',
              until,
              reason: 'You paused it',
            });
          return json(200, { pausedUntil: until, goalId: body.goalId, cancelled: 0 });
        }
        state.autopilot.pausedUntil = until;
        state.pausedUntil = until;
        let cancelled = 0;
        if (until) {
          cancelled = state.autopilot.queued.length;
          for (const q of state.autopilot.queued) {
            q.status = 'cancelled';
            const d = state.drafts.get(q.draftId);
            if (d) d.status = 'cancelled';
          }
          state.autopilot.queued = [];
        }
        return json(200, { pausedUntil: until, goalId: null, cancelled });
      }
      case '/replies/answer': {
        const d = state.drafts.get(String(body.draftId));
        if (!d) return error(404, 'not_found', 'no such draft');
        const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
        if (!answer) return error(400, 'bad_request', 'an answer is needed');
        d.body = d.body.replace(/\[ASK USER:[^\]]*\]/g, answer);
        d.needsInput = [];
        d.updatedAt = iso(clock);
        state.autopilot.needsYou = state.autopilot.needsYou.filter((x) => x.draftId !== d.id);
        return json(200, { draft: d });
      }
      case '/voice':
        return json(200, {
          card: null,
          cardProse: state.voice.cardProse,
          notes: state.voice.notes.filter((n) => !n.forgottenAt),
          soundsLikeYou: state.voice.soundsLikeYou,
          relearnedAt: state.voice.relearnedAt,
        });
      case '/voice/notes': {
        const n = state.voice.notes.find((x) => x.id === body.id);
        if (!n) return error(404, 'not_found', 'no such note');
        if (body.action === 'keep') n.keptAt = iso(clock);
        else if (body.action === 'forget') n.forgottenAt = iso(clock);
        else return error(400, 'bad_request', 'action is keep or forget');
        return json(200, { note: n });
      }
      case '/voice/relearn':
        state.voice.relearnRequests += 1;
        return json(200, { queued: true });
      case '/auth/logout':
        state.refresh = undefined;
        return json(200, { ok: true });
      case '/auth/me':
        return json(200, { user: state.user });
      case '/sync/status':
        return json(200, {
          counts: state.status.counts,
          integrations: [
            {
              provider: 'google',
              status: state.status.google.status,
              email: state.user.email,
              scopes: [],
              linked: true,
              lastSyncedAt: null,
              lastError: null,
              watchExpiresAt: null,
              backfill: state.status.google.backfill,
            },
          ],
          jobs: { pending: 0 },
        });
      case '/sync/pull': {
        const at = typeof body.cursor === 'string' && body.cursor ? Number(body.cursor.slice(1)) : 0;
        const page = state.pages[at];
        if (!page) return json(200, { changes: {}, deleted: {}, cursor: `c${at}`, hasMore: false });
        return json(200, {
          changes: page.changes,
          deleted: page.deleted ?? {},
          cursor: `c${at + 1}`,
          hasMore: at + 1 < state.pages.length,
        });
      }
      case '/sync/push': {
        const changes =
          (body.changes as { table: string; op: string; id: string; row?: Record<string, unknown> }[]) ?? [];
        const results = changes.map((c) => {
          const refused = state.rejectPush.get(c.id);
          if (refused)
            return { table: c.table, id: c.id, ok: false, error: { code: refused, message: 'refused' } };
          state.pushed.push(c);
          if (c.table === 'drafts') {
            const d = state.drafts.get(c.id);
            if (d && c.row) {
              if (typeof c.row.body === 'string') d.body = c.row.body;
              if ('subject' in c.row) d.subject = (c.row.subject as string | null) ?? null;
              d.needsInput = /\[ASK USER:/.test(d.body) ? d.needsInput : [];
            }
          }
          return { table: c.table, id: c.id, ok: true };
        });
        return json(200, { results });
      }
      case '/account/export':
        return json(200, {
          exportedAt: iso(clock),
          format: 'orbit-export-v1',
          data: { users: [state.user] },
        });
      case '/account/delete':
        if (body.confirm !== 'DELETE') return error(400, 'bad_request', "send {confirm: 'DELETE'}");
        state.deleted = true;
        return json(200, { deleted: true, cleanup: {} });
      case '/google/sync':
        return json(200, { queued: true });
      case '/linkedin/connect/start':
        state.linkedin.status = 'active';
        state.linkedin.relations = 120;
        return json(200, { url: 'https://account.unipile.test/link' });
      case '/linkedin/status':
        return json(200, {
          status: state.linkedin.status,
          accountId: state.linkedin.status === 'active' ? 'acc_1' : null,
          lastSyncedAt: null,
          relations: state.linkedin.relations,
        });
      case '/linkedin/sync':
        return json(200, { queued: true });
      // everything with one person, for their page
      case '/people/history':
        return json(
          200,
          state.history.get(String(body.personId)) ?? { threads: [], messages: [], events: [] },
        );
      // the student's own LinkedIn account and the proxy's token for it, once LinkedIn is connected
      case '/linkedin/reader':
        return json(
          200,
          state.linkedin.status === 'active'
            ? { ok: true, accountId: 'acc_1', token: 'tok_acc_1' }
            : { ok: false, reason: 'not_connected' },
        );
      // goals
      case '/goals/list':
        return json(200, { goals: state.goals.filter((g) => !g.deletedAt) });
      case '/goals/upsert': {
        const g = body.goal as Partial<Goal> & { kind: Goal['kind']; title: string };
        const existing = g.id ? state.goals.find((x) => x.id === g.id) : undefined;
        const active = state.goals.filter((x) => !x.deletedAt && x.status === 'active' && x.id !== g.id);
        if ((g.status ?? 'active') === 'active' && active.length >= 5)
          return error(409, 'too_many_goals', 'at most 5 active goals');
        const at = iso(clock);
        const next: Goal = {
          targets: { organizations: [], roles: [], geographies: [], people: [] },
          criteria: {},
          priority: 2,
          status: 'active',
          source: 'user',
          ...existing,
          ...g,
          id: existing?.id ?? uuid(),
          userId: state.user.id,
          createdAt: existing?.createdAt ?? at,
          updatedAt: at,
        } as Goal;
        state.goals = [...state.goals.filter((x) => x.id !== next.id), next];
        return json(200, { goal: next });
      }
      case '/goals/archive': {
        const g = state.goals.find((x) => x.id === body.id);
        if (!g) return error(404, 'not_found', 'no such goal');
        g.deletedAt = iso(clock);
        g.status = 'done';
        return json(200, { ok: true });
      }
      // scores
      case '/scores/explain': {
        const s = state.scores.get(String(body.personId)) ?? {
          score: 50,
          band: 'warm',
          explanation: ['12 messages between you (5 from them)'],
        };
        const label = state.labels.get(String(body.personId));
        return json(200, {
          personId: body.personId,
          ...s,
          contributions: {},
          modelVersion: 'tie-v1',
          computedAt: iso(clock),
          ...(label ? { labelled: label } : {}),
        });
      }
      case '/scores/label':
        state.labels.set(String(body.personId), Number(body.closeness));
        return json(200, { ok: true });
      // research
      case '/research/person': {
        const pid = String(body.personId);
        const d = state.dossiers.get(pid);
        if (d && !body.refresh) return json(200, { status: d.status, dossier: d });
        const queued = state.researchQueue.get(pid);
        if (queued) {
          state.dossiers.set(pid, { ...queued, status: 'pending' });
          return json(200, { status: 'queued', dossier: null });
        }
        return json(200, { status: 'queued', dossier: null });
      }
      case '/research/get': {
        const pid = String(body.personId);
        const ready = state.researchQueue.get(pid);
        if (ready && state.dossiers.get(pid)?.status === 'pending') {
          state.dossiers.set(pid, ready);
          state.researchQueue.delete(pid);
        }
        return json(200, { dossier: state.dossiers.get(pid) ?? null });
      }
      case '/research/choose': {
        const pid = String(body.personId);
        const ready = state.researchQueue.get(pid);
        if (ready) state.dossiers.set(pid, ready);
        return json(200, { status: ready ? ready.status : 'queued', dossier: ready ?? null });
      }
      // sourcing
      case '/source/search':
        return json(200, {
          batchId: uuid(),
          results: state.sourced,
          unconfigured: ['apollo'],
          relaxed: [],
        });
      case '/source/add': {
        const ids = (body.recommendationIds as string[]) ?? [];
        const people = ids
          .map((id) => state.sourced.find((c) => c.id === id))
          .filter((c): c is SourcedCandidate => !!c)
          .map((c) => ({ id: uuid(), displayName: c.name, chatId: uuid(), from: c }));
        const at = iso(clock);
        state.pages.push({
          changes: {
            people: people.map((p) => ({
              id: p.id,
              userId: state.user.id,
              displayName: p.displayName,
              currentTitle: p.from.title,
              currentOrganizationRaw: p.from.org,
              sources: ['manual'],
              createdAt: at,
              updatedAt: at,
            })),
            chats: people.map((p) => ({
              id: p.chatId,
              userId: state.user.id,
              personId: p.id,
              stage: 'identified',
              stageEnteredAt: at,
              createdAt: at,
              updatedAt: at,
            })),
          },
        });
        return json(200, {
          people: people.map(({ id, displayName, chatId }) => ({ id, displayName, chatId })),
        });
      }
      // routes
      case '/paths/find': {
        const target = body.target as {
          personId?: string;
          company?: string;
          domain?: string;
          linkedinUrl?: string;
        };
        const own = (target.personId && state.paths.get(target.personId)) || [];
        // plan 29 A4: a hop through a friend who shares the person, ranked with the student's own routes
        const viaFriends = friendPaths(state, target);
        const paths = [...own, ...viaFriends].sort((a, b) => b.p - a.p);
        return json(200, {
          paths,
          sources: viaFriends.length ? ['graph', 'friends'] : ['graph'],
          unconfigured: [],
          ...(target.personId && !paths.length ? { fallback: 'cold' } : {}),
        });
      }
      case '/intros/ask': {
        const draftId = uuid();
        state.drafts.set(
          draftId,
          draftRow(draftId, String(body.introducerPersonId), 'gmail', 'Hi, would you introduce me?', clock),
        );
        return json(200, { introRequestId: uuid(), draftIds: [draftId] });
      }
      // replies and drafts
      case '/replies/list':
        return json(200, { replies: state.replies });
      case '/replies/draft': {
        const r = state.replies.find((x) => x.messageId === body.messageId);
        if (!r) return error(404, 'not_found', 'no such reply');
        const id = uuid();
        const ask = r.replyClass === 'question';
        const d = draftRow(
          id,
          r.personId ?? '',
          r.channel,
          ask
            ? 'Hi, thanks for asking. [ASK USER: What is your start date?] Best, Maya'
            : 'Hi, thanks so much. Any of these work for a quick call? Best, Maya',
          clock,
        );
        d.needsInput = ask ? ['What is your start date?'] : [];
        d.kind = 'reply';
        state.drafts.set(id, d);
        r.draftId = id;
        return json(200, { draft: d });
      }
      case '/drafts/approve': {
        const d = state.drafts.get(String(body.draftId));
        if (!d) return error(404, 'not_found', 'no such draft');
        if (d.channel === 'linkedin' && body.confirm !== true)
          return error(409, 'needs_confirm', 'LinkedIn messages need a tap to confirm');
        if (/\[ASK USER:/.test(d.body))
          return error(409, 'needs_input', 'answer the question in the draft first');
        d.status = 'scheduled';
        d.sendAt = iso(clock + 18 * 3600_000);
        return json(200, { draft: d });
      }
      case '/drafts/cancel':
      case '/drafts/discard': {
        const d = state.drafts.get(String(body.draftId));
        if (!d) return error(404, 'not_found', 'no such draft');
        d.status = route === '/drafts/cancel' ? 'cancelled' : 'discarded';
        return json(200, { draft: d });
      }
      case '/drafts/compose': {
        const id = uuid();
        const d = draftRow(id, String(body.personId), body.channel as 'gmail', 'Hi there.', clock);
        state.drafts.set(id, d);
        return json(200, { draft: d });
      }
      case '/calendar/slots':
        return json(200, {
          tz: 'America/New_York',
          slots: [
            {
              start: '2026-10-07T14:00:00Z',
              end: '2026-10-07T14:30:00Z',
              label: 'Wed Oct 7, 10:00 to 10:30 ET',
            },
            {
              start: '2026-10-08T15:00:00Z',
              end: '2026-10-08T15:30:00Z',
              label: 'Thu Oct 8, 11:00 to 11:30 ET',
            },
            {
              start: '2026-10-13T18:00:00Z',
              end: '2026-10-13T18:30:00Z',
              label: 'Tue Oct 13, 2:00 to 2:30 PM ET',
            },
          ],
        });
      case '/calendar/book':
        return json(200, { eventId: `evt_${uuid()}` });
      // memory
      case '/memory/search': {
        const q = String(body.query ?? '').toLowerCase();
        const words = q.split(/\W+/).filter((w) => w.length > 2);
        const hits = state.memories
          .filter((m) => !body.personId || m.personId === body.personId)
          .map((m) => ({
            ...m,
            score: words.filter((w) => m.text.toLowerCase().includes(w)).length / Math.max(1, words.length),
          }))
          .filter((m) => m.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, Number(body.limit ?? 8));
        return json(200, { memories: hits });
      }
      case '/memory/add':
        return json(200, addMemory(String(body.text), body.kind as MemoryKind, body.personId as string));
      case '/memory/extract': {
        const turns = body.turns as { role: string; text: string }[] | undefined;
        if (!Array.isArray(turns) || !turns.length || turns.length > 6)
          return error(400, 'bad_request', 'turns');
        if (turns.reduce((n, t) => n + t.text.length, 0) > 8000) return error(400, 'bad_request', 'too long');
        const found = state.extractable.splice(0).map((m) => addMemory(m.text, m.kind));
        return json(200, {
          memories: found.map((f) => f.memory),
          added: found.filter((f) => !f.deduped).length,
        });
      }
      case '/goals/infer': {
        const turns = body.turns as { role: string; text: string }[] | undefined;
        if (!Array.isArray(turns) || !turns.length || turns.length > 6)
          return error(400, 'bad_request', 'turns');
        return json(200, { goals: state.proposals });
      }
      case '/memory/list':
        return json(200, { memories: state.memories });
      case '/memory/forget': {
        const before = state.memories.length;
        state.memories = state.memories.filter((m) => m.id !== body.id);
        if (state.memories.length === before) return error(404, 'not_found', 'no such memory');
        return json(200, { ok: true });
      }
      // settings and cadence
      case '/settings/autonomy':
        state.autonomy.push({ level: Number(body.level), goalId: body.goalId as string | undefined });
        return json(200, { ok: true });
      case '/settings/pause':
        state.pausedUntil = (body.until as string | null) ?? null;
        return json(200, { ok: true });
      case '/settings/profile': {
        const link = body.schedulingLink;
        if (typeof link === 'string' && link && !/^https:\/\/[^/\s]+/.test(link))
          return error(400, 'bad_request', 'schedulingLink must be an https link');
        if (typeof body.postalAddress === 'string' && body.postalAddress.length > 500)
          return error(400, 'bad_request', 'postalAddress is at most 500 characters');
        const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
        if ('postalAddress' in body) state.profile.postalAddress = text(body.postalAddress);
        if ('schedulingLink' in body) state.profile.schedulingLink = text(link);
        if (typeof body.timezone === 'string') state.profile.timezone = body.timezone;
        if ('about' in body)
          state.profile.about =
            body.about && typeof body.about === 'object' ? (body.about as Record<string, unknown>) : null;
        return json(200, state.profile);
      }
      case '/cadence/due':
        return json(200, { items: state.due });
      default:
        return error(404, 'not_found', 'no such route');
    }
  };

  const fakeFetch: typeof fetch = async (input, init) => {
    // under jsdom the client's AbortSignal is jsdom's, which undici's Request refuses: the fake never aborts anyway
    const req = new Request(input as RequestInfo, init ? { ...init, signal: undefined } : init);
    const url = new URL(req.url);
    if (!url.href.startsWith(base)) throw new TypeError('fake orbit-api: unexpected host');
    const route = url.pathname.replace(new URL(base).pathname, '');
    let body: Record<string, unknown> = {};
    if (req.method === 'POST') {
      const text = await req.text();
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    }
    calls.push({ route, body, auth: req.headers.get('authorization') ?? undefined });
    return handle(route, body, req);
  };

  return {
    base,
    fetch: fakeFetch,
    calls,
    state,
    code,
    routes: () => calls.map((c) => c.route),
    advance(ms: number) {
      clock += ms;
    },
  };
}

function draftRow(
  id: string,
  personId: string,
  channel: 'gmail' | 'linkedin',
  body: string,
  clock: number,
): ServerDraft {
  return {
    id,
    personId,
    chatId: null,
    goalId: null,
    channel,
    kind: 'intro_request',
    subject: channel === 'gmail' ? 'Quick question' : null,
    body,
    status: 'draft',
    sendAt: null,
    sentAt: null,
    validator: { ok: true, issues: [], words: 10, grade: 5 },
    generatedBy: 'template',
    hooks: [],
    needsInput: [],
    createdAt: iso(clock),
    updatedAt: iso(clock),
  };
}

/** A ready dossier for a person, with two sources. */
export function fakeDossier(userId: string, personId: string, over: Partial<Dossier> = {}): Dossier {
  return {
    id: crypto.randomUUID(),
    userId,
    personId,
    status: 'ready',
    content: {
      who: 'Product lead for payments at Stripe.',
      now: { role: 'Product Lead', org: 'Stripe', since: '2024', source_ids: ['S1'] },
      recently: [{ date: '2026-09', text: 'Spoke about fraud models at Money20/20.', source_ids: ['S2'] }],
      in_common: [{ text: 'Both studied at Cornell.', kind: 'school', source_ids: ['S1'] }],
      history: {
        first_contact: '2025-03-02',
        last_contact: '2026-08-14',
        summary: 'Two emails about internships.',
      },
      openers: [{ text: 'Your talk on fraud models stuck with me.', source_ids: ['S2'] }],
      careful: ['Two people with this name work in fintech.'],
      confidence: 'high',
    },
    sources: [
      { id: 'S1', url: 'https://example.com/profile', title: 'Profile' },
      { id: 'S2', url: 'https://example.com/talk', title: 'Money20/20 talk' },
    ],
    costUsd: 0.12,
    createdAt: '2026-10-06T12:00:00.000Z',
    updatedAt: '2026-10-06T12:00:00.000Z',
    expiresAt: '2026-11-05T12:00:00.000Z',
    ...over,
  };
}

// ---- friends and autopilot (plan 29), what the fake keeps and the seeds the bench uses --------------------------------

function emptyAutopilot(): AutopilotStatus {
  return {
    mode: 'off',
    pausedUntil: null,
    pausedGoals: [],
    queued: [],
    held: [],
    sentToday: [],
    needsYou: [],
    rungs: [
      { kind: 'bump', needed: 10, unchanged: 0, unlocked: false },
      { kind: 'thank_you', needed: 10, unchanged: 0, unlocked: false },
      { kind: 'schedule', needed: 10, unchanged: 0, unlocked: false },
      { kind: 'first_touch', needed: 20, unchanged: 0, unlocked: false },
    ],
    caps: {
      autoPerDay: 5,
      firstTouchPerWeek: 12,
      firstTouchPerDay: 3,
      usedToday: 0,
      firstTouchesThisWeek: 0,
    },
    reviewUntil: null,
  };
}

/** What the friend shares with the student, under the friend's mode. */
function visibleShares(f: FakeFriend): FakeFriendShare[] {
  if (f.theirMode === 'none') return [];
  if (f.theirMode === 'companies')
    return f.people.filter((p) => p.companyDomain && f.theirCompanyDomains.includes(p.companyDomain));
  return f.people;
}

/** The projection row as the server would send it: never the fake's own join hint. */
function publicShare(s: FakeFriendShare): FriendShare {
  const { matchesPersonId: _m, ...pub } = s;
  return pub;
}

function ownVisible(state: FakeState): FriendShare[] {
  if (state.friendShareMode === 'none') return [];
  if (state.friendShareMode === 'companies')
    return state.ownShares.filter(
      (p) => p.companyDomain && state.friendCompanyDomains.includes(p.companyDomain),
    );
  return state.ownShares;
}

/** The row the Friends tab shows, with the counts computed from the people behind it. */
function friendView(f: FakeFriend, targets: string[]): Friend {
  const vis = visibleShares(f);
  const lower = targets.map((t) => t.toLowerCase());
  const at = vis.filter((p) => p.company && lower.includes(p.company.toLowerCase()));
  const knowsAt = targets
    .map((company) => ({
      company,
      count: vis.filter((p) => p.company?.toLowerCase() === company.toLowerCase()).length,
    }))
    .filter((k) => k.count > 0);
  const { people: _p, theirMode: _t, theirCompanyDomains: _d, ...row } = f;
  return { ...row, shares: vis.length, atTargets: at.length, knowsAt };
}

/** The friend layer of /paths/find (plan 29 A4): p from the closeness word, 1: 0.35, 2: 0.6, 3: 0.85. */
const CLOSENESS_P: Record<FriendCloseness, number> = { 1: 0.35, 2: 0.6, 3: 0.85 };
const CLOSENESS_WORD: Record<FriendCloseness, string> = { 1: 'knows', 2: 'knows well', 3: 'is close to' };

function friendPaths(
  state: FakeState,
  target: { personId?: string; company?: string; domain?: string; linkedinUrl?: string },
): (WarmPath & { id: string; names: Record<string, string> })[] {
  const out: (WarmPath & { id: string; names: Record<string, string> })[] = [];
  const company = target.company?.toLowerCase();
  const domain = target.domain?.toLowerCase();
  const slug = target.linkedinUrl?.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1]?.toLowerCase();
  for (const f of state.friends) {
    for (const s of visibleShares(f)) {
      const hit =
        (target.personId && s.matchesPersonId === target.personId) ||
        (slug && s.linkedinSlug?.toLowerCase() === slug) ||
        (company && s.company?.toLowerCase() === company) ||
        (domain && s.companyDomain?.toLowerCase() === domain);
      if (!hit) continue;
      const friendNode = `friend:${f.userId}`;
      const targetNode = s.matchesPersonId ?? `friend_person:${s.personId}`;
      const via = { kind: 'friend' as const, userId: f.userId, name: f.name };
      const p2 = CLOSENESS_P[s.closeness];
      const hops: WarmHop[] = [
        { fromId: 'user', toId: friendNode, p: 0.9, kind: 'strength', via },
        {
          fromId: friendNode,
          toId: targetNode,
          p: p2,
          kind: s.closeness === 1 ? 'linkedin_mutual' : 'student_says_close',
          band: p2 >= 0.65 ? 'close' : p2 >= 0.5 ? 'know' : 'connected',
          phrase: `${CLOSENESS_WORD[s.closeness]} ${s.displayName.split(' ')[0]}`,
          via,
        },
      ];
      const p = 0.9 * p2;
      out.push({
        id: `path_friend_${f.userId}_${s.personId}`,
        nodes: ['user', friendNode, targetNode],
        hops,
        p,
        band: p >= 0.35 ? 'high' : p >= 0.15 ? 'medium' : 'low',
        firstHopId: friendNode,
        otherWays: 0,
        reasonText: `${f.name.split(' ')[0]} (friend) ${CLOSENESS_WORD[s.closeness]} ${s.displayName.split(' ')[0]}${s.company ? ` at ${s.company}` : ''}.`,
        names: { [friendNode]: f.name, [targetNode]: s.displayName },
      });
    }
  }
  return out;
}

/** A friend with nothing shared yet; the seeds fill in the people. */
export function fakeFriend(over: Partial<FakeFriend> & Pick<FakeFriend, 'userId' | 'name'>): FakeFriend {
  return {
    friendshipId: uuid(),
    school: null,
    gradYear: null,
    avatarUrl: null,
    myMode: 'all',
    myCompanyDomains: [],
    since: '2026-09-28T15:00:00.000Z',
    people: [],
    theirMode: 'all',
    theirCompanyDomains: [],
    ...over,
  };
}

/** Ana Okafor's user id in the fake, so a test can address her shares and asks. */
export const ANA_USER_ID = '2f4b9c1e-5d6a-4e7b-8c9d-0a1b2c3d4e5f';

/** The demo student's target companies, which the friend seed counts against when the fake has none set. */
const DEMO_TARGETS = ['Stripe', 'Figma', 'Anthropic', 'Ramp', 'Notion', 'Linear'];

/** Who Ana knows at the student's targets: six people, one of whom the student already has (Maya Chen). */
const ANA_AT_TARGETS: Omit<FakeFriendShare, 'personId' | 'school' | 'isAlumni'>[] = [
  {
    displayName: 'Dan Lee',
    title: 'Staff Engineer, Payments',
    company: 'Stripe',
    companyDomain: 'stripe.com',
    linkedinSlug: 'dan-lee-stripe',
    closeness: 3,
  },
  {
    displayName: 'Maya Chen',
    title: 'Software Engineer',
    company: 'Stripe',
    companyDomain: 'stripe.com',
    linkedinSlug: 'maya-chen-eng',
    closeness: 2,
  },
  {
    displayName: 'Priya Raman',
    title: 'Product Manager',
    company: 'Figma',
    companyDomain: 'figma.com',
    linkedinSlug: 'priya-raman',
    closeness: 2,
  },
  {
    displayName: 'Theo Lindqvist',
    title: 'Research Engineer',
    company: 'Anthropic',
    companyDomain: 'anthropic.com',
    linkedinSlug: 'theo-lindqvist',
    closeness: 1,
  },
  {
    displayName: 'Nina Kowalski',
    title: 'Product Manager, Bill Pay',
    company: 'Ramp',
    companyDomain: 'ramp.com',
    linkedinSlug: 'nina-kowalski',
    closeness: 2,
  },
  {
    displayName: 'Isabel Moreno',
    title: 'Product Designer',
    company: 'Notion',
    companyDomain: 'notion.so',
    linkedinSlug: 'isabel-moreno-design',
    closeness: 1,
  },
];

const FILLER_FIRST = [
  'Omar',
  'Grace',
  'Felix',
  'Amara',
  'Diego',
  'Yuki',
  'Caleb',
  'Ines',
  'Sana',
  'Victor',
  'Jonah',
  'Rhea',
];
const FILLER_LAST = [
  'Haddad',
  'Liu',
  'Weber',
  'Nwosu',
  'Alvarez',
  'Sato',
  'Brennan',
  'Moreau',
  'Qureshi',
  'Castro',
];
const FILLER_FIRMS: [string, string][] = [
  ['Cornell University', 'cornell.edu'],
  ['Deloitte', 'deloitte.com'],
  ['Google', 'google.com'],
  ['Microsoft', 'microsoft.com'],
  ['Capital One', 'capitalone.com'],
  ['Bloomberg', 'bloomberg.com'],
  ['Spotify', 'spotify.com'],
  ['Datadog', 'datadoghq.com'],
  ['Meta', 'meta.com'],
  ['Shopify', 'shopify.com'],
  ['Palantir', 'palantir.com'],
  ['Amazon', 'amazon.com'],
];

/**
 * The bench's friend (plan 29 C2): Ana Okafor, Cornell 2025, shares 120 people, six of them at the student's target
 * companies, closeness 1 to 3. When the student's own people are given, Ana's Maya Chen joins to the student's row for
 * the same human (A2.6) and Ana's open ask is for an intro to the student's Lena Novak. The student shares everyone
 * back, as a preview a friend would see: names, titles, companies, a closeness word, never an address.
 */
export function withFriend(
  api: FakeOrbitApi,
  user: { id: string; school?: string; firstName?: string },
  people: { id: string; displayName: string; currentTitle?: string; currentOrganizationRaw?: string }[] = [],
): FakeFriend {
  const { state } = api;
  if (!state.targets.length) state.targets = [...DEMO_TARGETS];
  const own = new Map(people.map((p) => [p.displayName, p]));
  const shares: FakeFriendShare[] = ANA_AT_TARGETS.map((s, i) => ({
    ...s,
    personId: `ana_p_${i + 1}`,
    school: null,
    isAlumni: false,
    ...(own.get(s.displayName) ? { matchesPersonId: own.get(s.displayName)!.id } : {}),
  }));
  let n = shares.length;
  for (let i = 0; n < 120; i++) {
    const first = FILLER_FIRST[i % FILLER_FIRST.length]!;
    const last = FILLER_LAST[Math.floor(i / FILLER_FIRST.length) % FILLER_LAST.length]!;
    const [company, companyDomain] = FILLER_FIRMS[i % FILLER_FIRMS.length]!;
    const cornell = company === 'Cornell University';
    shares.push({
      personId: `ana_p_${n + 1}`,
      displayName: `${first} ${last}${i >= FILLER_FIRST.length * FILLER_LAST.length ? ` ${i}` : ''}`,
      title: cornell
        ? 'Senior, Information Science'
        : ['Analyst', 'Software Engineer', 'Associate', 'Product Manager'][i % 4]!,
      company,
      companyDomain,
      linkedinSlug: `${first.toLowerCase()}-${last.toLowerCase()}-${i}`,
      school: cornell ? 'Cornell University' : null,
      isAlumni: cornell,
      closeness: ([1, 1, 2, 1, 3, 2, 1, 2] as FriendCloseness[])[i % 8]!,
    });
    n++;
  }
  const ana = fakeFriend({
    friendshipId: 'fr_ana',
    userId: ANA_USER_ID,
    name: 'Ana Okafor',
    school: 'Cornell University',
    gradYear: 2025,
    people: shares,
    theirMode: 'all',
    myMode: 'all',
  });
  state.friends.push(ana);
  // what Ana sees of the student: the projection rules of A1, no address, no score, a closeness word only
  state.friendShareMode = 'all';
  state.ownShares = people.map((p, i) => ({
    personId: p.id,
    displayName: p.displayName,
    title: p.currentTitle ?? null,
    company: p.currentOrganizationRaw ?? null,
    companyDomain: null,
    linkedinSlug: null,
    school: null,
    isAlumni: false,
    closeness: ([2, 1, 3, 1, 2] as FriendCloseness[])[i % 5]!,
  }));
  // Ana's open ask of the student: an intro to Lena Novak at Ramp, whom the student knows
  const lena = own.get('Lena Novak');
  state.friendAsks.push({
    id: 'ask_ana_lena',
    friendshipId: ana.friendshipId,
    askerUserId: ANA_USER_ID,
    askerName: 'Ana Okafor',
    friendUserId: user.id,
    friendName: user.firstName ?? 'You',
    targetPersonId: lena?.id ?? 'lena_novak',
    targetName: 'Lena Novak',
    targetCompany: 'Ramp',
    askerPersonId: null,
    note: "I'm a Cornell 2025 grad on the payments team at Plaid and I'm looking at bill pay engineering roles. Lena's post on matching bills to payments is the closest thing to what I built last year. Would love 15 minutes on how her team decides what to automate, and no worries at all if now is a bad time.",
    status: 'asked',
    createdAt: '2026-10-05T16:20:00.000Z',
    answeredAt: null,
    forwardedDraftId: null,
  });
  return ana;
}

/** The replies the autopilot bench needs: one of every class the classifier knows, except other. */
const REPLY_SEEDS: {
  cls: ReplyClass;
  name: string;
  snippet: string;
  minutesAgo: number;
}[] = [
  {
    cls: 'interested',
    name: 'Maya Chen',
    snippet:
      'This sounds great, happy to help however I can. Tell me a bit more about what you are looking for.',
    minutesAgo: 70,
  },
  // the time names an offered slot (Thu Oct 8, 11:00 to 11:30 ET), so a confirmed slot can book itself (B2.3)
  {
    cls: 'scheduling',
    name: 'Lena Novak',
    snippet: 'Thu Oct 8 at 11 works for me. Send a calendar invite and I will be there.',
    minutesAgo: 95,
  },
  {
    cls: 'question',
    name: 'Daniel Okafor',
    snippet: 'Happy to. Quick one first: have you applied through the portal yet? It changes what I can do.',
    minutesAgo: 140,
  },
  {
    cls: 'objection',
    name: 'Victor Castro',
    snippet:
      "I'm not sure a referral makes sense before you've applied. Most people go through the portal first.",
    minutesAgo: 200,
  },
  {
    cls: 'referral',
    name: 'Sofia Bennett',
    snippet: 'Not really my area, but my colleague Raj runs that team. Want me to connect you?',
    minutesAgo: 260,
  },
  {
    cls: 'not_now',
    name: 'Ethan Park',
    snippet: 'Swamped until after the launch. Ping me in November and I will make time.',
    minutesAgo: 330,
  },
  {
    cls: 'out_of_office',
    name: 'Caleb Weber',
    snippet: 'I am out of the office until October 12 with limited access to email.',
    minutesAgo: 400,
  },
  {
    cls: 'decline',
    name: 'Jonah Reyes',
    snippet: "I'll pass on this one. Best of luck with the search.",
    minutesAgo: 470,
  },
  { cls: 'unsubscribe', name: 'Chloe Dubois', snippet: 'Please stop emailing me.', minutesAgo: 540 },
  {
    cls: 'thanks',
    name: 'Priya Shah',
    snippet: 'Thanks for the note, appreciate you reaching out. Good luck with the rest of the process.',
    minutesAgo: 610,
  },
];

/**
 * The autopilot bench (plan 29 C2): an inbound reply of every class, and a day on autopilot behind /autopilot/status:
 * three sent this morning, two queued for tomorrow's batch, one held (Priya, with the rule that held her), one reply
 * that needs the student (Daniel's question, with its draft), the rungs and the caps, and three voice notes.
 */
export function withReplies(
  api: FakeOrbitApi,
  user: { id: string; firstName?: string },
  people: { id: string; displayName: string; currentOrganizationRaw?: string }[] = [],
  now = Date.parse('2026-10-06T14:00:00.000Z'),
): void {
  const { state } = api;
  const first = user.firstName ?? 'Alex';
  const own = new Map(people.map((p) => [p.displayName, p]));
  const at = (minutesAgo: number) => iso(now - minutesAgo * 60_000);
  state.replies = REPLY_SEEDS.map((r, i) => ({
    messageId: `msg_${r.cls}_${i}`,
    threadId: `thr_${r.cls}_${i}`,
    personId: own.get(r.name)?.id ?? null,
    personName: r.name,
    channel: 'gmail' as const,
    replyClass: r.cls,
    confidence: 0.9,
    receivedAt: at(r.minutesAgo),
    snippet: r.snippet,
    draftId: null,
  }));
  // Daniel's question waits on the student: the draft carries the gap, Needs you carries the question
  const question = state.replies.find((r) => r.replyClass === 'question')!;
  const qDraft = draftRow(
    'draft_daniel_question',
    question.personId ?? '',
    'gmail',
    `Hi Daniel,\n\nThanks for getting back to me. [ASK USER: Have you applied through the portal yet?]\n\nBest,\n${first}`,
    now,
  );
  qDraft.kind = 'reply';
  qDraft.needsInput = ['Have you applied through the portal yet?'];
  state.drafts.set(qDraft.id, qDraft);
  question.draftId = qDraft.id;
  // the day on autopilot
  const org = (name: string, fallback: string) => own.get(name)?.currentOrganizationRaw ?? fallback;
  const pid = (name: string) => own.get(name)?.id ?? null;
  const item = (
    over: Partial<AutopilotItem> & Pick<AutopilotItem, 'draftId' | 'personName' | 'kind' | 'status'>,
  ): AutopilotItem => ({
    personId: pid(over.personName),
    company: null,
    subject: null,
    sendAt: null,
    sentAt: null,
    ...over,
  });
  const tomorrow = '2026-10-07T12:40:00.000Z'; // 8:40 am in New York
  for (const q of [
    item({
      draftId: 'draft_ap_grace',
      personName: 'Grace Liu',
      company: 'Linear',
      kind: 'first_touch',
      status: 'queued',
      subject: 'Linear and a question about onboarding flows',
      sendAt: tomorrow,
    }),
    item({
      draftId: 'draft_ap_omar',
      personName: 'Omar Haddad',
      company: 'Notion',
      kind: 'first_touch',
      status: 'queued',
      subject: 'Quick question from a Cornell junior',
      sendAt: '2026-10-07T12:58:00.000Z',
    }),
  ]) {
    const d = draftRow(
      q.draftId,
      q.personId ?? '',
      'gmail',
      `Hi ${q.personName.split(' ')[0]},\n\nShort first note.\n\nBest,\n${first}`,
      now,
    );
    d.kind = 'first_touch';
    d.subject = q.subject;
    d.status = 'scheduled';
    d.sendAt = q.sendAt;
    state.drafts.set(d.id, d);
  }
  state.autopilot = {
    mode: 'autopilot',
    pausedUntil: null,
    pausedGoals: [],
    queued: [
      item({
        draftId: 'draft_ap_grace',
        personName: 'Grace Liu',
        company: 'Linear',
        kind: 'first_touch',
        status: 'queued',
        subject: 'Linear and a question about onboarding flows',
        sendAt: tomorrow,
      }),
      item({
        draftId: 'draft_ap_omar',
        personName: 'Omar Haddad',
        company: 'Notion',
        kind: 'first_touch',
        status: 'queued',
        subject: 'Quick question from a Cornell junior',
        sendAt: '2026-10-07T12:58:00.000Z',
      }),
    ],
    held: [
      item({
        draftId: 'draft_ap_priya',
        personName: 'Priya Shah',
        company: 'Figma',
        kind: 'first_touch',
        status: 'held',
        subject: 'Figma design systems and a Cornell junior',
        sendAt: null,
        reason:
          'Kenji Mori at Figma was written to this morning; autopilot never writes to two people at one firm on the same day. Priya moves to Thursday.',
      }),
    ],
    sentToday: [
      item({
        draftId: 'draft_ap_kenji',
        personName: 'Kenji Mori',
        company: org('Kenji Mori', 'Figma'),
        kind: 'first_touch',
        status: 'sent',
        subject: 'Figma and a question about design tooling',
        sendAt: '2026-10-06T12:41:00.000Z',
        sentAt: '2026-10-06T12:41:00.000Z',
        autoRung: 'first_touch',
      }),
      item({
        draftId: 'draft_ap_ethan',
        personName: 'Ethan Park',
        company: org('Ethan Park', 'Anthropic'),
        kind: 'bump',
        status: 'sent',
        subject: 'Re: Quick question from a Cornell junior',
        sendAt: '2026-10-06T12:52:00.000Z',
        sentAt: '2026-10-06T12:52:00.000Z',
        autoRung: 'bump',
      }),
      item({
        draftId: 'draft_ap_lena',
        personName: 'Lena Novak',
        company: org('Lena Novak', 'Ramp'),
        kind: 'schedule',
        replyClass: 'scheduling',
        status: 'sent',
        subject: 'Re: Coffee chat',
        sendAt: '2026-10-06T13:05:00.000Z',
        sentAt: '2026-10-06T13:05:00.000Z',
        autoRung: 'schedule',
      }),
    ],
    needsYou: [
      item({
        draftId: qDraft.id,
        personName: 'Daniel Okafor',
        company: org('Daniel Okafor', 'Goldman Sachs'),
        kind: 'reply',
        replyClass: 'question',
        status: 'needs_you',
        subject: 'Re: Quick question from a Cornell junior',
        question: 'Have you applied through the portal yet?',
      }),
    ],
    rungs: [
      { kind: 'bump', needed: 10, unchanged: 10, unlocked: true },
      { kind: 'thank_you', needed: 10, unchanged: 10, unlocked: true },
      { kind: 'schedule', needed: 10, unchanged: 10, unlocked: true },
      { kind: 'first_touch', needed: 20, unchanged: 14, unlocked: false },
    ],
    caps: {
      autoPerDay: 5,
      firstTouchPerWeek: 12,
      firstTouchPerDay: 3,
      usedToday: 3,
      firstTouchesThisWeek: 5,
    },
    reviewUntil: '2026-10-07T04:40:00.000Z',
  };
  state.pausedUntil = null;
  // what Orbit learned from the student's edits (B2.4), in their words, each with the edits behind it
  state.voice = {
    cardProse: [
      `You greet with Hi and sign off with Thanks, ${first}.`,
      'You write short, with contractions and no exclamation marks.',
      'You get to the ask by the second sentence.',
    ],
    notes: [
      {
        id: 'vn_thanks_either_way',
        text: "You cut 'Thanks either way' every time",
        evidence: ['edit_1', 'edit_4', 'edit_9'],
        createdAt: '2026-10-05T03:10:00.000Z',
        keptAt: null,
        forgottenAt: null,
      },
      {
        id: 'vn_connection_once',
        text: 'You never open with the connection line twice in one thread',
        evidence: ['edit_2', 'edit_7'],
        createdAt: '2026-10-05T03:10:00.000Z',
        keptAt: '2026-10-05T14:00:00.000Z',
        forgottenAt: null,
      },
      {
        id: 'vn_first_name',
        text: 'You sign with your first name only',
        evidence: ['edit_3', 'edit_5', 'edit_6', 'edit_8'],
        createdAt: '2026-10-05T03:10:00.000Z',
        keptAt: null,
        forgottenAt: null,
      },
    ],
    soundsLikeYou: 2.6,
    relearnedAt: '2026-10-01T03:00:00.000Z',
    relearnRequests: 0,
  };
}
