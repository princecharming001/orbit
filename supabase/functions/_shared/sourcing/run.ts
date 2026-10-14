/**
 * Sourcing as a service (§6): the request and the goal become a SourcingGoal, sourcePeople runs with the real
 * providers (Unipile, Apollo, Exa, Semantic Scholar), Haiku fit (keyword rule without a key), reach from the warm-path
 * ranker on the user's own graph, and responsiveness from core's responsePrior; the ranked rows are stored in
 * orbit.recommendations. "Add" turns chosen rows into people with a pipeline chat at `identified` and queues their
 * dossier.
 */
import { responsePrior } from '@orbit/core/recommend/score';
import type {
  SourceAddResponse,
  SourcedCandidate,
  SourceSearchRequest,
  SourceSearchResponse,
} from '@orbit/core/server/api';
import { normalizeEmail } from '@orbit/core/text/normalize';
import { GOAL_KINDS, type Person } from '@orbit/core/types';
import type { Db } from '../db.ts';
import { HttpError } from '../http.ts';
import { bestReach, ensurePerson, loadGraph, resolvePersonRef, type UserGraph } from '../paths/find.ts';
import { cleanLinkedInUrl } from '../providers/unipileResearch';
import { claudeDep, sqlBudget } from '../research/bind.ts';
import { firstNameOf } from '../rows.ts';
import type { Services } from '../services.ts';
import {
  type Candidate,
  type RecommendationRow,
  type SourceName,
  type SourcingGoal,
  sourcePeople,
} from './search';

const strs = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim())
    : [];
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** The goal row (when given) overlaid with the request's purpose, query and filters. */
export function sourcingGoal(
  req: SourceSearchRequest,
  goal?: {
    id: string;
    kind: string;
    title: string;
    targets: Record<string, unknown>;
    criteria: Record<string, unknown>;
  },
): SourcingGoal {
  const f = req.filters ?? {};
  const t = goal?.targets ?? {};
  const c = goal?.criteria ?? {};
  const roles = f.titles?.length ? f.titles : strs(t.roles);
  const orgs = f.organizations?.length ? f.organizations : strs(t.organizations);
  const keywords = f.keywords?.length ? f.keywords : strs(c.keywords);
  const location = f.locations?.[0] ?? strs(t.geographies)[0];
  const query = str(req.query);
  const criteria = [
    ...(query ? [query] : []),
    ...strs(c.criteria),
    ...roles,
    ...(str(c.sector) ? [str(c.sector)!] : []),
    ...strs(c.skills),
  ].slice(0, 8);
  return {
    id: goal?.id ?? null,
    kind: req.purpose,
    title: goal?.title ?? query ?? req.purpose,
    criteria,
    orgs,
    domains: strs(c.domains),
    roles,
    skills: strs(c.skills),
    keywords: keywords.length ? keywords : query ? [query] : [],
    sector: str(c.sector),
    stage: str(c.stage),
    location,
    seniorities: f.seniority?.length ? f.seniority : strs(c.seniority),
    employeeRanges: strs(c.employee_ranges ?? c.employeeRanges),
    pastCompanies: strs(c.past_companies ?? c.pastCompanies),
    topic: query ?? str(c.topic),
  };
}

const toSourced = (id: string, r: RecommendationRow): SourcedCandidate => {
  const c = r.candidate;
  return {
    id,
    name: c.name,
    ...(c.title ? { title: c.title } : {}),
    ...(c.org ? { org: c.org } : {}),
    ...(c.location ? { location: c.location } : {}),
    ...(c.linkedinUrl ? { linkedinUrl: c.linkedinUrl } : {}),
    source: (c.sources[0] ?? 'exa') as SourceName,
    rank: r.rank,
    fit: r.fit,
    reach: r.reach,
    responsiveness: r.responsiveness,
    reasons: r.reasons,
    ...(r.person_id ? { knownPersonId: r.person_id } : {}),
  };
};

export async function runSourcing(
  s: Services,
  userId: string,
  req: SourceSearchRequest,
): Promise<SourceSearchResponse> {
  if (!GOAL_KINDS.includes(req.purpose)) throw new HttpError(400, 'bad_request', 'unknown purpose');
  const db = s.db;
  const now = s.now();
  let goal:
    | {
        id: string;
        kind: string;
        title: string;
        targets: Record<string, unknown>;
        criteria: Record<string, unknown>;
      }
    | undefined;
  if (req.goalId) {
    [goal] = await db.sql<NonNullable<typeof goal>>`
      select id, kind, title, targets, criteria from orbit.goals
       where id = ${req.goalId}::uuid and user_id = ${userId}::uuid and deleted_at is null`;
    if (!goal) throw new HttpError(404, 'not_found', 'no such goal');
  }
  const [u] = await db.sql<{
    first_name: string | null;
    full_name: string | null;
    email: string;
    school: string | null;
    majors: string[];
  }>`
    select first_name, full_name, email, school, majors from orbit.users where id = ${userId}::uuid`;
  const [acct] = await db.sql<{ external_account_id: string | null }>`
    select external_account_id from orbit.integration_accounts
     where user_id = ${userId}::uuid and provider = 'linkedin' and status = 'active'`;
  let graph: UserGraph | undefined;
  const g = async () => (graph ??= await loadGraph(db, userId, now));
  const known = new Map<string, { personId: string; score?: number } | null>();
  const knownOf = async (c: Candidate) => {
    if (known.has(c.key)) return known.get(c.key)!;
    let id = await resolvePersonRef(db, userId, {
      name: '',
      linkedinUrl: c.linkedinUrl,
      memberId: c.memberId,
    });
    if (!id && c.email) {
      const [p] = await db.sql<{ person_id: string }>`
        select person_id from orbit.person_identities
         where user_id = ${userId}::uuid and kind = 'email' and value_norm = ${normalizeEmail(c.email)}`;
      id = p?.person_id ?? null;
    }
    if (!id && c.org) {
      const [p] = await db.sql<{ id: string }>`
        select id from orbit.people where user_id = ${userId}::uuid and not is_self and deleted_at is null
           and lower(display_name) = lower(${c.name}) and lower(coalesce(org_raw, '')) = lower(${c.org}) limit 1`;
      id = p?.id ?? null;
    }
    const v = id ? { personId: id, score: (await g()).people.get(id)?.score } : null;
    known.set(c.key, v);
    return v;
  };
  const user = { school: u?.school ?? '', majors: u?.majors ?? [] };
  const result = await sourcePeople(
    {
      unipile: s.unipile,
      apollo: s.apollo,
      exa: s.exa,
      semanticScholar: s.semanticScholar,
      claude: s.claude.configured ? claudeDep(s.claude, userId) : undefined,
      budget: sqlBudget(db, s.now),
      clock: () => now.getTime(),
      knownPerson: knownOf,
      reachOf: async (c) => {
        const k = await knownOf(c);
        return k ? bestReach(await g(), k.personId, req.purpose, now) : null;
      },
      responsiveness: (c) =>
        responsePrior(
          {
            isAlumni: !!user.school && !!c.headline?.toLowerCase().includes(user.school.toLowerCase()),
            currentTitle: c.title,
            headline: c.headline,
          } as Person,
          user,
        ),
      inPipeline: async (c) => {
        const k = await knownOf(c);
        if (!k || !goal) return false;
        const [x] = await db.sql`
          select 1 from orbit.chats where user_id = ${userId}::uuid and person_id = ${k.personId}::uuid
             and goal_id = ${goal.id}::uuid and archived_at is null limit 1`;
        return !!x;
      },
    },
    {
      userId,
      goal: sourcingGoal(req, goal),
      user: {
        firstName: u?.first_name ?? u?.full_name?.split(/\s+/)[0] ?? 'the user',
        school: u?.school ?? undefined,
      },
      unipileAccountId: acct?.external_account_id ?? undefined,
      limit: Math.max(1, Math.min(50, req.limit ?? 25)),
    },
  );
  const results: SourcedCandidate[] = [];
  for (const r of result.results) {
    const [row] = await db.sql<{ id: string }>`
      insert into orbit.recommendations (user_id, goal_id, person_id, candidate, source, external_id, rank, fit, reach,
                                         responsiveness, reasons, status, batch_id)
      values (${userId}::uuid, ${r.goal_id}::uuid, ${r.person_id}::uuid, ${r.candidate}::jsonb, ${r.source},
              ${r.external_id}, ${r.rank}::real, ${r.fit}::real, ${r.reach}::real, ${r.responsiveness}::real,
              ${r.reasons}::text[], 'new', ${result.batchId}::uuid)
      returning id`;
    results.push(toSourced(row!.id, r));
  }
  return { batchId: result.batchId, results, unconfigured: result.unconfigured, relaxed: result.relaxed };
}

/** POST /source/add: one person, one chat at `identified` with the goal, one queued dossier per recommendation. */
export async function addSourced(s: Services, userId: string, ids: unknown): Promise<SourceAddResponse> {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 50 ||
    !ids.every((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x))
  )
    throw new HttpError(400, 'bad_request', 'recommendationIds must be 1–50 ids');
  const db = s.db;
  const now = s.now();
  const out: SourceAddResponse['people'] = [];
  for (const id of ids as string[]) {
    const [rec] = await db.sql<{
      id: string;
      goal_id: string | null;
      person_id: string | null;
      candidate: Candidate;
      source: string;
    }>`
      select id, goal_id, person_id, candidate, source from orbit.recommendations
       where id = ${id}::uuid and user_id = ${userId}::uuid`;
    if (!rec) throw new HttpError(404, 'not_found', 'no such recommendation');
    const c = rec.candidate;
    const personId =
      rec.person_id ??
      (await ensurePerson(
        db,
        userId,
        {
          name: c.name,
          linkedinUrl: cleanLinkedInUrl(c.linkedinUrl),
          memberId: c.memberId,
          headline: c.headline,
          org: c.org,
          title: c.title,
          email: c.email,
          location: c.location,
        },
        rec.source.split('+')[0] ?? 'sourcing',
      ));
    const chatId = await ensureChat(db, userId, personId, rec.goal_id, now);
    await db.sql`
      update orbit.recommendations set status = 'added', person_id = ${personId}::uuid where id = ${rec.id}::uuid`;
    await s.queue.enqueue({
      kind: 'enrich.dossier',
      userId,
      payload: { personId, goalId: rec.goal_id },
      dedupeKey: `dossier:${personId}`,
    });
    const [p] = await db.sql<{ display_name: string; first_name: string | null }>`
      select display_name, first_name from orbit.people where id = ${personId}::uuid`;
    out.push({ id: personId, displayName: p?.display_name ?? firstNameOf({ display_name: c.name }), chatId });
  }
  return { people: out };
}

/** The open chat for a person and goal, or a new one at `identified`. */
export async function ensureChat(
  db: Db,
  userId: string,
  personId: string,
  goalId: string | null,
  now: Date,
): Promise<string> {
  const [c] = await db.sql<{ id: string }>`
    select id from orbit.chats
     where user_id = ${userId}::uuid and person_id = ${personId}::uuid and archived_at is null
       and goal_id is not distinct from ${goalId}::uuid
     order by created_at limit 1`;
  if (c) return c.id;
  const [row] = await db.sql<{ id: string }>`
    insert into orbit.chats (user_id, person_id, goal_id, stage, stage_entered_at, data)
    values (${userId}::uuid, ${personId}::uuid, ${goalId}::uuid, 'identified', ${now}::timestamptz,
            ${{ source: 'recommendation', goalTags: [], bumpCount: 0, priority: 2 }}::jsonb)
    returning id`;
  await db.sql`
    insert into orbit.stage_events (user_id, chat_id, from_stage, to_stage, status, actor, reason, decided_at)
    values (${userId}::uuid, ${row!.id}::uuid, null, 'identified', 'applied', 'user', 'added from sourcing', ${now}::timestamptz)`;
  return row!.id;
}
