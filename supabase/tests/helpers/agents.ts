/**
 * Fakes for the agent routes and jobs: one recording fetch that answers Anthropic, Exa, Unipile, Apollo, Village,
 * Semantic Scholar and Google by URL; a deterministic bag-of-words embedding (384 dims) standing in for gte-small; a
 * Google token source that never calls Google; and a signed-in user with a session.
 */
import { memoryTake } from '../../functions/_shared/ratelimit.ts';
import type { AgentConfig, AgentEnv } from '../../functions/_shared/services.ts';
import { createSession } from '../../functions/_shared/session.ts';
import { type ApiDeps, makeApiHandler } from '../../functions/orbit-api/api.ts';
import { upsertGoogleUser } from '../../functions/orbit-api/auth.ts';
import type { TestDb } from './pglite.ts';

export const BASE = 'https://ref.supabase.co/functions/v1/orbit-api';
export const APP = 'https://princecharming001.github.io/orbit';
export const SECRET = 'c2Vzc2lvbi1zZWNyZXQtcGxhY2Vob2xkZXItMzItYnl0ZXMhIQ==';
export const UNIPILE = 'https://unipile.test';

export interface NetCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** JSON-parsed when it is JSON, the form fields for multipart, else the text */
  body: unknown;
}

export type Answer = (c: NetCall) => Response | Promise<Response> | undefined;

export const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that records every call and answers from the first route that returns something (404 otherwise). */
export function fakeNet(...answers: Answer[]) {
  const calls: NetCall[] = [];
  const routes = [...answers];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    let body: unknown = '';
    if (init.body instanceof FormData) {
      const o: Record<string, string | string[]> = {};
      init.body.forEach((v, k) => {
        const prev = o[k];
        o[k] = prev === undefined ? String(v) : [...(Array.isArray(prev) ? prev : [prev]), String(v)];
      });
      body = o;
    } else if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call = { url, method: (init.method ?? 'GET').toUpperCase(), headers, body };
    calls.push(call);
    for (const a of routes) {
      const r = await a(call);
      if (r) return r;
    }
    return jsonRes(404, { error: 'no fake for this call' });
  }) as typeof fetch;
  return {
    fetch: f,
    calls,
    /** adds a route in front of the others */
    use(a: Answer) {
      routes.unshift(a);
    },
    count: (pred: (c: NetCall) => boolean) => calls.filter(pred).length,
  };
}

// ---- Anthropic -------------------------------------------------------------------------------------------------

export interface AnthropicRequest {
  model: string;
  system: { type: string; text: string; cache_control?: unknown }[];
  messages: { role: string; content: string }[];
  output_config: { effort?: string; format: unknown };
}

export function anthropicMessage(output: unknown, usage: Partial<Record<string, number>> = {}) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: JSON.stringify(output) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 1200,
      output_tokens: 300,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...usage,
    },
  };
}

/** Answers api.anthropic.com with `reply(request)`; the requests are kept for assertions. */
export function anthropic(reply: (req: AnthropicRequest) => unknown) {
  const requests: AnthropicRequest[] = [];
  const answer: Answer = (c) => {
    if (!c.url.startsWith('https://api.anthropic.com/')) return undefined;
    const req = c.body as AnthropicRequest;
    requests.push(req);
    const out = reply(req);
    return jsonRes(200, (out as { type?: string })?.type === 'message' ? out : anthropicMessage(out));
  };
  return { answer, requests };
}

export const userText = (r: AnthropicRequest) => r.messages[0]!.content;
export const systemText = (r: AnthropicRequest) => r.system.map((s) => s.text).join('\n');

// ---- embeddings ------------------------------------------------------------------------------------------------

const STOP = new Set(
  'a an and are as at be by do does for from has have he her his i in is it its me my of on or our she so that the their them they this to us was we what when where which who will with you your like'.split(
    ' ',
  ),
);

const stem = (w: string) => w.replace(/(ing|ed|es|s|ly)$/, '');

/** gte-small's stand-in: hashed, stemmed bag of words, normalized; similar wording gives a high cosine. */
export async function fakeEmbed(text: string): Promise<number[]> {
  const v = new Array<number>(384).fill(0);
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || STOP.has(raw)) continue;
    const w = stem(raw);
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619) >>> 0;
    v[h % 384]! += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

export const fakeTokens = {
  accessToken: async () => 'google-access-placeholder',
  invalidate: () => {},
};

export const ALL_KEYS: AgentEnv = {
  anthropicKey: 'sk-ant-placeholder',
  exaKey: 'exa-placeholder',
  unipileKey: 'unipile-placeholder',
  unipileBase: UNIPILE,
  apolloKey: 'apollo-placeholder',
  semanticScholarKey: 's2-placeholder',
  villageKey: 'sk_village_placeholder',
  villageBase: 'https://api.village.do',
};

export const instant = async () => {};

export function agentConfig(net: ReturnType<typeof fakeNet>, env: AgentEnv = ALL_KEYS): AgentConfig {
  return { env, fetch: net.fetch, embed: fakeEmbed, tokens: fakeTokens, sleep: instant, random: () => 0 };
}

// ---- the API ---------------------------------------------------------------------------------------------------

export function api(
  t: TestDb,
  net: ReturnType<typeof fakeNet>,
  over: Partial<ApiDeps> & { env?: AgentEnv } = {},
) {
  const { env, ...rest } = over;
  const handler = makeApiHandler({
    env: {
      googleClientId: 'client-id-placeholder.apps.googleusercontent.com',
      googleClientSecret: 'client-secret-placeholder',
      googleRedirectUri: `${BASE}/auth/google/callback`,
      sessionSecret: SECRET,
      appUrl: APP,
    },
    db: t.db,
    fetch: net.fetch,
    take: memoryTake(),
    agent: agentConfig(net, env ?? ALL_KEYS),
    ...rest,
  });
  return async <T = Record<string, unknown>>(path: string, token: string, body: unknown = {}) => {
    const r = await handler(
      new Request(`${BASE}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return { status: r.status, body: (await r.json()) as T };
  };
}

let seq = 0;
/** A signed-in user (Google refresh token in the Vault stub, Gmail + Calendar read scopes) and a session token. */
export async function signedInUser(
  t: TestDb,
  over: { scopes?: string[]; settings?: Record<string, unknown>; timezone?: string; firstName?: string } = {},
) {
  seq++;
  const sub = `agent-${seq}-${Math.random()}`;
  const email = `${sub}@example.com`;
  const userId = (await upsertGoogleUser(t.db, {
    sub,
    email,
    name: `${over.firstName ?? 'Sam'} Rivera`,
    givenName: over.firstName ?? 'Sam',
    familyName: 'Rivera',
    scopes: over.scopes ?? [
      'openid',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.readonly',
    ],
    refreshToken: 'refresh-placeholder',
  }))!;
  await t.db.sql`update orbit.users set school = 'Stanford', settings = ${over.settings ?? {}}::jsonb,
                 timezone = ${over.timezone ?? 'America/New_York'} where id = ${userId}::uuid`;
  const tokens = await createSession(t.db, { secret: SECRET }, userId);
  return { userId, token: tokens.accessToken, email };
}

export interface PersonSeed {
  name: string;
  email?: string;
  title?: string;
  org?: string;
  score?: number;
  linkedinUrl?: string;
  memberId?: string;
  timezone?: string;
  doNotContact?: boolean;
  features?: Record<string, number>;
  lastInteractionAt?: string;
}

export async function addPerson(t: TestDb, userId: string, p: PersonSeed): Promise<string> {
  const [first, ...rest] = p.name.split(' ');
  const slug = p.linkedinUrl?.match(/\/in\/([^/?#]+)/)?.[1]?.toLowerCase() ?? null;
  const [row] = await t.db.sql<{ id: string }>`
    insert into orbit.people (user_id, display_name, first_name, last_name, name_norm, primary_email, title, org_raw,
                              linkedin_url, linkedin_slug, linkedin_member_id, timezone, do_not_contact, sources,
                              last_interaction_at)
    values (${userId}::uuid, ${p.name}, ${first}, ${rest.join(' ') || null}, ${p.name.toLowerCase()}, ${p.email ?? null},
            ${p.title ?? null}, ${p.org ?? null}, ${p.linkedinUrl ?? null}, ${slug}, ${p.memberId ?? null},
            ${p.timezone ?? null}, ${p.doNotContact ?? false}, ${['test']}::text[], ${p.lastInteractionAt ?? null}::timestamptz)
    returning id`;
  const id = row!.id;
  if (p.email)
    await t.db.sql`
      insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source)
      values (${userId}::uuid, ${id}::uuid, 'email', ${p.email.toLowerCase()}, ${p.email}, 'test')`;
  if (p.score !== undefined)
    await t.db.sql`
      insert into orbit.tie_scores (user_id, person_id, score, band, features, contributions, explanation, model_version)
      values (${userId}::uuid, ${id}::uuid, ${p.score}::smallint, ${p.score >= 80 ? 'close' : p.score >= 60 ? 'strong' : p.score >= 40 ? 'warm' : p.score >= 20 ? 'light' : 'faint'},
              ${p.features ?? { reciprocity: 0.5 }}::jsonb, ${{ reciprocity: 0.4 }}::jsonb, ${['You email each other']}::text[], 'tie-v1')`;
  return id;
}

export async function addTie(
  t: TestDb,
  userId: string,
  a: string,
  b: string,
  kind: string,
  weight: number,
  confidence: number,
  evidence: Record<string, unknown> = {},
) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  await t.db.sql`
    insert into orbit.ties (user_id, a_person_id, b_person_id, kind, weight, confidence, evidence, last_seen_at)
    values (${userId}::uuid, ${lo}::uuid, ${hi}::uuid, ${kind}, ${weight}::real, ${confidence}::real, ${evidence}::jsonb, now())`;
}

/** A thread with messages; returns the thread id and the message ids in order. */
export async function addThread(
  t: TestDb,
  userId: string,
  personId: string,
  msgs: { direction: 'in' | 'out'; at: string; body: string; replyClass?: string; rfc?: string }[],
  opts: { provider?: 'gmail' | 'linkedin'; externalId?: string; subject?: string } = {},
): Promise<{ threadId: string; externalId: string; messageIds: string[] }> {
  const ext = opts.externalId ?? `thr-${Math.random().toString(36).slice(2)}`;
  const provider = opts.provider ?? 'gmail';
  const last = msgs[msgs.length - 1]!;
  const [th] = await t.db.sql<{ id: string }>`
    insert into orbit.threads (user_id, provider, external_id, subject, participant_person_ids, participant_count,
                               first_at, last_at, message_count, last_direction, is_networking)
    values (${userId}::uuid, ${provider}, ${ext}, ${opts.subject ?? 'Coffee chat'}, ${[personId]}::uuid[], 2,
            ${msgs[0]!.at}::timestamptz, ${last.at}::timestamptz, ${msgs.length}::int, ${last.direction}, true)
    returning id`;
  const ids: string[] = [];
  for (const [i, m] of msgs.entries()) {
    const [row] = await t.db.sql<{ id: string }>`
      insert into orbit.messages (user_id, thread_id, provider, external_id, rfc_message_id, direction, from_person_id,
                                  to_person_ids, sent_at, subject, snippet, body_text, reply_class, reply_confidence,
                                  in_reply_to)
      values (${userId}::uuid, ${th!.id}::uuid, ${provider}, ${`${ext}-m${i}`}, ${m.rfc ?? `<${ext}-m${i}@mail.test>`},
              ${m.direction}, ${m.direction === 'in' ? personId : null}::uuid,
              ${m.direction === 'out' ? [personId] : []}::uuid[], ${m.at}::timestamptz, ${opts.subject ?? 'Coffee chat'},
              ${m.body.slice(0, 100)}, ${m.body}, ${m.replyClass ?? null}, ${m.replyClass ? 0.9 : null}::real,
              ${i > 0 ? `<${ext}-m${i - 1}@mail.test>` : null})
      returning id`;
    ids.push(row!.id);
  }
  return { threadId: th!.id, externalId: ext, messageIds: ids };
}

export const iso = (msAgo: number, from = Date.now()) => new Date(from - msAgo).toISOString();
export const DAY = 86_400_000;
