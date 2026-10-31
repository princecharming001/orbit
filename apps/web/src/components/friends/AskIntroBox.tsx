/**
 * Ask a friend for an intro (plan 29 §A1, §A4): pick one of the people the friend shares (by name, a company helps),
 * write the two or three line note the friend can forward as it is (who you are, why this person, the ask, an out),
 * and file the ask. It goes to the friend, never to the person; nothing is sent until the friend forwards.
 */
import type { Friend, FriendShare, User } from '@orbit/core';
import { useEffect, useMemo, useState } from 'react';
import { CLOSENESS_WORDS, friendShares } from '../../engine/friends';
import { Button, Input, Textarea } from '../../ui';

const TAP = 'pointer-coarse:min-h-11';
export const ASK_NOTE_MAX = 600;

export function AskIntroBox({
  user,
  friend,
  initialTarget,
  onSend,
  onClose,
  busy,
}: {
  user: User;
  friend: Friend;
  /** a shared person already chosen (from the Map or a company page) */
  initialTarget?: string;
  onSend: (target: FriendShare, note: string) => Promise<boolean>;
  onClose: () => void;
  busy?: boolean;
}) {
  const [shares, setShares] = useState<FriendShare[]>();
  const [query, setQuery] = useState('');
  const [note, setNote] = useState('');
  const [pickedId, setPickedId] = useState<string | undefined>(initialTarget);
  useEffect(() => {
    let live = true;
    void friendShares(user, friend.userId).then((r) => {
      if (!live) return;
      setShares(r.ok ? r.value.shares : []);
    });
    return () => {
      live = false;
    };
  }, [user.id, friend.userId]);
  const matches = useMemo(() => {
    if (!shares) return [];
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return shares
      .filter((s) => s.displayName.toLowerCase().includes(q) || s.company?.toLowerCase().includes(q))
      .slice(0, 6);
  }, [shares, query]);
  const picked =
    shares?.find((s) => s.personId === pickedId) ?? (matches.length === 1 ? matches[0] : undefined);
  const first = friend.name.split(' ')[0];
  const words = note.trim() ? note.trim().split(/\s+/).length : 0;
  return (
    <div
      className="mt-3 border border-line rounded-[var(--radius-card)] p-3 space-y-2.5"
      data-testid="friend-ask-box"
    >
      <div className="text-[13.5px] font-medium">Ask {first} for an intro</div>
      <Input
        value={picked && !query ? picked.displayName : query}
        onChange={(e) => {
          setQuery(e.target.value);
          setPickedId(undefined);
        }}
        placeholder={`Who, among the people ${first} shares`}
        aria-label="Who to be introduced to"
        data-testid="friend-ask-target"
      />
      {!picked && matches.length > 1 && (
        <ul className="text-[13px] divide-y divide-line-2" data-testid="friend-ask-matches">
          {matches.map((s) => (
            <li key={s.personId}>
              <button
                type="button"
                className={`w-full text-left py-1.5 hover:underline ${TAP}`}
                onClick={() => {
                  setPickedId(s.personId);
                  setQuery('');
                }}
              >
                {s.displayName}
                <span className="text-ink-3">
                  {s.title ? ` · ${s.title}` : ''}
                  {s.company ? ` · ${s.company}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {shares && query && !matches.length && !picked && (
        <p className="text-[12.5px] text-ink-3">{first} does not share anyone by that name.</p>
      )}
      {picked && (
        <p className="text-[12.5px] text-ink-3" data-testid="friend-ask-picked">
          {picked.displayName}
          {picked.title ? `, ${picked.title}` : ''}
          {picked.company ? ` at ${picked.company}` : ''}: {first} {CLOSENESS_WORDS[picked.closeness]}
          {picked.closeness === 3 ? ' to them' : ' them'}.
        </p>
      )}
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value.slice(0, ASK_NOTE_MAX))}
        rows={4}
        placeholder={`The note ${first} can forward as it is: who you are, why ${picked?.displayName.split(' ')[0] ?? 'this person'}, the ask, an out.`}
        aria-label="The note your friend forwards"
        data-testid="friend-ask-note"
      />
      <div className="flex items-center gap-2 text-[12px] text-ink-3">
        <span>
          {words} words. It goes to {first}, who forwards it; nothing is sent to{' '}
          {picked?.displayName.split(' ')[0] ?? 'them'} by Orbit.
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" className={TAP} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            className={TAP}
            disabled={!picked || !note.trim()}
            loading={busy}
            onClick={() => picked && void onSend(picked, note.trim()).then((ok) => ok && onClose())}
            data-testid="friend-ask-send"
          >
            Ask {first}
          </Button>
        </span>
      </div>
    </div>
  );
}
