/**
 * Plan 44 §9.4: features the owner switches on for every student from Settings, Launch, with no redeploy. The server
 * says which are on beside the user (`features` on /auth/session and /auth/me); the browser reads one answer,
 * `featureOn`, everywhere a feature shows (the side bar, the route, the command palette, the chat tool and its card).
 *
 * Off by default everywhere. The demo student has every feature (it runs on sample data and never needs the server).
 * A local copy with no Orbit account has none: nothing is offered that cannot work there.
 */
import { useEffect, useState } from 'react';
import {
  accountUser,
  isServerUser,
  isSignedIn,
  refreshAccount,
  subscribeSession,
} from '../integrations/orbitApi';

/** engine/demo DEMO_USER_ID (not imported: demo.ts imports most of the engine) */
const DEMO_ID = 'demo-user';

export const FEATURES = ['roles'] as const;
export type Feature = (typeof FEATURES)[number];

/** What a test set by hand: a feature on or off whatever the account says. */
const forced = new Map<Feature, boolean>();

/** Test hook: force a feature on or off (undefined goes back to what the account says). */
export function setFeatureForTests(feature: Feature, on: boolean | undefined): void {
  if (on === undefined) forced.delete(feature);
  else forced.set(feature, on);
  for (const l of listeners) l();
}

const listeners = new Set<() => void>();

/** Whether `feature` is on for this student. */
export function featureOn(feature: Feature, userId: string | undefined): boolean {
  const f = forced.get(feature);
  if (f !== undefined) return f;
  if (!userId) return false;
  if (userId === DEMO_ID) return true;
  if (!isServerUser(userId)) return false;
  return (accountUser()?.features ?? []).includes(feature);
}

let asked = false;

/** Whether `feature` is on, followed as the session changes; the server is asked once a visit. */
export function useFeature(feature: Feature, userId: string | undefined): boolean {
  const [on, setOn] = useState(() => featureOn(feature, userId));
  useEffect(() => {
    const update = () => setOn(featureOn(feature, userId));
    update();
    listeners.add(update);
    const off = subscribeSession(update);
    if (isSignedIn() && !asked) {
      asked = true;
      void refreshAccount().then(update, () => {
        asked = false;
      });
    }
    return () => {
      listeners.delete(update);
      off();
    };
  }, [feature, userId]);
  return on;
}

/** Test hook: the next useFeature asks the server again. */
export function resetFeatureAskForTests(): void {
  asked = false;
}
