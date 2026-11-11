/**
 * One friend on the Friends tab (plan 29 §A1): avatar, name, school and year, what they share ("shares 312 people ·
 * 14 at your targets · knows 3 at Stripe"), the switch for what the student shares back, Ask for an intro, and End.
 */
import type { Friend, FriendShareMode } from '@orbit/core';
import { useState } from 'react';
import { SHARE_MODE_LABELS } from '../../engine/friends';
import { Avatar, Button, Chip, cx, Select } from '../../ui';
import { NameLink } from './Discover';

const TAP = 'pointer-coarse:min-h-11';

export function friendLine(f: Friend): string {
  const parts = [`shares ${f.shares} ${f.shares === 1 ? 'person' : 'people'}`];
  if (f.atTargets) parts.push(`${f.atTargets} at your targets`);
  const top = [...f.knowsAt].sort((a, b) => b.count - a.count)[0];
  if (top) parts.push(`knows ${top.count} at ${top.company}`);
  return parts.join(' · ');
}

export function FriendRow({
  friend,
  onAsk,
  onShareMode,
  onEnd,
  busy,
}: {
  friend: Friend;
  onAsk: (f: Friend) => void;
  onShareMode: (f: Friend, mode: FriendShareMode) => void;
  onEnd: (f: Friend) => void;
  busy?: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const who = [friend.school, friend.gradYear].filter(Boolean).join(' ');
  return (
    <li className="py-4" data-testid="friend-row" data-friend-id={friend.userId}>
      <div className="flex items-center gap-3">
        <Avatar name={friend.name} src={friend.avatarUrl ?? undefined} id={friend.userId} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <NameLink
              to={friend.personId ? `/people/${friend.personId}` : undefined}
              href={friend.linkedinUrl}
              className="text-[14.5px] font-medium truncate hover:underline underline-offset-2"
              testId="friend-row-name"
            >
              {friend.name}
            </NameLink>
            {who && <span className="text-[12.5px] text-ink-3 truncate">{who}</span>}
            {friend.shares === 0 && friend.myMode !== 'none' && <Chip>Shares nothing yet</Chip>}
          </div>
          <div className="text-[13px] text-ink-3 mt-0.5 truncate" data-testid="friend-line">
            {friendLine(friend)}
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className={cx('shrink-0', TAP)}
          onClick={() => onAsk(friend)}
          disabled={friend.shares === 0}
          data-testid="friend-ask-intro"
        >
          Ask for an intro
        </Button>
      </div>
      <div className="mt-2.5 pl-[52px] flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px]">
        <label className="flex items-center gap-2 text-ink-3">
          <span>You share</span>
          <Select
            value={friend.myMode}
            onChange={(e) => onShareMode(friend, e.target.value as FriendShareMode)}
            className="h-8 w-auto text-[12.5px]"
            aria-label={`What you share with ${friend.name}`}
            data-testid="friend-row-share-mode"
            disabled={busy}
          >
            {(Object.keys(SHARE_MODE_LABELS) as FriendShareMode[]).map((m) => (
              <option key={m} value={m}>
                {SHARE_MODE_LABELS[m]}
              </option>
            ))}
          </Select>
        </label>
        {confirm ? (
          <span className="flex items-center gap-2">
            <span className="text-ink-3">Ends it both ways, at once.</span>
            <Button
              size="sm"
              variant="danger"
              className={TAP}
              onClick={() => {
                setConfirm(false);
                onEnd(friend);
              }}
              data-testid="friend-end-confirm"
            >
              End friendship
            </Button>
            <Button size="sm" variant="ghost" className={TAP} onClick={() => setConfirm(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <button
            type="button"
            className={cx('ml-auto text-ink-3 hover:text-bad', TAP)}
            onClick={() => setConfirm(true)}
            data-testid="friend-end"
          >
            End friendship
          </button>
        )}
      </div>
    </li>
  );
}
