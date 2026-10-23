import { useSyncExternalStore } from 'react';
import { readPrefs, subscribePrefs } from '../integrations/prefs';

const read = () => !!readPrefs().showReasoning;

/**
 * Whether Orbit shows its explanations: the grey lines that say how it got somewhere (the chat's notes before each
 * step, why a route goes through someone, where a list came from). Off by default; one switch in Settings, Claude,
 * or "show your reasoning" in the chat. Hidden lines stay available as a tooltip where they explain a name.
 */
export function useShowReasoning(): boolean {
  return useSyncExternalStore(subscribePrefs, read, read);
}
