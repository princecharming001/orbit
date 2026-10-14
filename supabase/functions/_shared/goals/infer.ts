/**
 * Goal inference (§1.6): after a chat turn whose user text mentions plans, Haiku reads the last turns with the
 * student's active goals and proposes the goals they state or clearly imply for themselves. A proposal whose quote is
 * not the student's own words is dropped, and nothing is saved: the chat asks "Want me to track this as a goal?" and
 * calls set_goal only on yes. Empty when Claude is unconfigured, over budget or refuses.
 */
import type { ChatTurn, ProposedGoal } from '@orbit/core/server/api';
import { GOAL_KINDS, type GoalKind } from '@orbit/core/types';
import { z } from 'zod/v4';
import type { Claude } from '../claude.ts';

export const GOAL_PROMPT_VERSION = 'goal-infer-v1';

export const GOAL_INFER_SYSTEM = [
  'You extract networking goals from a conversation with a student or early-career professional.',
  'Return only goals the user states or clearly implies for themselves. Do not invent targets.',
  'kind is one of recruiting, fundraising, sales, hiring, advice, cofounder, community, collaboration.',
  'If nothing new is stated, return {"goals": []}.',
].join('\n');

export const GOAL_TITLE_MAX = 60;

const list = z.array(z.string());

export const goalInferSchema = z.object({
  goals: z.array(
    z.object({
      kind: z.enum(GOAL_KINDS as unknown as [GoalKind, ...GoalKind[]]),
      title: z.string(),
      targets: z.object({ organizations: list, roles: list, geographies: list, people: list }),
      criteria: z.object({
        sector: z.string().nullable(),
        stage: z.string().nullable(),
        seniority: list.nullable(),
        skills: list.nullable(),
        keywords: list.nullable(),
      }),
      success_metric: z.string().nullable(),
      due_at: z.string().nullable(),
      is_update_of: z.string().nullable(),
      quote: z.string(),
    }),
  ),
});

/** The active goals the prompt is shown, so an update names the goal it refines. */
export interface KnownGoal {
  id: string;
  kind: string;
  title: string;
  targets: unknown;
}

const squash = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim();

const clean = (xs: string[] | null | undefined, max = 25) =>
  (xs ?? [])
    .map((x) => x.trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, max);

export async function inferGoals(
  claude: Claude,
  userId: string,
  turns: ChatTurn[],
  existing: KnownGoal[] = [],
): Promise<ProposedGoal[]> {
  const said = squash(
    turns
      .filter((t) => t.role === 'user')
      .map((t) => t.text)
      .join('\n'),
  );
  if (!said) return [];
  const r = await claude.structured({
    task: 'goal_infer',
    system: GOAL_INFER_SYSTEM,
    user: `<existing_goals>${JSON.stringify(
      existing.map((g) => ({ id: g.id, kind: g.kind, title: g.title, targets: g.targets })),
    )}</existing_goals>\n<conversation>${turns
      .slice(-6)
      .map((t) => `${t.role}: ${t.text.replace(/<\/?conversation>/g, '')}`)
      .join('\n')}</conversation>`,
    schema: goalInferSchema,
    userId,
  });
  if (!r.ok) return [];
  const ids = new Set(existing.map((g) => g.id));
  return r.data.goals
    .filter((g) => g.quote.trim() && said.includes(squash(g.quote)))
    .filter((g) => g.title.trim())
    .map((g) => {
      const criteria: ProposedGoal['criteria'] = {};
      if (g.criteria.sector?.trim()) criteria.sector = g.criteria.sector.trim().slice(0, 200);
      if (g.criteria.stage?.trim()) criteria.stage = g.criteria.stage.trim().slice(0, 200);
      for (const k of ['seniority', 'skills', 'keywords'] as const) {
        const v = clean(g.criteria[k]);
        if (v.length) criteria[k] = v;
      }
      return {
        kind: g.kind,
        title: g.title.trim().slice(0, GOAL_TITLE_MAX),
        targets: {
          organizations: clean(g.targets.organizations),
          roles: clean(g.targets.roles),
          geographies: clean(g.targets.geographies),
          people: clean(g.targets.people),
        },
        criteria,
        successMetric: g.success_metric?.trim().slice(0, 500) || null,
        dueAt: g.due_at && /^\d{4}-\d{2}-\d{2}$/.test(g.due_at) ? g.due_at : null,
        isUpdateOf: g.is_update_of && ids.has(g.is_update_of) ? g.is_update_of : null,
        quote: g.quote.trim(),
      };
    });
}
