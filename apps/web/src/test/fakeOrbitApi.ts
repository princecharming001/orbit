/**
 * An in-memory orbit-api for tests and the user simulation: every route the client calls, with sessions that expire
 * and rotate, sync pages, goals, scores, dossiers, sourcing, routes, replies, memory and settings. It answers through
 * a `fetch` the client is pointed at (setOrbitApiFetchForTests), so no test ever reaches a real server.
 */
import type {
  Dossier,
  DueItem,
  Goal,
  MemoryItem,
  MemoryKind,
  ProposedGoal,
  ReplyItem,
  ServerDraft,
  SourcedCandidate,
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
    switch (route) {
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
        const target = body.target as { personId?: string };
        return json(200, {
          paths: (target.personId && state.paths.get(target.personId)) || [],
          sources: ['graph'],
          unconfigured: [],
          ...(target.personId && !state.paths.get(target.personId) ? { fallback: 'cold' } : {}),
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
    const req = new Request(input as RequestInfo, init);
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
