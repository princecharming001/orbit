import type { User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { calAvailable, calStatus, eventTypeLabel } from '../engine/calcom';
import { Input, Label, Select } from '../ui';

const OTHER = '__other';

/**
 * The booking link drafts offer when proposing times. With Cal.com connected it is picked from the student's event
 * types (or "Other link…" for any other page); without it, it is typed in, with a quiet way to connect Cal.com.
 */
export function SchedulingLinkField({
  user,
  value,
  onChange,
}: {
  user: Pick<User, 'id'>;
  value: string | undefined;
  onChange: (link: string | undefined) => void;
}) {
  const status = useLiveQuery(() => calStatus(user), [user.id]);
  const types = status?.connected ? status.eventTypes.filter((t) => !t.hidden || t.url === value) : [];
  const matched = types.some((t) => t.url === value);
  const [other, setOther] = useState(false);
  const showPicker = types.length > 0;
  const picked = !value ? '' : matched && !other ? value : OTHER;
  const typing = !showPicker || picked === OTHER;
  return (
    <div>
      <Label htmlFor={showPicker ? 'lim-sched-pick' : 'lim-sched'} optional>
        Scheduling link
      </Label>
      {showPicker && (
        <Select
          id="lim-sched-pick"
          value={picked}
          onChange={(e) => {
            const v = e.target.value;
            if (v === OTHER) {
              setOther(true);
              return;
            }
            setOther(false);
            onChange(v || undefined);
          }}
          className="w-full"
          data-testid="scheduling-link-select"
        >
          <option value="">None</option>
          {types.map((t) => (
            <option key={String(t.id)} value={t.url}>
              {eventTypeLabel(t)}
            </option>
          ))}
          <option value={OTHER}>Other link…</option>
        </Select>
      )}
      {typing && (
        <Input
          id="lim-sched"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder="https://cal.com/you/20min"
          className={showPicker ? 'mt-2' : undefined}
          aria-label={showPicker ? 'Other scheduling link' : undefined}
        />
      )}
      <p className="text-[12px] text-ink-3 mt-1">
        Orbit adds it when you propose times for a chat.
        {status && !status.connected && calAvailable(user) && (
          <>
            {' '}
            <Link
              to="/settings/integrations"
              className="underline underline-offset-2 hover:text-ink"
              data-testid="scheduling-link-connect"
            >
              Connect Cal.com
            </Link>{' '}
            to pick from your event types.
          </>
        )}
      </p>
    </div>
  );
}
