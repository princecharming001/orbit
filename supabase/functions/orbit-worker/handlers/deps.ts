/**
 * What the ingestion handlers need from the environment (main.ts wires it; tests pass fakes), and the error a
 * handler throws to end a job as `skipped` rather than failed: a provider that is not configured, an account that
 * is not connected or needs reconnecting. Such jobs are not retried.
 */
import type { Claude } from '../../_shared/claude.ts';
import type { Db } from '../../_shared/db.ts';
import type { TokenSource } from '../../_shared/google.ts';
import { type GoogleClient, googleClient, type QuotaPacer } from '../../_shared/googleApi.ts';
import type { Embed } from '../../_shared/services.ts';
import type { CostDigestDeps } from './cost.ts';
import type { XWorkerDeps } from './x.ts';

export interface HandlerDeps {
  fetch?: typeof fetch;
  /** Google access tokens; undefined when Orbit's Google client is not configured (Google jobs are skipped) */
  google?: TokenSource;
  /** GMAIL_PUBSUB_TOPIC; without it watch registration is skipped and Orbit relies on the 10-minute poll */
  gmailTopic?: string;
  unipile?: { apiKey?: string; baseUrl?: string };
  /** Supabase Storage for the shared company logos (SUPABASE_URL, the service role key): logos.sweep needs it */
  storage?: { url?: string; serviceKey?: string };
  claude?: Claude;
  /** milliseconds; pacing and per-job time budgets */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** how long a paged sync job works before it saves its place and queues the rest (default 60 s) */
  jobBudgetMs?: number;
  /** gte-small for the student's sent mail (plan 29 §B2.4a); the Edge Runtime's own model when not given */
  embed?: Embed;
  /** the daily cost digest's mailer, owner and thresholds (plan 34 E2) */
  cost?: CostDigestDeps;
  /** parking idle LinkedIn links (plan 35 E5): ORBIT_LINKEDIN_PARK_DAYS as days (0 is off), and links a night */
  park?: { days?: number; perRun?: number };
  /** X's settings and the DM writer (plan 43 §5); X jobs are skipped without them */
  x?: XWorkerDeps;
}

export class JobSkipped extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'JobSkipped';
  }
}

/** One Google client per handler set; pacers are kept per user across jobs. */
export function googleFor(deps: HandlerDeps): (db: Db) => GoogleClient {
  const pacers = new Map<string, QuotaPacer>();
  return (db) => {
    if (!deps.google) throw new JobSkipped('unconfigured');
    return googleClient({
      tokens: deps.google,
      db,
      fetch: deps.fetch,
      clock: deps.clock,
      sleep: deps.sleep,
      random: deps.random,
      pacers,
    });
  };
}

/** Long sync jobs take the message for up to 5 minutes so a second worker never runs the same page. */
export const LONG_VT_SEC = 300;
