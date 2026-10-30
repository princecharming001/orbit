/**
 * A person's Messages tab (plan 25): every message with them, oldest first, whatever it went through (Gmail,
 * LinkedIn, the texts Orbit imported), each marked by channel, and a box at the bottom to answer on the channel picked
 * without leaving Orbit. "Check now" reads Gmail and LinkedIn this second. When Orbit has a message waiting on the
 * student for them (a time to suggest, a thank-you, a follow-up), its draft fills that box, ready to edit and send,
 * with Dismiss beside it: the reply is written where the conversation is.
 */
import type { Person, Suggestion } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Send, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { db } from '../db/schema';
import { draftTypedMessage, ensureDrafts, isMessageSuggestion } from '../engine/brief';
import { type ConversationItem, conversationWith } from '../engine/conversation';
import { dismissSuggestion, restoreSuggestion } from '../engine/send';
import { SUGGESTION_KIND_LABELS } from '../engine/today';
import { useSession } from '../state/session';
import { Button, cx, Skeleton, Textarea, useToast } from '../ui';
import { runApproval } from './approve';
import { OutboxStatus } from './DraftEditor';
import { RepliesChecked } from './RepliesChecked';

type Filter = 'all' | ConversationItem['channel'];
const CHANNEL_NAME: Record<ConversationItem['channel'], string> = {
  gmail: 'Email',
  linkedin: 'LinkedIn',
  text: 'Text',
};

/** Cards that are a reply in this conversation; a first message and a warm-up step keep their own card. */
export const composesHere = (s: Pick<Suggestion, 'kind' | 'status'>) =>
  (s.status === 'pending' || s.status === 'snoozed') &&
  s.kind !== 'new_outreach' &&
  s.kind !== 'warm_up_engage' &&
  isMessageSuggestion(s.kind);

const bareSubject = (s: string | undefined) => (s ?? '').replace(/^\s*((re|fwd?)\s*:\s*)+/i, '').trim();

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

export function Conversation({ person }: { person: Person }) {
  const { user } = useSession();
  const toast = useToast();
  const items = useLiveQuery(() => (user ? conversationWith(user.id, person.id) : []), [user?.id, person.id]);
  const [filter, setFilter] = useState<Filter>('all');
  const channels = useMemo(() => [...new Set((items ?? []).map((i) => i.channel))], [items]);
  const shown = (items ?? []).filter((i) => filter === 'all' || i.channel === filter);
  // where Orbit can answer: LinkedIn when they are on it, email when Orbit has their address
  const canSend = useMemo(() => {
    const out: ('linkedin' | 'gmail')[] = [];
    if (person.linkedinUrl || person.linkedinMemberId) out.push('linkedin');
    if (person.primaryEmail) out.push('gmail');
    return out;
  }, [person.linkedinUrl, person.linkedinMemberId, person.primaryEmail]);
  // answer where they last wrote
  const lastIn = [...(items ?? [])].reverse().find((i) => !i.out && i.channel !== 'text');
  const preferred =
    lastIn && canSend.includes(lastIn.channel as 'linkedin' | 'gmail')
      ? (lastIn.channel as 'linkedin' | 'gmail')
      : canSend[0];
  // the newest message card waiting on the student for them, and its draft (written now if it has none yet)
  const waiting = useLiveQuery(
    async () =>
      (
        await db.suggestions
          .where('personId')
          .equals(person.id)
          .filter((s) => s.status === 'pending' && composesHere(s))
          .toArray()
      ).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null,
    [person.id],
  );
  const suggested = useLiveQuery(
    async () =>
      waiting?.outboundMessageId ? ((await db.outbound.get(waiting.outboundMessageId)) ?? null) : null,
    [waiting?.outboundMessageId],
  );
  const [drafting, setDrafting] = useState(false);
  useEffect(() => {
    if (!user || !waiting || waiting.outboundMessageId) return;
    let live = true;
    setDrafting(true);
    ensureDrafts(user, [waiting.id])
      .catch(() => undefined)
      .finally(() => live && setDrafting(false));
    return () => {
      live = false;
    };
  }, [user, waiting?.id, waiting?.outboundMessageId]);
  const usable = suggested && suggested.status === 'draft' ? suggested : undefined;
  const [picked, setPicked] = useState<'linkedin' | 'gmail' | undefined>();
  const draftChannel =
    usable && canSend.includes(usable.channel as 'linkedin' | 'gmail')
      ? (usable.channel as 'linkedin' | 'gmail')
      : undefined;
  const channel = picked ?? draftChannel ?? preferred;
  const [body, setBody] = useState('');
  // the draft fills the box once, when it arrives and the student has not typed anything of their own
  const [filledFrom, setFilledFrom] = useState<string>();
  useEffect(() => {
    if (!usable || filledFrom === usable.id) return;
    setFilledFrom(usable.id);
    setBody((b) => (b.trim() ? b : (usable.bodyFinal ?? usable.bodyDraft)));
  }, [usable?.id, usable?.bodyFinal, usable?.bodyDraft, filledFrom]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const end = useRef<HTMLDivElement>(null);
  // the newest message in view when the conversation opens or grows
  useEffect(() => {
    if (shown.length) end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [shown.length]);
  if (!user) return null;
  // the messages are still being read: bubbles in outline, never an empty conversation
  if (!items)
    return (
      <div
        className="space-y-3 loading-in"
        role="status"
        aria-busy="true"
        aria-label="Loading"
        data-testid="conversation-loading"
      >
        {[
          ['self-start', '62%'],
          ['self-end', '48%'],
          ['self-start', '70%'],
          ['self-end', '40%'],
        ].map(([side, w]) => (
          <div key={w} className={cx('flex', side === 'self-end' ? 'justify-end' : 'justify-start')}>
            <Skeleton className="h-10 rounded-[14px]" style={{ width: w }} />
          </div>
        ))}
      </div>
    );

  const send = async () => {
    const text = body.trim();
    if (!text || !channel) return;
    setBusy(true);
    setError(undefined);
    try {
      // Orbit's draft, edited or not, goes out as itself (the card it answers is then done); anything else as typed
      const draft =
        usable && usable.channel === channel
          ? usable
          : await draftTypedMessage(user, person.id, channel, text);
      if (!draft) return setError('Orbit could not find this person.');
      const err = await runApproval(user, draft, text, draft.subject, toast, person.firstName);
      if (err) setError(err);
      else setBody('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="conversation">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {channels.length > 1 ? (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show messages from">
            {(['all', ...channels] as Filter[]).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setFilter(c)}
                aria-pressed={filter === c}
                className={cx(
                  'h-7 rounded-full border px-2.5 text-[12px] pointer-coarse:min-h-11',
                  filter === c ? 'border-ink bg-ink text-canvas' : 'border-line text-ink-2 hover:bg-canvas-2',
                )}
                data-testid={`conversation-filter-${c}`}
              >
                {c === 'all' ? 'All' : CHANNEL_NAME[c]}
              </button>
            ))}
          </div>
        ) : (
          <span />
        )}
        <RepliesChecked className="text-[12px] text-ink-3" />
      </div>

      {shown.length === 0 ? (
        <p className="text-[13px] text-ink-3" data-testid="conversation-empty">
          No messages with {person.firstName} yet. Orbit shows email, LinkedIn messages and texts here as they
          come in.
        </p>
      ) : (
        <ol className="space-y-2.5" aria-label={`Messages with ${person.firstName}`}>
          {shown.map((m, i) => {
            // an email's subject when it starts a new email thread (a "Re:" or a LinkedIn message between is not one)
            const prevMail = shown
              .slice(0, i)
              .reverse()
              .find((x) => x.channel === 'gmail');
            const newSubject =
              m.channel === 'gmail' &&
              !!m.subject &&
              bareSubject(m.subject) !== bareSubject(prevMail?.subject);
            return (
              <li
                key={m.id}
                className={cx('flex flex-col', m.out ? 'items-end' : 'items-start')}
                data-testid="conversation-message"
                data-channel={m.channel}
                data-out={m.out ? 'true' : 'false'}
              >
                {newSubject && <div className="mb-1 text-[12px] font-medium text-ink-2">{m.subject}</div>}
                <div
                  className={cx(
                    'max-w-[85%] whitespace-pre-wrap break-words rounded-[14px] px-3 py-2 text-[13.5px] leading-relaxed',
                    m.out ? 'bg-ink text-canvas' : 'border border-line bg-canvas-2 text-ink',
                    m.pending && 'opacity-70',
                  )}
                >
                  {m.text}
                </div>
                <div className="mt-0.5 text-[11.5px] text-ink-3">
                  {m.out ? 'You' : person.firstName} · {CHANNEL_NAME[m.channel]}
                  {m.group ? ' · group thread' : ''} · {when(m.at)}
                  {m.pending ? ' · sending' : ''}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <div ref={end} />
      {/* Orbit's draft went out through the mail app or LinkedIn: whether it was sent is asked here, where it was written */}
      {suggested && ['queued', 'sending', 'handed_off'].includes(suggested.status) && (
        <div data-testid="conversation-outbox">
          <OutboxStatus draft={suggested} />
        </div>
      )}

      {canSend.length > 0 && channel ? (
        <form
          className="rounded-[14px] border border-line bg-canvas p-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          data-testid="conversation-reply"
        >
          {waiting && (!suggested || suggested.status === 'draft') && (
            <SuggestedLine
              s={waiting}
              userId={user.id}
              onGone={() => {
                // the draft leaves with its card; words the student changed stay in the box
                const text = usable ? (usable.bodyFinal ?? usable.bodyDraft) : undefined;
                if (text && body === text) setBody('');
              }}
            />
          )}
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={usable && body ? Math.min(10, Math.max(3, body.split('\n').length + 1)) : 3}
            placeholder={drafting ? 'Orbit is writing a draft…' : `Write to ${person.firstName}`}
            aria-label={`Message to ${person.firstName}`}
            className="border-0 focus:ring-0 px-1"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
            data-testid="conversation-input"
          />
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[12px] text-ink-3">
              <span>Send on</span>
              {canSend.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setPicked(c)}
                  aria-pressed={channel === c}
                  className={cx(
                    'h-7 rounded-full border px-2.5 pointer-coarse:min-h-11',
                    channel === c ? 'border-ink text-ink' : 'border-line hover:bg-canvas-2',
                  )}
                  data-testid={`conversation-channel-${c}`}
                >
                  {c === 'gmail' ? 'Email' : 'LinkedIn'}
                </button>
              ))}
            </div>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={!body.trim()}
              loading={busy}
              data-testid="conversation-send"
            >
              {!busy && <Send size={13} aria-hidden />} Send
            </Button>
          </div>
          {error && (
            <p className="mt-1.5 text-[12.5px] text-bad" role="alert" data-testid="conversation-error">
              {error}
            </p>
          )}
        </form>
      ) : (
        <p className="text-[12.5px] text-ink-3">
          Orbit has no email address or LinkedIn profile for {person.firstName}, so there is nowhere to write
          from here.
        </p>
      )}
    </div>
  );
}

/** What the draft in the box is for, with Dismiss: the waiting card, folded into the composer. */
function SuggestedLine({ s, userId, onGone }: { s: Suggestion; userId: string; onGone: () => void }) {
  const toast = useToast();
  const label = SUGGESTION_KIND_LABELS[s.kind]?.label ?? 'Suggested';
  const dismiss = async () => {
    await dismissSuggestion(userId, s, 'not_relevant');
    onGone();
    toast.push({
      text: 'Draft removed.',
      action: { label: 'Undo', onClick: () => restoreSuggestion(s) },
      ttl: 6000,
    });
  };
  const link = 'underline-offset-2 hover:text-ink hover:underline pointer-coarse:min-h-11';
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 pb-1.5 text-[12px] text-ink-3"
      data-testid="conversation-suggested"
    >
      <span className="inline-flex items-center gap-1.5">
        <Sparkles size={12} aria-hidden className="text-accent" />
        <span>
          Orbit&apos;s draft: <span className="text-ink-2">{label}</span>
        </span>
      </span>
      <span className="inline-flex items-center gap-2.5">
        <button type="button" className={link} onClick={dismiss} data-testid="conversation-dismiss">
          Dismiss
        </button>
      </span>
    </div>
  );
}
