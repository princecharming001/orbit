/**
 * The setup steps, by the number stored in `user.onboardingStep` (the address shows the number minus one, so Welcome
 * is /onboarding/0). The numbers were chosen so a student part way through the older, longer setup lands on the
 * step that comes next for them: 2 was About you (now You), 3 Goals, 4 Resume (now LinkedIn, the next step), 5
 * Google (now Gmail), and 6 to 8 (LinkedIn, meeting notes, preferences) are past the last step, so they land on Ready.
 * "Rate a few people" (account mode only) sits between Gmail and Ready, so it is 5.5 (its address is /onboarding/4.5).
 */
export const STEP = { welcome: 1, you: 2, goals: 3, linkedin: 4, gmail: 5, rate: 5.5, ready: 6 } as const;
export type StepKey = keyof typeof STEP;

export const STEP_TITLES: Record<number, string> = {
  [STEP.welcome]: 'Welcome',
  [STEP.you]: 'You',
  [STEP.goals]: 'Goals',
  [STEP.linkedin]: 'LinkedIn',
  [STEP.gmail]: 'Gmail',
  [STEP.rate]: 'Rate',
  [STEP.ready]: 'Ready',
};

/** Steps the student may skip; the progress bar marks a skipped one as skipped, never as done. */
export const OPTIONAL_STEPS: ReadonlySet<number> = new Set([STEP.linkedin, STEP.gmail, STEP.rate]);

/**
 * The steps shown, in order. Gmail is a step only on a copy of Orbit where Google sign-in is set up: a step that could
 * only say "not available" is not shown. Signed in to an Orbit account (`account`), Google is already connected by the
 * sign-in, so there is no Gmail step; the optional "Rate a few people" comes before Ready instead.
 */
export function visibleSteps(google: boolean, account = false): number[] {
  if (account) return [STEP.welcome, STEP.you, STEP.goals, STEP.linkedin, STEP.rate, STEP.ready];
  return google
    ? [STEP.welcome, STEP.you, STEP.goals, STEP.linkedin, STEP.gmail, STEP.ready]
    : [STEP.welcome, STEP.you, STEP.goals, STEP.linkedin, STEP.ready];
}

/**
 * The step a stored number opens: the first shown step at or after it, so a hidden step (Gmail without Google) or a
 * number left by the older setup moves forward, never back. Anything past the last step is the last step.
 */
export function resolveStep(stored: number, google: boolean, account = false): number {
  const steps = visibleSteps(google, account);
  const n = Number.isFinite(stored) ? stored : STEP.welcome;
  return steps.find((s) => s >= n) ?? steps[steps.length - 1]!;
}

/** The address of a stored step, after it is resolved to a shown one. */
export function stepPath(stored: number, google: boolean, account = false): string {
  return `/onboarding/${resolveStep(stored, google, account) - 1}`;
}

export type StepStatus = 'done' | 'skipped' | 'current' | 'todo';

/** Each shown step's state for the progress bar: an optional step passed without doing it is skipped, not done. */
export function stepStatuses(steps: number[], current: number, did: Record<number, boolean>): StepStatus[] {
  const idx = steps.indexOf(current);
  return steps.map((s, i) =>
    i === idx ? 'current' : i > idx ? 'todo' : OPTIONAL_STEPS.has(s) && !did[s] ? 'skipped' : 'done',
  );
}
