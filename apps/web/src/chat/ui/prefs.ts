/**
 * The composer's mode: Smart (full Claude) or Quick (Claude at low effort). It is a UI preference the engine reads
 * when it builds a request; it lives here, outside React, so the engine can read it without a hook.
 */
export type ChatMode = 'smart' | 'quick';
const KEY = 'orbit:chatMode';

export function getChatMode(): ChatMode {
  try {
    return localStorage.getItem(KEY) === 'quick' ? 'quick' : 'smart';
  } catch {
    return 'smart';
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
  smart: { label: 'Smart', hint: 'Claude thinks it through. Best for drafts and judgement calls.' },
  quick: { label: 'Quick', hint: 'Claude at low effort. Faster, for lookups and small edits.' },
};
