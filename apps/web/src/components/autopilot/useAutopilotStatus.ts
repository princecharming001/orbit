/**
 * The autopilot status for a screen (plan 29 §B5): read on mount and every half minute while the tab is visible,
 * again after a hold, a pause or an answer. For an account it is the server's; local mode reads this browser's outbox
 * and cards, so the live query below keeps it fresh without a timer.
 */
import type { AutopilotStatus, User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useState } from 'react';
import { db } from '../../db/schema';
import { autopilotStatus, type StatusResult } from '../../engine/autopilotMode';
import { isServerUser } from '../../integrations/orbitApi';

export const STATUS_EVERY_MS = 30_000;

export interface AutopilotView {
  status?: AutopilotStatus;
  local: boolean;
  note?: string;
  error?: string;
  refresh: () => Promise<void>;
}

export function useAutopilotStatus(user: User | undefined): AutopilotView {
  const [view, setView] = useState<Omit<AutopilotView, 'refresh'>>({ local: !isServerUser(user?.id) });
  // local mode: the outbox and the cards are the status, so their changes redraw it
  const tick = useLiveQuery(
    async () =>
      user && !isServerUser(user.id)
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
  useEffect(() => {
    void refresh();
  }, [refresh, tick]);
  useEffect(() => {
    if (!user || !isServerUser(user.id)) return;
    const t = setInterval(() => {
      if (!document.hidden) void refresh();
    }, STATUS_EVERY_MS);
    return () => clearInterval(t);
  }, [user, refresh]);
  return { ...view, refresh };
}
