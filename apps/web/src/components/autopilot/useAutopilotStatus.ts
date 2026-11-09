/**
 * The autopilot status for a screen (plan 29 §B5): read on mount, again after a hold, a pause or an answer, and for an
 * account again only when the sync status's autopilot mark moves (plan 35 B3: the server moves it when a draft, a
 * card, an inbound reply or the autopilot settings change). A server from before the marks is read every five
 * minutes while the tab is visible. Local mode reads this browser's outbox and cards, so the live query below keeps
 * it fresh without a timer.
 */
import type { AutopilotStatus, User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useState } from 'react';
import { db } from '../../db/schema';
import { autopilotStatus, type StatusResult } from '../../engine/autopilotMode';
import { isServerUser } from '../../integrations/orbitApi';
import { useStatusMark } from '../../state/account';

/** Only for a server from before the marks: how often its status is read while the tab is visible. */
export const STATUS_EVERY_MS = 5 * 60_000;

export interface AutopilotView {
  status?: AutopilotStatus;
  local: boolean;
  note?: string;
  error?: string;
  refresh: () => Promise<void>;
}

export function useAutopilotStatus(user: User | undefined): AutopilotView {
  const [view, setView] = useState<Omit<AutopilotView, 'refresh'>>({ local: !isServerUser(user?.id) });
  // the outbox and the cards change the status (local mode is made of them; an account's funnel writes cards here
  // after it booked or paused something), so their changes read it again
  const tick = useLiveQuery(
    async () =>
      user
        ? (await db.outbound.where('userId').equals(user.id).count()) +
          (await db.suggestions.where('userId').equals(user.id).count()) * 1000 +
          ((await db.settings.get(user.id))?.autopilotMode?.length ?? 0)
        : 0,
    [user?.id],
  );
  const refresh = useCallback(async () => {
    if (!user) return;
    const r: StatusResult | { ok: false; message: string } = await autopilotStatus(user);
    if (r.ok) setView({ status: r.status, local: r.local, note: r.note });
    else setView((v) => ({ ...v, error: r.message }));
  }, [user]);
  const server = !!user && isServerUser(user.id);
  // the server's autopilot mark: a new value means its answer changed (a local student has none)
  const mark = useStatusMark('autopilot');
  const marked = server ? mark : undefined;
  useEffect(() => {
    void refresh();
  }, [refresh, tick, marked]);
  // no marks known (a server from before them, or no status yet): the old slow timer, never while hidden
  const fallback = server && mark === undefined;
  useEffect(() => {
    if (!fallback) return;
    const t = setInterval(() => {
      if (!document.hidden) void refresh();
    }, STATUS_EVERY_MS);
    return () => clearInterval(t);
  }, [fallback, refresh]);
  return { ...view, refresh };
}
