import { useEffect, useState } from 'react';
import { db } from '../../db/schema';
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
}

const cache = new Map<string, HomeStatus>();

/** tests only */
export function resetHomeStatusCache(): void {
  cache.clear();
}

export async function readHomeStatus(userId: string, now: Date = new Date()): Promise<HomeStatus> {
  const [people, pending, briefs] = await Promise.all([
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
  ]);
  const latest = briefs.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
  const status = { ready: true, empty: people === 0, waiting: peopleWaitingNow(pending, latest, now) };
  cache.set(userId, status);
  return status;
}

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/** The optional line under the greeting: only when there is something real to say. */
export function homeStatusLine(status: HomeStatus): string | undefined {
  if (!status.ready) return undefined;
  if (status.empty) return "Let's get you set up. It takes about two minutes.";
  if (status.waiting <= 0) return undefined;
  const n = status.waiting;
  const count = n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
  return n === 1
    ? 'One person is waiting on a message from you.'
    : `${count} people are waiting on a message from you.`;
}

export function useHomeStatus(): HomeStatus {
  const { userId } = useSession();
  const thread = useThread();
  const [status, setStatus] = useState<HomeStatus>(
    () => (userId ? cache.get(userId) : undefined) ?? { ready: false, empty: false, waiting: 0 },
  );
  // on mount, and each time a turn ends or the history changes
  useEffect(() => {
    if (!userId || thread.running) return;
    let live = true;
    readHomeStatus(userId)
      .then((s) => live && setStatus(s))
      .catch(() => {
        // the database is not there (private window, tests): the full chip set and no status line
        if (live) setStatus({ ready: true, empty: false, waiting: 0 });
      });
    return () => {
      live = false;
    };
  }, [userId, thread.running, thread.historyVersion]);
  return status;
}
