/**
 * The pieces every result card is built from, so the cards read as one family: a flat card, one header line (a
 * face or logo, the title, one chip, one quiet link), compact person rows, lists that fold after five, and a row of
 * next steps that sends a message the chat's tools understand.
 */
import type { Person } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowRight, ArrowUpRight, Check, ChevronDown, Loader2, Plus } from 'lucide-react';
import { createContext, type ReactNode, useContext, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../../db/schema';
import { Avatar, cx, LinkedInMark } from '../../../ui';
import { type ResultEnvelope, type StepRun, tapActionId } from '../../types';
import { ChoicesContext } from './Choices';

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
  const runner = useContext(StepRunnerContext);
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
          {steps.map((s) =>
            s.run && runner.run && runner.origin ? (
              <InPlaceStep
                key={s.label}
                step={{ label: s.label, run: s.run }}
                origin={runner.origin}
                run={runner.run}
              />
            ) : (
              <button
                key={s.label}
                type="button"
                className="inline-flex items-center gap-1 min-h-7 px-2.5 py-1 rounded-[6px] border border-ink bg-ink text-canvas text-[12.5px] font-medium leading-tight hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 disabled:pointer-events-none"
                disabled={running}
                title={s.message}
                data-testid="selection-step"
                onClick={() => void send(s.message)}
              >
                <ArrowRight size={12} aria-hidden className="shrink-0" />
                {s.label}
              </button>
            ),
          )}
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
  const { running } = useContext(ChoicesContext);
  const runner = useContext(StepRunnerContext);
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
      {list.map((s) =>
        s.run && runner.run && runner.origin ? (
          <InPlaceStep
            key={s.label}
            step={{ label: s.label, run: s.run }}
            origin={runner.origin}
            run={runner.run}
          />
        ) : (
          <button
            key={s.label}
            type="button"
            className="inline-flex items-center gap-1 min-h-7 max-w-full px-2.5 py-1 rounded-[6px] border border-line bg-canvas text-[12.5px] font-medium leading-tight text-ink-2 text-left hover:text-ink hover:bg-canvas-2 hover:border-[#d6d4d0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 disabled:pointer-events-none"
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
        ),
      )}
    </div>
  );
}

const STEP_CHIP =
  'inline-flex items-center gap-1 min-h-7 max-w-full px-2.5 py-1 rounded-[6px] border text-[12.5px] font-medium leading-tight text-left';

/**
 * A button that does its thing where it is (plan 37 §4): "Add Stripe to targets" runs, then reads "Added to targets"
 * with a check. Nothing is said in the thread. The tap is recorded under the card, so a reload shows it done; a
 * failure says so in one line and the button can be tapped again.
 */
export function InPlaceStep({
  step,
  origin,
  run,
}: {
  step: { label: string; run: StepRun };
  origin: string;
  run: (step: { label: string; run: StepRun }) => Promise<ResultEnvelope>;
}) {
  const id = tapActionId(origin, step);
  // a tap recorded earlier (this conversation, before a reload); a temporary chat keeps it only in this state
  const stored = useLiveQuery(() => db.chatActions.get(id), [id]);
  const [local, setLocal] = useState<'running' | 'done' | 'failed'>();
  const [error, setError] = useState<string>();
  const state = local ?? (stored?.status === 'done' ? 'done' : undefined);
  const go = async () => {
    if (state === 'running' || state === 'done') return;
    setLocal('running');
    setError(undefined);
    try {
      const env = await run(step);
      if (env.kind === 'error' || env.kind === 'needs_confirmation') {
        setLocal('failed');
        setError(env.kind === 'error' ? env.summary : 'That needs your approval in a message.');
      } else setLocal('done');
    } catch (e) {
      setLocal('failed');
      setError(e instanceof Error ? e.message : 'That did not go through.');
    }
  };
  if (state === 'done')
    return (
      <span
        className={cx(STEP_CHIP, 'border-line-2 bg-canvas-2 text-ink-3')}
        data-testid="next-step"
        data-state="done"
        aria-live="polite"
      >
        <Check size={12} aria-hidden className="shrink-0" />
        <span className="min-w-0">{step.run.done}</span>
      </span>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <button
        type="button"
        className={cx(
          STEP_CHIP,
          'border-line bg-canvas text-ink-2 hover:text-ink hover:bg-canvas-2 hover:border-[#d6d4d0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 disabled:pointer-events-none',
        )}
        disabled={state === 'running'}
        aria-busy={state === 'running'}
        data-testid="next-step"
        data-state={state ?? 'ready'}
        onClick={() => void go()}
      >
        {state === 'running' ? (
          <Loader2 size={12} aria-hidden className="shrink-0 animate-spin text-ink-3" />
        ) : (
          <Plus size={12} aria-hidden className="shrink-0 text-ink-3" />
        )}
        <span className="min-w-0">{step.label}</span>
      </button>
      {state === 'failed' && error && (
        <span className="text-[12.5px] text-bad" data-testid="next-step-error">
          {error}
        </span>
      )}
    </span>
  );
}
