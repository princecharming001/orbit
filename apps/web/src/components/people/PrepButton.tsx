/**
 * Prep for the call: opens the Prep deck over the person's page (`?prep=1`). With a chat on the calendar in the next
 * day it says when, so the student knows this is the one to open now.
 */
import type { CalendarEvent } from '@orbit/core';
import { Presentation } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '../../ui';
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
}: {
  event?: Pick<CalendarEvent, 'startAt'>;
  variant?: 'primary' | 'ghost';
  testId?: string;
}) {
  const [params, setParams] = useSearchParams();
  const due = prepIsDue(event);
  return (
    <Button
      size="sm"
      variant={variant}
      onClick={() => {
        const next = new URLSearchParams(params);
        next.set('prep', '1');
        setParams(next);
      }}
      data-testid={testId}
      title="Everything for the call, one card at a time"
    >
      <Presentation size={14} aria-hidden />
      Prep for the call
      {due && event && <span className="font-normal opacity-80">· {chatTimeLabel(event.startAt)}</span>}
    </Button>
  );
}
