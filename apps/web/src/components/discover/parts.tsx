/**
 * Pieces every Discover card shares: the "Why them" block, the Match and Reach bars, the "not a fit" menu, the
 * LinkedIn degree, and the skeleton shown while a page of people loads.
 */
import type { WhyReason } from '@orbit/core';
import { ThumbsDown } from 'lucide-react';
import { useState } from 'react';
import type { PersonPoint } from '../../engine/personPoints';
import { POINT_LABELS } from '../../engine/personPoints';
import { RECOMMENDATION_DISMISS_REASONS, type RecommendationDismissReason } from '../../engine/recommend';
import { cx } from '../../ui';

/** What the two numbers on a card mean, in one line each: the bars' hover text and the legend above the feed. */
export const SCORE_MEANING = {
  match: 'Match is how well someone fits your goals: their role, company, industry and school.',
  reach:
    'Reach is how warm a path to them is: people you both know, an introducer, what has passed between you.',
} as const;

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
      <ScoreBar label="Match" value={fit} title={`${SCORE_MEANING.match} Out of 100.`} />
      <ScoreBar label="Reach" value={reach} title={`${SCORE_MEANING.reach} Out of 100.`} />
    </div>
  );
}

/** The legend above the feed: what Match and Reach mean, said once for every card. */
export function ScoreLegend() {
  return (
    <p className="text-[12px] text-ink-3 mb-2.5" data-testid="discover-legend">
      <span className="font-medium text-ink-2">Match</span> is how well someone fits your goals;{' '}
      <span className="font-medium text-ink-2">Reach</span> is how warm a path to them is.
    </p>
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

/** How many reasons a card shows before More. */
const WHY_SHOWN = 2;

/**
 * Why them: the reasons behind the pick, strongest first, each from a signal in the account (core whyThem). Two
 * show; More opens the rest in place, with what else is worth knowing about them (the points). A card with little
 * behind it says so in its last line rather than filling the space. The folded lines stay in the page (hidden), so
 * search and screen readers find them.
 */
export function WhyThem({
  reasons,
  points = [],
  testId,
}: {
  reasons: WhyReason[];
  points?: PersonPoint[];
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const lead = reasons.slice(0, WHY_SHOWN);
  const rest = reasons.slice(WHY_SHOWN);
  // a point that says what a reason already says is left out
  const extra = points.filter((pt) => !reasons.some((r) => r.text.toLowerCase() === pt.text.toLowerCase()));
  const hidden = rest.length + extra.length;
  const line = (r: WhyReason, i: number, folded: boolean) => (
    <li
      key={`${r.kind}-${i}`}
      className={cx(
        'flex items-baseline gap-2 min-w-0',
        folded && !open && 'hidden',
        r.kind === 'thin' ? 'text-ink-3' : 'text-ink-2',
      )}
      data-testid="why-reason"
      data-kind={r.kind}
    >
      <span aria-hidden className="shrink-0 text-ink-3">
        {r.kind === 'thin' ? '–' : '•'}
      </span>
      <span className="min-w-0">{r.text}</span>
    </li>
  );
  return (
    <div data-testid={testId} className="min-w-0">
      <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3 mb-1">Why them</p>
      <ul className="space-y-1 text-[13px]">
        {lead.map((r, i) => line(r, i, false))}
        {rest.map((r, i) => line(r, i + WHY_SHOWN, true))}
      </ul>
      {extra.length > 0 && (
        <ul className={cx('mt-1.5 space-y-1.5 text-[13px]', !open && 'hidden')} data-testid="rec-points">
          {extra.map((pt, i) => (
            <li key={`${pt.kind}-${i}`} className="flex items-baseline gap-2.5 min-w-0">
              <span className="w-[74px] shrink-0 whitespace-nowrap text-[11.5px] text-ink-3">
                {POINT_LABELS[pt.kind]}
              </span>
              <span className="text-ink-2 min-w-0">{pt.text}</span>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-1 text-[12px] text-ink-3 hover:text-ink"
          aria-expanded={open}
          data-testid="rec-points-more"
        >
          {open ? 'Less' : `+${hidden} more`}
        </button>
      )}
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
