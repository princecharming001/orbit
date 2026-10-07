import type { Person, Suggestion } from '@orbit/core';
import { draftWarmUpComment } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, ChevronDown, ChevronUp, Copy, ExternalLink, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { feedback } from '../db/repo';
import { db } from '../db/schema';
import { markWarmUpAction } from '../engine/brief';
import { mergePeople } from '../engine/people';
import { dismissSuggestion, snoozeSuggestion } from '../engine/send';
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
  confirm_stage: { label: 'Confirm', tone: 'neutral' },
  confirm_merge: { label: 'Same person?', tone: 'neutral' },
  confirm_note_match: { label: 'Match note', tone: 'neutral' },
};

export function SuggestionCard({ s, compact }: { s: Suggestion; compact?: boolean }) {
  const { user } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [postClaim, setPostClaim] = useState('');
  const [ownExperience, setOwnExperience] = useState('');
  const person = useLiveQuery(() => (s.personId ? db.people.get(s.personId) : undefined), [s.personId]);
  const draft = useLiveQuery(
    () => (s.outboundMessageId ? db.outbound.get(s.outboundMessageId) : undefined),
    [s.outboundMessageId],
  );
  const chat = useLiveQuery(() => (s.chatId ? db.chats.get(s.chatId) : undefined), [s.chatId]);
  const other = useOther(s.payload.otherPersonId as string | undefined);
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
  const dismiss = async (reason: string) => {
    await dismissSuggestion(user.id, s, reason);
    setDismissing(false);
  };
  const snooze = async (days: number) => {
    await snoozeSuggestion(user.id, s, days);
    toast.push({ text: `Snoozed for ${days} day${days > 1 ? 's' : ''}.` });
  };
  const confirmStage = async (accept: boolean) => {
    await decideProposedStage(s.payload.stageEventId as string, accept);
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
      )}
      data-testid={`suggestion-${s.kind}`}
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
            <button
              onClick={() => setOpen(true)}
              className="mt-2 text-left w-full rounded-lg bg-canvas-2 px-3 py-2 text-[13px] text-ink-2 line-clamp-2 hover:bg-line-2"
            >
              {draft.bodyFinal ?? draft.bodyDraft}
            </button>
          )}
          {draft && !inFlight && open && (
            <div className="mt-3">
              <DraftEditor draft={draft} onApprove={approve} busy={busy} onCancel={() => setOpen(false)} />
            </div>
          )}
          {s.kind === 'warm_up_engage' && warmAction && warmAction.kind !== 'view_profile' && (
            <div className="mt-3 rounded-lg bg-canvas-2 p-3 text-[13px]" data-testid="warmup-helper">
              <div className="font-medium">
                {warmAction.kind === 'comment_post'
                  ? 'What is the post about?'
                  : 'Which post did you react to?'}
              </div>
              <div className="text-ink-3 text-[12px] mb-1.5">
                One claim from it, in your words. Orbit turns it into a comment that asks or adds, never
                praises, and uses it as the hook in your message.
              </div>
              <input
                className="w-full h-9 rounded-lg border border-line bg-canvas px-3 text-[13px]"
                value={postClaim}
                onChange={(e) => setPostClaim(e.target.value)}
                placeholder="e.g. junior engineers should own a metric in their first quarter"
                aria-label="Post topic"
              />
              {warmAction.kind === 'comment_post' && (
                <input
                  className="w-full h-9 mt-2 rounded-lg border border-line bg-canvas px-3 text-[13px]"
                  value={ownExperience}
                  onChange={(e) => setOwnExperience(e.target.value)}
                  placeholder="Optional: your own experience with it, one clause"
                  aria-label="Your experience"
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
              <a
                href={s.payload.url as string}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-accent text-white text-[14px] font-medium hover:bg-accent-2"
              >
                Open on LinkedIn <ExternalLink size={14} />
              </a>
              <Button onClick={() => warmDone(true)}>
                <Check size={14} /> Done
              </Button>
              <Button variant="ghost" onClick={() => warmDone(false)}>
                Skip this one
              </Button>
              {chat?.warmUp && (
                <span className="text-[12px] text-ink-3 ml-1">
                  {chat.warmUp.actions.filter((a) => a.doneAt).length} of {chat.warmUp.actions.length} done ·
                  first message suggested after{' '}
                  {new Date(chat.warmUp.readyAt).toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
              )}
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
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => confirmStage(true)}>
                Yes, move it
              </Button>
              <Button onClick={() => confirmStage(false)}>No</Button>
            </div>
          )}
          {s.kind === 'confirm_merge' && (
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              {other && (
                <span className="text-[13px] text-ink-2">
                  Other record:{' '}
                  <Link className="underline" to={`/people/${other.id}`}>
                    {other.displayName}
                  </Link>
                  {other.primaryEmail ? ` (${other.primaryEmail})` : ''}
                </span>
              )}
              <Button variant="primary" onClick={() => confirmMerge(true)}>
                Merge
              </Button>
              <Button onClick={() => confirmMerge(false)}>Keep separate</Button>
            </div>
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
        </div>
        {draft && !inFlight && (
          <button
            onClick={() => setOpen((o) => !o)}
            className="p-1.5 rounded-md text-ink-3 hover:bg-canvas-2 shrink-0"
            aria-label={open ? 'Collapse the draft' : 'Open the draft'}
            aria-expanded={open}
          >
            {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        )}
      </div>
      {!['confirm_stage', 'confirm_merge'].includes(s.kind) && (
        <div className="mt-3 pt-3 border-t border-line-2 flex flex-wrap items-center gap-1 text-[12px]">
          {!dismissing ? (
            <>
              <button
                className="px-2 h-7 rounded-md text-ink-3 hover:bg-canvas-2 hover:text-ink"
                onClick={() => snooze(1)}
                aria-label="Snooze for 1 day"
                title="Snooze for 1 day"
              >
                Snooze 1d
              </button>
              <button
                className="px-2 h-7 rounded-md text-ink-3 hover:bg-canvas-2 hover:text-ink"
                onClick={() => snooze(3)}
                aria-label="Snooze for 3 days"
                title="Snooze for 3 days"
              >
                3d
              </button>
              <button
                className="px-2 h-7 rounded-md text-ink-3 hover:bg-canvas-2 hover:text-ink"
                onClick={() => snooze(7)}
                aria-label="Snooze for 1 week"
                title="Snooze for 1 week"
              >
                1w
              </button>
              <button
                className="ml-auto px-2 h-7 rounded-md text-ink-3 hover:bg-canvas-2 hover:text-ink"
                onClick={() => setDismissing(true)}
                title="Remove this card and tell Orbit why"
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
                  className="px-2 h-7 rounded-md bg-canvas-2 hover:bg-line-2"
                  onClick={() => dismiss(k!)}
                >
                  {l}
                </button>
              ))}
              <button className="ml-auto px-2 h-7 text-ink-3" onClick={() => setDismissing(false)}>
                Cancel
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function useOther(id?: string): Person | undefined {
  return useLiveQuery(() => (id ? db.people.get(id) : undefined), [id]) ?? undefined;
}
