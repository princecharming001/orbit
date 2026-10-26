/**
 * Log in. With Orbit accounts, Continue with Google. Without them (Orbit keeps everything in this browser), the
 * profiles saved here, each one click to pick up where it was: setup resumes on its step, a finished one opens Orbit.
 * Nobody saved here: says so plainly, with Get started and the demo, so nobody makes a second profile by accident.
 */
import type { User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Logo } from '../components/AppShell';
import { savedProfiles } from '../engine/account';
import { DEMO_USER_ID } from '../engine/demo';
import { isAccountMode, startGoogleSignIn } from '../integrations/orbitApi';
import { useSession } from '../state/session';
import { Avatar, Button, Spinner } from '../ui';
import { onboardingPath } from './onboardingPath';

export function LogInPage() {
  const { loading, userId, setUserId } = useSession();
  const nav = useNavigate();
  const profiles = useLiveQuery(() => savedProfiles(DEMO_USER_ID), []);
  const [opening, setOpening] = useState<string>();
  const account = isAccountMode();
  // already in: Log in has nothing to do
  if (!loading && userId) return <Navigate to="/" replace />;
  const open = async (u: User) => {
    setOpening(u.id);
    await setUserId(u.id);
    nav(u.onboardingCompletedAt ? '/' : onboardingPath(Math.max(2, u.onboardingStep)));
  };
  return (
    <div className="min-h-full bg-page text-ink">
      <div className="max-w-[440px] mx-auto px-5 pt-12 pb-16 fade-up" data-testid="login">
        <Link to="/" className="inline-flex items-center gap-2 text-ink">
          <Logo size={22} />
          <span className="font-medium tracking-[-0.01em] text-[16px]">Orbit</span>
        </Link>
        <h1 className="mt-10 text-[28px] leading-tight font-medium tracking-[-0.02em]">Log in to Orbit</h1>
        {account && (
          <>
            <p className="mt-2 text-[14.5px] text-ink-2">Use the Google account you signed up with.</p>
            <Button size="lg" variant="dark" className="mt-6 w-full" onClick={() => startGoogleSignIn()}>
              Continue with Google
            </Button>
          </>
        )}
        {profiles === undefined || loading ? (
          <div className="mt-8">
            <Spinner />
          </div>
        ) : profiles.length > 0 ? (
          <div className="mt-8">
            <p className="text-[14px] text-ink-2">
              {account
                ? 'Or open a profile saved in this browser.'
                : 'Your Orbit lives in this browser. Pick up where you left off.'}
            </p>
            <ul className="mt-3 space-y-2" data-testid="login-profiles">
              {profiles.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => void open(u)}
                    disabled={!!opening}
                    className="w-full flex items-center gap-3 rounded-[14px] border border-line bg-canvas px-3.5 py-3 text-left hover:border-ink/25 hover:shadow-[var(--shadow-card)] transition-[box-shadow,border-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
                    data-testid="login-profile"
                  >
                    <Avatar name={u.fullName || u.email} src={u.avatarUrl} id={u.id} size={36} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium truncate">{u.fullName || u.email}</span>
                      <span className="block text-[12.5px] text-ink-3 truncate">
                        {[u.school, u.onboardingCompletedAt ? undefined : 'setup not finished']
                          .filter(Boolean)
                          .join(' · ') || u.email}
                      </span>
                    </span>
                    <span className="text-[13px] text-ink-2 shrink-0">
                      {opening === u.id ? <Spinner /> : 'Continue'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          !account && (
            <div className="mt-6 rounded-[14px] border border-line bg-canvas p-4" data-testid="login-none">
              <p className="text-[14px] text-ink-2">
                No Orbit profile is saved in this browser. Orbit keeps your network in the browser you set it
                up in, so log in there, or start fresh here.
              </p>
            </div>
          )
        )}
        <p className="mt-8 text-[13.5px] text-ink-3">
          New to Orbit?{' '}
          <Link to="/" className="text-ink underline underline-offset-4">
            Get started or try the demo
          </Link>
        </p>
      </div>
    </div>
  );
}
