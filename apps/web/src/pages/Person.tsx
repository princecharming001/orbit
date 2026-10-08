import type {
  ActionItem,
  CalendarEvent,
  CoffeeChat,
  MessageKind,
  Person,
  FactType as PersonFactType,
  ResumeFacet,
} from '@orbit/core';
import {
  CHANNEL_LABELS,
  composeKindFor,
  conflictingFacts,
  FACT_TYPE_LABELS,
  linkedinActivityUrl,
  MESSAGE_KIND_LABELS,
  NOTE_SOURCE_LABELS,
  newId,
  RELATIONSHIP_LABELS,
  relTime,
  STAGE_LABELS,
  TOUCHPOINT_LABELS,
} from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { ExternalLink, Linkedin, Mail, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { runApproval } from '../components/approve';
import { DraftEditor, handoffWhere, OutboxStatus } from '../components/DraftEditor';
import { ConfirmEarlyDone, chatTimeLabel, ScheduleChatDialog } from '../components/ScheduleChat';
import { SuggestionCard } from '../components/SuggestionCard';
import { feedback } from '../db/repo';
import { db } from '../db/schema';
import {
  draftMessage,
  isMessageSuggestion,
  needsWarmUp,
  refreshPersonSummary,
  startWarmUpOrOutreach,
  unsentDraftOf,
} from '../engine/brief';
import { readSuggestedNames, type SuggestedName, saveSuggestedContacts } from '../engine/introductions';
import { moveChat, upcomingMeeting } from '../engine/move';
import { buildPrep, personSummary, toYou } from '../engine/prep';
import { useSession } from '../state/session';
import { Avatar, Button, Card, Chip, cx, Modal, NotFound, relDate, Select, Tabs, useToast } from '../ui';
import { STAGE_COLOR, StrengthDots } from './Pipeline';

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
  const tab = (params.get('tab') as 'timeline' | 'facts' | 'connections' | 'prep') ?? 'timeline';
  const nav = useNavigate();
  const toast = useToast();
  // null: looked it up and it is not there (merged, deleted, bad link); undefined: still loading.
  const person = useLiveQuery(async () => (id ? ((await db.people.get(id)) ?? null) : null), [id]);
  const chats = useLiveQuery(() => (id ? db.chats.where('personId').equals(id).toArray() : []), [id]) ?? [];
  const tps =
    useLiveQuery(() => (id ? db.touchpoints.where('personId').equals(id).toArray() : []), [id]) ?? [];
  const facts =
    useLiveQuery(
      () =>
        id
          ? db.facts
              .where('personId')
              .equals(id)
              .filter((f) => !f.deletedAt)
              .toArray()
          : [],
      [id],
    ) ?? [];
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
  const edges =
    useLiveQuery(
      () => (id ? db.edges.where('personAId').equals(id).or('personBId').equals(id).toArray() : []),
      [id],
    ) ?? [];
  const affs =
    useLiveQuery(() => (id ? db.affiliations.where('personId').equals(id).toArray() : []), [id]) ?? [];
  const neighbourIds = useMemo(
    () => edges.map((e) => (e.personAId === id ? e.personBId : e.personAId)),
    [edges, id],
  );
  const neighbours =
    useLiveQuery(
      () => (neighbourIds.length ? db.people.bulkGet(neighbourIds) : []),
      [neighbourIds.join(',')],
    ) ?? [];
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
  const [early, setEarly] = useState<string>();
  const settings = useSession().settings;
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
  // the summary is rewritten when something newer than it happened (a message sent, a note, a fact typed in), so it
  // never says "you haven't been in touch" after the first email went out
  const newestActivity = [...tps.map((t) => t.occurredAt), ...facts.map((f) => f.createdAt)]
    .filter((at) => at <= new Date().toISOString())
    .reduce((m, at) => (at > m ? at : m), '');
  const summaryStale =
    !!person?.summary && !!person.summaryUpdatedAt && newestActivity > person.summaryUpdatedAt;
  useEffect(() => {
    if (person && user && (!person.summary || summaryStale)) refreshPersonSummary(user, person.id);
  }, [person?.id, person?.summary, user, summaryStale]);
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
  if (!user || person === undefined) return null;
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
    const channel = person.primaryEmail ? 'gmail' : 'linkedin';
    // read from the database too: a page opened from Discover or Today may not have its drafts loaded yet
    const started = openDraftFor(kind) ?? (await unsentDraftOf(person.id, kind));
    if (started) {
      setDraftId(started.id);
      setComposing(kind);
      return;
    }
    // A cold LinkedIn-only contact: explain the warm-up and let the student choose before anything starts.
    if (
      kind === 'outreach' &&
      !chat &&
      !opts.confirmed &&
      needsWarmUp(person, channel, settings?.warmUpEnabled ?? true)
    ) {
      setWarmUpChoice(true);
      return;
    }
    setBusy(true);
    if (kind === 'outreach' && (!chat || (chat.stage === 'warming' && opts.skipWarmUp))) {
      const r = await startWarmUpOrOutreach(user, person.id, channel, 'manual', {
        skipWarmUp: opts.skipWarmUp,
      });
      setBusy(false);
      if (!r.draft) {
        toast.push({
          text: `Warm-up started for ${person.firstName}. The first step is outlined below.`,
          tone: 'good',
          ttl: 6000,
        });
        nav(`/today?person=${person.id}`);
        return;
      }
      setDraftId(r.draft.id);
      setComposing(kind);
      return;
    }
    const d = await draftMessage(user, person.id, kind, channel, chat?.id);
    setDraftId(d.id);
    setComposing(kind);
    setBusy(false);
  };
  const draft = drafts.find((d) => d.id === draftId);
  /** Drop a draft the student started; `quiet` when nothing of theirs is in it, otherwise with an Undo. */
  const discardDraft = async (id: string, quiet = false) => {
    await db.outbound
      .where('id')
      .equals(id)
      .filter((m) => m.status === 'draft')
      .modify({ status: 'cancelled' });
    if (id === draftId) {
      setComposing(undefined);
      setDraftId(undefined);
    }
    if (!quiet)
      toast.push({
        text: 'Draft discarded.',
        action: {
          label: 'Undo',
          onClick: () =>
            db.outbound
              .where('id')
              .equals(id)
              .filter((m) => m.status === 'cancelled')
              .modify({ status: 'draft' }),
        },
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
  const liveSummary = person.summary
    ? undefined
    : personSummary({ user, person, facts, touchpoints: tps, now: new Date() });
  const summary = person.summary ?? liveSummary?.summary;
  const talkingPoints = person.summary ? person.talkingPoints : liveSummary?.talkingPoints;
  return (
    <div>
      <div className="flex flex-col lg:flex-row lg:items-start gap-4 mb-5" data-testid="person-header">
        <div className="flex items-start gap-4 min-w-0 flex-1">
          <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={56} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-[22px] font-semibold tracking-[-0.01em] break-words">
                {person.displayName}
              </h1>
              {person.isAlumni && <Chip tone="accent">{user.school} alum</Chip>}
              {chat && (
                <Chip>
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: STAGE_COLOR[chat.stage] }}
                  />
                  {STAGE_LABELS[chat.stage]}
                </Chip>
              )}
            </div>
            <p className="text-ink-2 mt-0.5">
              {person.headline ??
                [person.currentTitle, person.currentOrganizationRaw].filter(Boolean).join(' at ')}
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
        <div className="flex flex-col items-stretch lg:items-end gap-2 w-full lg:w-auto lg:shrink-0">
          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            <label className="inline-flex items-center gap-1.5 text-[12px] text-ink-3">
              How you know them
              <Select
                value={person.relationshipType}
                onChange={(e) => db.people.update(person.id, { relationshipType: e.target.value as never })}
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
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => {
                // the stage and the calendar together: no check-in minutes after a thank-you
                const next = composeKindFor(chat, new Date());
                if ('wait' in next)
                  toast.push({
                    text: `You wrote to ${person.firstName} ${relTime(next.wait.since, new Date())}. A check-in fits in a few weeks, and Orbit will suggest one.`,
                    tone: 'neutral',
                    ttl: 6000,
                  });
                else compose(next.kind);
              }}
              data-testid="person-write"
            >
              Write to {person.firstName}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1 text-[12px] lg:justify-end">
            {chat && (
              <label className="inline-flex items-center gap-1.5 text-ink-3 mr-1">
                Stage
                <Select
                  value={chat.stage}
                  onChange={async (e) => {
                    const to = e.target.value as CoffeeChat['stage'];
                    // a chat still ahead is not done yet: ask before drafting a thank-you for it
                    const ahead = to === 'completed' ? await upcomingMeeting(chat) : undefined;
                    if (ahead && new Date(ahead.startAt).getTime() > Date.now()) {
                      setEarly(ahead.startAt);
                      return;
                    }
                    await moveChat(user, chat, to, 'user:select');
                    if (to === 'scheduled' && !(await upcomingMeeting(chat))) setAsking(true);
                  }}
                  className="h-8 text-[12px] text-ink"
                  aria-label="Chat stage"
                  title="Move this chat to another stage"
                >
                  {Object.entries(STAGE_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => nav(`/notes/new?person=${person.id}`)}
              title={`Add notes from a conversation with ${person.firstName}`}
            >
              Add note
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => nav(`/map?reach=${person.id}`)}
              title={`See who you know that could introduce you to ${person.firstName}`}
            >
              Find an intro
            </Button>
            <Button
              variant="ghost"
              size="sm"
              title={
                person.hiddenAt
                  ? 'Show this person again in People, Today and the map'
                  : 'Hide this person from People, Today and the map'
              }
              onClick={async () => {
                if (person.hiddenAt) {
                  await db.people.update(person.id, { hiddenAt: undefined });
                  toast.push({ text: `${person.firstName} is back in People, Today and the map.` });
                  return;
                }
                await db.people.update(person.id, { hiddenAt: new Date().toISOString() });
                toast.push({
                  text: `Hid ${person.displayName}. Find them under Hidden in People.`,
                  action: {
                    label: 'Undo',
                    onClick: () => db.people.update(person.id, { hiddenAt: undefined }),
                  },
                  ttl: 7000,
                });
                nav('/people');
              }}
            >
              {person.hiddenAt ? 'Show again' : 'Hide from lists'}
            </Button>
          </div>
        </div>
      </div>

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
            shows up on Today, and the message is drafted when the warm-up is done.
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
              <SuggestionCard key={w.id} s={w} compact />
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
                {kindsFor(chat?.stage, composing).length > 1
                  ? ' Pick another and it rewrites the draft.'
                  : ''}
              </div>
              {composing === 'outreach' && chat?.stage === 'warming' && chat.warmUp && (
                <div className="text-[12px] text-warn mt-0.5" data-testid="compose-warmup-early">
                  Your warm-up is {chat.warmUp.actions.filter((a) => a.doneAt).length} of{' '}
                  {chat.warmUp.actions.length} steps done. You can write now, but the message lands better
                  once {person.firstName} has seen your name.
                </div>
              )}
            </div>
            {/* one kind only: nothing to switch to, so no button that looks like one (it used to restart the draft) */}
            {kindsFor(chat?.stage, composing).length > 1 && (
              <div className="flex flex-wrap gap-1 text-[12px]" role="group" aria-label="Kind of message">
                {kindsFor(chat?.stage, composing).map((k) => (
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

      <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] gap-6 items-start">
        <div className="min-w-0">
          <Tabs
            value={tab}
            onChange={(v) => setParams({ tab: v })}
            items={[
              { value: 'timeline', label: 'Timeline', count: timeline.length },
              { value: 'facts', label: 'Facts', count: facts.length },
              { value: 'connections', label: 'Who they know', count: neighbours.filter(Boolean).length },
              { value: 'prep', label: 'Prep' },
            ]}
          />
          {tab === 'timeline' && (
            <ol className="relative border-l border-line ml-3 space-y-4">
              {timeline.length === 0 && <li className="pl-5 text-ink-3 text-[13px]">No interactions yet.</li>}
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
          {tab === 'facts' && (
            <div className="space-y-4">
              {facts.length === 0 && (
                <p className="text-ink-3 text-[13px]">
                  Nothing yet. Facts come from emails and meeting notes.
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
                          className="shrink-0 -my-1 p-1.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 text-ink-3 hover:text-bad rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                          title="Delete this fact (it won't come back)"
                          aria-label={`Delete fact: ${f.text}`}
                          onClick={async () => {
                            await db.facts.update(f.id, { deletedAt: new Date().toISOString() });
                            await feedback(user.id, 'fact_delete', { refTable: 'facts', refId: f.id });
                            toast.push({
                              text: 'Fact deleted. Drafts will not use it.',
                              action: {
                                label: 'Undo',
                                onClick: () => db.facts.update(f.id, { deletedAt: undefined }),
                              },
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
              {neighbours.filter(Boolean).length === 0 && (
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
                    <Avatar name={other.displayName} id={other.id} size={30} />
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
          {tab === 'prep' && (
            <Prep
              person={person}
              facts={facts}
              timeline={timeline}
              items={items}
              chat={chat}
              chats={chats}
              event={nextEvent}
              resumeFacets={resumeFacets}
              userId={user.id}
            />
          )}
        </div>
        <div className="space-y-4">
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
                        onChange={() => db.actionItems.update(i.id, { status: 'done' })}
                      />
                      <span className="flex-1">
                        {i.text}
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
  const [type, setType] = useState<'hook' | 'advice' | 'offer' | 'personal' | 'role_detail' | 'background'>(
    'hook',
  );
  const add = async () => {
    if (!text.trim()) return;
    await db.facts.add({
      id: newId('f'),
      userId,
      personId,
      type,
      text: text.trim(),
      sourceTable: 'manual',
      sourceId: 'manual',
      confidence: 1,
      occurredAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    setText('');
  };
  return (
    <div className="flex flex-wrap gap-2 items-center">
      <Select
        value={type}
        onChange={(e) => setType(e.target.value as never)}
        className="h-8 text-[13px]"
        aria-label="Kind of fact"
      >
        {(['hook', 'advice', 'offer', 'personal', 'role_detail', 'background'] as const).map((t) => (
          <option key={t} value={t}>
            {FACT_TYPE_LABELS[t]}
          </option>
        ))}
      </Select>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Something you know about them"
        aria-label="New fact"
        className="flex-1 min-w-[160px] h-8 rounded-lg border border-line px-2.5 text-[13px]"
        onKeyDown={(e) => {
          if (e.key === 'Enter') add();
        }}
      />
      <Button size="sm" onClick={add} disabled={!text.trim()}>
        Add
      </Button>
    </div>
  );
}

function Prep({
  person,
  facts,
  timeline,
  items,
  chat,
  chats,
  event,
  resumeFacets,
  userId,
}: {
  person: Person;
  facts: { type: string; text: string }[];
  timeline: { at: string; text: string }[];
  items: Pick<ActionItem, 'text' | 'status'>[];
  chat?: CoffeeChat;
  chats: CoffeeChat[];
  event?: CalendarEvent;
  resumeFacets: ResumeFacet[];
  userId: string;
}) {
  const [suggested, setSuggested] = useState('');
  const [added, setAdded] = useState<string[]>([]);
  const [notSaved, setNotSaved] = useState<string[]>([]);
  // names the reader is not sure are people ("will park", "Dr. Patel"): nothing is saved until the student says so
  const [unsure, setUnsure] = useState<SuggestedName[]>([]);
  const { user, goals } = useSession();
  const keep = async (list: SuggestedName[]) => {
    const people = await saveSuggestedContacts(userId, person.id, list);
    if (people.length) setAdded((a) => [...a, ...people.map((p) => p.displayName)]);
  };
  const label = (s: SuggestedName) => (s.org ? `${s.name} at ${s.org}` : s.name);
  const plan = useMemo(
    () =>
      user
        ? buildPrep({
            user,
            goals,
            person,
            facts: facts as { type: PersonFactType; text: string }[],
            chats,
            event,
            resumeFacets,
            now: new Date(),
          })
        : undefined,
    [user, goals, person, facts, chats, event, resumeFacets],
  );
  if (!user || !plan) return null;
  const picked = chat?.prepQuestions ?? [];
  const toggle = async (q: string) => {
    if (!chat) return;
    const next = picked.includes(q) ? picked.filter((x) => x !== q) : [...picked, q];
    await db.chats.update(chat.id, { prepQuestions: next, updatedAt: new Date().toISOString() });
  };
  const advice = facts.filter((f) => f.type === 'advice');
  const role = facts.filter((f) => f.type === 'role_detail' || f.type === 'background');
  const personal = facts.filter((f) => f.type === 'personal');
  const open = items.filter((i) => i.status === 'open');
  const tz = user.timezone || undefined;
  // the same email subject five times says nothing: one line per thing, newest first
  const lastTimes = timeline.filter((t, i) => timeline.findIndex((x) => x.text === t.text) === i).slice(0, 4);
  return (
    <div className="space-y-4 text-[13.5px]" data-testid="prep">
      <Card>
        <div className="font-medium">Your goal for this chat</div>
        <p className="text-ink-2 mt-1">{plan.goal}</p>
        <div className="font-medium mt-3">Your one ask</div>
        <p className="text-ink-2 mt-1">{plan.ask}</p>
      </Card>
      <Card>
        <div className="font-medium">When and where</div>
        {plan.logistics ? (
          <p className="text-ink-2 mt-1">
            {plan.logistics.when}
            {plan.logistics.link && (
              <>
                {' · '}
                <a className="underline" href={plan.logistics.link} target="_blank" rel="noreferrer">
                  Join link
                </a>
              </>
            )}
          </p>
        ) : (
          <p className="text-ink-3 mt-1">Nothing on your calendar with {person.firstName} yet.</p>
        )}
        <ul className="list-disc pl-4 mt-2 text-ink-2 space-y-1">
          {plan.logisticsTips.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </Card>
      <Card>
        <div className="font-medium">Before the call</div>
        <ul className="mt-2 space-y-1.5 text-ink-2">
          {plan.research.map((r) => (
            <li key={r.label} className="flex items-start gap-2">
              <span aria-hidden className="text-ink-3">
                •
              </span>
              {r.url ? (
                <a
                  className="underline-offset-2 hover:underline"
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {r.label}
                </a>
              ) : (
                <span>{r.label}</span>
              )}
            </li>
          ))}
          <li className="flex items-start gap-2">
            <span aria-hidden className="text-ink-3">
              •
            </span>
            <span>Practice your 30-second intro out loud once.</span>
          </li>
        </ul>
        {plan.intro && (
          <blockquote className="mt-3 rounded-lg bg-canvas-2 px-3 py-2 text-ink-2" data-testid="prep-intro">
            {plan.intro}
          </blockquote>
        )}
        {plan.introMissing && <p className="text-ink-3 text-[12px] mt-2">{plan.introMissing}</p>}
      </Card>
      <Card>
        <div className="font-medium">Who they are</div>
        <p className="text-ink-2 mt-1">
          {[
            person.headline ??
              [person.currentTitle, person.currentOrganizationRaw].filter(Boolean).join(' at '),
            person.isAlumni ? `${user.school} alum` : undefined,
            person.location,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {role.length > 0 && (
          <ul className="list-disc pl-4 mt-2 text-ink-2 space-y-1">
            {role.slice(0, 4).map((f, i) => (
              <li key={i}>{f.text}</li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <div className="font-medium">Questions to ask</div>
        <p className="text-ink-3 text-[12px] mt-0.5">
          {chat
            ? 'Tick up to three you most want answered. Orbit keeps them with this chat.'
            : 'Pick three to lead with.'}
        </p>
        <ol className="mt-2 space-y-1.5 text-ink-2">
          {plan.questions.map((q, i) => (
            <li key={q} className="flex items-start gap-2">
              {chat ? (
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={picked.includes(q)}
                  // three is the point: more than that and nothing gets asked properly
                  disabled={!picked.includes(q) && picked.length >= 3}
                  onChange={() => toggle(q)}
                  aria-label={`Pick question ${i + 1}`}
                />
              ) : (
                <span className="text-ink-3 tabular w-4">{i + 1}.</span>
              )}
              <span>{q}</span>
            </li>
          ))}
          <li className="flex items-start gap-2">
            <span className="text-ink-3 w-4" aria-hidden>
              ↳
            </span>
            <span>
              <span className="font-medium text-ink">Always close with:</span> {plan.closing}
            </span>
          </li>
        </ol>
        {picked.length > 0 && (
          <p className="text-[12px] text-ink-3 mt-2" data-testid="prep-picked">
            {picked.length} picked for this chat.
          </p>
        )}
        {(chat?.completedAt || ['completed', 'followed_up', 'nurturing'].includes(chat?.stage ?? '')) && (
          <>
            <label className="block mt-3 text-ink-2" htmlFor="prep-suggested">
              Who did {person.firstName} suggest you talk to?
            </label>
            <input
              id="prep-suggested"
              data-testid="prep-suggested"
              value={suggested}
              onChange={(e) => setSuggested(e.target.value)}
              placeholder="Priya Shah at Stripe, Tom Lee"
              className="mt-1 w-full h-8 rounded-lg border border-line px-2.5 text-[13px]"
              onKeyDown={async (e) => {
                if (e.key !== 'Enter' || !suggested.trim()) return;
                // clear names are saved; unsure ones wait for a yes; what is not a name stays in the field with a note
                const { names, confirm, skipped } = readSuggestedNames(suggested);
                await keep(names);
                setUnsure((u) => [
                  ...u,
                  ...confirm.filter((c) => !u.some((x) => x.name.toLowerCase() === c.name.toLowerCase())),
                ]);
                setNotSaved(skipped);
                setSuggested(skipped.join(', '));
              }}
            />
            {unsure.length > 0 && (
              <div className="mt-2 rounded-lg border border-line p-2.5" data-testid="prep-suggested-confirm">
                <p className="text-ink-2">
                  Are these people {person.firstName} suggested? Nothing is saved until you say yes.
                </p>
                <ul className="mt-1.5 space-y-1.5">
                  {unsure.map((s) => (
                    <li
                      key={label(s)}
                      className="flex flex-wrap items-center gap-2"
                      data-testid="prep-confirm-row"
                    >
                      <span className="flex-1 min-w-0 font-medium">{label(s)}</span>
                      <Button
                        size="sm"
                        data-testid="prep-confirm-save"
                        onClick={async () => {
                          setUnsure((u) => u.filter((x) => x !== s));
                          await keep([s]);
                        }}
                      >
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid="prep-confirm-skip"
                        onClick={() => setUnsure((u) => u.filter((x) => x !== s))}
                      >
                        Not a person
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {notSaved.length > 0 && (
              <p className="mt-1.5 text-ink-2" data-testid="prep-suggested-skipped">
                Not saved: {notSaved.join(', ')}. Write each as a full name, like Priya Shah at Stripe or Tom
                Lee.
              </p>
            )}
            {added.length > 0 && (
              <p className="mt-1.5 text-ink-3">
                Saved to Discover as suggested by {person.firstName}: {added.join(', ')}
              </p>
            )}
          </>
        )}
      </Card>
      <Card>
        <div className="font-medium">From last time</div>
        {lastTimes.length ? (
          <ul className="list-disc pl-4 mt-2 text-ink-2 space-y-1">
            {lastTimes.map((t, i) => (
              <li key={i}>
                {t.text}{' '}
                <span className="text-ink-3 text-[12px]">
                  ·{' '}
                  {new Date(t.at).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    timeZone: tz,
                  })}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-3 mt-1">This is your first conversation.</p>
        )}
        {plan.followUps.length > 0 && (
          <>
            <div className="font-medium mt-3">Follow up on</div>
            <ul className="list-disc pl-4 mt-1 text-ink-2 space-y-1">
              {plan.followUps.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </>
        )}
        {advice.length > 0 && (
          <>
            <div className="font-medium mt-3">Advice they gave</div>
            <ul className="list-disc pl-4 mt-1 text-ink-2 space-y-1">
              {advice.map((f, i) => (
                <li key={i}>{f.text}</li>
              ))}
            </ul>
          </>
        )}
        {open.length > 0 && (
          <>
            <div className="font-medium mt-3">You promised</div>
            <ul className="list-disc pl-4 mt-1 text-ink-2 space-y-1">
              {open.map((i, k) => (
                <li key={k}>{i.text}</li>
              ))}
            </ul>
          </>
        )}
        {personal.length > 0 && (
          <>
            <div className="font-medium mt-3">Personal</div>
            <ul className="list-disc pl-4 mt-1 text-ink-2 space-y-1">
              {personal.slice(0, 3).map((f, i) => (
                <li key={i}>{f.text}</li>
              ))}
            </ul>
          </>
        )}
      </Card>
      <Card>
        <div className="font-medium">Things to avoid</div>
        <ul className="list-disc pl-4 mt-2 text-ink-2 space-y-1">
          {plan.audience === 'recruiter' ? (
            <>
              <li>Asking a recruiter for a coffee chat or a referral. Keep it to the process.</li>
              <li>Asking anything the careers page already answers.</li>
            </>
          ) : (
            <>
              <li>Asking for a job or a referral in a first conversation.</li>
              <li>Generic praise. Mention something specific they said or did.</li>
            </>
          )}
          <li>Going over the time you asked for.</li>
        </ul>
      </Card>
    </div>
  );
}

/** Closeness in words: the score is a rough sense of how well you know them, not a precise number. */
export function closenessWord(v: number): string {
  return v >= 0.6 ? 'Close' : v >= 0.35 ? 'Getting to know' : v > 0.05 ? 'Light' : 'New contact';
}

/** The kinds of message that fit where the chat stands: no thank-you or referral ask to someone never met. */
export function kindsFor(stage: CoffeeChat['stage'] | undefined, current: MessageKind): MessageKind[] {
  const by: Partial<Record<CoffeeChat['stage'], MessageKind[]>> = {
    identified: ['outreach'],
    warming: ['outreach'],
    outreach_sent: ['bump', 'outreach'],
    no_response: ['bump', 'outreach'],
    replied: ['schedule', 'bump'],
    scheduling: ['schedule', 'bump'],
    scheduled: ['schedule'],
    completed: ['thank_you', 'nurture', 'referral_ask'],
    followed_up: ['nurture', 'referral_ask', 'schedule'],
    nurturing: ['nurture', 'referral_ask', 'schedule'],
    declined: ['nurture'],
  };
  const list = (stage && by[stage]) ?? ['outreach'];
  return list.includes(current) ? list : [current, ...list];
}
