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
import { createSemanticScholar, type SemanticScholar } from './providers/semanticScholar';
import { createUnipileResearch, type UnipileResearch } from './providers/unipileResearch';
import { createVillage, type Village } from './providers/village';
import { type Queue, sqlQueue } from './queue.ts';
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
  /** SEMANTIC_SCHOLAR_API_KEY; optional, the public rate limit applies without it */
  semanticScholarKey?: string;
  /** VILLAGE_SECRET_KEY + VILLAGE_BASE_URL (defaults to https://api.village.do) */
  villageKey?: string;
  villageBase?: string;
  /** Orbit's Google OAuth client, for Gmail sends, free/busy and event creation */
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri?: string;
}

/** gte-small sentence embedding (384 dims, mean-pooled, normalized), or null when the model is not available. */
export type Embed = (text: string) => Promise<number[] | null>;

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
}

export interface Services {
  db: Db;
  queue: Queue;
  now: () => Date;
  fetch: typeof fetch;
  random: () => number;
  env: AgentEnv;
  claude: Claude;
  exa: Exa;
  unipile: UnipileResearch;
  apollo: Apollo;
  semanticScholar: SemanticScholar;
  village: Village;
  embed: Embed;
  /** undefined when Orbit's Google client is not configured */
  google?: GoogleConfig;
  tokens?: TokenSource;
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
    env,
    claude: makeClaude({
      apiKey: env.anthropicKey,
      db: base.db,
      fetch: cfg.fetch,
      now,
      client: cfg.anthropic,
    }),
    exa: createExa({ ...p, apiKey: env.exaKey }),
    unipile: createUnipileResearch({ ...p, apiKey: env.unipileKey, baseUrl: env.unipileBase }),
    apollo: createApollo({ ...p, apiKey: env.apolloKey }),
    semanticScholar: createSemanticScholar({ ...p, apiKey: env.semanticScholarKey, anonymous: true }),
    village: villageFor(cfg, () =>
      createVillage({ ...p, secretKey: env.villageKey, baseUrl: env.villageBase }),
    ),
    embed: cfg.embed ?? supabaseEmbed(),
    google,
    tokens,
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

/** The agent env from a function's environment (`Deno.env.get`). */
export function agentEnvFrom(get: (name: string) => string | undefined): AgentEnv {
  const supabaseUrl = get('SUPABASE_URL');
  return {
    anthropicKey: get('ORBIT_ANTHROPIC_API_KEY') ?? get('ANTHROPIC_API_KEY'),
    exaKey: get('EXA_API_KEY'),
    unipileKey: get('UNIPILE_API_KEY'),
    unipileBase: get('UNIPILE_BASE_URL'),
    apolloKey: get('APOLLO_API_KEY'),
    semanticScholarKey: get('SEMANTIC_SCHOLAR_API_KEY'),
    villageKey: get('VILLAGE_SECRET_KEY'),
    villageBase: get('VILLAGE_BASE_URL'),
    googleClientId: get('ORBIT_GOOGLE_CLIENT_ID'),
    googleClientSecret: get('ORBIT_GOOGLE_CLIENT_SECRET'),
    googleRedirectUri:
      get('ORBIT_GOOGLE_REDIRECT_URI') ??
      (supabaseUrl ? `${supabaseUrl}/functions/v1/orbit-api/auth/google/callback` : undefined),
  };
}
