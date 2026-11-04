/**
 * The playbook lines the LLM draft prompt appends (plan 30): the niche playbook for this message's step, shared with
 * the server's composeDraft through `draftPlaybook`, so both pick the same niche and the same norms. Pure: the same
 * context gives the same lines.
 */
import { type DraftContext, type DraftPlaybook, draftPlaybook, goalOf } from '@orbit/core';

export function draftPlaybookFor(ctx: Pick<DraftContext, 'user' | 'person' | 'kind'>): DraftPlaybook {
  return draftPlaybook({
    goalKind: goalOf(ctx.user),
    goalText: [ctx.user.goalText, ctx.user.aim, ctx.user.cycleLabel].filter(Boolean).join('. '),
    recipient: { title: ctx.person.title, org: ctx.person.org, industry: ctx.person.orgIndustry },
    targetFunctions: ctx.user.targetFunctions,
    degree: ctx.user.degree,
    kind: ctx.kind,
    goalBrief: ctx.user.goalBrief,
  });
}

/** The playbook as numbered rules, after the prompt's own twelve. */
export function draftKnowledgeRules(ctx: Pick<DraftContext, 'user' | 'person' | 'kind'>): string[] {
  return draftPlaybookFor(ctx).lines.map((l, i) => `${13 + i}. ${l}`);
}
