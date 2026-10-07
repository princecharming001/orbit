import type { DraftNeed, OutboundMessage } from '@orbit/core';
import { LINKEDIN_NOTE_MAX, MAX_WORDS, WHY_THEM, wordsIn } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { db } from '../db/schema';
import { regenerateDraft } from '../engine/brief';
import {
  approveAndSend,
  checkSendAllowed,
  confirmHandoff,
  type DraftIssue,
  draftEnvelope,
  googleSendActive,
  handoffLink,
  isConnectionNote,
  revertHandoff,
  reviewDraft,
  undoQueued,
} from '../engine/send';
import { useSession } from '../state/session';
import { Button, cx, Input, relDate, Textarea, useToast } from '../ui';
import { copyText, openHandoff } from './approve';

type PromptNeed = Exclude<DraftNeed, 'post'>;
const INPUT_PROMPT: Record<PromptNeed, { label: string; hint: string; placeholder: string }> = {
  connection: {
    label: WHY_THEM,
    hint: 'One line only true of them: how you found them, what you share, or something of theirs you read. You have not talked yet, so Orbit will not send a first message without it.',
    placeholder: 'e.g. I read your post about your first year at the firm',
  },
  update: {
    label: 'One real update since you last spoke',
    hint: 'What you did with their advice, or what changed. A check-in without news reads as a nudge.',
    placeholder: 'e.g. Took your advice and moved my summer to the ops role; first week was ...',
  },
  news: {
    label: 'What are you congratulating them on?',
    hint: 'Finish the sentence "Just saw the news about ...". Orbit has no job change on record for them.',
    placeholder: 'e.g. your move to Figma as a senior PM',
  },
  target: {
    label: 'Who should they introduce you to?',
    hint: 'Name, and title and company if you know them.',
    placeholder: 'e.g. Lucas Fischer, Engineering Manager at Ramp',
  },
  answer: {
    label: 'Your answer to their question',
    hint: 'Orbit never answers a question for you. One or two sentences in your own words.',
    placeholder: 'e.g. Mostly growth and onboarding, since that is what I worked on at Brex',
  },
  role: {
    label: 'Which role are you applying to?',
    hint: 'The role and the company, so the ask is a two-minute task for them.',
    placeholder: 'e.g. PM Intern at Notion',
  },
  takeaway: {
    label: 'One thing they said that stuck with you',
    hint: 'A thank-you without it reads like a form letter. Their advice, a story, a point they made, in a few words.',
    placeholder: 'e.g. to lead every interview answer with one project story',
  },
};

export function DraftEditor({
  draft,
  onApprove,
  onCancel,
  busy,
  approveLabel,
}: {
  draft: OutboundMessage;
  /** resolves to an error to show inline when the message was not approved */
  onApprove: (body: string, subject?: string) => Promise<string | undefined>;
  /**
   * Close the editor. An edited draft asks first (keep or discard the changes). `kept` says whether the draft still
   * holds the student's own words afterwards, so a page can drop a draft nobody wrote anything in.
   */
  onCancel?: (r: { kept: boolean }) => void;
  busy?: boolean;
  approveLabel?: string;
}) {
  const { user } = useSession();
  const toast = useToast();
  const [body, setBody] = useState(draft.bodyFinal ?? draft.bodyDraft);
  const bodyId = useId();
  // the box grows with the message, so the whole draft (sign-off included) is visible without scrolling inside it,
  // which matters on a phone where every line wraps
  useLayoutEffect(() => {
    // the status too: the box mounts again when a hand-off is taken back for editing
    void body;
    void draft.status;
    const el = document.getElementById(bodyId) as HTMLTextAreaElement | null;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [body, bodyId, draft.status]);
  const [subject, setSubject] = useState(draft.subject ?? '');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [regenerating, setRegenerating] = useState(false);
  const [issues, setIssues] = useState<DraftIssue[]>([]);
  const [error, setError] = useState<string>();
  const [notAllowed, setNotAllowed] = useState<string>();
  const [envelope, setEnvelope] = useState<{ threaded: boolean; subject?: string }>({
    threaded: !!draft.externalThreadId,
  });
  const person = useLiveQuery(() => db.people.get(draft.personId), [draft.personId]);
  // whether approving sends from Orbit (Google connected with send permission) or opens the mail app
  const direct = useLiveQuery(
    async () => (user && draft.channel === 'gmail' ? googleSendActive(user.id) : false),
    [user?.id, draft.channel],
  );
  const chats = useLiveQuery(
    () => db.chats.where('personId').equals(draft.personId).toArray(),
    [draft.personId],
  );
  // a new draft (or a redraft) replaces the text; the student's own saved edits do not reset what they are typing
  useEffect(() => {
    setBody(draft.bodyFinal ?? draft.bodyDraft);
    setSubject(draft.subject ?? '');
  }, [draft.id, draft.bodyDraft]);
  // what the editor showed when it opened, so Cancel knows whether anything changed since
  const [opened] = useState(() => ({
    body: draft.bodyFinal ?? draft.bodyDraft,
    subject: draft.subject ?? '',
  }));
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [copying, setCopying] = useState(false);
  // edits are kept as they are typed, so leaving the page (to check LinkedIn) and coming back loses nothing; the
  // latest text is also written when the editor closes, so a change made just before leaving is never dropped
  const latest = useRef({ body, subject, draft, discard: false });
  latest.current = { ...latest.current, body, subject, draft };
  useEffect(() => {
    if (draft.status !== 'draft') return;
    const t = setTimeout(() => saveEdits(draft, body, subject), 400);
    return () => clearTimeout(t);
  }, [body, subject, draft]);
  useEffect(() => {
    const flush = () => {
      const l = latest.current;
      if (!l.discard && l.draft.status === 'draft') saveEdits(l.draft, l.body, l.subject);
    };
    // the tab closing or going to the background (a phone switching apps) also saves what was typed
    const hidden = () => document.visibilityState === 'hidden' && flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hidden);
      flush();
    };
  }, []);
  useEffect(() => {
    let live = true;
    draftEnvelope(draft).then((e) => live && setEnvelope(e));
    return () => {
      live = false;
    };
  }, [draft]);
  // the send rules (daily cap, cooldown, declined) checked up front, so the button says why before anyone clicks
  useEffect(() => {
    if (!user || draft.status === 'sent') return;
    let live = true;
    checkSendAllowed(user.id, draft.personId, draft.channel, draft.kind, new Date(), {
      chatId: draft.chatId,
      excludeMessageId: draft.id,
    }).then((r) => live && setNotAllowed(r.allowed ? undefined : r.reason));
    return () => {
      live = false;
    };
  }, [user, draft.id, draft.personId, draft.channel, draft.kind, draft.chatId, draft.status]);
  // the core validator re-run on what the student is about to approve
  useEffect(() => {
    if (!user) return;
    let live = true;
    const t = setTimeout(() => {
      reviewDraft(user, draft, body, subject || undefined).then((x) => live && setIssues(x));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [user, draft, body, subject]);
  const wc = wordsIn(body);
  const max = MAX_WORDS[draft.kind];
  const edited = body.trim() !== draft.bodyDraft.trim();
  const isLinkedIn = draft.channel === 'linkedin';
  const connectionNote = isConnectionNote(draft, person ?? undefined, chats ?? []);
  const needs = (draft.needsInput ?? []).filter((n): n is PromptNeed => n !== 'post');
  const hasPlaceholder = /\[[^\]]{3,}\]/.test(body);
  const blocked =
    (needs.length > 0 && (hasPlaceholder || !edited)) || issues.some((i) => i.blocking) || !!notAllowed;
  const shownError = error ?? (draft.status === 'failed' || draft.error ? draft.error : undefined);
  if (['queued', 'sending', 'handed_off', 'sent'].includes(draft.status))
    return <OutboxStatus draft={draft} onClose={onCancel && (() => onCancel({ kept: false }))} />;
  const first = person?.firstName ?? 'them';
  // Copy text is a hand-off like the mail app: the message waits for "I sent it", so a Gmail user can log the send
  const copyAll = async () => {
    if (!user) return;
    const subj = envelope.threaded ? envelope.subject : subject;
    // the clipboard write starts inside the click; browsers drop clipboard access after a long async gap
    const copied = copyText(`${subj ? `Subject: ${subj}\n\n` : ''}${body}`);
    setCopying(true);
    setError(undefined);
    try {
      const r = await approveAndSend(user, draft.id, body, subject || undefined, new Date(), { via: 'copy' });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.push({
        text: (await copied)
          ? 'Copied. Paste it into Gmail and send it, then come back and press I sent it.'
          : 'Select the text in the box and copy it, send it from Gmail, then press I sent it.',
        ttl: 8000,
      });
    } finally {
      setCopying(false);
    }
  };
  const dirty = body !== opened.body || subject !== opened.subject;
  const close = (keep: boolean) => {
    setConfirmingClose(false);
    if (keep) {
      saveEdits(draft, body, subject);
      onCancel?.({ kept: true });
      return;
    }
    // put back what was there when the editor opened, and make sure closing does not save the discarded text
    latest.current.discard = true;
    saveEdits(draft, opened.body, opened.subject);
    onCancel?.({ kept: opened.body.trim() !== draft.bodyDraft.trim() });
  };
  const cancel = () => {
    if (dirty) setConfirmingClose(true);
    else onCancel?.({ kept: !!draft.bodyFinal });
  };
  const defaultLabel = isLinkedIn
    ? connectionNote
      ? 'Copy note & open LinkedIn'
      : 'Copy & open LinkedIn'
    : direct
      ? `Send to ${first}`
      : 'Open in mail app';
  const canRegenerate = needs.every((n) => (inputs[n] ?? '').trim().length >= (n === 'role' ? 4 : 8));
  const regenerate = async () => {
    if (!user) return;
    setRegenerating(true);
    const given = Object.fromEntries(needs.map((n) => [n, inputs[n]?.trim()]).filter(([, v]) => v));
    await regenerateDraft(user, draft.id, given);
    setInputs({});
    setRegenerating(false);
  };
  return (
    <div>
      {needs.length > 0 && (
        <div
          className="mb-3 rounded-lg border border-warn/40 bg-warn/5 p-3 text-[13px]"
          data-testid="draft-needs-input"
        >
          {needs.map((n) => (
            <div key={n} className="mb-2 last:mb-0">
              <div className="font-medium">{INPUT_PROMPT[n].label}</div>
              <div className="text-ink-3 text-[12px] mb-1.5">{INPUT_PROMPT[n].hint}</div>
              <Input
                value={inputs[n] ?? ''}
                onChange={(e) => setInputs((v) => ({ ...v, [n]: e.target.value }))}
                placeholder={INPUT_PROMPT[n].placeholder}
                aria-label={INPUT_PROMPT[n].label}
                data-testid={`draft-input-${n}`}
              />
            </div>
          ))}
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={!canRegenerate || regenerating}
              onClick={regenerate}
              data-testid="draft-redraft"
            >
              {regenerating ? 'Redrafting…' : 'Redraft with this'}
            </Button>
            <span className="text-[12px] text-ink-3">or edit the bracketed line yourself below.</span>
          </div>
        </div>
      )}
      {!isLinkedIn && (
        <div className="text-[12px] text-ink-3 mb-1.5 truncate" data-testid="draft-to">
          To: {person?.displayName ?? 'them'}
          {draft.toEmail ? ` <${draft.toEmail}>` : ''}
        </div>
      )}
      {!isLinkedIn && !envelope.threaded && (
        <div className="mb-2 flex items-center gap-2">
          <label htmlFor={`subject-${draft.id}`} className="text-[12px] text-ink-3 shrink-0">
            Subject
          </label>
          <Input
            id={`subject-${draft.id}`}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
          />
        </div>
      )}
      {!isLinkedIn && envelope.threaded && (
        <div className="text-[12px] text-ink-3 mb-2" data-testid="draft-thread-subject">
          {direct
            ? `Goes as a reply in your email thread${envelope.subject ? ` “${envelope.subject}”` : ''}.`
            : `Opens as a new email${envelope.subject ? ` with the subject “${envelope.subject}”` : ''}, so ${first} sees which conversation it follows.`}
        </div>
      )}
      {isLinkedIn && (
        <div className="text-[12px] text-ink-3 mb-2" data-testid="draft-linkedin-hint">
          {connectionNote
            ? `Connection note. You are not connected to ${person?.firstName ?? 'them'} yet, so this goes with your connection request (${LINKEDIN_NOTE_MAX} characters at most).`
            : 'LinkedIn message. You are connected, so this opens a message to them.'}
        </div>
      )}
      <Textarea
        id={bodyId}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        className="resize-none overflow-hidden"
        aria-label="Message body"
      />
      <div className="mt-2 flex items-center gap-3 text-[12px] text-ink-3 flex-wrap">
        <span className={cx('tabular', wc > max && 'text-warn')}>
          {wc} word{wc === 1 ? '' : 's'}
          {wc > max ? ` (aim for ${max} or fewer)` : ''}
        </span>
        {isLinkedIn && (
          <span className={cx('tabular', connectionNote && body.length > LINKEDIN_NOTE_MAX && 'text-bad')}>
            {connectionNote
              ? `${body.length} / ${LINKEDIN_NOTE_MAX} characters`
              : `${body.length} characters`}
          </span>
        )}
        <span>{draft.generatedBy === 'llm' ? 'Drafted with Claude' : 'Drafted by Orbit'}</span>
        {edited && (
          <button
            className="underline underline-offset-2"
            onClick={() => {
              const mine = body;
              setBody(draft.bodyDraft);
              toast.push({
                text: 'Back to the suggested text.',
                action: { label: 'Undo', onClick: () => setBody(mine) },
                ttl: 8000,
              });
            }}
          >
            Reset to suggested
          </button>
        )}
        <span className="ml-auto flex gap-2">
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={cancel} data-testid="draft-cancel">
              Cancel
            </Button>
          )}
          {!isLinkedIn && !direct && !approveLabel && (
            <Button
              size="sm"
              onClick={copyAll}
              disabled={busy || copying || !body.trim() || blocked}
              title={
                blocked
                  ? (notAllowed ?? issues.find((i) => i.blocking)?.text ?? 'Add the missing line first')
                  : 'Copy the message to paste into Gmail in your browser'
              }
              data-testid="draft-copy"
            >
              Copy text
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !body.trim() || blocked}
            title={
              notAllowed ??
              issues.find((i) => i.blocking)?.text ??
              (blocked ? 'Add the missing line first' : undefined)
            }
            onClick={async () => {
              setError(undefined);
              const e = await onApprove(body, subject || undefined);
              if (e) setError(e);
            }}
          >
            {approveLabel ?? defaultLabel}
          </Button>
        </span>
      </div>
      {confirmingClose && (
        <div
          className="mt-2 rounded-lg border border-line bg-canvas-2 p-3 text-[13px]"
          role="alertdialog"
          aria-label="Keep your changes?"
          data-testid="draft-close-confirm"
        >
          <p className="font-medium">Keep your changes to this draft?</p>
          <p className="text-ink-3 text-[12px] mt-0.5">
            Kept changes stay in the draft until you send it. Discarding puts back the text from when you
            opened it.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => close(true)} data-testid="draft-keep">
              Keep changes
            </Button>
            <Button size="sm" onClick={() => close(false)} data-testid="draft-discard">
              Discard changes
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmingClose(false)}>
              Keep editing
            </Button>
          </div>
        </div>
      )}
      {!isLinkedIn && direct === false && !approveLabel && (
        <p className="mt-1.5 text-[12px] text-ink-3 text-right" data-testid="draft-mail-hint">
          Open in mail app starts the email in your mail app, addressed to {first}. Use Gmail in the browser?
          Copy text, paste it there, then press I sent it.
        </p>
      )}
      {blocked &&
        needs.length > 0 &&
        !notAllowed &&
        !issues.some((i) => i.blocking || i.code === 'placeholder') && (
          <p className="mt-1.5 text-[12px] text-warn" data-testid="draft-blocked-hint">
            Add the missing line above, or replace the text in brackets, to send this.
          </p>
        )}
      {(shownError || notAllowed || issues.length > 0) && (
        <ul className="mt-2 space-y-1 text-[12.5px]" data-testid="draft-issues">
          {shownError && <li className="text-bad">Not sent: {shownError}</li>}
          {notAllowed && notAllowed !== shownError && (
            <li className="text-bad">Can't send this yet: {notAllowed}</li>
          )}
          {issues.map((i) => (
            // a placeholder holds the button back while the line is missing, so it reads as a fix, not a suggestion
            <li
              key={`${i.code}:${i.text}`}
              className={i.blocking || (blocked && i.code === 'placeholder') ? 'text-bad' : 'text-warn'}
            >
              {i.blocking || (blocked && i.code === 'placeholder')
                ? 'Fix before sending: '
                : 'Worth a look: '}
              {i.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Write the student's edits to a draft that is still a draft; the suggested text itself is never stored twice. */
function saveEdits(draft: OutboundMessage, body: string, subject: string): void {
  const changedBody = body !== (draft.bodyFinal ?? draft.bodyDraft);
  const changedSubject = subject !== (draft.subject ?? '');
  if (!changedBody && !changedSubject) return;
  db.outbound
    .where('id')
    .equals(draft.id)
    .filter((m) => m.status === 'draft')
    .modify({
      bodyFinal: body.trim() === draft.bodyDraft.trim() ? undefined : body,
      ...(changedSubject ? { subject: subject || undefined } : {}),
    })
    .catch(() => undefined);
}

/** Where a message waiting for "I sent it" went: "opened in LinkedIn", "opened in your mail app", "copied for Gmail". */
export function handoffWhere(o: Pick<OutboundMessage, 'channel' | 'handoffVia'>): string {
  if (o.handoffVia === 'copy') return 'copied to paste into Gmail';
  return o.channel === 'linkedin' ? 'opened in LinkedIn' : 'opened in your mail app';
}

/** A message that left the editor: queued behind the undo window, handed off, sending or sent. */
export function OutboxStatus({ draft, onClose }: { draft: OutboundMessage; onClose?: () => void }) {
  const { user } = useSession();
  const toast = useToast();
  const person = useLiveQuery(() => db.people.get(draft.personId), [draft.personId]);
  // resolved ahead of the click, so "Open again" opens inside the click and is not treated as a popup
  const link = useLiveQuery(
    async () => (user && draft.status === 'handed_off' ? handoffLink(user, draft.id) : undefined),
    [user?.id, draft.id, draft.status, draft.bodyFinal],
  );
  const [now, setNow] = useState(() => Date.now());
  const [working, setWorking] = useState(false);
  useEffect(() => {
    if (draft.status !== 'queued') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [draft.status]);
  if (!user) return null;
  const name = person?.firstName ?? 'them';
  const act = async (fn: () => Promise<unknown>) => {
    setWorking(true);
    try {
      await fn();
    } finally {
      setWorking(false);
    }
  };
  const text = draft.bodyFinal ?? draft.bodyDraft;
  let line: string;
  let actions: ReactNode = null;
  if (draft.status === 'queued') {
    const secs = Math.max(0, Math.ceil((new Date(draft.sendAt ?? now).getTime() - now) / 1000));
    line = secs > 0 ? `Sending to ${name} in ${secs} seconds.` : `Sending to ${name} now.`;
    actions = (
      <Button
        size="sm"
        disabled={working}
        onClick={() =>
          act(async () => {
            const undone = await undoQueued(user, draft.id);
            toast.push({ text: undone ? 'Not sent. The draft is back.' : 'Too late, it already went out.' });
          })
        }
      >
        Undo
      </Button>
    );
  } else if (draft.status === 'sending') {
    line = `Sending to ${name}.`;
  } else if (draft.status === 'handed_off') {
    line =
      draft.handoffVia === 'copy'
        ? draft.externalThreadId
          ? `Copied. In Gmail, open your thread "${draft.subject?.replace(/^re:\s*/i, '') ?? 'with them'}" with ${name}, reply with the text, then press I sent it.`
          : `Copied. Paste it into a new email to ${person?.primaryEmail ?? name} in Gmail, send it, then press I sent it.`
        : draft.channel === 'gmail'
          ? draft.externalThreadId
            ? `Opened in your mail app as a new email to ${name}. Send it there, then press I sent it. Nothing opened? Copy the text into Gmail.`
            : `Opened in your mail app, addressed to ${name}. Send it there, then press I sent it. Nothing opened? Copy the text into Gmail.`
          : link?.via === 'linkedin_connect'
            ? `On ${name}'s LinkedIn profile, click Connect, then Add a note, and paste the note. Press I sent it once the request is out.`
            : `Paste the message into LinkedIn and send it to ${name}, then press I sent it.`;
    actions = (
      <>
        <Button
          size="sm"
          variant="primary"
          disabled={working}
          onClick={() =>
            act(async () => {
              const r = await confirmHandoff(user, draft.id);
              toast.push(
                r.ok
                  ? {
                      text: r.scheduledAt
                        ? `Logged as sent. Your chat with ${name} is booked for ${new Date(r.scheduledAt).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}, under Coming up on Today.`
                        : `Logged as sent to ${name}.`,
                      tone: 'good',
                      ttl: r.scheduledAt ? 8000 : undefined,
                    }
                  : { text: r.error, tone: 'bad' },
              );
            })
          }
        >
          I sent it
        </Button>
        {link && (
          <Button
            size="sm"
            disabled={working}
            onClick={() => {
              if (!openHandoff(link.url))
                toast.push({
                  text: 'Your browser blocked the new tab. Allow pop-ups for Orbit and try again.',
                });
            }}
          >
            {link.via === 'mailto' ? 'Open mail app again' : 'Open LinkedIn again'}
          </Button>
        )}
        <Button
          size="sm"
          disabled={working}
          onClick={async () =>
            toast.push({
              text: (await copyText(
                draft.channel === 'gmail' && draft.subject ? `Subject: ${draft.subject}\n\n${text}` : text,
              ))
                ? draft.channel === 'gmail'
                  ? `Copied. Paste it into a new email to ${person?.primaryEmail ?? name}.`
                  : 'Copied.'
                : 'Select the text and copy it.',
            })
          }
          data-testid="handoff-copy"
        >
          {draft.channel === 'linkedin' ? 'Copy again' : 'Copy text'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={working}
          onClick={() => act(() => revertHandoff(user, draft.id))}
        >
          Not sent, edit it
        </Button>
      </>
    );
  } else {
    line = `Sent to ${name} ${relDate(draft.sentAt)}.`;
    actions = onClose ? (
      <Button size="sm" variant="ghost" onClick={onClose}>
        Close
      </Button>
    ) : null;
  }
  return (
    <div className="rounded-lg border border-line bg-canvas-2 p-3" data-testid={`outbox-${draft.status}`}>
      <p className="text-[13px] text-ink-2 whitespace-pre-line line-clamp-3">{text}</p>
      <div className="mt-2 flex items-center gap-2 flex-wrap text-[13px]">
        <span className="font-medium mr-auto" aria-live="polite">
          {line}
        </span>
        {actions}
      </div>
    </div>
  );
}
