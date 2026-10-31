/**
 * The playbook block for a student (plan 28 §3b): etiquette always, then the sections for their goals, as one text
 * the loop puts after the frozen system block. It changes only when their goals or target functions change, so a
 * conversation keeps one block and the cache stays warm.
 */
import { knowledgeBlockText, knowledgeFor } from '@orbit/core';
import { db } from '../../db/schema';
import { activeGoals } from '../../engine/goals';

export async function knowledgeTextFor(userId: string): Promise<string> {
  const [goals, legacy] = await Promise.all([
    activeGoals(userId).catch(() => []),
    db.goals.get(userId).catch(() => undefined),
  ]);
  const sections = knowledgeFor(
    goals.map((g) => ({ kind: g.kind, title: g.title, targets: { roles: g.targets.roles } })),
    legacy?.targetFunctions ?? [],
  );
  return knowledgeBlockText(sections);
}
