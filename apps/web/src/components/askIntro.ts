import type { User } from '@orbit/core';
import { useNavigate } from 'react-router-dom';
import { db } from '../db/schema';
import { requestIntro } from '../engine/drafts';
import { useToast } from '../ui';

/**
 * "Ask X for an intro": drafts the request (or finds the one already drafted) and opens it in Drafts, where it is
 * read and sent, with a line that says what happened. Never a click that seems to do nothing.
 */
export function useAskIntro(user: User | null | undefined) {
  const nav = useNavigate();
  const toast = useToast();
  return async (connectorId: string, targetId: string, score: number) => {
    if (!user) return;
    const r = await requestIntro(user, connectorId, targetId, { path: { score } });
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
  };
}
