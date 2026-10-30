import { weeklyCapacity } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Gauge, Users } from 'lucide-react';
import { db } from '../db/schema';
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

/** What a weekly target means per working day, said plainly: first messages go out Monday to Friday. */
function perDay(value: number): string {
  if (value <= 5) return value === 1 ? 'one over the week' : `${value} spread over the week`;
  return `about ${Math.round(value / 5)} a weekday`;
}

/** What the target runs into: the sending limits (a week's worth) and the good matches lined up right now. */
export interface WeeklyLimits {
  perWeek: number;
  pool?: number;
}

/** The student's limits, live: their sending limits and the matches Discover holds that they have not acted on. */
export function useWeeklyLimits(userId: string): WeeklyLimits | undefined {
  return useLiveQuery(async () => {
    const [settings, pool] = await Promise.all([
      db.settings.get(userId),
      db.recommendations
        .where('userId')
        .equals(userId)
        .filter((r) => r.status === 'new' || r.status === 'saved')
        .count(),
    ]);
    if (!settings) return undefined;
    return { perWeek: weeklyCapacity(settings), pool };
  }, [userId]);
}

/** A plain note on a target out of reach: past the sending limits, or past the matches lined up. */
export function limitNotes(value: number, limits?: WeeklyLimits): { kind: 'cap' | 'pool'; text: string }[] {
  if (!limits) return [];
  const out: { kind: 'cap' | 'pool'; text: string }[] = [];
  if (limits.perWeek > 0 && value > limits.perWeek)
    out.push({
      kind: 'cap',
      text: `Your daily sending limits cover about ${limits.perWeek} a week. Orbit plans each day up to the limit, and the rest waits.`,
    });
  const pool = limits.pool ?? 0;
  if (pool > 0 && value > 0 && pool < value * 3) {
    const weeks = Math.floor(pool / value);
    const enough =
      weeks < 1 ? 'less than a week at this pace' : `about ${weeks} week${weeks > 1 ? 's' : ''} at this pace`;
    out.push({
      kind: 'pool',
      text: `${pool} strong match${pool > 1 ? 'es are' : ' is'} lined up now, ${enough}.`,
    });
  }
  return out;
}

const INK = '#0a0a0a';
const WARN = 'var(--color-warn, #9a5b00)';
const TRACK = 'var(--color-line, #e7e5e1)';

/** First messages a week, from 1 to 350, on one slider, with where the student's limits stand on it. */
export function WeeklyTargetSlider({
  value,
  onChange,
  id,
  testId,
  limits,
}: {
  value: number;
  onChange: (value: number) => void;
  id?: string;
  testId?: string;
  limits?: WeeklyLimits;
}) {
  const last = WEEKLY_TARGET_STEPS.length - 1;
  const index = stepIndexFor(value);
  const pct = (index / last) * 100;
  // the sending limits as a place on the track; past it the fill turns amber
  const capPct =
    limits && limits.perWeek > 0 && limits.perWeek < WEEKLY_TARGET_MAX
      ? (stepIndexFor(limits.perWeek) / last) * 100
      : undefined;
  const over = capPct !== undefined && value > limits!.perWeek;
  const background = over
    ? `linear-gradient(to right, ${INK} ${capPct}%, ${WARN} ${capPct}%, ${WARN} ${pct}%, ${TRACK} ${pct}%)`
    : `linear-gradient(to right, ${INK} ${pct}%, ${TRACK} ${pct}%)`;
  const notes = limitNotes(value, limits);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <span
          className="text-[15px] font-medium tabular-nums"
          data-testid={testId ? `${testId}-value` : undefined}
        >
          {value} a week
        </span>
        <span className={cx('text-[12.5px] transition-colors', over ? 'text-warn' : 'text-ink-3')}>
          {paceLabel(value)} · {perDay(value)}
        </span>
      </div>
      <div className="relative">
        <input
          id={id}
          type="range"
          min={0}
          max={last}
          step={1}
          value={index}
          onChange={(e) => onChange(WEEKLY_TARGET_STEPS[Number(e.target.value)] ?? value)}
          aria-label="First messages a week"
          aria-valuetext={`${value} a week`}
          className={cx(
            'relative z-[1] w-full h-1.5 rounded-full appearance-none cursor-pointer bg-line accent-ink',
            'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ink/15',
            '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-ink [&::-webkit-slider-thumb]:border-[3px] [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:shadow-[0_0_0_1px_#0a0a0a]',
            '[&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-ink [&::-moz-range-thumb]:border-[3px] [&::-moz-range-thumb]:border-white',
          )}
          // the filled part of the track, up to the thumb (amber past the sending limits)
          style={{ background }}
          data-testid={testId}
        />
        {capPct !== undefined && (over || value >= limits!.perWeek * 0.6) && (
          <span
            className="absolute top-1/2 h-3.5 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-warn/70 pointer-events-none fade-up"
            style={{ left: `${capPct}%` }}
            title={`Your sending limits: about ${limits!.perWeek} a week`}
            aria-hidden
          />
        )}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-ink-3 tabular-nums" aria-hidden>
        <span>1</span>
        <span>{WEEKLY_TARGET_MAX}</span>
      </div>
      {notes.length > 0 && (
        <ul
          className="mt-2.5 space-y-1.5"
          aria-live="polite"
          data-testid={testId ? `${testId}-notes` : undefined}
        >
          {notes.map((n) => (
            <li
              // a new kind of note rises in; one that stays keeps still while the number moves
              key={n.kind}
              className={cx(
                'flex items-start gap-2 rounded-[10px] px-3 py-2 text-[12.5px] leading-[1.45] fade-up',
                n.kind === 'cap' ? 'bg-warn-soft text-warn' : 'bg-canvas-2 text-ink-2',
              )}
            >
              {n.kind === 'cap' ? (
                <Gauge size={14} className="mt-[2px] shrink-0" aria-hidden />
              ) : (
                <Users size={14} className="mt-[2px] shrink-0 text-ink-3" aria-hidden />
              )}
              <span>{n.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
