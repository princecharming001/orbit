/**
 * The pieces every result card is built from, so the cards read as one family: a flat card, one header line (a
 * face or logo, the title, one chip, one quiet link), compact person rows, lists that fold after five, and a row of
 * next steps that sends a message the chat's tools understand.
 */
import type { Person } from '@orbit/core';
import { ArrowRight, ArrowUpRight, Check, ChevronDown, Loader2, PanelRight } from 'lucide-react';
import { createContext, type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar, cx, LinkedInMark, PickCircle } from '../../../ui';
import type { ResultEnvelope, StepRun } from '../../types';
import { useStepGo } from './stepGo';

/**
 * Which card holds each draft's editor (draft id to tool use id): the newest one in the thread, so the same draft is
 * never edited in two places. Older cards for it fold to one line.
 */
export const DraftOwnersContext = createContext<ReadonlyMap<string, string>>(new Map());

/**
 * The people this turn shows a full person card for: a one-person list of the same person beside it says nothing
 * new, so it is left out.
 */
export const TurnPersonCardsContext = createContext<ReadonlySet<string>>(new Set());

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
        'inline-flex items-center gap-0.5 h-7 px-2 rounded-[6px] text-[12.5px] font-medium text-ink-3 hover:text-ink hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 whitespace-nowrap',
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
        'glass glass-strong rounded-[6px] px-4 py-3.5 my-3 min-w-0 max-w-full break-words text-[13.5px] leading-[1.55]',
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
    <div className={cx('flex items-center gap-3 min-w-0 mb-3', className)}>
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
    <div className={cx('mt-4', className)}>
      <div className="text-[11.5px] font-medium text-ink-3 mb-2">{title}</div>
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
    <div className={cx('flex items-center gap-3 min-w-0', dense ? 'py-2' : 'py-2.5')}>
      <Link to={to} className="shrink-0" tabIndex={-1} aria-hidden>
        <Avatar
          name={person.displayName}
          src={person.photoUrl}
          id={person.id}
          size={size ?? (dense ? 26 : 32)}
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
  return <PickCircle checked={checked} onChange={onChange} label={`Pick ${label}`} />;
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
  if (!total) return null;
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px]"
      role="group"
      aria-label="Picked people"
      data-testid="selection-bar"
    >
      {count > 0 && (
        <span className="text-ink-3" data-testid="selection-count">
          {count} picked
        </span>
      )}
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
            <StepPill key={s.label} step={s} send={send} />
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
      className="mt-1 inline-flex items-center gap-1 h-7 px-2 -ml-2 rounded-[6px] text-[12.5px] font-medium text-ink-3 hover:text-ink hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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

/**
 * A next step a card offers: the chip's words, and the message it sends as the student's next turn. A step with `run`
 * acts in place instead (plan 37 §4): the tool runs at once, the chip shows `run.done`, and nothing is added to the
 * thread. `message` stays the same request in words, for the no-key router ("do it" after a card) and the tests.
 */
export interface NextStep {
  label: string;
  message: string;
  run?: StepRun;
  /** a page of the app to open in the side panel instead (a person's prep deck): no tool, no turn */
  open?: string;
}

/** The card's own tool_use id and how to run one of its buttons in place; empty where a card cannot act. */
export const StepRunnerContext = createContext<{
  origin?: string;
  run?: (step: { label: string; run: StepRun }) => Promise<ResultEnvelope>;
}>({});

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
  const list = steps.slice(0, 3);
  if (!list.length) return null;
  return (
    <div className="mt-3" role="group" aria-label="Next steps" data-testid="next-steps">
      <div className="mb-0.5 text-[11.5px] font-medium uppercase tracking-wide text-ink-3">Next steps</div>
      <div className="divide-y divide-line-2 border-y border-line-2">
        {list.map((s) => (
          <StepRow key={s.label} step={s} send={send} />
        ))}
      </div>
    </div>
  );
}

/**
 * One next step as a row: a round tick, the words, and where it goes. A step that runs in place or opens in the side
 * panel (plan 42) does its work where the student is: once done the row says what it did, and a result in the panel
 * opens again from here. A step that is a message is sent as the next turn, and reads as ticked off.
 */
export function StepRow({ step, send }: { step: NextStep; send: (text: string) => Promise<void> | void }) {
  const g = useStepGo(step, send);
  const done = g.state === 'done';
  const reopens = done && (g.mode === 'panel' || g.mode === 'open');
  const inert = done && g.mode === 'place';
  const words = done && g.mode !== 'send' ? g.doneLabel : step.label;
  const body = (
    <>
      <StepBox done={done} busy={g.state === 'running'} />
      <span
        className={cx(
          'min-w-0 flex-1',
          done && g.mode === 'send' && 'text-ink-3 line-through',
          inert && 'text-ink-3',
        )}
      >
        {words}
      </span>
      {!inert &&
        (reopens ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-ink-3 group-hover/step:text-ink">
            Open
            <PanelRight size={14} aria-hidden />
          </span>
        ) : g.mode === 'panel' || g.mode === 'open' ? (
          <PanelRight
            size={14}
            aria-hidden
            className="shrink-0 text-ink-3 transition-colors group-hover/step:text-ink"
          />
        ) : (
          <ArrowRight
            size={14}
            aria-hidden
            className="shrink-0 text-ink-3 transition-transform group-hover/step:translate-x-0.5"
          />
        ))}
    </>
  );
  return (
    <span className="block">
      {inert ? (
        <span
          className={STEP_ROW}
          data-testid="next-step"
          data-state="done"
          data-mode={g.mode}
          aria-live="polite"
        >
          {body}
        </span>
      ) : (
        <button
          type="button"
          className={cx(
            STEP_ROW,
            'group/step hover:bg-canvas-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60',
          )}
          disabled={g.blocked || g.state === 'running'}
          aria-busy={g.state === 'running'}
          title={g.mode === 'panel' || g.mode === 'open' ? 'Opens beside the chat' : step.message}
          data-testid="next-step"
          data-state={g.state}
          data-mode={g.mode}
          onClick={g.go}
        >
          {body}
        </button>
      )}
      {g.state === 'failed' && g.error && (
        <span className="block px-1 pb-2 text-[12.5px] text-bad" data-testid="next-step-error">
          {g.error}
        </span>
      )}
    </span>
  );
}

/**
 * A step as a dark pill (the bar under picked people): the same work as a row. Once done it says what it did and,
 * for a result in the side panel, opens it again.
 */
export function StepPill({ step, send }: { step: NextStep; send: (text: string) => Promise<void> | void }) {
  const g = useStepGo(step, send);
  const done = g.state === 'done';
  const inert = done && g.mode === 'place';
  if (inert)
    return (
      <span
        className="inline-flex min-h-7 items-center gap-1 px-1.5 py-1 text-[12.5px] font-medium text-ink-3"
        data-testid="selection-step"
        data-state="done"
        data-mode={g.mode}
        aria-live="polite"
      >
        <Check size={12} strokeWidth={3} aria-hidden className="text-accent" />
        {g.doneLabel}
      </span>
    );
  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        className={cx(
          'inline-flex items-center gap-1 min-h-7 px-2.5 py-1 rounded-[6px] text-[12.5px] font-medium leading-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 disabled:pointer-events-none',
          done && g.mode !== 'send'
            ? 'border border-line bg-canvas text-ink hover:bg-canvas-2'
            : 'border border-ink bg-ink text-canvas hover:opacity-90',
        )}
        disabled={g.blocked || g.state === 'running'}
        aria-busy={g.state === 'running'}
        title={g.mode === 'panel' || g.mode === 'open' ? 'Opens beside the chat' : step.message}
        data-testid="selection-step"
        data-state={g.state}
        data-mode={g.mode}
        onClick={g.go}
      >
        {g.state === 'running' ? (
          <Loader2 size={12} aria-hidden className="shrink-0 animate-spin" />
        ) : done && g.mode !== 'send' ? (
          <Check size={12} strokeWidth={3} aria-hidden className="shrink-0 text-accent" />
        ) : (
          <ArrowRight size={12} aria-hidden className="shrink-0" />
        )}
        {done && g.mode !== 'send' ? g.doneLabel : step.label}
        {done && (g.mode === 'panel' || g.mode === 'open') && (
          <PanelRight size={12} aria-hidden className="shrink-0" />
        )}
      </button>
      {g.state === 'failed' && g.error && (
        <span className="pt-1 text-[12px] text-bad" data-testid="next-step-error">
          {g.error}
        </span>
      )}
    </span>
  );
}

/** The box at the start of a step: empty, or ticked once it is done. */
function StepBox({ done, busy }: { done?: boolean; busy?: boolean }) {
  return (
    <span
      className={cx(
        'inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px]',
        done ? 'border-accent bg-accent text-white' : 'border-[#cfccc6] bg-canvas',
      )}
      aria-hidden
    >
      {busy ? (
        <Loader2 size={11} className="animate-spin text-ink-3" />
      ) : done ? (
        <Check size={12} strokeWidth={3} />
      ) : null}
    </span>
  );
}

const STEP_ROW = 'flex w-full items-center gap-3 px-1 py-2.5 text-left text-[13.5px] leading-snug text-ink';

/**
 * A button that does its thing where it is (plan 37 §4): "Add Stripe to targets" runs, then reads "Added to targets"
 * with a check. Nothing is said in the thread. Kept for callers that hold a step's run alone; the row is StepRow.
 */
export function InPlaceStep({
  step,
}: {
  step: { label: string; run: StepRun };
  origin?: string;
  run?: unknown;
}) {
  return <StepRow step={{ label: step.label, message: step.label, run: step.run }} send={() => undefined} />;
}
