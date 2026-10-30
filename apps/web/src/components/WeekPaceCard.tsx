import type { PaceStatus, WeekPace } from '@orbit/core';
import { useEffect, useState } from 'react';
import { cx } from '../ui';

const STATUS: Record<PaceStatus, { label: string; tone: string }> = {
  done: { label: 'Done', tone: 'bg-good-soft text-good' },
  ahead: { label: 'Ahead', tone: 'bg-good-soft text-good' },
  on_pace: { label: 'On pace', tone: 'bg-accent-soft text-accent' },
  behind: { label: 'Behind', tone: 'bg-warn-soft text-warn' },
  starting: { label: 'Starting', tone: 'bg-canvas text-ink-2 border border-line' },
  resting: { label: 'Rest day', tone: 'bg-canvas text-ink-2 border border-line' },
};

const DAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekdayOf = (key: string) => new Date(`${key}T00:00:00Z`).getUTCDay();

/** Fills to its value a beat after it shows, so the week's progress reads as movement; still for reduced motion. */
function useGrown(): boolean {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return grown;
}

/**
 * The week's first messages against the student's target: how many went out, where an even pace would be by tonight
 * (the tick on the bar), which days carry messages (the dots under it: grey gone by, today green, open to come), and
 * what today needs, in one line.
 */
export function WeekPaceCard({ pace, line }: { pace: WeekPace; line: string }) {
  const grown = useGrown();
  const target = pace.target;
  const pct = target ? Math.min(1, pace.sent / target) : 0;
  const tick = target ? Math.min(1, pace.expected / target) : 0;
  const status = STATUS[pace.status];
  const showTick = target > 0 && pace.status !== 'done' && pace.status !== 'starting' && tick > 0 && tick < 1;
  return (
    <div className="rounded-[14px] bg-canvas-2 px-3.5 py-3" data-testid="morning-pace">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[12px] text-ink-3">First messages this week</div>
          <div className="text-[22px] leading-tight tracking-[-0.02em] tabular mt-0.5">
            {pace.sent}
            {target > 0 && <span className="text-[14px] text-ink-3"> / {target}</span>}
          </div>
        </div>
        <span
          className={cx(
            'mt-0.5 shrink-0 h-6 px-2.5 inline-flex items-center rounded-full text-[12px] font-medium fade-up',
            status.tone,
          )}
          data-testid="morning-pace-status"
        >
          {status.label}
        </span>
      </div>
      <div className="relative mt-2.5 h-1.5 rounded-full bg-line" aria-hidden>
        <div
          className={cx(
            'absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
            pace.status === 'done' ? 'bg-good' : 'bg-accent',
          )}
          style={{ width: `${Math.round((grown ? pct : 0) * 100)}%` }}
        />
        {showTick && (
          <div
            className="absolute -top-[3px] h-3 w-[2px] -translate-x-1/2 rounded-full bg-ink-3 transition-opacity duration-500 delay-300 motion-reduce:transition-none"
            style={{ left: `${tick * 100}%`, opacity: grown ? 0.55 : 0 }}
            title={`An even pace is ${pace.expected} by tonight`}
          />
        )}
      </div>
      <div className="mt-2 flex justify-between" aria-hidden>
        {pace.days.map((d) => (
          <span
            key={d.key}
            className="flex flex-col items-center gap-1 w-5"
            title={DAY_NAME[weekdayOf(d.key)]}
          >
            <span
              className={cx(
                'h-1.5 w-1.5 rounded-full transition-colors',
                // a day off is faint, a working day gone by is grey, one to come is an open ring
                !d.counted
                  ? 'bg-line'
                  : d.when === 'past'
                    ? 'bg-ink-3/60'
                    : d.when === 'today'
                      ? // today's dot breathes while today's first messages are still to send
                        cx('bg-accent ring-[3px] ring-accent/20', pace.leftToday > 0 && 'breathe')
                      : 'border border-ink-3/60',
              )}
            />
            <span
              className={cx(
                'text-[10px] leading-none',
                d.when === 'today' ? 'text-ink font-medium' : d.counted ? 'text-ink-3' : 'text-ink-3/50',
              )}
            >
              {DAY_LETTER[weekdayOf(d.key)]}
            </span>
          </span>
        ))}
      </div>
      <p className="text-[12.5px] leading-[1.45] text-ink-2 mt-2.5" data-testid="morning-pace-line">
        {line}
      </p>
    </div>
  );
}
