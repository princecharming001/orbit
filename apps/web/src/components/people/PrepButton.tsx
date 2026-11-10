/**
 * Prep for the call: opens the Prep deck over the person's page (`?prep=1`). With a chat on the calendar in the next
 * day it says when, so the student knows this is the one to open now.
 */
import type { CalendarEvent } from '@orbit/core';
import { Presentation } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { Button, cx } from '../../ui';
import { chatTimeLabel } from '../ScheduleChat';

const DAY = 86_400_000;

/** The next chat is soon enough that prep is the thing to do now: within a day, or up to two hours after it. */
export function prepIsDue(event: Pick<CalendarEvent, 'startAt'> | undefined, now = new Date()): boolean {
  if (!event) return false;
  const t = new Date(event.startAt).getTime() - now.getTime();
  return t < DAY && t > -2 * 3_600_000;
}

export function PrepButton({
  event,
  variant = 'primary',
  testId = 'prep-open',
  className,
}: {
  event?: Pick<CalendarEvent, 'startAt'>;
  /** `round`: a circular icon button, for the end of a tab row; the label is its tooltip and its name */
  variant?: 'primary' | 'ghost' | 'round';
  testId?: string;
  className?: string;
}) {
  const [params, setParams] = useSearchParams();
  const due = prepIsDue(event);
  const open = () => {
    const next = new URLSearchParams(params);
    next.set('prep', '1');
    setParams(next);
  };
  if (variant === 'round') {
    const label = due && event ? `Prep for the call, ${chatTimeLabel(event.startAt)}` : 'Prep for the call';
    return (
      <button
        type="button"
        onClick={open}
        aria-label={label}
        title={label}
        className={cx(
          className,
          'relative ml-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25',
          due
            ? 'border-accent bg-accent text-white hover:bg-accent-2'
            : 'border-line bg-canvas text-ink-2 hover:text-ink hover:bg-canvas-2',
        )}
        data-testid={testId}
      >
        <Presentation size={15} aria-hidden />
      </button>
    );
  }
  return (
    <Button
      size="sm"
      variant={variant}
      onClick={open}
      data-testid={testId}
      title="Everything for the call, one card at a time"
    >
      <Presentation size={14} aria-hidden />
      Prep for the call
      {due && event && <span className="font-normal opacity-80">· {chatTimeLabel(event.startAt)}</span>}
    </Button>
  );
}
