/**
 * The one look every list of people shares (the network search card set it): a flat white card, rows with a face,
 * the name and its LinkedIn mark, one quiet line under it, the whole row a link, a checkbox where the face is on
 * hover, and one footer for "Show all" and what to do with the picked people.
 */
import { ArrowRight, ArrowUpRight, Check, ChevronDown, Copy, Mail, X } from 'lucide-react';
import { type ReactNode, useContext, useState } from 'react';
import { Link } from 'react-router-dom';
import { copyText } from '../../../components/approve';
import { Avatar, cx, LinkedInMark } from '../../../ui';
import { ChoicesContext } from './Choices';
import type { NextStep } from './parts';

/** "Co-Founder at Turnstone (YC W26)": the words without the batch, and the batch as its own tag. */
export function splitBatch(text: string | undefined): { text?: string; batch?: string } {
  if (!text) return {};
  const m = /\s*\(\s*(?:yc|y combinator)\s+([a-z]{1,6}\s?'?\d{2,4})\s*\)/i.exec(text);
  const yc = /\(\s*YC lists [^)]*\)/i.exec(text);
  let rest = text;
  if (m) rest = rest.replace(m[0], '');
  if (yc) rest = rest.replace(yc[0], '');
  return {
    text: rest.replace(/\s{2,}/g, ' ').trim() || undefined,
    batch: m?.[1]?.toUpperCase().replace(/\s/g, ''),
  };
}

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

/** The card around a list of people: a count as the title, one quiet line under it, and room for tabs. */
export function PeopleShell({
  title,
  sub,
  aside,
  testId,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  aside?: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div
      className="@container isolate my-2 min-w-0 max-w-full overflow-hidden rounded-[6px] border border-line bg-canvas text-[13.5px] leading-[1.45] shadow-[0_1px_2px_rgba(10,10,10,0.04)]"
      data-testid={testId}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pt-3.5 pb-2">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold leading-tight tracking-[-0.01em] text-ink">{title}</div>
          {sub && <div className="mt-0.5 text-[12px] text-ink-3">{sub}</div>}
        </div>
        {aside}
      </div>
      {children}
    </div>
  );
}

/** A small word beside a name: green with a dot for someone close, quiet grey for the rest. */
export function NameTag({ children, tone = 'quiet' }: { children: ReactNode; tone?: 'good' | 'quiet' }) {
  return (
    <span
      className={cx(
        'ml-0.5 hidden shrink-0 items-center gap-1 text-[11.5px] font-medium @xs:inline-flex',
        tone === 'good' ? 'text-good' : 'text-ink-3',
      )}
    >
      <span className={cx('h-1.5 w-1.5 rounded-full', tone === 'good' ? 'bg-good' : 'bg-line')} aria-hidden />
      {children}
    </span>
  );
}

/** The YC batch as its own small tag. */
export function BatchTag({ batch, title }: { batch: string; title?: string }) {
  return (
    <span
      className="shrink-0 rounded-[5px] bg-ember-soft px-1.5 text-[11px] font-semibold leading-[18px] text-ember"
      title={title}
    >
      YC {batch}
    </span>
  );
}

export type EmailSureness = 'verified' | 'page' | 'pattern' | 'guess';

const SURENESS: Record<EmailSureness, { label: string; tone: string; title: string }> = {
  verified: {
    label: 'Verified',
    tone: 'text-good',
    title: 'Their own LinkedIn contact email, or an address a mail check confirmed',
  },
  page: { label: 'On their page', tone: 'text-ink-3', title: 'Written on a public page about them' },
  pattern: {
    label: 'Company pattern',
    tone: 'text-ink-3',
    title: 'Built from the address pattern the company uses',
  },
  guess: {
    label: 'Unconfirmed',
    tone: 'text-warn',
    title: 'A guess nobody confirmed. Check it before sending',
  },
};

/** An email in a row: the address (a tap copies it) and how sure Orbit is of it. */
export function EmailLine({
  email,
  sureness,
  testId,
}: {
  email: string;
  sureness?: EmailSureness;
  /** on the address itself */
  testId?: string;
}) {
  const [copied, setCopied] = useState(false);
  const s = SURENESS[sureness ?? 'page'];
  return (
    <span className="relative z-10 inline-flex min-w-0 items-center gap-1.5" data-testid="person-email">
      <button
        type="button"
        className={cx(
          'group/email inline-flex min-w-0 items-center gap-1 rounded text-ink-2 hover:text-ink',
          FOCUS,
        )}
        title={copied ? 'Copied' : 'Copy the address'}
        aria-label={`Copy ${email}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void copyText(email).then((ok) => {
            if (!ok) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          });
        }}
      >
        <Mail size={12} className="shrink-0 text-ink-3" aria-hidden />
        <span className="truncate" data-testid={testId}>
          {email}
        </span>
        {copied ? (
          <Check size={11} className="shrink-0 text-good" aria-hidden />
        ) : (
          <Copy
            size={11}
            className="shrink-0 text-ink-3 opacity-0 transition-opacity group-hover/email:opacity-100"
            aria-hidden
          />
        )}
      </button>
      <span
        className={cx('shrink-0 text-[11px] font-medium', s.tone)}
        title={s.title}
        data-testid="email-sureness"
        data-sureness={sureness ?? 'page'}
      >
        {s.label}
      </span>
    </span>
  );
}

/** A dot between two parts of a line. */
export const Dot = () => (
  <span aria-hidden className="mx-0.5 shrink-0 text-line">
    ·
  </span>
);

/**
 * One person: the whole row is a link (in the app, or out to their page), the face turns into a checkbox on hover
 * when rows can be picked, and the right edge shows where the row goes and, when given, a way to drop it.
 */
export function PersonLine({
  name,
  avatar,
  linkedinUrl,
  tag,
  line,
  extra,
  to,
  href,
  goLabel,
  linkLabel,
  pick,
  onDismiss,
  trailing,
  testId = 'person-line',
  linkTestId,
  data,
}: {
  name: string;
  avatar: { id: string; src?: string };
  linkedinUrl?: string;
  /** beside the name: closeness, or how they connect */
  tag?: ReactNode;
  /** the line under the name */
  line?: ReactNode;
  /** a third line, for the email */
  extra?: ReactNode;
  /** in-app link for the whole row */
  to?: string;
  /** an outside page for the whole row, when there is no in-app one */
  href?: string;
  /** what the hover hint says, e.g. "Warm path" */
  goLabel?: string;
  /** what a screen reader hears for the row's link */
  linkLabel?: string;
  pick?: { picking: boolean; picked: boolean; onPick: (on: boolean) => void };
  onDismiss?: { label: string; run: () => void };
  /** a control at the right edge, in place of the hover hint (Discover's Add) */
  trailing?: ReactNode;
  testId?: string;
  linkTestId?: string;
  data?: Record<string, string | undefined>;
}) {
  const dataAttrs = Object.fromEntries(
    Object.entries(data ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [`data-${k}`, v]),
  );
  const cover = `absolute inset-0 rounded-[6px] ${FOCUS}`;
  const label = linkLabel ?? `Open ${name}`;
  return (
    <div
      className="group/row relative flex items-center gap-3 rounded-[6px] px-2.5 py-2 transition-colors hover:bg-canvas-2 focus-within:bg-canvas-2"
      data-testid={testId}
      {...dataAttrs}
    >
      {/* the whole row is the link; the controls inside sit above it */}
      {to ? (
        <Link to={to} className={cover} aria-label={label} data-testid={linkTestId} />
      ) : href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className={cover}
          aria-label={label}
          data-testid={linkTestId}
        >
          <span className="sr-only">{label}</span>
        </a>
      ) : null}
      <div className="relative h-9 w-9 shrink-0">
        <div
          className={cx(
            'transition-opacity',
            pick && (pick.picking ? 'opacity-0' : 'group-hover/row:opacity-0'),
          )}
        >
          <Avatar name={name} src={avatar.src} id={avatar.id} size={36} />
        </div>
        {pick && (
          <label
            className={cx(
              'absolute inset-0 z-10 flex cursor-pointer items-center justify-center rounded-full transition-opacity',
              pick.picking ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 focus-within:opacity-100',
            )}
          >
            <input
              type="checkbox"
              className="peer absolute inset-0 z-10 m-0 cursor-pointer appearance-none rounded-full opacity-0"
              checked={pick.picked}
              onChange={(e) => pick.onPick(e.target.checked)}
              aria-label={`Pick ${name}`}
              data-testid="pick-person"
            />
            <span
              className={cx(
                'pointer-events-none flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40',
                pick.picked ? 'border-ink bg-ink text-canvas' : 'border-[#cfccc6] bg-canvas',
              )}
              aria-hidden
            >
              {pick.picked && <Check size={12} strokeWidth={3} />}
            </span>
          </label>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[14px] font-medium leading-5 text-ink">{name}</span>
          {linkedinUrl && (
            <span className="relative z-10 inline-flex">
              <LinkedInMark url={linkedinUrl} name={name} />
            </span>
          )}
          {tag}
        </div>
        {line && (
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] leading-5 text-ink-3">
            {line}
          </div>
        )}
        {extra && (
          // its buttons and links sit above the row's own link, so "Find email" finds the email instead of opening
          // the page the row links to
          <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] leading-5 text-ink-3 [&_a]:relative [&_a]:z-10 [&_button]:relative [&_button]:z-10">
            {extra}
          </div>
        )}
      </div>
      {trailing ? (
        <span className="relative z-10 shrink-0">{trailing}</span>
      ) : (
        (to || href) &&
        goLabel && (
          <span
            className="pointer-events-none hidden shrink-0 items-center gap-1 text-[12px] font-medium text-ink-2 opacity-0 transition-opacity group-hover/row:opacity-100 @lg:inline-flex"
            aria-hidden
          >
            {goLabel} {to ? <ArrowRight size={13} /> : <ArrowUpRight size={13} />}
          </span>
        )
      )}
      {onDismiss && (
        <button
          type="button"
          className={cx(
            'relative z-10 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-3 opacity-0 transition-opacity hover:bg-canvas hover:text-ink focus-visible:opacity-100 group-hover/row:opacity-100',
            FOCUS,
          )}
          aria-label={onDismiss.label}
          title="Not a match"
          onClick={onDismiss.run}
        >
          <X size={13} aria-hidden />
        </button>
      )}
    </div>
  );
}

/** The rows, folded after `fold` with a footer button to show the rest. */
export function useRowFold<T>(rows: T[], fold = 8) {
  const [open, setOpen] = useState(false);
  const folds = rows.length > fold + 1;
  return {
    shown: open || !folds ? rows : rows.slice(0, fold),
    folds,
    open,
    toggle: () => setOpen((v) => !v),
  };
}

/**
 * The foot of a people card: "Show all", then either what to do with the picked people or the card's next steps.
 * Hidden when there is nothing to put in it.
 */
export function PeopleFooter({
  fold,
  total,
  picked,
  onClear,
  pickedSteps,
  steps,
  send,
}: {
  fold: { folds: boolean; open: boolean; toggle: () => void };
  total: number;
  picked: number;
  onClear: () => void;
  pickedSteps: NextStep[];
  steps: NextStep[];
  send: (text: string) => Promise<void> | void;
}) {
  const { running } = useContext(ChoicesContext);
  if (!fold.folds && !picked && !steps.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-line-2 px-3 py-2">
      {fold.folds && (
        <button
          type="button"
          className={cx(
            'inline-flex h-8 items-center gap-1 rounded-[6px] px-2.5 text-[12.5px] font-medium text-ink-2 hover:bg-canvas-2 hover:text-ink',
            FOCUS,
          )}
          aria-expanded={fold.open}
          onClick={fold.toggle}
          data-testid="show-all"
        >
          {fold.open ? 'Show fewer' : `Show all ${total}`}
          <ChevronDown
            size={13}
            aria-hidden
            className={cx('transition-transform', fold.open && 'rotate-180')}
          />
        </button>
      )}
      <span className="flex-1" />
      {picked > 0 ? (
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label="Picked people"
          data-testid="selection-bar"
        >
          <span className="px-1 text-[12.5px] text-ink-3" data-testid="selection-count">
            {picked} picked
          </span>
          <button
            type="button"
            className="h-8 rounded-[6px] px-2.5 text-[12.5px] font-medium text-ink-3 hover:bg-canvas-2 hover:text-ink"
            onClick={onClear}
            data-testid="selection-all"
          >
            Clear
          </button>
          {pickedSteps.map((s) => (
            <button
              key={s.label}
              type="button"
              className={cx(
                'inline-flex h-8 items-center gap-1 rounded-[6px] bg-ink px-3 text-[12.5px] font-medium text-canvas hover:opacity-90 disabled:pointer-events-none disabled:opacity-50',
                FOCUS,
              )}
              disabled={running}
              title={s.message}
              data-testid="selection-step"
              onClick={() => void send(s.message)}
            >
              {s.label}
              <ArrowRight size={13} aria-hidden />
            </button>
          ))}
        </div>
      ) : (
        steps.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-1.5"
            role="group"
            aria-label="Next steps"
            data-testid="next-steps"
          >
            {steps.slice(0, 3).map((s) => (
              <button
                key={s.label}
                type="button"
                className={cx(
                  'inline-flex h-8 items-center gap-1 rounded-[6px] px-2.5 text-[12.5px] font-medium text-ink-2 hover:bg-canvas-2 hover:text-ink disabled:pointer-events-none disabled:opacity-50',
                  FOCUS,
                )}
                disabled={running}
                title={s.message}
                data-testid="next-step"
                onClick={() => void send(s.message)}
              >
                {s.label}
              </button>
            ))}
          </div>
        )
      )}
    </div>
  );
}

/** Which rows are picked, shared by the checkboxes and the footer. */
export function usePickSet() {
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  return {
    size: ids.size,
    has: (id: string) => ids.has(id),
    set: (id: string, on: boolean) =>
      setIds((cur) => {
        const next = new Set(cur);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      }),
    clear: () => setIds(new Set()),
  };
}
