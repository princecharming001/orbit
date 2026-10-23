/**
 * Pieces every Discover card shares: the "Why them" block, the Match, Reach and Reply odds meters, the "not a fit"
 * menu, the LinkedIn degree, and the skeleton shown while a page of people loads.
 */
import type { WhyReason } from '@orbit/core';
import { ThumbsDown } from 'lucide-react';
import { useState } from 'react';
import type { PersonPoint } from '../../engine/personPoints';
import { POINT_LABELS } from '../../engine/personPoints';
import { RECOMMENDATION_DISMISS_REASONS, type RecommendationDismissReason } from '../../engine/recommend';
import { cx } from '../../ui';

/** What each meter on a card means, in one line: the meters' hover text. */
export const SCORE_MEANING = {
  match: 'Match: how well they fit your goals (role, company, school).',
  reach: 'Reach: how warm your path to them is (people you both know, an introducer, your history).',
  odds: 'Reply odds: how likely they are to answer you (seniority, what you share, a warm path, who replied before).',
} as const;

/** How many segments a meter has, and the band a score falls in: one segment per fifth, like a signal meter. */
export const METER_SEGMENTS = 5;
const BAND_WORDS = ['Very low', 'Low', 'Fair', 'Good', 'Strong'] as const;

/** The segments lit for a score out of 100: at least one for anything above zero. */
export function litSegments(pct: number): number {
  if (pct <= 0) return 0;
  return Math.max(1, Math.min(METER_SEGMENTS, Math.ceil(pct / (100 / METER_SEGMENTS))));
}

/**
 * A score out of 100 as a segmented meter: five segments lit by band, like a signal-strength meter, so a row of
 * cards compares at a glance. The number is in the hover text and read out by screen readers.
 */
export function SegmentMeter({ label, value, title }: { label: string; value: number; title: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  const lit = litSegments(pct);
  const word = BAND_WORDS[Math.max(0, lit - 1)]!;
  const tone = lit >= 4 ? 'bg-accent' : lit === 3 ? 'bg-accent/55' : 'bg-ink-3/45';
  return (
    <div
      title={`${title} ${pct} out of 100.`}
      role="meter"
      aria-label={label}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${pct} out of 100, ${word.toLowerCase()}`}
      data-lit={lit}
      className="min-w-0"
    >
      <div className="text-[11.5px] text-ink-3 truncate">{label}</div>
      <div className="mt-1 grid grid-cols-5 gap-[3px]" aria-hidden>
        {Array.from({ length: METER_SEGMENTS }, (_, i) => (
          <span
            key={i}
            className={cx('h-1.5 rounded-[2px]', i < lit ? tone : 'bg-line-2')}
            data-testid="meter-segment"
            data-lit={i < lit}
          />
        ))}
      </div>
    </div>
  );
}

/** Match, Reach and Reply odds side by side, the same on every card. */
export function ScoreBars({
  fit,
  reach,
  odds,
  testId,
}: {
  fit: number;
  reach: number;
  odds: number;
  testId: string;
}) {
  return (
    <div className="grid grid-cols-3 gap-3" data-testid={testId}>
      <SegmentMeter label="Match" value={fit} title={SCORE_MEANING.match} />
      <SegmentMeter label="Reach" value={reach} title={SCORE_MEANING.reach} />
      <SegmentMeter label="Reply odds" value={odds} title={SCORE_MEANING.odds} />
    </div>
  );
}

/** The legend above the feed: the three meters, said once for every card, on one line. */
export function ScoreLegend() {
  return (
    <p className="text-[12px] text-ink-3 mb-2.5" data-testid="discover-legend">
      <span className="font-medium text-ink-2">Match</span> your goals ·{' '}
      <span className="font-medium text-ink-2">Reach</span> your way in ·{' '}
      <span className="font-medium text-ink-2">Reply odds</span> will they answer
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
 * Why them: the reasons behind the pick, the most specific first, each from a signal in the account (core whyThem).
 * Two show; More opens the rest in place, with what else is worth knowing about them (the points). Discover shows
 * nobody without a specific reason, so no card fills the space with how little is known. The folded lines stay in
 * the page (hidden), so search and screen readers find them.
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
      <div className="grid grid-cols-3 gap-3">
        <div className="h-2 rounded bg-line-2" />
        <div className="h-2 rounded bg-line-2" />
        <div className="h-2 rounded bg-line-2" />
      </div>
      <div className="h-8 w-1/3 rounded-full bg-line-2 mt-2" />
    </div>
  );
}
