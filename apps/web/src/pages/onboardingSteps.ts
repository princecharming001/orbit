/**
 * The setup steps, by the number stored in `user.onboardingStep`. The numbers were chosen so a student part way through
 * the older, longer setup lands on the step that comes next for them: 2 was About you (now You), 3 Goals, 4 Resume
 * (now LinkedIn, the next step), 5 Google (now Gmail), and 6 to 8 (LinkedIn, meeting notes, preferences) are past the
 * last step, so they land on Ready. A stored 5.5 (the "Rate a few people" step setup used to have) lands on Ready too:
rating is now asked in a popup a couple of days after setup (components/account/RatePrompt.tsx).
 * The written questions (plan 24) sit between Goals and LinkedIn, 3.2 to 3.9, so a student already past Goals is not
 * sent back to them.
 *
 * The address of a step is its number minus one (Welcome is /onboarding/0, Gmail /onboarding/4), except the written
 * questions, which have words (/onboarding/aim): a fraction like 2.2 is not an address anyone should have to read.
 */
export const STEP = {
  welcome: 1,
  you: 2,
  goals: 3,
  aim: 3.2,
  story: 3.4,
  people: 3.6,
  style: 3.8,
  job: 3.9,
  linkedin: 4,
  gmail: 5,
  ready: 6,
} as const;
export type StepKey = keyof typeof STEP;

export const STEP_TITLES: Record<number, string> = {
  [STEP.welcome]: 'Welcome',
  [STEP.you]: 'You',
  [STEP.goals]: 'Goals',
  [STEP.aim]: 'Your aim',
  [STEP.story]: 'Your story',
  [STEP.people]: 'Who to meet',
  [STEP.style]: 'How Orbit helps',
  [STEP.job]: 'A job',
  [STEP.linkedin]: 'LinkedIn',
  [STEP.gmail]: 'Gmail',
  [STEP.ready]: 'Ready',
};

/** The written questions, in order (plan 24). */
export const QUESTION_STEPS: readonly number[] = [STEP.aim, STEP.story, STEP.people, STEP.style, STEP.job];

/** The written questions' addresses. */
const WORD_ADDRESS: Record<number, string> = {
  [STEP.aim]: 'aim',
  [STEP.story]: 'story',
  [STEP.people]: 'people',
  [STEP.style]: 'style',
  [STEP.job]: 'job',
};
const STEP_OF_WORD = new Map(Object.entries(WORD_ADDRESS).map(([n, w]) => [w, Number(n)]));

/** Steps the student may skip; the progress bar marks a skipped one as skipped, never as done. */
export const OPTIONAL_STEPS: ReadonlySet<number> = new Set([...QUESTION_STEPS, STEP.linkedin, STEP.gmail]);

/**
 * The steps shown, in order. Gmail is a step only on a copy of Orbit where Google sign-in is set up: a step that could
 * only say "not available" is not shown. Signed in to an Orbit account (`account`), Google is already connected by the
 * sign-in, so there is no Gmail step.
 */
export function visibleSteps(google: boolean, account = false): number[] {
  const start = [STEP.welcome, STEP.you, STEP.goals, ...QUESTION_STEPS, STEP.linkedin];
  if (account) return [...start, STEP.ready];
  return google ? [...start, STEP.gmail, STEP.ready] : [...start, STEP.ready];
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

/** The address part of a step: "0" for Welcome, "aim" for the first written question. */
export function stepAddress(step: number): string {
  return WORD_ADDRESS[step] ?? String(step - 1);
}

/** The step an address part opens ("aim", "3", "4.5"); NaN for anything else. */
export function stepFromAddress(part: string | undefined): number {
  if (part === undefined) return STEP.welcome;
  const word = STEP_OF_WORD.get(part.toLowerCase());
  if (word !== undefined) return word;
  return /^\d+(\.\d+)?$/.test(part) ? Number(part) + 1 : Number.NaN;
}

/** The address of a stored step, after it is resolved to a shown one. */
export function stepPath(stored: number, google: boolean, account = false): string {
  return `/onboarding/${stepAddress(resolveStep(stored, google, account))}`;
}

export type StepStatus = 'done' | 'skipped' | 'current' | 'todo';

/** Each shown step's state for the progress bar: an optional step passed without doing it is skipped, not done. */
export function stepStatuses(steps: number[], current: number, did: Record<number, boolean>): StepStatus[] {
  const idx = steps.indexOf(current);
  return steps.map((s, i) =>
    i === idx ? 'current' : i > idx ? 'todo' : OPTIONAL_STEPS.has(s) && !did[s] ? 'skipped' : 'done',
  );
}
