/**
 * Pieces every Discover card shares: the Match and Reach bars, the "not a fit" menu, the LinkedIn degree, the
 * folded details, and the skeleton shown while a page of people loads.
 */
import { ThumbsDown } from 'lucide-react';
import { useState } from 'react';
import type { PersonPoint } from '../../engine/personPoints';
import { POINT_LABELS } from '../../engine/personPoints';
import { RECOMMENDATION_DISMISS_REASONS, type RecommendationDismissReason } from '../../engine/recommend';
import { cx } from '../../ui';

/** A score out of 100 as a short bar: easier to compare down a list of cards than two numbers. */
export function ScoreBar({ label, value, title }: { label: string; value: number; title: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div
      title={title}
      role="meter"
      aria-label={label}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="flex items-baseline justify-between text-[11.5px] text-ink-3">
        <span>{label}</span>
        <span className="tabular text-ink-2">{pct}</span>
      </div>
      <div className="mt-1 h-1 rounded-full bg-line-2 overflow-hidden">
        <div
          className={cx(
            'h-full rounded-full',
            pct >= 70 ? 'bg-accent' : pct >= 50 ? 'bg-accent/60' : 'bg-ink-3/40',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Match and Reach side by side. */
export function ScoreBars({ fit, reach, testId }: { fit: number; reach: number; testId: string }) {
  return (
    <div className="grid grid-cols-2 gap-4" data-testid={testId}>
      <ScoreBar
        label="Match"
        value={fit}
        title="How well their role and company fit your goals, out of 100"
      />
      <ScoreBar label="Reach" value={reach} title="How easy they are to reach, out of 100" />
    </div>
  );
}

/** "2nd" or "3rd": how far out on LinkedIn they are. */
export function DegreeBadge({ distance }: { distance?: number }) {
  if (distance !== 2 && distance !== 3) return null;
  return (
    <span
      className="shrink-0 px-1.5 h-[18px] inline-flex items-center rounded-full border border-line text-[11px] text-ink-3 tabular"
      title={
        distance === 2
          ? 'Second degree: you share connections on LinkedIn'
          : 'Third degree: further out on LinkedIn'
      }
    >
      {distance === 2 ? '2nd' : '3rd'}
    </span>
  );
}

/** Not a fit? The reasons, folded behind a thumbs-down until the student says so. */
export function DismissMenu({
  onPick,
  testId,
}: {
  onPick: (reason: RecommendationDismissReason, label: string) => void;
  testId?: string;
}) {
  return (
    <details className="group ml-auto" data-testid={testId}>
      <summary
        className="list-none cursor-pointer w-8 h-8 rounded-full inline-flex items-center justify-center text-ink-3 hover:text-ink hover:bg-canvas-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25 [&::-webkit-details-marker]:hidden"
        aria-label="Not a fit?"
        title="Not a fit? Tell Orbit why"
      >
        <ThumbsDown size={15} />
      </summary>
      <div
        className="pop-in absolute z-20 right-3 bottom-14 w-[min(280px,calc(100%-24px))] rounded-[14px] border border-line bg-canvas p-2 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.18)]"
        role="group"
        aria-label="Not a fit? Tell Orbit why"
      >
        <div className="px-1.5 pb-1.5 text-[12px] text-ink-3">Not a fit? Tell Orbit why</div>
        <div className="flex flex-wrap gap-1">
          {(Object.entries(RECOMMENDATION_DISMISS_REASONS) as [RecommendationDismissReason, string][]).map(
            ([k, l]) => (
              <button
                key={k}
                type="button"
                className="px-2.5 h-7 rounded-full border border-line bg-canvas text-[12px] text-ink-2 hover:text-ink hover:border-[#d4d2ce] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25"
                onClick={() => onPick(k, l)}
                data-testid={`dismiss-${k}`}
              >
                {l}
              </button>
            ),
          )}
        </div>
      </div>
    </details>
  );
}

/**
 * The rest of what is worth knowing about someone, folded: the card leads with one reason, and More opens these in
 * place. The folded lines stay in the page (hidden), so search and screen readers find them.
 */
export function MorePoints({ points }: { points: PersonPoint[] }) {
  const [open, setOpen] = useState(false);
  if (!points.length) return null;
  return (
    <div data-testid="rec-points">
      <ul className={cx('space-y-1.5 text-[13px]', !open && 'hidden')}>
        {points.map((pt, i) => (
          <li key={`${pt.kind}-${i}`} className="flex items-baseline gap-2.5 min-w-0">
            <span className="w-[74px] shrink-0 whitespace-nowrap text-[11.5px] text-ink-3">
              {POINT_LABELS[pt.kind]}
            </span>
            <span className="text-ink-2 min-w-0">{pt.text}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cx('text-[12px] text-ink-3 hover:text-ink', open && 'mt-1.5')}
        aria-expanded={open}
        data-testid="rec-points-more"
      >
        {open ? 'Less' : `+${points.length} more about them`}
      </button>
    </div>
  );
}

/** A card-shaped placeholder while a page of people loads. */
export function CardSkeleton() {
  return (
    <div
      className="bg-canvas border border-line rounded-[var(--radius-card)] p-4 flex flex-col gap-3 animate-pulse"
      aria-hidden
      data-testid="discover-skeleton"
    >
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-full bg-line-2" />
        <div className="flex-1 space-y-2 pt-1">
          <div className="h-3 w-2/5 rounded bg-line-2" />
          <div className="h-3 w-3/5 rounded bg-line-2" />
        </div>
      </div>
      <div className="h-3 w-4/5 rounded bg-line-2" />
      <div className="grid grid-cols-2 gap-4">
        <div className="h-2 rounded bg-line-2" />
        <div className="h-2 rounded bg-line-2" />
      </div>
      <div className="h-8 w-1/3 rounded-full bg-line-2 mt-2" />
    </div>
  );
}
