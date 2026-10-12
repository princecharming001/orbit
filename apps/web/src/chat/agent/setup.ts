import type { Brief, Suggestion } from '@orbit/core';
import { todayCards } from '../../engine/today';

/**
 * Where the student is with setting Orbit up, and the ONE thing worth suggesting next. Pure: the snapshot gathers the
 * facts, this decides. The home page and the no-key router use the same words ("empty account", "waiting on you"),
 * so the three never disagree.
 */
export interface SetupState {
  /** people the student can see (human, not hidden) */
  people: number;
  linkedinImported: boolean;
  googleConnected: boolean;
  resumeOnFile: boolean;
  targetCompanies: number;
  /** at least one message draft exists (the moment Google starts to matter) */
  hasDraft: boolean;
  /** how the chat reaches Claude: the student's own key, Orbit's shared access, or neither */
  claude: 'own_key' | 'shared' | 'none';
  /** the sample student: nothing to set up */
  demo?: boolean;
}

export type SetupStepId = 'linkedin' | 'add_person' | 'target_companies' | 'google' | 'resume' | 'none';

export interface SetupStep {
  id: SetupStepId;
  /** one line for the model, naming the tool that does it */
  text: string;
}

/** A LinkedIn import is still the best first step until the student has about this many people. */
const SMALL_NETWORK = 10;

const STEPS: Record<SetupStepId, string> = {
  linkedin: 'import LinkedIn connections (show_setup linkedin)',
  add_person: 'add one person they met (ask for a name)',
  target_companies: 'add a few target companies (ask which ones)',
  google: 'connect Google so drafts can go out (show_setup google)',
  resume: 'add a resume (show_setup resume)',
  none: 'none, setup is done',
};

/**
 * The single next setup step, in priority order for a student with nothing set up: LinkedIn import, then a first
 * person or target companies, then Google once there is a draft to send, then the resume. The sample student has
 * nothing to set up.
 */
export function nextSetupStep(s: SetupState): SetupStep {
  const pick = (id: SetupStepId): SetupStep => ({ id, text: STEPS[id] });
  if (s.demo) return { id: 'none', text: 'none, this is the sample student' };
  if (s.people === 0) return pick(s.linkedinImported ? 'add_person' : 'linkedin');
  if (!s.linkedinImported && s.people < SMALL_NETWORK) return pick('linkedin');
  if (s.targetCompanies === 0) return pick('target_companies');
  if (s.hasDraft && !s.googleConnected) return pick('google');
  if (!s.resumeOnFile) return pick('resume');
  return pick('none');
}

/** An account with nothing in it yet: the home and the router both go gentle. */
export function isEmptyAccount(s: Pick<SetupState, 'people'>): boolean {
  return s.people === 0;
}

/** The snapshot's one-line "Setup:" entry. */
export function setupLine(s: SetupState): string {
  const claude = s.claude === 'own_key' ? 'own key' : s.claude === 'shared' ? 'shared access' : 'no key';
  const facts = [
    `people ${s.people}`,
    `LinkedIn ${s.linkedinImported ? 'imported' : 'not imported'}`,
    `Google ${s.googleConnected ? 'connected' : 'not connected'}`,
    `resume ${s.resumeOnFile ? 'on file' : 'none'}`,
    `target companies ${s.targetCompanies}`,
    `Claude ${claude}`,
  ].join(', ');
  return `Setup: ${facts}. Suggested first step: ${nextSetupStep(s).text}.`;
}

/** How many different people have an open Today card: "three people are waiting on a message from you". */
export function peopleWaiting(cards: { personId?: string }[]): number {
  return new Set(cards.filter((c) => c.personId).map((c) => c.personId)).size;
}

/** The same count from raw rows, counted the way the Today page counts its cards (live ones, the brief's picks first). */
export function peopleWaitingNow(
  pending: Suggestion[],
  latestBrief: Pick<Brief, 'suggestionIds'> | undefined,
  now: Date,
): number {
  return peopleWaiting(todayCards(pending, latestBrief, now).cards);
}
