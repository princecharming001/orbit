import type { OutboundMessage, Person, Suggestion, User } from '@orbit/core';
import { STAGE_LABELS } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Minus,
  Sun,
  Undo2,
  X,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { db } from '../db/schema';
import { ensureDrafts, markWarmUpAction, needsWarmUp, startWarmUpOrOutreach } from '../engine/brief';
import { quotedMessageFor, wroteWhen } from '../engine/conversation';
import { composeDraft, markPrepOpened } from '../engine/drafts';
import { runEnrichment } from '../engine/enrichment';
import { markActionItemDone } from '../engine/facts';
import { answerIntroductionQuestion } from '../engine/introductions';
import {
  decisionActions,
  localDay,
  type MorningAction,
  type MorningActionId,
  type MorningDeck,
  type MorningMove,
  type MorningOutcome,
  markMorningSeen,
  morningDeck,
  morningDue,
  morningSummary,
  snapshotDecision,
  undoDecision,
} from '../engine/morning';
import { decideMerge } from '../engine/people';
import { photoWanted } from '../engine/photoSignals';
import { currentResumeFacets, sharesOrgNow } from '../engine/resume';
import { snoozeSuggestion } from '../engine/send';
import { decideProposedStage } from '../engine/stages';
import { useSession } from '../state/session';
import { Avatar, Button, Chip, cx, LinkedInMark, useToast } from '../ui';
import { DeckLayer, useDeckFocus, useDeckKeys, useDeckSwipe } from '../ui/Deck';
import { runApproval } from './approve';
import { PersonCompanyLogo } from './CompanyLogo';
import { DraftEditor } from './DraftEditor';
import { MergePair, PersonNameLink } from './MergePair';
import { gapLabel, KIND_LABEL } from './SuggestionCard';
import { WeekPaceCard } from './WeekPaceCard';

/** Anything can open the debrief again (Settings, the command palette): `openMorningBrief()`. */
export const MORNING_EVENT = 'orbit:morning-brief';
export function openMorningBrief(): void {
  window.dispatchEvent(new Event(MORNING_EVENT));
}

type Slide =
  | { kind: 'overview' }
  | { kind: 'decide'; s: Suggestion; n: number }
  | { kind: 'moves' }
  | { kind: 'done' };
/** How a decision ended, and the sentence that says so when the student comes back to it. */
type Result = { o: MorningOutcome; text?: string };
/** The last decision, kept so the footer can take it back. */
type Last = { sid: string; text: string; undo: () => Promise<void> };

/**
 * A deck waiting as a pill outlives a reload of the tab: which day, and which step it was on (by the card, since a
 * fresh deck no longer holds the ones already decided). Only this tab's session; losing it only loses the pill.
 */
const PILL_KEY = 'orbit:morning-pill';
type SavedPill = { userId: string; day: string; step: Slide['kind']; sid?: string; away: boolean };
function readPill(): SavedPill | undefined {
  try {
    return (JSON.parse(sessionStorage.getItem(PILL_KEY) ?? 'null') as SavedPill | null) ?? undefined;
  } catch {
    return undefined;
  }
}
function writePill(x: SavedPill | undefined): void {
  try {
    if (x) sessionStorage.setItem(PILL_KEY, JSON.stringify(x));
    else sessionStorage.removeItem(PILL_KEY);
  } catch {}
}

/**
 * The morning debrief: once a day, after the brief time, a deck in the middle of the screen (a sheet from the bottom
 * on a phone). Click, swipe or use the arrow keys to move through it: the day in numbers, each decision on its own
 * with its buttons, what is worth doing today, and what got done. Every decision is finished inside the deck: drafts
 * are reviewed and approved here, LinkedIn opens in a new tab. A button that opens another page says so, and the deck
 * waits as a pill at the bottom of every page that brings the student back to the same step. Closing it (or reaching
 * the end) puts it away until tomorrow.
 */
export function MorningBrief() {
  const { user, userId, settings } = useSession();
  const { pathname } = useLocation();
  const nav = useNavigate();
  const [mode, setMode] = useState<'hidden' | 'open' | 'pill'>('hidden');
  const [deck, setDeck] = useState<MorningDeck>();
  const [i, setI] = useState(0);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [last, setLast] = useState<Last>();
  const toast = useToast();
  // the student went to another page from the deck: the pill says it brings them back
  const [away, setAway] = useState(false);
  const ready = !!user?.onboardingCompletedAt && !pathname.startsWith('/onboarding');
  // put away once in this visit: it never comes back by itself before tomorrow, even before the saved day loads
  const putAway = useRef(false);
  const ref = useRef<HTMLElement>(null);

  const open = useCallback(async () => {
    if (!user) return;
    writePill(undefined);
    setDeck(await morningDeck(user));
    setI(0);
    setResults({});
    setLast(undefined);
    setAway(false);
    setMode('open');
  }, [user]);

  // a pill from before a reload comes back as a pill, on the step it was on
  const restored = useRef(false);
  useEffect(() => {
    if (!ready || !user || restored.current) return;
    restored.current = true;
    const saved = readPill();
    if (!saved || saved.userId !== user.id || saved.day !== localDay(new Date())) return;
    putAway.current = true;
    void morningDeck(user).then((d) => {
      const at = saved.sid ? d.decisions.findIndex((x) => x.id === saved.sid) : -1;
      const moves = 1 + d.decisions.length;
      const end = moves + (d.moves.length ? 1 : 0);
      setDeck(d);
      setI(
        at >= 0
          ? 1 + at
          : saved.step === 'moves' && d.moves.length
            ? moves
            : saved.step === 'done'
              ? end
              : saved.step === 'decide' && d.decisions.length
                ? 1
                : 0,
      );
      setResults({});
      setAway(saved.away);
      setMode('pill');
    });
  }, [ready, user]);

  // everyone in the deck, first card first: their photo links are refreshed before their card comes up, and the
  // people to write to whose role Orbit does not know yet are looked up, so each line can say what they do
  useEffect(() => {
    if (!deck || !user || mode === 'hidden') return;
    const ids = [
      ...new Set([
        ...deck.decisions.flatMap((s) => [s.personId, s.payload.otherPersonId, s.payload.introducerId]),
        ...deck.moves.map((m) => m.personId),
      ]),
    ].filter((id): id is string => typeof id === 'string');
    // the photo queue takes the most recent first, so the first card is asked for last
    const release = [...ids].reverse().map((id) => photoWanted(id));
    const unknown = deck.moves
      .map((m) => deck.people[m.personId])
      .filter((p): p is Person => !!p && !p.currentTitle && !p.currentOrganizationRaw && !p.headline)
      .map((p) => p.id);
    if (unknown.length) void runEnrichment(user, { only: unknown, reason: 'view' }).catch(() => undefined);
    return () => {
      for (const r of release) r();
    };
  }, [deck, user, mode]);

  // once a day, after the brief time: checked on load and every few minutes while the app is open
  useEffect(() => {
    if (!ready || mode !== 'hidden' || !settings || putAway.current) return;
    // a browser driven by tests only gets it when the test asks (`__ORBIT_MORNING__`), so it covers nothing else
    const g = globalThis as { __ORBIT_MORNING__?: unknown };
    const automated = typeof navigator !== 'undefined' && navigator.webdriver && g.__ORBIT_MORNING__ !== 'on';
    if (automated) return;
    // nothing to show while the tab is hidden: checked again as soon as it is shown
    const check = () => {
      if (!document.hidden && morningDue(settings, new Date())) void open();
    };
    check();
    const t = setInterval(check, 5 * 60_000);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', check);
    };
  }, [ready, mode, settings, open]);

  // Settings or the palette ask for it: a deck waiting as a pill comes back where it was, otherwise a fresh one
  useEffect(() => {
    const onAsk = () => {
      if (mode === 'pill' && deck) {
        setAway(false);
        setMode('open');
      } else void open();
    };
    window.addEventListener(MORNING_EVENT, onAsk);
    return () => window.removeEventListener(MORNING_EVENT, onAsk);
  }, [open, mode, deck]);

  const slides: Slide[] = deck
    ? [
        { kind: 'overview' },
        ...deck.decisions.map((s, n) => ({ kind: 'decide' as const, s, n })),
        ...(deck.moves.length ? [{ kind: 'moves' as const }] : []),
        { kind: 'done' },
      ]
    : [];
  const go = useCallback((to: number) => setI(Math.max(0, Math.min(slides.length - 1, to))), [slides.length]);
  // the day is saved before the card goes, so leaving the page right after never loses it
  const close = useCallback(async () => {
    putAway.current = true;
    writePill(undefined);
    if (userId) await markMorningSeen(userId).catch(() => undefined);
    setMode('hidden');
  }, [userId]);
  const minimize = useCallback(
    (toPage = false) => {
      putAway.current = true;
      if (userId) void markMorningSeen(userId);
      setAway(toPage);
      setMode('pill');
    },
    [userId],
  );
  /** Go to another page of Orbit; the deck waits as a pill that brings the student back to this step. */
  const leave = useCallback(
    (to?: string) => {
      minimize(true);
      // a link that navigates by itself (a person's page) only needs the deck out of the way
      if (to) nav(to);
    },
    [minimize, nav],
  );
  const resume = () => {
    setAway(false);
    setMode('open');
  };

  useDeckFocus(ref, mode === 'open', i);

  const slide = slides[i];
  const next = () => go(i + 1);
  // the pill is kept for a reload of the tab, with the step it is on
  useEffect(() => {
    if (mode !== 'pill' || !user || !slide) return;
    writePill({
      userId: user.id,
      day: localDay(new Date()),
      step: slide.kind,
      sid: slide.kind === 'decide' ? slide.s.id : undefined,
      away,
    });
  }, [mode, away, slide, user]);
  // the keyboard while it is open: ← → move, Enter presses the main button, Esc puts it away as a pill, Tab stays
  // inside
  useDeckKeys(ref, { open: mode === 'open', i, go, onEscape: () => minimize() });

  const swipe = useDeckSwipe(i, go);

  if (!ready || !user || mode === 'hidden' || !deck || !slide) return null;
  const outcomes = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.o]));
  // still to decide: not reached, or skipped (it waits in Drafts too)
  const left = deck.decisions.filter((s) => !results[s.id] || results[s.id]!.o === 'skipped').length;
  if (mode === 'pill')
    return (
      <div
        className="fixed z-40 right-3 bottom-[76px] md:bottom-5 md:right-5 h-11 pl-1 pr-1 rounded-full bg-canvas border border-line shadow-[0_12px_32px_-12px_rgba(0,0,0,0.3)] inline-flex items-center gap-0.5 text-[13px] fade-up"
        data-testid="morning-pill"
      >
        <button
          onClick={resume}
          className="h-9 pl-3 pr-2 rounded-full inline-flex items-center gap-2 hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          data-testid="morning-resume"
          title="Open the morning brief where you left it"
        >
          <Sun size={15} className="text-warn" aria-hidden />
          <span className="font-medium">{away ? 'Back to your morning brief' : 'Morning brief'}</span>
          {left > 0 && <span className="text-ink-3 tabular">{left} left</span>}
        </button>
        <button
          onClick={() => void close()}
          aria-label="Put the morning brief away until tomorrow"
          title="Put it away until tomorrow"
          className="w-8 h-8 rounded-full inline-flex items-center justify-center text-ink-3 hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          data-testid="morning-pill-close"
        >
          <X size={14} />
        </button>
      </div>
    );

  const record = (s: Suggestion, o: MorningOutcome, text?: string, undo?: () => Promise<void>) => {
    setResults((x) => ({ ...x, [s.id]: { o, text } }));
    // skipping is not a decision: the last one can still be taken back
    if (o !== 'skipped') setLast(undo && text ? { sid: s.id, text, undo } : undefined);
  };
  const unrecord = (sid: string) =>
    setResults((x) => {
      const { [sid]: _, ...rest } = x;
      return rest;
    });
  const undoLast = async () => {
    if (!last) return;
    const l = last;
    setLast(undefined);
    try {
      await l.undo();
    } catch {
      // nothing was taken back: the Undo stays offered
      setLast(l);
      toast.push({ text: 'That undo did not go through. Try again.', ttl: 5000 });
      return;
    }
    unrecord(l.sid);
    const at = slides.findIndex((x) => x.kind === 'decide' && x.s.id === l.sid);
    if (at >= 0) go(at);
  };
  const result = slide.kind === 'decide' ? results[slide.s.id] : undefined;
  const summary = morningSummary(deck, outcomes);
  const nextLabel =
    slide.kind === 'overview'
      ? deck.decisions.length
        ? 'Start'
        : 'Next'
      : slide.kind === 'decide' && !result
        ? 'Skip'
        : 'Next';
  return (
    <DeckLayer
      deckRef={ref}
      label="Morning brief"
      testId="morning-brief"
      layerTestId="morning-layer"
      backdropTestId="morning-backdrop"
      step={slide.kind}
      onBackdrop={() => minimize()}
      swipe={swipe}
    >
      <header className="px-4 md:px-5 pt-2.5 md:pt-4 pb-2 flex items-center gap-2">
        <Progress slides={slides} i={i} results={results} />
        <button
          onClick={() => minimize()}
          className="w-8 h-8 rounded-full inline-flex items-center justify-center text-ink-3 hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Minimize. It waits at the bottom of the screen"
          title="Minimize (Esc). It waits at the bottom of the screen"
          data-testid="morning-minimize"
        >
          <Minus size={16} />
        </button>
        <button
          onClick={() => void close()}
          className="w-8 h-8 rounded-full inline-flex items-center justify-center text-ink-3 hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Close the morning brief until tomorrow"
          title="Close until tomorrow"
          data-testid="morning-close"
        >
          <X size={16} />
        </button>
      </header>
      <div className="px-5 md:px-6 pb-4 flex-1 min-h-0 overflow-y-auto scroll-thin" key={i}>
        <div className="fade-up">
          {slide.kind === 'overview' && <Overview deck={deck} onLeave={leave} />}
          {slide.kind === 'decide' && (
            <Decision
              key={slide.s.id}
              s={slide.s}
              user={user}
              index={slide.n}
              total={deck.decisions.length}
              known={deck.people}
              result={result}
              onResolve={(o, text, undo, advance = true) => {
                record(slide.s, o, text, undo);
                if (advance) next();
              }}
              onUnresolve={() => unrecord(slide.s.id)}
              onLeave={leave}
            />
          )}
          {slide.kind === 'moves' && <Moves deck={deck} user={user} onLeave={leave} />}
          {slide.kind === 'done' && (
            <Done
              summary={summary}
              onDrafts={() => {
                void close();
                nav('/inbox');
              }}
              onClose={() => void close()}
            />
          )}
        </div>
      </div>
      <footer className="px-3 md:px-4 py-3 border-t border-line-2 flex items-center gap-2 min-h-[60px]">
        <button
          onClick={() => go(i - 1)}
          disabled={i === 0}
          className="w-9 h-9 shrink-0 rounded-full inline-flex items-center justify-center text-ink-2 hover:bg-canvas-2 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Back"
          title="Back (←)"
          data-testid="morning-back"
        >
          <ChevronLeft size={17} />
        </button>
        {last ? (
          <div className="min-w-0 flex-1 flex items-center gap-1.5 text-[12.5px]" data-testid="morning-last">
            <span className="truncate text-ink-2" title={last.text}>
              {last.text}
            </span>
            <button
              onClick={() => void undoLast()}
              className="shrink-0 inline-flex items-center gap-1 h-7 px-2 rounded-full font-medium text-ink hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              data-testid="morning-undo"
            >
              <Undo2 size={13} /> Undo
            </button>
          </div>
        ) : (
          <span className="flex-1 hidden md:block" aria-hidden />
        )}
        {!last && <span className="flex-1 md:hidden" />}
        {slide.kind !== 'done' && (
          <Button
            size="sm"
            variant={slide.kind === 'decide' && !result ? 'ghost' : 'primary'}
            className="shrink-0"
            onClick={() => {
              if (slide.kind === 'decide' && !result) record(slide.s, 'skipped');
              next();
            }}
            data-testid="morning-next"
            data-primary={slide.kind !== 'decide' || result ? 'true' : undefined}
            title={
              slide.kind === 'decide' && !result ? 'Leave it for now; it stays in Drafts (→)' : 'Next (→)'
            }
          >
            {nextLabel}
            <ChevronRight size={14} />
          </Button>
        )}
      </footer>
    </DeckLayer>
  );
}

/** One segment per step, like stories; a decision's segment shows how it ended. */
function Progress({ slides, i, results }: { slides: Slide[]; i: number; results: Record<string, Result> }) {
  return (
    <div
      className="flex-1 flex gap-1"
      role="progressbar"
      aria-label="Morning brief progress"
      aria-valuemin={1}
      aria-valuemax={slides.length}
      aria-valuenow={i + 1}
      aria-valuetext={`Step ${i + 1} of ${slides.length}`}
      data-testid="morning-progress"
    >
      {slides.map((x, k) => {
        const r = x.kind === 'decide' ? results[x.s.id]?.o : undefined;
        return (
          <span
            key={k}
            data-outcome={r}
            className={cx(
              'h-[3px] flex-1 rounded-full transition-colors',
              r === 'sent' || r === 'done'
                ? 'bg-accent'
                : r === 'later'
                  ? 'bg-warn'
                  : k === i
                    ? 'bg-ink'
                    : k < i
                      ? 'bg-ink-3'
                      : 'bg-line',
            )}
          />
        );
      })}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="rounded-[14px] bg-canvas-2 px-3.5 py-3">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className="text-[22px] leading-tight tracking-[-0.02em] tabular mt-0.5">{value}</div>
      {sub && <div className="text-[11.5px] text-ink-3 mt-0.5">{sub}</div>}
    </div>
  );
}

function Overview({ deck, onLeave }: { deck: MorningDeck; onLeave: (to?: string) => void }) {
  const { stats } = deck;
  return (
    <div data-testid="morning-overview">
      <div className="text-[12.5px] text-ink-3 mt-2">{deck.dateLabel}</div>
      <h2 className="text-[26px] font-normal tracking-[-0.02em] leading-tight mt-0.5">{deck.greeting}</h2>
      <p className="text-[14px] text-ink-2 mt-2" data-testid="morning-headline">
        {deck.headline}
      </p>
      {deck.goal ? (
        <p className="mt-3 text-[13px] leading-[1.5] text-ink-2" data-testid="morning-goal">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3 mr-2">
            Working toward
          </span>
          {deck.goal}
        </p>
      ) : null}
      <div className="mt-5">
        <WeekPaceCard pace={stats.pace} line={stats.paceLine} />
      </div>
      <div className="grid grid-cols-3 gap-2 mt-2">
        <Stat label="Replies, last day" value={stats.replies} />
        <Stat label="Chats today" value={stats.chatsToday} />
        {stats.replyRate === undefined ? (
          <Stat label="Reply rate" value="Not yet" sub="After 3 first messages" />
        ) : (
          <Stat label="Reply rate" value={`${stats.replyRate}%`} sub="Last 30 days" />
        )}
      </div>
      {deck.peopleCount === 0 && (
        <div className="mt-5">
          <Button variant="primary" onClick={() => onLeave('/people')} data-testid="morning-add-people">
            Add people <ArrowUpRight size={14} />
          </Button>
        </div>
      )}
    </div>
  );
}

/** The message a card is about: the reply it answers, the email behind a stage question or an introduction. */
function useEvidence(s: Suggestion) {
  return useLiveQuery(
    () => quotedMessageFor(s),
    [s.kind, s.payload.stageEventId, s.payload.messageId, s.payload.inReplyTo],
  );
}

const shortDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

/** A button as the engine describes it: the main one filled, a page one with its arrow, LinkedIn as a new-tab link. */
/** A small spinner in the button's own colour: the click landed and its work is running. */
function Working() {
  return (
    <span
      className="inline-block w-3.5 h-3.5 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin"
      aria-hidden
    />
  );
}

function ActionButton({
  a,
  busy,
  working,
  onClick,
  href,
}: {
  a: MorningAction;
  busy: boolean;
  /** this is the button that was pressed and its work is running: it shows so at once */
  working?: boolean;
  onClick: () => void;
  href?: string;
}) {
  if (a.effect === 'tab' && href)
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        onClick={onClick}
        title={a.hint}
        data-primary={a.primary ? 'true' : undefined}
        data-effect={a.effect}
        data-testid={`morning-action-${a.id}`}
        className={cx(
          'inline-flex items-center justify-center gap-1.5 h-9 px-4 rounded-full text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25',
          a.primary
            ? 'bg-accent text-[#fdfcfc] hover:bg-accent-2 shadow-[var(--shadow-pill)]'
            : 'bg-canvas text-ink border border-line shadow-[var(--shadow-pill)] hover:bg-canvas-2',
        )}
      >
        {a.label} <ExternalLink size={13} />
      </a>
    );
  return (
    <Button
      variant={a.primary ? 'primary' : a.effect === 'snooze' ? 'ghost' : 'secondary'}
      disabled={busy}
      onClick={onClick}
      title={a.hint}
      data-primary={a.primary ? 'true' : undefined}
      data-effect={a.effect}
      data-testid={`morning-action-${a.id}`}
      aria-busy={working || undefined}
    >
      {working && <Working />}
      {a.label}
      {a.effect === 'page' && <ArrowUpRight size={14} />}
    </Button>
  );
}

function Decision({
  s,
  user,
  index,
  total,
  known,
  result,
  onResolve,
  onUnresolve,
  onLeave,
}: {
  s: Suggestion;
  user: User;
  index: number;
  total: number;
  /** the deck's copy of the people on the card, shown until the live read comes back */
  known: Record<string, Person>;
  result?: Result;
  /** the decision is made: how, the sentence for the footer, how to take it back; `advance` false stays here */
  onResolve: (o: MorningOutcome, text?: string, undo?: () => Promise<void>, advance?: boolean) => void;
  onUnresolve: () => void;
  onLeave: (to?: string) => void;
}) {
  const toast = useToast();
  const { settings } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [composing, setComposing] = useState(false);
  const [askMerge, setAskMerge] = useState(false);
  // the button pressed last, so it shows its work at once while the decision is saved
  const [pressed, setPressed] = useState<MorningActionId>();
  const [openedLinkedIn, setOpenedLinkedIn] = useState(false);
  const person = useLiveQuery(
    () => (s.personId ? db.people.get(s.personId) : undefined),
    [s.personId],
    s.personId ? known[s.personId] : undefined,
  );
  // the second record of a possible duplicate, so both can be seen before deciding
  const otherId = s.kind === 'confirm_merge' ? (s.payload.otherPersonId as string | undefined) : undefined;
  const otherRow = useLiveQuery(
    async () => (otherId ? ((await db.people.get(otherId)) ?? null) : undefined),
    [otherId],
    otherId ? known[otherId] : undefined,
  );
  const other = otherRow ?? undefined;
  const introducerId =
    s.kind === 'confirm_intro' ? (s.payload.introducerId as string | undefined) : undefined;
  const introducer = useLiveQuery(
    () => (introducerId ? db.people.get(introducerId) : undefined),
    [introducerId],
    introducerId ? known[introducerId] : undefined,
  );
  // the card as it is now: a draft written in the deck is on it, not on the deck's copy
  const live = useLiveQuery(async () => (await db.suggestions.get(s.id)) ?? null, [s.id]);
  const draftId = live?.outboundMessageId ?? s.outboundMessageId;
  // settled somewhere else while the deck was open (another card merged the same two people, a pass closed it): it
  // says so instead of showing buttons that have nothing left to act on
  const settled =
    !result &&
    (live === null ||
      live?.status === 'expired' ||
      live?.status === 'dismissed' ||
      (s.kind === 'confirm_merge' && (otherRow === null || (!!otherId && otherId === s.personId))));
  const draft = useLiveQuery(() => (draftId ? db.outbound.get(draftId) : undefined), [draftId]);
  const chat = useLiveQuery(() => (s.chatId ? db.chats.get(s.chatId) : undefined), [s.chatId]);
  const stageEvent = useLiveQuery(
    () =>
      typeof s.payload.stageEventId === 'string' ? db.stageEvents.get(s.payload.stageEventId) : undefined,
    [s.payload.stageEventId],
  );
  const evidence = useEvidence(s);
  const sharedOrgNow =
    useLiveQuery(
      async () =>
        s.kind === 'new_outreach' && person
          ? sharesOrgNow(person, await currentResumeFacets(user.id))
          : false,
      [s.kind, person?.currentOrganizationRaw, user.id],
    ) ?? false;
  // a message approved here and taken back (Undo) is a decision again
  useEffect(() => {
    if (result?.o === 'sent' && draft?.status === 'draft') onUnresolve();
  }, [result?.o, draft?.status, onUnresolve]);

  const meta = KIND_LABEL[s.kind];
  const first = person?.firstName ?? 'them';
  const toStage = (stageEvent?.toStage ?? s.payload.toStage) as keyof typeof STAGE_LABELS | undefined;
  const coldStart =
    s.kind === 'new_outreach' &&
    !s.chatId &&
    !!person &&
    !person.primaryEmail &&
    needsWarmUp(person, 'linkedin', settings?.warmUpEnabled ?? true, sharedOrgNow);
  const actions = decisionActions(s, {
    firstName: person?.firstName,
    hasDraft: !!draft,
    coldStart,
    toStage,
    openedLinkedIn,
  });
  const warmAction = chat?.warmUp?.actions.find((a) => a.id === (s.payload.actionId as string));

  /** Run a decision, keeping what it changes so Undo can put it back (a merge cannot be undone). */
  const decide = async (
    fn: () => Promise<unknown>,
    text: string,
    opts: { o?: MorningOutcome; undoable?: boolean } = {},
  ): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    try {
      const snap = opts.undoable === false ? undefined : await snapshotDecision(user.id, s);
      await fn();
      onResolve(opts.o ?? 'done', text, snap ? () => undoDecision(user.id, snap) : undefined);
      return true;
    } catch {
      setError('That did not go through. Try again, or skip it for now.');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const review = async () => {
    if (!draftId) {
      setBusy(true);
      setError(undefined);
      try {
        await ensureDrafts(user, [s.id]);
        const now = await db.suggestions.get(s.id);
        if (!now?.outboundMessageId) {
          setError(`Orbit could not draft this one. It stays in Drafts for you.`);
          return;
        }
      } finally {
        setBusy(false);
      }
    }
    setComposing(true);
  };
  const run: Record<MorningActionId, () => void> = {
    yes: () =>
      s.kind === 'confirm_intro'
        ? void decide(
            () => answerIntroductionQuestion(user, s.payload.threadId as string, true),
            `Added ${first} to your pipeline${introducer ? `, introduced by ${introducer.firstName}` : ''}.`,
          )
        : void decide(
            () => decideProposedStage(s.payload.stageEventId as string, true),
            toStage ? `Moved ${first} to ${STAGE_LABELS[toStage]}.` : `Moved ${first} on.`,
          ),
    no: () =>
      s.kind === 'confirm_intro'
        ? void decide(
            () => answerIntroductionQuestion(user, s.payload.threadId as string, false),
            'Got it. Orbit will not ask about this thread again.',
          )
        : void decide(
            () => decideProposedStage(s.payload.stageEventId as string, false),
            `Kept ${first} ${chat ? `in ${STAGE_LABELS[chat.stage]}` : 'where they were'}.`,
          ),
    keep: () =>
      void decide(
        () => decideMerge(user.id, s.payload.mergeId as string, false, { suggestionId: s.id }),
        'Kept as two people.',
      ),
    merge: () => setAskMerge(true),
    open_linkedin: () => setOpenedLinkedIn(true),
    warm_done: () =>
      void decide(
        () => markWarmUpAction(user.id, s.chatId!, s.payload.actionId as string, true),
        `Logged the warm-up step for ${first}.`,
      ),
    warm_skip: () =>
      void decide(
        () => markWarmUpAction(user.id, s.chatId!, s.payload.actionId as string, false),
        `Skipped that step for ${first}.`,
      ),
    prep_open: () => {
      void decide(() => markPrepOpened(s.id), `Opened prep for ${first}.`).then(
        (ok) => ok && person && onLeave(`/people/${person.id}?tab=facts&prep=1`),
      );
    },
    prep_done: () => void decide(() => markPrepOpened(s.id), `Marked prep for ${first} done.`),
    item_done: () =>
      void decide(
        () => markActionItemDone(s.payload.actionItemId as string, s.id),
        'Marked the promise kept.',
      ),
    pick_person: () => onLeave(`/notes/new?note=${s.payload.noteId as string}`),
    review: () => void review(),
    start_warm_up: () =>
      void decide(
        () => startWarmUpOrOutreach(user, person!.id, 'linkedin', 'recommendation'),
        `Warm-up started for ${first}. The first step shows in Drafts.`,
      ),
    tomorrow: () =>
      void decide(() => snoozeSuggestion(user.id, s, 1), `Put off until tomorrow.`, { o: 'later' }),
  };
  const approve = async (body: string, subject?: string) => {
    if (!draft) return;
    setBusy(true);
    try {
      const err = await runApproval(user, draft, body, subject, toast, person?.firstName);
      if (!err) onResolve('sent', undefined, undefined, false);
      return err;
    } finally {
      setBusy(false);
    }
  };
  const showEditor = !!draft && (composing || result?.o === 'sent');
  const decided = result && result.o !== 'skipped' && result.o !== 'sent';
  const body = draft ? (draft.bodyFinal ?? draft.bodyDraft) : '';
  const gap = body ? gapLabel(body) : undefined;
  const role = person
    ? [person.currentTitle, person.currentOrganizationRaw].filter(Boolean).join(' at ') || person.headline
    : undefined;

  return (
    <div data-testid="morning-decision" data-kind={s.kind}>
      <div className="flex items-center gap-2 mt-1.5">
        <span
          className="text-[11.5px] uppercase tracking-wide text-ink-3 tabular"
          data-testid="morning-count"
        >
          Decision {index + 1} of {total}
        </span>
        <Chip tone={meta.tone} className="h-5">
          {meta.label}
        </Chip>
      </div>
      <div className="flex items-center gap-3 mt-3">
        {person && <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={44} />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            {person ? (
              <PersonNameLink
                person={person}
                onNavigate={() => onLeave()}
                className="font-medium truncate text-[15px]"
                testId="morning-person-name"
              />
            ) : (
              <span className="font-medium truncate text-[15px]">{meta.label}</span>
            )}
            {person?.linkedinUrl && <LinkedInMark url={person.linkedinUrl} name={person.displayName} />}
            {person && <PersonCompanyLogo person={person} size={14} />}
          </div>
          {role && <div className="text-[12.5px] text-ink-3 truncate">{role}</div>}
        </div>
      </div>
      <p className="text-[14.5px] text-ink mt-3 leading-snug">{s.reasonText}</p>

      {evidence && (
        <blockquote
          className="mt-3 rounded-[12px] bg-canvas-2 px-3 py-2.5 text-[13px] text-ink-2"
          data-testid="morning-evidence"
        >
          <span className="text-ink-3">
            {s.kind === 'confirm_intro'
              ? `${introducer?.firstName ?? 'They'} wrote to you both ${shortDay(evidence.at)}: `
              : `${first} ${wroteWhen(evidence)}: `}
          </span>
          <span className="line-clamp-3">“{evidence.text}”</span>
        </blockquote>
      )}
      {s.kind === 'confirm_merge' && person && other && (
        <div className="mt-3">
          <MergePair a={person} b={other} onNavigate={() => onLeave()} />
        </div>
      )}
      {s.kind === 'warm_up_engage' && warmAction && (
        <p className="mt-3 rounded-[12px] bg-canvas-2 px-3 py-2.5 text-[13px] text-ink-2">
          Step {chat!.warmUp!.actions.indexOf(warmAction) + 1} of {chat!.warmUp!.actions.length}:{' '}
          {warmAction.label}.
        </p>
      )}
      {draft && !showEditor && (
        <button
          type="button"
          onClick={() => run.review()}
          tabIndex={-1}
          className="mt-3 block w-full text-left rounded-[12px] bg-canvas-2 px-3 py-2.5 text-[13px] text-ink-2 hover:bg-line-2"
          data-testid="morning-draft-preview"
          aria-label={`Open the draft to ${first}`}
        >
          {gap && <span className="block text-warn font-medium mb-0.5">Needs one line from you: {gap}</span>}
          {body.trim() ? (
            <span className="line-clamp-4 whitespace-pre-line">{body.replace(/\n{2,}/g, '\n')}</span>
          ) : (
            <span className="text-ink-3">The draft is empty. Open it to write it here.</span>
          )}
        </button>
      )}

      {showEditor && draft && (
        <div className="mt-3" data-testid="morning-composer">
          <DraftEditor
            draft={draft}
            compact
            focusOnOpen
            busy={busy}
            onApprove={approve}
            onCancel={() => setComposing(false)}
            extraActions={
              result?.o === 'sent' ? undefined : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setComposing(false)}
                  data-testid="morning-composer-close"
                >
                  Close
                </Button>
              )
            }
          />
          {result?.o === 'sent' && (
            <p className="mt-2 text-[12px] text-ink-3" data-testid="morning-sent-note">
              Approved. You can still undo it above while it waits; Next moves on.
            </p>
          )}
        </div>
      )}

      {settled ? (
        <div
          className="mt-4 flex items-center gap-2 rounded-[12px] bg-canvas-2 px-3 py-2.5 text-[13px] text-ink-2"
          data-testid="morning-settled"
        >
          <Check size={15} className="shrink-0" />
          <span className="min-w-0">
            {s.kind === 'confirm_merge'
              ? 'Already settled: these two are one record now.'
              : 'Already taken care of.'}
          </span>
        </div>
      ) : decided ? (
        <div
          className="mt-4 flex items-center gap-2 rounded-[12px] bg-accent-soft px-3 py-2.5 text-[13px] text-accent"
          data-testid="morning-resolved"
        >
          <Check size={15} className="shrink-0" />
          <span className="min-w-0">{result.text ?? 'Done.'}</span>
        </div>
      ) : askMerge && person && other ? (
        <div
          className="mt-4 rounded-[12px] border border-line p-3 text-[13px]"
          role="alertdialog"
          aria-label="Confirm merge"
        >
          <p>
            Merge {other.displayName} into {person.displayName}? Their emails, notes and chats are combined
            under {person.displayName}. This cannot be undone.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={busy}
              data-primary="true"
              data-testid="merge-confirm"
              aria-busy={busy || undefined}
              onClick={() =>
                void decide(
                  () => decideMerge(user.id, s.payload.mergeId as string, true, { suggestionId: s.id }),
                  `Merged into ${person.displayName}.`,
                  { undoable: false },
                )
              }
            >
              {busy && <Working />}
              Merge them
            </Button>
            <Button onClick={() => setAskMerge(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        !showEditor && (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-2" data-testid="morning-actions">
              {actions.map((a) => (
                <ActionButton
                  key={a.id}
                  a={a}
                  busy={busy}
                  href={
                    a.id === 'open_linkedin'
                      ? ((s.payload.url as string | undefined) ?? warmAction?.url)
                      : undefined
                  }
                  working={busy && pressed === a.id}
                  onClick={() => {
                    setPressed(a.id);
                    run[a.id]();
                  }}
                />
              ))}
            </div>
          </>
        )
      )}
      {error && (
        <p className="mt-2 text-[12.5px] text-bad" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** One line under "Worth doing today", done right there: a warm-up step, a first message, or prep (its own page). */
function MoveRow({
  m,
  user,
  known,
  onLeave,
}: {
  m: MorningMove;
  user: User;
  known?: Person;
  onLeave: (to?: string) => void;
}) {
  const toast = useToast();
  const person = useLiveQuery(() => db.people.get(m.personId), [m.personId], known);
  // what they do, so a line about someone new says who they are
  const role = person
    ? [person.currentTitle, person.currentOrganizationRaw].filter(Boolean).join(' at ') || person.headline
    : undefined;
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'choice' | 'composing' | 'done'>('idle');
  const [doneText, setDoneText] = useState('');
  const [draftId, setDraftId] = useState<string>();
  const [opened, setOpened] = useState(false);
  const draft = useLiveQuery(() => (draftId ? db.outbound.get(draftId) : undefined), [draftId]);
  const first = person?.firstName ?? 'them';
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      // a failed draft says so, rather than the button going quiet
      toast.push({
        text: e instanceof Error && e.message ? e.message : "That didn't work. Try again.",
        tone: 'bad',
      });
    } finally {
      setBusy(false);
    }
  };
  const write = (opts: { confirmed?: boolean; skipWarmUp?: boolean } = {}) =>
    act(async () => {
      // someone whose LinkedIn Orbit has not read yet: a few seconds for it, so the draft opens on what they do
      // rather than asking the student why them
      if (!role) await roleWithin(user, m.personId, 6000);
      const r = await composeDraft(user, m.personId, 'outreach', opts);
      if (r.kind === 'warmup_choice') setPhase('choice');
      else if (r.kind === 'warmup_started') {
        setDoneText(`Warm-up started for ${first}. The first step shows in Drafts.`);
        setPhase('done');
      } else if (r.kind === 'draft') {
        setDraftId(r.draft.id);
        setPhase('composing');
      }
    });
  const approve = async (d: OutboundMessage, body: string, subject?: string) => {
    setBusy(true);
    try {
      return await runApproval(user, d, body, subject, toast, person?.firstName);
    } finally {
      setBusy(false);
    }
  };
  let button: ReactNode = null;
  if (phase === 'idle' || phase === 'choice') {
    if (m.kind === 'prep')
      button = (
        <Button
          size="sm"
          onClick={() => onLeave(m.href)}
          title="Opens their prep page. This brief waits at the bottom of the screen"
          data-testid="morning-move-action"
          data-effect="page"
        >
          Open prep <ArrowUpRight size={13} />
        </Button>
      );
    else if (m.kind === 'warm_up')
      button = opened ? (
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          data-testid="morning-move-done"
          onClick={() =>
            act(async () => {
              await markWarmUpAction(user.id, m.chatId!, m.actionId!, true);
              setDoneText('Logged. The next step shows on its day.');
              setPhase('done');
            })
          }
        >
          <Check size={13} /> Mark done
        </Button>
      ) : (
        <a
          href={m.url}
          target="_blank"
          rel="noreferrer noopener"
          onClick={() => setOpened(true)}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[13px] font-medium bg-canvas text-ink border border-line shadow-[var(--shadow-pill)] hover:bg-canvas-2"
          title="Opens LinkedIn in a new tab. This stays open"
          data-testid="morning-move-action"
          data-effect="tab"
        >
          Open LinkedIn <ExternalLink size={12} />
        </a>
      );
    else if (phase === 'idle')
      button = (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => void write()}
          data-testid="morning-move-action"
          data-effect="compose"
          title="Orbit drafts it here. Nothing is sent until you approve it"
        >
          {busy ? 'Drafting' : 'Write'}
        </Button>
      );
  }
  return (
    <li className="py-3" data-testid="morning-move" data-kind={m.kind}>
      <div className="flex items-center gap-3">
        {person ? (
          <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={36} />
        ) : (
          <span className="w-9 h-9 rounded-full bg-canvas-2" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-medium line-clamp-2">
            {person ? (
              <>
                {m.text.replace(new RegExp(`${escapeRe(person.firstName)}$`), '')}
                <PersonNameLink
                  person={{ ...person, displayName: person.firstName }}
                  onNavigate={() => onLeave()}
                  testId="morning-move-name"
                />
              </>
            ) : (
              m.text
            )}
          </span>
          {role && (
            <span className="block text-[12.5px] text-ink-2 truncate" data-testid="morning-move-role">
              {role}
            </span>
          )}
          {m.sub && <span className="block text-[12px] text-ink-3 truncate">{m.sub}</span>}
        </span>
        {phase === 'done' ? (
          <Check size={16} className="text-accent shrink-0" aria-label="Done" />
        ) : (
          <span className="shrink-0">{button}</span>
        )}
      </div>
      {phase === 'choice' && (
        <div
          className="mt-2 ml-12 rounded-[12px] bg-canvas-2 p-3 text-[12.5px]"
          data-testid="morning-move-choice"
        >
          <p className="text-ink-2">
            You only have {first} on LinkedIn and have never talked, so Orbit suggests a short warm-up before
            your first message.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await startWarmUpOrOutreach(
                    user,
                    m.personId,
                    'linkedin',
                    m.kind === 'reach_out' ? 'recommendation' : 'manual',
                  );
                  setDoneText(`Warm-up started for ${first}. The first step shows in Drafts.`);
                  setPhase('done');
                })
              }
            >
              Start warm-up
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void write({ confirmed: true, skipWarmUp: true })}
            >
              Write now instead
            </Button>
          </div>
        </div>
      )}
      {phase === 'composing' && draft && (
        <div className="mt-2.5" data-testid="morning-move-composer">
          <DraftEditor
            draft={draft}
            compact
            focusOnOpen
            busy={busy}
            onApprove={(b, subj) => approve(draft, b, subj)}
            onCancel={() => setPhase('idle')}
            extraActions={
              <Button size="sm" variant="ghost" onClick={() => setPhase('idle')}>
                Close
              </Button>
            }
          />
        </div>
      )}
      {phase === 'done' && <p className="mt-1.5 ml-12 text-[12.5px] text-accent">{doneText}</p>}
    </li>
  );
}

/**
 * Give a LinkedIn read of someone up to `ms` before drafting to them, so the draft can say what they do. Nothing to
 * wait for (no LinkedIn connected, the sample student, a read already under way) returns at once.
 */
async function roleWithin(user: User, personId: string, ms: number): Promise<void> {
  await Promise.race([
    runEnrichment(user, { only: [personId], reason: 'view' }).catch(() => undefined),
    new Promise((r) => setTimeout(r, ms)),
  ]);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function Moves({ deck, user, onLeave }: { deck: MorningDeck; user: User; onLeave: (to?: string) => void }) {
  return (
    <div data-testid="morning-moves">
      <div className="text-[11.5px] uppercase tracking-wide text-ink-3 mt-1.5">Worth doing today</div>
      <ul className="mt-2 divide-y divide-line-2">
        {deck.moves.map((m) => (
          <MoveRow key={m.id} m={m} user={user} known={deck.people[m.personId]} onLeave={onLeave} />
        ))}
      </ul>
    </div>
  );
}

function Done({
  summary,
  onDrafts,
  onClose,
}: {
  summary: ReturnType<typeof morningSummary>;
  onDrafts: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col items-center text-center pt-10" data-testid="morning-done">
      <span className="w-12 h-12 rounded-full bg-accent-soft text-accent inline-flex items-center justify-center">
        <Check size={22} />
      </span>
      <h2 className="text-[22px] font-normal tracking-[-0.02em] mt-3">You're set for today</h2>
      {summary.lines.length > 0 && (
        <ul className="mt-3 flex flex-wrap justify-center gap-1.5" data-testid="morning-summary">
          {summary.lines.map((l) => (
            <li
              key={l}
              className="rounded-full bg-canvas-2 px-3 h-7 inline-flex items-center text-[12.5px] text-ink-2"
            >
              {l}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[13.5px] text-ink-3 mt-3 max-w-[320px]" data-testid="morning-rest">
        {summary.rest}
      </p>
      <div className="mt-6 flex gap-2">
        {summary.waitingInDrafts > 0 && (
          <Button
            onClick={onDrafts}
            data-testid="morning-drafts"
            title="Opens Drafts and puts this brief away"
          >
            Open Drafts <ArrowUpRight size={14} />
          </Button>
        )}
        <Button variant="primary" onClick={onClose} data-testid="morning-finish" data-primary="true">
          Close
        </Button>
      </div>
    </div>
  );
}
