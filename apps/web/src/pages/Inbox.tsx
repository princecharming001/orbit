import type { OutboundMessage, Person } from '@orbit/core';
import { CHANNEL_LABELS, MESSAGE_KIND_LABELS } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { runApproval } from '../components/approve';
import { DraftEditor, OutboxStatus } from '../components/DraftEditor';
import { KIND_LABEL, SuggestionCard } from '../components/SuggestionCard';
import { db } from '../db/schema';
import { ensureDrafts } from '../engine/brief';
import { draftLists, startedDrafts } from '../engine/today';
import { useSession } from '../state/session';
import { Avatar, Button, Chip, EmptyState, PageHeader, relDate, Tabs, useToast } from '../ui';

const IN_FLIGHT: OutboundMessage['status'][] = ['queued', 'sending', 'handed_off', 'failed'];

export function InboxPage() {
  const { user, userId } = useSession();
  const [tab, setTab] = useState<'pending' | 'snoozed' | 'outbox' | 'sent'>();
  const [showLater, setShowLater] = useState(false);
  const briefs = useLiveQuery(
    () => (userId ? db.briefs.where('userId').equals(userId).toArray() : []),
    [userId],
  );
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
              .filter((o) => o.status === 'sent' || o.status === 'draft' || IN_FLIGHT.includes(o.status))
              .toArray()
          : [],
      [userId],
    ) ?? [];
  const people =
    useLiveQuery(() => (userId ? db.people.where('userId').equals(userId).toArray() : []), [userId]) ?? [];
  const byId = new Map(people.map((p) => [p.id, p]));
  // Drafts holds the messages Orbit wrote for the student; other cards (prep, warm-ups, confirmations) live on Today.
  // A draft already opened in the mail app or LinkedIn is under "Not sent yet", not here as well.
  const latest = (briefs ?? []).sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
  const { forToday, later } = draftLists(suggestions, outbound, latest, new Date());
  const pending = [...forToday, ...later];
  const started = startedDrafts(outbound);
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
  // a message opened in the mail app or LinkedIn and not marked as sent comes first: it is waiting on the student
  const shown =
    tab ?? (outbox.some((o) => o.status === 'handed_off' || o.status === 'failed') ? 'outbox' : 'pending');
  return (
    <div>
      <PageHeader
        title="Drafts"
        subtitle="Every message Orbit wrote for you, in one place. Read it, edit it, and send it yourself. The same drafts show on Today, next to prep and warm-ups."
      />
      <Tabs
        value={shown}
        onChange={setTab}
        items={[
          { value: 'pending', label: 'Ready to send', count: forToday.length + started.length },
          { value: 'outbox', label: 'Not sent yet', count: outbox.length },
          { value: 'snoozed', label: 'Snoozed', count: snoozed.length },
          { value: 'sent', label: 'Sent', count: sent.length },
        ]}
      />
      {shown === 'pending' && started.length > 0 && (
        <div className="space-y-2 mb-5" data-testid="drafts-started">
          <div className="text-[12px] uppercase tracking-wide text-ink-3">Started by you, not sent yet</div>
          {started.map((o) => (
            <StartedItem key={o.id} o={o} person={byId.get(o.personId)} />
          ))}
        </div>
      )}
      {shown === 'pending' &&
        (pending.length ? (
          <div className="space-y-3">
            {forToday.length === 0 && (
              <p className="text-[13px] text-ink-3">Nothing to send today. The drafts below can wait.</p>
            )}
            {forToday.map((s) => (
              <SuggestionCard key={s.id} s={s} compact />
            ))}
            {later.length > 0 &&
              (showLater ? (
                <>
                  <div className="flex items-center gap-3 pt-2">
                    <span className="text-[12px] uppercase tracking-wide text-ink-3">Can wait</span>
                    <button
                      className="text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink"
                      onClick={() => setShowLater(false)}
                    >
                      Hide them
                    </button>
                  </div>
                  {later.map((s) => (
                    <SuggestionCard key={s.id} s={s} compact />
                  ))}
                </>
              ) : (
                <Button onClick={() => setShowLater(true)} data-testid="drafts-later">
                  Show {later.length} that can wait
                </Button>
              ))}
          </div>
        ) : (
          !started.length && (
            <EmptyState
              title="No drafts right now"
              body="When a follow-up or a thank-you is due, Orbit drafts the message and it waits here for you. A message you start on someone's page waits here too until you send it."
            />
          )
        ))}
      {shown === 'snoozed' &&
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
      {shown === 'outbox' &&
        (outbox.length ? (
          <div className="space-y-3">
            <p className="text-[13px] text-ink-3">
              Messages you opened in your mail app or LinkedIn but have not marked as sent, and any that could
              not be sent. Press I sent it once a message is out, so Orbit can follow up at the right time.
            </p>
            {outbox.map((o) => (
              <OutboxItem key={o.id} o={o} person={byId.get(o.personId)} />
            ))}
          </div>
        ) : (
          <EmptyState
            title="Nothing waiting"
            body="A message you open in your mail app or LinkedIn waits here until you press I sent it."
          />
        ))}
      {shown === 'sent' &&
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

/** A draft the student started on a person's page: open it there to keep writing, or drop it. */
function StartedItem({ o, person }: { o: OutboundMessage; person?: Person }) {
  const toast = useToast();
  return (
    <div className="border border-line rounded-[var(--radius-card)] p-3" data-testid="started-draft">
      <div className="flex items-center gap-2 text-[13.5px] flex-wrap">
        {person && <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={26} />}
        <Link to={person ? `/people/${person.id}` : '#'} className="font-medium">
          {person?.displayName ?? 'Unknown'}
        </Link>
        <Chip>{MESSAGE_KIND_LABELS[o.kind]}</Chip>
        <span className="text-ink-3 text-[12px] ml-auto">started {relDate(o.createdAt)}</span>
      </div>
      <p className="text-[13px] text-ink-2 mt-1.5 line-clamp-2 whitespace-pre-line">
        {o.bodyFinal ?? o.bodyDraft}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {person && (
          <Link to={`/people/${person.id}?open=${o.id}`}>
            <Button size="sm" variant="primary">
              Continue writing
            </Button>
          </Link>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            await db.outbound.update(o.id, { status: 'cancelled' });
            toast.push({
              text: 'Draft discarded.',
              action: { label: 'Undo', onClick: () => db.outbound.update(o.id, { status: 'draft' }) },
              ttl: 7000,
            });
          }}
        >
          Discard draft
        </Button>
      </div>
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
