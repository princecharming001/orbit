/**
 * Goals of every kind (plan 16 §1.3): 0 to 5 active goals, each with a kind, a title, targets and criteria. In
 * account mode they live on the server (/goals/*) and the browser keeps a copy; in local mode they live in the
 * browser's `userGoals` table. The v1 recruiting details (functions, pace, cycle) stay in the `goals` row.
 */
import type { ChatTurn, Goal, GoalKind, ProposedGoal, RecruitingGoals, User } from '@orbit/core';
import { functionCodeFor, functionsIn, GOAL_KINDS, industriesIn, locationsIn, newId } from '@orbit/core';
import { db } from '../db/schema';
import { type ApiFailure, callApi, isAccountMode, isServerUser, isSignedIn } from '../integrations/orbitApi';
import { writeFromServer } from './serverSync';
import { addTargetCompany } from './targets';

export const MAX_ACTIVE_GOALS = 5;

export const GOAL_KIND_LABELS: Record<GoalKind, string> = {
  recruiting: 'Recruiting',
  fundraising: 'Fundraising',
  sales: 'Sales',
  hiring: 'Hiring',
  advice: 'Advice',
  cofounder: 'Co-founder',
  community: 'Community',
  collaboration: 'Research collaborators',
};

/** What each kind means, as a chip's longer label and the default title of a new goal. */
export const GOAL_KIND_TITLES: Record<GoalKind, string> = {
  recruiting: 'Land an internship or job',
  fundraising: 'Raise money for my startup',
  sales: 'Find customers',
  hiring: 'Hire for my team',
  advice: 'Get advice from people ahead of me',
  cofounder: 'Find a co-founder',
  community: 'Build my community',
  collaboration: 'Find research collaborators',
};

export function isGoalKind(v: unknown): v is GoalKind {
  return typeof v === 'string' && (GOAL_KINDS as readonly string[]).includes(v);
}

export type GoalInput = Partial<Omit<Goal, 'id' | 'userId' | 'createdAt' | 'updatedAt'>> & {
  id?: string;
  kind: GoalKind;
  title?: string;
};

export class GoalError extends Error {}

/** Goals that are not archived, active first, then by priority. */
export async function listGoals(userId: string, opts: { includeDone?: boolean } = {}): Promise<Goal[]> {
  const rows = await db.userGoals.where('userId').equals(userId).toArray();
  return rows
    .filter((g) => !g.deletedAt && (opts.includeDone || g.status !== 'done'))
    .sort(
      (a, b) =>
        (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) ||
        a.priority - b.priority ||
        a.createdAt.localeCompare(b.createdAt),
    );
}

export async function activeGoals(userId: string): Promise<Goal[]> {
  return (await listGoals(userId)).filter((g) => g.status === 'active');
}

/** Account mode with a session: goals go through the server. */
function viaServer(): boolean {
  return isAccountMode() && isSignedIn();
}

function serverError(r: ApiFailure): GoalError {
  if (r.code === 'too_many_goals')
    return new GoalError(`You can have ${MAX_ACTIVE_GOALS} active goals. Archive one first.`);
  return new GoalError(r.message);
}

/** Refresh the browser's copy from the server (account mode); a no-op in local mode. */
export async function refreshGoals(userId: string): Promise<void> {
  if (!viaServer()) return;
  const r = await callApi('/goals/list', {});
  if (!r.ok) return;
  await writeFromServer('goals', r.value.goals, userId);
}

/** Create a goal (no id) or change one. At most five are active at once. */
export async function saveGoal(user: Pick<User, 'id'>, input: GoalInput, now = new Date()): Promise<Goal> {
  const existing = input.id ? await db.userGoals.get(input.id) : undefined;
  if (input.id && (!existing || existing.userId !== user.id || existing.deletedAt))
    throw new GoalError('Orbit has no goal with that id. List the goals first.');
  const status = input.status ?? existing?.status ?? 'active';
  if (status === 'active' && existing?.status !== 'active') {
    const active = await activeGoals(user.id);
    if (active.length >= MAX_ACTIVE_GOALS)
      throw new GoalError(`You can have ${MAX_ACTIVE_GOALS} active goals. Archive one first.`);
  }
  const title = (input.title ?? existing?.title ?? GOAL_KIND_TITLES[input.kind]).trim().slice(0, 200);
  const targets = {
    organizations: input.targets?.organizations ?? existing?.targets.organizations ?? [],
    roles: input.targets?.roles ?? existing?.targets.roles ?? [],
    geographies: input.targets?.geographies ?? existing?.targets.geographies ?? [],
    people: input.targets?.people ?? existing?.targets.people ?? [],
  };
  const at = now.toISOString();
  const goal: Goal = {
    ...(existing ?? {}),
    id: existing?.id ?? newId('goal'),
    userId: user.id,
    kind: input.kind,
    title,
    description: input.description ?? existing?.description,
    targets,
    criteria: input.criteria ?? existing?.criteria ?? {},
    successMetric: input.successMetric ?? existing?.successMetric,
    priority: input.priority ?? existing?.priority ?? 2,
    status,
    autonomyLevel: input.autonomyLevel ?? existing?.autonomyLevel,
    dueAt: input.dueAt ?? existing?.dueAt,
    source: input.source ?? existing?.source ?? 'user',
    evidence: input.evidence ?? existing?.evidence,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
  };
  if (viaServer()) {
    const { userId: _u, createdAt: _c, updatedAt: _up, deletedAt: _d, ...body } = goal;
    const r = await callApi('/goals/upsert', {
      goal: { ...body, id: existing ? goal.id : undefined },
    });
    if (!r.ok) throw serverError(r);
    await writeFromServer('goals', [r.value.goal], user.id);
    const saved = (await db.userGoals.get(r.value.goal.id)) ?? r.value.goal;
    await mirrorRecruitingGoal(user.id, saved);
    return saved;
  }
  await db.userGoals.put(goal);
  await mirrorRecruitingGoal(user.id, goal);
  return goal;
}

// ---- one recruiting goal everywhere ----------------------------------------------------------------------------------

/**
 * Recruiting targets in the names the readers use: function codes, the roles the Goals page shows, industries,
 * places and companies. Drafts read the cycle and functions from the `goals` row, recommendations its functions and
 * industries plus the target companies, and the chat the goal records; every write goes to all of them.
 */
export interface RecruitingTargets {
  functions?: string[];
  roles?: string[];
  industries?: string[];
  locations?: string[];
  organizations?: string[];
  cycleLabel?: string;
  /** what the student said they are after, for a new goal's title */
  phrase?: string;
  stage?: string;
}

const lower = (s: string) => s.trim().toLowerCase();
/** "New York" and "NYC" are one place, "fintech" and "Fintech" one industry. */
const samePlace = (s: string) => lower(locationsIn(s)[0] ?? s);
const sameIndustry = (s: string) => lower(industriesIn(s)[0] ?? s);

/** `have` plus whatever in `add` is not already there (by `key`, ignoring case); the new ones listed separately. */
function joinLists(
  have: string[],
  add: string[] | undefined,
  key: (s: string) => string = lower,
): { list: string[]; added: string[] } {
  const seen = new Set(have.map(key));
  const added: string[] = [];
  for (const a of add ?? []) {
    const t = a.trim();
    if (!t || seen.has(key(t))) continue;
    seen.add(key(t));
    added.push(t);
  }
  return { list: [...have, ...added], added };
}

export interface RecruitingChange {
  goals: RecruitingGoals;
  /** what was new, by field */
  added: Required<
    Pick<RecruitingTargets, 'functions' | 'roles' | 'industries' | 'locations' | 'organizations'>
  >;
  cycleChanged: boolean;
}

/** Add targets to the `goals` row (creating it when missing) and the target companies. Never removes anything. */
export async function mergeRecruitingRow(userId: string, t: RecruitingTargets): Promise<RecruitingChange> {
  const cur = await db.goals.get(userId);
  const functions = joinLists(cur?.targetFunctions ?? [], t.functions);
  const roles = joinLists(cur?.targetRoles ?? [], t.roles);
  const industries = joinLists(cur?.targetIndustries ?? [], t.industries, sameIndustry);
  const locations = joinLists(cur?.targetLocations ?? [], t.locations, samePlace);
  const cycleChanged = !!t.cycleLabel && t.cycleLabel !== cur?.cycleLabel;
  const goals: RecruitingGoals = {
    userId,
    cycleLabel: (cycleChanged ? t.cycleLabel : cur?.cycleLabel)?.trim() || 'This cycle',
    targetRoles: roles.list,
    targetFunctions: functions.list,
    targetIndustries: industries.list,
    targetLocations: locations.list,
    freeText: cur?.freeText,
    ambition: cur?.ambition ?? 2,
  };
  const changed =
    !cur ||
    cycleChanged ||
    functions.added.length + roles.added.length + industries.added.length + locations.added.length > 0;
  if (changed) await db.goals.put(goals);
  const organizations: string[] = [];
  for (const o of t.organizations ?? [])
    if ((await addTargetCompany(userId, o)) === 'added') organizations.push(o);
  return {
    goals,
    added: {
      functions: functions.added,
      roles: roles.added,
      industries: industries.added,
      locations: locations.added,
      organizations,
    },
    cycleChanged,
  };
}

/**
 * A recruiting goal record's targets, written into the `goals` row and the target companies that drafts and
 * recommendations read (set_goal for recruiting, or a goal edited in the chat).
 */
export async function mirrorRecruitingGoal(userId: string, g: Goal): Promise<RecruitingChange | undefined> {
  if (g.kind !== 'recruiting' || g.status !== 'active' || g.deletedAt) return undefined;
  const c = g.criteria as Record<string, unknown>;
  const sector = typeof c.sector === 'string' ? c.sector : '';
  const functions = [
    ...g.targets.roles.map((r) => functionCodeFor(r)).filter((f): f is string => !!f),
    ...functionsIn([g.title, ...g.targets.roles].join(' , ')),
  ];
  const industries = sector ? (industriesIn(sector).length ? industriesIn(sector) : [sector.trim()]) : [];
  const locations = g.targets.geographies.flatMap((p) =>
    locationsIn(p).length ? locationsIn(p) : [p.trim()],
  );
  return mergeRecruitingRow(userId, {
    functions,
    roles: g.targets.roles,
    industries,
    locations,
    organizations: g.targets.organizations,
  });
}

const capFirst = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * Targets the student stated in chat, applied everywhere at once: the `goals` row and target companies (drafts,
 * recommendations, the Goals page) and the active recruiting goal record (the chat), created when there is none and
 * fewer than five goals are active. Lists only grow; nothing the student set is removed.
 */
export async function applyRecruitingTargets(
  user: Pick<User, 'id'>,
  t: RecruitingTargets,
  opts: { evidence?: string; now?: Date } = {},
): Promise<RecruitingChange & { goal?: Goal }> {
  const change = await mergeRecruitingRow(user.id, t);
  const active = await activeGoals(user.id);
  const existing = active.find((g) => g.kind === 'recruiting');
  const criteria: Record<string, unknown> = { ...(existing?.criteria ?? {}) };
  if (t.industries?.length && typeof criteria.sector !== 'string') criteria.sector = t.industries.join(', ');
  if (t.stage && typeof criteria.stage !== 'string') criteria.stage = t.stage;
  let goal: Goal | undefined;
  try {
    if (existing) {
      const targets = {
        organizations: joinLists(existing.targets.organizations, t.organizations).list,
        roles: joinLists(existing.targets.roles, t.roles).list,
        geographies: joinLists(existing.targets.geographies, t.locations, samePlace).list,
        people: existing.targets.people,
      };
      const same =
        JSON.stringify(targets) === JSON.stringify(existing.targets) &&
        JSON.stringify(criteria) === JSON.stringify(existing.criteria);
      goal = same
        ? existing
        : await saveGoal(user, { id: existing.id, kind: 'recruiting', targets, criteria }, opts.now);
    } else if (active.length < MAX_ACTIVE_GOALS) {
      const title = capFirst((t.phrase ?? '').replace(/\s+/g, ' ').trim()).slice(0, 60) || undefined;
      goal = await saveGoal(
        user,
        {
          kind: 'recruiting',
          title,
          targets: {
            organizations: t.organizations ?? [],
            roles: t.roles ?? [],
            geographies: t.locations ?? [],
            people: [],
          },
          criteria,
          source: 'inferred',
          evidence: opts.evidence?.slice(0, 400),
        },
        opts.now,
      );
    }
  } catch {
    // the goal record is a bonus here: the row drafts and recommendations read is already updated
  }
  return { ...change, goal };
}

/** Archive a goal: it stops steering drafts and sourcing; its chats stay. */
export async function archiveGoal(user: Pick<User, 'id'>, goalId: string, now = new Date()): Promise<Goal> {
  const g = await db.userGoals.get(goalId);
  if (!g || g.userId !== user.id || g.deletedAt)
    throw new GoalError('Orbit has no goal with that id. List the goals first.');
  if (viaServer()) {
    const r = await callApi('/goals/archive', { id: goalId });
    if (!r.ok) throw serverError(r);
  }
  const done: Goal = { ...g, status: 'done', deletedAt: now.toISOString(), updatedAt: now.toISOString() };
  await writeFromServer('goals', [done], user.id);
  return done;
}

/** The goal a draft to this person serves: the chat's goal, else the only active goal there is. */
export async function goalForPerson(userId: string, chatGoalId?: string): Promise<Goal | undefined> {
  if (chatGoalId) {
    const g = await db.userGoals.get(chatGoalId);
    if (g && !g.deletedAt) return g;
  }
  const active = await activeGoals(userId);
  return active.length === 1 ? active[0] : undefined;
}

/** "Fundraising: Raise our pre-seed (Sequoia, a16z)": one line for the snapshot and the chat. */
export function goalLine(g: Goal): string {
  const targets = [...g.targets.organizations, ...g.targets.roles].slice(0, 3);
  return `${GOAL_KIND_LABELS[g.kind]}: ${g.title}${targets.length ? ` (${targets.join(', ')})` : ''}${g.dueAt ? `, by ${g.dueAt}` : ''}`;
}

/**
 * Goals the server reads in the last chat turns (§1.6), never saved: the chat offers each one and calls set_goal
 * only when the student says yes. Empty outside account mode or when the server has no Claude.
 */
export async function inferGoalsFromChat(user: Pick<User, 'id'>, turns: ChatTurn[]): Promise<ProposedGoal[]> {
  if (!isServerUser(user.id) || !turns.length) return [];
  const r = await callApi('/goals/infer', { turns });
  return r.ok ? r.value.goals : [];
}
