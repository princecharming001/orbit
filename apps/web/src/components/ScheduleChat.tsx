import type { CoffeeChat } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db } from '../db/schema';
import { calendarInvitesAvailable, canInviteFor, sendCalendarInvite } from '../engine/calendarInvite';
import { scheduleChatAt } from '../engine/move';
import { useSession } from '../state/session';
import { Button, Input, Label, Modal, Select, useToast } from '../ui';

/** "2026-10-08T15:00" for a datetime-local input, in the browser's clock. */
function localInput(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * Asked when a chat moves to Scheduled and Orbit has no meeting for it (no calendar connected, or not on it yet):
 * the time puts it under Coming up, brings a prep card the day before, and moves it to Completed once it has passed.
 */
export function ScheduleChatDialog({
  chat,
  firstName,
  onClose,
  current,
}: {
  chat: CoffeeChat | undefined;
  firstName: string;
  onClose: () => void;
  /** the time already saved, when the student is changing it */
  current?: string;
}) {
  const { user } = useSession();
  const toast = useToast();
  const [when, setWhen] = useState(() => {
    if (current && new Date(current).getTime() > Date.now()) return localInput(new Date(current));
    const d = new Date(Date.now() + 86_400_000);
    d.setHours(12, 0, 0, 0);
    return localInput(d);
  });
  const [minutes, setMinutes] = useState('30');
  const [busy, setBusy] = useState(false);
  const email = useLiveQuery(
    async () => (chat ? ((await db.people.get(chat.personId))?.primaryEmail ?? '') : ''),
    [chat?.personId],
  );
  // a meeting already on the calendar (or already invited) is moved there, never invited twice
  const onCalendar = useLiveQuery(async () => {
    const ev = chat?.scheduledEventId ? await db.events.get(chat.scheduledEventId) : undefined;
    return !!ev && !canInviteFor(ev);
  }, [chat?.scheduledEventId]);
  // a new time can go out as a Google Calendar invite, ticked by default; an existing time is just moved
  const [invite, setInvite] = useState(!current);
  if (!chat || !user) return null;
  const canInvite = !!email && !onCalendar && calendarInvitesAvailable(user);
  const at = new Date(when);
  const past = Number.isNaN(at.getTime()) || at.getTime() < Date.now() - 60_000;
  const save = async () => {
    setBusy(true);
    try {
      if (canInvite && invite) {
        const r = await sendCalendarInvite(user, chat, { at, minutes: Number(minutes) });
        toast.push(
          r.ok
            ? {
                text: `On your calendar, and Google sent ${firstName} the invite${r.meetUrl ? ' with a Meet link' : ''}.`,
                tone: 'good',
              }
            : { text: `Saved the time, but the invite did not go out: ${r.message}`, tone: 'bad', ttl: 9000 },
        );
      } else {
        await scheduleChatAt(user, chat, at, Number(minutes));
        toast.push({
          text: `Saved. Your chat with ${firstName} is under Coming up in Drafts, with prep the day before.`,
          tone: 'good',
        });
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`When is your chat with ${firstName}?`}>
      <div className="space-y-3 text-[13.5px]" data-testid="schedule-chat">
        <p className="text-ink-2">
          Orbit puts prep in Drafts the day before and reminds you to say thanks after.
        </p>
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <div>
            <Label htmlFor="schedule-when">Date and time</Label>
            <Input
              id="schedule-when"
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              className="w-full"
            />
          </div>
          <div>
            <Label htmlFor="schedule-length">Length</Label>
            <Select id="schedule-length" value={minutes} onChange={(e) => setMinutes(e.target.value)}>
              <option value="15">15 min</option>
              <option value="20">20 min</option>
              <option value="30">30 min</option>
              <option value="45">45 min</option>
              <option value="60">1 hour</option>
            </Select>
          </div>
        </div>
        {canInvite && (
          <label className="flex items-start gap-2 text-[13px]" data-testid="schedule-invite">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={invite}
              onChange={(e) => setInvite(e.target.checked)}
            />
            <span>
              Add it to my Google Calendar and send {firstName} the invite, with a Meet link
              <span className="block text-[12px] text-ink-3">To {email}</span>
            </span>
          </label>
        )}
        {onCalendar && current && (
          <p className="text-[12px] text-ink-3">It is on your Google Calendar: move it there too.</p>
        )}
        {past && <p className="text-[12px] text-warn">Pick a time that has not passed yet.</p>}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="primary" onClick={save} disabled={past} loading={busy} data-testid="schedule-save">
            {canInvite && invite ? 'Save and send invite' : 'Save the time'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {current ? 'Keep the time' : 'Not set yet'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** "Wed, Oct 7, 11:30 AM": when a booked chat is, on the People board's card and the person page. */
export function chatTimeLabel(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Asked before a chat whose meeting is still ahead is marked done: marking it done writes a thank-you for a talk that
 * has not happened.
 */
export function ConfirmEarlyDone({
  firstName,
  at,
  onConfirm,
  onClose,
}: {
  firstName: string;
  at: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal open onClose={onClose} title={`Mark your chat with ${firstName} as done?`}>
      <div className="space-y-3 text-[13.5px]" data-testid="confirm-early-done">
        <p className="text-ink-2">
          It is on your list for {chatTimeLabel(at)}, which has not come yet. Marking it done now drafts a
          thank-you for a chat that has not happened.
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="primary" onClick={onClose}>
            Keep it scheduled
          </Button>
          <Button onClick={onConfirm} data-testid="confirm-early-done-yes">
            Mark done anyway
          </Button>
        </div>
      </div>
    </Modal>
  );
}
