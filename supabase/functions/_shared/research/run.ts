/**
 * Research as a service (§5): the routes ask for a dossier (returned at once when one from the last 30 days exists,
 * else queued as `enrich.dossier`), and the job builds it with buildDossier bound to the real providers, Claude,
 * budget, cache and tables. A needs_disambiguation dossier is answered with /research/choose, which pins the chosen
 * person's organization and LinkedIn URL and runs the job again.
 */
import type { ResearchPersonResponse } from '@orbit/core/server/api';
import { dossierFromRow, type Row } from '@orbit/core/server/mappers';
import type { Dossier } from '@orbit/core/types';
import { buildUserContext, loadUserRow, userFirstName } from '../compose/context.ts';
import type { Db } from '../db.ts';
import { HttpError } from '../http.ts';
import { cleanLinkedInUrl, linkedInSlugOf } from '../providers/unipileResearch';
import { isoRow } from '../rows.ts';
import type { Services } from '../services.ts';
import { claudeDep, sqlBudget, sqlResearchDb } from './bind.ts';
import { buildDossier, type DisambiguationCandidate, type DossierOutcome, type GoalKind } from './dossier';

const GOAL_SENTENCE: Record<GoalKind, (title: string) => string> = {
  recruiting: (t) => `find their next role (${t})`,
  advice: (t) => `get advice on ${t}`,
  fundraising: (t) => `raise money (${t})`,
  sales: (t) => `find customers (${t})`,
  hiring: (t) => `hire (${t})`,
  cofounder: (t) => `find a cofounder (${t})`,
  community: (t) => `grow a community (${t})`,
  collaboration: (t) => `find research collaborators (${t})`,
};

export function goalSentence(goal: { kind: string; title: string } | undefined): string {
  if (!goal) return 'build relationships with people who matter to their work';
  const f = GOAL_SENTENCE[goal.kind as GoalKind];
  return f ? f(goal.title) : goal.title;
}

export async function dossierRow(
  db: Db,
  userId: string,
  personId: string,
): Promise<Record<string, unknown> | undefined> {
  const [r] = await db.sql<Record<string, unknown>>`
    select * from orbit.dossiers where user_id = ${userId}::uuid and person_id = ${personId}::uuid`;
  return r;
}

export const toDossier = (r: Record<string, unknown>): Dossier =>
  dossierFromRow({ ...isoRow(r), cost_usd: String(r.cost_usd ?? '0') } as unknown as Row.Dossiers);

async function ownedPerson(db: Db, userId: string, personId: unknown): Promise<string> {
  if (typeof personId !== 'string' || !/^[0-9a-f-]{36}$/i.test(personId))
    throw new HttpError(400, 'bad_request', 'personId is required');
  const [p] = await db.sql<{ id: string }>`
    select id from orbit.people where id = ${personId}::uuid and user_id = ${userId}::uuid and deleted_at is null`;
  if (!p) throw new HttpError(404, 'not_found', 'no such person');
  return p.id;
}

async function queueDossier(
  s: Services,
  userId: string,
  personId: string,
  payload: Record<string, unknown>,
  key: string,
) {
  await s.queue.enqueue({
    kind: 'enrich.dossier',
    userId,
    payload: { personId, ...payload },
    dedupeKey: key,
  });
}

/** POST /research/person */
export async function requestDossier(
  s: Services,
  userId: string,
  req: { personId?: unknown; goalId?: unknown; refresh?: unknown },
): Promise<ResearchPersonResponse> {
  const personId = await ownedPerson(s.db, userId, req.personId);
  const goalId = typeof req.goalId === 'string' ? req.goalId : null;
  const refresh = req.refresh === true;
  const now = s.now();
  const row = await dossierRow(s.db, userId, personId);
  if (row && !refresh) {
    const status = row.status as Dossier['status'];
    const fresh = new Date(row.expires_at as string).getTime() > now.getTime();
    if ((status === 'ready' || status === 'partial') && row.content && fresh)
      return { status, dossier: toDossier(row) };
    if (status === 'needs_disambiguation') return { status, dossier: toDossier(row) };
    if (status === 'pending' && now.getTime() - new Date(row.updated_at as string).getTime() < 10 * 60_000)
      return { status: 'queued', dossier: toDossier(row) };
  }
  await s.db.sql`
    insert into orbit.dossiers (user_id, person_id, goal_id, status, expires_at)
    values (${userId}::uuid, ${personId}::uuid, ${goalId}::uuid, 'pending', ${new Date(now.getTime() + 86_400_000)}::timestamptz)
    on conflict (user_id, person_id) do update set status = 'pending', goal_id = coalesce(excluded.goal_id, orbit.dossiers.goal_id),
      error = null`;
  const key = refresh
    ? `dossier:${personId}:refresh:${now.toISOString().slice(0, 16)}`
    : `dossier:${personId}`;
  await queueDossier(s, userId, personId, { goalId, refresh }, key);
  const after = await dossierRow(s.db, userId, personId);
  return { status: 'queued', dossier: after ? toDossier(after) : null };
}

/** POST /research/get */
export async function getDossier(db: Db, userId: string, personId: unknown): Promise<Dossier | null> {
  const id = await ownedPerson(db, userId, personId);
  const row = await dossierRow(db, userId, id);
  return row ? toDossier(row) : null;
}

/** POST /research/choose */
export async function chooseCandidate(
  s: Services,
  userId: string,
  req: { personId?: unknown; candidateIndex?: unknown },
): Promise<ResearchPersonResponse> {
  const personId = await ownedPerson(s.db, userId, req.personId);
  const row = await dossierRow(s.db, userId, personId);
  if (row?.status !== 'needs_disambiguation')
    throw new HttpError(409, 'not_ambiguous', 'there is no choice to make for this person');
  const cands = (row.candidates as DisambiguationCandidate[] | null) ?? [];
  const i = Number(req.candidateIndex);
  if (!Number.isInteger(i) || i < 0 || i >= cands.length)
    throw new HttpError(400, 'bad_request', 'no such candidate');
  const c = cands[i]!;
  const url = cleanLinkedInUrl(c.url);
  await s.db.sql`
    update orbit.people set org_raw = coalesce(${c.org ?? null}, org_raw),
           linkedin_url = coalesce(${url ?? null}, linkedin_url), linkedin_slug = coalesce(${linkedInSlugOf(url) ?? null}, linkedin_slug)
     where id = ${personId}::uuid and user_id = ${userId}::uuid`;
  await s.db.sql`
    update orbit.dossiers set status = 'pending', error = null
     where user_id = ${userId}::uuid and person_id = ${personId}::uuid`;
  await queueDossier(
    s,
    userId,
    personId,
    { refresh: true, chosen: c },
    `dossier:${personId}:choose:${s.now().toISOString().slice(0, 16)}`,
  );
  const after = await dossierRow(s.db, userId, personId);
  return { status: 'queued', dossier: after ? toDossier(after) : null };
}

/** The enrich.dossier job (§5.2): one person, the user's goal, the real providers. */
export async function runDossierJob(
  s: Services,
  userId: string,
  payload: { personId?: unknown; goalId?: unknown; refresh?: unknown; chosen?: unknown },
): Promise<DossierOutcome> {
  const db = s.db;
  const personId = await ownedPerson(db, userId, payload.personId);
  const [p] = await db.sql<{
    display_name: string;
    title: string | null;
    org_raw: string | null;
    org_name: string | null;
    location: string | null;
    linkedin_url: string | null;
    linkedin_member_id: string | null;
    emails: string[] | null;
  }>`
    select p.display_name, p.title, p.org_raw, o.name as org_name, p.location, p.linkedin_url, p.linkedin_member_id,
           (select array_agg(i.value_norm) from orbit.person_identities i where i.person_id = p.id and i.kind = 'email') as emails
      from orbit.people p left join orbit.organizations o on o.id = p.org_id where p.id = ${personId}::uuid`;
  const goalId =
    typeof payload.goalId === 'string'
      ? payload.goalId
      : ((await dossierRow(db, userId, personId))?.goal_id as string | null | undefined);
  const [goal] = goalId
    ? await db.sql<{ id: string; kind: GoalKind; title: string; criteria: Record<string, unknown> }>`
        select id, kind, title, criteria from orbit.goals where id = ${goalId}::uuid and user_id = ${userId}::uuid`
    : [];
  const user = await loadUserRow(db, userId);
  const [acct] = await db.sql<{ external_account_id: string | null }>`
    select external_account_id from orbit.integration_accounts
     where user_id = ${userId}::uuid and provider = 'linkedin' and status = 'active'`;
  const chosen = payload.chosen as DisambiguationCandidate | undefined;
  return buildDossier(
    {
      exa: s.exa,
      unipile: s.unipile,
      claude: claudeDep(s.claude, userId),
      db: sqlResearchDb(db, s.now),
      budget: sqlBudget(db, s.now),
      clock: () => s.now().getTime(),
    },
    {
      userId,
      personId,
      goalId: goal?.id ?? null,
      goalKind: goal?.kind,
      goalSentence: goalSentence(goal),
      field: typeof goal?.criteria?.topic === 'string' ? goal.criteria.topic : undefined,
      user: { firstName: userFirstName(user), context: await buildUserContext(db, user) },
      person: {
        name: p!.display_name,
        title: p!.title ?? undefined,
        org: chosen?.org ?? p!.org_name ?? p!.org_raw ?? undefined,
        location: p!.location ?? undefined,
        linkedinMemberId: p!.linkedin_member_id ?? undefined,
        linkedinUrl: p!.linkedin_url ?? undefined,
        emails: p!.emails ?? undefined,
      },
      unipileAccountId: acct?.external_account_id ?? undefined,
      refresh: payload.refresh === true || !!chosen,
    },
  );
}
