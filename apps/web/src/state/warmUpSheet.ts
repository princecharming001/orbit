import type { CoffeeChat } from '@orbit/core';
import { useSyncExternalStore } from 'react';

/**
 * The start sheet of an automated warm-up (components/WarmUpStartSheet.tsx) is one dialog for the whole app, mounted
 * in the shell: any place that starts a warm-up (a person's page, Discover, a card on Drafts, the morning brief) asks
 * for it here, and the sheet shows the plan and the comment for that person.
 */
export interface WarmUpSheetRequest {
  personId: string;
  /** where the warm-up was started from, kept on the chat it opens */
  source: CoffeeChat['source'];
  /** called once the warm-up has started (the page that asked may want to say so, or move on) */
  onStarted?: (chat: CoffeeChat) => void;
}

let current: WarmUpSheetRequest | undefined;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** Show the start sheet for a person. */
export function openWarmUpSheet(req: WarmUpSheetRequest): void {
  current = req;
  emit();
}

export function closeWarmUpSheet(): void {
  if (!current) return;
  current = undefined;
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const read = () => current;

/** The person the sheet is open for, if it is open. */
export function useWarmUpSheet(): WarmUpSheetRequest | undefined {
  return useSyncExternalStore(subscribe, read, read);
}
