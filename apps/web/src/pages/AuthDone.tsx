import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Logo } from '../components/AppShell';
import { ObHeader, ObPrimary, ObQuiet } from '../components/onboarding/OnboardingLayout';
import { getCurrentUserId } from '../db/repo';
import { db } from '../db/schema';
import { createLocalUser } from '../engine/account';
import { adoptAccountUser } from '../engine/accountMode';
import { completeSignIn, isAccountMode, startGoogleSignIn } from '../integrations/orbitApi';
import { useSession } from '../state/session';
import { Spinner } from '../ui';
import { onboardingPath } from './Onboarding';

/**
 * Where Google sign-in comes back (plan 16 §12.3): orbit-api redirects to /auth/done#code=… (or #error=…). The code is
 * traded for an Orbit session at once and the fragment is wiped from the address bar, then setup carries on. Errors
 * are said in plain words, with the way to use Orbit without Google.
 */
export function AuthDone() {
  const nav = useNavigate();
  const { setUserId } = useSession();
  const [error, setError] = useState<string>();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const hash = window.location.hash;
    // the one-time code never stays in the address bar or the history
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    void (async () => {
      if (!isAccountMode()) {
        nav('/', { replace: true });
        return;
      }
      const r = await completeSignIn(hash);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      const user = await adoptAccountUser(r.user);
      await setUserId(user.id);
      nav(user.onboardingCompletedAt ? '/' : onboardingPath(user.onboardingStep), { replace: true });
    })();
  }, [nav, setUserId]);

  const withoutGoogle = async () => {
    // local mode, as before: the profile made by Get started, or a new one
    const id = await getCurrentUserId();
    const existing = id ? await db.users.get(id) : undefined;
    const user = existing ?? (await createLocalUser());
    if (!existing) await setUserId(user.id);
    nav(user.onboardingCompletedAt ? '/' : onboardingPath(Math.max(user.onboardingStep, 2)), {
      replace: true,
    });
  };

  return (
    <div className="min-h-dvh bg-[#fcfcfd] flex flex-col items-center px-4 pt-[12vh]" data-testid="auth-done">
      <div className="w-full max-w-[440px] fade-up">
        <div className="mb-6 flex justify-center">
          <Logo size={40} />
        </div>
        {error ? (
          <div data-testid="auth-error">
            <ObHeader title="Sign-in didn't finish" subtitle={error} />
            <div className="space-y-3">
              <ObPrimary onClick={() => startGoogleSignIn()} data-testid="auth-retry">
                Try Google again
              </ObPrimary>
              <ObQuiet onClick={withoutGoogle} data-testid="auth-without-google">
                Use Orbit without Google
              </ObQuiet>
            </div>
          </div>
        ) : (
          <div className="text-center" role="status">
            <Spinner />
            <p className="mt-3 text-[15px] text-ink-2">Signing you in…</p>
          </div>
        )}
      </div>
    </div>
  );
}
