/**
 * Sourcing as a service (§6): the request and the goal become a SourcingGoal, sourcePeople runs with the real
 * providers (Unipile, Apollo, Exa, Semantic Scholar), Haiku fit (keyword rule without a key), reach from the warm-path
 * ranker on the user's own graph, and responsiveness from core's responsePrior; the ranked rows are stored in
 * orbit.recommendations. "Add" turns chosen rows into people with a pipeline chat at `identified` and queues their
 * dossier.
 */

import Anthropic from '@anthropic-ai/sdk';
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
import { cleanLinkedInUrl, linkedInSlugOf } from '../providers/unipileResearch';
import { claudeDep, sqlBudget } from '../research/bind.ts';
import { norm, normOrg } from '../research/guards';
import { claudeWeb, exaWeb, GATHER_MODEL, sqlSharedCache, type WebSource } from '../research/web';
import { firstNameOf } from '../rows.ts';
import type { Services } from '../services.ts';
import { dnsMx, fillEmails, type KnownAddress, orgDomainsOf } from './email';
import { indexKnown, type KnownRow, matchKnown } from './known';
import {
  type Candidate,
  type RecommendationRow,
  type SourceName,
  type SourcingGoal,
  sourcePeople,
} from './search';
import {
  orgsOf,
  type StudentContext,
  schoolIn,
  siteDomain,
  studentFromResume,
  WARM_SCORE,
  type WarmContact,
  warmthOf,
  workDomain,
} from './warmth';

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
    school: f.schools?.[0] ?? strs(t.schools)[0],
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
    ...(c.email ? { email: c.email } : {}),
    ...(c.url ? { url: c.url } : {}),
    ...(c.evidence?.length ? { evidence: c.evidence.slice(0, 4) } : {}),
    ...(c.email && c.emailConfidence ? { emailConfidence: c.emailConfidence } : {}),
    ...(c.warmth ? { tier: c.warmth.tier } : {}),
    ...(c.warmth?.why ? { why: c.warmth.why } : {}),
    ...(c.warmth?.bridge ? { bridge: c.warmth.bridge } : {}),
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
    current_org: string | null;
    grad_year: number | null;
  }>`
    select first_name, full_name, email, school, majors, current_org, grad_year from orbit.users
     where id = ${userId}::uuid`;
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
  const ctx = await warmContext(db, userId, u, req.homeCity, g);
  const slugOf = (c: Candidate) => linkedInSlugOf(cleanLinkedInUrl(c.linkedinUrl)) ?? undefined;
  const uniq = (xs: (string | undefined | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
  // every candidate against the student's people in one query, instead of two or three per candidate
  const knownBatch = async (todo: Candidate[]) => {
    if (!todo.length) return;
    const slugs = uniq(todo.map((c) => slugOf(c)?.toLowerCase()));
    const members = uniq(todo.map((c) => c.memberId));
    const emails = uniq(todo.map((c) => (c.email ? normalizeEmail(c.email) : undefined)));
    const names = uniq(todo.map((c) => c.name.trim().toLowerCase()));
    const rows = await db.sql<KnownRow>`
      select p.id, p.display_name, p.org_raw, p.headline, p.primary_email, p.linkedin_slug, p.linkedin_member_id,
             coalesce((select array_agg(i.value_norm) from orbit.person_identities i
                        where i.person_id = p.id and i.kind = 'email'), '{}') as emails,
             coalesce((select array_agg(i.value_norm) from orbit.person_identities i
                        where i.person_id = p.id and i.kind in ('linkedin_slug', 'linkedin_member')), '{}') as linkedin_ids
        from orbit.people p
       where p.user_id = ${userId}::uuid and p.deleted_at is null and not p.is_self
         and (lower(p.linkedin_slug) = any(${slugs}::text[]) or p.linkedin_member_id = any(${members}::text[])
           or lower(p.primary_email) = any(${emails}::text[]) or lower(p.display_name) = any(${names}::text[])
           or exists (select 1 from orbit.person_identities i where i.person_id = p.id
                       and ((i.kind = 'email' and i.value_norm = any(${emails}::text[]))
                         or (i.kind in ('linkedin_slug', 'linkedin_member')
                             and i.value_norm = any(${[...slugs, ...members]}::text[])))))
       order by p.merged_into is null desc, p.id`;
    const idx = indexKnown(rows);
    const gr = rows.length ? await g() : undefined;
    for (const c of todo) {
      const hit = matchKnown(idx, c, {
        slug: slugOf(c),
        email: c.email ? normalizeEmail(c.email) : undefined,
        orgDomain: orgDomainsOf(c, ctx.orgDomains)[0],
      });
      known.set(c.key, hit ? { personId: hit.id, score: gr?.people.get(hit.id)?.score } : null);
    }
  };
  // the domain of a candidate's company from the company facts Orbit already holds (YC, LinkedIn pages), so a
  // LinkedIn-only candidate at a known startup can get an address too
  const domainBatch = async (todo: Candidate[]) => {
    const keys = uniq(todo.flatMap((c) => orgsOf(c)).flatMap((o) => [norm(o), normOrg(o)])).filter(
      (k) => k.length >= 2 && !ctx.orgDomains.has(k),
    );
    if (!keys.length) return;
    const facts = await db.sql<{ key: string; website: string }>`
      select distinct on (key) key, website from orbit_private.company_facts
       where website is not null and not coalesce(ambiguous_name, false) and key = any(${keys.slice(0, 300)}::text[])
       order by key, (source = 'linkedin') desc`;
    for (const f of facts) {
      const d = siteDomain(f.website);
      if (d) ctx.orgDomains.set(f.key, d);
    }
  };
  const sGoal = sourcingGoal(req, goal);
  // the ask's own org → domain pairs come first; the student's contacts teach the rest
  sGoal.orgs?.forEach((o, i) => {
    const d = sGoal.domains?.[i];
    if (d) ctx.orgDomains.set(norm(o), d.toLowerCase());
  });
  const mx = dnsMx(s.fetch);
  const year = now.getUTCFullYear();
  const result = await sourcePeople(
    {
      unipile: s.unipile,
      apollo: s.apollo,
      exa: s.exa,
      semanticScholar: s.semanticScholar,
      claude: s.claude.configured ? claudeDep(s.claude, userId) : undefined,
      web: webSourcesFor(s),
      fetch: s.fetch,
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
            // the school by any of its names, beside a word that says they studied or teach there
            isAlumni: !!schoolIn(
              norm([c.title, c.org, c.headline].filter(Boolean).join(' ')),
              user.school || undefined,
            ),
            currentTitle: c.title,
            headline: c.headline,
          } as Person,
          user,
        ),
      prefetch: async (cands) => {
        const todo = cands.filter((c) => !known.has(c.key));
        await domainBatch(todo);
        await knownBatch(todo);
      },
      warmthOf: (c, known) =>
        warmthOf(c, {
          student: ctx.student,
          known,
          warm: ctx.warm,
          domains: [workDomain(c.email), ...orgDomainsOf(c, ctx.orgDomains)].filter((d): d is string => !!d),
          year,
        }),
      fillEmails: (cands) => fillEmails(cands, { known: ctx.known, orgDomains: ctx.orgDomains, mx }),
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
      goal: sGoal,
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
  return {
    batchId: result.batchId,
    results,
    unconfigured: result.unconfigured,
    relaxed: result.relaxed,
    ...(result.assumedPlace ? { assumedPlace: result.assumedPlace } : {}),
    ...(result.notes.length ? { notes: result.notes } : {}),
  };
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
    // what the page said about them becomes the person's facts (plan 31), the research a first message is written
    // from; the same line is never written twice
    for (const text of (c.evidence ?? []).slice(0, 4))
      await db.sql`
        insert into orbit.facts (user_id, person_id, type, text, source_table, source_id, confidence)
        select ${userId}::uuid, ${personId}::uuid, 'sourced', ${text}, 'recommendations', ${rec.id}::uuid, 0.7
         where not exists (select 1 from orbit.facts where person_id = ${personId}::uuid and text = ${text} and deleted_at is null)`;
    if (c.email)
      await db.sql`
        update orbit.people set primary_email = ${normalizeEmail(c.email)}
         where id = ${personId}::uuid and user_id = ${userId}::uuid and primary_email is null`;
    // an address Orbit built rather than read is said so on the person, so a draft to it is sent knowingly
    const how =
      c.email && c.emailConfidence === 'guess'
        ? `Email ${c.email} is a guess from the usual first.last pattern, not confirmed`
        : c.email && c.emailConfidence === 'pattern'
          ? `Email ${c.email} follows the address pattern their company uses`
          : undefined;
    if (how)
      await db.sql`
        insert into orbit.facts (user_id, person_id, type, text, source_table, source_id, confidence)
        select ${userId}::uuid, ${personId}::uuid, 'sourced', ${how}, 'recommendations', ${rec.id}::uuid,
               ${c.emailConfidence === 'guess' ? 0.3 : 0.6}
         where not exists (select 1 from orbit.facts where person_id = ${personId}::uuid and text = ${how} and deleted_at is null)`;
    await db.sql`
      update orbit.recommendations set status = 'added', person_id = ${personId}::uuid where id = ${rec.id}::uuid`;
    // no research is queued here: research on a person starts only when the student asks for it on their page
    // (docs/plan/20, the founder's decision: no automatic or background research)
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

/**
 * Where sourcing reads the public web (plan 31): Exa when its key is set, Claude's own search otherwise, both through
 * the shared research cache. Tests hand in their own sources.
 */
export function webSourcesFor(s: Services): WebSource[] {
  if (s.web) return s.web;
  const cache = sqlSharedCache(s.db, () => s.now().getTime());
  const out: WebSource[] = [];
  if (s.exa.configured) out.push(exaWeb(s.exa, cache));
  const client =
    s.anthropic ??
    (s.env.anthropicKey
      ? new Anthropic({ apiKey: s.env.anthropicKey, fetch: s.fetch, maxRetries: 1 })
      : undefined);
  if (client) out.push(claudeWeb(client, cache, { model: GATHER_MODEL }));
  return out;
}

/** What the warmth tiers and the email finder read, loaded once per search. */
interface WarmCtx {
  student: StudentContext;
  warm: WarmContact[];
  known: KnownAddress[];
  /** normalized org name → the work domain most of the student's contacts there use */
  orgDomains: Map<string, string>;
}

async function warmContext(
  db: Db,
  userId: string,
  u: { school: string | null; current_org: string | null; grad_year: number | null } | undefined,
  homeCity: string | undefined,
  graph: () => Promise<UserGraph>,
): Promise<WarmCtx> {
  const [resume] = await db.sql<{ parsed: Record<string, unknown> | null }>`
    select parsed from orbit.uploads
     where user_id = ${userId}::uuid and kind = 'resume' and is_current order by created_at desc limit 1`;
  const student = studentFromResume(resume?.parsed, {
    school: u?.school,
    currentOrg: u?.current_org,
    gradYear: u?.grad_year,
    homeCity: typeof homeCity === 'string' ? homeCity.slice(0, 80) : undefined,
  });
  const emails = await db.sql<{ id: string; display_name: string; org_raw: string | null; email: string }>`
    select id, display_name, org_raw, primary_email as email from orbit.people
     where user_id = ${userId}::uuid and primary_email is not null and deleted_at is null and not is_self
     limit 5000`;
  const known = emails.map((e) => ({ name: e.display_name, email: e.email }));
  const emailOf = new Map(emails.map((e) => [e.id, e.email]));
  // the domain most contacts at an org use
  const tally = new Map<string, Map<string, number>>();
  for (const e of emails) {
    const d = workDomain(e.email);
    if (!d || !e.org_raw) continue;
    const k = norm(e.org_raw);
    const m = tally.get(k) ?? new Map<string, number>();
    m.set(d, (m.get(d) ?? 0) + 1);
    tally.set(k, m);
  }
  const orgDomains = new Map<string, string>();
  for (const [k, m] of tally) orgDomains.set(k, [...m].sort((a, b) => b[1] - a[1])[0]![0]);
  const gr = await graph();
  const warm: WarmContact[] = [...gr.people.values()]
    .filter((p) => p.score >= WARM_SCORE && !p.hidden && !p.doNotContact)
    .sort((a, b) => b.score - a.score)
    .map((p) => ({
      personId: p.id,
      name: p.displayName,
      score: p.score,
      org: p.org,
      email: emailOf.get(p.id),
    }));
  return { student, warm, known, orgDomains };
}
