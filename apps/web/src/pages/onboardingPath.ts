import { googleClientId } from '../integrations/google';
import { isSignedIn } from '../integrations/orbitApi';
import { stepPath } from './onboardingSteps';

/** The address of a stored onboarding step (Welcome, stored as 1, is /onboarding/0); see `onboardingSteps.ts`. */
export function onboardingPath(step: number): string {
  return stepPath(step, !!googleClientId(), isSignedIn());
}
