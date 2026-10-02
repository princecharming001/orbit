import type { Person, Suggestion } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, ChevronDown, ChevronUp, ExternalLink, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { feedback } from '../db/repo';
import { db } from '../db/schema';
import { markWarmUpAction } from '../engine/brief';
import { mergePeople } from '../engine/people';
import { approveAndSend, dismissSuggestion, snoozeSuggestion } from '../engine/send';
import { decideProposedStage } from '../engine/stages';
import { useSession } from '../state/session';
import { Avatar, Button, Chip, cx, useToast } from '../ui';
import { DraftEditor } from './DraftEditor';

export const KIND_LABEL: Record<
  Suggestion['kind'],
  { label: string; tone: 'neutral' | 'accent' | 'good' | 'warn' | 'bad' }
> = {
  new_outreach: { label: 'New outreach', tone: 'accent' },
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
  const person = useLiveQuery(() => (s.personId ? db.people.get(s.personId) : undefined), [s.personId]);
  const draft = useLiveQuery(
    () => (s.outboundMessageId ? db.outbound.get(s.outboundMessageId) : undefined),
    [s.outboundMessageId],
  );
  const chat = useLiveQuery(() => (s.chatId ? db.chats.get(s.chatId) : undefined), [s.chatId]);
  const other = useOther(s.payload.otherPersonId as string | undefined);
  if (!user) return null;
  const meta = KIND_LABEL[s.kind];
  const approve = async (body: string, subject?: string) => {
    if (!draft) return;
    setBusy(true);
    const r = await approveAndSend(user, draft.id, body, subject);
    setBusy(false);
    if (!r.ok) return toast.push({ text: r.error, tone: 'bad', ttl: 6000 });
    if (r.handoffUrl) {
      window.open(r.handoffUrl, '_blank', 'noopener');
      toast.push({
        text:
          draft.channel === 'linkedin'
            ? 'Copied. Paste it into LinkedIn and send.'
            : 'Opened in your mail app.',
        tone: 'good',
      });
    } else toast.push({ text: `Sent to ${person?.firstName ?? 'them'}.`, tone: 'good' });
  };
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
    await markWarmUpAction(user.id, s.chatId, s.payload.actionId as string, done);
    toast.push({ text: done ? 'Nice. Logged the warm-up.' : 'Skipped.' });
  };
  return (
    <div
      className={cx(
        'bg-canvas border border-line rounded-[var(--radius-card)] p-4 fade-up',
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
              <span className="text-ink-3 text-[13px] truncate">
                {[person.currentTitle, person.currentOrganizationRaw].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>
          <p className="text-[13.5px] text-ink-2 mt-1">{s.reasonText}</p>
          {draft && !open && (
            <button
              onClick={() => setOpen(true)}
              className="mt-2 text-left w-full rounded-lg bg-canvas-2 px-3 py-2 text-[13px] text-ink-2 line-clamp-2 hover:bg-line-2"
            >
              {draft.bodyFinal ?? draft.bodyDraft}
            </button>
          )}
          {draft && open && (
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
              <Button onClick={() => warmDone(true)}>
                <Check size={14} /> Done
              </Button>
              <Button variant="ghost" onClick={() => warmDone(false)}>
                Skip this one
              </Button>
              {chat?.warmUp && (
                <span className="text-[12px] text-ink-3 ml-1">
                  {chat.warmUp.actions.filter((a) => a.doneAt).length} of {chat.warmUp.actions.length} done ·
                  outreach suggested after{' '}
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
            <div className="mt-3 flex gap-2">
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
        {draft && (
          <button
            onClick={() => setOpen((o) => !o)}
            className="p-1.5 rounded-md text-ink-3 hover:bg-canvas-2"
            aria-label={open ? 'Collapse' : 'Expand'}
          >
            {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        )}
      </div>
      {!['confirm_stage', 'confirm_merge'].includes(s.kind) && (
        <div className="mt-3 pt-3 border-t border-line-2 flex items-center gap-1 text-[12px]">
          {!dismissing ? (
            <>
              <button
                className="px-2 h-7 rounded-md text-ink-3 hover:bg-canvas-2 hover:text-ink"
                onClick={() => snooze(1)}
              >
                Snooze 1d
              </button>
              <button
                className="px-2 h-7 rounded-md text-ink-3 hover:bg-canvas-2 hover:text-ink"
                onClick={() => snooze(3)}
              >
                3d
              </button>
              <button
                className="px-2 h-7 rounded-md text-ink-3 hover:bg-canvas-2 hover:text-ink"
                onClick={() => snooze(7)}
              >
                1w
              </button>
              <button
                className="ml-auto px-2 h-7 rounded-md text-ink-3 hover:bg-canvas-2 hover:text-ink"
                onClick={() => setDismissing(true)}
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
