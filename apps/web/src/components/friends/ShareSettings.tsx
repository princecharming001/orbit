/**
 * What you share (plan 29 §A1): three choices for all friends (everyone I know, only at these companies, nothing yet),
 * a company picker for the second, "Hide a person from friends", and the preview button that renders the projection
 * as a friend's Map would.
 */
import type { Friend, FriendShareMode, Person } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { db } from '../../db/schema';
import { markPrivate, SHARE_MODE_LABELS } from '../../engine/friends';
import { Button, Chip, cx, Input, Select } from '../../ui';

const TAP = 'pointer-coarse:min-h-11';
const MODES = Object.keys(SHARE_MODE_LABELS) as FriendShareMode[];

/** "Ana sees 120 people", "Ana sees nothing yet", "Friends see 12 people at Stripe and Ramp". */
export function previewLine(
  friends: Friend[],
  mode: FriendShareMode,
  domains: string[],
  total: number,
): string {
  const who = friends.length === 1 ? friends[0]!.name.split(' ')[0]! : 'Friends';
  const verb = friends.length === 1 ? 'sees' : 'see';
  if (mode === 'none') return `${who} ${verb} nothing yet`;
  const people = `${total} ${total === 1 ? 'person' : 'people'}`;
  if (mode === 'companies')
    return `${who} ${verb} ${people}${domains.length ? ` at ${domains.map((d) => d.replace(/\.[a-z]+$/, '')).join(', ')}` : ''}`;
  return `${who} ${verb} ${people}`;
}

export function ShareSettings({
  userId,
  friends,
  mode,
  domains,
  total,
  onMode,
  onPreview,
  busy,
}: {
  userId: string;
  friends: Friend[];
  mode: FriendShareMode;
  domains: string[];
  /** how many people the projection holds under the mode */
  total: number;
  onMode: (mode: FriendShareMode, domains: string[]) => void;
  onPreview: () => void;
  busy?: boolean;
}) {
  const [domainText, setDomainText] = useState(domains.join(', '));
  const [hideQuery, setHideQuery] = useState('');
  const people = useLiveQuery(
    () =>
      db.people
        .where('userId')
        .equals(userId)
        .filter((p) => !p.hiddenAt && p.isHuman !== false)
        .toArray(),
    [userId],
    [] as Person[],
  );
  const hidden = useMemo(() => people.filter((p) => p.private), [people]);
  const hits = useMemo(() => {
    const q = hideQuery.trim().toLowerCase();
    if (!q) return [];
    return people.filter((p) => !p.private && p.displayName.toLowerCase().includes(q)).slice(0, 5);
  }, [people, hideQuery]);
  const parseDomains = (s: string) => [
    ...new Set(
      s
        .split(/[,\s]+/)
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={mode}
          onChange={(e) => onMode(e.target.value as FriendShareMode, parseDomains(domainText))}
          aria-label="What you share with friends"
          data-testid="friend-share-mode"
          disabled={busy}
          className="h-9"
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {SHARE_MODE_LABELS[m]}
            </option>
          ))}
        </Select>
        <span className="text-[13px] text-ink-3" data-testid="friend-share-preview">
          {previewLine(friends, mode, domains, total)}
        </span>
        <Button
          size="sm"
          variant="secondary"
          className={cx('ml-auto', TAP)}
          onClick={onPreview}
          data-testid="friend-share-preview-open"
        >
          {friends.length === 1
            ? `See exactly what ${friends[0]!.name.split(' ')[0]} sees`
            : 'See exactly what friends see'}
        </Button>
      </div>
      {mode === 'companies' && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onMode('companies', parseDomains(domainText));
          }}
        >
          <Input
            value={domainText}
            onChange={(e) => setDomainText(e.target.value)}
            placeholder="stripe.com, ramp.com"
            aria-label="Company domains to share"
            className="max-w-sm"
            data-testid="friend-share-domains"
          />
          <Button type="submit" size="sm" variant="secondary" className={TAP} loading={busy}>
            Save companies
          </Button>
        </form>
      )}
      <div className="space-y-1.5">
        <div className="text-[13px] font-medium">Hide a person from friends</div>
        <Input
          value={hideQuery}
          onChange={(e) => setHideQuery(e.target.value)}
          placeholder="Search your people"
          aria-label="Hide a person from friends"
          className="max-w-sm"
          data-testid="friend-hide-search"
        />
        {hits.length > 0 && (
          <ul className="text-[13px] divide-y divide-line-2" data-testid="friend-hide-hits">
            {hits.map((p) => (
              <li key={p.id} className="py-1.5 flex items-center gap-2">
                <span className="truncate">{p.displayName}</span>
                <span className="text-ink-3 text-[12.5px] truncate">{p.currentOrganizationRaw}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className={cx('ml-auto', TAP)}
                  onClick={() => {
                    void markPrivate(p.id, true);
                    setHideQuery('');
                  }}
                  data-testid="friend-hide-person"
                >
                  Hide
                </Button>
              </li>
            ))}
          </ul>
        )}
        {hidden.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-1.5 text-[12.5px]"
            data-testid="friend-hidden-people"
          >
            <span className="text-ink-3">Hidden:</span>
            {hidden.map((p) => (
              <Chip key={p.id}>
                {p.displayName}
                <button
                  type="button"
                  className="ml-1 text-ink-3 hover:text-ink"
                  onClick={() => void markPrivate(p.id, false)}
                  aria-label={`Show ${p.displayName} to friends again`}
                >
                  ×
                </button>
              </Chip>
            ))}
          </div>
        )}
        <p className="text-[12px] text-ink-3">
          Hidden people, anyone you hid from your own view and anyone who asked not to be contacted never
          show.
        </p>
      </div>
    </div>
  );
}
