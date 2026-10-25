/**
 * The student's own words about their goals (plan 24), saved from setup, Settings and the chat. They live in the
 * `goals` row in this browser. In account mode they also go to the server (/settings/profile `about`), where the
 * server's drafts read them, and two of them ride on the recruiting goal record that syncs everywhere: what they are
 * going for is its description, what a win looks like its success metric.
 */
import type { OwnWords, RecruitingGoals, User } from '@orbit/core';
import { ownWordsOf } from '@orbit/core';
import { db } from '../db/schema';
import { isServerUser } from '../integrations/orbitApi';
import { listGoals, saveGoal } from './goals';
import { pushProfileSettings, saveGoals } from './settings';

export type OwnWordsPatch = Partial<Pick<RecruitingGoals, keyof OwnWords>>;

/** Save some of the answers (others keep their stored value; '' clears one) and tell the server, in account mode. */
export async function saveOwnWords(user: Pick<User, 'id'>, patch: OwnWordsPatch): Promise<RecruitingGoals> {
  const before = ownWordsOf(await db.goals.get(user.id));
  const goals = await saveGoals(user.id, patch);
  const after = ownWordsOf(goals);
  if (JSON.stringify(before) !== JSON.stringify(after)) await syncOwnWords(user, after, before);
  return goals;
}

/** The aim and the win onto the recruiting goal; in account mode the whole set to the server too. Best effort. */
async function syncOwnWords(user: Pick<User, 'id'>, after: OwnWords, before: OwnWords): Promise<void> {
  if (isServerUser(user.id))
    void pushProfileSettings(user.id, { about: Object.keys(after).length ? after : null });
  await mirrorOnRecruitingGoal(user, after, before).catch(() => undefined);
}

/**
 * The recruiting goal says what the student is going for (its description) and what a win is (its success metric),
 * in their words. A description or metric someone wrote there by other means is only replaced when it was the old
 * answer, so the chat's own edits to a goal are kept.
 */
async function mirrorOnRecruitingGoal(
  user: Pick<User, 'id'>,
  after: OwnWords,
  before: OwnWords,
): Promise<void> {
  const goal = (await listGoals(user.id)).find((g) => g.kind === 'recruiting' && g.status === 'active');
  if (!goal) return;
  const description =
    !goal.description || goal.description === before.aim ? (after.aim ?? '') : goal.description;
  const successMetric =
    !goal.successMetric || goal.successMetric === before.success ? (after.success ?? '') : goal.successMetric;
  if ((goal.description ?? '') === description && (goal.successMetric ?? '') === successMetric) return;
  await saveGoal(user, {
    id: goal.id,
    kind: goal.kind,
    // '' clears what an earlier answer put there
    description,
    successMetric,
  });
}
