import type { CalendarEvent, CoffeeChat, OutboundMessage, Person } from '@orbit/core';
import { CHANNEL_LABELS, MESSAGE_KIND_LABELS, warmUpProgress } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { runApproval } from '../components/approve';
import { DraftEditor, OutboxStatus } from '../components/DraftEditor';
import { KIND_LABEL, SuggestionCard } from '../components/SuggestionCard';
import { db } from '../db/schema';
import { ensureDrafts, generateBrief, isMessageSuggestion, revalidatePending } from '../engine/brief';
import { discardDraft, restoreDraft, unsnoozeSuggestion } from '../engine/drafts';
import { moveChat } from '../engine/move';
import { wentQuiet } from '../engine/pipeline';
import { draftLists, notYetWritten, startedDrafts, todayCards } from '../engine/today';
import { useHints } from '../state/hints';
import { useSession } from '../state/session';
import {
  Avatar,
  Button,
  Card,
  Chip,
  EmptyState,
  FirstRunHint,
  PageHeader,
  relDate,
  Tabs,
  useToast,
} from '../ui';

const IN_FLIGHT: OutboundMessage['status'][] = ['queued', 'sending', 'handed_off', 'failed'];

const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  linkedin_csv: 'LinkedIn import',
  granola: 'Granola',
  fathom: 'Fathom',
  wispr_export: 'Wispr Flow',
  tracker_import: 'Tracker import',
  demo: 'Demo data',
};

/**
 * Drafts: every message Orbit wrote for the student and the other cards that need them today (prep, warm-up steps,
 * questions to answer), what was opened in the mail app and not marked sent, who is waiting on a reply, and what is
 * coming up. A link to one card (`?card=`) or to a person's newest card (`?person=`) opens it here and outlines it.
 */
export function InboxPage() {
  const { user, userId } = useSession();
  const [tab, setTab] = useState<'pending' | 'snoozed' | 'outbox' | 'sent'>();
  const [showLater, setShowLater] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [params] = useSearchParams();
  // a link that points at one card (a warm-up just started, a board's next step): show it and outline it
  const focusCard = params.get('card') ?? undefined;
  const focusPerson = params.get('person') ?? undefined;
  const toast = useToast();
  const nav = useNavigate();
  const hints = useHints();
  const now = new Date();
  // before showing the cards, retire anything that stopped being true since they were made
  useEffect(() => {
    if (userId) revalidatePending(userId).catch(() => undefined);
  }, [userId]);
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
  const chats =
    useLiveQuery(() => (userId ? db.chats.where('userId').equals(userId).toArray() : []), [userId]) ?? [];
  const events =
    useLiveQuery(
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
    ) ?? [];
  const integrations = useLiveQuery(
    () => (userId ? db.integrations.where('userId').equals(userId).toArray() : []),
    [userId],
  );
  const byId = new Map(people.map((p) => [p.id, p]));
  // A draft already opened in the mail app or LinkedIn is under "Opened, not marked sent", not under To send as well.
  const latest = (briefs ?? []).sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
  const { forToday, later } = draftLists(suggestions, outbound, latest, now);
  const pending = [...forToday, ...later];
  const started = startedDrafts(outbound).filter((o) => !byId.get(o.personId)?.hiddenAt);
  // the cards that are not a message to send (prep, a warm-up step, a question to answer), the brief's first
  const live = suggestions.filter(
    (s) =>
      s.status === 'pending' ||
      (s.status === 'snoozed' && !!s.snoozedUntil && new Date(s.snoozedUntil) <= now),
  );
  const { cards, more } = todayCards(live, latest, now);
  const otherCards = cards.filter((s) => !isMessageSuggestion(s.kind));
  const otherMore = more.filter((s) => !isMessageSuggestion(s.kind));
  // someone added by hand and not written to yet: the next step is to write to them
  const toWrite = notYetWritten(people, chats, outbound, suggestions, now).slice(0, 3);
  const undrafted = pending
    .filter((s) => !s.outboundMessageId)
    .map((s) => s.id)
    .join(',');
  // cards kept for later have no draft yet: write them now, so every card here has something to approve
  useEffect(() => {
    if (user && undrafted) ensureDrafts(user, undrafted.split(',')).catch(() => undefined);
  }, [user, undrafted]);
  // a card id wins; for a person, the newest of their cards (the warm-up step just started, the reply just drafted)
  const focused =
    live.find((s) => s.id === focusCard) ??
    (focusPerson
      ? live
          .filter((s) => s.personId === focusPerson)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      : undefined);
  // the card a link points at may be one kept for later: open that list so it is on screen
  const focusLater = !!focused && later.some((s) => s.id === focused.id);
  const focusMore = !!focused && otherMore.some((s) => s.id === focused.id);
  useEffect(() => {
    if (focusLater) setShowLater(true);
    if (focusMore) setShowMore(true);
  }, [focused?.id, focusLater, focusMore]);
  const snoozed = suggestions
    .filter((s) => s.status === 'snoozed')
    .sort((a, b) => (a.snoozedUntil ?? '').localeCompare(b.snoozedUntil ?? ''));
  const sent = outbound
    .filter((o) => o.status === 'sent')
    .sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? ''));
  const outbox = outbound
    .filter((o) => IN_FLIGHT.includes(o.status))
    .sort((a, b) => (b.queuedAt ?? b.createdAt).localeCompare(a.queuedAt ?? a.createdAt));
  const handedOff = outbox.filter((o) => o.status === 'handed_off');
  const notSent = outbox.filter((o) => o.status !== 'handed_off');
  // chats waiting on the other person for a week or more; a card here already covers its own chat
  const covered = new Set([...cards, ...more].map((x) => x.chatId).filter(Boolean));
  const quiet = chats
    .filter(
      (c) =>
        wentQuiet(c, now) && !covered.has(c.id) && byId.get(c.personId) && !byId.get(c.personId)!.hiddenAt,
    )
    .sort((a, b) => (a.lastOutboundAt ?? '').localeCompare(b.lastOutboundAt ?? ''));
  // warm-ups under way, so the page still says who is in progress and when the next step comes
  const warming = chats
    .filter(
      (c) => c.stage === 'warming' && c.warmUp && byId.get(c.personId) && !byId.get(c.personId)!.hiddenAt,
    )
    .map((c) => ({
      chat: c,
      // once the warm-up days are over the next thing is the first message, whatever steps are left
      next:
        user && warmUpProgress(c.warmUp!, now, user.timezone).ready
          ? undefined
          : c.warmUp!.actions.find((a) => !a.doneAt && !a.skippedAt),
    }));
  // without Google, Orbit cannot see replies: the student tells it, so the words say so
  const googleOn = (integrations ?? []).some((i) => i.provider === 'google' && i.status === 'active');
  const problems = (integrations ?? []).filter((i) => i.status === 'needs_reauth' || i.status === 'error');
  const visiblePeople = people.filter((p) => p.isHuman && !p.hiddenAt).length;
  // a message opened in the mail app or LinkedIn and not marked as sent comes first: it is waiting on the student.
  // A link to one card opens the cards instead.
  const shown =
    tab ??
    (focusCard || focusPerson
      ? 'pending'
      : outbox.some((o) => o.status === 'handed_off' || o.status === 'failed')
        ? 'outbox'
        : 'pending');
  const refresh = async () => {
    if (!user) return;
    setBusy(true);
    try {
      await generateBrief(user, 'daily');
      toast.push({ text: 'Updated from your latest email, calendar and notes.' });
    } finally {
      setBusy(false);
    }
  };
  const nothingToSend = !pending.length && !started.length && !toWrite.length && !otherCards.length;
  return (
    <div>
      <PageHeader
        title="Drafts"
        subtitle="Every message Orbit wrote for you, and the other things worth doing today. Read a draft, edit it, and send it yourself."
        actions={
          // with nobody in Orbit yet there is nothing to refresh
          visiblePeople > 0 && (
            <Button
              onClick={refresh}
              disabled={busy}
              title="Rebuild today's cards from your latest email, calendar and notes"
              aria-label="Refresh"
              className="px-2.5 @[40rem]:px-3.5"
              data-testid="drafts-refresh"
            >
              <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> <span>Refresh</span>
            </Button>
          )
        }
      />
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
          id="drafts"
          title="How Drafts works"
          dismissed={hints.seen('drafts')}
          onDismiss={hints.dismiss}
        >
          Each card is one thing worth doing, most urgent first, with the reason under the name. Open a draft
          to read and edit it: nothing goes out until you send it yourself. Snooze a card to see it again
          later, or dismiss it if it is wrong.
        </FirstRunHint>
      )}
      <div className="grid @5xl:grid-cols-[minmax(0,1fr)_300px] gap-6 items-start">
        <div className="min-w-0">
          <Tabs
            value={shown}
            onChange={setTab}
            items={[
              { value: 'pending', label: 'To send', count: forToday.length + started.length },
              { value: 'outbox', label: 'Opened, not marked sent', count: outbox.length },
              { value: 'snoozed', label: 'Snoozed', count: snoozed.length },
              { value: 'sent', label: 'Sent', count: sent.length },
            ]}
          />
          {shown === 'pending' && started.length > 0 && (
            <div className="space-y-2 mb-5" data-testid="drafts-started">
              <div className="text-[12px] uppercase tracking-wide text-ink-3">Started by you</div>
              {started.map((o) => (
                <StartedItem key={o.id} o={o} person={byId.get(o.personId)} />
              ))}
            </div>
          )}
          {shown === 'pending' && toWrite.length > 0 && <ToWrite people={toWrite} />}
          {shown === 'pending' && pending.length > 0 && (
            <div className="space-y-3" data-testid="drafts-to-send">
              {forToday.length === 0 && (
                <p className="text-[13px] text-ink-3">Nothing to send today. The drafts below can wait.</p>
              )}
              {forToday.map((s) => (
                <SuggestionCard key={s.id} s={s} compact highlight={s.id === focused?.id} />
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
                      <SuggestionCard key={s.id} s={s} compact highlight={s.id === focused?.id} />
                    ))}
                  </>
                ) : (
                  <Button onClick={() => setShowLater(true)} data-testid="drafts-later">
                    Show {later.length} that can wait
                  </Button>
                ))}
            </div>
          )}
          {shown === 'pending' && (otherCards.length > 0 || otherMore.length > 0) && (
            <div className="space-y-3 mt-6" data-testid="drafts-other">
              <div className="text-[12px] uppercase tracking-wide text-ink-3">Also worth doing</div>
              {otherCards.map((s) => (
                <SuggestionCard key={s.id} s={s} highlight={s.id === focused?.id} />
              ))}
              {otherMore.length > 0 &&
                (showMore ? (
                  <>
                    <div className="flex items-center gap-3 pt-2">
                      <span className="text-[12px] uppercase tracking-wide text-ink-3">Can wait</span>
                      <button
                        className="text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink"
                        onClick={() => setShowMore(false)}
                        data-testid="drafts-fewer"
                      >
                        Show fewer
                      </button>
                    </div>
                    {otherMore.map((s) => (
                      <SuggestionCard key={s.id} s={s} highlight={s.id === focused?.id} />
                    ))}
                  </>
                ) : (
                  <Button onClick={() => setShowMore(true)} data-testid="drafts-more">
                    Show {otherMore.length} more that can wait
                  </Button>
                ))}
            </div>
          )}
          {shown === 'pending' && nothingToSend && (
            <EmptyState
              title="No drafts right now"
              body="When a follow-up or a thank-you is due, Orbit drafts the message and it waits here for you. A message you start on someone's page waits here too until you send it."
            />
          )}
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
                      <button className="text-[12px] text-accent" onClick={() => unsnoozeSuggestion(s.id)}>
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
              <div className="space-y-5">
                {handedOff.length > 0 && (
                  <div className="space-y-3" data-testid="drafts-handed-off">
                    <div className="text-[12px] uppercase tracking-wide text-ink-3">Did these go out?</div>
                    <p className="text-[13px] text-ink-3">
                      Messages you opened in your mail app or LinkedIn but have not marked as sent. Press I
                      sent it once a message is out, so Orbit can follow up at the right time.
                    </p>
                    {handedOff.map((o) => (
                      <OutboxItem key={o.id} o={o} person={byId.get(o.personId)} />
                    ))}
                  </div>
                )}
                {notSent.length > 0 && (
                  <div className="space-y-3">
                    <div className="text-[12px] uppercase tracking-wide text-ink-3">Not sent yet</div>
                    {notSent.map((o) => (
                      <OutboxItem key={o.id} o={o} person={byId.get(o.personId)} />
                    ))}
                  </div>
                )}
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
        <div className="space-y-4 min-w-0">
          <ComingUp events={events} warming={warming} byId={byId} now={now} />
          {quiet.length > 0 && user && (
            <Card data-testid="drafts-quiet">
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
                          setTab('pending');
                          toast.push({
                            text: `Moved ${p.firstName} to Replied. Your reply to ${p.firstName} is now a draft here.`,
                            action: { label: 'Show it', onClick: () => nav(`/inbox?person=${p.id}`) },
                            ttl: 7000,
                          });
                        }}
                        data-testid="drafts-quiet-replied"
                      >
                        They replied
                      </button>
                    </li>
                  );
                })}
              </ul>
              <Link to="/people?view=board&quiet=1" className="mt-3 inline-block text-[12px] text-accent">
                {quiet.length > 4 ? `All ${quiet.length} in People` : 'See them in People'}
              </Link>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/** Chats in the next seven days and warm-ups under way, with when the next step comes. */
function ComingUp({
  events,
  warming,
  byId,
  now,
}: {
  events: CalendarEvent[];
  warming: { chat: CoffeeChat; next?: { dueAt: string } }[];
  byId: Map<string, Person>;
  now: Date;
}) {
  return (
    <Card>
      <div className="font-medium mb-3">Coming up</div>
      {!events.length && !warming.length && (
        <p className="text-[13px] text-ink-3">No chats in the next 7 days.</p>
      )}
      <ul className="space-y-2.5">
        {events
          .slice()
          .sort((a, b) => a.startAt.localeCompare(b.startAt))
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
  );
}

/** People the student added by hand and has not written to: a button opens the first message on their page. */
function ToWrite({ people }: { people: Person[] }) {
  return (
    <div
      className="mb-5 bg-canvas border border-line rounded-[var(--radius-card)] p-4 shadow-[var(--shadow-card)]"
      data-testid="drafts-to-write"
    >
      <p className="font-medium">Next: write to the people you added</p>
      <p className="text-ink-3 text-[13px] mt-0.5">
        Orbit drafts the first message for you to edit. Nothing goes out until you send it yourself.
      </p>
      <ul className="mt-3 space-y-2">
        {people.map((p) => (
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
              <Button size="sm" variant="primary" data-testid="drafts-write">
                Write to {p.firstName}
              </Button>
            </Link>
          </li>
        ))}
      </ul>
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
            await discardDraft(o.id);
            toast.push({
              text: 'Draft discarded.',
              action: { label: 'Undo', onClick: () => restoreDraft(o.id) },
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
