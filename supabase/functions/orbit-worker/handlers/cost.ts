/**
 * cost.digest (plan 34 E2): once a morning (cron orbit-cost-digest, 07:50 UTC), one job for everyone. For yesterday
 * (UTC) it adds up what Orbit spent per provider and per student (orbit.v_spend_daily and the chat proxy's per-user
 * day rows), the chat's token shape, the LinkedIn ledgers' fullest share, Hunter credits this month, isolate deaths,
 * dead letters and job errors, and any provider switched off. It writes one orbit.audit_log row, action
 * `cost.digest` (the owner's cost page reads these), and mails the owner when a threshold is crossed and a mailer
 * is configured. The Unipile accounts come from the newest unipile.reconcile row of the last 36 hours (plan 35 E1):
 * the count on the key, Orbit's linked ones, and the LinkedIn accounts Orbit made that no student row holds (orphans,
 * each still billed), with Osmo's and other accounts counted apart; null when the reconciler has not run.
 */
import type { Db } from '../../_shared/db.ts';
import type { Mailer } from '../../_shared/services.ts';
import type { JobHandler } from '../worker.ts';

export interface CostThresholds {
  /** Anthropic dollars in a day, chat and server and research together */
  anthropicUsdDay: number;
  /** Hunter credits used this calendar month */
  hunterMonthCredits: number;
  /** a LinkedIn ledger filled past this share of its daily total */
  linkedinShare: number;
  isolateDeaths: number;
  deadLetters: number;
}

export const DEFAULT_COST_THRESHOLDS: CostThresholds = {
  anthropicUsdDay: 5,
  hunterMonthCredits: 30,
  linkedinShare: 0.9,
  isolateDeaths: 5,
  deadLetters: 5,
};

/** What the digest carries from the newest unipile.reconcile row (handlers/unipile.ts ReconcileReport). */
export interface UnipileDigest {
  at: string;
  total: number;
  orbitLinked: number;
  missingAtUnipile: string[];
  orbitOrphans: { id: string; createdAt: string | null; reason: string }[];
  notOrbitCount: number;
  notOrbitLinkedin: string[];
  /** links parked by linkedin.park (plan 35 E5), now */
  parked: number;
}

/** each account's daily LinkedIn ledger totals (orbit-connectors DEFAULT_LEDGER) */
export const LINKEDIN_LEDGER_TOTALS: Record<string, number> = {
  profile: 100,
  posts: 100,
  search: 100,
  company: 150,
};

export interface CostDigestDeps {
  mailer?: Mailer;
  /** the owner's orbit.users id (ORBIT_OWNER_ID); without it nothing is mailed */
  ownerId?: string;
  thresholds?: Partial<CostThresholds>;
}

export interface CostDigest {
  day: string;
  totalUsd: number;
  anthropicUsd: number;
  providers: {
    source: string;
    provider: string;
    operation: string;
    calls: number;
    units: number | null;
    usd: number;
  }[];
  users: { userId: string; ledgerUsd: number; chatUsd: number; totalUsd: number }[];
  chat: {
    answers: number;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    webSearches: number;
    /** cache_read / (cache_read + cache_write + input), null with no tokens */
    cacheReadShare: number | null;
  } | null;
  hunterMonthCredits: number;
  linkedin: { kind: string; accountId: string; count: number; total: number; share: number }[];
  linkedinPeakShare: number | null;
  jobs: {
    runs: number;
    errors: number;
    isolateDeaths: number;
    deadLetters: number;
    byKind: { kind: string; runs: number; errors: number }[];
  };
  switchedOff: string[];
  /** every account on the shared Unipile key at the last reconcile; null before it first runs */
  unipileAccounts: number | null;
  unipile: UnipileDigest | null;
  thresholds: CostThresholds;
  crossed: { key: string; value: number; limit: number }[];
  mailed: boolean;
  mailError?: string;
}

const num = (v: unknown) => (v == null ? 0 : Number(v));
const round = (v: number, d = 5) => Math.round(v * 10 ** d) / 10 ** d;

export async function buildCostDigest(db: Db, now: Date, thresholds: CostThresholds): Promise<CostDigest> {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - 86_400_000);
  const day = start.toISOString().slice(0, 10);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const spend = await db.sql<{
    source: string;
    provider: string;
    operation: string;
    calls: number | string;
    units: number | string | null;
    usd: number | string | null;
    input_tokens: number | string | null;
    cache_read_tokens: number | string | null;
    cache_write_tokens: number | string | null;
    output_tokens: number | string | null;
    web_searches: number | string | null;
  }>`
    select source, provider, operation, sum(calls) as calls, sum(units) as units, sum(usd) as usd,
           sum(input_tokens) as input_tokens, sum(cache_read_tokens) as cache_read_tokens,
           sum(cache_write_tokens) as cache_write_tokens, sum(output_tokens) as output_tokens,
           sum(web_searches) as web_searches
      from orbit.v_spend_daily where day = ${day}::date
     group by source, provider, operation order by sum(usd) desc nulls last`;
  const priced = spend.filter((r) => r.source !== 'claude_usage');
  const providers = priced.map((r) => ({
    source: r.source,
    provider: r.provider,
    operation: r.operation,
    calls: num(r.calls),
    units: r.units == null ? null : num(r.units),
    usd: round(num(r.usd)),
  }));
  const totalUsd = round(providers.reduce((a, r) => a + r.usd, 0));
  const anthropicUsd = round(
    providers.filter((r) => r.provider === 'anthropic').reduce((a, r) => a + r.usd, 0),
  );
  const tokens = spend.filter((r) => r.source === 'claude_usage');
  const t = (k: keyof (typeof tokens)[number]) => tokens.reduce((a, r) => a + num(r[k]), 0);
  const chat = tokens.length
    ? {
        answers: t('calls'),
        inputTokens: t('input_tokens'),
        cacheReadTokens: t('cache_read_tokens'),
        cacheWriteTokens: t('cache_write_tokens'),
        outputTokens: t('output_tokens'),
        webSearches: t('web_searches'),
        cacheReadShare: (() => {
          const all = t('cache_read_tokens') + t('cache_write_tokens') + t('input_tokens');
          return all ? round(t('cache_read_tokens') / all, 3) : null;
        })(),
      }
    : null;

  // per student: the server ledger, and the chat proxy's user:<uuid>:<day> rows
  const userRows = await db.sql<{ user_id: string; ledger: number | string; chat: number | string }>`
    with l as (
      select user_id::text as user_id, sum(cost_usd) as usd from orbit.usage_ledger
       where created_at >= ${start}::timestamptz and created_at < ${end}::timestamptz and user_id is not null
       group by 1),
    c as (
      select substring(subject from '^user:([0-9a-f-]{36}):') as user_id, sum(usd) as usd
        from public.orbit_proxy_spend where subject like ${`user:%:${day}`} group by 1)
    select coalesce(l.user_id, c.user_id) as user_id, coalesce(l.usd, 0) as ledger, coalesce(c.usd, 0) as chat
      from l full join c on c.user_id = l.user_id`;
  const users = userRows
    .map((r) => ({
      userId: r.user_id,
      ledgerUsd: round(num(r.ledger)),
      chatUsd: round(num(r.chat)),
      totalUsd: round(num(r.ledger) + num(r.chat)),
    }))
    .sort((a, b) => b.totalUsd - a.totalUsd);

  const [hunter] = await db.sql<{ credits: number | string | null }>`
    select sum(units) as credits from orbit.usage_ledger
     where provider = 'hunter' and created_at >= ${monthStart}::timestamptz`;
  const hunterMonthCredits = round(num(hunter?.credits), 2);

  // the ledgers expire at the day's end and are swept on the next write, so yesterday's may already be gone
  const buckets = await db.sql<{ bucket: string; count: number | string }>`
    select bucket, count from public.orbit_proxy_counters where bucket like ${`connectors:li:%:${day}:%`}`;
  const linkedin = buckets
    .map((b) => {
      const [, , kind = '', , accountId = ''] = b.bucket.split(':');
      const total = LINKEDIN_LEDGER_TOTALS[kind] ?? 100;
      return { kind, accountId, count: num(b.count), total, share: round(num(b.count) / total, 3) };
    })
    .sort((a, b) => b.share - a.share);
  const linkedinPeakShare = linkedin.length ? linkedin[0]!.share : null;

  const kinds = await db.sql<{
    kind: string;
    runs: number | string;
    errors: number | string;
    deaths: number | string;
  }>`
    select kind, count(*) as runs, count(*) filter (where status = 'error') as errors,
           count(*) filter (where error = 'died with the isolate') as deaths
      from orbit.job_runs where started_at >= ${start}::timestamptz and started_at < ${end}::timestamptz
     group by kind order by count(*) desc`;
  const [dl] = await db.sql<{ n: number | string }>`
    select count(*) as n from orbit.dead_letters
     where created_at >= ${start}::timestamptz and created_at < ${end}::timestamptz`;
  const jobs = {
    runs: kinds.reduce((a, r) => a + num(r.runs), 0),
    errors: kinds.reduce((a, r) => a + num(r.errors), 0),
    isolateDeaths: kinds.reduce((a, r) => a + num(r.deaths), 0),
    deadLetters: num(dl?.n),
    byKind: kinds.map((r) => ({ kind: r.kind, runs: num(r.runs), errors: num(r.errors) })),
  };

  let switchedOff: string[] = [];
  const [sw] = await db.sql<{
    ok: boolean;
  }>`select to_regclass('orbit_private.provider_switches') is not null as ok`;
  if (sw?.ok)
    switchedOff = (
      await db.sql<{ provider: string }>`
        select provider from orbit_private.provider_switches where not enabled order by provider`
    ).map((r) => r.provider);

  const unipile = await unipileDigest(db, now);

  const crossed: CostDigest['crossed'] = [];
  const check = (key: string, value: number | null, limit: number) => {
    if (value != null && value > limit) crossed.push({ key, value, limit });
  };
  check('anthropicUsdDay', anthropicUsd, thresholds.anthropicUsdDay);
  check('hunterMonthCredits', hunterMonthCredits, thresholds.hunterMonthCredits);
  check('linkedinShare', linkedinPeakShare, thresholds.linkedinShare);
  check('isolateDeaths', jobs.isolateDeaths, thresholds.isolateDeaths);
  check('deadLetters', jobs.deadLetters, thresholds.deadLetters);
  check('switchedOff', switchedOff.length, 0);
  // an orphan is an account Orbit made and no student holds: billed every month until someone deletes it
  check('unipileOrphans', unipile ? unipile.orbitOrphans.length : null, 0);

  return {
    day,
    totalUsd,
    anthropicUsd,
    providers,
    users,
    chat,
    hunterMonthCredits,
    linkedin,
    linkedinPeakShare,
    jobs,
    switchedOff,
    unipileAccounts: unipile?.total ?? null,
    unipile,
    thresholds,
    crossed,
    mailed: false,
  };
}

async function unipileDigest(db: Db, now: Date): Promise<UnipileDigest | null> {
  const [r] = await db.sql<{
    created_at: Date | string;
    details: {
      total?: number;
      orbitLinked?: number;
      missingAtUnipile?: string[];
      orbitOrphans?: { id: string; createdAt: string | null; reason: string }[];
      notOrbit?: { count?: number; linkedin?: { id: string }[] };
    };
  }>`
    select created_at, details from orbit.audit_log
     where action = 'unipile.reconcile' and created_at > ${new Date(now.getTime() - 36 * 3_600_000)}::timestamptz
     order by created_at desc limit 1`;
  const [p] = await db.sql<{ n: number | string }>`
    select count(*) as n from orbit.integration_accounts where provider = 'linkedin' and status = 'parked'`;
  if (!r) return null;
  const d = r.details ?? {};
  return {
    at: new Date(r.created_at).toISOString(),
    total: num(d.total),
    orbitLinked: num(d.orbitLinked),
    missingAtUnipile: d.missingAtUnipile ?? [],
    orbitOrphans: (d.orbitOrphans ?? []).map((o) => ({ id: o.id, createdAt: o.createdAt, reason: o.reason })),
    notOrbitCount: num(d.notOrbit?.count),
    notOrbitLinkedin: (d.notOrbit?.linkedin ?? []).map((a) => a.id),
    parked: num(p?.n),
  };
}

const LABELS: Record<string, string> = {
  anthropicUsdDay: 'Anthropic spend in the day ($)',
  hunterMonthCredits: 'Hunter credits this month',
  linkedinShare: 'Fullest LinkedIn ledger (share of the daily total)',
  isolateDeaths: 'Worker runs that died with the isolate',
  deadLetters: 'Dead letters',
  switchedOff: 'Providers switched off',
  unipileOrphans: 'Unipile LinkedIn accounts Orbit made that no student holds',
};

/** the email: plain text, numbers first, no em dashes or exclamation marks */
export function costDigestText(d: CostDigest): string {
  const lines = [
    `Orbit spend for ${d.day} (UTC)`,
    '',
    'Over the line:',
    ...d.crossed.map((c) => `- ${LABELS[c.key] ?? c.key}: ${c.value} (limit ${c.limit})`),
    '',
    `Total recorded: $${d.totalUsd.toFixed(2)}. Anthropic: $${d.anthropicUsd.toFixed(2)}.`,
    `Hunter credits this month: ${d.hunterMonthCredits}.`,
    `Jobs: ${d.jobs.runs} runs, ${d.jobs.errors} errors, ${d.jobs.isolateDeaths} isolate deaths, ${d.jobs.deadLetters} dead letters.`,
  ];
  if (d.switchedOff.length) lines.push(`Switched off: ${d.switchedOff.join(', ')}.`);
  if (d.unipile) {
    const u = d.unipile;
    lines.push(
      `Unipile: ${u.total} accounts on the key, ${u.orbitLinked} linked by Orbit, ${u.parked} parked, ${u.notOrbitCount} not Orbit's.`,
    );
    if (u.orbitOrphans.length)
      lines.push(
        `Orbit orphans (not deleted, delete by hand once checked): ${u.orbitOrphans
          .map((o) => `${o.id} (${o.createdAt?.slice(0, 10) ?? 'no date'})`)
          .join(', ')}.`,
      );
    if (u.notOrbitLinkedin.length)
      lines.push(`LinkedIn accounts that are not Orbit's: ${u.notOrbitLinkedin.join(', ')}.`);
    if (u.missingAtUnipile.length)
      lines.push(`Orbit rows whose account Unipile no longer has: ${u.missingAtUnipile.length}.`);
  }
  if (d.providers.length) {
    lines.push('', 'By provider:');
    for (const p of d.providers.slice(0, 12))
      lines.push(`- ${p.provider} ${p.operation}: $${p.usd.toFixed(4)} over ${p.calls} calls`);
  }
  lines.push('', 'The full digest is in the audit log (action cost.digest).');
  return lines.join('\n');
}

export function costHandlers(deps: CostDigestDeps = {}): Record<string, JobHandler> {
  return {
    'cost.digest': async (_job, ctx) => {
      const thresholds = { ...DEFAULT_COST_THRESHOLDS, ...deps.thresholds };
      const digest = await buildCostDigest(ctx.db, ctx.now(), thresholds);
      if (digest.crossed.length) {
        if (!deps.mailer?.configured) digest.mailError = 'no_mailer';
        else if (!deps.ownerId) digest.mailError = 'no_owner';
        else {
          const [owner] = await ctx.db.sql<{ email: string }>`
            select email from orbit.users where id = ${deps.ownerId}::uuid and deleted_at is null`;
          if (!owner) digest.mailError = 'no_owner';
          else {
            const sent = await deps.mailer.send({
              to: owner.email,
              subject: `Orbit spend ${digest.day}: ${digest.crossed.length} over the line`,
              text: costDigestText(digest),
            });
            digest.mailed = sent.ok;
            if (!sent.ok) digest.mailError = sent.error;
          }
        }
      }
      await ctx.db.sql`
        insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
        values (null, 'system', 'cost.digest', 'v_spend_daily', ${digest.day}, ${JSON.stringify(digest)}::jsonb)`;
    },
  };
}
