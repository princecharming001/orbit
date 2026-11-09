/**
 * The composer's mode: Auto (Orbit picks per message, plan 37 §5), Smart (full Claude) or Quick (Claude at low effort).
 * It is a UI preference the engine reads when it builds a request; it lives here, outside React, so the engine can
 * read it without a hook. A student who never picked one gets Auto; one who picked Smart or Quick keeps it.
 */
export type ChatMode = 'auto' | 'smart' | 'quick';
const KEY = 'orbit:chatMode';

export function getChatMode(): ChatMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'quick' || v === 'smart' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function setChatMode(mode: ChatMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}

export const MODE_LABEL: Record<ChatMode, { label: string; hint: string }> = {
  auto: {
    label: 'Auto',
    hint: 'Orbit picks. Quick for lookups and small edits, Smart for drafts and judgement calls.',
  },
  smart: { label: 'Smart', hint: 'Claude thinks it through. Best for drafts and judgement calls.' },
  quick: { label: 'Quick', hint: 'Claude at low effort. Faster, for lookups and small edits.' },
};

/** What Auto picked for the last reply, for the mode menu: 'smart' or 'quick', or nothing yet. */
let lastAuto: 'smart' | 'quick' | undefined;
const listeners = new Set<() => void>();

export function setLastAutoChoice(effort: 'low' | 'medium') {
  lastAuto = effort === 'low' ? 'quick' : 'smart';
  for (const l of listeners) l();
}

export function getLastAutoChoice(): 'smart' | 'quick' | undefined {
  return lastAuto;
}

export function subscribeLastAutoChoice(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
