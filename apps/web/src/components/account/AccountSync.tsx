import { useEffect } from 'react';
import { db } from '../../db/schema';
import { generateBrief } from '../../engine/brief';
import { startServerSync } from '../../engine/serverSync';
import { useAccount } from '../../state/account';
import { useSession } from '../../state/session';

/**
 * Keeps the browser's copy in step with the Orbit account while someone is signed in (account mode only): pulls,
 * the status poll (every 3 seconds during setup, every minute after) and the outbox. Renders nothing.
 */
export function AccountSync() {
  const { user } = useSession();
  const account = useAccount();
  const userId = user?.id;
  const active = account.mode && account.signedIn && !!userId && account.user?.id === userId;
  const onboarding = !!user && !user.onboardingCompletedAt;
  useEffect(() => {
    if (!active || !userId) return;
    return startServerSync({
      user: { id: userId },
      onboarding,
      onPulled: async () => {
        // the brief and its cards are built in the browser from what was pulled, once setup is done
        const u = await db.users.get(userId);
        if (u?.onboardingCompletedAt) await generateBrief(u, 'daily');
      },
    });
  }, [active, userId, onboarding]);
  return null;
}
