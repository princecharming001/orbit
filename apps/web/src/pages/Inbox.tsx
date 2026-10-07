import type { OutboundMessage, Person } from '@orbit/core';
import { CHANNEL_LABELS, MESSAGE_KIND_LABELS } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { runApproval } from '../components/approve';
import { DraftEditor, OutboxStatus } from '../components/DraftEditor';
import { KIND_LABEL, SuggestionCard } from '../components/SuggestionCard';
import { db } from '../db/schema';
import { ensureDrafts, isMessageSuggestion } from '../engine/brief';
import { useSession } from '../state/session';
import { Avatar, Chip, EmptyState, PageHeader, relDate, Tabs, useToast } from '../ui';

const IN_FLIGHT: OutboundMessage['status'][] = ['queued', 'sending', 'handed_off', 'failed'];

export function InboxPage() {
  const { user, userId } = useSession();
  const [tab, setTab] = useState<'pending' | 'snoozed' | 'outbox' | 'sent'>('pending');
  const suggestions =
    useLiveQuery(() => (userId ? db.suggestions.where('userId').equals(userId).toArray() : []), [userId]) ??
    [];
  const outbound =
    useLiveQuery(
      () =>
        userId
          ? db.outbound
              .where('userId')
              .equals(userId)
              .filter((o) => o.status === 'sent' || IN_FLIGHT.includes(o.status))
              .toArray()
          : [],
      [userId],
    ) ?? [];
  const people =
    useLiveQuery(() => (userId ? db.people.where('userId').equals(userId).toArray() : []), [userId]) ?? [];
  const byId = new Map(people.map((p) => [p.id, p]));
  // Approvals holds messages waiting for the student's OK; other cards (prep, warm-ups, confirmations) live on Today
  const pending = suggestions
    .filter((s) => s.status === 'pending' && isMessageSuggestion(s.kind))
    .sort((a, b) => b.priorityScore - a.priorityScore);
  const undrafted = pending
    .filter((s) => !s.outboundMessageId)
    .map((s) => s.id)
    .join(',');
  // cards kept for later have no draft yet: write them now, so every card here has something to approve
  useEffect(() => {
    if (user && undrafted) ensureDrafts(user, undrafted.split(',')).catch(() => undefined);
  }, [user, undrafted]);
  const snoozed = suggestions
    .filter((s) => s.status === 'snoozed')
    .sort((a, b) => (a.snoozedUntil ?? '').localeCompare(b.snoozedUntil ?? ''));
  const sent = outbound
    .filter((o) => o.status === 'sent')
    .sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? ''));
  const outbox = outbound
    .filter((o) => IN_FLIGHT.includes(o.status))
    .sort((a, b) => (b.queuedAt ?? b.createdAt).localeCompare(a.queuedAt ?? a.createdAt));
  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle="Messages Orbit drafted for you to check and send. Nothing goes out until you approve it. Other cards, like prep and warm-ups, are on Today."
      />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'pending', label: 'To approve', count: pending.length },
          { value: 'snoozed', label: 'Snoozed', count: snoozed.length },
          { value: 'outbox', label: 'In progress', count: outbox.length },
          { value: 'sent', label: 'Sent', count: sent.length },
        ]}
      />
      {tab === 'pending' &&
        (pending.length ? (
          <div className="space-y-3">
            {pending.map((s) => (
              <SuggestionCard key={s.id} s={s} compact />
            ))}
          </div>
        ) : (
          <EmptyState
            title="No messages to approve"
            body="When a reply comes in or a follow-up is due, Orbit drafts the message and it waits here for you."
          />
        ))}
      {tab === 'snoozed' &&
        (snoozed.length ? (
          <ul className="divide-y divide-line border border-line rounded-[var(--radius-card)]">
            {snoozed.map((s) => {
              const p = s.personId ? byId.get(s.personId) : undefined;
              return (
                <li key={s.id} className="p-3 flex items-center gap-3">
                  <Chip tone={KIND_LABEL[s.kind].tone}>{KIND_LABEL[s.kind].label}</Chip>
                  <span className="text-[13.5px] flex-1 truncate">
                    {p ? (
                      <Link to={`/people/${p.id}`} className="font-medium">
                        {p.displayName}
                      </Link>
                    ) : null}{' '}
                    <span className="text-ink-3">{s.reasonText}</span>
                  </span>
                  <span className="text-[12px] text-ink-3">back {relDate(s.snoozedUntil)}</span>
                  <button
                    className="text-[12px] text-accent"
                    onClick={() =>
                      db.suggestions.update(s.id, { status: 'pending', snoozedUntil: undefined })
                    }
                  >
                    Unsnooze
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title="Nothing snoozed" />
        ))}
      {tab === 'outbox' &&
        (outbox.length ? (
          <div className="space-y-3">
            <p className="text-[13px] text-ink-3">
              Approved messages that have not gone out yet: waiting out the undo window, opened in your mail
              app or LinkedIn and not marked as sent, or stopped by a problem.
            </p>
            {outbox.map((o) => (
              <OutboxItem key={o.id} o={o} person={byId.get(o.personId)} />
            ))}
          </div>
        ) : (
          <EmptyState
            title="Nothing in progress"
            body="Approved messages wait here until they are sent: while the undo window runs, or after Orbit opens them in your mail app or LinkedIn and before you mark them as sent."
          />
        ))}
      {tab === 'sent' &&
        (sent.length ? (
          <ul className="divide-y divide-line border border-line rounded-[var(--radius-card)]">
            {sent.map((o) => {
              const p = byId.get(o.personId);
              return (
                <li key={o.id} className="p-3 flex items-start gap-3">
                  {p && <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={30} />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[13.5px]">
                      <Link to={p ? `/people/${p.id}` : '#'} className="font-medium">
                        {p?.displayName ?? 'Unknown'}
                      </Link>
                      <Chip>{MESSAGE_KIND_LABELS[o.kind]}</Chip>
                      <Chip>{CHANNEL_LABELS[o.channel]}</Chip>
                      <span className="text-ink-3 ml-auto text-[12px]">{relDate(o.sentAt)}</span>
                    </div>
                    <p className="text-[13px] text-ink-2 mt-1 line-clamp-2 whitespace-pre-line">
                      {o.bodyFinal ?? o.bodyDraft}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title="Nothing sent yet" />
        ))}
    </div>
  );
}

function OutboxItem({ o, person }: { o: OutboundMessage; person?: Person }) {
  const { user } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  return (
    <div className="border border-line rounded-[var(--radius-card)] p-3" data-testid="outbox-item">
      <div className="flex items-center gap-2 text-[13.5px] mb-2">
        {person && <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={26} />}
        <Link to={person ? `/people/${person.id}` : '#'} className="font-medium">
          {person?.displayName ?? 'Unknown'}
        </Link>
        <Chip>{MESSAGE_KIND_LABELS[o.kind]}</Chip>
        <Chip>{CHANNEL_LABELS[o.channel]}</Chip>
        {o.status === 'failed' && <Chip tone="bad">Not sent</Chip>}
      </div>
      {o.status === 'failed' ? (
        <DraftEditor
          draft={o}
          busy={busy}
          approveLabel="Try again"
          onApprove={async (body, subject) => {
            setBusy(true);
            try {
              return await runApproval(user, o, body, subject, toast, person?.firstName);
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : (
        <OutboxStatus draft={o} />
      )}
    </div>
  );
}
