import { dismissHint } from '../engine/settings';
import { useSession } from './session';

/** The first-run hints this student has closed, and how to close one for good. */
export function useHints(): { seen: (id: string) => boolean; dismiss: (id: string) => Promise<void> } {
  const { userId, settings } = useSession();
  const closed = settings?.dismissedHints ?? [];
  return {
    // until settings load, treat every hint as seen so nothing flashes in and out
    seen: (id) => !settings || closed.includes(id),
    dismiss: async (id) => {
      if (userId) await dismissHint(userId, id);
    },
  };
}
