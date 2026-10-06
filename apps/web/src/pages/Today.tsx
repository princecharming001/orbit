import type { Suggestion } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { SuggestionCard } from '../components/SuggestionCard';
import { db } from '../db/schema';
import { ensureDrafts, generateBrief, revalidatePending } from '../engine/brief';
import { useSession } from '../state/session';
import { Avatar, Button, Card, EmptyState, relDate, Spinner, Stat } from '../ui';

export function Today() {
  const { user, userId } = useSession();
  const [busy, setBusy] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const now = new Date();
  // before showing the brief, retire anything that stopped being true since it was made
  useEffect(() => {
    if (userId) revalidatePending(userId).catch(() => undefined);
  }, [userId]);
  const briefs = useLiveQuery(
    () => (userId ? db.briefs.where('userId').equals(userId).toArray() : []),
    [userId],
  );
  const latest = briefs?.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
  const suggestions = useLiveQuery(
    () =>
      userId
        ? db.suggestions
            .where('userId')
            .equals(userId)
            .filter(
              (s) =>
                s.status === 'pending' ||
                (s.status === 'snoozed' && !!s.snoozedUntil && new Date(s.snoozedUntil) <= now),
            )
            .toArray()
        : [],
    [userId],
  );
  const events = useLiveQuery(
    () =>
      userId
        ? db.events
            .where('userId')
            .equals(userId)
            .filter(
              (e) =>
                e.status !== 'cancelled' &&
                new Date(e.startAt) > new Date(Date.now() - 3_600_000) &&
                new Date(e.startAt).getTime() - Date.now() < 7 * 86_400_000 &&
                e.attendeePersonIds.length > 0,
            )
            .toArray()
        : [],
    [userId],
  );
  const people = useLiveQuery(
    () => (userId ? db.people.where('userId').equals(userId).toArray() : []),
    [userId],
  );
  const outbound = useLiveQuery(
    () => (userId ? db.outbound.where('userId').equals(userId).toArray() : []),
    [userId],
  );
  const chats = useLiveQuery(
    () => (userId ? db.chats.where('userId').equals(userId).toArray() : []),
    [userId],
  );
  const settings = useLiveQuery(() => (userId ? db.settings.get(userId) : undefined), [userId]);
  const integrations = useLiveQuery(
    () => (userId ? db.integrations.where('userId').equals(userId).toArray() : []),
    [userId],
  );
  if (!user || !suggestions || !people)
    return (
      <div className="py-20 flex justify-center">
        <Spinner />
      </div>
    );
  const byId = new Map(people.map((p) => [p.id, p]));
  const live = suggestions.filter((s) => stillTrue(s, now));
  const inBrief = latest ? live.filter((s) => latest.suggestionIds.includes(s.id)) : [];
  const rest = live.filter((s) => !s.deferred && (!latest || !latest.suggestionIds.includes(s.id)));
  const cards = [...inBrief, ...rest].sort((a, b) => b.priorityScore - a.priorityScore);
  const more = live
    .filter((s) => s.deferred && !latest?.suggestionIds.includes(s.id))
    .sort((a, b) => b.priorityScore - a.priorityScore);
  const openMore = async () => {
    setShowMore(true);
    await ensureDrafts(
      user,
      more.map((s) => s.id),
    );
  };
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  weekStart.setHours(0, 0, 0, 0);
  const sentThisWeek = (outbound ?? []).filter(
    (o) => o.status === 'sent' && o.kind === 'outreach' && o.sentAt && new Date(o.sentAt) >= weekStart,
  ).length;
  const sent30 = (outbound ?? []).filter(
    (o) =>
      o.status === 'sent' &&
      o.kind === 'outreach' &&
      o.sentAt &&
      now.getTime() - new Date(o.sentAt).getTime() < 30 * 86_400_000,
  );
  const replied30 = sent30.filter((o) =>
    (chats ?? []).some(
      (c) => c.personId === o.personId && c.lastInboundAt && o.sentAt && c.lastInboundAt > o.sentAt,
    ),
  ).length;
  const completed = (chats ?? []).filter((c) => c.completedAt).length;
  const problems = (integrations ?? []).filter((i) => i.status === 'needs_reauth' || i.status === 'error');
  const regenerate = async () => {
    setBusy(true);
    await generateBrief(user, 'daily');
    setBusy(false);
  };
  const hour = now.getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <div className="text-ink-3 text-[13px]">
            {now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          </div>
          <h1 className="text-[24px] font-semibold tracking-[-0.01em] mt-0.5">
            {greet}, {user.firstName || 'there'}
          </h1>
          <p className="text-ink-2 mt-1">{latest?.summaryText ?? 'Your first brief will appear here.'}</p>
        </div>
        <Button onClick={regenerate} disabled={busy} title="Re-run the rules now">
          <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>
      {problems.length > 0 && (
        <Card className="mb-4 border-warn/40 bg-warn-soft">
          {problems.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 text-[13.5px]">
              <span>
                <strong className="font-medium">{p.provider === 'google' ? 'Google' : p.provider}</strong>{' '}
                needs attention{p.lastError ? `: ${p.lastError}` : ''}.
              </span>
              <Link to="/settings/integrations" className="text-accent font-medium">
                Fix
              </Link>
            </div>
          ))}
        </Card>
      )}
      <div className="grid lg:grid-cols-[1fr_300px] gap-6 items-start">
        <div className="space-y-3">
          {cards.length === 0 && (
            <EmptyState
              title="Nothing to do right now"
              body="Your network is in good shape. New replies, meetings and notes will add cards here as they come in."
              action={
                <Link to="/discover">
                  <Button variant="primary">Find people to meet</Button>
                </Link>
              }
            />
          )}
          {cards.map((s) => (
            <SuggestionCard key={s.id} s={s} />
          ))}
          {more.length > 0 && !showMore && (
            <Button onClick={openMore} data-testid="today-more">
              {more.length} more suggestion{more.length === 1 ? '' : 's'}
            </Button>
          )}
          {showMore && more.map((s) => <SuggestionCard key={s.id} s={s} />)}
        </div>
        <div className="space-y-4">
          <Card>
            <div className="font-medium mb-3">Upcoming</div>
            {!events?.length && <p className="text-[13px] text-ink-3">No chats in the next 7 days.</p>}
            <ul className="space-y-2.5">
              {events
                ?.sort((a, b) => a.startAt.localeCompare(b.startAt))
                .map((e) => {
                  const p = byId.get(e.attendeePersonIds[0]!);
                  return (
                    <li key={e.id} className="flex items-center gap-2.5">
                      {p && <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={28} />}
                      <div className="min-w-0 flex-1">
                        <Link
                          to={p ? `/people/${p.id}?tab=prep` : '#'}
                          className="block text-[13.5px] font-medium truncate hover:underline"
                        >
                          {p?.displayName ?? e.title}
                        </Link>
                        <div className="text-[12px] text-ink-3 truncate">
                          {new Date(e.startAt).toLocaleString('en-US', {
                            weekday: 'short',
                            hour: 'numeric',
                            minute: '2-digit',
                          })}{' '}
                          · {relDate(e.startAt, now)}
                        </div>
                      </div>
                    </li>
                  );
                })}
            </ul>
          </Card>
          <Card>
            <div className="font-medium mb-3">This week</div>
            <div className="grid grid-cols-2 gap-4">
              <Stat
                label="Outreach"
                value={
                  <span>
                    {sentThisWeek}
                    <span className="text-ink-3 text-[14px] font-normal">
                      {' '}
                      / {settings?.weeklyOutreachTarget ?? 4}
                    </span>
                  </span>
                }
                hint="sent vs target"
              />
              <Stat
                label="Reply rate"
                value={sent30.length ? `${Math.round((replied30 / sent30.length) * 100)}%` : '—'}
                hint="last 30 days"
              />
              <Stat label="Chats done" value={completed} hint="this season" />
              <Stat
                label="People"
                value={people.filter((p) => p.isHuman && !p.hiddenAt).length}
                hint="in your orbit"
              />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/** Cards whose moment has passed are hidden at once, even before the engine retires them. */
function stillTrue(s: Suggestion, now: Date): boolean {
  if (s.kind === 'schedule_confirm') {
    const start = (s.payload.time as { startIso?: string } | undefined)?.startIso;
    if (start && new Date(start) <= now) return false;
  }
  if (s.kind === 'prep_brief') {
    const start = s.signals.startAt as string | undefined;
    if (start && new Date(start) <= now) return false;
  }
  return true;
}
