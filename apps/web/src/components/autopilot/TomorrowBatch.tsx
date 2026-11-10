/**
 * Tomorrow's batch (plan 29 §B1): the messages Orbit will send in the morning unless the student holds one. Hold puts
 * one back as a draft; Edit opens the person's page where the draft lives; Send now sends it at once. A first message
 * Orbit wrote before the first-message rung is earned waits for a tap (Send in the morning) and the line under the
 * title says why. The asks to a friend the plan drafted sit under it: Ask sends the ask to the friend, never anything
 * to the person. In local mode the batch is this browser's scheduled sends, with the honest line that Orbit sends
 * while it is open.
 */
import type { AutopilotFriendAsk, AutopilotItem } from '@orbit/core';
import { firstTouchRungLine, MESSAGE_KIND_LABELS } from '@orbit/core';
import { Link } from 'react-router-dom';
import { db } from '../../db/schema';
import { answerPlanAsk, holdSend, tapBatchItem } from '../../engine/autopilotMode';
import { approveAndSend } from '../../engine/send';
import { callApi, isServerUser } from '../../integrations/orbitApi';
import { useSession } from '../../state/session';
import { Button, Card, useToast } from '../../ui';
import type { AutopilotView } from './useAutopilotStatus';

const when = (iso: string | null, tz?: string) =>
  iso
    ? new Date(iso)
        .toLocaleString('en-US', {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
          timeZone: tz || undefined,
        })
        .replace(/\s?([AP])M$/i, (_, x: string) => ` ${x.toLowerCase()}m`)
    : '';

export function TomorrowBatch({ view }: { view: AutopilotView }) {
  const { user } = useSession();
  const toast = useToast();
  const items = view.status?.queued ?? [];
  const asks = view.status?.friendAsks ?? [];
  if (!user || (!items.length && !asks.length)) return null;
  const waiting = items.some((i) => i.status === 'needs_tap');
  const rung = view.status?.rungs.find((r) => r.kind === 'first_touch');
  const tap = async (i: AutopilotItem) => {
    const r = await tapBatchItem(user, i);
    toast.push({
      text: r.ok ? `It goes to ${i.personName.split(' ')[0]} in the morning.` : r.message,
    });
    await view.refresh();
  };
  const ask = async (a: AutopilotFriendAsk, send: boolean) => {
    const r = await answerPlanAsk(user, a, send);
    const friend = a.friendName.split(' ')[0];
    toast.push({
      text: r.ok
        ? send
          ? `Asked ${friend}. ${friend} forwards your note to ${a.targetName.split(' ')[0]} if it fits.`
          : 'Set aside. Orbit will not suggest that ask again.'
        : r.message,
    });
    await view.refresh();
  };
  const hold = async (i: AutopilotItem) => {
    const r = await holdSend(user, i.draftId);
    toast.push({
      text: r.ok ? `Held. The note to ${i.personName.split(' ')[0]} is a draft again.` : r.message,
    });
    await view.refresh();
  };
  const sendNow = async (i: AutopilotItem) => {
    if (isServerUser(user.id)) {
      const r = await callApi('/drafts/approve', { draftId: i.draftId, sendAt: new Date().toISOString() });
      toast.push({ text: r.ok ? `Sending to ${i.personName.split(' ')[0]} now.` : r.message });
    } else {
      const m = await db.outbound.get(i.draftId);
      if (!m) return;
      const { cancelScheduled } = await import('../../engine/autopilot');
      await cancelScheduled(user.id, m.id);
      const r = await approveAndSend(user, m.id, m.bodyFinal ?? m.bodyDraft, m.subject);
      toast.push({ text: r.ok ? `Sending to ${i.personName.split(' ')[0]} now.` : r.error });
    }
    await view.refresh();
  };
  return (
    <Card className="mb-5 @container" data-testid="tomorrow-batch">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[15px] font-semibold">Tomorrow's batch</div>
        <span className="text-[12.5px] text-ink-3 tabular">
          {items.length} {items.length === 1 ? 'message' : 'messages'}
        </span>
      </div>
      <p className="text-[13px] text-ink-3 mt-0.5">
        {view.local
          ? `${items.length === 1 ? 'This goes' : 'These go'} at the times shown, in each person's morning. ${view.note ?? ''}`
          : `${items.length === 1 ? 'This goes' : 'These go'} in the morning, each in the person's own time, unless you hold it.`}
      </p>
      {waiting && rung && (
        <div className="mt-3 flex items-center gap-3" data-testid="batch-rung">
          <span className="h-1 w-24 shrink-0 rounded-full bg-line-2 overflow-hidden" aria-hidden>
            <span
              className="block h-full bg-accent"
              style={{
                width: `${Math.min(100, Math.round((rung.unchanged / Math.max(1, rung.needed)) * 100))}%`,
              }}
            />
          </span>
          <p className="text-[12.5px] text-ink-2">
            {firstTouchRungLine({ unchanged: rung.unchanged, needed: rung.needed, earned: rung.unlocked })}
          </p>
        </div>
      )}
      <ul className="mt-3 divide-y divide-line-2 border-t border-line-2">
        {items.map((i) => (
          // the actions sit under the words until there is room beside them, so a name never breaks in two
          <li
            key={i.draftId}
            className="py-3 flex flex-col gap-2 @lg:flex-row @lg:items-center @lg:gap-4"
            data-testid="batch-item"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 text-[14px] min-w-0">
                {i.personId ? (
                  <Link
                    to={`/people/${i.personId}`}
                    className="font-medium whitespace-nowrap hover:underline underline-offset-2"
                  >
                    {i.personName}
                  </Link>
                ) : (
                  <span className="font-medium whitespace-nowrap">{i.personName}</span>
                )}
                {i.company && <span className="text-ink-3 truncate">{i.company}</span>}
              </div>
              {i.subject && <p className="text-[13px] text-ink-2 mt-0.5 line-clamp-1">{i.subject}</p>}
              <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-3">
                <span>{MESSAGE_KIND_LABELS[i.kind]}</span>
                <span aria-hidden>·</span>
                <span className="tabular" data-testid="batch-when">
                  {when(i.sendAt, user.timezone)} their time
                </span>
                {i.status === 'needs_tap' && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="text-warn" data-testid="batch-needs-tap">
                      Waits for your tap
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1 -ml-3 @lg:ml-0 @lg:shrink-0">
              <Button size="sm" variant="ghost" onClick={() => void hold(i)} data-testid="batch-hold">
                Hold
              </Button>
              {i.personId ? (
                <Link to={`/people/${i.personId}?tab=messages`} className="inline-flex">
                  <Button size="sm" variant="ghost" data-testid="batch-edit">
                    Edit
                  </Button>
                </Link>
              ) : (
                <Button size="sm" variant="ghost" disabled data-testid="batch-edit">
                  Edit
                </Button>
              )}
              {i.status === 'needs_tap' ? (
                <Button size="sm" variant="primary" onClick={() => void tap(i)} data-testid="batch-tap">
                  Send in the morning
                </Button>
              ) : null}
              <Button
                size="sm"
                variant={i.status === 'needs_tap' ? 'ghost' : 'secondary'}
                onClick={() => void sendNow(i)}
                data-testid="batch-send-now"
              >
                Send now
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {asks.length > 0 && (
        <div className="mt-4" data-testid="batch-asks">
          <div className="text-[12.5px] font-medium text-ink-2">Ask a friend</div>
          <p className="text-[12px] text-ink-3 mt-0.5 mb-2">
            These people are reached through a friend, so the ask goes to the friend, never to them.
          </p>
          <ul className="divide-y divide-line-2">
            {asks.map((a) => (
              <li
                key={a.id}
                className="py-2.5 flex flex-col gap-2 lg:flex-row lg:items-start lg:gap-3"
                data-testid="batch-ask"
              >
                <div className="min-w-0 flex-1 text-[13.5px]">
                  <div>
                    <span className="font-medium whitespace-nowrap">{a.friendName}</span>
                    <span className="text-ink-3"> knows </span>
                    <span className="font-medium whitespace-nowrap">{a.targetName}</span>
                    {a.company && <span className="text-ink-3"> at {a.company}</span>}
                  </div>
                  <p className="text-[12.5px] text-ink-3 mt-0.5 line-clamp-2">{a.note}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1 lg:shrink-0">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void ask(a, false)}
                    data-testid="batch-ask-skip"
                  >
                    Not now
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void ask(a, true)}
                    data-testid="batch-ask-send"
                  >
                    Ask {a.friendName.split(' ')[0]}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
