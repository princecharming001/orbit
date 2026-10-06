import { useEffect, useRef } from 'react';
import { db } from '../db/schema';
import { sendDueQueued } from '../engine/send';
import { useSession } from '../state/session';
import { useToast } from '../ui';

const TICK_MS = 3000;

/**
 * Sends queued Gmail messages once their undo window has ended. Mounted once in the app shell; the engine
 * serialises runs and claims each message atomically, so a message is never sent twice.
 */
export function OutboxScheduler() {
  const { user } = useSession();
  const toast = useToast();
  const userRef = useRef(user);
  userRef.current = user;
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    let stopped = false;
    const tick = async () => {
      const u = userRef.current;
      if (!u || stopped) return;
      const results = await sendDueQueued(u).catch(() => []);
      for (const r of results) {
        if (stopped) return;
        const o = await db.outbound.get(r.id);
        const p = o ? await db.people.get(o.personId) : undefined;
        const name = p?.firstName ?? 'them';
        toast.push(
          r.ok
            ? { text: `Sent to ${name}.`, tone: 'good' }
            : { text: `Not sent to ${name}: ${r.error}`, tone: 'bad', ttl: 8000 },
        );
      }
    };
    tick();
    const t = setInterval(tick, TICK_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [userId, toast]);
  return null;
}
