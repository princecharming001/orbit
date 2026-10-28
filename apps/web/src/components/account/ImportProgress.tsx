import { Check } from 'lucide-react';
import { useSyncStatus } from '../../state/account';
import { Spinner } from '../../ui';

const fmt = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-US');

/**
 * The live import line in setup (plan 16 §17): "I'm reading your last 90 days of email first" with what has come in,
 * then the older mail's progress. Account mode only; the sync loop polls /sync/status every 3 seconds meanwhile.
 */
export function ImportProgress({ firstName }: { firstName?: string }) {
  const status = useSyncStatus();
  const google = status?.integrations.find((i) => i.provider === 'google');
  const bf = google?.backfill;
  const messages = status?.counts.messages;
  const people = status?.counts.people;
  let lead: string;
  let detail: string;
  // reading: a spinner and a bar that moves, filled to the count once the older mail has a total
  let reading = true;
  let share: number | undefined;
  if (google?.status === 'needs_reauth') {
    reading = false;
    lead = 'Google needs you to sign in again before Orbit can read your email.';
    detail = 'Sign in with Google again from Settings, Account.';
  } else if (!bf || bf.phase === 'recent' || bf.phase === null) {
    lead = `${firstName ? `Hi ${firstName}. ` : ''}I'm reading your last 90 days of email first.`;
    detail = status ? `${fmt(messages)} messages · ${fmt(people)} people so far` : 'Getting started…';
  } else if (bf.phase === 'deep') {
    lead = 'Your recent email is in.';
    // the total is Gmail's estimate, which can come in under what is really there: once the count passes it, the
    // line gives the count alone (never "500 of 251") and the bar goes back to moving
    const done = bf.done ?? 0;
    const counted = !!bf.total && done < bf.total;
    if (counted) share = done / bf.total!;
    detail = counted
      ? `Reading older email: ${fmt(done)} of ${fmt(bf.total)}`
      : done
        ? `Reading older email: ${fmt(done)} messages so far`
        : `${fmt(messages)} messages · ${fmt(people)} people so far`;
  } else {
    reading = false;
    lead = 'Your email is in.';
    detail = `${fmt(people)} people, ${fmt(status?.counts.ties)} ties.`;
  }
  return (
    <div
      className="mb-6 rounded-xl border border-[#e6e8ec] bg-white px-4 py-3 text-[13.5px] leading-[1.5]"
      role="status"
      aria-live="polite"
      data-testid="ob-import-progress"
    >
      <div className="flex items-start gap-3">
        <span className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center">
          {reading ? (
            <Spinner />
          ) : google?.status === 'needs_reauth' ? null : (
            <Check size={16} className="text-good" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-ink">{lead}</p>
          <p className="text-ink-3 tabular-nums" data-testid="ob-import-count">
            {detail}
          </p>
        </div>
      </div>
      {reading && (
        <div
          className="mt-3 h-1 overflow-hidden rounded-full bg-[#eeece8]"
          data-testid="ob-import-bar"
          aria-hidden
        >
          {share === undefined ? (
            <div className="import-bar-moving h-full w-1/3 rounded-full bg-accent" />
          ) : (
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{ width: `${Math.max(4, Math.round(share * 100))}%` }}
            />
          )}
        </div>
      )}
    </div>
  );
}
