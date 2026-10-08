import { MESSAGE_KIND_LABELS, warmUpProgress } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AddPersonButton } from '../components/AddPerson';
import { handoffWhere, OutboxStatus } from '../components/DraftEditor';
import { LinkedInImportButton } from '../components/LinkedInImport';
import { SuggestionCard } from '../components/SuggestionCard';
import { db } from '../db/schema';
import { ensureDrafts, generateBrief, revalidatePending } from '../engine/brief';
import { moveChat } from '../engine/move';
import { notYetWritten, startedDrafts, todayCards, todaySummaryText } from '../engine/today';
import { googleClientId } from '../integrations/google';
import { useHints } from '../state/hints';
import { useSession } from '../state/session';
import { Avatar, Button, Card, EmptyState, FirstRunHint, relDate, Spinner, Stat, useToast } from '../ui';
import { wentQuiet } from './Pipeline';

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
  const nav = useNavigate();
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
  const recCount = useLiveQuery(
    () =>
      userId
        ? db.recommendations
            .where('userId')
            .equals(userId)
            .filter((r) => r.status === 'new' || r.status === 'saved')
            .count()
        : 0,
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
  // a reply by email, or a chat that moved on (a reply Orbit cannot see without Gmail, logged by the student)
  const MOVED_ON = ['replied', 'scheduling', 'scheduled', 'completed', 'followed_up', 'nurturing'];
  const replied30 = sent30.filter((o) =>
    (chats ?? []).some(
      (c) =>
        c.personId === o.personId &&
        ((c.lastInboundAt && o.sentAt && c.lastInboundAt > o.sentAt) || MOVED_ON.includes(c.stage)),
    ),
  ).length;
  const completed = (chats ?? []).filter((c) => c.completedAt).length;
  const visiblePeople = people.filter((p) => p.isHuman && !p.hiddenAt).length;
  // counted from the cards on screen, so the line never disagrees with them
  const baseSummary = latest
    ? todaySummaryText(cards, events ?? [], visiblePeople, now)
    : 'Your first brief will appear here.';
  const problems = (integrations ?? []).filter((i) => i.status === 'needs_reauth' || i.status === 'error');
  const regenerate = async () => {
    setBusy(true);
    try {
      await generateBrief(user, 'daily');
      // the count is the one in the line under the greeting, so the two never disagree
      toast.push({ text: 'Updated from your latest email, calendar and notes.' });
    } finally {
      setBusy(false);
    }
  };
  // a message opened in the mail app or LinkedIn and not marked as sent: the "I sent it" step must not get lost when
  // the student leaves the page, so it stays here until they answer (unless its own card already shows it)
  const shownDrafts = new Set([...cards, ...(showMore ? more : [])].map((x) => x.outboundMessageId));
  const handedOff = (outbound ?? [])
    .filter((o) => o.status === 'handed_off' && !shownDrafts.has(o.id))
    .sort((a, b) => (b.approvedAt ?? b.createdAt).localeCompare(a.approvedAt ?? a.createdAt));
  // warm-ups under way, so a quiet Today still says who is in progress and when the next step comes
  const warming = (chats ?? [])
    .filter((c) => c.stage === 'warming' && c.warmUp)
    .map((c) => ({
      chat: c,
      // once the warm-up days are over the next thing is the first message, whatever steps are left
      next: warmUpProgress(c.warmUp!, now, user.timezone).ready
        ? undefined
        : c.warmUp!.actions.find((a) => !a.doneAt && !a.skippedAt),
    }))
    .filter((w) => byId.get(w.chat.personId) && !byId.get(w.chat.personId)!.hiddenAt);
  const googleReady = !!googleClientId();
  // without Google, Orbit cannot see replies or meetings: the student tells it, so the words say so
  const googleOn = (integrations ?? []).some((i) => i.provider === 'google' && i.status === 'active');
  // drafts the student started on someone's page and left: they wait here as well as on Drafts
  const started = startedDrafts(outbound ?? []).filter((o) => !byId.get(o.personId)?.hiddenAt);
  // someone added by hand and not written to yet: the next step is to write to them, not to go looking elsewhere
  const toWrite = notYetWritten(people, chats ?? [], outbound ?? [], suggestions, now).slice(0, 3);
  // a message waiting for "I sent it" is something that needs the student: the line never says "nothing needs you"
  // above it
  const summary =
    !cards.length && handedOff.length
      ? `${handedOff.length === 1 ? 'One message you opened to send is' : `${handedOff.length} messages you opened to send are`} waiting for you to say whether ${handedOff.length === 1 ? 'it' : 'they'} went out.`
      : baseSummary;
  // with no cards, the line points at what is on screen instead: a draft to finish, someone to write to
  const nextLine = cards.length
    ? ''
    : started.length
      ? ` You have ${started.length === 1 ? 'a draft' : `${started.length} drafts`} you started and have not sent.`
      : toWrite.length
        ? ` Your next step is a first message to ${toWrite.length === 1 ? toWrite[0]!.firstName : 'the people you added'}.`
        : '';
  // chats waiting on the other person for a week or more; a follow-up card already on Today covers its own chat
  const onToday = new Set([...cards, ...more].map((x) => x.chatId).filter(Boolean));
  const quiet = (chats ?? [])
    .filter(
      (c) =>
        wentQuiet(c, now) && !onToday.has(c.id) && byId.get(c.personId) && !byId.get(c.personId)!.hiddenAt,
    )
    .sort((a, b) => (a.lastOutboundAt ?? '').localeCompare(b.lastOutboundAt ?? ''));
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
            {nextLine}
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
            <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> <span>Refresh</span>
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
          to read and edit it: nothing goes out until you send it yourself. Snooze a card to see it again
          later, or dismiss it if it is wrong.
        </FirstRunHint>
      )}
      <div className="grid lg:grid-cols-[minmax(0,1fr)_300px] gap-6 items-start">
        <div className="space-y-3 min-w-0">
          {handedOff.length > 0 && (
            <div className="space-y-2" data-testid="today-handed-off">
              <div className="text-[12px] uppercase tracking-wide text-ink-3">Did these go out?</div>
              {handedOff.map((o) => {
                const p = byId.get(o.personId);
                return (
                  <div key={o.id} className="bg-canvas border border-line rounded-[var(--radius-card)] p-3">
                    <div className="text-[13.5px] mb-2">
                      {p ? (
                        <Link to={`/people/${p.id}`} className="font-medium hover:underline">
                          {p.displayName}
                        </Link>
                      ) : (
                        'A message'
                      )}{' '}
                      <span className="text-ink-3">
                        · {handoffWhere(o)} {relDate(o.approvedAt ?? o.createdAt)}
                      </span>
                    </div>
                    <OutboxStatus draft={o} />
                  </div>
                );
              })}
            </div>
          )}
          {started.length > 0 && (
            <div className="space-y-2" data-testid="today-started">
              <div className="text-[12px] uppercase tracking-wide text-ink-3">Drafts you started</div>
              {started.slice(0, 3).map((o) => {
                const p = byId.get(o.personId);
                return (
                  <div
                    key={o.id}
                    className="bg-canvas border border-line rounded-[var(--radius-card)] p-3 flex flex-wrap items-center gap-3"
                  >
                    {p && <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={28} />}
                    <div className="min-w-0 flex-1 text-[13.5px]">
                      <span className="font-medium">{p?.displayName ?? 'Someone'}</span>{' '}
                      <span className="text-ink-3">
                        · {MESSAGE_KIND_LABELS[o.kind].toLowerCase()} started {relDate(o.createdAt)}, not sent
                      </span>
                    </div>
                    {p && (
                      <Link to={`/people/${p.id}?open=${o.id}`}>
                        <Button size="sm" variant="primary">
                          Continue writing
                        </Button>
                      </Link>
                    )}
                  </div>
                );
              })}
              {started.length > 3 && (
                <Link to="/inbox" className="text-[13px] text-accent">
                  See all {started.length} on Drafts
                </Link>
              )}
            </div>
          )}
          {visiblePeople > 0 && toWrite.length > 0 && (
            <div
              className="bg-canvas border border-line rounded-[var(--radius-card)] p-4 shadow-[var(--shadow-card)]"
              data-testid="today-to-write"
            >
              <p className="font-medium">Next: write to the people you added</p>
              <p className="text-ink-3 text-[13px] mt-0.5">
                Orbit drafts the first message for you to edit. Nothing goes out until you send it yourself.
              </p>
              <ul className="mt-3 space-y-2">
                {toWrite.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-3">
                    <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={30} />
                    <div className="min-w-0 flex-1">
                      <Link to={`/people/${p.id}`} className="text-[13.5px] font-medium hover:underline">
                        {p.displayName}
                      </Link>
                      <div className="text-[12px] text-ink-3 truncate">
                        {[p.currentTitle, p.currentOrganizationRaw].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    <Link to={`/people/${p.id}?draft=outreach`}>
                      <Button size="sm" variant="primary" data-testid="today-write">
                        Write to {p.firstName}
                      </Button>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {cards.length === 0 &&
            !toWrite.length &&
            !started.length &&
            !handedOff.length &&
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
                    className="self-center text-[13px] text-accent underline underline-offset-2 hover:text-ink"
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
                body={`${
                  warming.length
                    ? `Your warm-up${warming.length > 1 ? 's are' : ' is'} under way; the next step shows up here on its day (see Coming up).`
                    : googleOn
                      ? 'New replies, meetings and notes add cards here as they come in.'
                      : 'Cards show up here when a follow-up or a thank-you is due, after you add notes from a chat, and when you move a chat in Pipeline.'
                } ${
                  recCount
                    ? `Meanwhile, Discover has ${recCount} ${recCount === 1 ? 'person' : 'people'} from your network worth a coffee chat.`
                    : 'Meanwhile, add someone new you want to talk to.'
                }`}
                action={
                  recCount ? (
                    <Link to="/discover">
                      <Button variant="primary">See who to meet</Button>
                    </Link>
                  ) : (
                    <div className="flex flex-wrap justify-center gap-2">
                      <AddPersonButton variant="primary" />
                      <LinkedInImportButton />
                    </div>
                  )
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
              <div className="flex items-center gap-3 pt-2">
                <span className="text-[12px] uppercase tracking-wide text-ink-3">Can wait</span>
                <button
                  className="text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink"
                  onClick={() => setShowMore(false)}
                  data-testid="today-fewer"
                >
                  Show fewer
                </button>
              </div>
              {more.map((s) => (
                <SuggestionCard key={s.id} s={s} highlight={s.id === focused?.id} />
              ))}
            </>
          )}
        </div>
        <div className="space-y-4 min-w-0">
          <Card>
            <div className="font-medium mb-3">Coming up</div>
            {!events?.length && !warming.length && (
              <p className="text-[13px] text-ink-3">No chats in the next 7 days.</p>
            )}
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
              {warming.map(({ chat, next }) => {
                const p = byId.get(chat.personId)!;
                return (
                  <li key={chat.id} className="flex items-center gap-2.5" data-testid="upcoming-warmup">
                    <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={28} />
                    <div className="min-w-0 flex-1">
                      <Link
                        to={`/people/${p.id}`}
                        className="block text-[13.5px] font-medium truncate hover:underline"
                      >
                        {p.displayName}
                      </Link>
                      <div className="text-[12px] text-ink-3 truncate">
                        Warm-up ·{' '}
                        {next
                          ? `next step ${new Date(next.dueAt) <= now ? 'today' : relDate(next.dueAt, now)}`
                          : new Date(chat.warmUp!.readyAt) <= now
                            ? 'first message ready'
                            : `first message ${relDate(chat.warmUp!.readyAt, now)}`}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
          {quiet.length > 0 && (
            <Card data-testid="today-quiet">
              <div className="font-medium">Waiting on a reply</div>
              <p className="text-[12px] text-ink-3 mt-0.5 mb-3">
                You wrote last, a week or more ago.
                {googleOn
                  ? ' Orbit suggests a follow-up when one is due.'
                  : ' Orbit cannot see your inbox or LinkedIn, so when someone answers or accepts, tell it here.'}
              </p>
              <ul className="space-y-2.5">
                {quiet.slice(0, 4).map((c) => {
                  const p = byId.get(c.personId)!;
                  return (
                    <li key={c.id} className="flex items-center gap-2.5">
                      <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={28} />
                      <div className="min-w-0 flex-1">
                        <Link
                          to={`/people/${p.id}`}
                          className="block text-[13.5px] font-medium truncate hover:underline"
                        >
                          {p.displayName}
                        </Link>
                        <div className="text-[12px] text-ink-3">
                          You wrote {relDate(c.lastOutboundAt, now)}
                          {c.outreachChannel === 'linkedin' ? ' on LinkedIn' : ''}
                        </div>
                      </div>
                      <button
                        className="shrink-0 h-8 px-2 rounded-md text-[12px] text-accent hover:bg-canvas-2"
                        onClick={async () => {
                          await moveChat(user, c, 'replied', 'user:replied');
                          toast.push({
                            text: `Moved ${p.firstName} to Replied. Your reply to ${p.firstName} is now a card here.`,
                            action: { label: 'Show it', onClick: () => nav(`/today?person=${p.id}`) },
                            ttl: 7000,
                          });
                        }}
                        data-testid="today-quiet-replied"
                      >
                        They replied
                      </button>
                    </li>
                  );
                })}
              </ul>
              <Link to="/pipeline?quiet=1" className="mt-3 inline-block text-[12px] text-accent">
                {quiet.length > 4 ? `All ${quiet.length} in Pipeline` : 'See them in Pipeline'}
              </Link>
            </Card>
          )}
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
                      of {settings?.weeklyOutreachTarget ?? 4}
                    </span>
                  </span>
                }
                hint="your weekly goal"
              />
              <Stat
                label="Reply rate"
                value={sent30.length >= 3 ? `${Math.round((replied30 / sent30.length) * 100)}%` : '—'}
                hint={sent30.length >= 3 ? 'last 30 days' : 'after 3 first messages'}
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
