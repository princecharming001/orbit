/**
 * Tomorrow's batch (plan 29 §B1): the messages Orbit will send in the morning unless the student holds one. Hold puts
 * one back as a draft; Edit opens the person's page where the draft lives; Send now sends it at once. In local mode
 * the batch is this browser's scheduled sends, with the honest line that Orbit sends while it is open.
 */
import type { AutopilotItem } from '@orbit/core';
import { MESSAGE_KIND_LABELS } from '@orbit/core';
import { Link } from 'react-router-dom';
import { db } from '../../db/schema';
import { holdSend } from '../../engine/autopilotMode';
import { approveAndSend } from '../../engine/send';
import { callApi, isServerUser } from '../../integrations/orbitApi';
import { useSession } from '../../state/session';
import { Button, Card, Chip, useToast } from '../../ui';
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
  if (!user || !items.length) return null;
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
    <Card className="mb-5" data-testid="tomorrow-batch">
      <div className="font-medium">Tomorrow's batch</div>
      <p className="text-[12px] text-ink-3 mt-0.5 mb-3">
        {view.local
          ? `${items.length === 1 ? 'This goes' : 'These go'} at the times shown, in each person's morning. ${view.note ?? ''}`
          : `${items.length === 1 ? 'This goes' : 'These go'} in the morning, each in the person's own time, unless you hold it.`}
      </p>
      <ul className="divide-y divide-line">
        {items.map((i) => (
          <li key={i.draftId} className="py-2.5 flex items-start gap-3" data-testid="batch-item">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13.5px] flex-wrap">
                {i.personId ? (
                  <Link to={`/people/${i.personId}`} className="font-medium hover:underline">
                    {i.personName}
                  </Link>
                ) : (
                  <span className="font-medium">{i.personName}</span>
                )}
                {i.company && <span className="text-ink-3">{i.company}</span>}
                <Chip>{MESSAGE_KIND_LABELS[i.kind]}</Chip>
                <span className="ml-auto text-[12.5px] text-ink-2 tabular" data-testid="batch-when">
                  {when(i.sendAt, user.timezone)} their time
                </span>
              </div>
              {i.subject && <p className="text-[13px] text-ink-3 mt-0.5 line-clamp-1">{i.subject}</p>}
            </div>
            <div className="flex items-center gap-1 shrink-0">
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
              <Button size="sm" onClick={() => void sendNow(i)} data-testid="batch-send-now">
                Send now
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
