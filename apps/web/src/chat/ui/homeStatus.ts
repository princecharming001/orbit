import { useEffect, useState } from 'react';
import { db } from '../../db/schema';
import { DEMO_USER_ID } from '../../engine/demo';
import { googleClientId } from '../../integrations/google';
import { useSession } from '../../state/session';
import { peopleWaitingNow } from '../agent/setup';
import { useThread } from './threadStore';

/**
 * What the home page needs to know about the account to go gentle: is anyone in it yet, and how many people are
 * waiting on a message. Read from the local database, cached per student so coming back to the home does not flash,
 * and refreshed on mount and whenever a turn ends (a turn can import people or write drafts).
 */
export interface HomeStatus {
  /** false until the first read of this student's data finished */
  ready: boolean;
  /** nobody in the account yet */
  empty: boolean;
  /** how many people have a message waiting on the student today */
  waiting: number;
  /** LinkedIn is in (an export uploaded, or connected live) */
  linkedin: boolean;
  /** Gmail (Google) is connected */
  gmail: boolean;
  /** Google sign-in is set up in this copy of Orbit, so Gmail can be connected at all */
  gmailAvailable?: boolean;
  /** the sample student: nothing to connect */
  demo: boolean;
}

/** Before the first read, and when the database is not there: nothing to nag about. */
const QUIET: Omit<HomeStatus, 'ready'> = {
  empty: false,
  waiting: 0,
  linkedin: true,
  gmail: true,
  gmailAvailable: true,
  demo: false,
};

const cache = new Map<string, HomeStatus>();

/** tests only */
export function resetHomeStatusCache(): void {
  cache.clear();
}

export async function readHomeStatus(userId: string, now: Date = new Date()): Promise<HomeStatus> {
  const [people, pending, briefs, integrations] = await Promise.all([
    db.people
      .where('userId')
      .equals(userId)
      .filter((p) => p.isHuman && !p.hiddenAt)
      .count(),
    db.suggestions
      .where('userId')
      .equals(userId)
      .filter((s) => s.status === 'pending')
      .toArray(),
    db.briefs.where('userId').equals(userId).toArray(),
    db.integrations.where('userId').equals(userId).toArray(),
  ]);
  const latest = briefs.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
  // "connected" the way the snapshot's Setup line counts it
  const status: HomeStatus = {
    ready: true,
    empty: people === 0,
    waiting: peopleWaitingNow(pending, latest, now),
    linkedin: integrations.some(
      (i) =>
        i.provider === 'linkedin_csv' ||
        (i.provider === 'linkedin_live' && i.status !== 'revoked' && !!i.externalAccountId),
    ),
    gmail: integrations.some((i) => i.provider === 'google' && i.status !== 'revoked'),
    gmailAvailable: !!googleClientId(),
    demo: userId === DEMO_USER_ID || integrations.some((i) => i.provider === 'demo'),
  };
  cache.set(userId, status);
  return status;
}

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/** The optional line under the greeting: only when there is something real to say. */
export function homeStatusLine(status: HomeStatus): string | undefined {
  if (!status.ready) return undefined;
  if (status.empty) return "Let's get you set up. It takes about two minutes.";
  if (status.waiting <= 0) return missingAppsLine(status);
  const n = status.waiting;
  const count = n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
  return n === 1
    ? 'One person is waiting on a message from you.'
    : `${count} people are waiting on a message from you.`;
}

/** What is not connected yet, in one line; undefined when both are (or for the sample student). */
export function missingAppsLine(
  status: Pick<HomeStatus, 'linkedin' | 'gmail' | 'demo'> & { gmailAvailable?: boolean },
): string | undefined {
  if (status.demo) return undefined;
  // Gmail only counts as missing where it can be connected: never nag about something the student cannot do
  const gmailMissing = !status.gmail && status.gmailAvailable !== false;
  if (!status.linkedin && gmailMissing) return 'Connect LinkedIn and Gmail so I can see who you know.';
  if (!status.linkedin) return 'Connect LinkedIn so I can see everyone you know.';
  if (gmailMissing) return 'Connect Gmail so I can see who you email and send what you approve.';
  return undefined;
}

export function useHomeStatus(): HomeStatus {
  const { userId } = useSession();
  const thread = useThread();
  const [status, setStatus] = useState<HomeStatus>(
    () => (userId ? cache.get(userId) : undefined) ?? { ready: false, ...QUIET },
  );
  // on mount, and each time a turn ends or the history changes
  useEffect(() => {
    if (!userId || thread.running) return;
    let live = true;
    readHomeStatus(userId)
      .then((s) => live && setStatus(s))
      .catch(() => {
        // the database is not there (private window, tests): the full chip set and no status line
        if (live) setStatus({ ready: true, ...QUIET });
      });
    return () => {
      live = false;
    };
  }, [userId, thread.running, thread.historyVersion]);
  return status;
}
