/**
 * "Connect your apps": a quiet strip under the home composer for the two connections that make Orbit useful, LinkedIn
 * and Gmail. Each row shows its status and a Connect button that posts the matching setup widget into the chat. It
 * hides once both are connected, for the sample student, and for good once dismissed in this browser.
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
  return (
    <section
      className="glass rounded-[16px] mt-4 sm:mt-5 max-w-[680px] mx-auto px-3 py-2 sm:px-3.5 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 fade-up"
      aria-label="Connect your apps"
      data-testid="connect-strip"
    >
      <div className="flex items-center justify-between gap-2 sm:justify-start">
        <span className="text-[13px] font-medium text-ink-2 whitespace-nowrap">Connect your apps</span>
        <button
          type="button"
          className="sm:hidden h-7 w-7 inline-flex items-center justify-center rounded-full text-ink-3 hover:text-ink hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={onDismiss}
          aria-label="Hide connect your apps"
          data-testid="connect-strip-dismiss-phone"
        >
          <X size={14} aria-hidden />
        </button>
      </div>
      <ul className="flex flex-col sm:flex-row gap-1.5 sm:gap-2 flex-1 min-w-0">
        {rows.map((r) => (
          <li
            key={r.what}
            className="flex items-center gap-2 min-w-0 rounded-[12px] bg-canvas/60 border border-line-2 pl-2 pr-1 h-9 sm:flex-1"
            data-testid={`connect-row-${r.what}`}
          >
            {r.mark}
            <span className="text-[13px] font-medium truncate">{r.name}</span>
            <span
              className={cx(
                'inline-flex items-center gap-1 text-[12px] whitespace-nowrap',
                r.connected ? 'text-good' : 'text-ink-3',
              )}
              data-testid={`connect-status-${r.what}`}
            >
              {r.connected ? (
                <>
                  <Check size={12} aria-hidden /> Connected
                </>
              ) : r.available ? (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-ink-3/50" aria-hidden /> Not connected
                </>
              ) : (
                'Coming soon'
              )}
            </span>
            {!r.connected && r.available && (
              <button
                type="button"
                className="ml-auto h-7 px-2.5 rounded-[9px] text-[12.5px] font-medium bg-accent text-white hover:bg-accent-2 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                onClick={() => onConnect(r.what)}
                disabled={disabled}
                data-testid={`connect-${r.what === 'google' ? 'gmail' : 'linkedin'}`}
              >
                Connect
              </button>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="hidden sm:inline-flex h-7 w-7 items-center justify-center rounded-full text-ink-3 hover:text-ink hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 shrink-0"
        onClick={onDismiss}
        aria-label="Hide connect your apps"
        data-testid="connect-strip-dismiss"
      >
        <X size={14} aria-hidden />
      </button>
    </section>
  );
}
