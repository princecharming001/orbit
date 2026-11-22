/**
 * The sourcing fit prompt (§6.4) and its structured output (§6.2: `{fit: 0..1, reasons: string[≤2]}` per candidate,
 * batched 20 per call on Haiku 5.5). The ≤ 2 reasons and the 0..1 range are enforced after parsing.
 */
import { z } from '../providers/zod';

export const PROMPT_VERSION = 'sourcing-fit-v1.1';
export const FIT_BATCH = 20;

export function fitSystem(userFirstName: string, checks = 0): string {
  return [
    `Score how well each candidate matches what ${userFirstName} is looking for. 0 = not a match, 1 = an excellent match.`,
    'Judge only from the fields given. Do not reward fame. Give at most two short reasons.',
    ...(checks
      ? [
          `Also answer each of the ${checks} numbered checks for every candidate, in order, in "checks": "yes" when the fields say so, "no" when they say otherwise, "unknown" when they do not say. Never guess: a name, a company or a title alone that does not settle a check is "unknown". A company or a fund is not a person: when the candidate is not a person, answer "no" to every check.`,
        ]
      : []),
  ].join('\n');
}

export interface FitCandidate {
  id: string;
  name: string;
  title?: string;
  org?: string;
  location?: string;
  headline?: string;
  /** what the page said about them (plan 31) */
  evidence?: string[];
  source: string;
}

export function fitUser(
  lookingFor: { title: string; criteria: string[]; checks?: string[] },
  candidates: FitCandidate[],
): string {
  return [
    `<looking_for>${JSON.stringify({ goal: lookingFor.title, criteria: lookingFor.criteria })}</looking_for>`,
    ...(lookingFor.checks?.length
      ? [`<checks>${lookingFor.checks.map((c, i) => `${i + 1}. ${c}`).join('\n')}</checks>`]
      : []),
    `<candidates>${candidates.map((c) => JSON.stringify(c)).join('\n')}</candidates>`,
  ].join('\n');
}

export const fitSchema = z.object({
  scores: z.array(
    z.object({
      id: z.string(),
      fit: z.number(),
      reasons: z.array(z.string()),
      /** one answer per numbered check, in order; absent when the search asked none */
      checks: z.array(z.enum(['yes', 'no', 'unknown'])).optional(),
    }),
  ),
});
export type FitOutput = z.infer<typeof fitSchema>;
