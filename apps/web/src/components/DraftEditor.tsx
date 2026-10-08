import type { DraftNeed, OutboundMessage } from '@orbit/core';
import {
  LINKEDIN_NOTE_MAX,
  LINKEDIN_NOTE_TARGET,
  MAX_WORDS,
  MESSAGE_KIND_LABELS,
  WHY_THEM,
  WHY_THEM_GAP,
  wordsIn,
} from '@orbit/core';
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
  restorePerson,
  revertHandoff,
  reviewDraft,
  snapshotPerson,
  undoQueued,
} from '../engine/send';
import { useSession } from '../state/session';
import { Button, cx, Input, relDate, Textarea, useToast } from '../ui';
import { copyText, openHandoff } from './approve';

type PromptNeed = Exclude<DraftNeed, 'post' | 'resume'>;
/** Messages that ask a favour: two of them to one person at once is too much. */
const ASK_KINDS = new Set<OutboundMessage['kind']>(['referral_ask', 'intro_request']);
const INPUT_PROMPT: Record<PromptNeed, { label: string; hint: string; placeholder: string }> = {
  connection: {
    label: WHY_THEM,
    hint: 'One line only true of them: how you found them, what you share, or something of theirs you read. You have not talked yet, so the send buttons stay off until you add it.',
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
    hint: 'The role and the company, so the ask is a two-minute task for them. If it is not a role their part of the firm hires for, a check-in fits better than a referral ask.',
    placeholder: 'e.g. PM Intern at Notion',
  },
  mutual: {
    label: 'Who do you both know?',
    hint: 'Your line mentions someone without a name. With the name, they can place the connection.',
    placeholder: 'e.g. Jordan Lee',
  },
  posting: {
    label: 'Link to the posting',
    hint: 'They asked for the posting, so the ask goes out with it. Paste the link to the role, and name the team if they asked you to pick one.',
    placeholder: 'e.g. https://stripe.com/jobs/listing/software-engineer-intern/1234',
  },
  takeaway: {
    label: 'One thing they said that stuck with you',
    hint: 'A note without it reads like a form letter. Their advice, a story, a point they made, in a few words.',
    placeholder: 'e.g. to lead every interview answer with one project story',
  },
};

/** How the student last used the page: a key press or a pointer (mouse, finger). */
let lastInput: 'keyboard' | 'pointer' = 'pointer';
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', () => (lastInput = 'keyboard'), true);
  window.addEventListener('pointerdown', () => (lastInput = 'pointer'), true);
}

export function DraftEditor({
  draft,
  onApprove,
  onCancel,
  busy,
  approveLabel,
  focusOnOpen,
}: {
  draft: OutboundMessage;
  /** resolves to an error to show inline when the message was not approved */
  onApprove: (body: string, subject?: string) => Promise<string | undefined>;
  /**
   * Close the editor. An edited draft keeps the edits and offers Undo changes in a toast. `kept` says whether the draft still
   * holds the student's own words afterwards, so a page can drop a draft nobody wrote anything in.
   */
  onCancel?: (r: { kept: boolean }) => void;
  busy?: boolean;
  approveLabel?: string;
  /** opened by the student's own click or key press: the cursor goes into the message, where the keyboard was */
  focusOnOpen?: boolean;
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
  // the button that opened the editor is gone, so focus would fall back to the page: put it in the message instead
  // (only after a key press: a tap on a phone would pop the keyboard up over the draft the student wants to read)
  useEffect(() => {
    if (!focusOnOpen || lastInput !== 'keyboard') return;
    (document.getElementById(bodyId) as HTMLTextAreaElement | null)?.focus({ preventScroll: true });
  }, [focusOnOpen, bodyId]);
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
  // a second favour asked of the same person while the first is still waiting (a referral ask and an intro ask)
  const otherAsk = useLiveQuery(
    () =>
      ASK_KINDS.has(draft.kind)
        ? db.outbound
            .where('personId')
            .equals(draft.personId)
            .filter(
              (o) =>
                o.id !== draft.id &&
                ASK_KINDS.has(o.kind) &&
                (['draft', 'queued', 'handed_off'].includes(o.status) ||
                  (o.status === 'sent' &&
                    !!o.sentAt &&
                    Date.now() - new Date(o.sentAt).getTime() < 3 * 86_400_000)),
            )
            .first()
        : undefined,
    [draft.id, draft.personId, draft.kind],
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
  const [confirmingRedraft, setConfirmingRedraft] = useState(false);
  const [copying, setCopying] = useState(false);
  // edits are kept as they are typed, so leaving the page (to check LinkedIn) and coming back loses nothing; the
  // latest text is also written when the editor closes, so a change made just before leaving is never dropped
  const latest = useRef({ body, subject, draft });
  latest.current = { ...latest.current, body, subject, draft };
  useEffect(() => {
    if (draft.status !== 'draft') return;
    const t = setTimeout(() => saveEdits(draft, body, subject), 400);
    return () => clearTimeout(t);
  }, [body, subject, draft]);
  useEffect(() => {
    const flush = () => {
      const l = latest.current;
      if (l.draft.status === 'draft') saveEdits(l.draft, l.body, l.subject);
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
  const needs = (draft.needsInput ?? []).filter((n): n is PromptNeed => n !== 'post' && n !== 'resume');
  // the message says the resume is attached: Orbit cannot attach files, so the student does it in their mail app
  const attachResume =
    (draft.needsInput ?? []).includes('resume') && !isLinkedIn && /\battached\b/i.test(body);
  const [attached, setAttached] = useState(false);
  const hasPlaceholder = /\[[^\]]{3,}\]/.test(body);
  const missingLine =
    (needs.length > 0 && (hasPlaceholder || !edited)) || issues.some((i) => i.blocking) || !!notAllowed;
  const blocked = missingLine || (attachResume && (!!direct || !attached));
  // Copy text is how a resume goes out with a Gmail-sent message (pasted into Gmail, where the student attaches it),
  // so only the mail-app hand-off waits for "I will attach it"
  const copyBlocked = missingLine || (attachResume && !direct && !attached);
  const shownError = error ?? (draft.status === 'failed' || draft.error ? draft.error : undefined);
  if (['queued', 'sending', 'handed_off', 'sent'].includes(draft.status))
    return <OutboxStatus draft={draft} onClose={onCancel && (() => onCancel({ kept: false }))} />;
  const first = person?.firstName ?? 'them';
  // Copy text is a hand-off like the mail app: the message waits for "I sent it", so a Gmail user can log the send
  const copyAll = async () => {
    if (!user) return;
    // the message alone: a "Subject:" line pasted into the body would go out as its first line. The subject is
    // shown next to the I sent it step with its own Copy button.
    // the clipboard write starts inside the click; browsers drop clipboard access after a long async gap
    const copied = copyText(body);
    setCopying(true);
    setError(undefined);
    try {
      const r = await approveAndSend(user, draft.id, body, subject || undefined, new Date(), { via: 'copy' });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // the line under the message says what to do next; a toast repeating it would only cover the page
      if (!(await copied))
        toast.push({
          text: 'Select the text in the box and copy it, send it from Gmail, then press I sent it.',
          ttl: 8000,
        });
    } finally {
      setCopying(false);
    }
  };
  const dirty = body !== opened.body || subject !== opened.subject;
  const close = () => {
    saveEdits(draft, body, subject);
    onCancel?.({ kept: true });
  };
  // Close keeps what was typed (it is saved as it is typed anyway) and offers to undo the edits, rather than asking a
  // question whose obvious answer is "keep them"
  const cancel = () => {
    if (!dirty) {
      onCancel?.({ kept: !!draft.bodyFinal });
      return;
    }
    close();
    toast.push({
      text: 'Your changes are kept in the draft.',
      action: {
        label: 'Undo changes',
        // written as is: the draft held in this closure still has the text from before, so a diff would skip it
        onClick: () =>
          db.outbound
            .where('id')
            .equals(draft.id)
            .filter((m) => m.status === 'draft')
            .modify({
              bodyFinal: opened.body.trim() === draft.bodyDraft.trim() ? undefined : opened.body,
              subject: opened.subject || undefined,
            }),
      },
      ttl: 8000,
    });
  };
  const defaultLabel = isLinkedIn
    ? connectionNote
      ? 'Copy note & open LinkedIn'
      : 'Copy & open LinkedIn'
    : direct
      ? `Send to ${first}`
      : `Open email to ${first}`;
  const canRegenerate = needs.every(
    (n) => (inputs[n] ?? '').trim().length >= (n === 'mutual' ? 2 : n === 'role' ? 4 : 8),
  );
  // the student's edits survive a redraft: the missing line drops into the gap in their own text, and when there is
  // no gap left to fill (they rewrote that part) Orbit asks before it rewrites the message
  const keepsMine = edited && needs.length === 1 && needs[0] === 'connection' && WHY_THEM_GAP.test(body);
  const regenerate = async (force = false) => {
    if (!user) return;
    if (edited && !keepsMine && !force) {
      setConfirmingRedraft(true);
      return;
    }
    setConfirmingRedraft(false);
    setRegenerating(true);
    const before = {
      bodyDraft: draft.bodyDraft,
      bodyFinal: edited ? body : undefined,
      subject: subject || undefined,
      needsInput: draft.needsInput,
      opening: draft.opening,
      claims: draft.claims,
    };
    // what was typed a moment ago is stored first, so the redraft starts from the student's latest words
    await saveEdits(draft, body, subject);
    const given = Object.fromEntries(needs.map((n) => [n, inputs[n]?.trim()]).filter(([, v]) => v));
    const done = await regenerateDraft(user, draft.id, given, new Date(), {
      mine: keepsMine ? body : undefined,
    });
    setRegenerating(false);
    if (!done) {
      setError('Orbit could not redraft this message. Your text is unchanged.');
      return;
    }
    setInputs({});
    toast.push({
      text: keepsMine ? 'Added your line to your message.' : 'Redrafted with your line.',
      action: {
        label: 'Undo',
        onClick: () =>
          db.outbound
            .where('id')
            .equals(draft.id)
            .filter((m) => m.status === 'draft')
            .modify(before),
      },
      ttl: 8000,
    });
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
              <div className="text-ink-3 text-[12px] mb-1.5" data-testid={`draft-input-hint-${n}`}>
                {edited && !hasPlaceholder
                  ? 'You wrote it into the message yourself, so the send buttons are on. Or type it here and Orbit redrafts around it.'
                  : INPUT_PROMPT[n].hint}
              </div>
              <Input
                value={inputs[n] ?? ''}
                onChange={(e) => setInputs((v) => ({ ...v, [n]: e.target.value }))}
                placeholder={INPUT_PROMPT[n].placeholder}
                aria-label={INPUT_PROMPT[n].label}
                data-testid={`draft-input-${n}`}
              />
            </div>
          ))}
          {confirmingRedraft ? (
            <div className="mt-2" role="alertdialog" aria-label="Rewrite your edited message?">
              <p className="text-[12.5px]" data-testid="draft-redraft-confirm">
                You have edited this message. Redrafting rewrites all of it, so your edits go. To keep them,
                write the line into the message yourself instead.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="primary" onClick={() => setConfirmingRedraft(false)}>
                  Keep my text
                </Button>
                <Button size="sm" onClick={() => regenerate(true)} data-testid="draft-redraft-anyway">
                  Redraft anyway
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              <Button
                variant="primary"
                size="sm"
                disabled={!canRegenerate || regenerating}
                onClick={() => regenerate()}
                data-testid="draft-redraft"
              >
                {regenerating ? 'Adding…' : keepsMine ? 'Add to my message' : 'Redraft with this'}
              </Button>
              <span className="text-[12px] text-ink-3">
                {keepsMine
                  ? 'It goes where the bracketed line is. The rest of your text stays.'
                  : 'or edit the bracketed line yourself below.'}
              </span>
            </div>
          )}
        </div>
      )}
      {attachResume && (
        <div
          className="mb-3 rounded-lg border border-warn/40 bg-warn/5 p-3 text-[13px]"
          data-testid="draft-attach-resume"
        >
          <div className="font-medium">Attach your resume</div>
          <div className="text-ink-3 text-[12px] mb-1.5">
            {direct
              ? 'The message says your resume is attached, and Orbit cannot attach files. Copy the text into Gmail and attach it there.'
              : 'The message says your resume is attached. Orbit cannot attach files, so add it in your mail app before you send.'}
          </div>
          {!direct && (
            <label className="inline-flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={attached}
                onChange={(e) => setAttached(e.target.checked)}
                data-testid="draft-attach-confirm"
              />
              I will attach it before sending
            </label>
          )}
        </div>
      )}
      {draft.holdUntil && new Date(draft.holdUntil).getTime() > Date.now() && (
        <div className="text-[12px] text-warn mb-1.5" data-testid="draft-hold">
          Your last note to {person?.firstName ?? 'them'} went out only a few days ago. Wait until{' '}
          {new Date(draft.holdUntil).toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'short',
            day: 'numeric',
            timeZone: user?.timezone,
          })}{' '}
          to send this one.
        </div>
      )}
      {!isLinkedIn && (
        <div className="text-[12px] text-ink-3 mb-1.5 truncate" data-testid="draft-to">
          To: {person?.displayName ?? 'them'}
          {draft.toEmail
            ? ` <${person?.primaryEmail === draft.toEmail ? (person.primaryEmailAsWritten ?? draft.toEmail) : draft.toEmail}>`
            : ''}
          {draft.bccEmails?.length ? ` · Bcc: ${draft.bccEmails.join(', ')}` : ''}
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
            ? `Connection note. You are not connected to ${person?.firstName ?? 'them'} yet, so this goes with your connection request. A free LinkedIn account allows ${LINKEDIN_NOTE_TARGET} characters (Premium allows ${LINKEDIN_NOTE_MAX}).`
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
          <span
            className={cx(
              'tabular',
              connectionNote && body.length > LINKEDIN_NOTE_MAX
                ? 'text-bad'
                : connectionNote && body.length > LINKEDIN_NOTE_TARGET && 'text-warn',
            )}
            data-testid="draft-char-count"
          >
            {connectionNote
              ? body.length > LINKEDIN_NOTE_MAX
                ? `${body.length} / ${LINKEDIN_NOTE_MAX} characters. Too long for LinkedIn, trim it`
                : body.length > LINKEDIN_NOTE_TARGET
                  ? `${body.length} / ${LINKEDIN_NOTE_TARGET} characters. A free account cuts the rest, so trim it unless you have Premium`
                  : `${body.length} / ${LINKEDIN_NOTE_TARGET} characters`
              : `${body.length} characters`}
          </span>
        )}
        <span>
          {edited
            ? 'Edited by you'
            : draft.generatedBy === 'llm'
              ? 'Drafted with Claude'
              : 'Drafted by Orbit'}
        </span>
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
              Close
            </Button>
          )}
          {!isLinkedIn && (!direct || attachResume) && !approveLabel && (
            <Button
              size="sm"
              onClick={copyAll}
              disabled={busy || copying || !body.trim() || copyBlocked}
              title={
                missingLine
                  ? (notAllowed ?? issues.find((i) => i.blocking)?.text ?? 'Add the missing line first')
                  : copyBlocked
                    ? 'Confirm you will attach your resume first'
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
              (attachResume && direct
                ? 'Orbit cannot attach your resume. Copy the text into Gmail instead.'
                : attachResume && !attached
                  ? 'Confirm you will attach your resume first'
                  : blocked
                    ? 'Add the missing line first'
                    : undefined)
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
          Opens your mail app with the email to {first}. Gmail in the browser? Use Copy text.
        </p>
      )}
      {!edited && draft.claims?.some((c) => c.factId) && ['thank_you', 'nurture'].includes(draft.kind) && (
        <p className="mt-1.5 text-[12px] text-ink-3" data-testid="draft-from-notes">
          Parts of this come from your notes. Read it once as {first} will: names, short forms and who "she"
          or "he" is.
        </p>
      )}
      {otherAsk && (
        <p className="mt-1.5 text-[12px] text-warn" data-testid="draft-other-ask">
          You {otherAsk.status === 'sent' ? 'just sent' : 'also have'} {first} a{' '}
          {MESSAGE_KIND_LABELS[otherAsk.kind].toLowerCase()}
          {otherAsk.status === 'sent' ? '' : ' waiting'}. Two favours at once is a lot to ask: send one, and
          the other a few days after they answer.
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
function saveEdits(draft: OutboundMessage, body: string, subject: string): Promise<unknown> {
  const changedBody = body !== (draft.bodyFinal ?? draft.bodyDraft);
  const changedSubject = subject !== (draft.subject ?? '');
  if (!changedBody && !changedSubject) return Promise.resolve();
  return db.outbound
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
    // on a phone the words say tap, not click
    const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
    line =
      draft.handoffVia === 'copy'
        ? draft.externalThreadId
          ? `Copied. In Gmail, open your thread "${draft.subject?.replace(/^re:\s*/i, '') ?? 'with them'}" with ${name}, reply with the text, then press I sent it.`
          : `Copied. In Gmail, start a new email to ${person?.primaryEmail ?? name}, paste the message, add the subject below, send it, then press I sent it.`
        : draft.channel === 'gmail'
          ? draft.externalThreadId
            ? `Opened in your mail app as a new email to ${name}. Send it there, then press I sent it. Nothing opened? Copy the text into Gmail.`
            : `Opened in your mail app, addressed to ${name}. Send it there, then press I sent it. Nothing opened? Copy the text into Gmail.`
          : link?.via === 'linkedin_connect'
            ? `On ${name}'s LinkedIn profile, ${coarse ? 'tap' : 'click'} Connect, then Add a note, and paste the note. In the LinkedIn phone app, tap More, then Personalize invite, so the request does not go out without it. Press I sent it once the request is out.`
            : `Paste the message into LinkedIn and send it to ${name}, then press I sent it.`;
    actions = (
      <>
        <Button
          size="sm"
          variant="primary"
          disabled={working}
          onClick={() =>
            act(async () => {
              // a tap before the message really went out can be taken back: everything it changed is put back
              const before = await snapshotPerson(user.id, draft.personId);
              const r = await confirmHandoff(user, draft.id);
              toast.push(
                r.ok
                  ? {
                      text: r.scheduledAt
                        ? `Logged as sent. Your chat with ${name} is booked for ${new Date(r.scheduledAt).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}, under Coming up on Today.`
                        : `Logged as sent to ${name}.`,
                      tone: 'good',
                      ttl: 8000,
                      action: {
                        label: 'Undo',
                        onClick: async () => {
                          await restorePerson(user.id, before);
                          toast.push({
                            text: `Not sent after all. The message to ${name} is waiting again.`,
                          });
                        },
                      },
                    }
                  : { text: r.error, tone: 'bad' },
              );
            })
          }
        >
          I sent it to {name}
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
              text: (await copyText(text))
                ? draft.channel === 'gmail'
                  ? `Copied the message. Paste it into the email to ${person?.primaryEmail ?? name}.`
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
      {draft.status === 'handed_off' &&
        draft.channel === 'gmail' &&
        draft.subject &&
        !(draft.handoffVia === 'copy' && draft.externalThreadId) && (
          <div
            className="mt-1.5 flex items-center gap-2 text-[12.5px] text-ink-3"
            data-testid="handoff-subject"
          >
            <span className="min-w-0 truncate">Subject: {draft.subject}</span>
            <button
              type="button"
              className="shrink-0 underline underline-offset-2 hover:text-ink"
              onClick={async () =>
                toast.push({
                  text: (await copyText(draft.subject ?? ''))
                    ? 'Copied the subject.'
                    : 'Select the subject and copy it.',
                })
              }
            >
              Copy subject
            </button>
          </div>
        )}
      <div className="mt-2 flex items-center gap-2 flex-wrap text-[13px]">
        <span className="font-medium mr-auto" aria-live="polite">
          {line}
        </span>
        {actions}
      </div>
    </div>
  );
}
