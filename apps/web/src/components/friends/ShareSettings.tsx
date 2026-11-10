/**
 * What you share (plan 29 §A1), as settings rows: who friends see (everyone I know, only at these companies, nothing
 * yet) with the count it shares, a company picker for the second, who is hidden (Hide someone opens the search), and
 * one line on what crosses with the preview that renders the projection as a friend's Map would.
 */
import type { Friend, FriendShareMode, Person } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { db } from '../../db/schema';
import { markPrivate, SHARE_MODE_LABELS } from '../../engine/friends';
import { Button, Chip, cx, Input, Select } from '../../ui';

const TAP = 'pointer-coarse:min-h-11';
const MODES = Object.keys(SHARE_MODE_LABELS) as FriendShareMode[];

/**
 * "Ana sees 120 people", "Ana sees nothing yet", "Friends see 12 people at Stripe and Ramp"; with no friends yet,
 * what a friend would see once there is one. `total` is unknown while it is being counted.
 */
export function previewLine(
  friends: Friend[],
  mode: FriendShareMode,
  domains: string[],
  total: number | undefined,
): string {
  const people = total === undefined ? 'your people' : `${total} ${total === 1 ? 'person' : 'people'}`;
  const where =
    mode === 'companies' && domains.length
      ? ` at ${domains.map((d) => d.replace(/\.[a-z]+$/, '')).join(', ')}`
      : '';
  if (!friends.length) {
    if (mode === 'none') return 'Friends you add see nothing until you choose';
    if (total === 0) return 'Nothing to share yet: your people are still arriving';
    return `A friend you add will see ${people}${where}`;
  }
  const who = friends.length === 1 ? friends[0]!.name.split(' ')[0]! : 'Friends';
  const verb = friends.length === 1 ? 'sees' : 'see';
  if (mode === 'none') return `${who} ${verb} nothing yet`;
  return `${who} ${verb} ${people}${where}`;
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
  /** how many people the projection holds under the mode (unknown while counted) */
  total: number | undefined;
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
  const [hiding, setHiding] = useState(false);
  const firstFriend = friends.length === 1 ? friends[0]!.name.split(' ')[0] : undefined;
  return (
    <div className="border-y border-line-2 divide-y divide-line-2">
      <div className="py-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="text-[14px] font-medium">Who friends see</div>
          <p className="text-[13px] text-ink-3 mt-0.5" data-testid="friend-share-preview">
            {previewLine(friends, mode, domains, total)}
          </p>
        </div>
        <Select
          value={mode}
          onChange={(e) => onMode(e.target.value as FriendShareMode, parseDomains(domainText))}
          aria-label="What you share with friends"
          data-testid="friend-share-mode"
          disabled={busy}
          className="h-9 w-52"
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {SHARE_MODE_LABELS[m]}
            </option>
          ))}
        </Select>
      </div>
      {mode === 'companies' && (
        <form
          className="py-4 flex flex-wrap items-center gap-2"
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
            className="max-w-sm h-9"
            data-testid="friend-share-domains"
          />
          <Button type="submit" size="sm" variant="secondary" className={TAP} loading={busy}>
            Save companies
          </Button>
        </form>
      )}
      <div className="py-4">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <div className="text-[14px] font-medium">Hidden from friends</div>
            <p className="text-[13px] text-ink-3 mt-0.5">
              {hidden.length
                ? `${hidden.length} ${hidden.length === 1 ? 'person' : 'people'} never shown`
                : 'Anyone you hide never shows, nor anyone who asked not to be contacted'}
            </p>
          </div>
          {!hiding && (
            <Button
              size="sm"
              variant="secondary"
              className={TAP}
              onClick={() => setHiding(true)}
              data-testid="friend-hide-open"
            >
              Hide someone
            </Button>
          )}
        </div>
        {hiding && (
          <div className="mt-3 max-w-sm">
            <Input
              autoFocus
              value={hideQuery}
              onChange={(e) => setHideQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setHideQuery('');
                  setHiding(false);
                }
              }}
              placeholder="Search your people"
              aria-label="Hide a person from friends"
              className="h-9"
              data-testid="friend-hide-search"
            />
            {hits.length > 0 && (
              <ul className="mt-1 text-[13px]" data-testid="friend-hide-hits">
                {hits.map((p) => (
                  <li key={p.id} className="py-1 flex items-center gap-2">
                    <span className="truncate font-medium">{p.displayName}</span>
                    <span className="text-ink-3 text-[12.5px] truncate">{p.currentOrganizationRaw}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className={cx('ml-auto', TAP)}
                      onClick={() => {
                        void markPrivate(p.id, true);
                        setHideQuery('');
                        setHiding(false);
                      }}
                      data-testid="friend-hide-person"
                    >
                      Hide
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {hidden.length > 0 && (
          <div
            className="mt-3 flex flex-wrap items-center gap-1.5 text-[12.5px]"
            data-testid="friend-hidden-people"
          >
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
      </div>
      <div className="py-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <p className="text-[13px] text-ink-3 max-w-[56ch]">
          Friends see names, titles, companies, schools and how well you know someone. Never your emails,
          notes or drafts.
        </p>
        <Button
          size="sm"
          variant="ghost"
          className={cx('-mr-2', TAP)}
          onClick={onPreview}
          data-testid="friend-share-preview-open"
        >
          {firstFriend ? `Preview what ${firstFriend} sees` : 'Preview what friends see'}
        </Button>
      </div>
    </div>
  );
}
