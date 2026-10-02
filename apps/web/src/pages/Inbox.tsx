import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { KIND_LABEL, SuggestionCard } from '../components/SuggestionCard';
import { db } from '../db/schema';
import { useSession } from '../state/session';
import { Avatar, Chip, EmptyState, PageHeader, relDate, Tabs } from '../ui';

export function InboxPage() {
  const { userId } = useSession();
  const [tab, setTab] = useState<'pending' | 'snoozed' | 'sent'>('pending');
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
              .filter((o) => o.status === 'sent')
              .toArray()
          : [],
      [userId],
    ) ?? [];
  const people =
    useLiveQuery(() => (userId ? db.people.where('userId').equals(userId).toArray() : []), [userId]) ?? [];
  const byId = new Map(people.map((p) => [p.id, p]));
  const pending = suggestions
    .filter((s) => s.status === 'pending')
    .sort((a, b) => b.priorityScore - a.priorityScore);
  const snoozed = suggestions
    .filter((s) => s.status === 'snoozed')
    .sort((a, b) => (a.snoozedUntil ?? '').localeCompare(b.snoozedUntil ?? ''));
  const sent = outbound.sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? ''));
  return (
    <div>
      <PageHeader title="Approvals" subtitle="Everything waiting on you, plus what Orbit has sent." />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'pending', label: 'Pending', count: pending.length },
          { value: 'snoozed', label: 'Snoozed', count: snoozed.length },
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
          <EmptyState title="Inbox zero" body="No suggestions waiting." />
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
                      <Chip>{o.kind.replace('_', ' ')}</Chip>
                      <Chip>{o.channel}</Chip>
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
