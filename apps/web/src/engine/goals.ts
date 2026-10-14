/**
 * Goals of every kind (plan 16 §1.3): 0 to 5 active goals, each with a kind, a title, targets and criteria. In
 * account mode they live on the server (/goals/*) and the browser keeps a copy; in local mode they live in the
 * browser's `userGoals` table. The v1 recruiting details (functions, pace, cycle) stay in the `goals` row.
 */
import type { ChatTurn, Goal, GoalKind, ProposedGoal, User } from '@orbit/core';
import { GOAL_KINDS, newId } from '@orbit/core';
import { db } from '../db/schema';
import { type ApiFailure, callApi, isAccountMode, isServerUser, isSignedIn } from '../integrations/orbitApi';
import { writeFromServer } from './serverSync';

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
    return (await db.userGoals.get(r.value.goal.id)) ?? r.value.goal;
  }
  await db.userGoals.put(goal);
  return goal;
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
