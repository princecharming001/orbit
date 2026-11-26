/**
 * The whole plan of a LinkedIn warm-up, step by step: the day and time of each step in the student's time zone, what
 * happens in plain words and who does it (Orbit, or the student by hand), the post it acts on, the comment (or that it
 * is not written yet), where each step stands, and last the day the student's connection request and first message
 * are ready. Orbit never sends those: they wait for the student's Send, and the plan says so.
 *
 * One dialog for the whole app, mounted in the shell and opened through state/warmUpPlan.ts from wherever a warm-up
 * is listed: the person's page, the pipeline card and Coming up on Drafts. The start sheet (WarmUpStartSheet.tsx) is
 * the same plan before a warm-up starts.
 */
import {
  autoDayLabel,
  type CoffeeChat,
  type Person,
  type User,
  type WarmUpAction,
  wallKey,
  warmUpStopWords,
} from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import { db } from '../db/schema';
import { useSession } from '../state/session';
import { closeWarmUpPlan, useWarmUpPlan } from '../state/warmUpPlan';
import { openWarmUpSheet } from '../state/warmUpSheet';
import { Avatar, Button, Chip, cx, Modal } from '../ui';
import { useAutoWarmUp, useStopWarmUp } from './WarmUpCard';

export type PlanStatus = 'done' | 'today' | 'due' | 'upcoming' | 'skipped' | 'ready' | 'sent';

export interface PlanRow {
  key: string;
  kind: WarmUpAction['kind'] | 'message';
  /** who does the step: Orbit from the student's LinkedIn, or the student by hand */
  who: 'orbit' | 'you';
  /** the time shown: when it ran, or when it is due */
  at: string;
  text: string;
  status: PlanStatus;
  /** a line under the step: why it was skipped, or what happens next */
  note?: string;
  /** the post the step acts on */
  post?: { excerpt?: string; url?: string };
  /** the comment step: its words, or null when they are not written yet, with a line on how they are posted */
  comment?: { text: string | null; note: string };
  /** a step done by hand: where to do it on LinkedIn */
  url?: string;
}

const STATUS_WORDS: Record<PlanStatus, string> = {
  done: 'Done',
  today: 'Today',
  due: 'Due',
  upcoming: 'Upcoming',
  skipped: 'Skipped',
  ready: 'Ready',
  sent: 'Sent',
};
const STATUS_TONE: Record<PlanStatus, 'neutral' | 'accent' | 'good' | 'warn'> = {
  done: 'good',
  today: 'accent',
  due: 'warn',
  upcoming: 'neutral',
  skipped: 'neutral',
  ready: 'accent',
  sent: 'good',
};

/** "Today, 10:00 AM", "Thursday, 10:00 AM", or a past day as "Mon, Oct 5, 10:20 AM", in the student's time zone. */
export function planWhen(iso: string, now: Date, tz?: string): string {
  const d = new Date(iso);
  const opts = (o: Intl.DateTimeFormatOptions) => {
    try {
      return d.toLocaleString('en-US', { ...o, timeZone: tz || undefined });
    } catch {
      return d.toLocaleString('en-US', o);
    }
  };
  const time = opts({ hour: 'numeric', minute: '2-digit' });
  const day =
    wallKey(d, tz) < wallKey(now, tz)
      ? opts({ weekday: 'short', month: 'short', day: 'numeric' })
      : autoDayLabel(iso, now, tz);
  return `${day}, ${time}`;
}

/**
 * The plan's rows: one per step and, while the warm-up is on (or once it is done), the student's first message last.
 * A step Orbit ran or runs reads "Orbit …"; a step left to the student (by hand, or handed back when Orbit stopped)
 * reads "You …".
 */
export function warmUpPlanRows(o: {
  chat: Pick<CoffeeChat, 'stage' | 'warmUp' | 'firstOutreachAt'>;
  person: Pick<Person, 'firstName' | 'displayName' | 'linkedinConnectedOn'>;
  now: Date;
  tz?: string;
}): PlanRow[] {
  const plan = o.chat.warmUp;
  if (!plan) return [];
  const auto = plan.auto;
  const first = o.person.firstName?.trim() || o.person.displayName.split(' ')[0] || 'them';
  const whose = /s$/i.test(first) ? `${first}'` : `${first}'s`;
  const today = wallKey(o.now, o.tz);
  let postShown = false;
  let postBefore = false;
  const rows: PlanRow[] = plan.actions.map((a) => {
    const who: PlanRow['who'] =
      auto && (auto.status !== 'stopped' || a.doneAt || a.skippedAt) ? 'orbit' : 'you';
    const Who = who === 'orbit' ? 'Orbit' : 'You';
    const status: PlanStatus = a.doneAt
      ? 'done'
      : a.skippedAt
        ? 'skipped'
        : wallKey(new Date(a.dueAt), o.tz) < today && who === 'you'
          ? 'due'
          : wallKey(new Date(a.dueAt), o.tz) <= today
            ? 'today'
            : 'upcoming';
    const excerpt = who === 'orbit' ? auto?.postExcerpt : undefined;
    let text: string;
    switch (a.kind) {
      case 'view_profile':
        text =
          who === 'orbit'
            ? `Orbit views ${whose} profile`
            : `You look at ${whose} profile and what they post about`;
        break;
      case 'react_post':
        text =
          who === 'orbit'
            ? excerpt
              ? `Orbit likes ${whose} post`
              : `Orbit likes one of ${whose} recent posts`
            : `You react to one of ${whose} recent posts`;
        break;
      case 'comment_post':
        text = postBefore
          ? `${Who} comment${who === 'orbit' ? 's' : ''} on that post`
          : `${Who} comment${who === 'orbit' ? 's' : ''} on ${who === 'orbit' && excerpt ? `${whose} post` : `one of ${whose} recent posts`}`;
        break;
      default:
        text = `${Who} follow${who === 'orbit' ? 's' : ''} ${first}`;
    }
    const row: PlanRow = {
      key: a.id,
      kind: a.kind,
      who,
      at: a.doneAt ?? a.dueAt,
      text,
      status,
    };
    if (a.kind === 'react_post' || a.kind === 'comment_post') {
      if (who === 'orbit' && !postShown && (auto?.postExcerpt || auto?.postUrl)) {
        row.post = { excerpt: auto?.postExcerpt, url: auto?.postUrl };
        postShown = true;
      } else if (who === 'you' && a.doneAt && a.note) {
        row.post = { excerpt: a.note };
      }
      postBefore = true;
    }
    if (a.kind === 'comment_post' && status !== 'skipped') {
      row.comment =
        who === 'orbit'
          ? auto?.comment
            ? { text: auto.comment, note: 'Orbit posts exactly these words, as you approved them.' }
            : { text: null, note: 'Orbit shows it to you before anything is posted.' }
          : a.doneAt
            ? undefined
            : {
                text: null,
                note: 'On the day, Orbit helps you draft it in Drafts, and you post it yourself.',
              };
    }
    if (status === 'skipped')
      row.note = a.autoNote ?? (who === 'you' ? 'You skipped this step.' : 'Skipped.');
    if (who === 'you' && !a.doneAt && !a.skippedAt) row.url = a.url;
    return row;
  });
  // the first message last: it waits for the student's Send, whoever ran the steps
  const on = o.chat.stage === 'warming' || auto?.status === 'done' || !!o.chat.firstOutreachAt;
  if (on) {
    const connected = !!o.person.linkedinConnectedOn;
    rows.push({
      key: 'message',
      kind: 'message',
      who: 'you',
      at: plan.readyAt,
      text: connected
        ? 'Your first message is ready for you to send'
        : 'Your connection request and first message are ready for you to send',
      status: o.chat.firstOutreachAt
        ? 'sent'
        : auto?.status === 'done' || new Date(plan.readyAt) <= o.now
          ? 'ready'
          : 'upcoming',
      note: o.chat.firstOutreachAt
        ? undefined
        : `Orbit never sends ${connected ? 'it' : 'them'} for you. Nothing goes out until you press Send.`,
    });
  }
  return rows;
}

function Mark({ status }: { status: PlanStatus }) {
  const done = status === 'done' || status === 'sent';
  return (
    <span
      className={cx(
        'mt-0.5 w-4 h-4 rounded-full border inline-flex items-center justify-center text-[10px] shrink-0',
        done
          ? 'bg-good border-good text-white'
          : status === 'skipped'
            ? 'bg-line border-line'
            : status === 'today' || status === 'ready' || status === 'due'
              ? 'border-accent'
              : 'border-line',
      )}
      aria-hidden
    >
      {done ? '✓' : ''}
    </span>
  );
}

/** The plan's body: what the dialog shows, and what a test renders on its own. */
export function WarmUpPlanView({
  user,
  person,
  chat,
  now = new Date(),
  onClose,
}: {
  user: User;
  person: Person;
  chat: CoffeeChat;
  now?: Date;
  /** called when the student leaves the plan for another page or the start sheet */
  onClose?: () => void;
}) {
  const canAuto = useAutoWarmUp(user);
  const { stop, stopping } = useStopWarmUp(user);
  const plan = chat.warmUp;
  if (!plan) return null;
  const auto = plan.auto;
  const first = person.firstName || 'them';
  const running = auto?.status === 'running';
  const warming = chat.stage === 'warming';
  const rows = warmUpPlanRows({ chat, person, now, tz: user.timezone });
  const open = plan.actions.some((a) => !a.doneAt && !a.skippedAt);
  const canStop = running || (warming && !auto && open) || (warming && auto?.status === 'stopped' && open);
  const canHandOver = warming && canAuto && !running && auto?.status !== 'done' && open;
  const status = running
    ? { words: 'Orbit is running it', tone: 'accent' as const }
    : auto?.status === 'done'
      ? { words: 'Warmed up', tone: 'good' as const }
      : warming
        ? { words: 'By hand', tone: 'neutral' as const }
        : chat.firstOutreachAt
          ? { words: 'Finished', tone: 'good' as const }
          : { words: 'Stopped', tone: 'neutral' as const };
  const lead = running
    ? 'Orbit does these steps from your LinkedIn. There is nothing for you to do until your message.'
    : auto?.status === 'done'
      ? 'Orbit ran these steps from your LinkedIn.'
      : auto?.status === 'stopped'
        ? warmUpStopWords(auto.stopReason, first)
        : warming
          ? 'You do these steps on LinkedIn. Each one shows up in Drafts on its day.'
          : undefined;

  return (
    <div className="space-y-4 text-[13.5px] text-ink-2" data-testid="warmup-plan-view">
      <div className="flex items-center gap-3">
        <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={32} />
        <div className="min-w-0 flex-1">
          <Link
            to={`/people/${person.id}`}
            onClick={onClose}
            className="block font-medium text-ink truncate hover:underline"
            data-testid="warmup-plan-person"
          >
            {person.displayName}
          </Link>
          {lead && (
            <p className="text-[12.5px] text-ink-3" data-testid="warmup-plan-lead">
              {lead}
            </p>
          )}
        </div>
        <Chip tone={status.tone} data-testid="warmup-plan-status">
          {status.words}
        </Chip>
      </div>

      <ol className="space-y-3.5" data-testid="warmup-plan-steps">
        {rows.map((r) => (
          <li
            key={r.key}
            className="flex gap-3"
            data-testid={`warmup-plan-step-${r.kind}`}
            data-status={r.status}
            data-who={r.who}
          >
            <Mark status={r.status} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] text-ink-3" data-testid="warmup-plan-when">
                  {planWhen(r.at, now, user.timezone)}
                </span>
                <Chip tone={STATUS_TONE[r.status]} data-testid="warmup-plan-step-status">
                  {STATUS_WORDS[r.status]}
                </Chip>
              </div>
              <p
                className={cx('mt-0.5 text-ink', r.status === 'skipped' && 'text-ink-3')}
                data-testid="warmup-plan-step-text"
              >
                {r.text}
                {r.url && (
                  <>
                    {' '}
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-0.5 text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink"
                    >
                      Open on LinkedIn <ExternalLink size={11} aria-hidden />
                    </a>
                  </>
                )}
              </p>
              {r.post && (
                <div
                  className="mt-1.5 border-l-2 border-line pl-3 text-[12.5px]"
                  data-testid="warmup-plan-post"
                >
                  {r.post.excerpt && <p className="text-ink-2">"{r.post.excerpt}"</p>}
                  {r.post.url && (
                    <a
                      href={r.post.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-0.5 text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink"
                    >
                      Open the post <ExternalLink size={11} aria-hidden />
                    </a>
                  )}
                </div>
              )}
              {r.comment && (
                <div className="mt-1.5 rounded-lg bg-canvas-2 px-3 py-2" data-testid="warmup-plan-comment">
                  {r.comment.text ? (
                    <p className="text-ink">{r.comment.text}</p>
                  ) : (
                    <p className="text-ink-2" data-testid="warmup-plan-comment-none">
                      Comment not written yet.
                    </p>
                  )}
                  <p className="text-[12px] text-ink-3">{r.comment.note}</p>
                </div>
              )}
              {r.note && <p className="mt-0.5 text-[12px] text-ink-3">{r.note}</p>}
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {canHandOver && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              onClose?.();
              openWarmUpSheet({ personId: person.id, source: chat.source });
            }}
            data-testid="warmup-plan-hand-over"
          >
            Let Orbit run it
          </Button>
        )}
        {canStop && (
          <Button
            size="sm"
            onClick={() => void stop(chat, first)}
            loading={stopping === chat.id}
            data-testid="warmup-plan-stop"
          >
            Stop
          </Button>
        )}
        <Link
          to={`/people/${person.id}`}
          onClick={onClose}
          className="h-8 px-2 inline-flex items-center text-[13px] text-ink-3 underline underline-offset-2 hover:text-ink"
          data-testid="warmup-plan-profile"
        >
          Open their profile
        </Link>
      </div>
    </div>
  );
}

/** The plan as a dialog, for the chat state/warmUpPlan.ts names. */
export function WarmUpPlanSheet() {
  const req = useWarmUpPlan();
  return req ? <Sheet key={req.chatId} chatId={req.chatId} /> : null;
}

function Sheet({ chatId }: { chatId: string }) {
  const { user } = useSession();
  const data = useLiveQuery(async () => {
    const chat = await db.chats.get(chatId);
    const person = chat ? await db.people.get(chat.personId) : undefined;
    return { chat, person };
  }, [chatId]);
  if (!user) return null;
  const close = () => closeWarmUpPlan();
  return (
    <Modal open onClose={close} title="Warm-up plan" width={560}>
      {!data ? null : data.chat?.warmUp && data.person ? (
        <WarmUpPlanView user={user} person={data.person} chat={data.chat} onClose={close} />
      ) : (
        <p className="text-[13.5px] text-ink-3" data-testid="warmup-plan-gone">
          This warm-up is no longer there.
        </p>
      )}
    </Modal>
  );
}
