import type { OutboundStatus, Person, Suggestion } from '@orbit/core';
import { draftWarmUpComment, STAGE_LABELS } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, ChevronDown, ChevronUp, Copy, ExternalLink, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { feedback } from '../db/repo';
import { db } from '../db/schema';
import { ensureDrafts, isMessageSuggestion, markWarmUpAction } from '../engine/brief';
import { mergePeople } from '../engine/people';
import { dismissSuggestion, restoreSuggestion, snoozeSuggestion } from '../engine/send';
import { decideProposedStage } from '../engine/stages';
import { useSession } from '../state/session';
import { Avatar, Button, Chip, cx, useToast } from '../ui';
import { runApproval } from './approve';
import { DraftEditor, OutboxStatus } from './DraftEditor';

export const KIND_LABEL: Record<
  Suggestion['kind'],
  { label: string; tone: 'neutral' | 'accent' | 'good' | 'warn' | 'bad' }
> = {
  new_outreach: { label: 'First message', tone: 'accent' },
  warm_up_engage: { label: 'LinkedIn warm-up', tone: 'neutral' },
  follow_up_bump: { label: 'Follow up', tone: 'warn' },
  schedule_propose: { label: 'Propose times', tone: 'accent' },
  schedule_confirm: { label: 'Confirm time', tone: 'accent' },
  prep_brief: { label: 'Prep', tone: 'good' },
  thank_you: { label: 'Thank-you', tone: 'good' },
  action_item_reminder: { label: 'Promise to keep', tone: 'warn' },
  nurture_checkin: { label: 'Check-in', tone: 'neutral' },
  reconnect: { label: 'Reconnect', tone: 'neutral' },
  congratulate: { label: 'Congratulate', tone: 'good' },
  ask_referral: { label: 'Referral ask', tone: 'accent' },
  intro_request: { label: 'Intro ask', tone: 'accent' },
  report_back: { label: 'Close the loop', tone: 'good' },
  confirm_stage: { label: 'Stage update', tone: 'neutral' },
  confirm_merge: { label: 'Possible duplicate', tone: 'neutral' },
  confirm_note_match: { label: 'Match note', tone: 'neutral' },
};

/** What two records have in common and where they differ, in plain words, so the student can judge a merge. */
export function mergeEvidence(a: Person, b: Person): { same: string[]; differ: string[] } {
  const same: string[] = [];
  const differ: string[] = [];
  const eq = (x?: string, y?: string) => !!x && !!y && x.trim().toLowerCase() === y.trim().toLowerCase();
  const emailsA = new Set([a.primaryEmail, ...a.emails].filter(Boolean).map((e) => e!.toLowerCase()));
  if ([b.primaryEmail, ...b.emails].some((e) => e && emailsA.has(e.toLowerCase())))
    same.push('the same email address');
  if (eq(a.firstName, b.firstName)) same.push('the same first name');
  else if (a.firstName && b.firstName) differ.push('different first names');
  if (eq(a.lastName, b.lastName)) same.push('the same last name');
  if (eq(a.currentOrganizationRaw, b.currentOrganizationRaw)) same.push('the same company');
  else if (a.currentOrganizationRaw && b.currentOrganizationRaw) differ.push('different companies');
  if (eq(a.school, b.school)) same.push('the same school');
  if (eq(a.linkedinSlug, b.linkedinSlug)) same.push('the same LinkedIn profile');
  return { same, differ };
}

function sentenceList(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

export function SuggestionCard({
  s,
  compact,
  highlight,
}: {
  s: Suggestion;
  compact?: boolean;
  /** scroll to this card and outline it (Today opened from a link that points at it) */
  highlight?: boolean;
}) {
  const { user } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [mergeAsk, setMergeAsk] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlight]);
  const [postClaim, setPostClaim] = useState('');
  const [ownExperience, setOwnExperience] = useState('');
  const person = useLiveQuery(() => (s.personId ? db.people.get(s.personId) : undefined), [s.personId]);
  const draft = useLiveQuery(
    () => (s.outboundMessageId ? db.outbound.get(s.outboundMessageId) : undefined),
    [s.outboundMessageId],
  );
  const chat = useLiveQuery(() => (s.chatId ? db.chats.get(s.chatId) : undefined), [s.chatId]);
  const other = useOther(s.payload.otherPersonId as string | undefined);
  // what made Orbit think the stage changed: the message it read, when there is one
  const evidence = useLiveQuery(async () => {
    if (s.kind !== 'confirm_stage') return undefined;
    const e = await db.stageEvents.get(s.payload.stageEventId as string);
    if (e?.evidenceRefTable !== 'messages' || !e.evidenceRefId) return undefined;
    const m = await db.messages.get(e.evidenceRefId);
    return m ? { text: m.bodyText.replace(/\s+/g, ' ').trim(), at: m.sentAt } : undefined;
  }, [s.kind, s.payload.stageEventId]);
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
    await decideProposedStage(s.payload.stageEventId as string, accept);
    toast.push({
      text: accept
        ? `Moved ${first} to ${toStage ? STAGE_LABELS[toStage] : 'the new stage'}.`
        : `Kept ${first} in ${chat ? STAGE_LABELS[chat.stage] : 'the same stage'}.`,
    });
  };
  const confirmMerge = async (accept: boolean) => {
    const mergeId = s.payload.mergeId as string;
    const m = await db.merges.get(mergeId);
    if (!m) return;
    if (accept) {
      await mergePeople(user.id, m.personAId, m.personBId);
      await db.merges.update(mergeId, { status: 'accepted' });
      await feedback(user.id, 'merge_accept', { refTable: 'merges', refId: mergeId });
    } else {
      await db.merges.update(mergeId, { status: 'rejected' });
      await feedback(user.id, 'merge_reject', { refTable: 'merges', refId: mergeId });
    }
    await db.suggestions.update(s.id, { status: 'done', decidedAt: new Date().toISOString() });
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
  const warmDone = async (done: boolean) => {
    if (!s.chatId) return;
    await markWarmUpAction(
      user.id,
      s.chatId,
      s.payload.actionId as string,
      done,
      done ? postClaim : undefined,
    );
    toast.push({
      text: done
        ? postClaim.trim()
          ? 'Logged. Your first message will mention the post.'
          : 'Nice. Logged the warm-up.'
        : 'Skipped.',
    });
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
  return (
    <div
      className={cx(
        'bg-canvas border border-line rounded-[var(--radius-card)] p-4 fade-up min-w-0 max-w-full break-words',
        !compact && 'shadow-[var(--shadow-card)]',
        highlight && 'ring-2 ring-accent/50 border-accent/50',
      )}
      data-testid={`suggestion-${s.kind}`}
      data-highlight={highlight ? 'true' : undefined}
      ref={ref}
    >
      <div className="flex items-start gap-3">
        {person ? (
          <Link to={`/people/${person.id}`} className="shrink-0">
            <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={40} />
          </Link>
        ) : (
          <span className="w-10 h-10 rounded-full bg-accent-soft inline-flex items-center justify-center text-accent shrink-0">
            <Sparkles size={16} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Chip tone={meta.tone}>{meta.label}</Chip>
            {person && (
              <Link to={`/people/${person.id}`} className="font-medium hover:underline truncate">
                {person.displayName}
              </Link>
            )}
            {person && (person.currentTitle || person.currentOrganizationRaw) && (
              <span className="text-ink-3 text-[13px] truncate min-w-0 max-w-full">
                {[person.currentTitle, person.currentOrganizationRaw].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>
          <p className="text-[13.5px] text-ink-2 mt-1">{s.reasonText}</p>
          {draft && inFlight && (
            <div className="mt-3">
              <OutboxStatus draft={draft} />
            </div>
          )}
          {draft && !inFlight && !open && (
            <>
              <button
                onClick={() => setOpen(true)}
                className="group mt-2 block text-left w-full rounded-lg bg-canvas-2 px-3 py-2 text-[13px] text-ink-2 hover:bg-line-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                aria-label={`Open the draft to ${first} to edit it`}
                data-testid="draft-preview"
              >
                {/* the clamp sits on the text, not the padded button, so no half line shows under it */}
                <span className="line-clamp-2">{draft.bodyFinal ?? draft.bodyDraft}</span>
              </button>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button variant="primary" size="sm" onClick={() => setOpen(true)} data-testid="draft-review">
                  Review draft
                </Button>
                <span className="text-[12px] text-ink-3">
                  Edit it if you like. Nothing is sent until you approve it.
                </span>
              </div>
            </>
          )}
          {draft && !inFlight && open && (
            <div className="mt-3">
              <DraftEditor draft={draft} onApprove={approve} busy={busy} onCancel={() => setOpen(false)} />
            </div>
          )}
          {s.kind === 'warm_up_engage' && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <a
                href={s.payload.url as string}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-accent text-white text-[14px] font-medium hover:bg-accent-2"
              >
                Open on LinkedIn <ExternalLink size={14} />
              </a>
              {chat?.warmUp && (
                <span className="text-[12px] text-ink-3">
                  Step{' '}
                  {Math.min(
                    chat.warmUp.actions.length,
                    chat.warmUp.actions.filter((a) => a.doneAt || a.skippedAt).length + 1,
                  )}{' '}
                  of {chat.warmUp.actions.length}. Orbit suggests the first message after{' '}
                  {new Date(chat.warmUp.readyAt).toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                  })}
                  .
                </span>
              )}
            </div>
          )}
          {s.kind === 'warm_up_engage' && warmAction && warmAction.kind !== 'view_profile' && (
            <div className="mt-3 rounded-lg bg-canvas-2 p-3 text-[13px]" data-testid="warmup-helper">
              <label className="font-medium block" htmlFor={`warm-${s.id}`}>
                {warmAction.kind === 'comment_post'
                  ? 'What is the post about?'
                  : 'Which post did you react to?'}{' '}
                <span className="font-normal text-ink-3">Optional</span>
              </label>
              <div className="text-ink-3 text-[12px] mb-1.5">
                {warmAction.kind === 'comment_post'
                  ? 'One point from it, in your own words. Orbit drafts a short comment that asks a question or adds something, and mentions the post in your first message.'
                  : 'One point from it, in your own words. Orbit mentions the post in your first message.'}
              </div>
              <input
                id={`warm-${s.id}`}
                className="w-full h-9 rounded-lg border border-line bg-canvas px-3 text-[13px]"
                value={postClaim}
                onChange={(e) => setPostClaim(e.target.value)}
                placeholder="e.g. interns should ship in week one"
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
            </div>
          )}
          {s.kind === 'prep_brief' && person && (
            <div className="mt-3 flex gap-2">
              <Button
                variant="primary"
                onClick={async () => {
                  await db.suggestions.update(s.id, { status: 'done', decidedAt: new Date().toISOString() });
                  nav(`/people/${person.id}?tab=prep`);
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
                  await db.actionItems.update(s.payload.actionItemId as string, { status: 'done' });
                  await db.suggestions.update(s.id, { status: 'done', decidedAt: new Date().toISOString() });
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
                    {first} wrote{' '}
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
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => confirmStage(true)}>
                  Yes, mark as {toStage ? STAGE_LABELS[toStage].toLowerCase() : 'changed'}
                </Button>
                <Button onClick={() => confirmStage(false)}>
                  No, keep it {chat ? `as ${STAGE_LABELS[chat.stage].toLowerCase()}` : 'as is'}
                </Button>
              </div>
            </>
          )}
          {s.kind === 'confirm_merge' && person && other && (
            <MergeChoice a={person} b={other} asking={mergeAsk} onAsk={setMergeAsk} onDecide={confirmMerge} />
          )}
          {s.kind === 'confirm_note_match' && (
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
          {s.kind !== 'new_outreach' && isMessageSuggestion(s.kind) && !draft && person && (
            <div className="mt-3 flex gap-2">
              <Button variant="primary" onClick={draftNow} disabled={busy} data-testid="draft-now">
                {busy ? 'Drafting…' : `Draft a message to ${person.firstName}`}
              </Button>
            </div>
          )}
        </div>
        {draft && !inFlight && (
          <button
            onClick={() => setOpen((o) => !o)}
            className="p-2 -m-1 rounded-md text-ink-3 hover:bg-canvas-2 shrink-0"
            aria-label={open ? 'Close the draft' : 'Open the draft'}
            aria-expanded={open}
          >
            {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        )}
      </div>
      {!['confirm_stage', 'confirm_merge'].includes(s.kind) && !inFlight && (
        <div className="mt-3 pt-3 border-t border-line-2 flex flex-wrap items-center gap-1 text-[12px]">
          {!dismissing ? (
            <>
              <button
                className="px-2 h-8 rounded-md text-ink-3 hover:bg-canvas-2 hover:text-ink"
                onClick={() => snooze(1)}
                aria-label="Snooze for 1 day"
                title="Snooze for 1 day"
              >
                Snooze 1d
              </button>
              <button
                className="px-2 h-8 rounded-md text-ink-3 hover:bg-canvas-2 hover:text-ink"
                onClick={() => snooze(3)}
                aria-label="Snooze for 3 days"
                title="Snooze for 3 days"
              >
                3d
              </button>
              <button
                className="px-2 h-8 rounded-md text-ink-3 hover:bg-canvas-2 hover:text-ink"
                onClick={() => snooze(7)}
                aria-label="Snooze for 1 week"
                title="Snooze for 1 week"
              >
                1w
              </button>
              <button
                className="ml-auto px-2 h-8 rounded-md text-ink-3 hover:bg-canvas-2 hover:text-ink"
                onClick={() => setDismissing(true)}
                title="Remove this card and tell Orbit why, so it suggests better next time"
              >
                Dismiss
              </button>
            </>
          ) : (
            <>
              <span className="text-ink-3 mr-1">Why?</span>
              {[
                ['already_did', 'Already did this'],
                ['not_now', 'Not now'],
                ['wrong_person', 'Wrong person'],
                ['bad_draft', 'Bad draft'],
              ].map(([k, l]) => (
                <button
                  key={k}
                  className="px-2 h-8 rounded-md bg-canvas-2 hover:bg-line-2"
                  onClick={() => dismiss(k!)}
                >
                  {l}
                </button>
              ))}
              <button className="ml-auto px-2 h-8 text-ink-3" onClick={() => setDismissing(false)}>
                Cancel
              </button>
            </>
          )}
        </div>
      )}
    </div>
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
  const ev = mergeEvidence(a, b);
  const row = (p: Person) => (
    <li className="min-w-0">
      <Link className="font-medium hover:underline" to={`/people/${p.id}`}>
        {p.displayName}
      </Link>
      <span className="text-ink-3">
        {[p.currentTitle, p.currentOrganizationRaw].filter(Boolean).length
          ? ` · ${[p.currentTitle, p.currentOrganizationRaw].filter(Boolean).join(' at ')}`
          : ''}
        {p.primaryEmail ? ` · ${p.primaryEmail}` : ''}
      </span>
    </li>
  );
  return (
    <div className="mt-2 text-[13px]" data-testid="merge-choice">
      <ul className="rounded-lg bg-canvas-2 px-3 py-2 space-y-1">
        {row(a)}
        {row(b)}
      </ul>
      <p className="text-ink-3 text-[12px] mt-1.5">
        {ev.same.length ? `Both have ${sentenceList(ev.same)}.` : 'Their names look alike.'}
        {ev.differ.length ? ` But they have ${sentenceList(ev.differ)}.` : ''}
      </p>
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
