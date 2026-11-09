/**
 * Needs you (plan 29 §B1): the replies that asked something only the student knows, each with the question in the
 * person's words and one line to answer it; the answer drafts the reply, which then waits for approval like any other.
 * Under it, the threads the funnel closed (a decline, an unsubscribe) so the student knows, and the breaker's cards.
 */
import type { Suggestion, User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../db/schema';
import { answerReply } from '../../engine/autopilotMode';
import { useSession } from '../../state/session';
import { Button, Card, Chip, Input, useToast } from '../../ui';

export function useOpenAutopilotCards(userId: string | undefined) {
  return useLiveQuery(
    () =>
      userId
        ? db.suggestions
            .where('userId')
            .equals(userId)
            .filter((s) => (s.kind === 'needs_you' || s.kind === 'breaker') && s.status === 'pending')
            .toArray()
            // one card per key, whatever raised it twice
            .then((rows) => rows.filter((s, i) => rows.findIndex((r) => r.dedupeKey === s.dedupeKey) === i))
        : [],
    [userId],
  );
}

/** One question with its answer box. */
export function NeedsYouCard({ s, compact }: { s: Suggestion; compact?: boolean }) {
  const { user } = useSession();
  const toast = useToast();
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  const name = (s.payload.personName as string | undefined) ?? 'They';
  const question = (s.payload.question as string | undefined) ?? s.reasonText;
  const send = async () => {
    if (!answer.trim()) return;
    setBusy(true);
    try {
      const r = await answerReply(user, { suggestionId: s.id, answer });
      toast.push({
        text: r.ok
          ? `Drafted the reply to ${name.split(' ')[0]} around your answer. It waits for your approval.`
          : r.message,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className={compact ? 'py-2.5' : 'bg-canvas border border-line rounded-[var(--radius-card)] p-4 fade-up'}
      data-testid="needs-you-item"
    >
      <div className="flex items-center gap-2 text-[13.5px] flex-wrap">
        <Chip tone="accent">Needs you</Chip>
        {s.personId ? (
          <Link to={`/people/${s.personId}`} className="font-medium hover:underline">
            {name}
          </Link>
        ) : (
          <span className="font-medium">{name}</span>
        )}
        {s.payload.company ? <span className="text-ink-3">{String(s.payload.company)}</span> : null}
      </div>
      <p className="text-[13.5px] text-ink-2 mt-1" data-testid="needs-you-question">
        {name.split(' ')[0]} asked: "{question}"
      </p>
      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Input
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Your answer, in a line"
          aria-label={`Your answer to ${name}`}
          className="flex-1"
          data-testid="needs-you-answer"
        />
        <Button size="sm" type="submit" disabled={busy || !answer.trim()} data-testid="needs-you-send">
          Draft the reply
        </Button>
      </form>
    </div>
  );
}

/** The breaker's card: who pushed back, which goal's first messages paused, and the way to lift it. */
export function BreakerCard({ s }: { s: Suggestion }) {
  const { user } = useSession();
  const toast = useToast();
  const text = (s.payload.text as string | undefined) ?? s.reasonText.replace(/ Read it\?$/, '');
  const goalId = s.payload.goalId as string | null | undefined;
  const resume = async () => {
    if (!user || !goalId) return;
    const { pauseAutopilot } = await import('../../engine/autopilotMode');
    const r = await pauseAutopilot(user, { until: null, goalId });
    if (r.ok) {
      await db.suggestions.update(s.id, { status: 'done', decidedAt: new Date().toISOString() });
      toast.push({ text: 'Resumed. Orbit sends for this goal on its own again.' });
    } else toast.push({ text: r.message });
  };
  return (
    <div
      className="bg-canvas border border-warn/40 rounded-[var(--radius-card)] p-4 fade-up"
      data-testid="autopilot-breaker-card"
    >
      <div className="flex items-center gap-2 text-[13.5px] flex-wrap">
        <Chip tone="warn">Paused</Chip>
        {s.personId && (
          <Link to={`/people/${s.personId}`} className="font-medium hover:underline">
            {String(s.payload.personName ?? 'Read it')}
          </Link>
        )}
      </div>
      <p className="text-[13.5px] text-ink-2 mt-1">{text}</p>
      <div className="mt-2 flex items-center gap-2">
        {s.personId && (
          <Link to={`/people/${s.personId}?tab=messages`} className="inline-flex">
            <Button size="sm">Read it</Button>
          </Link>
        )}
        {goalId && (
          <Button size="sm" variant="ghost" onClick={() => void resume()} data-testid="breaker-resume">
            Resume this goal
          </Button>
        )}
      </div>
    </div>
  );
}

/** The section on Drafts: the open questions, the breaker's cards, then the closed threads in one line each. */
/**
 * The one autopilot notice Drafts keeps (plan 37 follow-up): Orbit paused what it sends on its own for a goal, and
 * why. The questions replies ask and the threads a reply closed are not listed here any more: a question is answered in
 * the chat ("answer Dan: yes, applied Monday"), and a closed thread moves its card on the board by itself.
 */
export function AutopilotPaused({ user }: { user: User }) {
  const cards = useOpenAutopilotCards(user.id) ?? [];
  const breakers = cards.filter((s) => s.kind === 'breaker');
  if (!breakers.length) return null;
  return (
    <Card className="mb-5" data-testid="autopilot-paused">
      <div className="font-medium">Paused</div>
      <p className="text-[12px] text-ink-3 mt-0.5">
        Orbit paused what it sends on its own for a goal, and says why.
      </p>
      <div className="mt-3 space-y-2">
        {breakers.map((s) => (
          <BreakerCard key={s.id} s={s} />
        ))}
      </div>
    </Card>
  );
}
