/**
 * The Friends tab's side column: the invite link (Copy in the field, Reset link beside the heading, asked about before
 * it runs since it breaks links already shared) with the invite by email under it, requests waiting on the student,
 * requests they sent, and their friends five at a time. Each person is a square photo, their name and one grey line
 * that says only what the server knows. Flat sections on white space: no cards, no rules between them.
 */
import type { Friend, FriendInvite } from '@orbit/core';
import { Check, Link2, Mail } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Avatar, Button, cx, Skeleton, useToast } from '../../ui';
import { NameLink } from './Discover';
import { friendStatus } from './FriendRow';

const TAP = 'pointer-coarse:min-h-11';
/** How many people a list shows before "See more". */
export const RAIL_FOLDED = 5;
const PHOTO = 56;

function RailSection({
  title,
  count,
  aside,
  children,
  testId,
}: {
  title: string;
  /** the grey number beside the heading */
  count?: number;
  aside?: ReactNode;
  children: ReactNode;
  testId: string;
}) {
  return (
    <section data-testid={testId}>
      <div className="flex items-center justify-between gap-3 min-h-8">
        <h2 className="text-[16px] font-semibold">
          {title}
          {count !== undefined && (
            <span className="ml-2 font-normal text-ink-3" data-testid={`${testId}-count`}>
              {count}
            </span>
          )}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** One person in the column: a square photo (initials on a colour without one), the name, a grey line. */
function PersonRow({
  name,
  photo,
  seed,
  to,
  href,
  line,
  testId,
  onPhoto,
  photoLabel,
  children,
  tone,
  address,
}: {
  name: string;
  photo?: string | null;
  seed: string;
  /** their page in Orbit, which the name opens */
  to?: string;
  /** their LinkedIn, opened in a new tab when there is no page in Orbit */
  href?: string;
  line: string;
  testId: string;
  /** what a tap on the photo does, when it does anything */
  onPhoto?: () => void;
  photoLabel?: string;
  /** actions under the line (Accept, Decline) */
  children?: ReactNode;
  /** a dot before the line: waiting on the student (amber), on its way (green), nothing to do (grey) */
  tone?: 'wait' | 'ok' | 'idle';
  /** someone known only by an address: a quiet mail tile, and the address with its domain set back */
  address?: boolean;
}) {
  const picture = address ? (
    <span
      data-shape="square"
      className="flex shrink-0 items-center justify-center rounded-[12px] border border-line-2 bg-canvas-2 text-ink-3"
      style={{ width: PHOTO, height: PHOTO }}
      aria-hidden
    >
      <Mail className="h-5 w-5" strokeWidth={1.5} />
    </span>
  ) : (
    <Avatar name={name} src={photo ?? undefined} id={seed} size={PHOTO} shape="square" />
  );
  const at = address ? name.indexOf('@') : -1;
  return (
    <li className="flex items-center gap-3.5 min-w-0" data-testid={testId}>
      {onPhoto ? (
        <button
          type="button"
          className="shrink-0 rounded-[12px] transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25 focus-visible:ring-offset-2"
          onClick={onPhoto}
          aria-label={photoLabel}
          data-testid={`${testId}-photo`}
        >
          {picture}
        </button>
      ) : (
        picture
      )}
      <div className="min-w-0 flex-1">
        <NameLink
          to={to}
          href={href}
          className={cx(
            'block text-[15px] font-medium leading-snug truncate',
            (to || href) && 'hover:underline underline-offset-2',
          )}
          testId={`${testId}-name`}
        >
          {at > 0 ? (
            <>
              {name.slice(0, at)}
              <span className="font-normal text-ink-3">{name.slice(at)}</span>
            </>
          ) : (
            name
          )}
        </NameLink>
        <div
          className="mt-1 flex min-w-0 items-center gap-1.5 text-[13px] leading-snug text-ink-3"
          data-testid={`${testId}-line`}
        >
          {tone && (
            <span
              aria-hidden
              className={cx(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                tone === 'wait' ? 'bg-[#d9a441]' : tone === 'ok' ? 'bg-[#5fa777]' : 'bg-[#c9c5be]',
              )}
            />
          )}
          <span className="truncate">{line}</span>
        </div>
        {children}
      </div>
    </li>
  );
}

/** "See more" beside a heading: only there while the list holds more than it shows, then "See fewer". */
function MoreButton({
  total,
  open,
  onToggle,
  testId,
}: {
  total: number;
  open: boolean;
  onToggle: () => void;
  testId: string;
}) {
  if (total <= RAIL_FOLDED) return null;
  return (
    <Button
      size="sm"
      variant="secondary"
      className={TAP}
      onClick={onToggle}
      aria-expanded={open}
      data-testid={open ? `${testId}-fewer` : `${testId}-more`}
    >
      {open ? 'See fewer' : 'See more'}
    </Button>
  );
}

export function InviteLinkSection({
  link,
  onReset,
  children,
}: {
  link?: string;
  /** end the old link and make a new one; the section has already asked, and waits for this to finish */
  onReset: () => Promise<void> | void;
  /** the invite by email, under the link */
  children?: ReactNode;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState(false);
  const [resetting, setResetting] = useState(false);
  const resetRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);
  // the keyboard follows the question: to Cancel when it opens, back to Reset link when it closes
  useEffect(() => {
    if (asking) cancelRef.current?.focus();
    else if (wasAsking.current) resetRef.current?.focus();
    wasAsking.current = asking;
  }, [asking]);
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
  const reset = async () => {
    setResetting(true);
    try {
      await onReset();
    } catch {
      // the caller says why when it can; a throw past it still gets an answer, and the old link stands
      toast.push({ text: 'The link was not reset. Try again.', tone: 'bad' });
    } finally {
      setResetting(false);
      setAsking(false);
    }
  };
  return (
    <RailSection
      title="Invite link"
      testId="friends-invite-link"
      aside={
        !asking && (
          <button
            type="button"
            ref={resetRef}
            className={cx(
              'text-[13px] text-ink-3 hover:text-ink underline-offset-2 hover:underline disabled:opacity-50 disabled:no-underline',
              TAP,
            )}
            onClick={() => setAsking(true)}
            disabled={!link}
            data-testid="friends-invite-reset"
          >
            Reset link
          </button>
        )
      }
    >
      {asking ? (
        <div
          className="mt-1 mb-3 flex flex-wrap items-center gap-x-3 gap-y-2"
          role="group"
          aria-label="Reset the invite link"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !resetting) setAsking(false);
          }}
          data-testid="friends-invite-reset-ask"
        >
          <p className="text-[13.5px] text-ink-2">Reset? The old link stops working.</p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="danger"
              className={TAP}
              onClick={() => void reset()}
              loading={resetting}
              data-testid="friends-invite-reset-confirm"
            >
              Reset
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className={TAP}
              ref={cancelRef}
              onClick={() => setAsking(false)}
              disabled={resetting}
              data-testid="friends-invite-reset-cancel"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-1 mb-3 text-[13.5px] text-ink-3">Share it in a group chat to add friends.</p>
      )}
      {link ? (
        <div className="flex items-center gap-2 h-11 rounded-[10px] border border-line bg-canvas pl-3.5 pr-1.5">
          <span
            className="min-w-0 flex-1 truncate text-[13.5px] text-ink-2"
            title={link}
            data-testid="friends-link-text"
          >
            {link.replace(/^https?:\/\//, '')}
          </span>
          <Button
            size="sm"
            variant="subtle"
            className={cx('shrink-0 px-2.5', TAP)}
            onClick={() => void copy()}
            data-testid="friends-invite-copy"
          >
            {copied ? <Check size={14} aria-hidden /> : <Link2 size={14} aria-hidden />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      ) : (
        <Skeleton className="h-11 rounded-[10px]" />
      )}
      {children && <div className="mt-3">{children}</div>}
    </RailSection>
  );
}

/** Requests waiting on the student: Accept or Decline, in place. */
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
    <RailSection title="Requests" count={incoming.length} testId="friends-requests">
      <ul className="mt-3 space-y-4">
        {incoming.map((i) => (
          <PersonRow
            key={i.id}
            name={i.name ?? i.email ?? 'Someone'}
            photo={i.avatarUrl}
            seed={i.id}
            to={i.personId ? `/people/${i.personId}` : undefined}
            href={i.linkedinUrl}
            line="Wants to pool networks"
            testId="friend-request"
          >
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                className={TAP}
                onClick={() => onAccept(i)}
                disabled={busy}
                data-testid="friend-request-accept"
              >
                Accept
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className={TAP}
                onClick={() => onDecline(i)}
                disabled={busy}
                data-testid="friend-request-decline"
              >
                Decline
              </Button>
            </div>
          </PersonRow>
        ))}
      </ul>
    </RailSection>
  );
}

/** What waits on the other side: a request to someone on Orbit, or an invite by email to someone who is not. */
export function requestedLine(i: FriendInvite): string {
  if (i.name) return 'Request sent';
  // an invite nobody was emailed is not "invited" yet: the student still has to pass the link on
  if (i.emailed === false) return 'Not emailed yet, share your link';
  return i.emailed ? 'Emailed, not on Orbit yet' : 'Invited, not on Orbit yet';
}

/** The dot beside that line: amber while it waits on the student, green once the invite went out. */
export function requestedTone(i: FriendInvite): 'wait' | 'ok' | 'idle' {
  if (i.name) return 'idle';
  if (i.emailed === false) return 'wait';
  return i.emailed ? 'ok' : 'idle';
}

/** Requests the student sent that nobody has answered yet. */
export function RequestedSection({ pending }: { pending: FriendInvite[] }) {
  const [open, setOpen] = useState(false);
  const sent = pending.filter((p) => p.direction === 'out' && p.status === 'pending');
  if (!sent.length) return null;
  const shown = open ? sent : sent.slice(0, RAIL_FOLDED);
  return (
    <RailSection
      title="Requested"
      count={sent.length}
      testId="friends-requested"
      aside={
        <MoreButton
          total={sent.length}
          open={open}
          onToggle={() => setOpen((v) => !v)}
          testId="friends-requested"
        />
      }
    >
      <ul className="mt-3 space-y-4">
        {shown.map((i) => (
          <PersonRow
            key={i.id}
            name={i.name ?? i.email ?? 'Someone'}
            photo={i.avatarUrl}
            seed={i.id}
            to={i.personId ? `/people/${i.personId}` : undefined}
            href={i.linkedinUrl}
            line={requestedLine(i)}
            tone={requestedTone(i)}
            address={!i.name && !i.avatarUrl && !!i.email}
            testId="friends-requested-row"
          />
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
  /** show the friend's full row (ask for an intro, what you share, end), which their photo jumps to */
  onOpen: (f: Friend) => void;
}) {
  const [open, setOpen] = useState(false);
  const shown = open ? friends : friends.slice(0, RAIL_FOLDED);
  const waiting = loading && !friends.length;
  return (
    <RailSection
      title="Your friends"
      count={waiting ? undefined : friends.length}
      testId="friends-yours"
      aside={
        <MoreButton
          total={friends.length}
          open={open}
          onToggle={() => setOpen((v) => !v)}
          testId="friends-yours"
        />
      }
    >
      {waiting ? (
        <div className="mt-3 space-y-4" aria-busy>
          {[0, 1].map((n) => (
            <div key={n} className="flex items-center gap-3.5">
              <Skeleton className="h-14 w-14 rounded-[12px] shrink-0" />
              <div className="flex-1">
                <Skeleton className="h-3.5 w-2/5" />
                <Skeleton className="h-3 w-3/5 mt-2" />
              </div>
            </div>
          ))}
        </div>
      ) : friends.length ? (
        <ul className="mt-3 space-y-4">
          {shown.map((f) => (
            <PersonRow
              key={f.friendshipId}
              name={f.name}
              photo={f.avatarUrl}
              seed={f.userId}
              to={f.personId ? `/people/${f.personId}` : undefined}
              href={f.linkedinUrl}
              line={friendStatus(f)}
              testId="friends-yours-row"
              onPhoto={() => onOpen(f)}
              photoLabel={`Show ${f.name} in your friends below`}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[13.5px] text-ink-3" data-testid="friends-empty">
          None yet. People who accept show up here.
        </p>
      )}
    </RailSection>
  );
}
