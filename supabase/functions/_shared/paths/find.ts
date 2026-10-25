/**
 * Warm paths on the server (§4): the user's graph from orbit.people, tie_scores, ties and intro_requests in the core
 * routing shape; Unipile mutuals and Village introducers gathered (30-day cache) and stored as ties; then core's
 * `rankWarmPaths` for a person and `rankCompanyTargets` for a company. Each path gets a stable id (a hash of the
 * user and its nodes) and the names of its nodes.
 */
import {
  pairKeyOf,
  type RoutePerson,
  rankCompanyTargets,
  rankWarmPaths,
  type TargetInfo,
  type WarmPath,
} from '@orbit/core/graph/route';
import { combineTies, TIE_KINDS, type Tie, type TieKind, type TiePair } from '@orbit/core/graph/ties';
import { responsePrior } from '@orbit/core/recommend/score';
import { looksLikeMinor } from '@orbit/core/safety/rules';
import type { PathsFindRequest, PathsFindResponse } from '@orbit/core/server/api';
import { normalizeEmail, parseName } from '@orbit/core/text/normalize';
import type { GoalKind, Person } from '@orbit/core/types';
import { sha256Hex } from '../crypto.ts';
import type { Db } from '../db.ts';
import { HttpError } from '../http.ts';
import { cleanLinkedInUrl, linkedInSlugOf } from '../providers/unipileResearch';
import { sqlBudget, sqlCache } from '../research/bind.ts';
import { iso, num } from '../rows.ts';
import type { Services } from '../services.ts';
import {
  type ExternalResult,
  type ExternalTarget,
  gatherExternalCandidates,
  type PersonRef,
  type TieRow,
} from './externalCandidates';
import { enqueueHopEvidence, hopEvidenceFresh, linkedinAccountOf } from './hopJob';

const DAY = 86_400_000;

export interface GraphPerson extends RoutePerson {
  displayName: string;
  title?: string;
  org?: string;
  isAlumni: boolean;
  linkedinUrl?: string;
  memberId?: string;
  doNotContact: boolean;
}

export interface UserGraph {
  selfId: string | null;
  people: Map<string, GraphPerson>;
  pairs: Map<string, TiePair>;
  /** pairs the student said do not really know each other (plan 21 §3.5), keyed `${a}|${b}` with a < b */
  blocked: Set<string>;
}

const TIE_KIND_SET = new Set<string>(TIE_KINDS);

/** The user's people and ties in the shape core routes over. */
export async function loadGraph(db: Db, userId: string, now: Date): Promise<UserGraph> {
  const rows = await db.sql<{
    id: string;
    is_self: boolean;
    display_name: string;
    first_name: string | null;
    title: string | null;
    org_raw: string | null;
    org_name: string | null;
    is_alumni: boolean;
    linkedin_url: string | null;
    linkedin_member_id: string | null;
    hidden_at: Date | null;
    do_not_contact: boolean;
    last_interaction_at: Date | null;
    score: number | null;
    features: Record<string, number> | null;
  }>`
    select p.id, p.is_self, p.display_name, p.first_name, p.title, p.org_raw, o.name as org_name, p.is_alumni,
           p.linkedin_url, p.linkedin_member_id, p.hidden_at, p.do_not_contact, p.last_interaction_at,
           ts.score::int as score, ts.features
      from orbit.people p
      left join orbit.organizations o on o.id = p.org_id
      left join orbit.tie_scores ts on ts.user_id = p.user_id and ts.person_id = p.id
     where p.user_id = ${userId}::uuid and p.deleted_at is null and p.merged_into is null`;
  const intros = await db.sql<{
    introducer_person_id: string | null;
    status: string;
    asked_at: Date;
    outcome_at: Date | null;
  }>`
    select introducer_person_id, status, asked_at, outcome_at from orbit.intro_requests
     where user_id = ${userId}::uuid and introducer_person_id is not null`;
  const goals = await db.sql<{ targets: { organizations?: string[] } }>`
    select targets from orbit.goals where user_id = ${userId}::uuid and status = 'active' and deleted_at is null`;
  const targetOrgs = new Set(
    goals.flatMap((g) => g.targets?.organizations ?? []).map((o) => o.toLowerCase().trim()),
  );
  const owes = await db.sql<{ person_id: string }>`
    select distinct m.from_person_id as person_id from orbit.threads t
      join orbit.messages m on m.thread_id = t.id and m.sent_at = t.last_at
     where t.user_id = ${userId}::uuid and t.last_direction = 'in' and t.is_networking
       and m.from_person_id is not null and t.last_at > ${new Date(now.getTime() - 30 * DAY)}::timestamptz`;
  const owesSet = new Set(owes.map((o) => o.person_id));

  let selfId: string | null = null;
  const people = new Map<string, GraphPerson>();
  for (const r of rows) {
    if (r.is_self) {
      selfId = r.id;
      continue;
    }
    const mine = intros.filter((i) => i.introducer_person_id === r.id);
    const declined = mine
      .filter((i) => i.status === 'declined')
      .map((i) => iso(i.outcome_at ?? i.asked_at)!)
      .sort()
      .pop();
    const org = r.org_name ?? r.org_raw ?? undefined;
    people.set(r.id, {
      id: r.id,
      name: r.first_name ?? r.display_name.split(/\s+/)[0]!,
      displayName: r.display_name,
      score: r.score ?? 0,
      reciprocity: num(r.features?.reciprocity),
      sharesGoalTargetOrg: !!org && targetOrgs.has(org.toLowerCase().trim()),
      askedRecently: mine.some((i) => now.getTime() - new Date(i.asked_at).getTime() < 30 * DAY),
      introducedUserBefore: mine.some((i) => i.status === 'intro_made' || i.status === 'meeting'),
      owesReply: owesSet.has(r.id),
      lastContactAt: iso(r.last_interaction_at) ?? undefined,
      hidden: !!r.hidden_at || r.do_not_contact,
      declinedIntroAt: declined,
      title: r.title ?? undefined,
      org,
      isAlumni: r.is_alumni,
      linkedinUrl: r.linkedin_url ?? undefined,
      memberId: r.linkedin_member_id ?? undefined,
      doNotContact: r.do_not_contact,
    });
  }
  const tieRows = await db.sql<{
    id: string;
    a_person_id: string;
    b_person_id: string;
    kind: string;
    weight: number;
    confidence: number;
    evidence: Record<string, unknown>;
    first_seen_at: Date;
    last_seen_at: Date;
  }>`
    select id, a_person_id, b_person_id, kind, weight, confidence, evidence, first_seen_at, last_seen_at
      from orbit.ties where user_id = ${userId}::uuid`;
  const ties: Tie[] = [];
  for (const t of tieRows) {
    if (!TIE_KIND_SET.has(t.kind) || t.a_person_id === selfId || t.b_person_id === selfId) continue;
    ties.push({
      id: `${t.a_person_id}|${t.b_person_id}|${t.kind}`,
      userId,
      aId: t.a_person_id,
      bId: t.b_person_id,
      kind: t.kind as TieKind,
      weight: num(t.weight),
      confidence: num(t.confidence),
      evidence: t.evidence ?? {},
      firstSeenAt: iso(t.first_seen_at) ?? undefined,
      lastSeenAt: iso(t.last_seen_at) ?? undefined,
    });
  }
  const blockedRows = await db.sql<{ a_person_id: string; b_person_id: string }>`
    select a_person_id, b_person_id from orbit.blocked_pairs where user_id = ${userId}::uuid`;
  const blocked = new Set(blockedRows.map((b) => pairKeyOf(b.a_person_id, b.b_person_id)));
  return { selfId, people, pairs: combineTies(ties, now), blocked };
}

/** A local person for a LinkedIn member, URL or slug, or a unique exact name; null when unknown. */
export async function resolvePersonRef(db: Db, userId: string, p: PersonRef): Promise<string | null> {
  const url = cleanLinkedInUrl(p.linkedinUrl);
  const slug = linkedInSlugOf(url);
  const [hit] = await db.sql<{ id: string }>`
    select p.id from orbit.people p
     where p.user_id = ${userId}::uuid and p.deleted_at is null and not p.is_self
       and ((${p.memberId ?? null}::text is not null and p.linkedin_member_id = ${p.memberId ?? null})
         or (${slug ?? null}::text is not null and lower(p.linkedin_slug) = ${slug ?? null})
         or (${url ?? null}::text is not null and lower(rtrim(p.linkedin_url, '/')) = ${url ?? null})
         or exists (select 1 from orbit.person_identities i where i.person_id = p.id
                     and ((i.kind = 'linkedin_member' and i.value_norm = ${p.memberId ?? ''})
                       or (i.kind = 'linkedin_slug' and i.value_norm = ${slug ?? ''}))))
     order by p.merged_into is null desc limit 1`;
  if (hit) return hit.id;
  const name = p.name.trim().toLowerCase();
  if (!name) return null;
  const byName = await db.sql<{ id: string }>`
    select id from orbit.people
     where user_id = ${userId}::uuid and deleted_at is null and not is_self and lower(display_name) = ${name}
     limit 2`;
  return byName.length === 1 ? byName[0]!.id : null;
}

/** An existing person for the reference, or a new one (sources = [source]). */
export async function ensurePerson(
  db: Db,
  userId: string,
  p: PersonRef & { org?: string; title?: string; email?: string; location?: string },
  source: string,
): Promise<string> {
  const found = await resolvePersonRef(db, userId, p);
  if (found) return found;
  const url = cleanLinkedInUrl(p.linkedinUrl);
  const slug = linkedInSlugOf(url);
  const name = p.name.trim() || slug || 'Unknown';
  const parsed = parseName(name);
  const [first, ...rest] = name.split(/\s+/);
  const [row] = await db.sql<{ id: string }>`
    insert into orbit.people (user_id, display_name, first_name, last_name, name_norm, title, org_raw, headline,
                              location, linkedin_url, linkedin_slug, linkedin_member_id, primary_email, sources,
                              first_seen_at)
    values (${userId}::uuid, ${name}, ${parsed.first || first || null}, ${parsed.last || rest.join(' ') || null},
            ${parsed.normalized || name.toLowerCase()},
            ${p.title ?? null}, ${p.org ?? null}, ${p.headline ?? null}, ${p.location ?? null}, ${url ?? null},
            ${slug ?? null}, ${p.memberId ?? null}, ${p.email ? normalizeEmail(p.email) : null}, ${[source]}::text[],
            now())
    returning id`;
  const id = row!.id;
  if (p.memberId)
    await db.sql`
      insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source)
      values (${userId}::uuid, ${id}::uuid, 'linkedin_member', ${p.memberId}, ${p.memberId}, ${source})
      on conflict (user_id, kind, value_norm) do nothing`;
  if (slug)
    await db.sql`
      insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source)
      values (${userId}::uuid, ${id}::uuid, 'linkedin_slug', ${slug}, ${url ?? slug}, ${source})
      on conflict (user_id, kind, value_norm) do nothing`;
  if (p.email)
    await db.sql`
      insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source)
      values (${userId}::uuid, ${id}::uuid, 'email', ${normalizeEmail(p.email)}, ${p.email}, ${source})
      on conflict (user_id, kind, value_norm) do nothing`;
  return id;
}

export async function upsertTies(db: Db, ties: TieRow[]): Promise<void> {
  for (const t of ties)
    await db.sql`
      insert into orbit.ties (user_id, a_person_id, b_person_id, kind, weight, confidence, evidence, first_seen_at,
                              last_seen_at)
      values (${t.user_id}::uuid, ${t.a_person_id}::uuid, ${t.b_person_id}::uuid, ${t.kind}, ${t.weight}::real,
              ${t.confidence}::real, ${t.evidence}::jsonb, ${t.last_seen_at}::timestamptz, ${t.last_seen_at}::timestamptz)
      on conflict (user_id, a_person_id, b_person_id, kind) do update set
        weight = greatest(orbit.ties.weight, excluded.weight), confidence = excluded.confidence,
        evidence = excluded.evidence, last_seen_at = greatest(orbit.ties.last_seen_at, excluded.last_seen_at)`;
}

async function externalFor(s: Services, userId: string, target: ExternalTarget): Promise<ExternalResult> {
  const accountId = await linkedinAccountOf(s.db, userId);
  const [u] = await s.db.sql<{ email: string }>`select email from orbit.users where id = ${userId}::uuid`;
  return gatherExternalCandidates(
    {
      unipile: s.unipile,
      village: s.village,
      cache: sqlCache(s.db, s.now),
      budget: sqlBudget(s.db, s.now),
      clock: () => s.now().getTime(),
      resolvePerson: (p) => resolvePersonRef(s.db, userId, p),
    },
    {
      userId,
      target,
      unipileAccountId: accountId,
      villageUser: u ? { externalUserId: userId, email: u.email } : undefined,
    },
  );
}

export async function pathId(userId: string, nodes: string[]): Promise<string> {
  return `path_${(await sha256Hex(`${userId}:${nodes.join('>')}`)).slice(0, 16)}`;
}

function namesOf(g: UserGraph, nodes: string[], extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of nodes)
    out[n] = n === 'user' ? 'You' : (g.people.get(n)?.displayName ?? extra[n] ?? 'Someone');
  return out;
}

function personLike(p: GraphPerson): Person {
  return {
    isAlumni: p.isAlumni,
    currentTitle: p.title,
    lastInteractionAt: p.lastContactAt,
  } as Person;
}

export async function findPaths(
  s: Services,
  userId: string,
  req: PathsFindRequest,
): Promise<PathsFindResponse> {
  const db = s.db;
  const now = s.now();
  let goalKind: GoalKind | undefined;
  if (req.goalId) {
    const [g] = await db.sql<{ kind: GoalKind }>`
      select kind from orbit.goals where id = ${req.goalId}::uuid and user_id = ${userId}::uuid`;
    if (!g) throw new HttpError(404, 'not_found', 'no such goal');
    goalKind = g.kind;
  }
  const t = req.target as Record<string, unknown>;
  const [me] = await db.sql<{ school: string | null; majors: string[] }>`
    select school, majors from orbit.users where id = ${userId}::uuid`;
  const user = { school: me?.school ?? '', majors: me?.majors ?? [] };

  // ---- a company ---------------------------------------------------------------------------------------------
  if (typeof t.company === 'string' && !('personId' in t) && !('linkedinUrl' in t)) {
    const company = t.company.trim();
    const domain = typeof t.domain === 'string' ? t.domain.trim().toLowerCase() : undefined;
    if (!company) throw new HttpError(400, 'bad_request', 'company is required');
    const ext = await externalFor(s, userId, { kind: 'company', domain, name: company });
    // Village's people at the company become targets (they are who the introducers reach)
    for (const c of ext.candidates) {
      if (!c.personId || c.target.personId || !c.target.name) continue;
      const tid = await ensurePerson(
        db,
        userId,
        { name: c.target.name, linkedinUrl: c.target.linkedinUrl, org: company },
        'village',
      );
      c.target.personId = tid;
      const [lo, hi] = c.personId < tid ? [c.personId, tid] : [tid, c.personId];
      if (lo !== hi)
        ext.ties.push({
          user_id: userId,
          a_person_id: lo,
          b_person_id: hi,
          kind: 'village_path',
          weight: c.warmth,
          confidence: 0.7,
          evidence: c.evidence,
          last_seen_at: now.toISOString(),
        });
    }
    await upsertTies(db, ext.ties);
    const g = await loadGraph(db, userId, now);
    const atCompany = await db.sql<{ id: string }>`
      select p.id from orbit.people p left join orbit.organizations o on o.id = p.org_id
       where p.user_id = ${userId}::uuid and p.deleted_at is null and not p.is_self
         and (lower(p.org_raw) = lower(${company}) or lower(o.name) = lower(${company})
              or (${domain ?? null}::text is not null and ${domain ?? ''} = any(o.domains)))`;
    const villageTargets = ext.candidates.map((c) => c.target.personId).filter((x): x is string => !!x);
    const ids = [...new Set([...atCompany.map((r) => r.id), ...villageTargets])];
    const targets: TargetInfo[] = ids
      .map((id) => g.people.get(id))
      .filter((p): p is GraphPerson => !!p && !p.doNotContact && !looksLikeMinor({ title: p.title }))
      .map((p) => ({
        id: p.id,
        name: p.name,
        isAlum: p.isAlumni,
        title: p.title,
        pReply: p.score > 0 ? responsePrior(personLike(p), user) : undefined,
      }));
    const chosen = rankCompanyTargets({
      targets,
      goal: goalKind,
      people: g.people,
      pairs: g.pairs,
      blockedPairs: g.blocked,
      now,
    });
    const paths: PathsFindResponse['paths'] = [];
    for (const x of chosen)
      paths.push({ ...x.path, id: await pathId(userId, x.path.nodes), names: namesOf(g, x.path.nodes) });
    return {
      paths,
      ...(paths.length ? {} : { fallback: 'cold' as const }),
      sources: sourcesOf(ext),
      unconfigured: ext.unconfigured,
    };
  }

  // ---- a person ------------------------------------------------------------------------------------------------
  let targetId: string;
  if (typeof t.personId === 'string') {
    const [p] = await db.sql<{ id: string }>`
      select id from orbit.people where id = ${t.personId}::uuid and user_id = ${userId}::uuid and deleted_at is null`;
    if (!p) throw new HttpError(404, 'not_found', 'no such person');
    targetId = p.id;
  } else if (typeof t.linkedinUrl === 'string' && cleanLinkedInUrl(t.linkedinUrl)) {
    targetId = await ensurePerson(
      db,
      userId,
      {
        name: typeof t.name === 'string' ? t.name : '',
        linkedinUrl: t.linkedinUrl,
        org: typeof t.company === 'string' ? t.company : undefined,
      },
      'paths',
    );
  } else throw new HttpError(400, 'bad_request', 'target needs personId, linkedinUrl or company');

  let g = await loadGraph(db, userId, now);
  const target = g.people.get(targetId);
  if (!target) throw new HttpError(404, 'not_found', 'no such person');
  if (looksLikeMinor({ title: target.title })) return { paths: [], sources: [], unconfigured: [] };
  const ext = await externalFor(s, userId, {
    kind: 'person',
    personId: targetId,
    memberId: target.memberId,
    linkedinUrl: target.linkedinUrl,
    name: target.displayName,
    company: target.org,
  });
  const learned = await learnMemberIds(db, userId, ext);
  if (ext.ties.length || learned) {
    await upsertTies(db, ext.ties);
    g = await loadGraph(db, userId, now);
  }
  const r = rankWarmPaths({
    targetId,
    target: {
      name: target.name,
      isAlum: target.isAlumni,
      title: target.title,
      pReply: target.score > 0 ? responsePrior(personLike(target), user) : undefined,
    },
    goal: goalKind,
    people: g.people,
    pairs: g.pairs,
    blockedPairs: g.blocked,
    now,
  });
  const paths: PathsFindResponse['paths'] = [];
  for (const p of r.paths as WarmPath[])
    paths.push({ ...p, id: await pathId(userId, p.nodes), names: namesOf(g, p.nodes) });
  const hopEvidence = await queueHopEvidence(s, userId, g, targetId, r.paths, ext);
  return {
    paths,
    ...(r.fallback ? { fallback: r.fallback } : {}),
    ...(r.direct ? { direct: { personId: targetId, ...r.direct } } : {}),
    sources: sourcesOf(ext),
    unconfigured: ext.unconfigured,
    ...(hopEvidence ? { hopEvidence } : {}),
  };
}

/**
 * Keep the member id LinkedIn's mutuals search gave for a person found by the same LinkedIn profile address (never
 * by name: names never bind, plan 17): hop evidence matches by member id only (plan 21 §6). Returns how many were new.
 */
async function learnMemberIds(db: Db, userId: string, ext: ExternalResult): Promise<number> {
  let n = 0;
  for (const c of ext.candidates) {
    const slug = linkedInSlugOf(c.linkedinUrl);
    if (c.source !== 'linkedin_mutual' || !c.personId || !c.memberId || !slug) continue;
    const rows = await db.sql`
      update orbit.people set linkedin_member_id = ${c.memberId}
       where id = ${c.personId}::uuid and user_id = ${userId}::uuid and linkedin_member_id is null
         and lower(linkedin_slug) = ${slug}
         and not exists (select 1 from orbit.people q where q.user_id = ${userId}::uuid
                          and q.linkedin_member_id = ${c.memberId} and q.id <> ${c.personId}::uuid)
         and not exists (select 1 from orbit.person_identities i where i.user_id = ${userId}::uuid
                          and i.kind = 'linkedin_member' and i.value_norm = ${c.memberId}
                          and i.person_id <> ${c.personId}::uuid)
      returning 1`;
    if (!rows.length) continue;
    n++;
    await db.sql`
      insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source)
      values (${userId}::uuid, ${c.personId}::uuid, 'linkedin_member', ${c.memberId}, ${c.memberId}, 'unipile')
      on conflict (user_id, kind, value_norm) do nothing`;
  }
  return n;
}

/**
 * The target's LinkedIn mutuals with member ids, best first: the introducers of the ranked routes in order, then the
 * other mutuals by the student's tie score. Blocked pairs are left out (nothing to weigh).
 */
export function mutualsToWeigh(
  g: UserGraph,
  targetId: string,
  paths: Pick<WarmPath, 'nodes'>[],
  candidateIds: string[],
): string[] {
  const ids = new Set<string>();
  for (const id of candidateIds) ids.add(id);
  for (const p of g.pairs.values()) {
    if (!p.kinds.includes('linkedin_mutual')) continue;
    if (p.aId === targetId) ids.add(p.bId);
    else if (p.bId === targetId) ids.add(p.aId);
  }
  const ok = (id: string) =>
    id !== targetId && !!g.people.get(id)?.memberId && !g.blocked.has(pairKeyOf(id, targetId));
  const out: string[] = [];
  for (const p of paths) {
    const before = p.nodes[p.nodes.length - 2];
    if (before && ids.has(before) && ok(before) && !out.includes(before)) out.push(before);
  }
  const rest = [...ids]
    .filter((id) => ok(id) && !out.includes(id))
    .sort((a, b) => (g.people.get(b)?.score ?? 0) - (g.people.get(a)?.score ?? 0) || a.localeCompare(b));
  return [...out, ...rest];
}

/**
 * Queue the hop_evidence job for a person target (plan 21 §4: only when the student opens a target, never on a timer)
 * when it has mutuals with member ids and its evidence is not fresh; 'queued' tells the app hop words may still change.
 */
async function queueHopEvidence(
  s: Services,
  userId: string,
  g: UserGraph,
  targetId: string,
  paths: Pick<WarmPath, 'nodes'>[],
  ext: ExternalResult,
): Promise<PathsFindResponse['hopEvidence']> {
  const target = g.people.get(targetId);
  if (!target?.memberId || !s.unipile.configured) return undefined;
  const accountId = await linkedinAccountOf(s.db, userId);
  if (!accountId) return undefined;
  const fromSearch = ext.candidates
    .filter((c) => c.source === 'linkedin_mutual' && c.personId)
    .map((c) => c.personId!);
  const mutuals = mutualsToWeigh(g, targetId, paths, fromSearch);
  if (!mutuals.length) return undefined;
  if (await hopEvidenceFresh(sqlCache(s.db, s.now), userId, accountId, target.memberId)) return 'checked';
  await enqueueHopEvidence(s, userId, targetId, mutuals);
  return 'queued';
}

function sourcesOf(ext: ExternalResult): string[] {
  const out = ['graph'];
  const asked = (prefix: string) => !ext.skipped.some((x) => x.startsWith(prefix));
  if (!ext.unconfigured.includes('unipile') && asked('mutuals')) out.push('linkedin_mutual');
  if (!ext.unconfigured.includes('village') && asked('village')) out.push('village');
  return out;
}

/** The best path P to a known person, for sourcing reach (§6.2); a direct tie counts as its score. */
export function bestReach(
  g: UserGraph,
  personId: string,
  goal: GoalKind | undefined,
  now: Date,
): number | null {
  const p = g.people.get(personId);
  if (!p) return null;
  const r = rankWarmPaths({
    targetId: personId,
    target: { name: p.name, isAlum: p.isAlumni, title: p.title },
    goal,
    people: g.people,
    pairs: g.pairs,
    blockedPairs: g.blocked,
    now,
    limit: 1,
  });
  if (r.direct) return Math.min(1, r.direct.score / 100);
  return r.paths[0]?.p ?? null;
}
