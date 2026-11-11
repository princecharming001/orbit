/**
 * Finding friends on the Friends tab (plan 37 follow-up): people on Orbit the student may know, a search for someone
 * they are looking for, and the student's LinkedIn connections worth inviting. Each is a card: their photo, the name,
 * why they are here in a few words, and one button that acts in place (Add turns to Requested, Invite to Invited). A
 * card without a photo shows a plain silhouette, never letters made up from the name.
 */
import type { FriendSuggestion, InviteSuggestion } from '@orbit/core';
import { Check, Linkedin, Mail, Search, UserPlus, UserRound } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, cx, Input, Skeleton } from '../../ui';

const TAP = 'pointer-coarse:min-h-11';
/** Two rows of five before "See more". */
export const TILES_FOLDED = 10;

/** "7.6K connections", "312 connections"; nothing under ten (a new account says nothing about its network yet). */
export function connectionsLabel(n: number): string | undefined {
  if (n < 10) return undefined;
  if (n < 1000) return `${n} connections`;
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}K connections`;
}

function Photo({ src }: { src?: string | null }) {
  const [broken, setBroken] = useState(false);
  return src && !broken ? (
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className="w-full aspect-square object-cover rounded-[8px] bg-canvas-2"
    />
  ) : (
    <div
      className="w-full aspect-square rounded-[8px] flex items-end justify-center overflow-hidden bg-[linear-gradient(180deg,#f3f2ef,#ebe9e5)] text-[#d6d2cb]"
      aria-hidden
      data-testid="tile-no-photo"
    >
      <UserRound className="w-1/2 h-1/2 translate-y-[10%]" strokeWidth={1} />
    </div>
  );
}

export function PersonTile({
  name,
  photo,
  seed,
  lines,
  action,
  testId,
  to,
  href,
}: {
  name: string;
  photo?: string | null;
  seed: string;
  /** their page in Orbit, which the photo and name open */
  to?: string;
  /** their LinkedIn, opened in a new tab when there is no page in Orbit */
  href?: string;
  lines: (string | undefined | null)[];
  action: ReactNode;
  testId: string;
}) {
  const shown = lines.filter((l): l is string => !!l).slice(0, 2);
  void seed;
  return (
    <li
      className="min-w-0 flex flex-col rounded-[12px] border border-line-2 bg-canvas p-2 transition-[border-color,box-shadow] hover:border-line hover:shadow-[0_2px_12px_rgba(0,0,0,0.04)]"
      data-testid={testId}
    >
      <NameLink to={to} href={href} label={`Open ${name}`} className="block rounded-[8px]">
        <Photo src={photo} />
      </NameLink>
      <NameLink
        to={to}
        href={href}
        className="mt-2.5 font-medium text-[14px] leading-snug truncate hover:underline underline-offset-2"
        testId="tile-name"
      >
        {name}
      </NameLink>
      {shown.map((l, i) => (
        <div
          key={l}
          className={cx('text-[12.5px] leading-snug truncate', i === 0 ? 'text-ink-2' : 'text-ink-3')}
        >
          {l}
        </div>
      ))}
      <div className="mt-auto pt-2.5">{action}</div>
    </li>
  );
}

/** A name or a photo that opens the person: their page in Orbit, else their LinkedIn, else plain text. */
export function NameLink({
  to,
  href,
  className,
  label,
  testId,
  children,
}: {
  to?: string;
  href?: string;
  className?: string;
  label?: string;
  testId?: string;
  children: ReactNode;
}) {
  if (to)
    return (
      <Link to={to} className={className} aria-label={label} data-testid={testId}>
        {children}
      </Link>
    );
  if (href)
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={className}
        aria-label={label}
        data-testid={testId}
      >
        {children}
      </a>
    );
  return (
    <div className={className} data-testid={testId}>
      {children}
    </div>
  );
}

/** The button under a tile: the action, then its done state in place. */
export function TileButton({
  label,
  done,
  icon,
  onClick,
  busy,
  testId,
  title,
}: {
  label: string;
  done?: string;
  icon: 'add' | 'invite' | 'linkedin' | 'accept';
  onClick: () => void;
  busy?: boolean;
  testId: string;
  title?: string;
}) {
  if (done)
    return (
      <span
        className="w-full inline-flex items-center justify-center gap-1.5 h-9 rounded-[6px] border border-line-2 bg-canvas-2 text-[13px] font-medium text-ink-3"
        data-testid={testId}
        data-state="done"
      >
        <Check size={14} aria-hidden /> {done}
      </span>
    );
  const Icon =
    icon === 'invite' ? Mail : icon === 'linkedin' ? Linkedin : icon === 'accept' ? Check : UserPlus;
  return (
    <Button
      variant={icon === 'accept' ? 'primary' : 'secondary'}
      className={cx('w-full h-9', TAP)}
      onClick={onClick}
      loading={busy}
      title={title}
      data-testid={testId}
      data-state="ready"
    >
      {!busy && <Icon size={14} aria-hidden />} {label}
    </Button>
  );
}

/** A titled grid of tiles with See more, folded to two rows. */
export function TileSection({
  title,
  count,
  testId,
  children,
  empty,
  loading,
}: {
  title: string;
  count: number;
  testId: string;
  children: (limit: number) => ReactNode;
  empty?: ReactNode;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const fold = count > TILES_FOLDED;
  return (
    <section data-testid={testId}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-[16px] font-semibold">
          {title}
          {count > 0 && <span className="ml-2 font-normal text-ink-3">{count}</span>}
        </h2>
        {fold && (
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} data-testid={`${testId}-more`}>
            {open ? 'See fewer' : 'See more'}
          </Button>
        )}
      </div>
      {loading ? (
        <ul className={GRID} aria-busy>
          {Array.from({ length: 5 }, (_, i) => (
            <li key={i} className="rounded-[12px] border border-line p-2.5">
              <Skeleton className="w-full aspect-square rounded-[8px]" />
              <Skeleton className="h-3 mt-2 w-3/4" />
              <Skeleton className="h-3 mt-1.5 w-1/2" />
            </li>
          ))}
        </ul>
      ) : count ? (
        <ul className={GRID}>{children(open || !fold ? count : TILES_FOLDED)}</ul>
      ) : (
        empty
      )}
    </section>
  );
}

/**
 * An empty grid, shown as the grid it will become: faded cards that breathe one after another, with a quiet line on
 * the first. No paragraph of advice.
 */
export function GhostTiles({ label, testId }: { label: string; testId?: string }) {
  // one row at every width: as many ghosts as the grid has columns, fading off to the right
  const shown = ['', '', 'hidden @2xl:flex', 'hidden @4xl:flex', 'hidden @6xl:flex'];
  return (
    <div className="relative [mask-image:linear-gradient(90deg,#000_55%,transparent)]" data-testid={testId}>
      <ul className={GRID} aria-hidden>
        {shown.map((when, i) => (
          <li
            key={i}
            className={cx(
              'ghost-tile min-w-0 flex flex-col rounded-[12px] border border-dashed border-line p-2',
              when,
            )}
            style={{ animationDelay: `${i * 220}ms` }}
          >
            <div className="w-full aspect-square rounded-[8px] bg-[linear-gradient(180deg,#f4f3f0,#eeece8)] flex items-end justify-center overflow-hidden">
              <UserRound className="w-1/2 h-1/2 translate-y-[10%] text-[#e2ded8]" strokeWidth={1} />
            </div>
            <div className="mt-2.5 h-2.5 w-2/3 rounded-full bg-[#efedea]" />
            <div className="mt-1.5 h-2 w-1/2 rounded-full bg-[#f3f2ef]" />
            <div className="mt-3 h-8 rounded-[6px] border border-dashed border-line-2" />
          </li>
        ))}
      </ul>
      <p className="sr-only">{label}</p>
      <span className="pointer-events-none absolute left-[28%] top-[38%] -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-canvas/90 px-3 py-1 text-[12.5px] text-ink-3 shadow-[0_1px_6px_rgba(0,0,0,0.05)]">
        {label}
      </span>
    </div>
  );
}

export const GRID = 'grid grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-4 @6xl:grid-cols-5 gap-3';

/** The state a tile's button shows: what the server said, or what the student just did here. */
export type TileState = 'none' | 'busy' | 'requested' | 'friends' | 'invited';

export function SuggestionTile({
  s,
  state,
  onAdd,
  onAccept,
}: {
  s: FriendSuggestion;
  state: TileState;
  onAdd: (s: FriendSuggestion) => void;
  onAccept: (s: FriendSuggestion) => void;
}) {
  const incoming = s.state === 'incoming' && state === 'none';
  const done =
    state === 'friends'
      ? 'Friends'
      : state === 'requested' || s.state === 'requested'
        ? 'Requested'
        : undefined;
  return (
    <PersonTile
      name={s.name}
      photo={s.avatarUrl}
      seed={s.userId}
      to={s.personId ? `/people/${s.personId}` : undefined}
      href={s.linkedinUrl}
      lines={[s.reason, s.headline && s.headline !== s.reason ? s.headline : connectionsLabel(s.connections)]}
      testId="friend-suggestion"
      action={
        <TileButton
          label={incoming ? 'Accept' : 'Add'}
          icon={incoming ? 'accept' : 'add'}
          done={done}
          busy={state === 'busy'}
          onClick={() => (incoming ? onAccept(s) : onAdd(s))}
          testId="friend-suggestion-add"
        />
      }
    />
  );
}

export function InviteTile({
  s,
  state,
  onInvite,
}: {
  s: InviteSuggestion;
  state: TileState;
  onInvite: (s: InviteSuggestion) => void;
}) {
  return (
    <PersonTile
      name={s.name}
      photo={s.photoUrl}
      seed={s.personId}
      to={`/people/${s.personId}`}
      lines={[s.reason, s.headline]}
      testId="friend-invitee"
      action={
        <TileButton
          label="Invite"
          icon={s.via === 'linkedin' ? 'linkedin' : 'invite'}
          done={state === 'invited' ? 'Invited' : undefined}
          busy={state === 'busy'}
          onClick={() => onInvite(s)}
          testId="friend-invitee-invite"
        />
      }
    />
  );
}

/** The search box: results come in as the student types (after a short pause), by name or by an exact address. */
export function FriendSearch({ onSearch }: { onSearch: (q: string) => void }) {
  const [q, setQ] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <label className="relative block" data-testid="friends-search">
      <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
      <Input
        value={q}
        onChange={(e) => {
          const v = e.target.value;
          setQ(v);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => onSearch(v.trim()), 250);
        }}
        placeholder="Find someone on Orbit by name or email"
        aria-label="Find someone on Orbit"
        className="pl-9 h-11"
        data-testid="friends-search-input"
      />
    </label>
  );
}
