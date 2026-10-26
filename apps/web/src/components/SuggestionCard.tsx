import type { OutboundStatus, Person, Suggestion } from '@orbit/core';
import { draftWarmUpComment, STAGE_LABELS, warmUpProgress } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, ChevronUp, Copy, ExternalLink, Sparkles } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { db } from '../db/schema';
import {
  ensureDrafts,
  isMessageSuggestion,
  markWarmUpAction,
  needsWarmUp,
  startWarmUpOrOutreach,
} from '../engine/brief';
import { quotedMessageFor, wroteWhen } from '../engine/conversation';
import { markPrepOpened } from '../engine/drafts';
import { markActionItemDone } from '../engine/facts';
import { answerHeldMeeting } from '../engine/fathom';
import { answerIntroductionQuestion } from '../engine/introductions';
import { stageNoLabel } from '../engine/morning';
import { decideMerge, mergeEvidence } from '../engine/people';
import { currentResumeFacets, sharesOrgNow } from '../engine/resume';
import { dismissSuggestion, restoreSuggestion, snoozeSuggestion } from '../engine/send';
import { applyStage, decideProposedStage } from '../engine/stages';
import { SUGGESTION_KIND_LABELS } from '../engine/today';
import { answerTrustOffer, LADDER_WORDS, type LadderKind } from '../engine/trust';
import { useSession } from '../state/session';
import { Avatar, Button, Chip, cx, useToast } from '../ui';
import { runApproval } from './approve';
import { CompanyLogo, PersonCompanyLogo } from './CompanyLogo';
import { DraftEditor, OutboxStatus } from './DraftEditor';
import { MergePair } from './MergePair';

/** Kept here for older imports; the labels live in the engine so the chat and the cards share them. */
export const KIND_LABEL = SUGGESTION_KIND_LABELS;

export { mergeEvidence };

export function SuggestionCard({
  s,
  highlight,
  onPersonPage,
  defaultOpen,
}: {
  s: Suggestion;
  /** open the draft at once (Drafts' reading pane, where the card is the thing being looked at) */
  defaultOpen?: boolean;
  /** on the person's own page: their face, name and role are already the page, so the card leaves them out */
  onPersonPage?: boolean;
  /** every card is flat now; callers that ask for the compact look get the same card */
  compact?: boolean;
  /** scroll to this card and outline it (Drafts opened from a link that points at it) */
  highlight?: boolean;
}) {
  const { user, settings } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(!!defaultOpen);
  const [busy, setBusy] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [mergeAsk, setMergeAsk] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlight]);
  const [postClaim, setPostClaim] = useState('');
  const [ownExperience, setOwnExperience] = useState('');
  // null: looked and it is not there; undefined: still loading (the card waits rather than drawing half of itself)
  const personRow = useLiveQuery(
    async () => (s.personId ? ((await db.people.get(s.personId)) ?? null) : null),
    [s.personId],
  );
  const draftRow = useLiveQuery(
    async () => (s.outboundMessageId ? ((await db.outbound.get(s.outboundMessageId)) ?? null) : null),
    [s.outboundMessageId],
  );
  const person = personRow ?? undefined;
  const draft = draftRow ?? undefined;
  // the card open in Drafts' reading pane writes its own draft at once, so it is never stuck behind the others (the
  // Drafts page drafts the rest; cards elsewhere keep their Draft button)
  const autoDraft =
    !!defaultOpen &&
    s.status === 'pending' &&
    !s.outboundMessageId &&
    s.kind !== 'new_outreach' &&
    isMessageSuggestion(s.kind);
  const [drafting, setDrafting] = useState(() => autoDraft);
  useEffect(() => {
    if (!autoDraft || !user) {
      setDrafting(false);
      return;
    }
    let live = true;
    setDrafting(true);
    ensureDrafts(user, [s.id])
      .catch(() => undefined)
      .finally(() => live && setDrafting(false));
    return () => {
      live = false;
    };
  }, [autoDraft, user, s.id]);
  const chat = useLiveQuery(() => (s.chatId ? db.chats.get(s.chatId) : undefined), [s.chatId]);
  const sharedOrgNow =
    useLiveQuery(
      async () =>
        s.kind === 'new_outreach' && person && user
          ? sharesOrgNow(person, await currentResumeFacets(user.id))
          : false,
      [s.kind, person?.currentOrganizationRaw, user?.id],
    ) ?? false;
  const other = useOther(s.payload.otherPersonId as string | undefined);
  const introducer = useOther(s.payload.introducerId as string | undefined);
  // the message the card is about: the reply it answers, or what made Orbit think the stage changed (plan 25)
  const evidence = useLiveQuery(
    () => quotedMessageFor(s),
    [s.kind, s.payload.stageEventId, s.payload.messageId, s.payload.inReplyTo],
  );
  const warmAction = chat?.warmUp?.actions.find((a) => a.id === (s.payload.actionId as string));
  const comment = useMemo(
    () =>
      warmAction?.kind === 'comment_post' && postClaim.trim().length >= 8
        ? draftWarmUpComment(postClaim, {
            seed: `${s.id}:${postClaim.length}`,
            ownExperience: ownExperience || undefined,
          })
        : undefined,
    [warmAction?.kind, postClaim, ownExperience, s.id],
  );
  if (!user) return null;
  const meta = KIND_LABEL[s.kind];
  const approve = async (body: string, subject?: string) => {
    if (!draft) return;
    setBusy(true);
    try {
      // a blocked or failed send leaves the card and its draft in place, with the reason shown in the editor
      return await runApproval(user, draft, body, subject, toast, person?.firstName);
    } finally {
      setBusy(false);
    }
  };
  const inFlight = !!draft && ['queued', 'sending', 'handed_off'].includes(draft.status);
  const first = person?.firstName ?? 'them';
  const dismiss = async (reason: string) => {
    const draftWas: OutboundStatus | undefined = draft?.status;
    await dismissSuggestion(user.id, s, reason);
    setDismissing(false);
    // "Already did this" also logs what was done, so it is not offered back
    toast.push(
      reason === 'already_did'
        ? { text: 'Marked as done.' }
        : {
            text: 'Card removed.',
            action: { label: 'Undo', onClick: () => restoreSuggestion(s, draftWas) },
            ttl: 6000,
          },
    );
  };
  const snooze = async (days: number) => {
    await snoozeSuggestion(user.id, s, days);
    toast.push({
      text: `Snoozed. It comes back in ${days === 7 ? 'a week' : `${days} day${days > 1 ? 's' : ''}`}.`,
      action: { label: 'Undo', onClick: () => restoreSuggestion(s) },
      ttl: 6000,
    });
  };
  const toStage = s.payload.toStage as keyof typeof STAGE_LABELS | undefined;
  const confirmStage = async (accept: boolean) => {
    const from = chat?.stage;
    const r = await decideProposedStage(s.payload.stageEventId as string, accept);
    toast.push({
      text: accept
        ? `Moved ${first} to ${toStage ? STAGE_LABELS[toStage] : 'the new stage'}.`
        : `Kept ${first} in ${chat ? STAGE_LABELS[chat.stage] : 'the same stage'}.`,
      // a stage the student accepted can be taken back, like a move on the Pipeline
      action:
        accept && r === 'applied' && from && s.chatId
          ? {
              label: 'Undo',
              onClick: async () => {
                const now = s.chatId ? await db.chats.get(s.chatId) : undefined;
                if (now) await applyStage(now, from, 'user', 'user:undo');
              },
            }
          : undefined,
      ttl: accept ? 6000 : undefined,
    });
  };
  const confirmMerge = async (accept: boolean) => {
    const r = await decideMerge(user.id, s.payload.mergeId as string, accept, { suggestionId: s.id });
    if (r === 'missing') return;
    toast.push({
      text: accept
        ? `Merged into ${person?.displayName ?? 'one record'}.`
        : 'Kept as two people. Orbit will not ask again.',
      tone: accept ? 'good' : 'neutral',
    });
  };
  const draftNow = async () => {
    setBusy(true);
    try {
      await ensureDrafts(user, [s.id]);
      setOpen(true);
    } finally {
      setBusy(false);
    }
  };
  const answerIntro = async (yes: boolean) => {
    setBusy(true);
    try {
      // the introducer by name even if their row had not loaded yet when the answer was given (a slow machine)
      const who =
        introducer ??
        (s.payload.introducerId ? await db.people.get(s.payload.introducerId as string) : undefined);
      await answerIntroductionQuestion(user, s.payload.threadId as string, yes);
      toast.push(
        yes
          ? {
              text: `Added to your pipeline, noting that ${who?.firstName ?? 'they'} introduced you.`,
              tone: 'good',
            }
          : { text: 'Got it. Orbit will not ask about this thread again.' },
      );
    } finally {
      setBusy(false);
    }
  };
  const warmDone = async (done: boolean) => {
    if (!s.chatId) return;
    await markWarmUpAction(
      user.id,
      s.chatId,
      s.payload.actionId as string,
      done,
      done ? postClaim : undefined,
    );
    // say when Orbit comes back: the next step waits for its own day, the first message for the ready date
    const after = await db.chats.get(s.chatId);
    const next = after?.warmUp?.actions.find((a) => !a.doneAt && !a.skippedAt);
    const day = (iso: string) =>
      new Date(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const nextDue = next ? new Date(next.dueAt) : undefined;
    const when = next
      ? nextDue && nextDue.getTime() > Date.now()
        ? ` The next step shows in Drafts on ${day(next.dueAt)}.`
        : ' The next step is in Drafts.'
      : after?.warmUp
        ? (() => {
            const prog = warmUpProgress(after.warmUp, new Date(), user.timezone);
            return prog.ready
              ? ' Your first message is ready in Drafts.'
              : ` Orbit suggests your first message from ${day(prog.readyFrom)}.`;
          })()
        : '';
    toast.push({
      text: `${
        done
          ? postClaim.trim()
            ? 'Logged. Your first message will mention the post.'
            : 'Nice. Logged the warm-up.'
          : 'Skipped.'
      }${when}`,
      ttl: 6000,
    });
  };
  // a first message suggested from a recommendation, to someone known only from LinkedIn and never talked to
  const coldStart =
    s.kind === 'new_outreach' &&
    !s.chatId &&
    !!person &&
    !person.primaryEmail &&
    needsWarmUp(person, 'linkedin', settings?.warmUpEnabled ?? true, sharedOrgNow);
  const startWarmUp = async () => {
    if (!person) return;
    setBusy(true);
    try {
      await startWarmUpOrOutreach(user, person.id, 'linkedin', 'recommendation');
      toast.push({
        text: `Warm-up started for ${person.firstName}. The first step is the new card in Drafts.`,
        tone: 'good',
        ttl: 6000,
      });
    } finally {
      setBusy(false);
    }
  };
  const copyComment = async () => {
    if (!comment) return;
    try {
      await navigator.clipboard.writeText(comment.text);
      toast.push({ text: 'Copied. Paste it under their post.', tone: 'good' });
    } catch {
      toast.push({ text: 'Select the comment and copy it.', tone: 'neutral' });
    }
  };
  // the person or the draft is still loading: the card keeps its place from the first frame (lists never jump), with
  // soft placeholders where the face, the name and the draft will be, never a card with them simply missing
  const loadingPerson = !!s.personId && personRow === undefined;
  const loadingDraft = !!s.outboundMessageId && draftRow === undefined;
  return (
    <div
      className={cx(
        'bg-canvas border border-line rounded-[var(--radius-card)] p-4 fade-up min-w-0 max-w-full break-words',
        highlight && 'ring-2 ring-accent/50 border-accent/50',
      )}
      data-testid={`suggestion-${s.kind}`}
      data-highlight={highlight ? 'true' : undefined}
      ref={ref}
    >
      <div className="flex items-start gap-3">
        {onPersonPage ? null : person ? (
          <Link to={`/people/${person.id}`} className="shrink-0">
            <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={40} />
          </Link>
        ) : loadingPerson ? (
          <span className="skeleton w-10 h-10 rounded-full shrink-0" aria-hidden />
        ) : (
          <span className="w-10 h-10 rounded-full bg-accent-soft inline-flex items-center justify-center text-accent shrink-0">
            <Sparkles size={16} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Chip tone={meta.tone}>{meta.label}</Chip>
            {person && !onPersonPage && (
              <Link to={`/people/${person.id}`} className="font-medium hover:underline truncate">
                {person.displayName}
              </Link>
            )}
            {person && !onPersonPage && (person.currentTitle || person.currentOrganizationRaw) && (
              <RoleLine title={person.currentTitle} company={person.currentOrganizationRaw} person={person} />
            )}
            {loadingPerson && !onPersonPage && <span className="skeleton h-3.5 w-36" aria-hidden />}
          </div>
          <p className="text-[13.5px] text-ink-2 mt-1">{s.reasonText}</p>
          {loadingDraft && <DraftComing />}
          {draft && inFlight && (
            <div className="mt-3">
              <OutboxStatus draft={draft} />
            </div>
          )}
          {draft && !inFlight && !open && (
            <>
              {/* a click target for the mouse; the keyboard reaches the same thing through Review draft, one stop */}
              <button
                onClick={() => setOpen(true)}
                tabIndex={-1}
                className="group mt-2 block text-left w-full rounded-lg bg-canvas-2 px-3 py-2 text-[13px] text-ink-2 hover:bg-line-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                aria-label={`Open the draft to ${first} to edit it`}
                data-testid="draft-preview"
              >
                {/* a draft still missing the student's line says so first, instead of reading like a broken message */}
                {gapLabel(draft.bodyFinal ?? draft.bodyDraft) && (
                  <span className="block text-warn font-medium mb-0.5" data-testid="draft-preview-gap">
                    Needs one line from you: {gapLabel(draft.bodyFinal ?? draft.bodyDraft)}
                  </span>
                )}
                {/* the clamp sits on the text, not the padded button, so no half line shows under it */}
                <span className="line-clamp-2">{withGaps(draft.bodyFinal ?? draft.bodyDraft)}</span>
                {/* an intro ask's second text: the note the introducer can forward (plan 23 §4.3) */}
                {draft.kind === 'intro_request' && draft.forwardNote && (
                  <span
                    className="block mt-1.5 pt-1.5 border-t border-dashed border-line"
                    data-testid="draft-preview-note"
                  >
                    <span className="label-mono block mb-0.5">The note {first} can forward</span>
                    <span className="line-clamp-2">{draft.forwardNote}</span>
                  </span>
                )}
              </button>
              {coldStart ? (
                // the same rule as Discover: someone known only from LinkedIn gets a warm-up first
                <div className="mt-2" data-testid="card-warmup-first">
                  <p className="text-[12px] text-warn">
                    You only have {first} on LinkedIn and have never talked, so Orbit suggests a short warm-up
                    before your first message.
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button variant="primary" size="sm" onClick={startWarmUp} disabled={busy}>
                      Start warm-up
                    </Button>
                    <Button size="sm" onClick={() => setOpen(true)} data-testid="draft-review">
                      Write now instead
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setOpen(true)}
                    data-testid="draft-review"
                  >
                    Review draft
                  </Button>
                </div>
              )}
            </>
          )}

          {s.kind === 'warm_up_engage' && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <a
                href={s.payload.url as string}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-accent text-white text-[14px] font-medium hover:bg-accent-2"
              >
                Open on LinkedIn <ExternalLink size={14} />
              </a>
            </div>
          )}
          {s.kind === 'warm_up_engage' && chat?.warmUp && (
            // every step with its day, so "step 2 of 3" and the dates in the toasts add up
            <ol className="mt-3 text-[12px] text-ink-3 space-y-0.5" data-testid="warmup-steps">
              {chat.warmUp.actions.map((a, i) => {
                const current = a.id === (s.payload.actionId as string);
                return (
                  <li key={a.id} className={cx(current && 'text-ink font-medium')}>
                    {i + 1}. {WARM_STEP[a.kind] ?? a.label}
                    {' · '}
                    {a.doneAt ? 'done' : a.skippedAt ? 'skipped' : current ? 'now' : shortDay(a.dueAt)}
                  </li>
                );
              })}
              <li>Then your first message, from {shortDay(chat.warmUp.readyAt)}.</li>
            </ol>
          )}
          {s.kind === 'warm_up_engage' && warmAction && warmAction.kind !== 'view_profile' && (
            <div className="mt-3 rounded-lg bg-canvas-2 p-3 text-[13px]" data-testid="warmup-helper">
              <label className="font-medium block" htmlFor={`warm-${s.id}`}>
                What was the post about? <span className="font-normal text-ink-3">Optional</span>
              </label>
              <div className="text-ink-3 text-[12px] mb-1.5">
                {warmAction.kind === 'comment_post'
                  ? 'One point it makes, in your own words, not a link. Orbit drafts a short comment that asks a question or adds something, and mentions the post in your first message.'
                  : 'One point from the post you reacted to, in your own words, not a link. Orbit mentions it in your first message.'}
              </div>
              <input
                id={`warm-${s.id}`}
                className="w-full h-9 rounded-lg border border-line bg-canvas px-3 text-[13px]"
                value={postClaim}
                onChange={(e) => setPostClaim(e.target.value)}
                placeholder="e.g. new analysts should ship something in week one"
              />
              {warmAction.kind === 'comment_post' && (
                <input
                  className="w-full h-9 mt-2 rounded-lg border border-line bg-canvas px-3 text-[13px]"
                  value={ownExperience}
                  onChange={(e) => setOwnExperience(e.target.value)}
                  placeholder="Your own experience with it (optional)"
                  aria-label="Your experience with it (optional)"
                />
              )}
              {comment && (
                <div className="mt-2 flex flex-wrap items-start gap-2">
                  <p
                    className="flex-1 rounded-md bg-canvas px-3 py-2 text-ink-2"
                    data-testid="warmup-comment"
                  >
                    {comment.text}
                  </p>
                  <Button size="sm" onClick={copyComment} aria-label="Copy comment">
                    <Copy size={14} /> Copy
                  </Button>
                </div>
              )}
            </div>
          )}
          {s.kind === 'warm_up_engage' && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button onClick={() => warmDone(true)}>
                <Check size={14} /> Done
              </Button>
              <Button
                variant="ghost"
                onClick={() => warmDone(false)}
                title="Move on to the next warm-up step without doing this one"
              >
                Skip this step
              </Button>
              <span className="basis-full text-[12px] text-ink-3">
                Either way, the next step shows up here on its day.
              </span>
            </div>
          )}
          {s.kind === 'prep_brief' && person && (
            <div className="mt-3 flex gap-2">
              <Button
                variant="primary"
                onClick={async () => {
                  await markPrepOpened(s.id);
                  nav(`/people/${person.id}?tab=facts&prep=1`);
                }}
              >
                Open prep
              </Button>
            </div>
          )}
          {s.kind === 'action_item_reminder' && (
            <div className="mt-3 flex gap-2">
              <Button
                variant="primary"
                onClick={async () => {
                  await markActionItemDone(s.payload.actionItemId as string, s.id);
                  toast.push({ text: 'Marked done.', tone: 'good' });
                }}
              >
                <Check size={14} /> Done
              </Button>
              {person && <Button onClick={() => nav(`/people/${person.id}`)}>Open {person.firstName}</Button>}
            </div>
          )}
          {s.kind === 'confirm_stage' && (
            <>
              {evidence && (
                <blockquote
                  className="mt-2 rounded-lg bg-canvas-2 px-3 py-2 text-[13px] text-ink-2"
                  data-testid="stage-evidence"
                >
                  <span className="text-ink-3">
                    {first} {wroteWhen(evidence)}:{' '}
                  </span>
                  <span className="line-clamp-2">“{evidence.text}”</span>
                </blockquote>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => confirmStage(true)}>
                  Yes, mark as {toStage ? STAGE_LABELS[toStage].toLowerCase() : 'changed'}
                </Button>
                <Button onClick={() => confirmStage(false)}>{stageNoLabel(toStage, first)}</Button>
              </div>
            </>
          )}
          {s.kind !== 'confirm_stage' && s.kind !== 'confirm_intro' && evidence && (
            <blockquote
              className="mt-2 rounded-lg bg-canvas-2 px-3 py-2 text-[13px] text-ink-2"
              data-testid="reply-quote"
            >
              <span className="text-ink-3">
                {first} {wroteWhen(evidence)}:{' '}
              </span>
              <span className="line-clamp-3">“{evidence.text}”</span>
            </blockquote>
          )}
          {s.kind === 'confirm_merge' && person && other && (
            <MergeChoice a={person} b={other} asking={mergeAsk} onAsk={setMergeAsk} onDecide={confirmMerge} />
          )}
          {s.kind === 'confirm_intro' && evidence && (
            <blockquote
              className="mt-2 rounded-lg bg-canvas-2 px-3 py-2 text-[13px] text-ink-2"
              data-testid="intro-evidence"
            >
              <span className="text-ink-3">
                Orbit asks because {introducer?.firstName ?? 'they'} wrote to you both{' '}
                {new Date(evidence.at).toLocaleDateString('en-US', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                })}
                :{' '}
              </span>
              <span className="line-clamp-2">“{evidence.text}”</span>
            </blockquote>
          )}
          {s.kind === 'confirm_intro' && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" disabled={busy} onClick={() => answerIntro(true)}>
                Yes
              </Button>
              <Button size="sm" disabled={busy} onClick={() => answerIntro(false)}>
                No
              </Button>
            </div>
          )}
          {s.kind === 'confirm_note_match' && !!s.payload.held && user && (
            // plan 23 §4.5: a recording of people Orbit cannot tie to a chat waits for the student's word
            <div className="mt-3 flex gap-2" data-testid="held-meeting">
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => void answerHeldMeeting(user, s.id, true)}
                data-testid="held-meeting-yes"
              >
                Yes, file it
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void answerHeldMeeting(user, s.id, false)}>
                No
              </Button>
            </div>
          )}
          {s.kind === 'trust_offer' && user && (
            // plan 23 §4.9: earned by ten untouched approvals; the answer is per kind
            <div className="mt-3 flex flex-wrap gap-2" data-testid="trust-offer">
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => void answerTrustOffer(user, s, true)}
                data-testid="trust-offer-yes"
              >
                {s.payload.recheck
                  ? 'Keep'
                  : `Yes, send ${LADDER_WORDS[s.payload.messageKind as LadderKind]?.many ?? 'them'}`}
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void answerTrustOffer(user, s, false)}
                data-testid="trust-offer-no"
              >
                {s.payload.recheck ? 'Ask me again' : 'Keep asking me'}
              </Button>
            </div>
          )}
          {s.kind === 'confirm_note_match' && !s.payload.held && (
            <div className="mt-3 flex gap-2">
              <Button variant="primary" onClick={() => nav(`/notes/new?note=${s.payload.noteId as string}`)}>
                Pick the person
              </Button>
            </div>
          )}
          {s.kind === 'new_outreach' && !draft && person && (
            <div className="mt-3 flex gap-2">
              <Button variant="primary" onClick={() => nav(`/people/${person.id}?draft=outreach`)}>
                Write to {person.firstName}
              </Button>
            </div>
          )}
          {s.kind !== 'new_outreach' && isMessageSuggestion(s.kind) && !draft && person && drafting && (
            <DraftComing first={person.firstName} />
          )}
          {s.kind !== 'new_outreach' && isMessageSuggestion(s.kind) && !draft && person && !drafting && (
            <div className="mt-3 flex gap-2">
              <Button variant="primary" onClick={draftNow} disabled={busy} data-testid="draft-now">
                {busy ? 'Drafting…' : `Draft a message to ${person.firstName}`}
              </Button>
            </div>
          )}
        </div>
        {draft && !inFlight && open && (
          <button
            onClick={() => setOpen(false)}
            className="p-2 -m-1 rounded-md text-ink-3 hover:bg-canvas-2 shrink-0"
            aria-label="Close the draft"
            title="Close the draft (your edits are kept)"
          >
            <ChevronUp size={16} />
          </button>
        )}
      </div>
      {/* the open draft uses the card's full width, not the column next to the avatar (a phone needs every pixel) */}
      {draft && !inFlight && open && (
        <div className="mt-3">
          <DraftEditor
            draft={draft}
            onApprove={approve}
            busy={busy}
            onCancel={() => setOpen(false)}
            focusOnOpen
          />
        </div>
      )}
      {!['confirm_stage', 'confirm_merge', 'confirm_intro'].includes(s.kind) && !inFlight && (
        <div className="mt-2 flex flex-wrap items-center gap-0.5 text-[12px]">
          {!dismissing ? (
            <>
              <span className="text-ink-3 pl-1 mr-0.5" id={`snooze-${s.id}`}>
                Snooze
              </span>
              {(
                [
                  [1, '1 day'],
                  [3, '3 days'],
                  [7, '1 week'],
                ] as const
              ).map(([d, l]) => (
                <button
                  key={d}
                  className={CARD_SMALL_BUTTON}
                  onClick={() => snooze(d)}
                  aria-label={`Snooze for ${l}`}
                  title={`Hide this card for ${l}; it comes back in Drafts`}
                >
                  {l}
                </button>
              ))}
              <button
                className={cx('ml-auto', CARD_SMALL_BUTTON)}
                onClick={() => setDismissing(true)}
                title="Remove this card and tell Orbit why, so it suggests better next time"
              >
                Dismiss
              </button>
            </>
          ) : (
            <>
              <span className="text-ink-3 mr-1">Why remove it?</span>
              {[
                ['already_did', 'Already did this'],
                ['not_now', 'Not now'],
                ['wrong_person', 'Wrong person'],
                // only a card with a message can have a bad draft
                ...(draft ? [['bad_draft', 'Bad draft']] : []),
              ].map(([k, l]) => (
                <button
                  key={k}
                  className="px-2 h-10 @[40rem]:h-8 rounded-md bg-canvas-2 hover:bg-line-2"
                  onClick={() => dismiss(k!)}
                >
                  {l}
                </button>
              ))}
              <button
                className="ml-auto px-2 h-10 @[40rem]:h-8 text-ink-3"
                onClick={() => setDismissing(false)}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The small secondary buttons along a card's foot (Snooze, Dismiss): quiet text until hovered, so the draft leads. */
const CARD_SMALL_BUTTON =
  'px-2 h-10 @[40rem]:h-7 rounded-md text-ink-3 hover:bg-canvas-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

/** "Title · Company" where a long title gives way first: the company is the part that matters. */
export function RoleLine({
  title,
  company,
  person,
}: {
  title?: string;
  company?: string;
  /** their record, so the company's logo can come from a stored domain or their work address */
  person?: Pick<Person, 'currentOrganizationRaw' | 'currentOrganizationId' | 'emails' | 'primaryEmail'>;
}) {
  return (
    // the company is its logo (named on hover); written out only when there is no title to show
    <span className="text-ink-3 text-[13px] flex items-center gap-1.5 min-w-0 max-w-full">
      {company &&
        (person ? <PersonCompanyLogo person={person} size={14} /> : <CompanyLogo name={company} size={14} />)}
      <span className="truncate min-w-0">{title ?? company}</span>
    </span>
  );
}

const WARM_STEP: Record<string, string> = {
  view_profile: 'Look at their profile',
  react_post: 'React to one of their posts',
  comment_post: 'Comment on one of their posts',
};
const shortDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

/** The first missing line of a draft, as a short label ("One real update since you last spoke"), if any. */
export function gapLabel(text: string): string | undefined {
  const m = text.match(/\[([^\]]{3,})\]/);
  if (!m) return undefined;
  return m[1]!
    .split(':')[0]!
    .replace(/\s+(with|to)\s+\p{Lu}[\p{L}'-]*$/u, '')
    .trim();
}

/**
 * A draft preview with each "[Why them: one line only true of Priya ...]" gap shown by its short name ("[Why them]"),
 * the same name the card and the editor use, so the card says a line is missing instead of showing the instruction.
 */
function withGaps(text: string): ReactNode[] {
  return text.split(/(\[[^\]]{3,}\])/).map((part, i) =>
    /^\[[^\]]+\]$/.test(part) ? (
      <mark key={i} className="rounded bg-warn-soft px-1 text-warn not-italic">
        [{gapLabel(part) ?? 'your line'}]
      </mark>
    ) : (
      part
    ),
  );
}

/** The two records side by side, what they share and where they differ, and a second step before merging. */
function MergeChoice({
  a,
  b,
  asking,
  onAsk,
  onDecide,
}: {
  a: Person;
  b: Person;
  asking: boolean;
  onAsk: (v: boolean) => void;
  onDecide: (accept: boolean) => void;
}) {
  return (
    <div className="mt-2 text-[13px]" data-testid="merge-choice">
      <MergePair a={a} b={b} />
      {asking ? (
        <div className="mt-2 rounded-lg border border-line p-3" role="alertdialog" aria-label="Confirm merge">
          <p>
            Merge {b.displayName} into {a.displayName}? Their emails, notes and chats are combined under{' '}
            {a.displayName}. This cannot be undone.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => onDecide(true)} data-testid="merge-confirm">
              Merge them
            </Button>
            <Button onClick={() => onAsk(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <Button onClick={() => onAsk(true)} data-testid="merge-ask">
            Same person, merge
          </Button>
          <Button variant="primary" onClick={() => onDecide(false)}>
            Different people
          </Button>
        </div>
      )}
    </div>
  );
}

function useOther(id?: string): Person | undefined {
  return useLiveQuery(() => (id ? db.people.get(id) : undefined), [id]) ?? undefined;
}

/** The draft is being written (or still loading): says so when writing, with lines where the message will be. */
function DraftComing({ first }: { first?: string }) {
  return (
    <div className="mt-3 rounded-lg bg-canvas-2 px-3 py-3" aria-busy="true" data-testid="draft-coming">
      {first && <p className="text-[13px] shimmer">Writing your draft to {first}…</p>}
      <div className="mt-2.5 space-y-1.5" aria-hidden>
        <span className="skeleton block h-2.5 w-full" />
        <span className="skeleton block h-2.5 w-11/12" />
        <span className="skeleton block h-2.5 w-3/5" />
      </div>
    </div>
  );
}
