import type { User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { calStatus, eventTypeLabel } from '../engine/calcom';
import { Input, Label, Select } from '../ui';

const OTHER = '__other';

/**
 * The booking link drafts offer when proposing times. With Cal.com connected it is picked from the student's event
 * types (or "Other link…" for any other page); without it, it is typed in.
 */
export function SchedulingLinkField({
  user,
  value,
  onChange,
  compact,
}: {
  user: Pick<User, 'id'>;
  value: string | undefined;
  onChange: (link: string | undefined) => void;
  /** inside the Cal.com row: no heading or hint, the row says what it is */
  compact?: boolean;
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
      {compact ? null : (
        <Label htmlFor={showPicker ? 'lim-sched-pick' : 'lim-sched'} optional>
          Scheduling link
        </Label>
      )}
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
          aria-label={compact ? 'Booking link in drafts' : undefined}
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
          aria-label={showPicker ? 'Other scheduling link' : compact ? 'Booking link in drafts' : undefined}
        />
      )}
      {compact ? null : <p className="text-[12px] text-ink-3 mt-1">Added when you propose times.</p>}
    </div>
  );
}
