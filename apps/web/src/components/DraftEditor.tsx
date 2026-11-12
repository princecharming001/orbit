import type { DraftNeed, OutboundMessage, Person } from '@orbit/core';
import {
  LINKEDIN_NOTE_MAX,
  LINKEDIN_NOTE_TARGET,
  MAX_WORDS,
  MESSAGE_KIND_LABELS,
  placeholderIn,
  plainWhyThem,
  researchLine,
  suggestedWhyThem,
  WHY_THEM,
  WHY_THEM_GAP,
  wordsIn,
} from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { db } from '../db/schema';
import { defaultFollowUp, followUpFor, saveFollowUp } from '../engine/afterAccept';
import { regenerateDraft } from '../engine/brief';
import { researchOpeners } from '../engine/deepResearch';
import { restoreDraftText, saveDraftEdits as saveEdits } from '../engine/drafts';
import { enableGmailSend } from '../engine/integrations';
import { linkedInSendActive } from '../engine/linkedinLive';
import {
  approveAndSend,
  canSendFromOrbit,
  checkSendAllowed,
  confirmHandoff,
  type DraftIssue,
  draftEnvelope,
  emailSendsFromOrbit,
  handoffLink,
  isConnectionNote,
  openInMessages,
  pendingNoteFor,
  restorePerson,
  revertHandoff,
  reviewDraft,
  sendHandedOffFromOrbit,
  snapshotPerson,
  undoQueued,
  withNote,
  withoutNote,
} from '../engine/send';
import { useSources } from '../engine/sources';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { googleClientId } from '../integrations/google';
import { useSession } from '../state/session';
import { Avatar, Button, cx, Input, relDate, Textarea, useToast } from '../ui';
import { copyText, handoffToast, openHandoff, runApproval } from './approve';
import { DraftFiles } from './DraftFiles';
import { ForwardNote } from './ForwardNote';
import { HistoryPeek, ThreadContext } from './ThreadContext';

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

/** The chat's compact editor: a short label beside the field. */
const COMPACT_LABEL: Record<PromptNeed, string> = {
  connection: WHY_THEM,
  update: 'Your update',
  news: 'Congrats on',
  target: 'Intro to',
  answer: 'Your answer',
  role: 'Role',
  mutual: 'Who you both know',
  posting: 'Posting',
  takeaway: 'What stuck',
};

/** The tallest the chat's editor grows before it scrolls, so a long email does not fill the screen. */
const COMPACT_MAX_HEIGHT = 232;

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
  compact,
  extraActions,
  thread,
}: {
  draft: OutboundMessage;
  /** what was said before, above the message (where nothing else on screen quotes it: a person's page, the chat) */
  thread?: boolean;
  /**
   * The chat's card: the missing line as one row, the message box capped in height, and at most one status line
   * (the most urgent; the rest one tap away). The pages keep the full editor.
   */
  compact?: boolean;
  /** more buttons beside the approve button (the chat's approval card puts Cancel there) */
  extraActions?: ReactNode;
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
  const [body, setBody] = useState(() => withoutNote(draft.bodyFinal ?? draft.bodyDraft, draft.forwardNote));
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
    const full = el.scrollHeight + 2;
    // the chat's card stops growing at a sensible height and scrolls inside; the pages show the whole draft
    const cap = compact ? COMPACT_MAX_HEIGHT : Number.POSITIVE_INFINITY;
    el.style.height = `${Math.min(full, cap)}px`;
    el.style.overflowY = full > cap ? 'auto' : 'hidden';
  }, [body, bodyId, draft.status, compact]);
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
  const [enabling, setEnabling] = useState(false);
  // whether approving sends from Orbit (Google connected with send permission, or LinkedIn connected live) or opens
  // the mail app or LinkedIn for the student to send it there
  const direct = useLiveQuery(
    async () =>
      !user
        ? false
        : draft.channel === 'gmail'
          ? emailSendsFromOrbit(user, draft)
          : draft.channel === 'linkedin'
            ? linkedInSendActive(user, person ?? undefined, draft.id)
            : false,
    [user?.id, draft.id, draft.channel, person?.linkedinMemberId, person?.linkedinSlug],
  );
  // email that would open the mail app, in a copy of Orbit that can sign in to Google (never the made-up demo student)
  const canEnableSend =
    draft.channel === 'gmail' &&
    direct === false &&
    !!user &&
    !!googleClientId() &&
    !usesMockConnectors(user.id);
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
    setBody(withoutNote(draft.bodyFinal ?? draft.bodyDraft, draft.forwardNote));
    setSubject(draft.subject ?? '');
  }, [draft.id, draft.bodyDraft]);
  // what the editor showed when it opened, so Cancel knows whether anything changed since
  const [opened] = useState(() => ({
    body: withoutNote(draft.bodyFinal ?? draft.bodyDraft, draft.forwardNote),
    subject: draft.subject ?? '',
  }));
  const [confirmingRedraft, setConfirmingRedraft] = useState(false);
  const [showAllLines, setShowAllLines] = useState(false);
  const [copying, setCopying] = useState(false);
  const [texting, setTexting] = useState(false);
  // texting is a way to send once the owner offers Texts and Orbit has their number (plan 43 §6)
  const sources = useSources(user?.id);
  const canText =
    !!person?.phones?.length && !!sources?.offered.includes('imessage') && draft.channel !== 'imessage';
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
  // the line Orbit can stand behind (from their LinkedIn headline, else their company), already in the box
  const whyThem =
    needs.includes('connection') && person
      ? suggestedWhyThem({
          headline: person.headline,
          title: person.currentTitle,
          org: person.currentOrganizationRaw,
        })
      : undefined;
  // the opening line Orbit writes without research: their headline or company, else the plain one
  const ownLine =
    suggestedWhyThem({
      headline: person?.headline,
      title: person?.currentTitle,
      org: person?.currentOrganizationRaw,
    }) ?? plainWhyThem();
  const prefilled = useRef(false);
  useEffect(() => {
    if (!whyThem || prefilled.current) return;
    prefilled.current = true;
    setInputs((v) => (v.connection ? v : { ...v, connection: whyThem }));
  }, [whyThem]);
  // the message says a file is attached: Orbit attaches it when it sends, and the mail app gets it from the student
  const mentionsFile = !isLinkedIn && /\battached\b/i.test(body);
  const fileCount = draft.attachments?.length ?? 0;
  const [attached, setAttached] = useState(false);
  const hasPlaceholder = !!placeholderIn(body);
  const missingLine =
    (needs.length > 0 && (hasPlaceholder || !edited)) || issues.some((i) => i.blocking) || !!notAllowed;
  const fileMissing = mentionsFile && !fileCount && (direct ? true : !attached);
  const blocked = missingLine || fileMissing;
  // Copy text is how a resume goes out with a Gmail-sent message (pasted into Gmail, where the student attaches it),
  // so only the mail-app hand-off waits for "I will attach it"
  const copyBlocked = missingLine || (mentionsFile && !direct && !attached);
  const shownError = error ?? (draft.status === 'failed' || draft.error ? draft.error : undefined);
  if (['queued', 'sending', 'handed_off', 'sent'].includes(draft.status))
    return (
      <OutboxStatus draft={draft} onClose={onCancel && (() => onCancel({ kept: false }))} compact={compact} />
    );
  const first = person?.firstName ?? 'them';
  // Copy text is a hand-off like the mail app: the message waits for "I sent it", so a Gmail user can log the send
  const copyAll = async () => {
    if (!user) return;
    // the message alone: a "Subject:" line pasted into the body would go out as its first line. The subject is
    // shown next to the I sent it step with its own Copy button.
    // the clipboard write starts inside the click; browsers drop clipboard access after a long async gap
    const copied = copyText(draft.kind === 'intro_request' ? withNote(body, draft.forwardNote) : body);
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
        onClick: () => restoreDraftText(draft, opened),
      },
      ttl: 8000,
    });
  };
  const defaultLabel = isLinkedIn
    ? direct
      ? connectionNote
        ? `Send request to ${first}`
        : `Send to ${first}`
      : connectionNote
        ? 'Copy note & open LinkedIn'
        : 'Copy & open LinkedIn'
    : draft.channel === 'imessage'
      ? `Open in Messages to ${first}`
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
    let done: Awaited<ReturnType<typeof regenerateDraft>> | undefined;
    try {
      // what was typed a moment ago is stored first, so the redraft starts from the student's latest words
      await saveEdits(draft, body, subject);
      const given = Object.fromEntries(needs.map((n) => [n, inputs[n]?.trim()]).filter(([, v]) => v));
      // a redraft that throws reads as one that failed, so the button never stays on "Adding…"
      done = await regenerateDraft(user, draft.id, given, new Date(), {
        mine: keepsMine ? body : undefined,
      }).catch(() => undefined);
    } catch {
      // the save before it failed: nothing was redrafted, and the message below says so
      done = undefined;
    } finally {
      setRegenerating(false);
    }
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
  const copyButton = !isLinkedIn && draft.channel !== 'imessage' && !direct && !approveLabel && (
    <Button
      size="sm"
      onClick={copyAll}
      disabled={busy || copying || !body.trim() || copyBlocked}
      title={
        missingLine
          ? (notAllowed ?? issues.find((i) => i.blocking)?.text ?? 'Add the missing line first')
          : copyBlocked
            ? 'Confirm you will attach the file first'
            : 'Copy the message to paste into Gmail in your browser'
      }
      data-testid="draft-copy"
    >
      Copy text
    </Button>
  );
  // plan 43 §6: someone with a phone number can be texted instead. Messages opens with the draft written, and the
  // message waits for "I sent it" like any hand-off
  const handoffButton = canText && !approveLabel && (
    <Button
      size="sm"
      disabled={busy || texting || !body.trim() || missingLine}
      title={
        missingLine
          ? (notAllowed ?? issues.find((i) => i.blocking)?.text ?? 'Add the missing line first')
          : `Open Messages with this written to ${first}`
      }
      onClick={async () => {
        if (!user) return;
        setError(undefined);
        setTexting(true);
        try {
          const r = await openInMessages(user, draft.id, body);
          if (!r.ok) setError(r.error);
          else if (r.status === 'handed_off' && openHandoff(r.handoffUrl))
            toast.push({ text: handoffToast('sms', false, false), tone: 'good', ttl: 8000 });
        } finally {
          setTexting(false);
        }
      }}
      data-testid="draft-messages"
    >
      Open in Messages
    </Button>
  );
  const primaryButton = (
    <Button
      variant="primary"
      size="sm"
      disabled={busy || !body.trim() || blocked}
      title={
        notAllowed ??
        issues.find((i) => i.blocking)?.text ??
        (fileMissing
          ? direct
            ? 'It says a file is attached: attach it first'
            : 'Confirm you will attach the file first'
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
  );
  if (compact) {
    // one status line: the most urgent of what the full editor lists one under another
    const lines: { key: string; tone: 'bad' | 'warn' | 'muted'; node: ReactNode; testId?: string }[] = [];
    if (shownError) lines.push({ key: 'error', tone: 'bad', node: `Not sent: ${shownError}` });
    if (notAllowed && notAllowed !== shownError)
      lines.push({ key: 'rules', tone: 'bad', node: `Can't send this yet: ${notAllowed}` });
    for (const i of issues) {
      // the missing-line row above already says the bracketed line has to go
      if (needs.length > 0 && i.code === 'placeholder') continue;
      const fix = i.blocking || (blocked && i.code === 'placeholder');
      // only what holds Send back is said: a suggestion under every draft was noise
      if (!fix) continue;
      lines.push({
        key: `${i.code}:${i.text}`,
        tone: fix ? 'bad' : 'warn',
        node: `${fix ? 'Fix before sending: ' : 'Worth a look: '}${i.text}`,
        testId: 'draft-issues',
      });
    }
    if (draft.holdUntil && new Date(draft.holdUntil).getTime() > Date.now())
      lines.push({
        key: 'hold',
        tone: 'warn',
        testId: 'draft-hold',
        node: `You wrote to ${first} a few days ago. Wait until ${new Date(
          draft.holdUntil,
        ).toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'short',
          day: 'numeric',
          timeZone: user?.timezone,
        })} to send this.`,
      });
    if (otherAsk)
      lines.push({
        key: 'ask',
        tone: 'warn',
        testId: 'draft-other-ask',
        node: `You ${otherAsk.status === 'sent' ? 'just sent' : 'also have'} ${first} a ${MESSAGE_KIND_LABELS[
          otherAsk.kind
        ].toLowerCase()}${otherAsk.status === 'sent' ? '' : ' waiting'}. Send one, the other after they answer.`,
      });
    if (canEnableSend)
      lines.push({
        key: 'gmail',
        tone: 'muted',
        testId: 'draft-enable-send',
        node: (
          <>
            Send from Orbit instead of your mail app?{' '}
            <button
              type="button"
              className="text-accent font-medium hover:underline disabled:opacity-50"
              disabled={enabling}
              onClick={async () => {
                if (!user) return;
                setEnabling(true);
                const r = await enableGmailSend(user);
                setEnabling(false);
                if (r.ok)
                  toast.push({
                    text: 'Orbit can send email for you now. Each one still waits a few seconds so you can undo.',
                    tone: 'good',
                  });
                else setError(r.message);
              }}
              data-testid="draft-enable-send-button"
            >
              {enabling ? 'Waiting for Google…' : 'Connect Gmail'}
            </button>
          </>
        ),
      });
    const rank = { bad: 0, warn: 1, muted: 2 };
    lines.sort((a, b) => rank[a.tone] - rank[b.tone]);
    const shownLines = showAllLines ? lines : lines.slice(0, 1);
    const note = isLinkedIn && connectionNote;
    return (
      <div className="text-[13.5px]">
        {thread && user && (
          <ThreadContext userId={user.id} personId={draft.personId} firstName={first} className="mb-2" />
        )}
        {needs.length > 0 && (
          <div className="mb-3 border-l-2 border-warn pl-3 py-0.5" data-testid="draft-needs-input">
            {needs.map((n) => (
              <div key={n} className="flex items-center gap-2 mb-1.5 last:mb-0">
                <label
                  htmlFor={`need-${draft.id}-${n}`}
                  className="text-[12.5px] font-medium text-ink shrink-0"
                >
                  {COMPACT_LABEL[n]}
                </label>
                <Input
                  id={`need-${draft.id}-${n}`}
                  className="!h-8 !text-[13px] min-w-0 flex-1"
                  value={inputs[n] ?? ''}
                  onChange={(e) => setInputs((v) => ({ ...v, [n]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canRegenerate && !regenerating) {
                      e.preventDefault();
                      void regenerate();
                    }
                  }}
                  placeholder={INPUT_PROMPT[n].placeholder}
                  aria-label={INPUT_PROMPT[n].label}
                  data-testid={`draft-input-${n}`}
                />
                {n === needs[needs.length - 1] && !confirmingRedraft && (
                  <Button
                    variant="primary"
                    size="sm"
                    className="shrink-0"
                    disabled={!canRegenerate || regenerating}
                    onClick={() => regenerate()}
                    data-testid="draft-redraft"
                  >
                    {regenerating ? 'Adding…' : keepsMine ? 'Add to my message' : 'Redraft'}
                  </Button>
                )}
              </div>
            ))}
            {confirmingRedraft ? (
              <div className="mt-1.5" role="alertdialog" aria-label="Rewrite your edited message?">
                <p className="text-[12px]" data-testid="draft-redraft-confirm">
                  Redrafting rewrites your edited message. To keep your words, write the line in yourself.
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Button size="sm" variant="primary" onClick={() => setConfirmingRedraft(false)}>
                    Keep my text
                  </Button>
                  <Button size="sm" onClick={() => regenerate(true)} data-testid="draft-redraft-anyway">
                    Redraft anyway
                  </Button>
                </div>
              </div>
            ) : (
              edited &&
              !hasPlaceholder && (
                <p className="text-[12px] text-ink-3 mt-1.5" data-testid={`draft-input-hint-${needs[0]}`}>
                  You wrote it in yourself, so it can go. Or add it here and Orbit fits it in.
                </p>
              )
            )}
          </div>
        )}
        {!isLinkedIn && !!draft.bccEmails?.length && (
          <div className="text-[12px] text-ink-3 mb-1 truncate" data-testid="draft-bcc">
            Bcc: {draft.bccEmails.join(', ')}
          </div>
        )}
        {/* an email reads as the email it will be: To, Subject, the words, hairlines between, no box in a box */}
        {!isLinkedIn && (
          <div className="divide-y divide-line-2 border-y border-line-2 -mx-1" data-testid="draft-mail">
            <div className="flex items-center gap-3 px-1 py-2">
              <span className="w-14 shrink-0 text-[12.5px] text-ink-3">To</span>
              <span className="flex min-w-0 items-center gap-2 text-[13.5px]" data-testid="draft-mail-to">
                {person && (
                  <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={22} />
                )}
                <span className="truncate">{draft.toEmail ?? person?.primaryEmail ?? first}</span>
              </span>
            </div>
            {!envelope.threaded && (
              <div className="flex items-center gap-3 px-1 py-1">
                <label htmlFor={`subject-${draft.id}`} className="w-14 shrink-0 text-[12.5px] text-ink-3">
                  Subject
                </label>
                <Input
                  id={`subject-${draft.id}`}
                  className="!h-8 !text-[13.5px] !border-transparent !bg-transparent !px-0 focus:!ring-0 hover:!bg-canvas-2/60 focus:!bg-canvas-2/60 focus:!px-2"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Subject"
                />
              </div>
            )}
            <Textarea
              id={bodyId}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={7}
              className="resize-y !rounded-none !border-0 !bg-transparent !text-[14px] !leading-[1.65] !px-1 !py-3 focus:!ring-0"
              aria-label="Message body"
            />
          </div>
        )}
        {isLinkedIn && note && (
          <AfterAcceptSteps
            draft={draft}
            person={person ?? undefined}
            first={first}
            body={body}
            setBody={setBody}
            bodyId={bodyId}
          />
        )}
        {isLinkedIn && !note && (
          <Textarea
            id={bodyId}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            className="resize-y !text-[14px] !leading-[1.65] !px-3 !py-2.5"
            aria-label="Message body"
          />
        )}
        <ResearchChip personId={draft.personId} body={body} setBody={setBody} fallback={ownLine} />
        <ForwardNote draft={draft} introducer={first} />
        {user && (
          <DraftFiles
            draft={draft}
            userId={user.id}
            direct={!!direct}
            mentionsFile={mentionsFile}
            confirmed={attached}
            onConfirm={setAttached}
            className="mt-2.5"
          />
        )}
        <div className="mt-3 flex items-center gap-x-2 gap-y-1.5 flex-wrap text-[12px] text-ink-3">
          <span className="flex items-center gap-2 min-w-0 mr-auto">
            {!isLinkedIn && direct && user?.email && (
              <span className="truncate" data-testid="draft-sends-from">
                Sends from {user.email}
              </span>
            )}
            {note && (
              <span
                className={cx(
                  'tabular',
                  body.length > LINKEDIN_NOTE_MAX
                    ? 'text-bad'
                    : body.length > LINKEDIN_NOTE_TARGET && 'text-warn',
                )}
                title={
                  body.length > LINKEDIN_NOTE_MAX
                    ? 'Too long for LinkedIn: trim it'
                    : body.length > LINKEDIN_NOTE_TARGET
                      ? 'A free LinkedIn account cuts the rest: trim it unless you have Premium'
                      : 'Goes with your connection request'
                }
                data-testid="draft-char-count"
              >
                Connection note · {body.length}/{LINKEDIN_NOTE_TARGET}
              </span>
            )}
            {wc > max && (
              <span className="tabular text-warn" data-testid="draft-word-count">
                {wc} words, aim for {max}
              </span>
            )}
            {edited && (
              <button
                type="button"
                className="underline underline-offset-2 hover:text-ink"
                title="Back to the suggested text"
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
                Reset
              </button>
            )}
          </span>
          <span className="ml-auto flex flex-wrap justify-end gap-1.5">
            {extraActions}
            {copyButton}
            {handoffButton}
            {primaryButton}
          </span>
        </div>
        {shownLines.length > 0 && (
          <ul className="mt-2.5 space-y-1 text-[12px]">
            {shownLines.map((l, i) => (
              <li
                key={l.key}
                className={cx(
                  'flex items-start gap-1.5',
                  l.tone === 'bad' ? 'text-bad' : l.tone === 'warn' ? 'text-warn' : 'text-ink-3',
                )}
                data-testid={l.testId}
              >
                <span className="min-w-0">{l.node}</span>
                {i === 0 && lines.length > 1 && !showAllLines && (
                  <button
                    type="button"
                    className="shrink-0 text-ink-3 underline underline-offset-2 hover:text-ink"
                    onClick={() => setShowAllLines(true)}
                    data-testid="draft-more-notes"
                  >
                    +{lines.length - 1} more
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
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
              {keepsMine && (
                <span className="text-[12px] text-ink-3">
                  It goes where the bracketed line is. The rest of your text stays.
                </span>
              )}
            </div>
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
      {/* who it goes to is the card it sits on; only a Bcc is worth a line */}
      {!isLinkedIn && !!draft.bccEmails?.length && (
        <div className="text-[12px] text-ink-3 mb-1.5 truncate" data-testid="draft-bcc">
          Bcc: {draft.bccEmails.join(', ')}
        </div>
      )}
      {/* the letter: who, what about and the words on hairlines, the files under them; the conversation behind it
          waits under a mark in the To line, shown on hover */}
      <div className="border-y border-line-2" data-testid="draft-sheet">
        {/* who it goes to: a line only where the editor stands alone (a card names its person already) */}
        {thread && (
          <div className="flex items-center gap-3 border-b border-line-2 py-2 text-[14px] leading-none">
            <span className="w-[62px] shrink-0 text-[13px] text-ink-3">To</span>
            <span className="min-w-0 flex-1 truncate" data-testid="draft-to">
              {isLinkedIn
                ? `${person?.displayName ?? first} on LinkedIn`
                : (draft.toEmail ?? person?.primaryEmail ?? first)}
            </span>
            {user && <HistoryPeek userId={user.id} personId={draft.personId} firstName={first} />}
          </div>
        )}
        {!isLinkedIn && !envelope.threaded && (
          <div className="flex items-center gap-3 border-b border-line-2 py-1 text-[14px]">
            <label htmlFor={`subject-${draft.id}`} className="w-[62px] shrink-0 text-[13px] text-ink-3">
              Subject
            </label>
            <input
              id={`subject-${draft.id}`}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className="min-w-0 flex-1 h-9 bg-transparent font-medium outline-none placeholder:text-ink-3"
            />
          </div>
        )}
        <textarea
          id={bodyId}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          className="block w-full resize-none overflow-hidden bg-transparent py-3.5 text-[14.5px] leading-[1.7] outline-none"
          aria-label="Message body"
        />
        <ResearchChip personId={draft.personId} body={body} setBody={setBody} fallback={ownLine} />
        <ForwardNote draft={draft} introducer={first} />
        {user && (
          <DraftFiles
            draft={draft}
            userId={user.id}
            direct={!!direct}
            mentionsFile={mentionsFile}
            confirmed={attached}
            onConfirm={setAttached}
            part="list"
            className="pb-2"
          />
        )}
      </div>
      <div className="mt-3 flex items-center gap-3 text-[12px] text-ink-3 flex-wrap">
        {/* Send first, as in Gmail, with the paperclip beside it */}
        <span className="flex items-center gap-2">
          {primaryButton}
          {handoffButton}
          {copyButton}
        </span>
        {user && (
          <DraftFiles
            draft={draft}
            userId={user.id}
            direct={!!direct}
            mentionsFile={mentionsFile}
            confirmed={attached}
            onConfirm={setAttached}
            part="actions"
          />
        )}
        {wc > max && (
          <span className="tabular text-warn" data-testid="draft-word-count">
            {wc} words (aim for {max} or fewer)
          </span>
        )}
        {isLinkedIn && connectionNote && (
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
              : null}
          </span>
        )}
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
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={cancel} className="ml-auto" data-testid="draft-cancel">
            Close
          </Button>
        )}
      </div>
      {canEnableSend && (
        // without send permission the button opens the mail app; one click lets Orbit send it itself
        <p
          className="mt-1.5 text-[12px] text-ink-3 flex flex-wrap items-center gap-x-1.5"
          data-testid="draft-enable-send"
        >
          <span>Send it from Orbit instead of your mail app?</span>
          <button
            type="button"
            className="text-accent font-medium hover:underline disabled:opacity-50"
            disabled={enabling}
            onClick={async () => {
              if (!user) return;
              setEnabling(true);
              const r = await enableGmailSend(user);
              setEnabling(false);
              if (r.ok)
                toast.push({
                  text: 'Orbit can send email for you now. Each one still waits a few seconds so you can undo.',
                  tone: 'good',
                });
              else setError(r.message);
            }}
            data-testid="draft-enable-send-button"
          >
            {enabling ? 'Waiting for Google…' : 'Connect Gmail'}
          </button>
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
      {(shownError ||
        notAllowed ||
        issues.some((i) => i.blocking || (blocked && i.code === 'placeholder'))) && (
        <ul className="mt-2 space-y-1 text-[12.5px]" data-testid="draft-issues">
          {shownError && <li className="text-bad">Not sent: {shownError}</li>}
          {notAllowed && notAllowed !== shownError && (
            <li className="text-bad">Can't send this yet: {notAllowed}</li>
          )}
          {issues
            .filter((i) => i.blocking || (blocked && i.code === 'placeholder'))
            .map((i) => (
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

/** Where a message waiting for "I sent it" went: "opened in LinkedIn", "opened in your mail app", "copied for Gmail". */
export function handoffWhere(o: Pick<OutboundMessage, 'channel' | 'handoffVia'>): string {
  if (o.handoffVia === 'copy') return 'copied to paste into Gmail';
  if (o.channel === 'imessage' || o.handoffVia === 'sms') return 'opened in Messages';
  return o.channel === 'linkedin' ? 'opened in LinkedIn' : 'opened in your mail app';
}

/** A message that left the editor: queued behind the undo window, handed off, sending or sent. */
export function OutboxStatus({
  draft,
  onClose,
  compact,
}: {
  draft: OutboundMessage;
  onClose?: () => void;
  /** the chat's card: two lines of the message and one "again" button (it opens and copies) instead of two */
  compact?: boolean;
}) {
  const { user } = useSession();
  const toast = useToast();
  const person = useLiveQuery(() => db.people.get(draft.personId), [draft.personId]);
  // resolved ahead of the click, so "Open again" opens inside the click and is not treated as a popup
  const link = useLiveQuery(
    async () => (user && draft.status === 'handed_off' ? handoffLink(user, draft.id) : undefined),
    [user?.id, draft.id, draft.status, draft.bodyFinal],
  );
  // Orbit can still send it itself (Gmail with send permission, live LinkedIn), so opening it elsewhere is not final
  const sendable = useLiveQuery(
    async () => (user && draft.status === 'handed_off' ? canSendFromOrbit(user, draft) : false),
    [user?.id, draft.id, draft.status],
  );
  const [now, setNow] = useState(() => Date.now());
  const [working, setWorking] = useState(false);
  useEffect(() => {
    if (draft.status !== 'queued') return;
    // a countdown on screen: nothing to redraw while the tab is hidden
    const t = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1000);
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
          ? `Copied. Reply in your Gmail thread with ${name}, then press I sent it.`
          : `Copied. Paste it into a new email to ${person?.primaryEmail ?? name}, then press I sent it.`
        : draft.channel === 'gmail'
          ? 'Opened in your mail app. Send it there, then press I sent it.'
          : draft.channel === 'imessage'
            ? `Opened in Messages. Send it to ${name} there, then press I sent it. Orbit looks for the answer the next time you update texts.`
            : link?.via === 'linkedin_connect'
              ? `On ${name}'s profile, ${coarse ? 'tap' : 'click'} Connect, then Add a note, and paste it. Then press I sent it.`
              : `Paste it into LinkedIn and send it, then press I sent it.`;
    actions = (
      <>
        {sendable && (
          <Button
            size="sm"
            variant="primary"
            disabled={working}
            onClick={() =>
              act(async () => {
                const r = await sendHandedOffFromOrbit(user, draft.id);
                toast.push(
                  r.ok
                    ? {
                        text:
                          r.status === 'queued' ? `Sending to ${name} in a few seconds.` : `Sent to ${name}.`,
                        tone: 'good',
                      }
                    : { text: r.error, tone: 'bad' },
                );
              })
            }
            data-testid="handoff-send"
          >
            Send from Orbit
          </Button>
        )}
        <Button
          size="sm"
          variant={sendable ? 'secondary' : 'primary'}
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
                        ? `Logged as sent. Your chat with ${name} is booked for ${new Date(r.scheduledAt).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}, under Coming up in Drafts.`
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
              // in the chat this one button also copies the text again, which is what LinkedIn needs pasted
              if (compact && draft.channel === 'linkedin') void copyText(text);
              if (!openHandoff(link.url))
                toast.push({
                  text: 'Your browser blocked the new tab. Allow pop-ups for Orbit and try again.',
                });
            }}
          >
            {compact
              ? 'Open again'
              : link.via === 'mailto'
                ? 'Open mail app again'
                : link.via === 'sms'
                  ? 'Open Messages again'
                  : 'Open LinkedIn again'}
          </Button>
        )}
        {!(compact && link && draft.channel === 'linkedin') && (
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
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={working}
          onClick={() => act(() => revertHandoff(user, draft.id))}
        >
          {compact ? 'Edit' : 'Not sent, edit it'}
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
    <div
      className={cx('rounded-lg border border-line bg-canvas-2', compact ? 'px-3 py-2' : 'p-3')}
      data-testid={`outbox-${draft.status}`}
    >
      <p
        className={cx(
          'text-ink-2 whitespace-pre-line',
          compact ? 'text-[12.5px] line-clamp-2' : 'text-[13px] line-clamp-3',
        )}
      >
        {text}
      </p>
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
      <div
        className={cx(
          'flex items-center flex-wrap',
          compact ? 'mt-1.5 gap-1.5 text-[12.5px]' : 'mt-2 gap-2 text-[13px]',
        )}
      >
        <span className="font-medium mr-auto" aria-live="polite">
          {line}
        </span>
        {actions}
      </div>
      {draft.kind === 'intro_request' && draft.channel === 'linkedin' && (
        <NoteToSend ask={draft} name={name} />
      )}
    </div>
  );
}

/**
 * A LinkedIn intro ask went alone: the note to forward waits as a second message, sent with its own tap (every
 * LinkedIn send is a tap, plan 16 §8.3).
 */
function NoteToSend({ ask, name }: { ask: OutboundMessage; name: string }) {
  const { user } = useSession();
  const toast = useToast();
  const note = useLiveQuery(() => pendingNoteFor(ask), [ask.id, ask.status]);
  const [working, setWorking] = useState(false);
  if (!user || !note || ask.status === 'queued') return null;
  return (
    <div
      className="mt-2 pt-2 border-t border-line flex items-center gap-2 flex-wrap text-[13px]"
      data-testid="note-to-send"
    >
      <span className="mr-auto text-ink-2">The note {name} can forward is ready as a second message.</span>
      <Button
        size="sm"
        variant="primary"
        disabled={working}
        onClick={async () => {
          setWorking(true);
          try {
            const err = await runApproval(user, note, note.bodyDraft, undefined, toast, name);
            if (err) toast.push({ text: err, tone: 'bad' });
          } finally {
            setWorking(false);
          }
        }}
        data-testid="note-to-send-button"
      >
        Send the note to {name}
      </Button>
    </div>
  );
}

/**
 * The draft's line from research (docs/plan/20 §6): when the message opens with the top opener of the brief the
 * student ran on them, a chip says so, "from research [1]", linking to its source. Swap puts in the next opener the
 * support check backed fully, and after the last, the student's own line.
 */
function ResearchChip({
  personId,
  body,
  setBody,
  fallback,
}: {
  personId: string;
  body: string;
  setBody: (b: string) => void;
  /** the opening line without research: from their headline or company, else the plain one */
  fallback: string;
}) {
  const openers = useLiveQuery(() => researchOpeners(personId), [personId]) ?? [];
  const lines = openers.map((o) => researchLine(o.text) ?? o.text);
  const i = lines.findIndex((l) => body.includes(l));
  if (i < 0) return null;
  const o = openers[i]!;
  const next = i + 1 < openers.length ? lines[i + 1]! : undefined;
  // after the last opener, the line Orbit can stand behind without research (never a blank to fill)
  const swap = () => setBody(body.replace(lines[i]!, next ?? fallback));
  return (
    <div
      className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-ink-3"
      data-testid="draft-research-chip"
    >
      {o.url ? (
        <a
          href={o.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center h-6 px-2 rounded-full border border-line hover:text-ink"
          title="The opening line comes from the research brief; this is its source"
        >
          from research [{o.ref}]
        </a>
      ) : (
        <span className="inline-flex items-center h-6 px-2 rounded-full border border-line">
          from research [{o.ref}]
        </span>
      )}
      <button
        type="button"
        className="underline underline-offset-2 hover:text-ink"
        onClick={swap}
        data-testid="draft-research-swap"
      >
        {next ? 'Swap' : 'Write my own'}
      </button>
    </div>
  );
}

/**
 * A connection note and the follow-up after it (the chat's LinkedIn card): step 1 is the note, sent now; step 2 is the
 * ask, kept until they accept, then drafted for a tap (engine/afterAccept.ts). LinkedIn never sends on its own.
 */
function AfterAcceptSteps({
  draft,
  person,
  first,
  body,
  setBody,
  bodyId,
}: {
  draft: OutboundMessage;
  person?: Person;
  first: string;
  body: string;
  setBody: (v: string) => void;
  bodyId: string;
}) {
  // null while it is read, false when none is kept yet
  const kept = useLiveQuery(
    async () => (await followUpFor(draft.personId)) ?? (false as const),
    [draft.personId],
    null,
  );
  const [follow, setFollow] = useState<string>();
  const shown = follow ?? (kept ? kept.text : defaultFollowUp(first, person?.currentOrganizationRaw));
  // the follow-up is kept from the start, so a note sent without touching step 2 still gets it
  useEffect(() => {
    if (kept === false) void saveFollowUp(draft.personId, shown, draft.id);
  }, [kept === false, draft.id]);
  const she = first;
  return (
    <ol className="divide-y divide-line-2 border-y border-line-2 -mx-1" data-testid="draft-after-accept">
      <li className="flex gap-3 px-1 py-3">
        <span className="mt-0.5 h-6 w-6 shrink-0 rounded-full bg-accent text-white text-[12px] font-semibold inline-flex items-center justify-center">
          1
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={bodyId} className="text-[13.5px] font-medium">
              Connection note
            </label>
            <span className="text-[12px] text-ink-3">Sends now</span>
          </div>
          <Textarea
            id={bodyId}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            className="mt-1 resize-y !rounded-none !border-0 !bg-transparent !text-[14px] !leading-[1.6] !px-0 !py-1 focus:!ring-0"
            aria-label="Connection note"
          />
        </div>
      </li>
      <li className="flex gap-3 px-1 py-3">
        <span className="mt-0.5 h-6 w-6 shrink-0 rounded-full border border-line text-ink-3 text-[12px] font-semibold inline-flex items-center justify-center">
          2
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={`${bodyId}-follow`} className="text-[13.5px] font-medium">
              Follow up
            </label>
            <span className="text-[12px] text-ink-3">When {she} accepts</span>
          </div>
          <Textarea
            id={`${bodyId}-follow`}
            value={shown}
            onChange={(e) => setFollow(e.target.value)}
            onBlur={() => void saveFollowUp(draft.personId, shown, draft.id)}
            rows={3}
            className="mt-1 resize-y !rounded-none !border-0 !bg-transparent !text-[14px] !leading-[1.6] !px-0 !py-1 focus:!ring-0"
            aria-label="Follow up after they accept"
            data-testid="draft-follow-up"
          />
          <p className="text-[12px] text-ink-3">
            When {she} accepts, Orbit drafts this for you. It goes on your tap.
          </p>
        </div>
      </li>
    </ol>
  );
}
