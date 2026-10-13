import type { Brief, Suggestion } from '@orbit/core';
import { isMessageSuggestion } from '../../engine/brief';
import { todayCards } from '../../engine/today';

/**
 * Where the student is with setting Orbit up, and the ONE thing worth suggesting next. Pure: the snapshot gathers the
 * facts, this decides. The home page and the no-key router use the same words ("empty account", "waiting on you"),
 * so the three never disagree.
 */
export interface SetupState {
  /** people the student can see (human, not hidden) */
  people: number;
  /** LinkedIn is in: an export was uploaded, or the account is connected live */
  linkedinImported: boolean;
  /** LinkedIn is connected live (Unipile) and keeps itself in sync */
  linkedinLive?: boolean;
  /** live LinkedIn can be offered here, so the step is "connect" rather than "import" */
  liveLinkedInAvailable?: boolean;
  /** Gmail and Calendar (Google) are connected */
  googleConnected: boolean;
  resumeOnFile: boolean;
  targetCompanies: number;
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

const STEPS: Record<SetupStepId, string> = {
  linkedin: 'import LinkedIn connections (show_setup linkedin)',
  add_person: 'add one person they met (ask for a name)',
  target_companies: 'add a few target companies (ask which ones)',
  google: 'connect Gmail so Orbit sees who they email and drafts can go out (show_setup google)',
  resume: 'add a resume (show_setup resume)',
  none: 'none, setup is done',
};

/**
 * The single next setup step, in priority order: LinkedIn (connect live where Orbit offers it, else the export)
 * until it is in, then Gmail until it is connected, then a first person if there is still nobody, then target
 * companies, then the resume. The sample student has nothing to set up.
 */
export function nextSetupStep(s: SetupState): SetupStep {
  const pick = (id: SetupStepId): SetupStep => ({ id, text: STEPS[id] });
  if (s.demo) return { id: 'none', text: 'none, this is the sample student' };
  if (!s.linkedinImported)
    return s.liveLinkedInAvailable
      ? { id: 'linkedin', text: 'connect LinkedIn so their connections stay in sync (show_setup linkedin)' }
      : pick('linkedin');
  if (!s.googleConnected) return pick('google');
  if (s.people === 0) return pick('add_person');
  if (s.targetCompanies === 0) return pick('target_companies');
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
    `LinkedIn ${s.linkedinLive ? 'connected live' : s.linkedinImported ? 'imported' : 'not connected'}`,
    `Gmail ${s.googleConnected ? 'connected' : 'not connected'}`,
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
  // only cards whose job is a message: a prep sheet or a duplicate to confirm is not someone waiting on a message
  return peopleWaiting(
    todayCards(pending, latestBrief, now).cards.filter((c) => isMessageSuggestion(c.kind)),
  );
}
