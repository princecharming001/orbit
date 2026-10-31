/**
 * The playbook lines the LLM draft prompt appends (plan 28 §3b): the register of the student's goal and what a first
 * message to this kind of firm asks and never asks. Pure: the same context gives the same two rules.
 */
import { ASK_RULES, DRAFT_RULES, type DraftContext, firmKindOf, goalOf, sectorOf } from '@orbit/core';

export function draftKnowledgeRules(ctx: Pick<DraftContext, 'user' | 'person'>): [string, string] {
  const goal = goalOf(ctx.user);
  const person = { title: ctx.person.title, org: ctx.person.org, industry: ctx.person.orgIndustry };
  const sector = sectorOf(person, ctx.user.targetFunctions);
  const firm = firmKindOf(person, sector, ctx.user.targetFunctions);
  return [`13. ${DRAFT_RULES[goal]}`, `14. ${ASK_RULES[firm]}`];
}
