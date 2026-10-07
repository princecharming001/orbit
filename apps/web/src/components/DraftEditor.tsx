import type { DraftNeed, OutboundMessage } from '@orbit/core';
import { LINKEDIN_NOTE_MAX, MAX_WORDS, wordsIn } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, useEffect, useState } from 'react';
import { db } from '../db/schema';
import { regenerateDraft } from '../engine/brief';
import {
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
    label: 'One line only true of them',
    hint: 'You have not talked yet, so the message needs one line that shows why you are writing to them: how you found them, what you share, or something of theirs you read. Orbit will not send a first message without it.',
    placeholder: 'e.g. Read your post on pricing experiments at Ramp; we both interned at Brex',
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
  onCancel?: () => void;
  busy?: boolean;
  approveLabel?: string;
}) {
  const { user } = useSession();
  const [body, setBody] = useState(draft.bodyFinal ?? draft.bodyDraft);
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
  useEffect(() => {
    setBody(draft.bodyFinal ?? draft.bodyDraft);
    setSubject(draft.subject ?? '');
  }, [draft.id, draft.bodyDraft, draft.bodyFinal, draft.subject]);
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
    return <OutboxStatus draft={draft} onClose={onCancel} />;
  const first = person?.firstName ?? 'them';
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
          Goes as a reply in your email thread{envelope.subject ? ` “${envelope.subject}”` : ''}.
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
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={Math.min(14, Math.max(6, body.split('\n').length + 2))}
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
          <button className="underline underline-offset-2" onClick={() => setBody(draft.bodyDraft)}>
            Reset to suggested
          </button>
        )}
        <span className="ml-auto flex gap-2">
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
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
      {!isLinkedIn && direct === false && !approveLabel && (
        <p className="mt-1.5 text-[12px] text-ink-3 text-right" data-testid="draft-mail-hint">
          Orbit opens this in your mail app, addressed to {first}. You send it from there.
        </p>
      )}
      {blocked &&
        needs.length > 0 &&
        !notAllowed &&
        !issues.some((i) => i.blocking || i.code === 'placeholder') && (
          <p className="mt-1.5 text-[12px] text-warn" data-testid="draft-blocked-hint">
            Add the missing line above, or replace the text in brackets, to approve this.
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
      draft.channel === 'gmail'
        ? draft.externalThreadId
          ? `Opened in your mail app, addressed to ${name}. Send it there as a reply in your original thread if you can, then press I sent it.`
          : `Opened in your mail app, addressed to ${name}. Send it there, then press I sent it.`
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
                r.ok ? { text: `Logged as sent to ${name}.`, tone: 'good' } : { text: r.error, tone: 'bad' },
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
        {draft.channel === 'linkedin' && (
          <Button
            size="sm"
            disabled={working}
            onClick={async () =>
              toast.push({
                text: (await copyText(text)) ? 'Copied.' : 'Select the text and copy it.',
              })
            }
          >
            Copy again
          </Button>
        )}
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
