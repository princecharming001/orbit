import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { db } from '../../db/schema';
import { peopleToRate } from '../../engine/closeness';
import { useAccount } from '../../state/account';
import { useSession } from '../../state/session';
import { Button, Modal } from '../../ui';
import { RatePeople } from './RatePeople';

/** How long after setup the question waits: by then the email and LinkedIn reads have brought people in. */
export const RATE_PROMPT_AFTER_MS = 2 * 24 * 60 * 60_000;
/** Fewer people than this and the list would be thin: it waits for more. */
const ENOUGH = 5;
const seenKey = (userId: string) => `ratePromptSeen:${userId}`;

/**
 * "Rate a few people", asked once in a popup on a visit at least two days after setup (account mode only), instead of
 * as a setup step: during setup Orbit has not read enough email to have people worth rating. Never asked again once
 * closed, and never asked after the student has rated anyone.
 */
export function RatePrompt() {
  const { user } = useSession();
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const closed = useRef(false);
  const state = useLiveQuery(async () => {
    if (!user) return null;
    const [seen, rated] = await Promise.all([
      db.kv.get(seenKey(user.id)),
      db.tieLabels.where('userId').equals(user.id).count(),
    ]);
    return { seen: !!seen, rated };
  }, [user?.id]);
  const signedIn = account.signedIn && account.user?.id === user?.id;
  useEffect(() => {
    if (
      !user?.onboardingCompletedAt ||
      !signedIn ||
      !state ||
      state.seen ||
      state.rated ||
      open ||
      closed.current
    )
      return;
    // a browser driven by tests only gets it when the test asks, so it covers nothing else
    const g = globalThis as { __ORBIT_RATE__?: unknown };
    if (typeof navigator !== 'undefined' && navigator.webdriver && g.__ORBIT_RATE__ !== 'on') return;
    if (Date.now() - Date.parse(user.onboardingCompletedAt) < RATE_PROMPT_AFTER_MS) return;
    let stop = false;
    const check = async () => {
      if (stop || document.hidden) return;
      // never over another deck (the morning brief, the week review): it waits its turn
      if (document.querySelector('[role="dialog"]')) return;
      if ((await peopleToRate(user.id)).length >= ENOUGH && !stop) setOpen(true);
    };
    void check();
    const t = setInterval(check, 60_000);
    document.addEventListener('visibilitychange', check);
    return () => {
      stop = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', check);
    };
  }, [user?.id, user?.onboardingCompletedAt, signedIn, state, open]);
  if (!open || !user) return null;
  const close = () => {
    closed.current = true;
    setOpen(false);
    void db.kv.put({ key: seenKey(user.id), value: new Date().toISOString() });
  };
  return (
    <Modal open onClose={close} title="Rate a few people" width={560}>
      <div data-testid="rate-prompt">
        <p className="mb-4 text-[14px] text-ink-3">
          How close are you to each? Orbit tunes its closeness scores to your answers. Skip anyone you like.
        </p>
        <div className="max-h-[60vh] overflow-y-auto">
          <RatePeople userId={user.id} />
        </div>
        <div className="mt-5 flex justify-end">
          <Button variant="primary" onClick={close} data-testid="rate-prompt-done">
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}
