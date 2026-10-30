import type { SyncStatus } from '../integrations/orbitApi';
import { useSyncStatus } from '../state/account';

/** Below this many people still on their way, the map has caught up: a refresh in flight is not worth a banner. */
const GAP_SHOWN = 5;

const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * What is still on its way to the map, or nothing: LinkedIn's first pass bringing connections in, the email import
 * reading for more people, or people the server has that this browser has not pulled yet. `have` is the people the
 * browser holds. Account mode only: without a server status there is nothing to wait for.
 */
export function arriving(
  status: SyncStatus | undefined,
  have: number,
): { lead: string; detail: string; share?: number } | undefined {
  if (!status) return undefined;
  const total = status.counts.people;
  const gap = total === undefined ? 0 : total - have;
  const linkedin = status.integrations.some((i) => i.provider === 'linkedin' && i.importing);
  const phase = status.integrations.find((i) => i.provider === 'google')?.backfill?.phase;
  const email = phase === 'recent' || phase === 'deep';
  if (!linkedin && !email && gap <= GAP_SHOWN) return undefined;
  const lead = linkedin
    ? 'Bringing in your LinkedIn connections'
    : email
      ? 'Reading your email for more people'
      : `Loading ${fmt(gap)} more ${gap === 1 ? 'person' : 'people'}`;
  // the share only while the server is ahead of the browser: during an import the total is still growing
  const behind = total !== undefined && gap > GAP_SHOWN;
  return {
    lead,
    detail: behind ? `${fmt(have)} of ${fmt(total)} on the map` : `${fmt(have)} on the map so far`,
    ...(behind && !linkedin && !email ? { share: have / total } : {}),
  };
}

/**
 * A small card at the top of the map while people are still coming in: a breathing dot, what is arriving and how many
 * are here, over a bar that slides (or fills, when the total is known). It rises in, and leaves once the map has
 * caught up.
 */
export function PeopleArriving({ have }: { have: number }) {
  const status = useSyncStatus();
  const a = arriving(status, have);
  if (!a) return null;
  return (
    <div
      className="absolute top-3 left-1/2 -translate-x-1/2 z-10 w-[min(320px,calc(100%-24px))] rounded-[14px] border border-line bg-canvas/95 backdrop-blur px-3.5 pt-2.5 pb-2.5 shadow-[var(--shadow-card)] fade-up pointer-events-none"
      role="status"
      aria-live="polite"
      data-testid="map-arriving"
    >
      <div className="flex items-center gap-2.5">
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
          <span className="absolute inset-0 rounded-full bg-accent breathe" />
        </span>
        <div className="min-w-0">
          <p className="text-[13px] leading-tight text-ink truncate">{a.lead}</p>
          <p
            className="text-[11.5px] leading-tight text-ink-3 tabular-nums mt-0.5"
            data-testid="map-arriving-count"
          >
            {a.detail}
          </p>
        </div>
      </div>
      <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-line" aria-hidden>
        {a.share === undefined ? (
          <div className="import-bar-moving h-full w-1/3 rounded-full bg-accent" />
        ) : (
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500 motion-reduce:transition-none"
            style={{ width: `${Math.max(4, Math.round(a.share * 100))}%` }}
          />
        )}
      </div>
    </div>
  );
}
