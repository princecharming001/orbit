/**
 * The Friends tab's side column (plan 37 follow-up): one Invite section (the standing link on a flat strip with Copy,
 * the email box under it, Reset link last and quiet), requests waiting on the student, and their friends, five at a
 * time. Flat sections, no box inside a box.
 */
import type { Friend, FriendInvite } from '@orbit/core';
import { Check, Link2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Avatar, Button, Skeleton, useToast } from '../../ui';
import { friendLine } from './FriendRow';

const TAP = 'pointer-coarse:min-h-11';
const FRIENDS_FOLDED = 5;

function RailSection({
  title,
  aside,
  children,
  testId,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  testId: string;
}) {
  return (
    <section className="py-6 first:pt-0 border-b border-line-2 last:border-0" data-testid={testId}>
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <h2 className="text-[14px] font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function InviteLinkSection({
  link,
  onReset,
  resetting,
  children,
}: {
  link?: string;
  onReset: () => void;
  resetting?: boolean;
  /** the email box, under the link */
  children?: ReactNode;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.push({
        text: 'Link copied. Anyone with it can ask to be your friend until you reset it.',
        tone: 'good',
      });
    } catch {
      toast.push({ text: link, tone: 'neutral', ttl: 10_000 });
    }
  };
  return (
    <RailSection title="Invite friends" testId="friends-invite-link">
      <p className="text-[13px] text-ink-3 mb-3">
        Send your link to a group chat, or invite someone by email.
      </p>
      {link ? (
        <div className="flex items-center h-10 rounded-[8px] bg-canvas-2 pl-3 pr-1">
          <span
            className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-2"
            data-testid="friends-link-text"
          >
            {link.replace(/^https?:\/\//, '')}
          </span>
          <button
            type="button"
            className={`shrink-0 inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[6px] text-[13px] font-medium text-ink hover:bg-line-2 ${TAP}`}
            onClick={() => void copy()}
            data-testid="friends-link-copy"
          >
            {copied ? <Check size={14} aria-hidden /> : <Link2 size={14} aria-hidden />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      ) : (
        <Skeleton className="h-10 rounded-[8px]" />
      )}
      {children && <div className="mt-3">{children}</div>}
      <button
        type="button"
        className="mt-3 text-[12px] text-ink-3 hover:text-ink underline-offset-2 hover:underline disabled:opacity-50"
        onClick={onReset}
        disabled={!link || resetting}
        data-testid="friends-link-reset"
      >
        Reset link
      </button>
    </RailSection>
  );
}

export function RequestsSection({
  pending,
  onAccept,
  onDecline,
  busy,
}: {
  pending: FriendInvite[];
  onAccept: (i: FriendInvite) => void;
  onDecline: (i: FriendInvite) => void;
  busy?: boolean;
}) {
  const incoming = pending.filter((p) => p.direction === 'in' && p.status === 'pending');
  if (!incoming.length) return null;
  return (
    <RailSection
      title={
        <>
          Requests <span className="text-ink-3 font-normal ml-1">{incoming.length}</span>
        </>
      }
      testId="friends-requests"
    >
      <ul className="space-y-3">
        {incoming.map((i) => (
          <li key={i.id} className="flex items-center gap-3" data-testid="friend-request">
            <Avatar name={i.name ?? i.email ?? '?'} id={i.id} size={36} />
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium truncate">{i.name ?? i.email}</div>
              <div className="text-[12px] text-ink-3">Wants to pool networks</div>
            </div>
            <Button
              size="sm"
              variant="primary"
              onClick={() => onAccept(i)}
              disabled={busy}
              data-testid="friend-request-accept"
            >
              Accept
            </Button>
            <button
              type="button"
              className="text-[12.5px] text-ink-3 hover:text-ink"
              onClick={() => onDecline(i)}
              disabled={busy}
              data-testid="friend-request-decline"
            >
              Decline
            </button>
          </li>
        ))}
      </ul>
    </RailSection>
  );
}

export function FriendsListSection({
  friends,
  loading,
  onOpen,
}: {
  friends: Friend[];
  loading: boolean;
  /** open the friend's full row (ask for an intro, what you share, end) */
  onOpen: (f: Friend) => void;
}) {
  const [open, setOpen] = useState(false);
  const shown = open ? friends : friends.slice(0, FRIENDS_FOLDED);
  return (
    <RailSection
      title={
        <>
          Your friends <span className="text-ink-3 font-normal ml-1">{friends.length}</span>
        </>
      }
      testId="friends-list"
      aside={
        friends.length > FRIENDS_FOLDED && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setOpen((v) => !v)}
            data-testid="friends-list-more"
          >
            {open ? 'See fewer' : 'See more'}
          </Button>
        )
      }
    >
      {loading && !friends.length ? (
        <div className="space-y-3">
          <Skeleton className="h-11" />
          <Skeleton className="h-11" />
        </div>
      ) : friends.length ? (
        <ul className="space-y-1">
          {shown.map((f) => (
            <li key={f.friendshipId}>
              <button
                type="button"
                className="w-full flex items-center gap-3 py-1.5 px-1 -mx-1 rounded-[6px] text-left hover:bg-canvas-2"
                onClick={() => onOpen(f)}
                data-testid="friends-list-item"
              >
                <Avatar name={f.name} src={f.avatarUrl ?? undefined} id={f.userId} size={40} />
                <span className="min-w-0">
                  <span className="block text-[14px] font-medium truncate">{f.name}</span>
                  <span className="block text-[12px] text-ink-3 truncate">{friendLine(f)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-ink-3" data-testid="friends-empty">
          None yet. People who accept show up here.
        </p>
      )}
    </RailSection>
  );
}
