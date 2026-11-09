/**
 * What the agent features (research, sourcing, paths, compose, replies, calendar, sending, memory, cadence) need from
 * the outside world, built once per request or job from the environment: Claude through claude.ts, the provider
 * adapters, Google tokens for Gmail and Calendar, the embedding model and the queue. Every piece degrades to
 * "unconfigured" when its key is missing, and tests inject fakes through `AgentConfig` (fetch, embed, clock).
 */

import type Anthropic from '@anthropic-ai/sdk';
import { type Claude, makeClaude } from './claude.ts';
import type { Db } from './db.ts';
import { type GoogleConfig, googleTokenSource, type TokenSource } from './google.ts';
import { type Apollo, createApollo } from './providers/apollo';
import { createExa, type Exa } from './providers/exa';
import { createHunter, type Hunter } from './providers/hunter';
import { defaultSleep } from './providers/request';
import { createSemanticScholar, type SemanticScholar } from './providers/semanticScholar';
import { createUnipileResearch, type UnipileResearch } from './providers/unipileResearch';
import { createVillage, type Village } from './providers/village';
import { type Queue, sqlQueue } from './queue.ts';
import type { WebSource } from './research/web';
import { switchGate } from './switches.ts';
import { sqlVault } from './vault.ts';

export interface AgentEnv {
  /** ORBIT_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) */
  anthropicKey?: string;
  /** EXA_API_KEY */
  exaKey?: string;
  /** UNIPILE_API_KEY + UNIPILE_BASE_URL (the account's DSN, e.g. https://api9.unipile.com:13999) */
  unipileKey?: string;
  unipileBase?: string;
  /** APOLLO_API_KEY */
  apolloKey?: string;
  /** HUNTER_API_KEY: finds and verifies work emails for people found outside the student's inbox */
  hunterKey?: string;
  /** SEMANTIC_SCHOLAR_API_KEY; optional, the public rate limit applies without it */
  semanticScholarKey?: string;
  /** VILLAGE_SECRET_KEY + VILLAGE_BASE_URL (defaults to https://api.village.do) */
  villageKey?: string;
  villageBase?: string;
  /** Orbit's Google OAuth client, for Gmail sends, free/busy and event creation */
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri?: string;
  /** RESEND_API_KEY (+ RESEND_FROM): the transactional mailer plan 10 §1 names; unset, nothing is mailed */
  resendKey?: string;
  resendFrom?: string;
  /** SERPER_API_KEY, PARALLEL_API_KEY: cheaper web searches for sourcing than Claude's web search (plan 34 B5) */
  serperKey?: string;
  parallelKey?: string;
}

/** gte-small sentence embedding (384 dims, mean-pooled, normalized), or null when the model is not available. */
export type Embed = (text: string) => Promise<number[] | null>;

/** One transactional email to the student's own address (plan 29 §B2.6); never to anyone else, never a reply's text. */
export interface MailerMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  /** false when no mailer is configured (the message is dropped, never queued) */
  configured: boolean;
  send(m: MailerMessage): Promise<{ ok: true; id: string | null } | { ok: false; error: string }>;
}

export const RESEND_URL = 'https://api.resend.com/emails';
export const DEFAULT_MAIL_FROM = 'Orbit <orbit@tryorbit.today>';

/** Resend when RESEND_API_KEY is set; otherwise a mailer that says so and sends nothing. */
export function makeMailer(env: AgentEnv, doFetch: typeof fetch): Mailer {
  const key = env.resendKey;
  if (!key) return { configured: false, send: async () => ({ ok: false, error: 'unconfigured' }) };
  return {
    configured: true,
    async send(m) {
      const res = await doFetch(RESEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: env.resendFrom || DEFAULT_MAIL_FROM,
          to: [m.to],
          subject: m.subject,
          text: m.text,
        }),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, error: `resend ${res.status}` };
      }
      const json = (await res.json().catch(() => ({}))) as { id?: string };
      return { ok: true, id: typeof json.id === 'string' ? json.id : null };
    },
  };
}

export interface AgentConfig {
  env: AgentEnv;
  fetch?: typeof fetch;
  embed?: Embed;
  /** waits between provider retries (tests pass an instant one) */
  sleep?: (ms: number) => Promise<void>;
  /** jitter source in [0, 1) */
  random?: () => number;
  /** a prepared Google token source (tests) */
  tokens?: TokenSource;
  /** a prepared Anthropic client (tests) */
  anthropic?: Anthropic;
  /** the public web for sourcing (tests hand in a fake; plan 31) */
  web?: WebSource[];
}

export interface Services {
  db: Db;
  queue: Queue;
  now: () => Date;
  fetch: typeof fetch;
  random: () => number;
  /** waits (pacing between provider reads; tests pass an instant one) */
  sleep: (ms: number) => Promise<void>;
  env: AgentEnv;
  claude: Claude;
  exa: Exa;
  unipile: UnipileResearch;
  apollo: Apollo;
  hunter: Hunter;
  semanticScholar: SemanticScholar;
  village: Village;
  embed: Embed;
  /** the student's own mailbox (plan 29 §B2.6): a no-op until RESEND_API_KEY is set */
  mailer: Mailer;
  /** undefined when Orbit's Google client is not configured */
  google?: GoogleConfig;
  tokens?: TokenSource;
  /** a prepared Anthropic client (tests), for the web sourcing chain */
  anthropic?: Anthropic;
  /** web sources handed in (tests); otherwise built from the keys */
  web?: WebSource[];
}

interface SupabaseAi {
  ai?: { Session: new (model: string) => { run(text: string, opts: object): Promise<unknown> } };
}

/** The Edge Runtime's built-in gte-small (`Supabase.ai.Session`); null outside the runtime. */
export function supabaseEmbed(): Embed {
  let session: { run(text: string, opts: object): Promise<unknown> } | undefined;
  return async (text) => {
    const S = (globalThis as { Supabase?: SupabaseAi }).Supabase;
    if (!S?.ai) return null;
    session ??= new S.ai.Session('gte-small');
    const out = await session.run(text, { mean_pool: true, normalize: true });
    if (!out || typeof (out as ArrayLike<number>).length !== 'number') return null;
    return Array.from(out as ArrayLike<number>, Number);
  };
}

/** Google OAuth config from the agent env, or undefined when any part is missing. */
export function googleConfigOf(
  env: AgentEnv,
  doFetch?: typeof fetch,
  now?: () => Date,
): GoogleConfig | undefined {
  if (!env.googleClientId || !env.googleClientSecret || !env.googleRedirectUri) return undefined;
  return {
    clientId: env.googleClientId,
    clientSecret: env.googleClientSecret,
    redirectUri: env.googleRedirectUri,
    fetch: doFetch,
    now,
  };
}

// token sources cache access tokens per user and Village caches its bearer token for 50 minutes: keep one of each
// per config for the life of the function instance
const tokenSources = new WeakMap<object, TokenSource>();
const villages = new WeakMap<object, Village>();

export function makeServices(cfg: AgentConfig, base: { db: Db; now?: () => Date; queue?: Queue }): Services {
  const now = base.now ?? (() => new Date());
  const doFetch = cfg.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const p = { fetch: doFetch, sleep: cfg.sleep, random: cfg.random, clock: () => now().getTime() };
  // each paid provider answers budget_exceeded (reason 'off') while its switch is off (switches.ts, plan 34 A5)
  const gate = (name: Parameters<typeof switchGate>[1]) => switchGate(base.db, name);
  const env = cfg.env;
  const google = googleConfigOf(env, doFetch, now);
  let tokens = cfg.tokens;
  if (!tokens && google) {
    tokens = tokenSources.get(cfg) ?? googleTokenSource(google, { db: base.db, vault: sqlVault(base.db) });
    tokenSources.set(cfg, tokens);
  }
  return {
    db: base.db,
    queue: base.queue ?? sqlQueue(base.db),
    now,
    fetch: doFetch,
    random: cfg.random ?? Math.random,
    sleep: cfg.sleep ?? defaultSleep,
    env,
    claude: makeClaude({
      apiKey: env.anthropicKey,
      db: base.db,
      fetch: cfg.fetch,
      now,
      client: cfg.anthropic,
      enabled: gate('anthropic'),
    }),
    exa: createExa({ ...p, apiKey: env.exaKey, gate: gate('exa') }),
    unipile: createUnipileResearch({
      ...p,
      apiKey: env.unipileKey,
      baseUrl: env.unipileBase,
      gate: gate('unipile_reads'),
    }),
    apollo: createApollo({ ...p, apiKey: env.apolloKey, gate: gate('apollo') }),
    hunter: createHunter({ ...p, apiKey: env.hunterKey, gate: gate('hunter') }),
    semanticScholar: createSemanticScholar({ ...p, apiKey: env.semanticScholarKey, anonymous: true }),
    village: villageFor(cfg, () =>
      createVillage({ ...p, secretKey: env.villageKey, baseUrl: env.villageBase, gate: gate('village') }),
    ),
    embed: cfg.embed ?? supabaseEmbed(),
    mailer: makeMailer(env, doFetch),
    google,
    tokens,
    anthropic: cfg.anthropic,
    web: cfg.web,
  };
}

function villageFor(cfg: AgentConfig, make: () => Village): Village {
  let v = villages.get(cfg);
  if (!v) {
    v = make();
    villages.set(cfg, v);
  }
  return v;
}

/** The secrets the agent env reads, by name. */
export const AGENT_SECRET_NAMES = [
  'ORBIT_ANTHROPIC_API_KEY',
  'EXA_API_KEY',
  'UNIPILE_API_KEY',
  'UNIPILE_BASE_URL',
  'APOLLO_API_KEY',
  'HUNTER_API_KEY',
  'SEMANTIC_SCHOLAR_API_KEY',
  'VILLAGE_SECRET_KEY',
  'VILLAGE_BASE_URL',
  'RESEND_API_KEY',
  'RESEND_FROM',
  'SERPER_API_KEY',
  'PARALLEL_API_KEY',
] as const;

/**
 * The agent env with each key taken from the function's environment when set, else from the copy kept in
 * orbit_private.secrets (public.orbit_secret, service role only), read in one round trip. Without this, a key stored
 * once for every function (Orbit's Claude key is) left research, sourcing's web search and drafting unconfigured.
 */
export async function agentEnvWithSecrets(
  get: (name: string) => string | undefined,
  db: Db | undefined,
): Promise<AgentEnv> {
  const stored = new Map<string, string>();
  const missing = AGENT_SECRET_NAMES.filter((n) => !get(n));
  if (db && missing.length) {
    try {
      const rows = await db.sql<{ n: string; v: string | null }>`
        select n, public.orbit_secret(n) as v from unnest(${missing as unknown as string[]}::text[]) as n`;
      for (const r of rows) if (r.v) stored.set(r.n, r.v);
    } catch {
      // no orbit_secret here: the env alone, as before
    }
  }
  return agentEnvFrom((name) => get(name) || stored.get(name));
}

/** The agent env from a function's environment (`Deno.env.get`). */
export function agentEnvFrom(get: (name: string) => string | undefined): AgentEnv {
  const supabaseUrl = get('SUPABASE_URL');
  return {
    anthropicKey: get('ORBIT_ANTHROPIC_API_KEY') ?? get('ANTHROPIC_API_KEY'),
    exaKey: get('EXA_API_KEY'),
    unipileKey: get('UNIPILE_API_KEY'),
    unipileBase: get('UNIPILE_BASE_URL'),
    apolloKey: get('APOLLO_API_KEY'),
    hunterKey: get('HUNTER_API_KEY'),
    semanticScholarKey: get('SEMANTIC_SCHOLAR_API_KEY'),
    villageKey: get('VILLAGE_SECRET_KEY'),
    villageBase: get('VILLAGE_BASE_URL'),
    googleClientId: get('ORBIT_GOOGLE_CLIENT_ID'),
    googleClientSecret: get('ORBIT_GOOGLE_CLIENT_SECRET'),
    googleRedirectUri:
      get('ORBIT_GOOGLE_REDIRECT_URI') ??
      (supabaseUrl ? `${supabaseUrl}/functions/v1/orbit-api/auth/google/callback` : undefined),
    resendKey: get('RESEND_API_KEY'),
    resendFrom: get('RESEND_FROM'),
    serperKey: get('SERPER_API_KEY'),
    parallelKey: get('PARALLEL_API_KEY'),
  };
}
