import type { CoffeeChat } from '@orbit/core';
import { useState } from 'react';
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
}: {
  chat: CoffeeChat | undefined;
  firstName: string;
  onClose: () => void;
}) {
  const { user } = useSession();
  const toast = useToast();
  const [when, setWhen] = useState(() => {
    const d = new Date(Date.now() + 86_400_000);
    d.setHours(12, 0, 0, 0);
    return localInput(d);
  });
  const [minutes, setMinutes] = useState('30');
  const [busy, setBusy] = useState(false);
  if (!chat || !user) return null;
  const at = new Date(when);
  const past = Number.isNaN(at.getTime()) || at.getTime() < Date.now() - 60_000;
  const save = async () => {
    setBusy(true);
    try {
      await scheduleChatAt(user, chat, at, Number(minutes));
      toast.push({
        text: `Saved. Your chat with ${firstName} is under Coming up on Today, with prep the day before.`,
        tone: 'good',
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`When is your chat with ${firstName}?`}>
      <div className="space-y-3 text-[13.5px]" data-testid="schedule-chat">
        <p className="text-ink-2">
          Orbit shows it under Coming up on Today, puts prep there the day before, and reminds you to say
          thank you after.
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
        {past && <p className="text-[12px] text-warn">Pick a time that has not passed yet.</p>}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="primary" onClick={save} disabled={busy || past} data-testid="schedule-save">
            Save the time
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Not set yet
          </Button>
        </div>
      </div>
    </Modal>
  );
}
