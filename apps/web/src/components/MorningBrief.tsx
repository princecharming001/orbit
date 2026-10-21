import type { Suggestion, User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowRight, Check, ChevronLeft, ChevronRight, ExternalLink, Minus, Sun, X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { db } from '../db/schema';
import { markWarmUpAction } from '../engine/brief';
import { answerIntroductionQuestion } from '../engine/introductions';
import { type MorningDeck, markMorningSeen, morningDeck, morningDue } from '../engine/morning';
import { decideMerge } from '../engine/people';
import { snoozeSuggestion } from '../engine/send';
import { decideProposedStage } from '../engine/stages';
import { useSession } from '../state/session';
import { Avatar, Button, Chip, cx } from '../ui';
import { PersonCompanyLogo } from './CompanyLogo';
import { KIND_LABEL } from './SuggestionCard';

/** Anything can open the debrief again (Settings, the command palette): `openMorningBrief()`. */
export const MORNING_EVENT = 'orbit:morning-brief';
export function openMorningBrief(): void {
  window.dispatchEvent(new Event(MORNING_EVENT));
}

type Slide = { kind: 'overview' } | { kind: 'decide'; s: Suggestion } | { kind: 'moves' } | { kind: 'done' };
type Outcome = 'done' | 'later' | 'skipped';

/**
 * The morning debrief: a small deck in the corner, once a day after the brief time. Click, swipe or use the arrow keys
 * to move through it: the day in numbers, each decision on its own with its buttons, what is worth doing today, and
 * a last word. Closing it (or reaching the end) puts it away until tomorrow; the dash keeps it as a pill to come back
 * to.
 */
export function MorningBrief() {
  const { user, userId } = useSession();
  const settings = useLiveQuery(() => (userId ? db.settings.get(userId) : undefined), [userId]);
  const { pathname } = useLocation();
  const [mode, setMode] = useState<'hidden' | 'open' | 'pill'>('hidden');
  const [deck, setDeck] = useState<MorningDeck>();
  const [i, setI] = useState(0);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const ready = !!user?.onboardingCompletedAt && !pathname.startsWith('/onboarding');
  // put away once in this visit: it never comes back by itself before tomorrow, even before the saved day loads
  const putAway = useRef(false);

  const open = useCallback(async () => {
    if (!user) return;
    setDeck(await morningDeck(user));
    setI(0);
    setOutcomes({});
    setMode('open');
  }, [user]);

  // once a day, after the brief time: checked on load and every few minutes while the app is open
  useEffect(() => {
    if (!ready || mode !== 'hidden' || !settings || putAway.current) return;
    // a browser driven by tests only gets it when the test asks (`__ORBIT_MORNING__`), so it covers nothing else
    const g = globalThis as { __ORBIT_MORNING__?: unknown };
    const automated = typeof navigator !== 'undefined' && navigator.webdriver && g.__ORBIT_MORNING__ !== 'on';
    if (automated) return;
    const check = () => {
      if (morningDue(settings, new Date())) void open();
    };
    check();
    const t = setInterval(check, 5 * 60_000);
    return () => clearInterval(t);
  }, [ready, mode, settings, open]);

  useEffect(() => {
    const onAsk = () => void open();
    window.addEventListener(MORNING_EVENT, onAsk);
    return () => window.removeEventListener(MORNING_EVENT, onAsk);
  }, [open]);

  const slides: Slide[] = deck
    ? [
        { kind: 'overview' },
        ...deck.decisions.map((s) => ({ kind: 'decide' as const, s })),
        ...(deck.moves.length ? [{ kind: 'moves' as const }] : []),
        { kind: 'done' },
      ]
    : [];
  const go = useCallback((to: number) => setI(Math.max(0, Math.min(slides.length - 1, to))), [slides.length]);
  // the day is saved before the card goes, so leaving the page right after never loses it
  const close = useCallback(async () => {
    putAway.current = true;
    if (userId) await markMorningSeen(userId).catch(() => undefined);
    setMode('hidden');
  }, [userId]);
  const minimize = () => {
    putAway.current = true;
    if (userId) void markMorningSeen(userId);
    setMode('pill');
  };

  // the arrow keys move through it while it is open, unless the student is typing somewhere
  useEffect(() => {
    if (mode !== 'open') return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (e.key === 'ArrowRight') go(i + 1);
      else if (e.key === 'ArrowLeft') go(i - 1);
      else if (e.key === 'Escape') minimize();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // a swipe sideways on a phone (or a drag with the mouse) moves a slide
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const onPointerDown = (e: React.PointerEvent) => {
    start.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = start.current;
    start.current = undefined;
    if (!s) return;
    const dx = e.clientX - s.x;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.clientY - s.y) * 1.5) go(i + (dx < 0 ? 1 : -1));
  };

  if (!ready || !user || mode === 'hidden') return null;
  const left = deck ? deck.decisions.filter((s) => !outcomes[s.id]).length : 0;
  if (mode === 'pill')
    return (
      <button
        onClick={() => setMode('open')}
        className="fixed z-40 right-4 bottom-20 md:bottom-5 h-10 pl-3 pr-2 rounded-full glass glass-strong border border-line shadow-[var(--shadow-card)] inline-flex items-center gap-2 text-[13px] pop-in"
        data-testid="morning-pill"
      >
        <Sun size={15} className="text-warn" />
        Morning brief{left ? ` · ${left} to decide` : ''}
        <span
          role="button"
          tabIndex={0}
          aria-label="Put the morning brief away until tomorrow"
          onClick={(e) => {
            e.stopPropagation();
            void close();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.stopPropagation();
              void close();
            }
          }}
          className="w-6 h-6 rounded-full inline-flex items-center justify-center text-ink-3 hover:bg-canvas-2"
        >
          <X size={13} />
        </span>
      </button>
    );
  if (!deck) return null;
  const slide = slides[i]!;
  const decide = (s: Suggestion, o: Outcome) => {
    setOutcomes((x) => ({ ...x, [s.id]: o }));
    go(i + 1);
  };
  const decidedCount = Object.values(outcomes).filter((o) => o === 'done').length;
  return (
    <section
      role="dialog"
      aria-label="Morning brief"
      className={cx(
        'fixed z-40 pop-in flex flex-col bg-canvas border border-line rounded-[20px] shadow-[0_24px_60px_-20px_rgba(0,0,0,0.25)]',
        'inset-x-2 bottom-[72px] md:inset-x-auto md:right-5 md:bottom-5 md:w-[380px]',
        'max-h-[min(560px,calc(100dvh-96px))]',
      )}
      data-testid="morning-brief"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <header className="px-4 pt-3 pb-2 flex items-center gap-2">
        {/* one segment per slide, like stories: where you are and how much is left */}
        <div className="flex-1 flex gap-1" aria-hidden>
          {slides.map((_, k) => (
            <span
              key={k}
              className={cx('h-[3px] flex-1 rounded-full transition-colors', k <= i ? 'bg-ink' : 'bg-line')}
            />
          ))}
        </div>
        <button
          onClick={minimize}
          className="w-7 h-7 rounded-full inline-flex items-center justify-center text-ink-3 hover:bg-canvas-2"
          aria-label="Keep it for later"
          title="Keep it for later"
        >
          <Minus size={15} />
        </button>
        <button
          onClick={close}
          className="w-7 h-7 rounded-full inline-flex items-center justify-center text-ink-3 hover:bg-canvas-2"
          aria-label="Close the morning brief until tomorrow"
          title="Close until tomorrow"
          data-testid="morning-close"
        >
          <X size={15} />
        </button>
      </header>
      <div className="px-5 pb-2 flex-1 min-h-[300px] overflow-y-auto scroll-thin select-none" key={i}>
        <div className="fade-up">
          {slide.kind === 'overview' && <Overview deck={deck} />}
          {slide.kind === 'decide' && (
            <Decision
              key={slide.s.id}
              s={slide.s}
              user={user}
              index={deck.decisions.indexOf(slide.s)}
              total={deck.decisions.length}
              onOutcome={(o) => decide(slide.s, o)}
              onOpen={minimize}
            />
          )}
          {slide.kind === 'moves' && <Moves deck={deck} onGo={minimize} />}
          {slide.kind === 'done' && (
            <Done
              decided={decidedCount}
              later={deck.decisions.filter((s) => outcomes[s.id] !== 'done').length + deck.moreInDrafts}
              onClose={close}
            />
          )}
        </div>
      </div>
      <footer className="px-4 py-3 border-t border-line-2 flex items-center gap-2">
        <button
          onClick={() => go(i - 1)}
          disabled={i === 0}
          className="w-8 h-8 rounded-full inline-flex items-center justify-center text-ink-2 hover:bg-canvas-2 disabled:opacity-30"
          aria-label="Back"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="text-[12px] text-ink-3 tabular">
          {i + 1} / {slides.length}
        </span>
        {slide.kind !== 'done' && (
          <Button
            size="sm"
            variant={slide.kind === 'decide' ? 'ghost' : 'primary'}
            className="ml-auto"
            onClick={() => (slide.kind === 'decide' ? decide(slide.s, 'skipped') : go(i + 1))}
            data-testid="morning-next"
          >
            {slide.kind === 'overview'
              ? deck.decisions.length
                ? 'Start'
                : 'Next'
              : slide.kind === 'decide'
                ? 'Skip'
                : 'Next'}
            <ChevronRight size={14} />
          </Button>
        )}
      </footer>
    </section>
  );
}

function Stat({ label, value, bar }: { label: string; value: ReactNode; bar?: number }) {
  return (
    <div className="rounded-[14px] bg-canvas-2 px-3 py-2.5">
      <div className="text-[11.5px] text-ink-3">{label}</div>
      <div className="text-[22px] leading-tight tracking-[-0.02em] tabular mt-0.5">{value}</div>
      {bar !== undefined && (
        <div className="mt-1.5 h-1 rounded-full bg-line overflow-hidden">
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${Math.round(Math.min(1, bar) * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function Overview({ deck }: { deck: MorningDeck }) {
  const { stats } = deck;
  return (
    <div data-testid="morning-overview">
      <div className="text-[12px] text-ink-3 mt-1">{deck.dateLabel}</div>
      <h2 className="text-[24px] font-normal tracking-[-0.02em] leading-tight mt-0.5">{deck.greeting}</h2>
      <p className="text-[13.5px] text-ink-2 mt-1.5">{deck.headline}</p>
      <div className="grid grid-cols-2 gap-2 mt-4">
        <Stat
          label="First messages this week"
          value={
            <>
              {stats.sentThisWeek}
              <span className="text-[14px] text-ink-3"> / {stats.weeklyTarget}</span>
            </>
          }
          bar={stats.weeklyTarget ? stats.sentThisWeek / stats.weeklyTarget : 0}
        />
        <Stat label="Replies since yesterday" value={stats.replies} />
        <Stat label="Chats today" value={stats.chatsToday} />
        <Stat
          label="Reply rate, 30 days"
          value={stats.replyRate === undefined ? '—' : `${stats.replyRate}%`}
        />
      </div>
    </div>
  );
}

function Decision({
  s,
  user,
  index,
  total,
  onOutcome,
  onOpen,
}: {
  s: Suggestion;
  user: User;
  index: number;
  total: number;
  onOutcome: (o: Outcome) => void;
  onOpen: () => void;
}) {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const person = useLiveQuery(() => (s.personId ? db.people.get(s.personId) : undefined), [s.personId]);
  const draft = useLiveQuery(
    () => (s.outboundMessageId ? db.outbound.get(s.outboundMessageId) : undefined),
    [s.outboundMessageId],
  );
  const meta = KIND_LABEL[s.kind];
  const run = async (fn: () => Promise<unknown>, o: Outcome = 'done') => {
    setBusy(true);
    try {
      await fn();
      onOutcome(o);
    } finally {
      setBusy(false);
    }
  };
  const openCard = () => {
    onOpen();
    nav(`/inbox?card=${s.id}`);
  };
  const body = draft ? (draft.bodyFinal ?? draft.bodyDraft) : '';
  let actions: ReactNode;
  if (s.kind === 'confirm_stage')
    actions = (
      <>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => run(() => decideProposedStage(s.payload.stageEventId as string, true))}
        >
          Yes
        </Button>
        <Button
          disabled={busy}
          onClick={() => run(() => decideProposedStage(s.payload.stageEventId as string, false))}
        >
          No
        </Button>
      </>
    );
  else if (s.kind === 'confirm_merge')
    actions = (
      <>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() =>
            run(() => decideMerge(user.id, s.payload.mergeId as string, true, { suggestionId: s.id }))
          }
        >
          Same person
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            run(() => decideMerge(user.id, s.payload.mergeId as string, false, { suggestionId: s.id }))
          }
        >
          Keep both
        </Button>
      </>
    );
  else if (s.kind === 'confirm_intro')
    actions = (
      <>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => run(() => answerIntroductionQuestion(user, s.payload.threadId as string, true))}
        >
          Yes
        </Button>
        <Button
          disabled={busy}
          onClick={() => run(() => answerIntroductionQuestion(user, s.payload.threadId as string, false))}
        >
          No
        </Button>
      </>
    );
  else if (s.kind === 'warm_up_engage' && s.chatId)
    actions = (
      <>
        <a
          href={s.payload.url as string}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-accent text-white text-[14px] font-medium hover:bg-accent-2"
        >
          Open LinkedIn <ExternalLink size={13} />
        </a>
        <Button
          disabled={busy}
          onClick={() => run(() => markWarmUpAction(user.id, s.chatId!, s.payload.actionId as string, true))}
        >
          <Check size={14} /> Done
        </Button>
      </>
    );
  else
    actions = (
      <>
        <Button variant="primary" onClick={openCard} data-testid="morning-open">
          {draft ? 'Review and send' : 'Open'} <ArrowRight size={14} />
        </Button>
        <Button disabled={busy} onClick={() => run(() => snoozeSuggestion(user.id, s, 1), 'later')}>
          Tomorrow
        </Button>
      </>
    );
  return (
    <div data-testid="morning-decision">
      <div className="text-[11.5px] uppercase tracking-wide text-ink-3 mt-1">
        Decision {index + 1} of {total}
      </div>
      <div className="flex items-center gap-3 mt-3">
        {person && <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={40} />}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-medium truncate">{person?.displayName ?? meta.label}</span>
            {person && <PersonCompanyLogo person={person} size={14} />}
          </div>
          <Chip tone={meta.tone} className="h-5 mt-0.5">
            {meta.label}
          </Chip>
        </div>
      </div>
      <p className="text-[14px] text-ink mt-3 leading-snug">{s.reasonText}</p>
      {body && (
        <p className="mt-3 rounded-[12px] bg-canvas-2 px-3 py-2.5 text-[13px] text-ink-2 line-clamp-4 whitespace-pre-line">
          {body.replace(/\n{2,}/g, '\n')}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

function Moves({ deck, onGo }: { deck: MorningDeck; onGo: () => void }) {
  const people = useLiveQuery(
    () => db.people.bulkGet(deck.moves.map((m) => m.personId ?? '')),
    [deck.moves.map((m) => m.id).join()],
  );
  return (
    <div data-testid="morning-moves">
      <div className="text-[11.5px] uppercase tracking-wide text-ink-3 mt-1">Worth doing today</div>
      <ul className="mt-3 divide-y divide-line-2">
        {deck.moves.map((m, k) => {
          const p = people?.[k];
          return (
            <li key={m.id}>
              <Link to={m.href} onClick={onGo} className="flex items-center gap-3 py-2.5 group">
                {p ? (
                  <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={32} />
                ) : (
                  <span className="w-8 h-8 rounded-full bg-canvas-2" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium truncate group-hover:underline">
                    {m.text}
                  </span>
                  {m.sub && <span className="block text-[12px] text-ink-3 truncate">{m.sub}</span>}
                </span>
                <ChevronRight size={15} className="text-ink-3 shrink-0" />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Done({ decided, later, onClose }: { decided: number; later: number; onClose: () => void }) {
  return (
    <div className="flex flex-col items-center text-center pt-8" data-testid="morning-done">
      <span className="w-12 h-12 rounded-full bg-accent-soft text-accent inline-flex items-center justify-center">
        <Check size={22} />
      </span>
      <h2 className="text-[20px] font-normal tracking-[-0.02em] mt-3">You're set for today</h2>
      <p className="text-[13px] text-ink-3 mt-1.5 max-w-[260px]">
        {decided ? `${decided} decided. ` : ''}
        {later
          ? `${later} more wait${later === 1 ? 's' : ''} in Drafts whenever you are ready.`
          : 'Nothing else is waiting on you.'}
      </p>
      <div className="mt-5 flex gap-2">
        {later > 0 && (
          <Link to="/inbox" onClick={onClose}>
            <Button variant="primary">Open Drafts</Button>
          </Link>
        )}
        <Button onClick={onClose} data-testid="morning-finish">
          Close
        </Button>
      </div>
    </div>
  );
}
