/**
 * Asks on the Friends tab (plan 29 §A1): intros friends asked of the student ("Noah wants to meet Dan Lee at Stripe.
 * Forward his note?" with Forward, Not this one and the note itself) and intros the student asked ("Ana · Dan Lee ·
 * forwarded Tuesday"). A forward becomes a draft the student approves here like any draft, with the friend in cc;
 * nothing goes on its own.
 */
import type { FriendIntroAsk, ServerDraft, User } from '@orbit/core';
import { useState } from 'react';
import { approveServerDraft } from '../../engine/replies';
import { Button, cx, relDate, Textarea, useToast } from '../../ui';

const TAP = 'pointer-coarse:min-h-11';

const STATUS_WORD: Record<FriendIntroAsk['status'], string> = {
  asked: 'asked',
  forwarded: 'forwarded',
  declined: 'not this time',
  expired: 'expired',
};

/** "Ana · Dan Lee · forwarded Tuesday": one of the student's own asks. */
export function MyAskRow({ ask, now = new Date() }: { ask: FriendIntroAsk; now?: Date }) {
  const when = relDate(ask.answeredAt ?? ask.createdAt, now);
  return (
    <li
      className="py-2 text-[13.5px] flex items-center gap-2"
      data-testid="friend-ask-mine"
      data-status={ask.status}
    >
      <span className="truncate">
        {ask.friendName.split(' ')[0]} · {ask.targetName} · {STATUS_WORD[ask.status]}
        {ask.status !== 'asked' && when ? ` ${when}` : ''}
      </span>
      {ask.status === 'forwarded' && (
        <span className="text-[12.5px] text-ink-3">
          When {ask.targetName.split(' ')[0]} replies, thank {ask.friendName.split(' ')[0]}.
        </span>
      )}
    </li>
  );
}

/** An ask a friend made of the student: the note, Forward (a draft to approve) and Not this one. */
export function ReceivedAskRow({
  ask,
  user,
  onRespond,
  busy,
}: {
  ask: FriendIntroAsk;
  user: User;
  onRespond: (
    ask: FriendIntroAsk,
    action: 'forward' | 'decline',
  ) => Promise<{ ask: FriendIntroAsk; draft: ServerDraft | null } | undefined>;
  busy?: boolean;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<ServerDraft | null>(null);
  const [body, setBody] = useState('');
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState<string>();
  const askerFirst = ask.askerName.split(' ')[0];
  const forward = async () => {
    const r = await onRespond(ask, 'forward');
    if (r?.draft) {
      setDraft(r.draft);
      setBody(r.draft.body);
    }
  };
  const approve = async () => {
    if (!draft) return;
    setApproving(true);
    try {
      const r = await approveServerDraft(user, draft, { body });
      if (!r.ok) {
        toast.push({ text: r.message, tone: 'bad' });
        return;
      }
      setApproved(r.text);
      toast.push({ text: r.text, tone: 'good' });
    } finally {
      setApproving(false);
    }
  };
  return (
    <li className="py-3" data-testid="friend-ask-received" data-status={ask.status}>
      <div className="text-[13.5px]">
        <span className="font-medium">{askerFirst}</span> wants to meet {ask.targetName}
        {ask.targetCompany ? ` at ${ask.targetCompany}` : ''}.{' '}
        {ask.status === 'asked'
          ? `Forward ${askerFirst === 'You' ? 'the' : 'their'} note?`
          : STATUS_WORD[ask.status]}
      </div>
      <blockquote
        className="mt-1.5 border-l-2 border-line pl-3 text-[13px] text-ink-2 whitespace-pre-wrap"
        data-testid="friend-ask-note-text"
      >
        {ask.note}
      </blockquote>
      {ask.status === 'asked' && !draft && (
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" variant="primary" className={TAP} onClick={() => void forward()} loading={busy}>
            Forward
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className={TAP}
            onClick={() => void onRespond(ask, 'decline')}
            disabled={busy}
          >
            Not this one
          </Button>
        </div>
      )}
      {draft && !approved && (
        <div
          className="mt-3 border border-line rounded-[var(--radius-card)] p-3 space-y-2"
          data-testid="friend-forward-draft"
        >
          <div className="text-[12px] text-ink-3">
            To {ask.targetName}, cc {ask.askerName}. Read it over; it goes only when you approve it, by email.
          </div>
          {draft.subject && <div className="text-[13px] font-medium">{draft.subject}</div>}
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            className="text-[13px]"
            aria-label="The note to forward"
            data-testid="draft-body"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              className={TAP}
              onClick={() => void approve()}
              loading={approving}
              data-testid="draft-approve"
            >
              Approve and send
            </Button>
            <span className={cx('text-[12px] text-ink-3')}>Nothing goes out without this tap.</span>
          </div>
        </div>
      )}
      {approved && (
        <p className="mt-2 text-[12.5px] text-ink-2" data-testid="friend-forward-approved">
          {approved}
        </p>
      )}
    </li>
  );
}
