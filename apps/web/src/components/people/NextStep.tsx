import type { OutboundStatus, Suggestion } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { db } from '../../db/schema';
import { nextStepPhrase, SUGGESTION_KIND_LABELS } from '../../engine/today';
import { useSession } from '../../state/session';
import { Drawer, useLastToastAt } from '../../ui';
import { NeedsYouCard } from '../autopilot/NeedsYou';
import { SuggestionCard } from '../SuggestionCard';

/** The address keeps which next step is open (`/people?next=<suggestion id>`): Back closes it, a reload reopens it. */
export const NEXT_PARAM = 'next';

/** Set on the history entry a pill made, so closing the panel goes back to the page it was opened from. */
const OPENED_HERE = { nextStep: true };

/** A draft that has left the student's hands: approved and on its way, or gone. */
const ON_ITS_WAY: OutboundStatus[] = ['queued', 'sending', 'approved', 'sent'];

/** The page already said what happened if a toast went up this recently. */
const TOAST_RECENT_MS = 2500;
/** The wait before looking for that toast: the card raises it just after the change it reports. */
const TOAST_BEAT_MS = 250;
/** How long the panel's own line stays before it closes. */
const DONE_LINE_MS = 1400;

/**
 * The next step for a chat, on a board card or a list row. It looks like a chip and is a button: it opens that step
 * right here, in a panel over the page (NextStepPanel, which the page renders once), with the same card Drafts shows.
 */
export function NextStepPill({ s }: { s: Suggestion }) {
  const [params, setParams] = useSearchParams();
  return (
    <button
      type="button"
      onClick={(e) => {
        // the card or the row it sits on opens the person on a click of its own: this click is not that one
        e.stopPropagation();
        // some browsers do not focus a clicked button: the panel hands focus back to this pill when it closes
        e.currentTarget.focus();
        const next = new URLSearchParams(params);
        next.set(NEXT_PARAM, s.id);
        setParams(next, { state: OPENED_HERE });
      }}
      className="relative z-10 inline-flex items-center gap-1 rounded-full bg-accent-soft text-accent px-2 h-6 text-[12px] font-medium whitespace-nowrap cursor-pointer hover:bg-accent hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      title="Do this here"
      aria-haspopup="dialog"
      aria-expanded={params.get(NEXT_PARAM) === s.id}
      data-testid="chat-next"
    >
      {SUGGESTION_KIND_LABELS[s.kind].label}
    </button>
  );
}

/** What the panel says for a moment when its step was dealt with and nothing else on the page said so. */
function doneLine(s: Suggestion | null, first?: string): string {
  switch (s?.status) {
    case 'sent':
      return first ? `Sent to ${first}.` : 'Sent.';
    case 'approved':
    case 'edited':
    case 'done':
      return 'Done.';
    case 'dismissed':
      return 'Removed.';
    case 'snoozed':
      return 'Saved for later.';
    default:
      return 'This step is no longer needed.';
  }
}

/**
 * The open next step: a panel on the right with what it is and for whom ("Find a time with Maya") and the step's own
 * card, the one Drafts renders, so the draft, the times and every button work here as they do there. It reads the
 * step from the address, so a page renders it once and any pill on that page opens it. It closes itself when the
 * step is dealt with (or goes away), and the page underneath updates on its own from the same data.
 */
export function NextStepPanel() {
  const { userId } = useSession();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const nav = useNavigate();
  const lastToastAt = useLastToastAt();
  const id = params.get(NEXT_PARAM) ?? undefined;
  // undefined: still reading; `s: null`: looked and it is not there. The id comes back with the row, so a result
  // read for the step that was open before is never taken for this one.
  const read = useLiveQuery(
    async () => (id ? { id, s: (await db.suggestions.get(id)) ?? null } : undefined),
    [id],
  );
  const row = read && read.id === id ? read.s : undefined;
  const pending = !!row && row.status === 'pending' && row.userId === userId;
  // the step as it was last seen waiting, kept while the panel says it is done and closes
  const [kept, setKept] = useState<Suggestion>();
  const s = pending ? (row ?? undefined) : kept?.id === id ? kept : undefined;
  const person = useLiveQuery(
    async () => (s?.personId ? db.people.get(s.personId) : undefined),
    [s?.personId],
  );
  const draft = useLiveQuery(
    async () => (s?.outboundMessageId ? db.outbound.get(s.outboundMessageId) : undefined),
    [s?.outboundMessageId],
  );
  const [done, setDone] = useState<string>();

  // one close per opening: a second one (Escape while the panel is already closing itself) would go back twice
  const closing = useRef(false);
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    // opened from a pill: Back is the way out, so the address history holds the page once, not twice
    if ((location.state as { nextStep?: boolean } | null)?.nextStep) {
      nav(-1);
      return;
    }
    // opened from a link or a reload: there may be nothing to go back to, so the step just leaves the address
    const next = new URLSearchParams(params);
    next.delete(NEXT_PARAM);
    setParams(next, { replace: true });
  }, [location.state, nav, params, setParams]);
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    void id;
    closing.current = false;
    setDone(undefined);
    if (!id) setKept(undefined);
  }, [id]);
  useEffect(() => {
    if (pending && row) setKept(row);
  }, [pending, row]);

  // no longer waiting: dealt with here (sent, dismissed, put off), or retired by Orbit while the panel was open
  const resolved = !!id && row !== undefined && !pending;
  const wasOpen = kept?.id === id;
  const line = useRef('');
  line.current = doneLine(row ?? null, person?.firstName);
  useEffect(() => {
    if (!resolved) return;
    // a link to a step that is already done, or is not this student's: there is nothing to open
    if (!wasOpen) {
      closeRef.current();
      return;
    }
    let hold: ReturnType<typeof setTimeout> | undefined;
    // a beat first: the card's own toast goes up just after the change it reports
    const wait = setTimeout(() => {
      if (Date.now() - lastToastAt() < TOAST_RECENT_MS) {
        closeRef.current();
        return;
      }
      setDone(line.current);
      hold = setTimeout(() => closeRef.current(), DONE_LINE_MS);
    }, TOAST_BEAT_MS);
    return () => {
      clearTimeout(wait);
      clearTimeout(hold);
      // taken back before the panel closed (Undo): the card is the thing to show again
      setDone(undefined);
    };
  }, [resolved, wasOpen, lastToastAt]);

  // A message approved here is on its way while its card still waits out the undo window. The toast (with Undo) and
  // the board's own "Sending in 8s" line carry on from there, so the panel gets out of the way at once. A message
  // handed to LinkedIn or the mail app stays: its card still asks whether it went.
  const seen = useRef<{ id: string; onItsWay: boolean } | undefined>(undefined);
  useEffect(() => {
    if (!draft) {
      seen.current = undefined;
      return;
    }
    const onItsWay = ON_ITS_WAY.includes(draft.status);
    const was = seen.current;
    seen.current = { id: draft.id, onItsWay };
    if (onItsWay && was?.id === draft.id && !was.onItsWay) closeRef.current();
  }, [draft]);

  if (!id || !s) return null;
  const label = SUGGESTION_KIND_LABELS[s.kind].label;
  const [before, after] = nextStepPhrase(s.kind).split('{name}');
  return (
    <Drawer
      open
      onClose={close}
      width={500}
      testId="next-panel"
      title={
        person ? (
          <>
            {before}
            <Link
              to={`/people/${person.id}`}
              className="rounded-sm underline decoration-line decoration-1 underline-offset-4 hover:decoration-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              data-testid="next-panel-person"
            >
              {person.firstName}
            </Link>
            {after}
          </>
        ) : (
          label
        )
      }
      footer={
        <Link
          to={`/inbox?card=${s.id}`}
          className="text-ink-3 underline underline-offset-2 hover:text-ink"
          data-testid="next-panel-open-drafts"
        >
          Open in Drafts
        </Link>
      }
    >
      {done ? (
        <p
          className="flex items-center gap-2 text-[13.5px] text-ink-2"
          role="status"
          data-testid="next-panel-done"
        >
          <Check size={15} className="text-good shrink-0" aria-hidden />
          {done}
        </p>
      ) : s.kind === 'needs_you' ? (
        // a reply's question has its own card (an answer box); the shared card leaves it to that one
        <NeedsYouCard s={s} compact />
      ) : (
        // the draft opens at once: the panel is the place to act, as Drafts' reading pane is
        <SuggestionCard key={s.id} s={s} defaultOpen bare onCloseDraft={close} />
      )}
    </Drawer>
  );
}
