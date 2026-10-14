/** Shared set-up for the ingestion tests: a connected user, fake Google tokens, and a worker loop on virtual time. */
import type { Db } from '../../functions/_shared/db.ts';
import type { TokenSource } from '../../functions/_shared/google.ts';
import type { JobHandler, TickSummary } from '../../functions/orbit-worker/worker.ts';
import { runTick } from '../../functions/orbit-worker/worker.ts';
import { makeUser, type TestDb } from './pglite.ts';

export const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
];

/** A user with a connected Google account (and, optionally, a LinkedIn account id). */
export async function connectedUser(
  db: Db,
  o: { email?: string; linkedinAccount?: string; scopes?: string[] } = {},
): Promise<string> {
  const email = o.email ?? `maya.${Math.random().toString(36).slice(2, 8)}@example.com`;
  const u = await makeUser(db, { email });
  await db.sql`
    update orbit.users set full_name = 'Maya Chen', first_name = 'Maya', last_name = 'Chen',
           school = 'State University', current_city = 'New York, NY'
     where id = ${u}::uuid`;
  await db.sql`
    insert into orbit.integration_accounts (user_id, provider, email, scopes, status)
    values (${u}::uuid, 'google', ${email}, ${o.scopes ?? SCOPES}::text[], 'active')`;
  if (o.linkedinAccount)
    await db.sql`
      insert into orbit.integration_accounts (user_id, provider, external_account_id, status)
      values (${u}::uuid, 'linkedin', ${o.linkedinAccount}, 'active')`;
  return u;
}

export function fakeTokens(): TokenSource & { invalidated: number; minted: number } {
  const t = {
    invalidated: 0,
    minted: 0,
    async accessToken() {
      t.minted++;
      return `access-${t.minted}`;
    },
    invalidate() {
      t.invalidated++;
    },
  };
  return t;
}

const QUEUES = ['orbit_send', 'orbit_classify', 'orbit_sync', 'orbit_cadence', 'orbit_score', 'orbit_enrich'];

/** Makes every queued message visible now (delays and backoffs are real time in the pgmq stub). */
export async function releaseAll(t: TestDb) {
  for (const q of QUEUES)
    await t.pg.exec(`update pgmq.q_${q} set vt = clock_timestamp() - interval '1 second'`);
}

/** Runs worker ticks until nothing is left (or `maxTicks`), releasing delayed messages between ticks. */
export async function drain(
  t: TestDb,
  handlers: Record<string, JobHandler>,
  now: () => Date,
  o: { maxTicks?: number; onTick?: (s: TickSummary) => void | Promise<void> } = {},
): Promise<TickSummary[]> {
  const out: TickSummary[] = [];
  for (let i = 0; i < (o.maxTicks ?? 100); i++) {
    await releaseAll(t);
    const s = await runTick({ db: t.db, handlers, now, budgetMs: 600_000 });
    out.push(s);
    await o.onTick?.(s);
    if (!s.processed) break;
  }
  return out;
}

export async function clearQueues(t: TestDb) {
  for (const q of QUEUES) await t.pg.exec(`delete from pgmq.q_${q}; delete from pgmq.a_${q};`);
  await t.pg.exec('delete from orbit.job_runs; delete from orbit.dead_letters;');
}

export const jobRuns = (db: Db, userId?: string) =>
  db.sql<{ kind: string; status: string; error: string | null }>`
    select kind, status, error from orbit.job_runs
     where ${userId ?? null}::uuid is null or user_id = ${userId ?? null}::uuid order by id`;
