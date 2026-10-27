import type { CoffeeChat, MessageKind, Person } from '@orbit/core';
import {
  CHANNEL_LABELS,
  composeKindFor,
  composeKinds,
  conflictingFacts,
  FACT_TYPE_LABELS,
  linkedinActivityUrl,
  MESSAGE_KIND_LABELS,
  NOTE_SOURCE_LABELS,
  promiseText,
  RELATIONSHIP_LABELS,
  relTime,
  STAGE_LABELS,
  TIE_BAND_LABELS,
  TOUCHPOINT_LABELS,
  tieBand,
} from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronDown, ExternalLink, Linkedin, Mail, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { runApproval } from '../components/approve';
import { BackLink } from '../components/BackLink';
import { PersonCompanyLogo } from '../components/CompanyLogo';
import { Conversation } from '../components/Conversation';
import { DraftEditor, handoffWhere, OutboxStatus } from '../components/DraftEditor';
import { MutualConnections } from '../components/MutualConnections';
import { DossierCard } from '../components/people/DossierCard';
import { InPlanChip } from '../components/people/InPlanChip';
import { LinkedInHistory } from '../components/people/LinkedInHistory';
import { PrepButton, prepIsDue } from '../components/people/PrepButton';
import { PrepDeck } from '../components/people/PrepDeck';
import { ResearchDebrief } from '../components/people/ResearchDebrief';
import { STAGE_COLOR, StrengthDots } from '../components/people/shared';
import { TieScoreCard } from '../components/people/TieScoreCard';
import { ConfirmEarlyDone, chatTimeLabel, ScheduleChatDialog } from '../components/ScheduleChat';
import { SuggestionCard } from '../components/SuggestionCard';
import { db } from '../db/schema';
import { isMessageSuggestion, refreshPersonSummary } from '../engine/brief';
import { calendarInvitesAvailable, canInviteFor, sendCalendarInvite } from '../engine/calendarInvite';
import { conversationWith } from '../engine/conversation';
import { composeDraft, discardDraft as discardDraftRow, lastInboundOf, restoreDraft } from '../engine/drafts';
import { enrichOnView } from '../engine/enrichment';
import {
  addFact,
  deleteFact,
  MANUAL_FACT_TYPES,
  type ManualFactType,
  markActionItemDone,
  restoreFact,
} from '../engine/facts';
import { moveChat } from '../engine/move';
import { hidePerson, setRelationshipType, unhidePerson } from '../engine/people';
import { moveChatGuarded } from '../engine/pipeline';
import { personSummary, toYou } from '../engine/prep';
import { SUMMARY_RULES_AT } from '../engine/repair';
import { isServerUser } from '../integrations/orbitApi';
import { useSession } from '../state/session';
import {
  Avatar,
  Button,
  Card,
  Chip,
  cx,
  Modal,
  NotFound,
  relDate,
  Select,
  Skeleton,
  SkeletonRows,
  SkeletonText,
  Tabs,
  useToast,
} from '../ui';

/**
 * The line under their name: their current position as their own LinkedIn profile states it (the truth about where
 * they work, plan 17 E), else their headline, title or company as Orbit has it.
 */
function positionLine(
  person: Pick<Person, 'headline' | 'currentTitle' | 'currentOrganizationRaw' | 'fieldSources'>,
): string | undefined {
  const fromLinkedIn =
    person.fieldSources?.currentTitle === 'linkedin_profile' ||
    person.fieldSources?.currentOrganizationId === 'linkedin_profile';
  if (fromLinkedIn && (person.currentTitle || person.currentOrganizationRaw))
    return [person.currentTitle, person.currentOrganizationRaw].filter(Boolean).join(' at ');
  return person.headline ?? person.currentTitle ?? person.currentOrganizationRaw;
}

/**
 * "Last touch 3 days ago", or "Connected on LinkedIn Mar 27" when accepting a connection is all there has been: a
 * connection is not a conversation.
 */
function lastTouchLabel(
  person: Pick<Person, 'lastInteractionAt' | 'linkedinConnectedOn'>,
  tps: { kind: string }[],
): string {
  const talked = tps.some((t) => t.kind !== 'linkedin_connected');
  if (!talked && person.linkedinConnectedOn)
    return `Connected on LinkedIn ${shortDate(person.linkedinConnectedOn).replace(/, \d{4}$/, '')}`;
  if (!talked) return 'Not in touch yet';
  return `Last touch ${relDate(person.lastInteractionAt)}`;
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const TP_ICON: Record<string, string> = {
  email_in: '↙',
  email_out: '↗',
  email_cc: 'cc',
  meeting: '☕',
  linkedin_in: 'in',
  linkedin_out: 'in',
  linkedin_connected: '+',
  linkedin_engaged: '♥',
  note: '✎',
  manual_log: '✓',
  intro_observed: '⇄',
};

export function PersonPage() {
  const { id } = useParams();
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  // Prep is a deck over About now (docs/plan/22): an old link to the Prep tab opens it there
  const rawTab = params.get('tab');
  const tab =
    (rawTab === 'prep'
      ? 'facts'
      : (rawTab as 'timeline' | 'conversation' | 'facts' | 'connections' | null)) ?? 'timeline';
  const prepOpen = params.get('prep') === '1' || rawTab === 'prep';
  const nav = useNavigate();
  const toast = useToast();
  // null: looked it up and it is not there (merged, deleted, bad link); undefined: still loading.
  const person = useLiveQuery(async () => (id ? ((await db.people.get(id)) ?? null) : null), [id]);
  const chats = useLiveQuery(() => (id ? db.chats.where('personId').equals(id).toArray() : []), [id]) ?? [];
  const tpsQ = useLiveQuery(() => (id ? db.touchpoints.where('personId').equals(id).toArray() : []), [id]);
  const tps = tpsQ ?? [];
  const factsQ = useLiveQuery(
    () =>
      id
        ? db.facts
            .where('personId')
            .equals(id)
            .filter((f) => !f.deletedAt)
            .toArray()
        : [],
    [id],
  );
  const facts = factsQ ?? [];
  const items =
    useLiveQuery(() => (id ? db.actionItems.where('personId').equals(id).toArray() : []), [id]) ?? [];
  const drafts =
    useLiveQuery(() => (id ? db.outbound.where('personId').equals(id).toArray() : []), [id]) ?? [];
  // messages waiting on the student for this person: a drafted card (a thank-you after a note) and anything handed to
  // the mail app or LinkedIn that is not marked as sent yet, so leaving the page never loses the "I sent it" step
  const waiting =
    useLiveQuery(
      () =>
        id
          ? db.suggestions
              .where('personId')
              .equals(id)
              .filter((x) => x.status === 'pending' && isMessageSuggestion(x.kind))
              .toArray()
          : [],
      [id],
    ) ?? [];
  const edgesQ = useLiveQuery(
    () => (id ? db.edges.where('personAId').equals(id).or('personBId').equals(id).toArray() : []),
    [id],
  );
  const edges = edgesQ ?? [];
  const affs =
    useLiveQuery(() => (id ? db.affiliations.where('personId').equals(id).toArray() : []), [id]) ?? [];
  // a referral ask is offered only when something on record makes it fit: their offer to refer or pass the resume
  // along, or the student's application to their company
  const referralFits =
    useLiveQuery(async () => {
      if (!person || !user) return true;
      const org = (person.currentOrganizationRaw ?? '').trim().toLowerCase();
      const applying = org
        ? !!(await db.targetCompanies
            .where('userId')
            .equals(user.id)
            .filter(
              (t) =>
                (!!person.currentOrganizationId && t.organizationId === person.currentOrganizationId) ||
                t.nameRaw.trim().toLowerCase() === org,
            )
            .first())
        : false;
      return (
        applying ||
        facts.some(
          (f) =>
            f.type === 'offer' &&
            /\b(refer|referral|pass (along )?my (resume|name)|flag|put in a (good )?word|introduce me)\b/i.test(
              f.text,
            ),
        )
      );
    }, [person?.id, person?.currentOrganizationRaw, user?.id, facts.length]) ?? true;
  const neighbourIds = useMemo(
    () => edges.map((e) => (e.personAId === id ? e.personBId : e.personAId)),
    [edges, id],
  );
  const neighboursQ = useLiveQuery(
    () => (neighbourIds.length ? db.people.bulkGet(neighbourIds) : []),
    [neighbourIds.join(',')],
  );
  const neighbours = neighboursQ ?? [];
  // the tabs' own reads: until they answer, a tab shows its shape, never "No interactions yet"
  const tabsLoading =
    tpsQ === undefined || factsQ === undefined || edgesQ === undefined || neighboursQ === undefined;
  const notes =
    useLiveQuery(
      () =>
        id
          ? db.notes
              .where('userId')
              .equals(user?.id ?? '')
              .filter((n) => n.personIds.includes(id))
              .toArray()
          : [],
      [id, user?.id],
    ) ?? [];
  const [composing, setComposing] = useState<MessageKind | undefined>(
    (params.get('draft') as MessageKind | null) ?? undefined,
  );
  const [draftId, setDraftId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [warmUpChoice, setWarmUpChoice] = useState(false);
  const [asking, setAsking] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [early, setEarly] = useState<string>();
  // a finished brief on them: the first message's composer then needs no "Research them first" link
  const hasBrief =
    useLiveQuery(
      async () =>
        id
          ? (await db.dossiers.where('personId').equals(id).toArray()).some(
              (d) => d.status === 'ready' || d.status === 'partial',
            )
          : false,
      [id],
    ) ?? false;
  const events =
    useLiveQuery(
      () =>
        id
          ? db.events
              .where('userId')
              .equals(user?.id ?? '')
              .filter((e) => e.attendeePersonIds.includes(id) && e.status !== 'cancelled')
              .toArray()
          : [],
      [id, user?.id],
    ) ?? [];
  const resumeFacets =
    useLiveQuery(async () => {
      if (!user) return [];
      const current = (await db.resumes.where('userId').equals(user.id).toArray()).filter((r) => r.isCurrent);
      if (!current.length) return [];
      return db.resumeFacets
        .where('resumeId')
        .anyOf(current.map((r) => r.id))
        .toArray();
    }, [user?.id]) ?? [];
  const chat = chats.find((c) => !['archived'].includes(c.stage)) ?? chats[0];
  // how many messages the Messages tab holds (plan 25)
  const messageCount =
    useLiveQuery(
      async () => (user && id ? (await conversationWith(user.id, id)).length : 0),
      [user?.id, id, chat?.lastInboundAt, chat?.lastOutboundAt],
    ) ?? 0;
  // their last message, on the chat's email thread or on LinkedIn: "Write to" answers it only when it waits on an answer
  const lastInbound = useLiveQuery(
    async () => (await lastInboundOf(chat)) ?? null,
    [chat?.id, chat?.threadId, chat?.lastInboundAt],
  );
  // the summary is rewritten when something newer than it happened (a message sent, a note, a fact typed in), so it
  // never says "you haven't been in touch" after the first email went out
  const newestActivity = [...tps.map((t) => t.occurredAt), ...facts.map((f) => f.createdAt)]
    .filter((at) => at <= new Date().toISOString())
    .reduce((m, at) => (at > m ? at : m), '');
  // and when it was written under older rules (what counts as a touch, what makes someone an alum)
  const summaryStale =
    !!person?.summary &&
    (!person.summaryUpdatedAt ||
      person.summaryUpdatedAt < SUMMARY_RULES_AT ||
      newestActivity > person.summaryUpdatedAt);
  useEffect(() => {
    if (person && user && (!person.summary || summaryStale)) refreshPersonSummary(user, person.id);
  }, [person?.id, person?.summary, user, summaryStale]);
  // their LinkedIn profile is read when their page opens, when it is due and today's allowance has room (plan 17 E)
  useEffect(() => {
    if (person && user && !isServerUser(user.id)) void enrichOnView(user, person.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person?.id, user?.id]);
  const wantDraft = params.get('draft') as MessageKind | null;
  // a link to one draft the student started (from Drafts or Today) opens it in the composer
  const wantOpen = params.get('open');
  useEffect(() => {
    if (!wantOpen) return;
    const d = drafts.find((x) => x.id === wantOpen);
    if (!d) return;
    if (d.status === 'draft') {
      setDraftId(d.id);
      setComposing(d.kind);
    }
    setParams(
      (p) => {
        p.delete('open');
        return p;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantOpen, drafts.length]);
  useEffect(() => {
    if (person && user && wantDraft && !draftId && !busy) {
      compose(wantDraft);
      setParams(
        (p) => {
          p.delete('draft');
          return p;
        },
        { replace: true },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person?.id, user?.id, wantDraft]);
  if (!user || person === undefined) return <PersonLoading />;
  if (person === null)
    return (
      <NotFound
        title="We can't find that person"
        body="They may have been merged with another record or removed, or the link is out of date."
        to="/people"
        linkLabel="Back to People"
      />
    );
  // a draft the student started here and has not sent: it waits for them, it is never written again from scratch
  const openDraftFor = (kind: MessageKind) =>
    drafts
      .filter((d) => d.kind === kind && d.status === 'draft')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const compose = async (kind: MessageKind, opts: { skipWarmUp?: boolean; confirmed?: boolean } = {}) => {
    // a draft the page already has is reopened without a round trip; the engine reads the database for the rest
    const started = openDraftFor(kind);
    if (started) {
      setDraftId(started.id);
      setComposing(kind);
      return;
    }
    setBusy(true);
    try {
      const r = await composeDraft(user, person.id, kind, { ...opts, chat: chat ?? null });
      // A cold LinkedIn-only contact: explain the warm-up and let the student choose before anything starts.
      if (r.kind === 'warmup_choice') {
        setWarmUpChoice(true);
        return;
      }
      if (r.kind === 'warmup_started') {
        toast.push({
          text: `Warm-up started for ${person.firstName}. The first step is outlined below.`,
          tone: 'good',
          ttl: 6000,
        });
        nav(`/inbox?person=${person.id}`);
        return;
      }
      if (r.kind !== 'draft') return;
      setDraftId(r.draft.id);
      // the thread may call for another kind (a bump to someone who answered is the scheduling reply)
      setComposing(r.draft.kind);
    } finally {
      setBusy(false);
    }
  };
  const draft = drafts.find((d) => d.id === draftId);
  /** Drop a draft the student started; `quiet` when nothing of theirs is in it, otherwise with an Undo. */
  const discardDraft = async (id: string, quiet = false) => {
    await discardDraftRow(id);
    if (id === draftId) {
      setComposing(undefined);
      setDraftId(undefined);
    }
    if (!quiet)
      toast.push({
        text: 'Draft discarded.',
        action: { label: 'Undo', onClick: () => restoreDraft(id) },
        ttl: 7000,
      });
  };
  const send = async (body: string, subject?: string) => {
    if (!draft) return;
    setBusy(true);
    try {
      // the composer stays open: it shows the undo window, the hand-off confirmation, or why it was not sent
      return await runApproval(user, draft, body, subject, toast, person.firstName);
    } finally {
      setBusy(false);
    }
  };
  const timeline = [
    ...tps.map((t) => ({
      at: t.occurredAt,
      text: t.summary ?? TOUCHPOINT_LABELS[t.kind] ?? 'Interaction',
      icon: TP_ICON[t.kind] ?? '•',
      kind: t.kind,
    })),
    // a sent message already logged as a touchpoint ("Email: <subject>") is one entry, not two
    ...drafts
      .filter((d) => d.status === 'sent' && !tps.some((t) => t.refTable === 'outbound' && t.refId === d.id))
      .map((d) => ({
        at: d.sentAt!,
        text: `${MESSAGE_KIND_LABELS[d.kind]} sent ${d.channel === 'linkedin' ? 'on LinkedIn' : d.channel === 'gmail' ? 'by email' : 'as copied text'}`,
        icon: '↗',
        kind: 'sent',
      })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const grouped = new Map<string, typeof facts>();
  for (const f of facts) grouped.set(f.type, [...(grouped.get(f.type) ?? []), f]);
  // two answers to the same question (two hometowns, two teams): point at both so the wrong one gets deleted
  const conflicts = conflictingFacts(facts);
  const nextEvent = events
    .filter((e) => new Date(e.endAt).getTime() > Date.now())
    .sort((a, b) => a.startAt.localeCompare(b.startAt))[0];
  // the booked chat's time has passed and the chat has not moved on yet: say so, not "the time is not set"
  const pastEvent =
    chat?.stage === 'scheduled' && !nextEvent && chat.scheduledEventId
      ? events.find((e) => e.id === chat.scheduledEventId && e.status !== 'cancelled')
      : undefined;
  const liveSummary = person.summary
    ? undefined
    : personSummary({ user, person, facts, touchpoints: tps, now: new Date() });
  const summary = person.summary ?? liveSummary?.summary;
  const talkingPoints = person.summary ? person.talkingPoints : liveSummary?.talkingPoints;
  return (
    <div>
      <BackLink />
      <div className="flex flex-col @4xl:flex-row @4xl:items-start gap-4 mb-5" data-testid="person-header">
        <div className="flex items-start gap-4 min-w-0 flex-1">
          <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={56} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-[22px] font-semibold tracking-[-0.01em] break-words">
                {person.displayName}
              </h1>
              {person.isAlumni && <Chip tone="accent">{user.school} alum</Chip>}
              {chat && (
                // the stage, as a chip that opens the stages to move the chat to
                <label
                  className="relative inline-flex items-center gap-1 rounded-full border border-line bg-canvas px-2 h-[22px] text-[12px] font-medium leading-none whitespace-nowrap shrink-0 text-ink-2 cursor-pointer hover:bg-canvas-2 hover:text-ink focus-within:ring-2 focus-within:ring-accent/40"
                  title="Move this chat to another stage"
                  data-testid="person-stage"
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: STAGE_COLOR[chat.stage] }}
                  />
                  {STAGE_LABELS[chat.stage]}
                  <ChevronDown size={12} aria-hidden className="text-ink-3" />
                  <select
                    value={chat.stage}
                    onChange={async (e) => {
                      const to = e.target.value as CoffeeChat['stage'];
                      // a chat still ahead is not done yet: ask before drafting a thank-you for it
                      const r = await moveChatGuarded(user, chat, to, 'user:select');
                      if (r.outcome === 'meeting_ahead') setEarly(r.meetingAt);
                      else if (r.outcome === 'applied' && r.needsTime) setAsking(true);
                    }}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    aria-label="Chat stage"
                  >
                    {Object.entries(STAGE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <p className="text-ink-2 mt-0.5 flex items-center gap-2 min-w-0">
              <PersonCompanyLogo person={person} size={18} />
              <span className="min-w-0" data-testid="person-position">
                {positionLine(person)}
              </span>
              {user && <InPlanChip userId={user.id} personId={person.id} />}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-3">
              {person.location && <span>{person.location}</span>}
              {person.school && <span>{person.school}</span>}
              {person.primaryEmail && (
                <a
                  href={`mailto:${person.primaryEmail}`}
                  className="inline-flex items-center gap-1 hover:text-ink"
                >
                  <Mail size={13} /> {person.primaryEmailAsWritten ?? person.primaryEmail}
                </a>
              )}
              {person.linkedinUrl && (
                <a
                  href={person.linkedinUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:text-ink"
                >
                  <Linkedin size={13} /> LinkedIn
                </a>
              )}
              <span
                className="inline-flex items-center gap-1.5 whitespace-nowrap"
                title="How well you know them, from how often and how recently you have emailed, met and written notes. It grows as you talk."
              >
                Closeness <StrengthDots v={person.strength} /> {closenessWord(person.strength)}
              </span>
              <span className="whitespace-nowrap">{lastTouchLabel(person, tps)}</span>
            </div>
            {chat && (chat.stage === 'scheduled' || nextEvent) && (
              <div
                className="mt-2 flex flex-wrap items-center gap-2 text-[13px]"
                data-testid="person-chat-time"
              >
                {nextEvent ? (
                  <>
                    <span>
                      Chat <span className="font-medium">{chatTimeLabel(nextEvent.startAt)}</span> (
                      {relDate(nextEvent.startAt)})
                    </span>
                    <button
                      type="button"
                      className="text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink"
                      onClick={() => setAsking(true)}
                    >
                      Change the time
                    </button>
                    {nextEvent.inviteSentAt ? (
                      <span className="text-[12px] text-good" data-testid="person-invite-sent">
                        Invite sent
                        {nextEvent.conferenceUrl && (
                          <>
                            {' · '}
                            <a
                              href={nextEvent.conferenceUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="underline underline-offset-2"
                            >
                              Meet link
                            </a>
                          </>
                        )}
                      </span>
                    ) : (
                      canInviteFor(nextEvent) &&
                      !!person.primaryEmail &&
                      calendarInvitesAvailable(user) && (
                        <Button
                          size="sm"
                          disabled={inviting}
                          onClick={async () => {
                            setInviting(true);
                            try {
                              const r = await sendCalendarInvite(user, chat);
                              toast.push(
                                r.ok
                                  ? {
                                      text: `On your calendar, and Google sent ${person.firstName} the invite.`,
                                      tone: 'good',
                                    }
                                  : { text: r.message, tone: 'bad', ttl: 9000 },
                              );
                            } finally {
                              setInviting(false);
                            }
                          }}
                          title={`Add it to your Google Calendar and email ${person.firstName} the invite, with a Meet link`}
                          data-testid="person-send-invite"
                        >
                          {inviting ? 'Sending…' : 'Send invite'}
                        </Button>
                      )
                    )}
                  </>
                ) : pastEvent ? (
                  <>
                    <span data-testid="person-chat-past">
                      Your chat was <span className="font-medium">{chatTimeLabel(pastEvent.startAt)}</span>.
                      How did it go?
                    </span>
                    <Link to={`/notes/new?person=${person.id}`}>
                      <Button size="sm">Add notes</Button>
                    </Link>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => moveChat(user, chat, 'completed', 'user:select')}
                    >
                      Mark it done
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="text-warn">Your chat is booked, but the time is not set.</span>
                    <Button size="sm" onClick={() => setAsking(true)} data-testid="person-set-time">
                      Set the time
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 w-full @4xl:w-auto @4xl:shrink-0 @4xl:justify-end">
          <div className="contents">
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => {
                // the stage and the calendar together: no check-in minutes after a thank-you
                const next = composeKindFor(chat, new Date(), {
                  lastInbound: lastInbound ?? undefined,
                  timezone: user?.timezone,
                });
                if ('wait' in next)
                  toast.push({
                    text:
                      next.wait.reason === 'away' && next.wait.until
                        ? `${person.firstName} is away. A follow-up fits from ${new Date(next.wait.until).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: user?.timezone })}, once they have had a couple of days back, and Orbit will suggest it then.`
                        : next.wait.reason === 'too_soon' && next.wait.until
                          ? `You wrote to ${person.firstName} ${relTime(next.wait.since, new Date())}. A follow-up fits from ${new Date(next.wait.until).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: user?.timezone })}, and Orbit will suggest it then.`
                          : `You wrote to ${person.firstName} ${relTime(next.wait.since, new Date())}. A check-in fits in a few weeks, and Orbit will suggest one.`,
                    tone: 'neutral',
                    ttl: 6000,
                  });
                else compose(next.kind);
              }}
              data-testid="person-write"
            >
              Write to {person.firstName}
            </Button>
            {prepIsDue(nextEvent ?? pastEvent) && (
              <PrepButton event={nextEvent ?? pastEvent} variant="ghost" testId="person-prep" />
            )}
          </div>
          <div className="contents text-[12px]">
            {/* the less frequent actions wait behind More, so the header leads with writing to them */}
            <details className="relative group/more" data-testid="person-more">
              <summary
                className="list-none cursor-pointer h-8 px-3 rounded-full inline-flex items-center gap-1 text-[13px] text-ink-2 hover:text-ink hover:bg-canvas-2 [&::-webkit-details-marker]:hidden"
                aria-label="More actions"
              >
                More <ChevronDown size={14} aria-hidden />
              </summary>
              <div className="pop-in absolute right-0 z-20 mt-1 w-64 rounded-[var(--radius-card)] border border-line bg-canvas p-1.5 shadow-[var(--shadow-card)]">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start"
                  onClick={() => nav(`/map?reach=${person.id}`)}
                  title={`See who you know that could introduce you to ${person.firstName}`}
                >
                  Find an intro
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start"
                  title={
                    person.hiddenAt
                      ? 'Show this person again in People, Today and the map'
                      : 'Hide this person from People, Today and the map'
                  }
                  onClick={async () => {
                    if (person.hiddenAt) {
                      await unhidePerson(person.id);
                      toast.push({ text: `${person.firstName} is back in People, Today and the map.` });
                      return;
                    }
                    await hidePerson(person.id);
                    toast.push({
                      text: `Hid ${person.displayName}. Find them under Hidden in People.`,
                      action: { label: 'Undo', onClick: () => unhidePerson(person.id) },
                      ttl: 7000,
                    });
                    nav('/people?view=list');
                  }}
                >
                  {person.hiddenAt ? 'Show again' : 'Hide from lists'}
                </Button>
                <label className="flex items-center justify-between gap-2 px-3 py-1.5 text-[12px] text-ink-3">
                  How you know them
                  <Select
                    value={person.relationshipType}
                    onChange={(e) => setRelationshipType(person.id, e.target.value as never)}
                    className="h-8 text-[13px] text-ink"
                    title="Orbit adjusts the tone of drafts and its suggestions to it."
                  >
                    {Object.entries(RELATIONSHIP_LABELS).map(([k, l]) => (
                      <option key={k} value={k}>
                        {k === 'unknown' ? 'Not set' : l}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
            </details>
          </div>
        </div>
      </div>

      {prepOpen && (
        <PrepDeck
          person={person}
          chat={chat}
          chats={chats}
          event={nextEvent ?? pastEvent}
          facts={facts}
          timeline={timeline}
          items={items}
          resumeFacets={resumeFacets}
          onClose={() => {
            const next = new URLSearchParams(params);
            next.delete('prep');
            if (next.get('tab') === 'prep') next.set('tab', 'facts');
            setParams(next);
          }}
        />
      )}
      {asking && chat && (
        <ScheduleChatDialog
          chat={chat}
          firstName={person.firstName}
          current={nextEvent?.startAt}
          onClose={() => setAsking(false)}
        />
      )}
      {early && chat && (
        <ConfirmEarlyDone
          firstName={person.firstName}
          at={early}
          onClose={() => setEarly(undefined)}
          onConfirm={async () => {
            setEarly(undefined);
            await moveChat(user, chat, 'completed', 'user:select');
          }}
        />
      )}
      <Modal
        open={warmUpChoice}
        onClose={() => setWarmUpChoice(false)}
        title={`Write to ${person.firstName}`}
      >
        <div className="space-y-3 text-[13.5px] text-ink-2" data-testid="warmup-choice">
          <p>
            You only have {person.firstName} on LinkedIn and you haven't talked yet. Cold messages get far
            more replies when your name is already familiar, so Orbit suggests a short warm-up first: view
            their profile, then react to or comment on one of their posts over the next few days. Each step
            shows up in Drafts, and the message is drafted when the warm-up is done.
          </p>
          <p>If you already know {person.firstName}, skip it and write now.</p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              variant="primary"
              onClick={() => {
                setWarmUpChoice(false);
                compose('outreach', { confirmed: true });
              }}
            >
              Warm up first (recommended)
            </Button>
            <Button
              onClick={() => {
                setWarmUpChoice(false);
                compose('outreach', { confirmed: true, skipWarmUp: true });
              }}
              data-testid="warmup-skip"
            >
              Message {person.firstName} now
            </Button>
          </div>
        </div>
      </Modal>

      {(() => {
        const cardDrafts = new Set(waiting.map((w) => w.outboundMessageId).filter(Boolean));
        const handedOff = drafts.filter(
          (d) => d.status === 'handed_off' && d.id !== draft?.id && !cardDrafts.has(d.id),
        );
        const cards = waiting.filter((w) => !draft || w.outboundMessageId !== draft.id);
        // drafts the student started here (Write to, the Map, Discover) and has not sent: they wait here and on Drafts
        const started = drafts
          .filter((d) => d.status === 'draft' && !d.suggestionId && d.id !== draft?.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        if (!cards.length && !handedOff.length && !started.length) return null;
        return (
          <div className="mb-5 space-y-3" data-testid="person-waiting">
            <div className="text-[12px] uppercase tracking-wide text-ink-3">Waiting on you</div>
            {started.map((d) => (
              <div
                key={d.id}
                className="rounded-[var(--radius-card)] border border-line p-3"
                data-testid="person-started-draft"
              >
                <div className="text-[13px] text-ink-2">
                  {MESSAGE_KIND_LABELS[d.kind]} you started {relDate(d.createdAt)}, not sent yet.
                </div>
                <p className="text-[13px] text-ink-3 mt-1 line-clamp-2 whitespace-pre-line">
                  {d.bodyFinal ?? d.bodyDraft}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      setDraftId(d.id);
                      setComposing(d.kind);
                    }}
                    data-testid="person-continue-draft"
                  >
                    Continue writing
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => discardDraft(d.id)}>
                    Discard draft
                  </Button>
                </div>
              </div>
            ))}
            {cards.map((w) => (
              <SuggestionCard key={w.id} s={w} compact onPersonPage />
            ))}
            {handedOff.map((d) => (
              <div key={d.id}>
                <div className="text-[13px] text-ink-2 mb-1.5">
                  {MESSAGE_KIND_LABELS[d.kind]} you {handoffWhere(d)} {relDate(d.approvedAt ?? d.createdAt)}.
                  Did it go out?
                </div>
                <OutboxStatus draft={d} />
              </div>
            ))}
          </div>
        );
      })()}
      {composing && draft && (
        <Card className="mb-5 border-accent/40">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <div className="min-w-0">
              <div className="font-medium">
                {MESSAGE_KIND_LABELS[composing]} · {CHANNEL_LABELS[draft.channel]}
              </div>
              <div className="text-[12px] text-ink-3">
                Orbit picked this kind of message from where your chat stands.
                {composeKinds(chat?.stage, composing, { referral: referralFits }).length > 1
                  ? ' Pick another and it rewrites the draft.'
                  : ''}
              </div>
              {composing === 'outreach' && !hasBrief && !tps.some((t) => t.kind !== 'linkedin_connected') && (
                <Link
                  to={`/people/${person.id}?tab=facts`}
                  className="text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink mt-0.5 inline-block"
                  data-testid="compose-research-first"
                >
                  Research them first
                </Link>
              )}
              {composing === 'outreach' && chat?.stage === 'warming' && chat.warmUp && (
                <div className="text-[12px] text-warn mt-0.5" data-testid="compose-warmup-early">
                  Your warm-up is {chat.warmUp.actions.filter((a) => a.doneAt).length} of{' '}
                  {chat.warmUp.actions.length} steps done. You can write now, but the message lands better
                  once {person.firstName} has seen your name.
                </div>
              )}
            </div>
            {/* one kind only: nothing to switch to, so no button that looks like one (it used to restart the draft) */}
            {composeKinds(chat?.stage, composing, { referral: referralFits }).length > 1 && (
              <div className="flex flex-wrap gap-1 text-[12px]" role="group" aria-label="Kind of message">
                {composeKinds(chat?.stage, composing, { referral: referralFits }).map((k) => (
                  <button
                    key={k}
                    disabled={busy || draft.status !== 'draft'}
                    onClick={() => {
                      if (k === composing) return;
                      // the draft being left keeps the student's words (it waits under Waiting on you); an untouched
                      // one is dropped
                      if (draft.status === 'draft' && !draft.bodyFinal && !draft.suggestionId)
                        discardDraft(draft.id, true);
                      compose(k, { confirmed: true });
                    }}
                    aria-pressed={composing === k}
                    className={cx(
                      'px-2.5 h-8 rounded-full border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                      composing === k ? 'border-ink bg-ink text-white' : 'border-line text-ink-2',
                    )}
                  >
                    {MESSAGE_KIND_LABELS[k]}
                  </button>
                ))}
              </div>
            )}
          </div>
          <DraftEditor
            draft={draft}
            thread
            onApprove={send}
            onCancel={({ kept }) => {
              // a first message nobody wrote anything in is dropped; one with the student's words waits for them
              if (!kept && draft.status === 'draft' && !draft.suggestionId) discardDraft(draft.id, true);
              setComposing(undefined);
              setDraftId(undefined);
            }}
            busy={busy}
          />
        </Card>
      )}

      <div className="grid @4xl:grid-cols-[minmax(0,1fr)_320px] gap-6 items-start">
        <div className="min-w-0">
          <Tabs
            value={tab}
            onChange={(v) => setParams({ tab: v })}
            items={[
              { value: 'timeline', label: 'Timeline', count: tabsLoading ? undefined : timeline.length },
              { value: 'conversation', label: 'Messages', count: messageCount || undefined },
              { value: 'facts', label: 'About', count: (!tabsLoading && facts.length) || undefined },
              {
                value: 'connections',
                label: 'Who they know',
                count: tabsLoading ? undefined : neighbours.filter(Boolean).length,
              },
            ]}
          />
          {tab === 'timeline' && (
            <ol className="relative border-l border-line ml-3 space-y-4">
              {/* adding a note sits at the top of the timeline, where it will land */}
              <li className="pl-5">
                <Link
                  to={`/notes/new?person=${person.id}`}
                  className="group/add inline-flex items-center gap-2 text-[13px] text-ink-3 hover:text-ink"
                  title={`Add notes from a conversation with ${person.firstName}`}
                  aria-label="Add note"
                  data-testid="person-add-note"
                >
                  <span className="absolute -left-[9px] w-[18px] h-[18px] rounded-full bg-canvas border border-dashed border-ink-3/60 inline-flex items-center justify-center group-hover/add:border-ink group-hover/add:bg-ink group-hover/add:text-canvas">
                    <Plus size={11} aria-hidden />
                  </span>
                  Add a note
                </Link>
              </li>
              {tabsLoading ? (
                <li className="pl-5">
                  <SkeletonRows rows={4} avatar={0} testId="timeline-loading" />
                </li>
              ) : (
                timeline.length === 0 && <li className="pl-5 text-ink-3 text-[13px]">No interactions yet.</li>
              )}
              {timeline.slice(0, 100).map((t, i) => (
                <li key={i} className="pl-5">
                  <span className="absolute -left-[9px] w-[18px] h-[18px] rounded-full bg-canvas border border-line text-[10px] inline-flex items-center justify-center text-ink-3">
                    {t.icon}
                  </span>
                  <div className="text-[13.5px]">{t.text}</div>
                  <div className="text-[12px] text-ink-3">
                    {new Date(t.at).toLocaleString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </div>
                </li>
              ))}
            </ol>
          )}
          {tab === 'conversation' && <Conversation person={person} />}
          {tab === 'facts' && (
            <div className="space-y-4">
              {/* who they are, straight from LinkedIn (everyone), then Deep research, a step further, from the web */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="about-prep">
                <PrepButton event={nextEvent} />
                <span className="text-[12.5px] text-ink-3">
                  Who they are, what you share, your intro and questions, one card at a time.
                </span>
              </div>
              <LinkedInHistory person={person} />
              <ResearchDebrief person={person} userId={user.id} />
              <div className="flex items-baseline justify-between gap-3 pt-2">
                <h2 className="text-[13px] font-medium text-ink">What you've learned yourself</h2>
                {facts.length > 0 && (
                  <span className="text-[12px] text-ink-3">
                    {facts.length === 1 ? '1 fact' : `${facts.length} facts`}
                  </span>
                )}
              </div>
              {tabsLoading && <SkeletonText lines={4} testId="facts-loading" />}
              {!tabsLoading && facts.length === 0 && (
                <p className="text-ink-3 text-[12.5px] -mt-2" data-testid="facts-empty">
                  Nothing yet. Facts come in from your emails and meeting notes, or add one below.
                </p>
              )}
              {[...grouped.entries()].map(([type, fs]) => (
                <div key={type}>
                  <div className="text-[12px] uppercase tracking-wide text-ink-3 mb-1.5">
                    {FACT_TYPE_LABELS[type as keyof typeof FACT_TYPE_LABELS] ?? 'Other'}
                  </div>
                  <ul className="space-y-1.5">
                    {fs.map((f) => (
                      <li key={f.id} className="group flex items-start gap-2 text-[13.5px]">
                        <span className="flex-1">
                          {/* stored as written in the notes ("She offered to intro me"); shown to the student as "you" */}
                          {/* a "Why them" line was written to them, so it is shown as written, in quotes */}
                          {f.sourceTable === 'outbound' ? `“${f.text}”` : toYou(f.text)}{' '}
                          <span className="text-ink-3 text-[12px]">
                            ·{' '}
                            {f.sourceTable === 'notes'
                              ? 'from notes'
                              : f.sourceTable === 'manual'
                                ? 'added by you'
                                : f.sourceTable === 'outbound'
                                  ? 'from a message you wrote'
                                  : f.sourceTable === 'messages'
                                    ? 'from email'
                                    : f.sourceTable === 'dossiers'
                                      ? 'from research'
                                      : 'from Orbit'}
                            {f.occurredAt ? ` · ${shortDate(f.occurredAt)}` : ''}
                          </span>
                          {conflicts.has(f.id) && (
                            <span className="block text-[12px] text-warn mt-0.5" data-testid="fact-conflict">
                              Disagrees with “{conflicts.get(f.id)}”. Delete the one that is wrong.
                            </span>
                          )}
                        </span>
                        <button
                          className="shrink-0 -my-1 p-1.5 opacity-100 @3xl:opacity-0 @3xl:group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 text-ink-3 hover:text-bad rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                          title="Delete this fact (it won't come back)"
                          aria-label={`Delete fact: ${f.text}`}
                          onClick={async () => {
                            await deleteFact(user.id, f.id);
                            toast.push({
                              text: 'Fact deleted. Drafts will not use it.',
                              action: { label: 'Undo', onClick: () => restoreFact(f.id) },
                              ttl: 6000,
                            });
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <AddFact personId={person.id} userId={user.id} />
              {notes.length > 0 && (
                <div>
                  <div className="text-[12px] uppercase tracking-wide text-ink-3 mb-1.5">Notes</div>
                  {notes.map((n) => (
                    <details key={n.id} className="border border-line rounded-lg p-3 mb-2">
                      <summary className="cursor-pointer text-[13.5px] font-medium">
                        {n.title}{' '}
                        <span className="text-ink-3 font-normal">
                          · {shortDate(n.occurredAt)} · {NOTE_SOURCE_LABELS[n.source] ?? 'Note'}
                        </span>
                      </summary>
                      <p className="text-[13px] text-ink-2 mt-2 whitespace-pre-line">
                        {n.summary ?? n.rawText.slice(0, 600)}
                      </p>
                    </details>
                  ))}
                </div>
              )}
            </div>
          )}
          {tab === 'connections' && (
            <div className="space-y-2">
              {tabsLoading && <SkeletonRows rows={4} avatar={28} testId="connections-loading" />}
              {!tabsLoading && neighbours.filter(Boolean).length === 0 && (
                <p className="text-ink-3 text-[13px]">
                  No inferred connections yet. These appear from shared employers, schools, threads and
                  meetings.
                </p>
              )}
              {edges.map((e) => {
                const other = neighbours.find(
                  (p) => p && p.id === (e.personAId === id ? e.personBId : e.personAId),
                ) as Person | undefined;
                if (!other) return null;
                return (
                  <Link
                    key={e.id}
                    to={`/people/${other.id}`}
                    className="flex items-center gap-3 border border-line rounded-lg p-3 hover:bg-canvas-2/60"
                  >
                    <Avatar name={other.displayName} src={other.photoUrl} id={other.id} size={30} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] font-medium">
                        {other.displayName}{' '}
                        <span className="text-ink-3 font-normal">
                          {other.currentOrganizationRaw ? `· ${other.currentOrganizationRaw}` : ''}
                        </span>
                      </div>
                      <div className="text-[12px] text-ink-3">
                        {e.evidence.text ?? 'Inferred from shared history'}
                      </div>
                    </div>
                    <StrengthDots v={e.weight} label="Tie strength" />
                  </Link>
                );
              })}
            </div>
          )}
        </div>
        <div className="space-y-4">
          <TieScoreCard person={person} userId={user.id} />
          <TextsCard personId={person.id} firstName={person.firstName} />
          {isServerUser(user.id) && <DossierCard person={person} userId={user.id} />}
          <Card>
            <div className="font-medium mb-2">Summary</div>
            <p className="text-[13.5px] text-ink-2 leading-relaxed" data-testid="person-summary">
              {summary}
            </p>
            {talkingPoints && talkingPoints.length > 0 && (
              <>
                <div className="font-medium mt-4 mb-1.5">Talking points</div>
                <ul className="list-disc pl-4 text-[13.5px] text-ink-2 space-y-1">
                  {talkingPoints.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </>
            )}
            <button
              className="mt-3 text-[12px] text-ink-3 underline"
              onClick={() => refreshPersonSummary(user, person.id)}
              title="Rewrite this summary from the latest emails, meetings and notes"
            >
              Refresh summary
            </button>
          </Card>
          <MutualConnections user={user} person={person} />
          {chat?.warmUp && (
            <Card>
              <div className="font-medium mb-2">LinkedIn warm-up</div>
              <ul className="space-y-2 text-[13px]">
                {chat.warmUp.actions.map((a) => (
                  <li key={a.id} className="flex items-center gap-2">
                    <span
                      className={cx(
                        'w-4 h-4 rounded-full border inline-flex items-center justify-center text-[10px]',
                        a.doneAt
                          ? 'bg-good border-good text-white'
                          : a.skippedAt
                            ? 'bg-line border-line'
                            : 'border-line',
                      )}
                    >
                      {a.doneAt ? '✓' : ''}
                    </span>
                    <span className={cx('flex-1', (a.doneAt || a.skippedAt) && 'text-ink-3 line-through')}>
                      {a.label}
                    </span>
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-ink-3 hover:text-ink"
                      aria-label={`Open on LinkedIn: ${a.label}`}
                      title="Open on LinkedIn"
                    >
                      <ExternalLink size={13} />
                    </a>
                  </li>
                ))}
              </ul>
              <p className="text-[12px] text-ink-3 mt-2">
                First message suggested after{' '}
                {new Date(chat.warmUp.readyAt).toLocaleDateString('en-US', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                })}
                .{' '}
                {person.linkedinSlug && (
                  <a
                    className="underline"
                    href={linkedinActivityUrl(person.linkedinSlug)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Their activity
                  </a>
                )}
              </p>
            </Card>
          )}
          {items.filter((i) => i.status === 'open').length > 0 && (
            <Card>
              <div className="font-medium mb-2">You promised</div>
              <ul className="space-y-1.5 text-[13px]">
                {items
                  .filter((i) => i.status === 'open')
                  .map((i) => (
                    <li key={i.id} className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        aria-label={`Mark done: ${i.text}`}
                        onChange={() => markActionItemDone(i.id)}
                      />
                      <span className="flex-1">
                        {promiseText(i.text, person.firstName)}
                        {i.dueAt ? <span className="text-ink-3"> · due {relDate(i.dueAt)}</span> : null}
                      </span>
                    </li>
                  ))}
              </ul>
            </Card>
          )}
          {affs.length > 0 && (
            <Card>
              <div className="font-medium mb-2">History</div>
              <ul className="space-y-1.5 text-[13px]">
                {affs
                  .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''))
                  .map((a) => (
                    <li key={a.id}>
                      <span className="font-medium">
                        {a.title ?? a.degree ?? (a.kind === 'education' ? 'Student' : 'Role')}
                      </span>{' '}
                      <span className="text-ink-2">· {a.nameRaw}</span>
                      {a.startDate ? (
                        <span className="text-ink-3">
                          {' '}
                          · {a.startDate.slice(0, 4)}
                          {a.isCurrent ? ' to now' : a.endDate ? ` to ${a.endDate.slice(0, 4)}` : ''}
                        </span>
                      ) : null}
                    </li>
                  ))}
              </ul>
            </Card>
          )}
          {chats.length > 1 && (
            <Card>
              <div className="font-medium mb-2">Past chats</div>
              <ul className="text-[13px] space-y-1">
                {chats.map((c) => (
                  <li key={c.id}>
                    {STAGE_LABELS[c.stage]} · started {shortDate(c.createdAt)}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function AddFact({ personId, userId }: { personId: string; userId: string }) {
  const [text, setText] = useState('');
  const [type, setType] = useState<ManualFactType>('hook');
  const add = async () => {
    // Take the text now and clear the box at once: clearing after the save would wipe a fact typed while it ran.
    const value = text.trim();
    if (!value) return;
    setText('');
    try {
      await addFact(userId, personId, type, value);
    } catch {
      setText((current) => current || value); // the save failed: give the words back unless new ones were typed
    }
  };
  // one quiet field: the kind as a small chip inside it, the words, and Add, which only lights up once there are words
  return (
    <div
      className="flex items-center gap-1.5 h-11 pl-1.5 pr-1.5 rounded-full border border-line bg-canvas focus-within:border-ink-3 focus-within:ring-2 focus-within:ring-accent/20 transition-[box-shadow,border-color]"
      data-testid="add-fact"
    >
      <label className="relative shrink-0">
        <span className="sr-only">Kind of fact</span>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as never)}
          className="appearance-none h-8 rounded-full bg-canvas-2 pl-3 pr-7 text-[12.5px] font-medium text-ink-2 hover:text-ink cursor-pointer focus-visible:outline-none"
        >
          {MANUAL_FACT_TYPES.map((t) => (
            <option key={t} value={t}>
              {FACT_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <ChevronDown
          size={13}
          aria-hidden
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3"
        />
      </label>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Something you know about them"
        aria-label="New fact"
        className="flex-1 min-w-0 h-8 bg-transparent px-2 text-[13.5px] placeholder:text-ink-3 focus:outline-none"
        onKeyDown={(e) => {
          if (e.key === 'Enter') add();
        }}
      />
      <Button
        size="sm"
        variant={text.trim() ? 'primary' : 'ghost'}
        onClick={add}
        disabled={!text.trim()}
        className="rounded-full"
      >
        Add
      </Button>
    </div>
  );
}

/** Closeness in words: the same band the closeness card names (Faint, Light, Warm, Strong, Close). */
export function closenessWord(v: number): string {
  return TIE_BAND_LABELS[tieBand(Math.round(v * 100))];
}

/** Texts with them, from the Mac's Messages: how much, how lately, and the last few messages (kept in this browser). */
function TextsCard({ personId, firstName }: { personId: string; firstName: string }) {
  const t = useLiveQuery(() => db.textThreads.get(personId), [personId]);
  if (!t) return null;
  return (
    <Card data-testid="person-texts">
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-medium">Texts</div>
        <div className="text-[12.5px] text-ink-3">
          {t.inCount + t.outCount} · last {relDate(t.lastAt)}
        </div>
      </div>
      <ul className="mt-3 space-y-1.5">
        {t.recent.slice(-3).map((m) => (
          <li key={m.at} className={cx('flex', m.fromMe ? 'justify-end' : 'justify-start')}>
            <span
              className={cx(
                'max-w-[85%] rounded-[14px] px-3 py-1.5 text-[13px] leading-snug',
                m.fromMe ? 'bg-accent text-white' : 'bg-canvas-2 text-ink',
              )}
              title={new Date(m.at).toLocaleString()}
            >
              {m.text}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11.5px] text-ink-3">
        {t.inCount} from {firstName || 'them'}, {t.outCount} from you
      </p>
    </Card>
  );
}

/** The person's page while their record loads: the header, the tabs and the side cards in outline. */
function PersonLoading() {
  return (
    <div
      className="loading-in"
      role="status"
      aria-busy="true"
      aria-label="Loading"
      data-testid="person-loading"
    >
      <Skeleton className="h-3 w-16 mb-5" />
      <div className="flex items-center gap-4">
        <Skeleton className="w-16 h-16 rounded-full shrink-0" />
        <div className="flex-1 space-y-2.5">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3 w-64 max-w-full" />
        </div>
        <Skeleton className="h-9 w-28 rounded-full hidden sm:block" />
      </div>
      <div className="grid @4xl:grid-cols-[minmax(0,1fr)_320px] gap-6 items-start mt-8">
        <div>
          <div className="flex gap-5 border-b border-line pb-2.5 mb-5">
            {[64, 70, 52, 92].map((w) => (
              <Skeleton key={w} className="h-3" style={{ width: w }} />
            ))}
          </div>
          <SkeletonRows rows={5} avatar={18} />
        </div>
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="rounded-[var(--radius-card)] border border-line bg-canvas p-4 space-y-2.5"
            >
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-2.5 w-full" />
              <Skeleton className="h-2.5 w-4/5" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
