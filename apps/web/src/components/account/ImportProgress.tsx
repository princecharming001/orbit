import { useSyncStatus } from '../../state/account';

const fmt = (n: number | undefined) => (n ?? 0).toLocaleString('en-US');

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
  if (google?.status === 'needs_reauth') {
    lead = 'Google needs you to sign in again before Orbit can read your email.';
    detail = 'Sign in with Google again from Settings, Account.';
  } else if (!bf || bf.phase === 'recent' || bf.phase === null) {
    lead = `${firstName ? `Hi ${firstName}. ` : ''}I'm reading your last 90 days of email first.`;
    detail = status ? `${fmt(messages)} messages · ${fmt(people)} people so far` : 'Getting started…';
  } else if (bf.phase === 'deep') {
    lead = 'Your recent email is in.';
    detail = bf.total
      ? `Reading older email: ${fmt(bf.done)} of ${fmt(bf.total)}`
      : `${fmt(messages)} messages · ${fmt(people)} people so far`;
  } else {
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
      <p className="text-ink">{lead}</p>
      <p className="text-ink-3 tabular-nums" data-testid="ob-import-count">
        {detail}
      </p>
    </div>
  );
}
