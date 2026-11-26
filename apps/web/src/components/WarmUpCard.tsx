/**
 * A chat's LinkedIn warm-up on the person's page. Two shapes:
 *
 * - one Orbit runs (the plan carries `auto`): each step with when it ran or when it is due, the comment the student
 *   approved, Stop while it is under way, "Warmed up" once the last step has run, and plain words when it stopped;
 * - one the student does by hand: the steps as links to LinkedIn, as before, with Stop, and "Let Orbit run it" when
 *   Orbit can (an Orbit account with LinkedIn connected and the setting on).
 *
 * Either way "See the plan" opens the whole plan with the day and time of each step (WarmUpPlanView.tsx).
 */
import {
  autoDayLabel,
  type CoffeeChat,
  linkedinActivityUrl,
  type Person,
  type User,
  type WarmUpAction,
  warmUpStopWords,
} from '@orbit/core';
import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { autoWarmUpMode, demoRunNextStep, stopWarmUp } from '../engine/warmupAuto';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { openWarmUpPlan } from '../state/warmUpPlan';
import { openWarmUpSheet } from '../state/warmUpSheet';
import { Button, Card, Chip, cx, useToast } from '../ui';
import { warmUpPlanRows } from './WarmUpPlanView';

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

/** Whether Orbit can run warm-ups for this student right now (asked once per mount; false until known). */
export function useAutoWarmUp(user: Pick<User, 'id'> | undefined): boolean {
  const [on, setOn] = useState(false);
  const id = user?.id;
  useEffect(() => {
    let alive = true;
    if (!id) return;
    void autoWarmUpMode({ id })
      .then((m) => alive && setOn(!!m))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);
  return on;
}

/** Stop a warm-up from anywhere it is listed; says what happened in a toast. */
export function useStopWarmUp(user: Pick<User, 'id'> | undefined) {
  const toast = useToast();
  const [stopping, setStopping] = useState<string>();
  const stop = async (chat: Pick<CoffeeChat, 'id'>, firstName: string) => {
    if (!user) return;
    setStopping(chat.id);
    try {
      const r = await stopWarmUp(user, chat.id);
      toast.push(
        r.ok
          ? {
              text: `Stopped the warm-up for ${firstName}. Nothing more will be done on LinkedIn.`,
              tone: 'good',
            }
          : { text: r.message, tone: 'bad' },
      );
    } finally {
      setStopping(undefined);
    }
  };
  return { stop, stopping };
}

/** Opens the whole plan, step by step, with the day and time of each (WarmUpPlanView). */
function PlanLink({ chat }: { chat: Pick<CoffeeChat, 'id'> }) {
  return (
    <button
      type="button"
      className="text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink"
      onClick={() => openWarmUpPlan({ chatId: chat.id })}
      data-testid="warmup-see-plan"
    >
      See the plan
    </button>
  );
}

function Mark({ a }: { a: WarmUpAction }) {
  return (
    <span
      className={cx(
        'w-4 h-4 rounded-full border inline-flex items-center justify-center text-[10px] shrink-0',
        a.doneAt ? 'bg-good border-good text-white' : a.skippedAt ? 'bg-line border-line' : 'border-line',
      )}
      aria-hidden
    >
      {a.doneAt ? '✓' : ''}
    </span>
  );
}

export function WarmUpCard({
  user,
  person,
  chat,
  now = new Date(),
}: {
  user: User;
  person: Person;
  chat: CoffeeChat;
  now?: Date;
}) {
  const canAuto = useAutoWarmUp(user);
  const { stop, stopping } = useStopWarmUp(user);
  const plan = chat.warmUp;
  if (!plan) return null;
  const auto = plan.auto;
  const first = person.firstName || 'them';
  const warming = chat.stage === 'warming';

  if (auto && auto.status !== 'stopped') {
    const over = auto.status === 'done';
    const ran = plan.actions.filter((a) => a.doneAt).length;
    return (
      <Card data-testid="warmup-card">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="font-medium">LinkedIn warm-up</span>
            <PlanLink chat={chat} />
          </div>
          {over ? (
            <Chip tone="good" data-testid="warmup-warmed">
              {ran > 0 ? 'Warmed up' : 'Could not run'}
            </Chip>
          ) : (
            <Chip data-testid="warmup-running">Orbit is running it</Chip>
          )}
        </div>
        <ul className="space-y-2 text-[13px]" data-testid="warmup-progress">
          {plan.actions.map((a) => (
            <li key={a.id} className="flex items-start gap-2" data-testid={`warmup-step-${a.kind}`}>
              <span className="mt-0.5">
                <Mark a={a} />
              </span>
              <span className="flex-1 min-w-0">
                <span className={cx(a.skippedAt && !a.doneAt && 'text-ink-3')}>{a.label}</span>
                <span className="block text-[12px] text-ink-3">
                  {a.doneAt
                    ? `Done ${day(a.doneAt)}`
                    : a.skippedAt
                      ? (a.autoNote ?? 'Skipped.')
                      : autoDayLabel(a.dueAt, now, user.timezone)}
                </span>
              </span>
            </li>
          ))}
          {warmUpPlanRows({ chat, person, now, tz: user.timezone })
            .filter((r) => r.kind === 'no_post' || r.kind === 'message')
            .map((r) => (
              <li key={r.key} className="flex items-start gap-2" data-testid={`warmup-step-${r.kind}`}>
                <span
                  className={cx(
                    'mt-0.5 w-4 h-4 rounded-full border shrink-0',
                    r.status === 'sent'
                      ? 'bg-good border-good'
                      : r.status === 'skipped'
                        ? 'bg-line border-line'
                        : 'border-line',
                  )}
                  aria-hidden
                />
                <span className="flex-1 min-w-0">
                  <span className={cx(r.status === 'skipped' && 'text-ink-3')}>{r.text}</span>
                  <span className="block text-[12px] text-ink-3">
                    {r.kind === 'message' && r.status !== 'sent'
                      ? `${autoDayLabel(r.at, now, user.timezone)}. `
                      : ''}
                    {r.note}
                  </span>
                </span>
              </li>
            ))}
        </ul>
        {auto.comment ? (
          <p className="text-[12.5px] text-ink-2 mt-3" data-testid="warmup-approved-comment">
            <span className="text-ink-3">The comment you approved:</span> {auto.comment}
          </p>
        ) : (
          plan.actions.some((a) => a.kind === 'react_post') && (
            <p className="text-[12px] text-ink-3 mt-3">No comment, as you chose.</p>
          )
        )}
        {auto.postUrl && (
          <a
            className="mt-1 inline-flex items-center gap-1 text-[12px] text-ink-3 underline"
            href={auto.postUrl}
            target="_blank"
            rel="noreferrer"
          >
            The post <ExternalLink size={11} aria-hidden />
          </a>
        )}
        {over ? (
          <p className="text-[12px] text-ink-3 mt-2" data-testid="warmup-done-line">
            {ran > 0
              ? `Orbit finished on ${day(auto.finishedAt ?? plan.readyAt)}. Your first message is ready to write.`
              : `Orbit could not run the steps. You can still write to ${first}.`}
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => void stop(chat, first)}
              loading={stopping === chat.id}
              data-testid="warmup-stop"
            >
              Stop
            </Button>
            {usesMockConnectors(user.id) && (
              <button
                type="button"
                className="text-[12px] text-ink-3 underline"
                onClick={() => void demoRunNextStep(user, auto.runId)}
                data-testid="warmup-demo-next"
              >
                Sample student: run the next step now
              </button>
            )}
          </div>
        )}
      </Card>
    );
  }

  // by hand: the reminders with links to LinkedIn (and what Orbit ran before it stopped, if it had started)
  return (
    <Card data-testid="warmup-card">
      <div className="flex items-baseline gap-2 mb-2">
        <span className="font-medium">LinkedIn warm-up</span>
        <PlanLink chat={chat} />
      </div>
      {auto?.status === 'stopped' && (
        <p className="text-[12.5px] text-ink-2 mb-2" data-testid="warmup-stopped-line">
          {warmUpStopWords(auto.stopReason, first)}
        </p>
      )}
      <ul className="space-y-2 text-[13px]">
        {plan.actions.map((a) => (
          <li key={a.id} className="flex items-center gap-2">
            <Mark a={a} />
            <span className={cx('flex-1', (a.doneAt || a.skippedAt) && 'text-ink-3 line-through')}>
              {a.label}
            </span>
            <a
              href={a.url}
              target="_blank"
              rel="noreferrer"
              className="text-ink-3 hover:text-ink"
              aria-label={`Open on LinkedIn: ${a.label}`}
              title="Open on LinkedIn"
            >
              <ExternalLink size={13} />
            </a>
          </li>
        ))}
      </ul>
      {(warming || !auto) && (
        <p className="text-[12px] text-ink-3 mt-2">
          First message suggested after {day(plan.readyAt)}.{' '}
          {person.linkedinSlug && (
            <a
              className="underline"
              href={linkedinActivityUrl(person.linkedinSlug)}
              target="_blank"
              rel="noreferrer"
            >
              Their activity
            </a>
          )}
        </p>
      )}
      {warming && (
        <div className="mt-3 flex flex-wrap gap-2">
          {canAuto && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => openWarmUpSheet({ personId: person.id, source: chat.source })}
              data-testid="warmup-hand-over"
            >
              Let Orbit run it
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => void stop(chat, first)}
            loading={stopping === chat.id}
            data-testid="warmup-stop"
          >
            Stop
          </Button>
        </div>
      )}
    </Card>
  );
}
