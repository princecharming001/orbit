import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { leaveDemoForOwnSetup } from '../engine/account';
import { DEMO_USER_ID } from '../engine/demo';
import { onboardingPath } from '../pages/Onboarding';
import { useSession } from '../state/session';
import { Button, Modal } from '../ui';

/** Says the data on screen is a made-up student's, and offers the way to set Orbit up for real. */
export function DemoBanner() {
  const { user, setUserId } = useSession();
  const nav = useNavigate();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (user?.id !== DEMO_USER_ID) return null;
  const start = async () => {
    setBusy(true);
    const u = await leaveDemoForOwnSetup();
    await setUserId(u.id);
    nav(onboardingPath(2));
  };
  return (
    <>
      <div
        className="border-b border-line bg-accent-soft text-[12.5px] md:text-[13px] px-4 py-1.5 md:py-2 flex flex-wrap items-center gap-x-3 gap-y-1"
        data-testid="demo-banner"
      >
        <span className="text-ink-2 min-w-0">
          <span className="md:hidden">Demo data for a made-up student.</span>
          <span className="hidden md:inline">
            You are looking at demo data for {user.fullName}, a made-up student. Nothing here is real or sent.
          </span>
        </span>
        <button
          className="font-medium text-accent underline underline-offset-2 hover:text-ink"
          onClick={() => setAsking(true)}
          data-testid="demo-start-own"
        >
          Set up Orbit for me
        </button>
      </div>
      <Modal open={asking} onClose={() => setAsking(false)} title="Set up Orbit for yourself">
        <div className="space-y-3 text-[13.5px] text-ink-2">
          <p>
            Orbit clears the demo data from this browser and walks you through your own setup. It takes about
            two minutes, and you can come back to the demo any time from the home page.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="primary" onClick={start} disabled={busy} data-testid="demo-start-confirm">
              {busy ? 'Starting…' : 'Start my setup'}
            </Button>
            <Button onClick={() => setAsking(false)}>Keep exploring</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
