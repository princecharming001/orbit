/**
 * search_census (plan 32 §6.4, §18.9): a slow background sweep of the student's 1st-degree LinkedIn connections
 * through LinkedIn's own people search (distance 1, no keywords), which names each connection's location line and
 * current employers: the facts Orbit's relations sync never receives (it had a location for 5 of 7,540 people).
 *
 * Every page is 10 people (LinkedIn caps classic search there) and costs one unit of the account's daily search
 * ledger, the same counters orbit-connectors keeps (public.orbit_proxy_counters, key connectors:li:search:<day>:<acc>).
 * The census may fill that ledger only to CENSUS_SHARE of the day's total, and checks before it takes, so a student's
 * own searches always have the rest. A pass of a few thousand connections therefore takes days; it resumes from the
 * saved cursor, and a finished pass is walked again after 30 days.
 *
 * What it writes: a positive place assertion with the location line LinkedIn shows, a positive company assertion for
 * each current employer, and people.location when Orbit had none. Nobody outside Orbit's own people is stored.
 */
import type { Db } from '../db.ts';

/** orbit-connectors DEFAULT_LEDGER.search: searches per account per day. */
export const SEARCH_LEDGER_TOTAL = 100;
/** orbit-connectors LEDGER_CEILINGS.search.census */
export const CENSUS_SHARE = 0.4;
export const CENSUS_JOB_MS = 50_000;
export const PASS_AGAIN_DAYS = 30;

export interface CensusDeps {
  fetch: typeof fetch;
  apiKey: string;
  baseUrl: string;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  clock: () => number;
}

export interface CensusPerson {
  memberId: string;
  name: string;
  headline?: string;
  location?: string;
  companies: string[];
}

export interface CensusStep {
  pages: number;
  seen: number;
  matched: number;
  done: boolean;
  stopped?: 'ledger' | 'time' | 'fresh' | 'refused';
}

const txt = (v: unknown, n = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);

/** One page of the sweep as people; LinkedIn's shapes per orbit-connectors unipileSearch. */
export function censusPeople(items: unknown): CensusPerson[] {
  if (!Array.isArray(items)) return [];
  const out: CensusPerson[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const memberId = txt(p.id, 120);
    const name = txt(p.name, 160);
    if (!memberId || !name) continue;
    if (typeof p.network_distance === 'string' && p.network_distance !== 'DISTANCE_1') continue;
    const companies = Array.isArray(p.current_positions)
      ? p.current_positions
          .map((x) =>
            x && typeof x === 'object' ? txt((x as Record<string, unknown>).company, 160) : undefined,
          )
          .filter((c): c is string => !!c)
          .slice(0, 3)
      : [];
    out.push({ memberId, name, headline: txt(p.headline, 220), location: txt(p.location, 160), companies });
  }
  return out;
}

function ledgerBucket(accountId: string, now: Date, share: number) {
  const day = now.toISOString().slice(0, 10);
  const end = new Date(`${day}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    key: `connectors:li:search:${day}:${accountId}`,
    limit: Math.round(SEARCH_LEDGER_TOTAL * share),
    expires: end.toISOString(),
  };
}

/**
 * Takes one search from the shared ledger when the caller's share has room (the census's by default); peeks first so
 * a refusal adds nothing.
 */
export async function spendCensus(
  db: Db,
  accountId: string,
  now: Date,
  share = CENSUS_SHARE,
): Promise<boolean> {
  const b = ledgerBucket(accountId, now, share);
  const [used] = await db.sql<{ count: number }>`
    select count from public.orbit_proxy_counters where bucket = ${b.key} and expires_at >= now()`;
  if ((used?.count ?? 0) + 1 > b.limit) return false;
  const [row] = await db.sql<{ allowed: boolean }>`
    select allowed from public.orbit_proxy_take(${[b.key]}::text[], ${[b.limit]}::int[], ${[b.expires]}::timestamptz[])`;
  return !!row?.allowed;
}

/** Files one page: assertions for the people Orbit has, locations where it had none. Returns how many it knew. */
export async function filePage(db: Db, userId: string, people: CensusPerson[], now: Date): Promise<number> {
  if (!people.length) return 0;
  const ids = people.map((p) => p.memberId);
  const known = await db.sql<{ id: string; member: string }>`
    select p.id, p.linkedin_member_id as member from orbit.people p
     where p.user_id = ${userId}::uuid and p.deleted_at is null and p.merged_into is null
       and p.linkedin_member_id = any(${ids}::text[])
    union
    select i.person_id as id, i.value_norm as member from orbit.person_identities i
      join orbit.people p on p.id = i.person_id and p.deleted_at is null and p.merged_into is null
     where i.user_id = ${userId}::uuid and i.kind = 'linkedin_member' and i.value_norm = any(${ids}::text[])`;
  const byMember = new Map<string, string>();
  for (const k of known) if (!byMember.has(k.member)) byMember.set(k.member, k.id);
  const rows: { person_id: string; kind: string; value: string }[] = [];
  const places: { id: string; location: string }[] = [];
  for (const p of people) {
    const id = byMember.get(p.memberId);
    if (!id) continue;
    if (p.location) {
      rows.push({ person_id: id, kind: 'place', value: p.location });
      places.push({ id, location: p.location });
    }
    for (const c of p.companies) rows.push({ person_id: id, kind: 'company', value: c });
  }
  if (rows.length)
    await db.sql`
      insert into orbit.facet_assertions (user_id, person_id, kind, value, positive, source, at)
      select ${userId}::uuid, r.person_id, r.kind, r.value, true, 'census', ${now.toISOString()}::timestamptz
        from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as r(person_id uuid, kind text, value text)
      on conflict (user_id, person_id, kind, value, source) do update set at = excluded.at, positive = true`;
  if (places.length)
    await db.sql`
      update orbit.people p set location = r.location, updated_at = now()
        from jsonb_to_recordset(${JSON.stringify(places)}::jsonb) as r(id uuid, location text)
       where p.id = r.id and p.user_id = ${userId}::uuid and (p.location is null or p.location = '')`;
  return byMember.size;
}

type CensusRow = {
  cursor: string | null;
  seen: number;
  matched: number;
  pass_started_at: string | null;
  pass_done_at: string | null;
};

/** One job's worth of the sweep: pages until the ledger share, the time budget or the pass runs out. */
export async function runCensusStep(
  db: Db,
  deps: CensusDeps,
  userId: string,
  accountId: string,
  now: Date,
): Promise<CensusStep> {
  const [row] = await db.sql<CensusRow>`
    select cursor, seen, matched, pass_started_at::text, pass_done_at::text from orbit.search_census
     where user_id = ${userId}::uuid`;
  if (
    row?.pass_done_at &&
    !row.cursor &&
    now.getTime() - Date.parse(row.pass_done_at) < PASS_AGAIN_DAYS * 86_400_000
  )
    return { pages: 0, seen: 0, matched: 0, done: true, stopped: 'fresh' };
  // a pass starts fresh when there is no cursor to resume from
  const resuming = !!row?.cursor;
  let cursor: string | null = resuming ? row.cursor : null;
  let seen = resuming ? row.seen : 0;
  let matched = resuming ? row.matched : 0;
  const passStarted = resuming && row.pass_started_at ? row.pass_started_at : now.toISOString();
  const started = deps.clock();
  const step: CensusStep = { pages: 0, seen: 0, matched: 0, done: false };
  const base = deps.baseUrl.replace(/\/+$/, '');
  let lastError: string | null = null;
  while (true) {
    if (deps.clock() - started > CENSUS_JOB_MS) {
      step.stopped = 'time';
      break;
    }
    if (!(await spendCensus(db, accountId, now))) {
      step.stopped = 'ledger';
      break;
    }
    if (step.pages > 0) await deps.sleep(1500 + Math.floor(deps.random() * 2500));
    const q = new URLSearchParams({ account_id: accountId, limit: '10' });
    if (cursor) q.set('cursor', cursor);
    const res = await deps.fetch(`${base}/api/v1/linkedin/search?${q}`, {
      method: 'POST',
      headers: { 'X-API-KEY': deps.apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ api: 'classic', category: 'people', network_distance: [1] }),
    });
    if (res.status >= 400 && res.status < 500) {
      lastError = `refused ${res.status}`;
      step.stopped = 'refused';
      break;
    }
    if (!res.ok) throw new Error(`unipile ${res.status}`);
    const body = (await res.json()) as { items?: unknown; cursor?: string | null };
    const people = censusPeople(body.items);
    const knew = await filePage(db, userId, people, now);
    step.pages++;
    step.seen += people.length;
    step.matched += knew;
    seen += people.length;
    matched += knew;
    cursor = typeof body.cursor === 'string' && body.cursor ? body.cursor : null;
    if (!cursor || !people.length) {
      cursor = null;
      step.done = true;
      break;
    }
  }
  await db.sql`
    insert into orbit.search_census (user_id, cursor, seen, matched, pass_started_at, pass_done_at, last_error, updated_at)
    values (${userId}::uuid, ${cursor}, ${seen}, ${matched}, ${passStarted}::timestamptz,
            ${step.done ? now.toISOString() : (row?.pass_done_at ?? null)}::timestamptz, ${lastError}, now())
    on conflict (user_id) do update set cursor = excluded.cursor, seen = excluded.seen, matched = excluded.matched,
      pass_started_at = excluded.pass_started_at, pass_done_at = excluded.pass_done_at,
      last_error = excluded.last_error, updated_at = now()`;
  return step;
}
