/**
 * "Connect your apps": one quiet line under the home composer for the two connections that make Orbit useful, LinkedIn
 * and Gmail. Each app not yet connected is a button that posts the matching setup widget into the chat; a connected
 * one shows a check. It hides once both are connected, for the sample student, and for good once dismissed here.
 */
import { Check, Mail, X } from 'lucide-react';
import { useState } from 'react';
import { cx } from '../../ui';

const DISMISS_KEY = 'orbit.home.connectStrip.dismissed';

function readDismissed(userId: string | undefined): boolean {
  if (!userId) return false;
  try {
    return localStorage.getItem(`${DISMISS_KEY}.${userId}`) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(userId: string | undefined): void {
  if (!userId) return;
  try {
    localStorage.setItem(`${DISMISS_KEY}.${userId}`, '1');
  } catch {
    // private window or blocked storage: it stays hidden until the page reloads
  }
}

/** Whether this student dismissed the strip in this browser, and the way to dismiss it. */
export function useConnectStripDismissed(userId: string | undefined): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(() => readDismissed(userId));
  const [forUser, setForUser] = useState(userId);
  if (forUser !== userId) {
    setForUser(userId);
    setDismissed(readDismissed(userId));
  }
  return [
    dismissed,
    () => {
      writeDismissed(userId);
      setDismissed(true);
    },
  ];
}

function LinkedInMark() {
  return (
    <span
      className="inline-flex items-center justify-center w-5 h-5 rounded-[5px] bg-[#0a66c2] text-white text-[10.5px] font-bold leading-none shrink-0"
      aria-hidden
    >
      in
    </span>
  );
}

function GmailMark() {
  return (
    <span
      className="inline-flex items-center justify-center w-5 h-5 rounded-[5px] bg-white border border-line text-[#d93025] shrink-0"
      aria-hidden
    >
      <Mail size={12} strokeWidth={2.4} />
    </span>
  );
}

export function ConnectStrip({
  linkedin,
  gmail,
  gmailAvailable = true,
  onConnect,
  onDismiss,
  disabled,
}: {
  linkedin: boolean;
  gmail: boolean;
  /** false where Google sign-in is not set up yet: Gmail shows as coming soon, with nothing to press */
  gmailAvailable?: boolean;
  onConnect: (what: 'linkedin' | 'google') => void;
  onDismiss: () => void;
  disabled?: boolean;
}) {
  const rows = [
    {
      what: 'linkedin' as const,
      name: 'LinkedIn',
      mark: <LinkedInMark />,
      connected: linkedin,
      available: true,
    },
    {
      what: 'google' as const,
      name: 'Gmail',
      mark: <GmailMark />,
      connected: gmail,
      available: gmailAvailable,
    },
  ];
  // one quiet line under the composer: each app is its own button, so its name never gets cut short
  return (
    <section
      className="mt-4 sm:mt-5 mx-auto flex flex-wrap items-center justify-center gap-x-2 gap-y-2 fade-up"
      aria-label="Connect your apps"
      data-testid="connect-strip"
    >
      <span className="text-[13px] text-ink-3 whitespace-nowrap">Connect your apps</span>
      <ul className="contents">
        {rows.map((r) => (
          <li key={r.what} className="contents" data-testid={`connect-row-${r.what}`}>
            {/* the status is said to screen readers; on screen the button or the check says it */}
            <span className="sr-only" data-testid={`connect-status-${r.what}`}>
              {r.connected ? 'Connected' : r.available ? 'Not connected' : 'Coming soon'}
            </span>
            {!r.connected && r.available ? (
              <button
                type="button"
                className="h-8 pl-1.5 pr-3 rounded-full border border-line bg-canvas inline-flex items-center gap-2 text-[13px] font-medium text-ink shadow-[var(--shadow-pill)] hover:bg-canvas-2 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 transition-colors"
                onClick={() => onConnect(r.what)}
                disabled={disabled}
                aria-label={`Connect ${r.name}`}
                data-testid={`connect-${r.what === 'google' ? 'gmail' : 'linkedin'}`}
              >
                {r.mark}
                {r.name}
              </button>
            ) : (
              <span
                className={cx(
                  'h-8 pl-1.5 pr-3 rounded-full inline-flex items-center gap-2 text-[13px] text-ink-3',
                  !r.connected && 'opacity-60',
                )}
                aria-hidden
              >
                {r.mark}
                {r.name}
                {r.connected ? (
                  <Check size={13} className="text-good" />
                ) : (
                  <span className="text-[12px]">soon</span>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="h-7 w-7 inline-flex items-center justify-center rounded-full text-ink-3 hover:text-ink hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 shrink-0"
        onClick={onDismiss}
        aria-label="Hide connect your apps"
        data-testid="connect-strip-dismiss"
      >
        <X size={14} aria-hidden />
      </button>
    </section>
  );
}
