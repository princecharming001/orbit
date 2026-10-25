/**
 * The `hop_evidence` job (plan 21 §5.3): queued by /paths/find when a person target has LinkedIn mutuals with member
 * ids and no hop evidence from the last 30 days, never run inline (finding paths stays fast). It gathers the evidence
 * of hopEvidence.ts through the student's Unipile account, under the per-account daily read budget kept in
 * orbit.usage_ledger (operation `hop_read`, keyed by `account_id`), and stores what core's `pairEvidenceTies` makes of
 * it in orbit.ties, replacing the earlier rows of the kinds each pair was checked for. A run that finished every step
 * leaves a 30-day marker in orbit.research_cache, which is what "fresh" means to the next /paths/find.
 */
import type { Tie } from '@orbit/core/graph/ties';
import type { Db } from '../db.ts';
import { type TieRow, upsertTies } from '../ingest/ties.ts';
import { cacheKey } from '../providers/request';
import { type Bucket, sqlTake } from '../ratelimit.ts';
import { sqlCache } from '../research/bind.ts';
import type { CacheDep } from '../research/deps';
import type { Services } from '../services.ts';
import {
  gatherHopEvidence,
  HOP_CACHE_MS,
  HOP_READ_OPERATION,
  HOP_READS_PER_DAY,
  type HopBudget,
  type HopEvidenceResult,
  type HopLedger,
  type HopRef,
} from './hopEvidence';

export const HOP_EVIDENCE_JOB = 'hop_evidence';
/** how many mutuals a job is told about (it reads the first five, matches the rest from the cache) */
export const HOP_JOB_MUTUALS = 25;
/** the jittered gap between two LinkedIn reads */
export const HOP_PACE_MS: [number, number] = [400, 1500];

const dayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/**
 * The account's shared LinkedIn ledgers (plan 21 §6), as orbit-connectors keeps them in public.orbit_proxy_counters
 * (`ledgerBucket` in orbit-connectors/connectors.ts; the key format must stay the same, a test checks it): the browser
 * and this job spend from one count per Unipile account and day, so neither can read past it.
 */
export const SHARED_LEDGER_PER_DAY: Record<HopLedger, number> = { profile: 100, posts: 100 };

export function sharedLedgerBucket(kind: HopLedger, accountId: string, now: Date, limit: number): Bucket {
  const day = now.toISOString().slice(0, 10);
  const end = new Date(`${day}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return { key: `connectors:li:${kind}:${day}:${accountId}`, limit, expires: end.toISOString() };
}

/**
 * The job's budget over the database: at most `limit` hop reads per Unipile account per UTC day (orbit.usage_ledger,
 * operation `hop_read`, keyed by `account_id`), and every read also taken from the account's shared LinkedIn ledger
 * (peeked first, so a refused read never adds to the count the browser shares). A read taken is recorded at once.
 */
export function sqlHopBudget(
  db: Db,
  now: () => Date,
  opts: { limit?: number; shared?: Record<HopLedger, number> } = {},
): HopBudget {
  const limit = opts.limit ?? HOP_READS_PER_DAY;
  const shared = opts.shared ?? SHARED_LEDGER_PER_DAY;
  const take = sqlTake(db);
  return {
    async take(accountId, userId, ledger) {
      const t = now();
      const [r] = await db.sql<{ n: number }>`
        select coalesce(sum(units), 0)::int as n from orbit.usage_ledger
         where account_id = ${accountId} and provider = 'unipile' and operation = ${HOP_READ_OPERATION}
           and created_at >= ${dayStart(t)}::timestamptz`;
      if ((r?.n ?? 0) >= limit) return false;
      const b = sharedLedgerBucket(ledger, accountId, t, shared[ledger]);
      const [used] = await db.sql<{ count: number }>`
        select count from public.orbit_proxy_counters where bucket = ${b.key} and expires_at >= ${t}::timestamptz`;
      if ((used?.count ?? 0) >= b.limit) return false;
      if (!(await take([b])).allowed) return false;
      await db.sql`
        insert into orbit.usage_ledger (user_id, provider, operation, units, cost_usd, account_id, created_at)
        values (${userId}::uuid, 'unipile', ${HOP_READ_OPERATION}, 1, 0, ${accountId}, ${t}::timestamptz)`;
      return true;
    },
  };
}

const doneKey = (accountId: string, memberId: string) =>
  cacheKey('unipile', { op: 'hop_done', accountId, memberId });

/** Whether a target's hop evidence was fully gathered in the last 30 days. */
export async function hopEvidenceFresh(
  cache: CacheDep,
  userId: string,
  accountId: string,
  memberId: string,
): Promise<boolean> {
  return (await cache.get(userId, await doneKey(accountId, memberId))) !== undefined;
}

/** The user's active LinkedIn account id at Unipile, if any. */
export async function linkedinAccountOf(db: Db, userId: string): Promise<string | undefined> {
  const [a] = await db.sql<{ external_account_id: string | null }>`
    select external_account_id from orbit.integration_accounts
     where user_id = ${userId}::uuid and provider = 'linkedin' and status = 'active'`;
  return a?.external_account_id ?? undefined;
}

/** Queue a target's hop evidence (at most one run per target a day: the queue's 24-hour dedupe). */
export async function enqueueHopEvidence(
  s: Pick<Services, 'queue'>,
  userId: string,
  targetPersonId: string,
  mutualPersonIds: string[],
): Promise<boolean> {
  const id = await s.queue.enqueue({
    kind: HOP_EVIDENCE_JOB,
    userId,
    payload: { targetPersonId, mutualPersonIds: mutualPersonIds.slice(0, HOP_JOB_MUTUALS) },
    dedupeKey: `${HOP_EVIDENCE_JOB}:${userId}:${targetPersonId}`,
  });
  return id !== null;
}

const tieRow = (t: Tie): TieRow => ({
  a: t.aId,
  b: t.bId,
  kind: t.kind,
  weight: t.weight,
  confidence: t.confidence,
  evidence: t.evidence,
  firstSeenAt: t.firstSeenAt,
  lastSeenAt: t.lastSeenAt,
});

/**
 * Store a gathering's ties. For each pair and kind it was checked for, the new row replaces the old one and an old row
 * with no new evidence is deleted (and the deletion recorded for /sync/pull); evidence of a kind a pair was not fully
 * checked for is only added where the pair has no row of that kind yet, so a partial read never weakens a full one.
 */
export async function storeHopEvidence(
  db: Db,
  userId: string,
  r: Pick<HopEvidenceResult, 'ties' | 'checked'>,
  now: Date,
): Promise<{ upserted: number; added: number; deleted: number }> {
  const checked = new Map(r.checked.map((c) => [`${c.aId}|${c.bId}`, new Set<string>(c.kinds)]));
  const replace: Tie[] = [];
  const add: Tie[] = [];
  for (const t of r.ties) (checked.get(`${t.aId}|${t.bId}`)?.has(t.kind) ? replace : add).push(t);
  await upsertTies(db, userId, replace.map(tieRow), now);
  let added = 0;
  for (const t of add) {
    const rows = await db.sql`
      insert into orbit.ties (user_id, a_person_id, b_person_id, kind, weight, confidence, evidence, first_seen_at,
                              last_seen_at)
      values (${userId}::uuid, ${t.aId}::uuid, ${t.bId}::uuid, ${t.kind}, ${t.weight}::real, ${t.confidence}::real,
              ${t.evidence}::jsonb, coalesce(${t.firstSeenAt ?? null}::timestamptz, ${now}::timestamptz),
              coalesce(${t.lastSeenAt ?? null}::timestamptz, ${now}::timestamptz))
      on conflict (user_id, a_person_id, b_person_id, kind) do nothing
      returning 1`;
    added += rows.length;
  }
  let deleted = 0;
  for (const c of r.checked) {
    const keep = replace.filter((t) => t.aId === c.aId && t.bId === c.bId).map((t) => t.kind);
    deleted += await deleteTies(db, userId, c.aId, c.bId, c.kinds, keep);
  }
  return { upserted: replace.length, added, deleted };
}

/** Delete a pair's rows of these kinds (except `keep`), recording each for /sync/pull. */
export async function deleteTies(
  db: Db,
  userId: string,
  aId: string,
  bId: string,
  kinds: readonly string[],
  keep: readonly string[] = [],
  by: { actor: 'user' | 'system'; reason: string } = { actor: 'system', reason: 'hop_evidence' },
): Promise<number> {
  const [lo, hi] = aId < bId ? [aId, bId] : [bId, aId];
  const gone = await db.sql<{ id: string }>`
    delete from orbit.ties
     where user_id = ${userId}::uuid and a_person_id = ${lo}::uuid and b_person_id = ${hi}::uuid
       and kind = any(${[...kinds]}::text[]) and not (kind = any(${[...keep]}::text[]))
    returning id`;
  for (const g of gone)
    await db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${userId}::uuid, ${by.actor}, 'sync.delete', 'ties', ${g.id}, ${{ reason: by.reason }}::jsonb)`;
  return gone.length;
}

export type HopJobOutcome =
  | { status: 'skipped'; reason: string }
  | {
      status: 'ok';
      reads: number;
      cached: number;
      ties: number;
      deleted: number;
      complete: boolean;
      stoppedBy?: 'budget';
      errors: string[];
    };

/**
 * Run one `hop_evidence` job: the target and mutuals are re-read from orbit.people (member ids as stored now, never
 * from the payload), the evidence gathered and stored, the target's follower and connection counts kept on the person.
 */
export async function runHopEvidenceJob(
  s: Services,
  userId: string,
  payload: Record<string, unknown>,
): Promise<HopJobOutcome> {
  const targetId = typeof payload.targetPersonId === 'string' ? payload.targetPersonId : '';
  const mutualIds = Array.isArray(payload.mutualPersonIds)
    ? payload.mutualPersonIds.filter((x): x is string => typeof x === 'string').slice(0, HOP_JOB_MUTUALS)
    : [];
  if (!/^[0-9a-f-]{36}$/i.test(targetId)) return { status: 'skipped', reason: 'no target' };
  if (!s.unipile.configured) return { status: 'skipped', reason: 'unconfigured' };
  const accountId = await linkedinAccountOf(s.db, userId);
  if (!accountId) return { status: 'skipped', reason: 'LinkedIn not connected' };
  const ids = [targetId, ...mutualIds.filter((x) => /^[0-9a-f-]{36}$/i.test(x))];
  const rows = await s.db.sql<{
    id: string;
    linkedin_member_id: string | null;
    linkedin_follower_count: number | null;
  }>`
    select id, linkedin_member_id, linkedin_follower_count from orbit.people
     where user_id = ${userId}::uuid and id = any(${ids}::uuid[]) and deleted_at is null and merged_into is null
       and not is_self`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const t = byId.get(targetId);
  if (!t?.linkedin_member_id) return { status: 'skipped', reason: "the target's member id is unknown" };
  const mutuals: HopRef[] = [];
  for (const id of mutualIds) {
    const m = byId.get(id);
    if (m?.linkedin_member_id && id !== targetId)
      mutuals.push({ personId: id, memberId: m.linkedin_member_id });
  }
  if (!mutuals.length) return { status: 'skipped', reason: 'no mutual with a member id' };
  const followers: Record<string, number> = {};
  for (const r of rows)
    if (typeof r.linkedin_follower_count === 'number') followers[r.id] = r.linkedin_follower_count;

  const cache = sqlCache(s.db, s.now);
  const [lo, hi] = HOP_PACE_MS;
  const r = await gatherHopEvidence(
    {
      unipile: s.unipile,
      cache,
      budget: sqlHopBudget(s.db, s.now),
      clock: () => s.now().getTime(),
      pace: () => s.sleep(lo + Math.floor(s.random() * (hi - lo))),
    },
    {
      userId,
      unipileAccountId: accountId,
      target: { personId: targetId, memberId: t.linkedin_member_id },
      mutuals,
      followers,
    },
  );
  const now = s.now();
  const stored = await storeHopEvidence(s.db, userId, r, now);
  if (r.target.followers !== undefined || r.target.connections !== undefined)
    await s.db.sql`
      update orbit.people set
        linkedin_follower_count = coalesce(${r.target.followers ?? null}::int, linkedin_follower_count),
        linkedin_connections_count = coalesce(${r.target.connections ?? null}::int, linkedin_connections_count)
       where id = ${targetId}::uuid and user_id = ${userId}::uuid`;
  if (r.complete)
    await cache.put(userId, {
      key: await doneKey(accountId, t.linkedin_member_id),
      provider: 'unipile',
      response: { at: now.toISOString(), reads: r.reads },
      expiresAt: new Date(now.getTime() + HOP_CACHE_MS),
    });
  return {
    status: 'ok',
    reads: r.reads,
    cached: r.cached,
    ties: r.ties.length,
    deleted: stored.deleted,
    complete: r.complete,
    ...(r.stoppedBy ? { stoppedBy: r.stoppedBy } : {}),
    errors: r.errors,
  };
}
