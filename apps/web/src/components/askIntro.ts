import type { ReachPath, User } from '@orbit/core';
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../db/schema';
import { requestIntro } from '../engine/drafts';
import { useToast, useWorking } from '../ui';

/** The `busy` key of one intro request, so the button for that pair (and only that one) shows the spinner. */
export function askIntroKey(connectorId: string, targetId: string): string {
  return `intro:${connectorId}:${targetId}`;
}

/**
 * "Ask X for an intro": drafts the request (or finds the one already drafted) and opens it in Drafts, where it is
 * read and sent, with a line that says what happened. Never a click that seems to do nothing: Claude takes a few
 * seconds to write it, so a working toast shows at once, the pair's button spins (`isAsking`), and a failure says so.
 * A page with other slow buttons passes its own `useWorking()` so one click at a time runs across all of them.
 */
export function useAskIntro(user: User | null | undefined, working?: ReturnType<typeof useWorking>) {
  const nav = useNavigate();
  const toast = useToast();
  const own = useWorking();
  const { busy, run } = working ?? own;
  const ask = useCallback(
    async (connectorId: string, targetId: string, score: number, hops?: ReachPath['hops']) => {
      if (!user) return;
      await run(askIntroKey(connectorId, targetId), 'Writing your intro request…', async () => {
        const r = await requestIntro(user, connectorId, targetId, { path: { score, hops } });
        if (!r) {
          toast.push({ text: `Orbit couldn't find one of them to draft the intro request.`, tone: 'bad' });
          return;
        }
        const [connector, target] = await Promise.all([db.people.get(connectorId), db.people.get(targetId)]);
        const who = connector?.firstName ?? 'them';
        const to = target?.firstName ?? 'them';
        nav(`/inbox?card=${r.suggestion.id}`);
        toast.push({
          text: r.existed
            ? `You already have a request to ${who} for an intro to ${to}. Here it is in Drafts.`
            : `Drafted your request to ${who} for an intro to ${to}. Read it over and send it from Drafts.`,
          tone: 'good',
          ttl: 6000,
        });
      });
    },
    [user, run, nav, toast],
  );
  const isAsking = useCallback(
    (connectorId: string, targetId: string) => busy === askIntroKey(connectorId, targetId),
    [busy],
  );
  return { ask, isAsking, busy };
}
