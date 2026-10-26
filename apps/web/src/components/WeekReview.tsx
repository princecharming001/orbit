/**
 * The weekly review (plan 23 §4.8), on the deck the morning brief and prep share (ui/Deck.tsx): four cards, phone
 * first. Your week, who moved, what waits on you (the nudges and thank-yous to approve right there), and next week.
 * It opens by itself from Sunday at 5 pm (or the first open after), once; Drafts keeps "Last week's review" until the
 * next one.
 */
import type { OutboundMessage, Suggestion } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../db/schema';
import { markActionItemDone } from '../engine/facts';
import { useFlag } from '../engine/flags';
import { SUGGESTION_KIND_LABELS } from '../engine/today';
import {
  buildWeekReview,
  type Named,
  reviewSunday,
  storeWeekReview,
  type WeekReview,
  weekReviewDue,
} from '../engine/weekReview';
import { useSession } from '../state/session';
import { Avatar, Button, cx, useToast } from '../ui';
import { DeckLayer, DeckProgress, useDeckFocus, useDeckKeys, useDeckSwipe } from '../ui/Deck';
import { runApproval } from './approve';

const CARDS = ['week', 'moved', 'waiting', 'next'] as const;
type CardKind = (typeof CARDS)[number];
const TITLES: Record<CardKind, string> = {
  week: 'Your week',
  moved: 'Who moved',
  waiting: 'Waiting on you',
  next: 'Next week',
};
const OPEN_EVENT = 'orbit:week-review';
const POSITION_KEY = 'orbit.weekReview.card';

/** Open the review from anywhere (Drafts, the palette). */
export function openWeekReview(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** Mounted once in the shell: opens the review when it is due, or when asked. */
export function WeekReviewLauncher() {
  const { user, settings } = useSession();
  const on = useFlag('weekReview');
  const [open, setOpen] = useState(false);
  // closed once in this visit: it never opens again by itself until the next load (the settings row catches up later)
  const closed = useRef(false);
  const firstBrief = useLiveQuery(
    async () =>
      user
        ? ((await db.briefs.where('userId').equals(user.id).toArray()).sort((a, b) =>
            a.generatedAt.localeCompare(b.generatedAt),
          )[0]?.generatedAt ?? null)
        : null,
    [user?.id],
  );
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, []);
  useEffect(() => {
    if (!on || !user?.onboardingCompletedAt || open || closed.current || firstBrief === undefined) return;
    // a browser driven by tests only gets it when the test asks, so it covers nothing else
    const g = globalThis as { __ORBIT_REVIEW__?: unknown };
    if (typeof navigator !== 'undefined' && navigator.webdriver && g.__ORBIT_REVIEW__ !== 'on') return;
    const check = () => {
      // nothing to show while the tab is hidden: checked again as soon as it is shown
      if (document.hidden) return;
      // never over another deck (the morning brief, prep): it waits its turn
      if (document.querySelector('[role="dialog"]')) return;
      if (weekReviewDue(settings, firstBrief ?? undefined, new Date(), user.timezone || 'UTC')) setOpen(true);
    };
    check();
    const t = setInterval(check, 5 * 60_000);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', check);
    };
  }, [on, user?.id, settings?.weekReviewSeenOn, firstBrief, open]);
  if (!open || !user) return null;
  const close = () => {
    closed.current = true;
    setOpen(false);
    const sunday = reviewSunday(new Date(), user.timezone || 'UTC');
    void db.settings.update(user.id, { weekReviewSeenOn: sunday });
    void storeWeekReview(user).catch(() => undefined);
  };
  return <WeekReviewDeck onClose={close} />;
}

export function WeekReviewDeck({ onClose }: { onClose: () => void }) {
  const { user } = useSession();
  const review = useLiveQuery(() => (user ? buildWeekReview(user) : undefined), [user?.id]);
  const [kind, setKind] = useState<CardKind>(() => {
    try {
      const saved = sessionStorage.getItem(POSITION_KEY) as CardKind | null;
      return saved && CARDS.includes(saved) ? saved : 'week';
    } catch {
      return 'week';
    }
  });
  const at = CARDS.indexOf(kind);
  const go = useCallback((to: number) => {
    const next = CARDS[Math.max(0, Math.min(CARDS.length - 1, to))]!;
    setKind(next);
    try {
      sessionStorage.setItem(POSITION_KEY, next);
    } catch {
      // storage blocked: the position lasts for this deck only
    }
  }, []);
  const ref = useRef<HTMLElement>(null);
  useDeckKeys(ref, { open: true, i: at, go, onEscape: onClose });
  useDeckFocus(ref, true, at);
  const swipe = useDeckSwipe(at, go);
  const isLast = at === CARDS.length - 1;
  return (
    <DeckLayer
      deckRef={ref}
      label="Your week in review"
      testId="week-review"
      step={kind}
      onBackdrop={onClose}
      swipe={swipe}
    >
      <header className="px-4 md:px-5 pt-2.5 md:pt-4 pb-2 flex items-center gap-2">
        <DeckProgress count={CARDS.length} i={at} label="Review progress" testId="week-review-progress" />
        <span className="text-[12px] text-ink-3 tabular shrink-0">
          {at + 1} of {CARDS.length}
        </span>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-full inline-flex items-center justify-center text-ink-3 hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Close the review"
          title="Close (Esc)"
          data-testid="week-review-close"
        >
          <X size={16} />
        </button>
      </header>
      <div className="px-5 md:px-6 pb-4 flex-1 min-h-0 overflow-y-auto scroll-thin" key={kind}>
        {!review ? (
          <p className="text-[13px] text-ink-3 pt-6">Adding up your week…</p>
        ) : (
          <div className="fade-up">
            <h2
              className="text-[22px] leading-tight font-medium tracking-[-0.01em]"
              data-testid="week-review-title"
            >
              {TITLES[kind]}
            </h2>
            {kind === 'week' && <WeekCard r={review} />}
            {kind === 'moved' && <MovedCard r={review} />}
            {kind === 'waiting' && <WaitingCard r={review} />}
            {kind === 'next' && <NextCard r={review} onClose={onClose} />}
          </div>
        )}
      </div>
      <footer className="px-3 md:px-4 py-3 border-t border-line-2 flex items-center gap-2 min-h-[60px]">
        <button
          onClick={() => go(at - 1)}
          disabled={at === 0}
          className="w-9 h-9 shrink-0 rounded-full inline-flex items-center justify-center text-ink-2 hover:bg-canvas-2 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Back"
          title="Back (←)"
        >
          <ChevronLeft size={17} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-3 hidden md:block" aria-hidden>
          ← → to move · Esc to close
        </span>
        <span className="flex-1 md:hidden" />
        <Button
          size="sm"
          variant="primary"
          className="shrink-0"
          onClick={() => (isLast ? onClose() : go(at + 1))}
          data-primary="true"
          data-testid="week-review-next"
        >
          {isLast ? 'Done' : 'Next'}
          {!isLast && <ChevronRight size={14} />}
        </Button>
      </footer>
    </DeckLayer>
  );
}

/** A number with the names behind it on tap. */
function Count({ label, people, testId }: { label: string; people: Named[]; testId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <li data-testid={testId}>
      <button
        type="button"
        className={cx(
          'w-full flex items-baseline gap-2 text-left py-2',
          people.length > 0 && 'hover:text-ink',
        )}
        onClick={() => setOpen((o) => !o)}
        disabled={!people.length}
        aria-expanded={open}
      >
        <span className="text-[28px] tabular leading-none w-12">{people.length}</span>
        <span className="text-[14px] text-ink-2">{label}</span>
      </button>
      {open && <p className="pl-14 pb-2 text-[13px] text-ink-3">{people.map((p) => p.name).join(', ')}</p>}
    </li>
  );
}

function WeekCard({ r }: { r: WeekReview }) {
  if (r.empty)
    return (
      <p className="mt-3 text-[15px] text-ink-2" data-testid="week-review-empty">
        {r.headline}.
      </p>
    );
  return (
    <>
      <p className="mt-1.5 text-[14px] text-ink-2" data-testid="week-review-headline">
        {r.headline}
      </p>
      <ul className="mt-3 divide-y divide-line-2">
        <Count label="reached" people={r.reached} testId="week-review-reached" />
        <Count label="replied" people={r.replied} testId="week-review-replied" />
        <Count
          label={r.booked.length === 1 ? 'chat booked' : 'chats booked'}
          people={r.booked}
          testId="week-review-booked"
        />
        <Count label="went quiet" people={r.quiet} testId="week-review-quiet" />
      </ul>
      {r.sentForYou > 0 && (
        <p className="mt-3 text-[13px] text-ink-2" data-testid="week-review-sent-for-you">
          Orbit sent {r.sentForYou} for you, the kinds you handed over.
        </p>
      )}
      <p className="mt-3 text-[13px] text-ink-3" data-testid="week-review-target">
        Your target is {r.target} first {r.target === 1 ? 'message' : 'messages'} a week, and you sent{' '}
        {r.reached.length}.
      </p>
    </>
  );
}

function MovedCard({ r }: { r: WeekReview }) {
  if (!r.moved.length) return <p className="mt-3 text-[14px] text-ink-2">Nobody moved this week.</p>;
  return (
    <ul className="mt-3 space-y-2.5" data-testid="week-review-moved">
      {r.moved.map((m) => (
        <li key={m.personId} className="flex items-center gap-2.5 text-[14px]">
          <Avatar name={m.name} id={m.personId} size={26} />
          <Link to={`/people/${m.personId}`} className="hover:underline">
            {m.text}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function WaitingCard({ r }: { r: WeekReview }) {
  const cards = useLiveQuery(async () => {
    const ss = (await db.suggestions.bulkGet(r.waiting.suggestionIds)).filter((s): s is Suggestion => !!s);
    const out: { s: Suggestion; draft?: OutboundMessage; name: string }[] = [];
    for (const s of ss) {
      const draft = s.outboundMessageId ? await db.outbound.get(s.outboundMessageId) : undefined;
      const p = s.personId ? await db.people.get(s.personId) : undefined;
      out.push({ s, draft, name: p?.firstName ?? 'them' });
    }
    return out;
  }, [r.waiting.suggestionIds.join()]);
  const overdue = r.waiting.overdue;
  if (!cards) return null;
  if (!cards.length && !overdue.length)
    return <p className="mt-3 text-[14px] text-ink-2">Nothing is waiting on you. You are caught up.</p>;
  return (
    <ul className="mt-3 divide-y divide-line-2" data-testid="week-review-waiting">
      {cards.map((c) => (
        <WaitingRow key={c.s.id} s={c.s} draft={c.draft} name={c.name} />
      ))}
      {overdue.map((a) => (
        <OverdueRow key={a.id} id={a.id} text={a.text} />
      ))}
    </ul>
  );
}

function WaitingRow({ s, draft, name }: { s: Suggestion; draft?: OutboundMessage; name: string }) {
  const { user } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const sent = !!draft && draft.status !== 'draft';
  return (
    <li className="py-2.5" data-testid="week-review-waiting-row">
      <div className="flex items-center gap-2">
        <span className="text-[13.5px] min-w-0 flex-1">
          <span className="font-medium">{SUGGESTION_KIND_LABELS[s.kind].label}</span>
          <span className="text-ink-3"> · {s.reasonText}</span>
        </span>
        {draft && user && (
          <Button
            size="sm"
            variant={sent ? 'secondary' : 'primary'}
            disabled={busy || sent}
            onClick={async () => {
              setBusy(true);
              setError(
                await runApproval(
                  user,
                  draft,
                  draft.bodyFinal ?? draft.bodyDraft,
                  draft.subject,
                  toast,
                  name,
                ),
              );
              setBusy(false);
            }}
            data-testid="week-review-approve"
          >
            {sent ? 'Approved' : 'Approve'}
          </Button>
        )}
      </div>
      {draft && (
        <p className="mt-1 text-[12.5px] text-ink-3 line-clamp-2">{draft.bodyFinal ?? draft.bodyDraft}</p>
      )}
      {error && <p className="mt-1 text-[12.5px] text-bad">{error}</p>}
    </li>
  );
}

function OverdueRow({ id, text }: { id: string; text: string }) {
  const [done, setDone] = useState(false);
  return (
    <li className="py-2.5 flex items-center gap-2" data-testid="week-review-overdue">
      <span className="text-[13.5px] min-w-0 flex-1">
        <span className="font-medium">You promised</span>
        <span className="text-ink-3"> · {text}</span>
      </span>
      <Button
        size="sm"
        disabled={done}
        onClick={async () => {
          await markActionItemDone(id);
          setDone(true);
        }}
      >
        {done ? 'Done' : 'Mark done'}
      </Button>
    </li>
  );
}

function NextCard({ r, onClose }: { r: WeekReview; onClose: () => void }) {
  return (
    <div className="mt-3 space-y-3 text-[14px]" data-testid="week-review-next-week">
      <p>
        Next week: {r.next.target} first {r.next.target === 1 ? 'message' : 'messages'}, your usual.
      </p>
      {r.next.booked.length > 0 && (
        <div>
          <p className="text-ink-3 text-[13px] mb-1">Already booked</p>
          <ul className="space-y-1">
            {r.next.booked.map((b) => (
              <li key={`${b.personId}${b.day}`}>
                {b.day} · {b.name}
              </li>
            ))}
          </ul>
          <Link
            to="/chats"
            onClick={onClose}
            className="mt-1 inline-block text-[13px] underline underline-offset-2"
          >
            Your chats
          </Link>
        </div>
      )}
      {r.next.planLine && <p data-testid="week-review-plan-line">{r.next.planLine}</p>}
    </div>
  );
}
