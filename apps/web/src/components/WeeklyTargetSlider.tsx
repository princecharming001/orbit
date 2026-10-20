import { cx } from '../ui';

/** The most first messages a week a student can aim for. */
export const WEEKLY_TARGET_MAX = 350;

/**
 * The values the slider stops at: one at a time at the low end, where a student picks carefully, and in bigger
 * steps towards 350, so a 1 and a 4 are as easy to land on as a 300.
 */
export const WEEKLY_TARGET_STEPS: number[] = (() => {
  const out: number[] = [];
  for (let v = 1; v <= 10; v++) out.push(v);
  for (let v = 12; v <= 30; v += 2) out.push(v);
  for (let v = 35; v <= 100; v += 5) out.push(v);
  for (let v = 110; v <= WEEKLY_TARGET_MAX; v += 10) out.push(v);
  return out;
})();

/** The slider position for a stored target: the nearest stop. */
export function stepIndexFor(value: number): number {
  let best = 0;
  for (let i = 0; i < WEEKLY_TARGET_STEPS.length; i++)
    if (Math.abs(WEEKLY_TARGET_STEPS[i]! - value) < Math.abs(WEEKLY_TARGET_STEPS[best]! - value)) best = i;
  return best;
}

/** A word for the pace, so the number reads as a choice and not a quota. */
export function paceLabel(value: number): string {
  if (value <= 3) return 'Steady';
  if (value <= 7) return 'Focused';
  if (value <= 30) return 'All in';
  return 'Full season push';
}

/** What a weekly target means per day, said plainly. */
function perDay(value: number): string {
  const d = value / 7;
  if (d < 1) return 'under one a day';
  return `about ${Math.round(d)} a day`;
}

/** First messages a week, from 1 to 350, on one slider. */
export function WeeklyTargetSlider({
  value,
  onChange,
  id,
  testId,
}: {
  value: number;
  onChange: (value: number) => void;
  id?: string;
  testId?: string;
}) {
  const index = stepIndexFor(value);
  const pct = (index / (WEEKLY_TARGET_STEPS.length - 1)) * 100;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <span
          className="text-[15px] font-medium tabular-nums"
          data-testid={testId ? `${testId}-value` : undefined}
        >
          {value} a week
        </span>
        <span className="text-[12.5px] text-ink-3">
          {paceLabel(value)} · {perDay(value)}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={WEEKLY_TARGET_STEPS.length - 1}
        step={1}
        value={index}
        onChange={(e) => onChange(WEEKLY_TARGET_STEPS[Number(e.target.value)] ?? value)}
        aria-label="First messages a week"
        aria-valuetext={`${value} a week`}
        className={cx(
          'w-full h-1.5 rounded-full appearance-none cursor-pointer bg-line accent-ink',
          'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ink/15',
          '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-ink [&::-webkit-slider-thumb]:border-[3px] [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:shadow-[0_0_0_1px_#0a0a0a]',
          '[&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-ink [&::-moz-range-thumb]:border-[3px] [&::-moz-range-thumb]:border-white',
        )}
        // the filled part of the track, up to the thumb
        style={{
          background: `linear-gradient(to right, #0a0a0a ${pct}%, var(--color-line, #e7e5e1) ${pct}%)`,
        }}
        data-testid={testId}
      />
      <div className="mt-1.5 flex justify-between text-[11px] text-ink-3 tabular-nums" aria-hidden>
        <span>1</span>
        <span>{WEEKLY_TARGET_MAX}</span>
      </div>
    </div>
  );
}
