// Log out: this browser stops opening Orbit as this person until they log in again from the home page. Everything
// stays where it is (local data in this browser; with an Orbit account, on the server too), so logging back in picks
// up exactly where they left off. With an Orbit account the server session is ended as well.
import { useNavigate } from 'react-router-dom';
import { signOutHere } from '../engine/accountMode';
import { clearSession, isAccountMode, isSignedIn } from '../integrations/orbitApi';
import { useSession } from '../state/session';
import { useToast } from '../ui';

export function useLogOut(): () => Promise<void> {
  const { signOut } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  return async () => {
    if (isAccountMode() && isSignedIn()) {
      // The server logout goes out first (its request already carries this session's tokens) but is not waited on:
      // the browser forgets the session and leaves at once, and a slow or unreachable server only means the server
      // session runs out on its own.
      void signOutHere().catch(() => undefined);
      await clearSession();
    }
    await signOut();
    nav('/');
    toast.push({
      text: isAccountMode()
        ? 'Logged out. Log in with Google to pick up where you left off.'
        : 'Logged out. Your data stays in this browser; Log in on the home page to pick up where you left off.',
    });
  };
}
