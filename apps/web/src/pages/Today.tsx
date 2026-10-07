import { useLiveQuery } from 'dexie-react-hooks';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AddPersonButton } from '../components/AddPerson';
import { LinkedInImportButton } from '../components/LinkedInImport';
import { SuggestionCard } from '../components/SuggestionCard';
import { db } from '../db/schema';
import { ensureDrafts, generateBrief, revalidatePending } from '../engine/brief';
import { todayCards, todaySummaryText } from '../engine/today';
import { googleClientId } from '../integrations/google';
import { useHints } from '../state/hints';
import { useSession } from '../state/session';
import { Avatar, Button, Card, EmptyState, FirstRunHint, relDate, Spinner, Stat, useToast } from '../ui';

const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  linkedin_csv: 'LinkedIn import',
  granola: 'Granola',
  fathom: 'Fathom',
  wispr_export: 'Wispr Flow',
  tracker_import: 'Tracker import',
  demo: 'Demo data',
};

export function Today() {
  const { user, userId } = useSession();
  const [busy, setBusy] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [params] = useSearchParams();
  // a link that points at one card (a warm-up just started, a pipeline next step): show it and outline it
  const focusCard = params.get('card') ?? undefined;
  const focusPerson = params.get('person') ?? undefined;
  const toast = useToast();
  const hints = useHints();
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
  const targets = useLiveQuery(
    () => (userId ? db.targetCompanies.where('userId').equals(userId).toArray() : []),
    [userId],
  );
  // a card id wins; for a person, the newest of their cards (the warm-up step just started, the thank-you just drafted)
  const focused =
    (suggestions ?? []).find((s) => s.id === focusCard) ??
    (focusPerson
      ? (suggestions ?? [])
          .filter((s) => s.personId === focusPerson)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      : undefined);
  // the card a link points at may be one kept for later: open that list so it is on screen
  useEffect(() => {
    if (focused?.deferred) setShowMore(true);
  }, [focused?.id, focused?.deferred]);
  if (!user || !suggestions || !people)
    return (
      <div className="py-20 flex justify-center">
        <Spinner />
      </div>
    );
  const byId = new Map(people.map((p) => [p.id, p]));
  const { cards, more } = todayCards(suggestions, latest, now);
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
  const visiblePeople = people.filter((p) => p.isHuman && !p.hiddenAt).length;
  // counted from the cards on screen, so the line never disagrees with them
  const summary = latest
    ? todaySummaryText(cards, events ?? [], visiblePeople, now)
    : 'Your first brief will appear here.';
  const problems = (integrations ?? []).filter((i) => i.status === 'needs_reauth' || i.status === 'error');
  const regenerate = async () => {
    setBusy(true);
    try {
      const b = await generateBrief(user, 'daily');
      toast.push({
        text: `Updated from your latest email, calendar and notes. ${b.suggestionIds.length} card${b.suggestionIds.length === 1 ? '' : 's'} in today's brief.`,
      });
    } finally {
      setBusy(false);
    }
  };
  const googleReady = !!googleClientId();
  const hour = now.getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-5">
        <div className="min-w-0">
          <div className="text-ink-3 text-[13px]">
            {now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          </div>
          <h1 className="text-[24px] font-semibold tracking-[-0.01em] mt-0.5">
            {greet}, {user.firstName || 'there'}
          </h1>
          <p className="text-ink-2 mt-1" data-testid="today-summary">
            {summary}
          </p>
        </div>
        {/* with nobody in Orbit yet there is nothing to refresh */}
        {visiblePeople > 0 && (
          <Button
            onClick={regenerate}
            disabled={busy}
            title="Rebuild today's brief from your latest email, calendar and notes"
            aria-label="Refresh"
            className="shrink-0 px-2.5 sm:px-3.5"
            data-testid="today-refresh"
          >
            <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />{' '}
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        )}
      </div>
      {problems.length > 0 && (
        <Card className="mb-4 border-warn/40 bg-warn-soft">
          {problems.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 text-[13.5px]">
              <span>
                <strong className="font-medium">{PROVIDER_LABELS[p.provider] ?? 'An integration'}</strong>{' '}
                needs attention{p.lastError ? `: ${p.lastError}` : ''}.
              </span>
              <Link to="/settings/integrations" className="text-accent font-medium">
                Fix
              </Link>
            </div>
          ))}
        </Card>
      )}
      {cards.length > 0 && (
        <FirstRunHint
          id="today"
          title="How Today works"
          dismissed={hints.seen('today')}
          onDismiss={hints.dismiss}
        >
          Each card is one thing worth doing, most urgent first, with the reason under the name. Open a draft
          to read and edit it: nothing is sent until you approve it. Snooze a card to see it again later, or
          dismiss it if it is wrong.
        </FirstRunHint>
      )}
      <div className="grid lg:grid-cols-[minmax(0,1fr)_300px] gap-6 items-start">
        <div className="space-y-3 min-w-0">
          {cards.length === 0 &&
            (visiblePeople === 0 ? (
              <div
                className="border border-dashed border-line rounded-[var(--radius-card)] p-6"
                data-testid="today-empty-network"
              >
                <p className="font-medium">Add the first people you want to talk to</p>
                <p className="text-ink-3 mt-1 text-[13px] max-w-xl">
                  Orbit works from the people you add: an alum at a target company, a friend's older sibling,
                  a speaker from a club event. Add one by hand, or bring in everyone at once from your
                  LinkedIn connections.
                  {googleReady ? ' Connecting Google also finds the people you already email and meet.' : ''}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <AddPersonButton variant="primary" />
                  <LinkedInImportButton />
                  <Link
                    to="/settings/integrations"
                    className="self-center text-[13px] text-ink-3 underline underline-offset-2 hover:text-ink"
                  >
                    How to get the LinkedIn file
                  </Link>
                  {googleReady && (
                    <Link to="/settings/integrations">
                      <Button variant="ghost">Connect Google</Button>
                    </Link>
                  )}
                </div>
                {(targets ?? []).length > 0 && (
                  <div className="mt-5 pt-4 border-t border-line-2">
                    <p className="text-[13px] text-ink-2">
                      Know someone at a company on your list? Add them and Orbit helps you write the first
                      message.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {(targets ?? []).slice(0, 6).map((t) => (
                        <AddPersonButton
                          key={t.id}
                          label={`Someone at ${t.nameRaw}`}
                          company={t.nameRaw}
                          variant="ghost"
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <EmptyState
                title="Nothing needs you right now"
                body="New replies, meetings and notes add cards here as they come in. In the meantime, pick someone new to talk to."
                action={
                  <Link to="/discover">
                    <Button variant="primary">Find people to meet</Button>
                  </Link>
                }
              />
            ))}
          {cards.map((s) => (
            <SuggestionCard key={s.id} s={s} highlight={s.id === focused?.id} />
          ))}
          {more.length > 0 && !showMore && (
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button onClick={openMore} data-testid="today-more">
                Show {more.length} more that can wait
              </Button>
              <span className="text-[12px] text-ink-3">
                Orbit puts the few most useful first, so today stays short.
              </span>
            </div>
          )}
          {showMore && (
            <>
              <div className="text-[12px] uppercase tracking-wide text-ink-3 pt-2">Can wait</div>
              {more.map((s) => (
                <SuggestionCard key={s.id} s={s} highlight={s.id === focused?.id} />
              ))}
            </>
          )}
        </div>
        <div className="space-y-4 min-w-0">
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
                label="First messages"
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
              <Stat label="People" value={visiblePeople} hint="in your orbit" />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
