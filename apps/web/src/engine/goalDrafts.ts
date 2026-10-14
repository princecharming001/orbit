/**
 * Drafts in the register of the student's goal (plan 16 §7.3): a fundraising, sales, hiring, advice, co-founder,
 * community or collaboration goal gets core's goal-family template instead of the recruiting coffee-chat note. The
 * recruiting goal, and anyone without goals, keep the v1 drafts.
 */
import type { MessageKind, Person, User } from '@orbit/core';
import { type ComposeKind, composeFallback } from '@orbit/core';
import { goalForPerson } from './goals';

/** The v1 kinds a goal family rewrites, and the compose kind each becomes. */
const COMPOSE_OF: Partial<Record<MessageKind, ComposeKind>> = {
  outreach: 'first_touch',
  bump: 'bump',
  thank_you: 'thank_you',
  intro_request: 'intro_request',
};

export interface GoalDraft {
  goalId: string;
  subject?: string;
  body: string;
}

/** The draft for a non-recruiting goal, or undefined to keep the v1 draft. */
export async function goalRegisterDraft(
  user: User,
  person: Person,
  kind: MessageKind,
  channel: 'gmail' | 'linkedin',
  chatGoalId?: string,
): Promise<GoalDraft | undefined> {
  const compose = COMPOSE_OF[kind];
  if (!compose) return undefined;
  const goal = await goalForPerson(user.id, chatGoalId);
  if (!goal || goal.kind === 'recruiting') return undefined;
  const c = goal.criteria as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const about = user.school ? `a student at ${user.school}` : undefined;
  const out = composeFallback({
    kind: compose,
    goal: goal.kind,
    channel,
    personId: person.id,
    goalId: goal.id,
    user: {
      firstName: user.firstName || user.fullName.split(' ')[0] || 'me',
      school: user.school || undefined,
      about,
      company: str(c.company),
      pitch: str(goal.description) ?? str(c.pitch),
      traction: str(c.traction),
    },
    recipient: {
      firstName: person.firstName || person.displayName.split(' ')[0] || 'there',
      org: person.currentOrganizationRaw,
      title: person.currentTitle,
    },
    topic: str(c.topic) ?? str(c.sector) ?? goal.title,
  });
  return { goalId: goal.id, subject: out.subject ?? undefined, body: out.body };
}
