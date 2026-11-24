import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../db/schema';
import { stopMovedWarmUps, tellWarmUpDone, tickDemoWarmUps, warmUpsToTell } from '../engine/warmupAuto';
import { mirrorWarmUpRuns } from '../engine/warmupMirror';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { useSession } from '../state/session';
import { useToast } from '../ui';

/** How often the demo's simulated warm-ups catch up with the clock while the app is open. */
export const DEMO_TICK_MS = 60_000;

/**
 * Keeps the warm-ups Orbit runs in step with what the student sees, while the app is open. Mounted once in the shell.
 *
 * - When the app opens, every run is copied onto its chat (engine/warmupMirror.ts), in case a pull brought one while
 *   the tab was closed.
 * - A run that finished is said once: one toast with a way to the person, one line in the notifications, and the
 *   "ready to message" card on Drafts. `toldAt` on the run (kept on the server too) is what makes it once.
 * - In the demo the run is simulated here, so the clock is checked every minute.
 */
export function WarmUpWatch() {
  const { user } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const userId = user?.id;
  const tz = user?.timezone;
  const ready = !!user?.onboardingCompletedAt;
  const telling = useRef(new Set<string>());

  useEffect(() => {
    if (!userId || !ready) return;
    let stopped = false;
    void mirrorWarmUpRuns(userId).catch(() => undefined);
    if (!usesMockConnectors(userId)) return;
    const tick = () => {
      if (!stopped && !document.hidden)
        void tickDemoWarmUps({ id: userId, timezone: tz ?? 'UTC' }).catch(() => undefined);
    };
    tick();
    const t = setInterval(tick, DEMO_TICK_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [userId, ready, tz]);

  // a card moved out of Warming up by hand while Orbit was running its warm-up: the run stops on the server too
  const moved = useLiveQuery(
    async () =>
      userId && ready
        ? db.chats
            .where('userId')
            .equals(userId)
            .filter((c) => c.warmUp?.auto?.status === 'running' && (c.stage !== 'warming' || !!c.archivedAt))
            .count()
        : 0,
    [userId, ready],
  );
  useEffect(() => {
    if (userId && moved) void stopMovedWarmUps({ id: userId }).catch(() => undefined);
  }, [moved, userId]);

  // the runs that are done and not said yet (a live query: it fires when a pull brings one)
  const done = useLiveQuery(async () => (userId && ready ? warmUpsToTell(userId) : []), [userId, ready]);
  useEffect(() => {
    if (!userId || !done?.length) return;
    for (const run of done) {
      if (telling.current.has(run.id)) continue;
      telling.current.add(run.id);
      void tellWarmUpDone({ id: userId }, run)
        .then((said) => {
          if (!said) return;
          toast.push({
            text: said.text,
            tone: 'good',
            ttl: 10_000,
            sticky: true,
            action: { label: 'Write to them', onClick: () => nav(`/inbox?person=${said.personId}`) },
          });
        })
        .catch(() => undefined);
    }
  }, [done, userId, toast, nav]);
  return null;
}
