/**
 * Plan 35 phase E, the LinkedIn line. Unipile bills on the peak number of accounts linked at the same time in each
 * 30-day period, and the Unipile key is shared with another product (Osmo), so Orbit acts only on accounts it holds
 * in orbit.integration_accounts.
 *
 * unipile.reconcile (E1, cron orbit-unipile-reconcile, 07:30 UTC, one job for everyone): lists every account on the
 * key (read only, never deletes) and writes one orbit.audit_log row, action `unipile.reconcile`, with:
 *   - Orbit's linked accounts (in integration_accounts and at Unipile), and Orbit rows Unipile no longer has;
 *   - `orbitOrphans`: LinkedIn accounts not in integration_accounts that Orbit made. An account is Orbit's when its
 *     `name` is what Orbit's hosted sign-ins name it: the Orbit user id (orbit-api /linkedin/connect/start) or an
 *     `orbit_<uuid>` reference (orbit-connectors /connect/start), or its id is in public.orbit_unipile_links (the
 *     notify_url record of a sign-in Orbit started);
 *   - `notOrbit`: every other account (Osmo's, and every non-LinkedIn account), counted by type, LinkedIn ids listed.
 *     A LinkedIn one whose name is a UUID that is no Orbit user carries hint `uuid_name`, for a human to look at.
 * Names are never stored, only how an account was recognised. The cost digest and orbit.health() read the newest row.
 *
 * linkedin.park (E5, cron orbit-linkedin-park, 07:10 UTC, one job for everyone): with ORBIT_LINKEDIN_PARK_DAYS above 0
 * (default 21), a student whose LinkedIn is active and who has not opened Orbit in that many days, has no send
 * approved, scheduled or going out, no needs-you card open, no LinkedIn reply arrived in that time, autopilot off,
 * and at least one finished LinkedIn pass, has their Unipile account unlinked (DELETE, after checking the account is a
 * LinkedIn one Orbit named). The integration row stays, with status `parked`, external_account_id cleared (so the
 * poll, webhooks, sends, research and status all pass it over), every synced row kept, and
 * sync_state.linkedin.parked = {at, accountId, since}: `since` is the end of the last finished pass, the point the
 * reconnect resumes from (orbit-webhooks unipileAccount). At most PARK_PER_RUN a night.
 */
import { isUuid } from '../../_shared/crypto.ts';
import type { Db } from '../../_shared/db.ts';
import { iso } from '../../_shared/ingest/util.ts';
import type { ProviderOptions } from '../../_shared/providers/request.ts';
import {
  deleteUnipileAccount,
  getUnipileAccount,
  listUnipileAccounts,
  type UnipileAccountRow,
} from '../../_shared/providers/unipileAccounts.ts';
import type { JobHandler } from '../worker.ts';
import { type HandlerDeps, JobSkipped } from './deps.ts';

/** Days away before a link is parked when ORBIT_LINKEDIN_PARK_DAYS is not set; 0 turns parking off. */
export const DEFAULT_PARK_DAYS = 21;
/** Links parked in one night at most (two Unipile calls each). */
export const PARK_PER_RUN = 25;
/** The reference orbit-connectors' /connect/start names a hosted sign-in with. */
const ORBIT_REF = /^orbit_[A-Za-z0-9-]{4,64}$/;

/** ORBIT_LINKEDIN_PARK_DAYS as days: unset or unreadable is the default, 0 (or less) is off. */
export function parkDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PARK_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_PARK_DAYS;
  return n <= 0 ? 0 : Math.floor(n);
}

export interface ReconcileReport {
  total: number;
  byType: Record<string, number>;
  /** Orbit's accounts that Unipile holds (each one is billed) */
  orbitLinked: number;
  /** Orbit rows that name an account Unipile no longer has */
  missingAtUnipile: string[];
  orbitOrphans: {
    id: string;
    createdAt: string | null;
    status: string | null;
    reason: 'user_id' | 'orbit_ref' | 'link_record';
    userId?: string;
  }[];
  notOrbit: { count: number; linkedin: { id: string; createdAt: string | null; hint?: 'uuid_name' }[] };
  orbitOrphanCount: number;
}

const created = (v: unknown) => (v == null ? null : (iso(typeof v === 'number' ? new Date(v) : v) ?? null));
const sourceStatus = (a: UnipileAccountRow) =>
  (a.sources ?? []).map((s) => s.status).find((s) => !!s) ?? null;

/** Sorts the account list into Orbit's, Orbit's orphans and everyone else's. Pure. */
export function classifyAccounts(
  accounts: UnipileAccountRow[],
  known: { orbitAccountIds: Set<string>; userIds: Set<string>; linkAccountIds: Set<string> },
): ReconcileReport {
  const byType: Record<string, number> = {};
  const orbitOrphans: ReconcileReport['orbitOrphans'] = [];
  const notOrbit: ReconcileReport['notOrbit'] = { count: 0, linkedin: [] };
  const seen = new Set<string>();
  let orbitLinked = 0;
  for (const a of accounts) {
    const type = (a.type ?? 'UNKNOWN').toUpperCase();
    byType[type] = (byType[type] ?? 0) + 1;
    seen.add(a.id);
    if (known.orbitAccountIds.has(a.id)) {
      orbitLinked++;
      continue;
    }
    const name = a.name ?? '';
    const reason =
      type !== 'LINKEDIN'
        ? undefined
        : isUuid(name) && known.userIds.has(name.toLowerCase())
          ? ('user_id' as const)
          : ORBIT_REF.test(name)
            ? ('orbit_ref' as const)
            : known.linkAccountIds.has(a.id)
              ? ('link_record' as const)
              : undefined;
    if (reason) {
      orbitOrphans.push({
        id: a.id,
        createdAt: created(a.created_at),
        status: sourceStatus(a),
        reason,
        ...(reason === 'user_id' ? { userId: name.toLowerCase() } : {}),
      });
      continue;
    }
    notOrbit.count++;
    if (type === 'LINKEDIN')
      notOrbit.linkedin.push({
        id: a.id,
        createdAt: created(a.created_at),
        ...(isUuid(name) ? { hint: 'uuid_name' as const } : {}),
      });
  }
  return {
    total: accounts.length,
    byType,
    orbitLinked,
    missingAtUnipile: [...known.orbitAccountIds].filter((id) => !seen.has(id)).sort(),
    orbitOrphans,
    notOrbit,
    orbitOrphanCount: orbitOrphans.length,
  };
}

async function knownIds(db: Db) {
  const rows = await db.sql<{ external_account_id: string }>`
    select external_account_id from orbit.integration_accounts
     where provider = 'linkedin' and external_account_id is not null`;
  const users = await db.sql<{ id: string }>`select id::text as id from orbit.users`;
  const [links] = await db.sql<{ ok: boolean }>`
    select to_regclass('public.orbit_unipile_links') is not null as ok`;
  const linkRows = links?.ok
    ? await db.sql<{ account_id: string }>`select account_id from public.orbit_unipile_links`
    : [];
  return {
    orbitAccountIds: new Set(rows.map((r) => r.external_account_id)),
    userIds: new Set(users.map((r) => r.id.toLowerCase())),
    linkAccountIds: new Set(linkRows.map((r) => r.account_id)),
  };
}

type ParkCandidate = {
  user_id: string;
  external_account_id: string;
  synced_at: string | null;
  recent_at: string | null;
};

/**
 * The students whose link can be parked tonight: away `days` days (no visit and no session refreshed), autopilot off,
 * nothing approved, scheduled or sending, no needs-you card open, no LinkedIn reply in that time, a finished pass.
 */
export async function parkCandidates(db: Db, now: Date, days: number, limit = PARK_PER_RUN) {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  return db.sql<ParkCandidate>`
    select a.user_id::text as user_id, a.external_account_id,
           a.sync_state #>> '{linkedin,syncedAt}' as synced_at,
           a.sync_state #>> '{linkedin,recentAt}' as recent_at
      from orbit.integration_accounts a
      join orbit.users u on u.id = a.user_id and u.deleted_at is null
     where a.provider = 'linkedin' and a.status = 'active' and a.external_account_id is not null
       and a.sync_state #>> '{linkedin,syncedAt}' is not null
       and coalesce(u.last_seen_at, u.created_at) < ${cutoff}::timestamptz
       and not exists (
         select 1 from orbit.sessions s
          where s.user_id = u.id and s.revoked_at is null
            and coalesce(s.last_used_at, s.created_at) >= ${cutoff}::timestamptz)
       and coalesce(nullif(u.settings->>'autopilot_mode', ''),
                    case when u.autonomy_level >= 2 then 'autopilot'
                         when u.autonomy_level = 1 then 'assist' else 'off' end) = 'off'
       and not exists (
         select 1 from orbit.drafts d
          where d.user_id = u.id and d.status in ('approved', 'scheduled', 'sending'))
       and not exists (
         select 1 from orbit.suggestions g
          where g.user_id = u.id and g.kind = 'needs_you' and g.status in ('pending', 'snoozed')
            and g.expires_at > ${now}::timestamptz)
       and not exists (
         select 1 from orbit.threads t
          where t.user_id = u.id and t.provider = 'linkedin' and t.last_direction = 'in'
            and t.last_at >= ${cutoff}::timestamptz)
     order by coalesce(u.last_seen_at, u.created_at)
     limit ${limit}`;
}

export function unipileHandlers(deps: HandlerDeps): Record<string, JobHandler> {
  const opts: ProviderOptions = {
    fetch: deps.fetch ?? fetch,
    apiKey: deps.unipile?.apiKey,
    baseUrl: deps.unipile?.baseUrl,
    clock: deps.clock,
    sleep: deps.sleep,
    random: deps.random,
  };
  const configured = !!opts.apiKey && !!opts.baseUrl;

  return {
    'unipile.reconcile': async (_job, ctx) => {
      if (!configured) throw new JobSkipped('unconfigured');
      const list = await listUnipileAccounts(opts);
      if (!list.ok) throw new Error(`unipile accounts ${list.status ?? list.kind}`);
      const report = classifyAccounts(list.value, await knownIds(ctx.db));
      const day = ctx.now().toISOString().slice(0, 10);
      await ctx.db.sql`
        insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
        values (null, 'system', 'unipile.reconcile', 'integration_accounts', ${day}, ${JSON.stringify(report)}::jsonb)`;
    },

    'linkedin.park': async (_job, ctx) => {
      const days = deps.park?.days ?? DEFAULT_PARK_DAYS;
      if (days <= 0) throw new JobSkipped('off');
      if (!configured) throw new JobSkipped('unconfigured');
      const now = ctx.now();
      const candidates = await parkCandidates(ctx.db, now, days, deps.park?.perRun ?? PARK_PER_RUN);
      const out = { days, parked: [] as string[], skipped: [] as { userId: string; reason: string }[] };
      for (const c of candidates) {
        const id = c.external_account_id;
        // the id came from Orbit's own row; still, only a LinkedIn account Orbit named is ever unlinked
        const one = await getUnipileAccount(opts, id);
        if (!one.ok) {
          out.skipped.push({ userId: c.user_id, reason: `get ${one.status ?? one.kind}` });
          continue;
        }
        if (one.value) {
          const name = one.value.name ?? '';
          const ours = name.toLowerCase() === c.user_id.toLowerCase() || ORBIT_REF.test(name);
          if ((one.value.type ?? '').toUpperCase() !== 'LINKEDIN' || !ours) {
            out.skipped.push({ userId: c.user_id, reason: 'not_orbit_named' });
            continue;
          }
          const del = await deleteUnipileAccount(opts, id);
          if (!del.ok) {
            out.skipped.push({ userId: c.user_id, reason: `delete ${del.status ?? del.kind}` });
            continue;
          }
        }
        const since = [c.synced_at, c.recent_at]
          .filter((d): d is string => !!d)
          .sort()
          .at(-1)!;
        const parked = { at: now.toISOString(), accountId: id, since };
        const rows = await ctx.db.sql`
          update orbit.integration_accounts
             set status = 'parked', external_account_id = null, last_error = null,
                 sync_state = coalesce(sync_state, '{}'::jsonb)
                   || jsonb_build_object('linkedin',
                        coalesce(sync_state -> 'linkedin', '{}'::jsonb) || ${{ parked }}::jsonb)
           where user_id = ${c.user_id}::uuid and provider = 'linkedin' and external_account_id = ${id}
           returning id`;
        if (!rows.length) continue;
        await ctx.db.sql`
          insert into orbit.audit_log (user_id, actor, action, target_table, details)
          values (${c.user_id}::uuid, 'system', 'linkedin.parked', 'integration_accounts',
                  ${{ accountId: id, since, days, gone: !one.value }}::jsonb)`;
        out.parked.push(c.user_id);
      }
      await ctx.db.sql`
        insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
        values (null, 'system', 'linkedin.park', 'integration_accounts', ${now.toISOString().slice(0, 10)},
                ${JSON.stringify(out)}::jsonb)`;
    },
  };
}
