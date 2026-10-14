/**
 * What the ingestion handlers need from the environment (main.ts wires it; tests pass fakes), and the error a
 * handler throws to end a job as `skipped` rather than failed: a provider that is not configured, an account that
 * is not connected or needs reconnecting. Such jobs are not retried.
 */
import type { Claude } from '../../_shared/claude.ts';
import type { Db } from '../../_shared/db.ts';
import type { TokenSource } from '../../_shared/google.ts';
import { type GoogleClient, googleClient, type QuotaPacer } from '../../_shared/googleApi.ts';

export interface HandlerDeps {
  fetch?: typeof fetch;
  /** Google access tokens; undefined when Orbit's Google client is not configured (Google jobs are skipped) */
  google?: TokenSource;
  /** GMAIL_PUBSUB_TOPIC; without it watch registration is skipped and Orbit relies on the 10-minute poll */
  gmailTopic?: string;
  unipile?: { apiKey?: string; baseUrl?: string };
  claude?: Claude;
  /** milliseconds; pacing and per-job time budgets */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
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
