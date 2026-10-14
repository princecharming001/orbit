import type { ReplyClass, ReplyItem, ServerDraft, Slot } from '@orbit/core';
import { Linkedin, Mail } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  approveServerDraft,
  blockingQuestions,
  bookCall,
  draftReply,
  freeSlots,
  listReplies,
  NO_DRAFT_CLASSES,
  REPLY_CLASS_LABELS,
  SLOT_CLASSES,
} from '../../engine/replies';
import { useSession } from '../../state/session';
import { Button, Chip, cx, EmptyState, relDate, Spinner, Textarea, useToast } from '../../ui';

const CLASS_TONE: Partial<Record<ReplyClass, 'good' | 'accent' | 'warn' | 'bad' | 'neutral'>> = {
  interested: 'good',
  scheduling: 'good',
  referral: 'accent',
  question: 'accent',
  objection: 'warn',
  not_now: 'warn',
  decline: 'bad',
  unsubscribe: 'bad',
};

/**
 * Drafts' Replies tab (plan 16 §8, account mode): replies to the student's outreach with what each one means, a
 * "Draft reply" in their voice, free times when they want to talk, and Approve. A LinkedIn message needs a second
 * tap; a draft that still asks the student something cannot be approved until it is answered.
 */
export function RepliesPanel() {
  const { user } = useSession();
  const [replies, setReplies] = useState<ReplyItem[]>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<ReplyClass | 'all'>('all');
  const load = useCallback(async () => {
    if (!user) return;
    const r = await listReplies(user);
    if (r.ok) setReplies(r.replies);
    else setError(r.message);
  }, [user]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!user) return null;
  if (error && !replies)
    return (
      <p className="text-[13px] text-bad" role="alert">
        {error}
      </p>
    );
  if (!replies)
    return (
      <div className="py-6 flex justify-center">
        <Spinner />
      </div>
    );
  if (!replies.length)
    return (
      <EmptyState
        title="No replies yet"
        body="When someone answers your outreach, their reply shows up here with a draft answer in your voice."
      />
    );
  const classes = [...new Set(replies.map((r) => r.replyClass))];
  const shown = filter === 'all' ? replies : replies.filter((r) => r.replyClass === filter);
  return (
    <div data-testid="replies">
      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter replies">
        {(['all', ...classes] as const).map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={filter === c}
            onClick={() => setFilter(c)}
            className={cx(
              'h-7 px-2.5 rounded-full text-[12.5px] transition-colors',
              filter === c ? 'bg-ink text-white' : 'bg-canvas-2 text-ink-2 hover:text-ink',
            )}
            data-testid={`replies-filter-${c}`}
          >
            {c === 'all' ? 'All' : REPLY_CLASS_LABELS[c]}
          </button>
        ))}
      </div>
      <div className="space-y-3">
        {shown.map((r) => (
          <ReplyCard key={r.messageId} reply={r} />
        ))}
      </div>
    </div>
  );
}

function ReplyCard({ reply }: { reply: ReplyItem }) {
  const { user } = useSession();
  const toast = useToast();
  const [draft, setDraft] = useState<ServerDraft>();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [slots, setSlots] = useState<Slot[]>();
  const [booking, setBooking] = useState<Slot>();
  if (!user) return null;
  const Icon = reply.channel === 'linkedin' ? Linkedin : Mail;
  const draftIt = async () => {
    setBusy('Drafting…');
    setError(undefined);
    try {
      const r = await draftReply(user, reply.messageId);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setDraft(r.draft);
      setBody(r.draft.body);
      if (SLOT_CLASSES.has(reply.replyClass)) {
        const s = await freeSlots(user, reply.personId ?? undefined);
        if (s.ok && s.slots.length) setSlots(s.slots);
      }
    } finally {
      setBusy(undefined);
    }
  };
  const open = draft ? blockingQuestions(draft, body) : [];
  const approve = async (confirm = false) => {
    if (!draft) return;
    setBusy('Approving…');
    setError(undefined);
    try {
      const r = await approveServerDraft(user, draft, { body, confirm });
      if (!r.ok) setError(r.message);
      else {
        setDraft(r.draft);
        setDone(r.text);
        setConfirming(false);
        toast.push({ text: r.text });
      }
    } finally {
      setBusy(undefined);
    }
  };
  const book = async (s: Slot) => {
    if (!draft) return;
    setBusy('Booking…');
    setError(undefined);
    try {
      const r = await bookCall(user, draft.id, s.start);
      if (!r.ok) setError(r.message);
      else if (r.consentUrl) window.location.assign(r.consentUrl);
      else {
        setBooking(undefined);
        toast.push({ text: `Booked ${s.label}. The invite went to ${reply.personName.split(' ')[0]}.` });
      }
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="rounded-[var(--radius-card)] border border-line p-3" data-testid="reply-card">
      <div className="flex flex-wrap items-center gap-2">
        <Icon size={14} className="text-ink-3" aria-hidden />
        {reply.personId ? (
          <Link to={`/people/${reply.personId}`} className="font-medium hover:underline">
            {reply.personName}
          </Link>
        ) : (
          <span className="font-medium">{reply.personName}</span>
        )}
        <Chip tone={CLASS_TONE[reply.replyClass] ?? 'neutral'}>{REPLY_CLASS_LABELS[reply.replyClass]}</Chip>
        <span className="text-[12px] text-ink-3 ml-auto">{relDate(reply.receivedAt)}</span>
      </div>
      <p className="mt-1.5 text-[13px] text-ink-2 line-clamp-3 whitespace-pre-line">{reply.snippet}</p>
      {done ? (
        <p className="mt-2 text-[13px] text-good" role="status" data-testid="reply-approved">
          {done}
        </p>
      ) : draft ? (
        <div className="mt-3" data-testid="reply-draft">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={Math.min(12, Math.max(4, body.split('\n').length + 1))}
            aria-label={`Your reply to ${reply.personName}`}
            data-testid="reply-body"
          />
          {open.length ? (
            <p
              className="mt-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn"
              data-testid="reply-needs-input"
            >
              Orbit needs you to answer this in the text before it can go: {open[0]}
            </p>
          ) : null}
          {slots?.length ? (
            <div className="mt-2" data-testid="reply-slots">
              <div className="text-[12px] text-ink-3 mb-1">Times you're free</div>
              <div className="flex flex-wrap gap-1.5">
                {slots.map((s) => (
                  <button
                    key={s.start}
                    type="button"
                    className={cx(
                      'h-7 px-2.5 rounded-full text-[12.5px] border',
                      booking?.start === s.start
                        ? 'bg-ink text-white border-ink'
                        : 'border-line hover:bg-canvas-2',
                    )}
                    onClick={() => setBooking(booking?.start === s.start ? undefined : s)}
                    data-testid="reply-slot"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              {booking ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
                  <span>Put {booking.label} on your calendar and invite them?</span>
                  <Button size="sm" onClick={() => book(booking)} disabled={!!busy} data-testid="reply-book">
                    Book it
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {confirming ? (
            <div
              className="mt-3 rounded-lg border border-line bg-canvas-2 p-3 text-[13px]"
              data-testid="reply-confirm"
            >
              <p>This sends from your own LinkedIn account. Send it?</p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => approve(true)}
                  disabled={!!busy}
                  data-testid="reply-confirm-yes"
                >
                  Yes, send it
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Not yet
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={!!busy || open.length > 0 || !body.trim()}
                onClick={() => (draft.channel === 'linkedin' ? setConfirming(true) : approve())}
                data-testid="reply-approve"
              >
                {busy ? <Spinner className="border-white/30 border-t-white" /> : null} Approve
              </Button>
              <span className="text-[12px] text-ink-3">
                {draft.channel === 'linkedin'
                  ? 'LinkedIn messages always wait for your tap.'
                  : 'It goes out in your next send window, and you can cancel until then.'}
              </span>
            </div>
          )}
        </div>
      ) : NO_DRAFT_CLASSES.has(reply.replyClass) ? (
        <p className="mt-2 text-[12.5px] text-ink-3">
          They asked not to be contacted, so Orbit won't write to them again.
        </p>
      ) : (
        <Button
          size="sm"
          className="mt-2"
          onClick={draftIt}
          disabled={!!busy}
          data-testid="reply-draft-button"
        >
          {busy ? <Spinner /> : null} Draft reply
        </Button>
      )}
      {error ? (
        <p className="mt-2 text-[12.5px] text-bad" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
