/**
 * The pieces every result card is built from, so the cards read as one family: a flat card, one header line (a
 * face or logo, the title, one chip, one quiet link), compact person rows, lists that fold after five, and a row of
 * next steps that sends a message the chat's tools understand.
 */
import type { Person } from '@orbit/core';
import { ArrowRight, ArrowUpRight, ChevronDown } from 'lucide-react';
import { createContext, type ReactNode, useContext, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar, cx, LinkedInMark } from '../../../ui';
import { ChoicesContext } from './Choices';

/**
 * Which card holds each draft's editor (draft id to tool use id): the newest one in the thread, so the same draft is
 * never edited in two places. Older cards for it fold to one line.
 */
export const DraftOwnersContext = createContext<ReadonlyMap<string, string>>(new Map());

/** The label of the page an href opens, for the quiet link in a card's header. */
export function hrefLabel(href: string): string {
  const path = href.split('?')[0]!.split('#')[0]!;
  if (path.startsWith('/people/')) return 'Profile';
  if (path.startsWith('/companies/')) return 'Company';
  if (path.startsWith('/inbox')) return 'Drafts';
  if (path.startsWith('/map')) return 'Map';
  if (path.startsWith('/settings')) return 'Settings';
  if (path.startsWith('/people')) return 'People';
  if (path.startsWith('/discover')) return 'Discover';
  if (path.startsWith('/notes')) return 'Notes';
  return 'Open';
}

/** A card's one link to its page: quiet, so it never competes with what the card is for. */
export function OpenInApp({ href, className, label }: { href?: string; className?: string; label?: string }) {
  if (!href) return null;
  return (
    <Link
      to={href}
      className={cx(
        'inline-flex items-center gap-0.5 h-7 px-2 rounded-full text-[12.5px] font-medium text-ink-3 hover:text-ink hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 whitespace-nowrap',
        className,
      )}
      data-testid="open-in-app"
    >
      {label ?? hrefLabel(href)} <ArrowUpRight size={13} aria-hidden />
    </Link>
  );
}

export function GlassCard({
  children,
  kind,
  className,
  tone,
}: {
  children: ReactNode;
  kind: string;
  className?: string;
  tone?: 'bad' | 'warn';
}) {
  return (
    <div
      className={cx(
        'glass glass-strong rounded-[14px] px-3.5 py-3 my-2 min-w-0 max-w-full break-words text-[13.5px] leading-[1.45]',
        tone === 'bad' && 'border-bad/30',
        tone === 'warn' && 'border-warn/30',
        className,
      )}
      data-testid={`result-${kind}`}
    >
      {children}
    </div>
  );
}

/** One header line: an optional face or logo, the title, one chip, an optional second line, one quiet link. */
export function CardHead({
  title,
  lead,
  chip,
  sub,
  href,
  hrefText,
  aside,
  className,
}: {
  title: ReactNode;
  lead?: ReactNode;
  chip?: ReactNode;
  sub?: ReactNode;
  href?: string;
  hrefText?: string;
  /** in place of the link, when the header's one action is something else */
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex items-center gap-2.5 min-w-0 mb-1.5', className)}>
      {lead}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <div className="font-semibold text-[14px] leading-tight min-w-0 truncate">{title}</div>
          {chip}
        </div>
        {sub && <div className="text-[12.5px] text-ink-3 truncate mt-0.5">{sub}</div>}
      </div>
      {aside ?? <OpenInApp href={href} label={hrefText} className="shrink-0 -mr-1.5" />}
    </div>
  );
}

/** A small label over a part of a card ("Questions to ask", "Who they know"). */
export function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('mt-2.5', className)}>
      <div className="text-[11.5px] font-medium text-ink-3 mb-1">{title}</div>
      {children}
    </div>
  );
}

/** A person in a list: a small face, the name, one line under it, and room for a chip on the right. */
export function PersonRow({
  person,
  sub,
  href,
  aside,
  size,
  dense,
}: {
  person: Pick<Person, 'id' | 'displayName' | 'photoUrl' | 'currentTitle' | 'currentOrganizationRaw'> &
    Partial<Pick<Person, 'linkedinUrl'>>;
  sub?: ReactNode;
  href?: string;
  aside?: ReactNode;
  size?: number;
  /** one line: the name with its sub beside it, for long lists where the second line is short */
  dense?: boolean;
}) {
  const role = sub ?? [person.currentTitle, person.currentOrganizationRaw].filter(Boolean).join(' at ');
  const to = href ?? `/people/${person.id}`;
  return (
    <div className={cx('flex items-center gap-2.5 min-w-0', dense ? 'py-1' : 'py-1.5')}>
      <Link to={to} className="shrink-0" tabIndex={-1} aria-hidden>
        <Avatar
          name={person.displayName}
          src={person.photoUrl}
          id={person.id}
          size={size ?? (dense ? 22 : 28)}
        />
      </Link>
      {dense ? (
        <div className="min-w-0 flex-1 truncate">
          <Link to={to} className="font-medium hover:underline">
            {person.displayName}
          </Link>
          {person.linkedinUrl && <LinkedInMark url={person.linkedinUrl} name={person.displayName} />}
          {role && <span className="text-[12.5px] text-ink-3"> · {role}</span>}
        </div>
      ) : (
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex items-center gap-1.5 min-w-0">
            <Link to={to} className="font-medium hover:underline truncate">
              {person.displayName}
            </Link>
            {person.linkedinUrl && <LinkedInMark url={person.linkedinUrl} name={person.displayName} />}
          </div>
          {role && <div className="text-[12.5px] text-ink-3 truncate mt-0.5">{role}</div>}
        </div>
      )}
      {aside}
    </div>
  );
}

/** A checkbox at the start of a row of people, so the student can pick who the next step is about. */
export function PickBox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={`Pick ${label}`}
      className="h-4 w-4 shrink-0 accent-accent cursor-pointer"
      data-testid="pick-person"
    />
  );
}

/**
 * The bar under a list of people once some are picked: how many, and what to do with them, each a message the chat
 * handles the same with or without a Claude key. "All" picks every row shown.
 */
export function SelectionBar({
  count,
  total,
  onAll,
  onClear,
  steps,
  send,
}: {
  count: number;
  total: number;
  onAll: () => void;
  onClear: () => void;
  steps: NextStep[];
  send: (text: string) => Promise<void> | void;
}) {
  const { running } = useContext(ChoicesContext);
  if (!total) return null;
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px]"
      role="group"
      aria-label="Picked people"
      data-testid="selection-bar"
    >
      <span className="text-ink-3" data-testid="selection-count">
        {count ? `${count} picked` : 'Pick people to act on them'}
      </span>
      <button
        type="button"
        className="text-ink-3 underline underline-offset-2 hover:text-ink"
        onClick={count === total ? onClear : onAll}
        data-testid="selection-all"
      >
        {count === total ? 'None' : 'All'}
      </button>
      {count > 0 && (
        <span className="flex flex-wrap gap-1.5">
          {steps.map((s) => (
            <button
              key={s.label}
              type="button"
              className="inline-flex items-center gap-1 min-h-7 px-2.5 py-1 rounded-full border border-ink bg-ink text-canvas text-[12.5px] font-medium leading-tight hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 disabled:pointer-events-none"
              disabled={running}
              title={s.message}
              data-testid="selection-step"
              onClick={() => void send(s.message)}
            >
              <ArrowRight size={12} aria-hidden className="shrink-0" />
              {s.label}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

/** The first `n` of a list, and the button that shows the rest. */
export function useFold<T>(items: T[], n = 5): { shown: T[]; more: ReactNode } {
  const [open, setOpen] = useState(false);
  const fold = items.length > n + 1;
  const shown = fold && !open ? items.slice(0, n) : items;
  const more = fold ? (
    <button
      type="button"
      className="mt-1 inline-flex items-center gap-1 h-7 px-2 -ml-2 rounded-full text-[12.5px] font-medium text-ink-3 hover:text-ink hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      data-testid="show-all"
    >
      {open ? 'Show fewer' : `Show all ${items.length}`}
      <ChevronDown size={13} aria-hidden className={cx('transition-transform', open && 'rotate-180')} />
    </button>
  ) : null;
  return { shown, more };
}

/** A next step a card offers: the chip's words, and the message it sends as the student's next turn. */
export interface NextStep {
  label: string;
  message: string;
}

/**
 * The row of next steps at the foot of a card: up to three quiet chips. A tap sends the step's message, which the
 * chat's tools handle the same way with or without a Claude key. They wait while a turn runs.
 */
export function NextSteps({
  steps,
  send,
}: {
  steps: NextStep[];
  send: (text: string) => Promise<void> | void;
}) {
  const { running } = useContext(ChoicesContext);
  const sending = useRef(false);
  const list = steps.slice(0, 3);
  if (!list.length) return null;
  return (
    <div
      className="mt-2.5 flex flex-wrap gap-1.5"
      role="group"
      aria-label="Next steps"
      data-testid="next-steps"
    >
      {list.map((s) => (
        <button
          key={s.label}
          type="button"
          className="inline-flex items-center gap-1 min-h-7 max-w-full px-2.5 py-1 rounded-full border border-line bg-canvas text-[12.5px] font-medium leading-tight text-ink-2 text-left hover:text-ink hover:bg-canvas-2 hover:border-[#d6d4d0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 disabled:pointer-events-none"
          disabled={running}
          title={s.message}
          data-testid="next-step"
          onClick={() => {
            if (sending.current || running) return;
            sending.current = true;
            void Promise.resolve(send(s.message)).finally(() => {
              sending.current = false;
            });
          }}
        >
          <ArrowRight size={12} aria-hidden className="shrink-0 text-ink-3" />
          <span className="min-w-0">{s.label}</span>
        </button>
      ))}
    </div>
  );
}
