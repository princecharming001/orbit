import { useSyncExternalStore } from 'react';

/**
 * The plan of a warm-up under way (components/WarmUpPlanView.tsx) is one dialog for the whole app, mounted in the
 * shell: anywhere a warm-up is listed (the person's page, the pipeline card, Coming up on Drafts) opens it here, and it
 * shows every step of that chat's warm-up with its day and time.
 */
export interface WarmUpPlanRequest {
  chatId: string;
}

let current: WarmUpPlanRequest | undefined;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** Show the plan of a chat's warm-up. */
export function openWarmUpPlan(req: WarmUpPlanRequest): void {
  current = req;
  emit();
}

export function closeWarmUpPlan(): void {
  if (!current) return;
  current = undefined;
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const read = () => current;

/** The chat whose plan is open, if it is open. */
export function useWarmUpPlan(): WarmUpPlanRequest | undefined {
  return useSyncExternalStore(subscribe, read, read);
}
