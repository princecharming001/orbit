import { useEffect, useState } from 'react';
import { Logo } from '../components/AppShell';
import { finishAppSignIn } from '../engine/appSignIn';

/**
 * Where Cal.com's, Fathom's, Granola's and Wispr Flow's sign-in comes back. It hands the code to the Orbit tab that opened the window, wipes
 * it from the address bar, and closes itself; if the browser keeps it open, it says so.
 */
export function AuthApp() {
  const [state, setState] = useState<'done' | 'unknown'>('done');
  useEffect(() => {
    const ok = finishAppSignIn(window.location.search);
    window.history.replaceState(window.history.state, '', window.location.pathname);
    if (!ok) {
      setState('unknown');
      return;
    }
    const t = setTimeout(() => window.close(), 300);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="min-h-dvh flex items-center justify-center bg-page px-6">
      <div className="text-center max-w-sm" data-testid="auth-app">
        <div className="flex justify-center">
          <Logo size={36} />
        </div>
        <h1 className="text-[20px] font-normal tracking-[-0.02em] mt-4">
          {state === 'done'
            ? 'Connected. You can close this window.'
            : 'This sign-in did not come from Orbit.'}
        </h1>
        <p className="text-[13px] text-ink-3 mt-2">Orbit picks up where you left off in its own tab.</p>
      </div>
    </div>
  );
}
