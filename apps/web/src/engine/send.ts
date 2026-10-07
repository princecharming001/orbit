import type {
  CoffeeChat,
  EmailMessage,
  EmailThread,
  OutboundMessage,
  OutboundStatus,
  Person,
  Suggestion,
  User,
} from '@orbit/core';
import {
  declineReengage,
  LINKEDIN_NOTE_MAX,
  linkedinMessageUrl,
  linkedinProfileUrl,
  MESSAGE_KIND_LABELS,
  maxBumpsFor,
  newId,
  reengageDueAt,
  sectorOf,
  sha256Hex,
  validateDraft,
} from '@orbit/core';
import { addTouchpoint, audit, feedback, notify, recomputePersonStrength } from '../db/repo';
import { db } from '../db/schema';
import {
  canSendWith,
  currentGoogleToken,
  gmailGet,
  gmailHeaders,
  gmailSend,
  messageIdTokens,
} from '../integrations/google';
import { evaluateImmediateSuggestions, findReferrerFor } from './brief';
import { evaluateTrigger, recordAlreadyDone } from './stages';

/** Provider sends wait this long in `queued` so the student can undo (01 §6, 07 §5, 14 §7). */
export const UNDO_WINDOW_MS = 60_000;
/** A queued send found this long after its `sendAt` (Orbit was closed) is not sent blindly; it goes back to draft. */
const STALE_QUEUE_MS = 10 * 60_000;

const HOUR = 3_600_000;
/**
 * Kinds the per-person cooldown never holds back: answers to them, scheduling, thank-yous and congratulations. Every
 * other message (outreach, bumps, check-ins, updates, referral and intro asks) waits until they answer the last one.
 */
const COOLDOWN_EXEMPT: OutboundMessage['kind'][] = ['reply', 'schedule', 'thank_you', 'congratulate'];
/** Chat stages that mean the person has answered at least once. */
const ANSWERED_STAGES: CoffeeChat['stage'][] = [
  'replied',
  'scheduling',
  'scheduled',
  'completed',
  'followed_up',
];
/**
 * Entering one of these after the student's last message means the person answered it. `followed_up` is not one:
 * the student's own thank-you puts the chat there.
 */
const ANSWER_STAGES: CoffeeChat['stage'][] = ANSWERED_STAGES.filter((st) => st !== 'followed_up');
const INACTIVE_STAGES: CoffeeChat['stage'][] = ['declined', 'no_response', 'archived'];
/** Statuses that count as "already written" for caps and cooldowns; a hand-off counts from the moment it opened. */
const COMMITTED: OutboundStatus[] = ['sent', 'queued', 'sending', 'handed_off'];

function committedAt(o: OutboundMessage): string | undefined {
  return o.status === 'sent' ? o.sentAt : o.queuedAt;
}

/** "just now", "20 minutes ago", "5 hours ago", "2 days ago" for the cooldown message (never "0 hours ago"). */
export function timeAgo(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(ms / HOUR);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** The chat a message belongs to: its own, else the person's live chat; old declined or silent chats only for non-outreach. */
async function chatFor(
  personId: string,
  kind: OutboundMessage['kind'],
  chatId?: string,
): Promise<CoffeeChat | undefined> {
  if (chatId) {
    const c = await db.chats.get(chatId);
    if (c) return c;
  }
  const chats = (await db.chats.where('personId').equals(personId).toArray()).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  const live = chats.find((c) => !INACTIVE_STAGES.includes(c.stage));
  if (live || kind === 'outreach') return live;
  return chats.find((c) => c.stage !== 'archived');
}

/**
 * A decline with a time limit ("not this quarter") whose window has passed, with nothing sent since: the one polite
 * second try the re-engagement card offers (the same rule that makes the card) may go out.
 */
async function declineWindowPassed(chat: CoffeeChat, now: Date): Promise<boolean> {
  if (!chat.threadId) return false;
  const last = (await db.messages.where('threadId').equals(chat.threadId).toArray())
    .filter((m) => m.direction === 'inbound' && !m.isAutomated && m.signal !== 'out_of_office')
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0];
  if (last?.signal !== 'reply_decline') return false;
  const saidAt = new Date(last.sentAt);
  const re = declineReengage(last.bodyText, saidAt);
  if (!re || now < reengageDueAt(re, saidAt)) return false;
  return !chat.lastOutboundAt || new Date(chat.lastOutboundAt) < saidAt;
}

export async function checkSendAllowed(
  userId: string,
  personId: string,
  channel: OutboundMessage['channel'],
  kind: OutboundMessage['kind'],
  now = new Date(),
  opts: { chatId?: string; excludeMessageId?: string } = {},
): Promise<{ allowed: boolean; reason?: string }> {
  const settings = await db.settings.get(userId);
  const person = await db.people.get(personId);
  if (!person || person.hiddenAt) return { allowed: false, reason: 'This person is hidden.' };
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const sentToday = await db.outbound
    .where('userId')
    .equals(userId)
    .filter((o) => {
      const at = committedAt(o);
      return (
        o.id !== opts.excludeMessageId &&
        COMMITTED.includes(o.status) &&
        o.channel === channel &&
        !!at &&
        new Date(at) >= dayStart
      );
    })
    .count();
  const cap =
    channel === 'linkedin' ? (settings?.dailySendCapLinkedin ?? 10) : (settings?.dailySendCapGmail ?? 15);
  if (sentToday >= cap)
    return {
      allowed: false,
      reason: `Daily limit reached: ${cap} ${channel === 'linkedin' ? 'LinkedIn messages' : 'emails'} today. It resets at midnight.`,
    };
  const chat = await chatFor(personId, kind, opts.chatId);
  if (
    chat?.stage === 'declined' &&
    kind !== 'reply' &&
    kind !== 'thank_you' &&
    !(await declineWindowPassed(chat, now))
  )
    return {
      allowed: false,
      reason: `${person.firstName} declined earlier. Move the chat out of Declined first if that changed.`,
    };
  if (!COOLDOWN_EXEMPT.includes(kind)) {
    const cooldownHours = settings?.perPersonCooldownHours ?? 72;
    const prior = (
      await db.outbound
        .where('personId')
        .equals(personId)
        .filter((o) => o.id !== opts.excludeMessageId && COMMITTED.includes(o.status) && !!committedAt(o))
        .toArray()
    ).sort((a, b) => (committedAt(b) ?? '').localeCompare(committedAt(a) ?? ''))[0];
    const lastAt = prior ? new Date(committedAt(prior)!) : undefined;
    if (lastAt && now.getTime() - lastAt.getTime() < cooldownHours * HOUR) {
      const chats = await db.chats.where('personId').equals(personId).toArray();
      const answered =
        chats.some((c) => !!c.lastInboundAt && new Date(c.lastInboundAt) > lastAt) ||
        (!!chat && ANSWER_STAGES.includes(chat.stage) && new Date(chat.stageEnteredAt) >= lastAt);
      if (!answered)
        return {
          allowed: false,
          reason: `You wrote to ${person.firstName} ${timeAgo(now.getTime() - lastAt.getTime())} and they have not replied yet. Orbit waits ${cooldownHours} hours before another unanswered message to the same person.`,
        };
    }
  }
  if (kind === 'bump' && chat?.stage === 'outreach_sent') {
    const max = maxBumpsFor(
      sectorOf({ title: person.currentTitle, org: person.currentOrganizationRaw }),
      settings?.maxBumps ?? 2,
    );
    if (chat.bumpCount >= max)
      return {
        allowed: false,
        reason: `You've already followed up ${max === 1 ? 'once' : `${max} times`}; the playbook says let it rest and try someone else on the team.`,
      };
  }
  return { allowed: true };
}

// ---------- threading ----------

/** `Re: <subject>` with any existing Re:/Fwd: prefixes collapsed. */
export function replySubject(subject?: string): string | undefined {
  const base = (subject ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^\s*((re|fwd?|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, '')
    .trim();
  return base ? `Re: ${base}` : undefined;
}

/** The email thread a message answers, if any (its own thread, or the chat's thread for non-outreach kinds). */
export async function threadForMessage(msg: OutboundMessage): Promise<EmailThread | undefined> {
  if (msg.channel !== 'gmail') return undefined;
  if (msg.externalThreadId) {
    const th = await db.threads
      .where('externalThreadId')
      .equals(msg.externalThreadId)
      .filter((t) => t.userId === msg.userId)
      .first();
    if (th) return th;
  }
  if (msg.kind === 'outreach') return undefined;
  const chat = await chatFor(msg.personId, msg.kind, msg.chatId);
  return chat?.threadId ? db.threads.get(chat.threadId) : undefined;
}

interface Envelope {
  subject?: string;
  externalThreadId?: string;
  inReplyTo?: string;
  references?: string;
  threaded: boolean;
}

async function envelopeFor(msg: OutboundMessage, subjectArg?: string): Promise<Envelope> {
  const thread = await threadForMessage(msg);
  if (!thread && !msg.externalThreadId)
    return { subject: (subjectArg ?? msg.subject)?.trim() || undefined, threaded: false };
  // In a thread the subject is always the thread's, never an empty or made-up one
  const subject = replySubject(thread?.subject ?? msg.subject ?? subjectArg);
  const msgs = thread ? await db.messages.where('threadId').equals(thread.id).sortBy('sentAt') : [];
  const last = [...msgs].reverse().find((m) => !!m.headers['message-id']);
  const inReplyTo = last?.headers['message-id'] ?? msg.inReplyToMessageId;
  const references = messageIdTokens(last?.headers.references, inReplyTo).join(' ') || undefined;
  return {
    subject,
    externalThreadId: thread?.externalThreadId ?? msg.externalThreadId,
    inReplyTo,
    references,
    threaded: true,
  };
}

/** How the message will go out (for the editor): in a thread with the thread's subject, or as a new email. */
export async function draftEnvelope(msg: OutboundMessage): Promise<{ threaded: boolean; subject?: string }> {
  const env = await envelopeFor(msg);
  return { threaded: env.threaded, subject: env.subject };
}

// ---------- validation at approval ----------

export interface DraftIssue {
  code: string;
  text: string;
  blocking: boolean;
}

const TEXT_CODES = new Set([
  'too_long',
  'banned_phrase',
  'em_dash',
  'placeholder',
  'unknown_url',
  'unknown_email',
  'missing_name',
  'injection',
  'banned_subject',
  'exclamations',
  'long_sentences',
  'i_heavy',
]);
/** Issues that only warn when the student wrote the text: their own link, a longer note, style. */
const SOFT_FOR_EDITS = new Set([
  'too_long',
  'unknown_url',
  'unknown_email',
  'exclamations',
  'long_sentences',
  'i_heavy',
]);

function issueText(code: string, detail: string, person: Person): string {
  switch (code) {
    case 'missing_name':
      return `The message never uses ${person.firstName}'s name. Check it is addressed to the right person.`;
    case 'banned_phrase':
      return `"${detail}" reads like a template. Say it in your own words.`;
    case 'em_dash':
      return 'Swap the long dash for a comma or a period. Dashes read as machine-written.';
    case 'placeholder':
      return `Fill in ${detail} before sending.`;
    case 'injection':
      return 'The message contains instruction-like text. Remove it before sending.';
    case 'banned_subject':
      return `The subject "${detail}" reads like a mass email. Make it specific.`;
    case 'too_long':
      return `${detail}. Shorter messages get more replies.`;
    case 'unknown_url':
      return `Check the link ${detail} before sending.`;
    case 'unknown_email':
      return `Check the email address ${detail} before sending.`;
    case 'exclamations':
      return 'More than one exclamation mark. One at most reads calmer.';
    case 'long_sentences':
      return `${detail}. Split them so they are easy to skim.`;
    case 'i_heavy':
      return `${detail}. Lead with them, not you.`;
    default:
      return detail;
  }
}

type ChatEvidence = Pick<
  CoffeeChat,
  'stage' | 'outreachChannel' | 'lastInboundAt' | 'completedAt' | 'followedUpAt'
>;

/**
 * Did they answer this chat that started on LinkedIn? Its stage says so while it is in an answered stage or Nurturing
 * (only answered chats get there), and its dates say so after it moves on, for example to Archived.
 */
function answeredOnLinkedin(c: ChatEvidence): boolean {
  if (c.outreachChannel !== 'linkedin') return false;
  return (
    ANSWERED_STAGES.includes(c.stage) ||
    c.stage === 'nurturing' ||
    !!c.lastInboundAt ||
    !!c.completedAt ||
    !!c.followedUpAt
  );
}

/**
 * Is this LinkedIn message a connection note? It is unless they are a connection: in the imported connections, or they
 * ever answered a chat that started on LinkedIn (they accepted the request, so LinkedIn lets the student message them).
 * A note goes with Connect, Add a note, and LinkedIn caps it at 300 characters, whatever kind of message it is.
 */
export function isConnectionNote(
  msg: Pick<OutboundMessage, 'channel'>,
  person?: Pick<Person, 'linkedinConnectedOn'>,
  chats: ChatEvidence[] = [],
): boolean {
  if (msg.channel !== 'linkedin' || person?.linkedinConnectedOn) return false;
  return !chats.some(answeredOnLinkedin);
}

async function connectionNoteFor(msg: OutboundMessage, person: Person): Promise<boolean> {
  if (msg.channel !== 'linkedin' || person.linkedinConnectedOn) return false;
  return isConnectionNote(msg, person, await db.chats.where('personId').equals(person.id).toArray());
}

/**
 * Re-validate the text the student is about to approve with the core validator. Issues the edit introduced keep the
 * validator's blocking flag; issues already in Orbit's draft, and style issues in the student's own words, only warn.
 */
export async function reviewDraft(
  user: User,
  msg: OutboundMessage,
  body: string,
  subject?: string,
): Promise<DraftIssue[]> {
  const person = await db.people.get(msg.personId);
  if (!person) return [];
  const settings = await db.settings.get(user.id);
  const threaded = !!msg.externalThreadId || !!(await threadForMessage(msg));
  const opts = {
    kind: msg.kind,
    facts: [],
    allowedUrls: [settings?.schedulingLink, user.linkedinUrl, person.linkedinUrl].filter(
      (u): u is string => !!u,
    ),
    recipientEmail: person.primaryEmail,
    recipientFirstName: person.firstName,
    recipientFullName: person.displayName,
    channel: msg.channel,
  };
  const check = (b: string, s?: string) =>
    validateDraft(
      { body: b, claims: [], subject: msg.channel === 'gmail' && !threaded ? s : undefined },
      opts,
    )
      .filter((i) => TEXT_CODES.has(i.code))
      .map((i) => ({ ...i, key: `${i.code}|${i.detail}` }));
  const original = new Set(check(msg.bodyDraft, msg.subject).map((i) => i.key));
  const issues: DraftIssue[] = check(body, subject ?? msg.subject).map((i) => ({
    code: i.code,
    text: issueText(i.code, i.detail, person),
    blocking: i.blocking && !original.has(i.key) && !SOFT_FOR_EDITS.has(i.code),
  }));
  if ((await connectionNoteFor(msg, person)) && body.length > LINKEDIN_NOTE_MAX)
    issues.unshift({
      code: 'linkedin_note_too_long',
      text: `LinkedIn caps a connection note at ${LINKEDIN_NOTE_MAX} characters and this one is ${body.length}. Trim it before sending.`,
      blocking: true,
    });
  if (msg.channel === 'gmail' && !threaded && !(subject ?? msg.subject)?.trim())
    issues.unshift({ code: 'no_subject', text: 'Add a subject line.', blocking: true });
  return issues;
}

// ---------- approval ----------

export type HandoffVia = 'mailto' | 'linkedin_compose' | 'linkedin_connect';

export type ApproveResult =
  | { ok: true; status: 'queued'; sendAt: string }
  | { ok: true; status: 'sent' }
  | { ok: true; status: 'handed_off'; handoffUrl: string; via: HandoffVia; threaded: boolean }
  | { ok: false; error: string; issues?: DraftIssue[] };

/**
 * True when approved email goes out through the Gmail API: Google is connected and the student granted the send
 * permission (they can untick it on the consent screen). Otherwise approval hands off to the mail app.
 */
export async function googleSendActive(userId: string): Promise<boolean> {
  const g = await db.integrations
    .where('userId')
    .equals(userId)
    .filter((i) => i.provider === 'google' && i.status === 'active')
    .first();
  if (!g) return false;
  return canSendWith(g.scopes) && canSendWith(currentGoogleToken()?.scopes);
}

/** Atomically move a message from one of `from` to `changes.status`; undefined when it was not in `from`. */
async function transition(
  id: string,
  from: OutboundStatus[],
  changes: Partial<OutboundMessage> & { status: OutboundStatus },
): Promise<OutboundMessage | undefined> {
  return db.transaction('rw', db.outbound, async () => {
    const m = await db.outbound.get(id);
    if (!m || !from.includes(m.status)) return undefined;
    await db.outbound.update(id, changes);
    return { ...m, ...changes };
  });
}

/** Where a hand-off opens: the mail app, LinkedIn compose for a connection, the profile (Connect, Add a note) otherwise. */
function handoffFor(
  msg: OutboundMessage,
  person: Person,
  body: string,
  env: Envelope,
  connectionNote: boolean,
): { url: string; via: HandoffVia } | { error: string } {
  if (msg.channel === 'gmail') {
    if (!msg.toEmail) return { error: `There is no email address for ${person.firstName}.` };
    return {
      url: `mailto:${encodeURIComponent(msg.toEmail)}?subject=${encodeURIComponent(env.subject ?? '')}&body=${encodeURIComponent(body)}`,
      via: 'mailto',
    };
  }
  const slug = person.linkedinSlug;
  const profile = slug ? linkedinProfileUrl(slug) : person.linkedinUrl;
  if (!profile)
    return {
      error: `Orbit has no LinkedIn profile for ${person.firstName}, so there is nowhere to send this.`,
    };
  if (connectionNote) return { url: profile, via: 'linkedin_connect' };
  return { url: slug ? linkedinMessageUrl(slug) : profile, via: 'linkedin_compose' };
}

function alreadyText(status?: OutboundStatus): string {
  switch (status) {
    case 'queued':
    case 'sending':
      return 'This message is already being sent.';
    case 'handed_off':
      return 'This message is waiting for you to confirm you sent it.';
    case 'sent':
      return 'This message was already sent.';
    default:
      return 'This message can no longer be sent from here.';
  }
}

/**
 * Bind approval to the exact text, then queue a Gmail API send behind the undo window, or hand off to the mail app or
 * LinkedIn (status `handed_off` until the student confirms). A blocked approval changes nothing, and the suggestion is
 * only closed once the message has really gone out.
 */
export async function approveAndSend(
  user: User,
  messageId: string,
  bodyFinal: string,
  subject?: string,
  now = new Date(),
  opts: { undoWindowMs?: number } = {},
): Promise<ApproveResult> {
  const msg = await db.outbound.get(messageId);
  if (!msg || msg.userId !== user.id) return { ok: false, error: 'Message not found' };
  if (!['draft', 'failed', 'cancelled'].includes(msg.status))
    return { ok: false, error: alreadyText(msg.status) };
  const person = await db.people.get(msg.personId);
  if (!person) return { ok: false, error: 'Person not found' };
  if (!bodyFinal.trim()) return { ok: false, error: 'The message is empty.' };
  const issues = await reviewDraft(user, msg, bodyFinal, subject);
  const blocking = issues.filter((i) => i.blocking);
  if (blocking.length) return { ok: false, error: blocking[0]!.text, issues };
  const allowed = await checkSendAllowed(user.id, msg.personId, msg.channel, msg.kind, now, {
    chatId: msg.chatId,
    excludeMessageId: msg.id,
  });
  if (!allowed.allowed) return { ok: false, error: allowed.reason ?? 'Not allowed' };
  const env = await envelopeFor(msg, subject);
  if (msg.channel === 'gmail' && !env.subject)
    return {
      ok: false,
      error: env.threaded
        ? 'Orbit could not find the subject of this thread. Reply from Gmail instead.'
        : 'Add a subject line.',
    };
  const hash = await sha256Hex(bodyFinal);
  const approval: Partial<OutboundMessage> = {
    bodyFinal,
    bodyFinalHash: hash,
    subject: env.subject,
    externalThreadId: env.externalThreadId,
    inReplyToMessageId: env.inReplyTo,
    approvedAt: now.toISOString(),
    error: undefined,
  };
  if (msg.channel === 'gmail' && (await googleSendActive(user.id))) {
    if (!msg.toEmail) return { ok: false, error: `There is no email address for ${person.firstName}.` };
    const undoMs = opts.undoWindowMs ?? UNDO_WINDOW_MS;
    const sendAt = new Date(now.getTime() + undoMs).toISOString();
    const claimed = await transition(msg.id, ['draft', 'failed', 'cancelled'], {
      ...approval,
      status: undoMs > 0 ? 'queued' : 'sending',
      queuedAt: now.toISOString(),
      sendAt,
    });
    if (!claimed) return { ok: false, error: alreadyText((await db.outbound.get(msg.id))?.status) };
    await audit(user.id, 'message.approved', {
      objectTable: 'outbound',
      objectId: msg.id,
      metadata: { channel: msg.channel, kind: msg.kind, hash, sendAt },
    });
    if (undoMs > 0) return { ok: true, status: 'queued', sendAt };
    const r = await deliver(user, claimed, now);
    return r.ok ? { ok: true, status: 'sent' } : r;
  }
  const h = handoffFor(msg, person, bodyFinal, env, await connectionNoteFor(msg, person));
  if ('error' in h) return { ok: false, error: h.error };
  const claimed = await transition(msg.id, ['draft', 'failed', 'cancelled'], {
    ...approval,
    status: 'handed_off',
    queuedAt: now.toISOString(),
    sendAt: undefined,
  });
  if (!claimed) return { ok: false, error: alreadyText((await db.outbound.get(msg.id))?.status) };
  await audit(user.id, 'message.handed_off', {
    objectTable: 'outbound',
    objectId: msg.id,
    metadata: { channel: msg.channel, kind: msg.kind, hash, via: h.via },
  });
  return { ok: true, status: 'handed_off', handoffUrl: h.url, via: h.via, threaded: env.threaded };
}

/** Undo a queued send inside the window: back to an editable draft; the suggestion stays where it was. */
export async function undoQueued(user: User, messageId: string): Promise<boolean> {
  const m = await transition(messageId, ['queued'], {
    status: 'draft',
    sendAt: undefined,
    queuedAt: undefined,
    approvedAt: undefined,
  });
  if (m) await audit(user.id, 'message.undone', { objectTable: 'outbound', objectId: messageId });
  return !!m;
}

/** The student says the hand-off did not go out: back to an editable draft. */
export async function revertHandoff(user: User, messageId: string): Promise<boolean> {
  const m = await transition(messageId, ['handed_off'], {
    status: 'draft',
    queuedAt: undefined,
    approvedAt: undefined,
  });
  if (m) await audit(user.id, 'message.handoff_reverted', { objectTable: 'outbound', objectId: messageId });
  return !!m;
}

/** Where a handed-off message opens again (the mail app or LinkedIn), for the "Open again" button. */
export async function handoffLink(
  user: User,
  messageId: string,
): Promise<{ url: string; via: HandoffVia } | undefined> {
  const m = await db.outbound.get(messageId);
  if (!m || m.userId !== user.id || m.status !== 'handed_off') return undefined;
  const person = await db.people.get(m.personId);
  if (!person) return undefined;
  const h = handoffFor(
    m,
    person,
    m.bodyFinal ?? m.bodyDraft,
    await envelopeFor(m, m.subject),
    await connectionNoteFor(m, person),
  );
  return 'error' in h ? undefined : h;
}

/**
 * The student confirms they sent the hand-off: record it as sent, with the touchpoint and stage change. The move to
 * `sent` is the atomic claim (a second click finds nothing to confirm), so a failure in the bookkeeping after it can
 * never leave the message stuck in between; the student is told to check the chat instead.
 */
export async function confirmHandoff(
  user: User,
  messageId: string,
  now = new Date(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const m = await transition(messageId, ['handed_off'], {
    status: 'sent',
    sentAt: now.toISOString(),
    sendAt: undefined,
  });
  if (!m) return { ok: false, error: 'This message is not waiting for confirmation.' };
  try {
    await finalizeSent(user, m, {}, now);
  } catch (e) {
    return {
      ok: false,
      error: chatBehind(e)
        ? 'Logged as sent, but Orbit could not update the chat. Check its stage on their page.'
        : 'Logged as sent and the chat is updated, but Orbit could not save all of it to their history. Check their page.',
    };
  }
  return { ok: true };
}

let draining: Promise<unknown> | undefined;

/**
 * Send every queued message whose undo window has ended. The app shell calls this on an interval; runs are serialised
 * and the queued to sending step is atomic, so a message is never sent twice.
 */
export async function sendDueQueued(
  user: User,
  now = new Date(),
): Promise<{ id: string; ok: boolean; error?: string }[]> {
  while (draining) await draining.catch(() => undefined);
  const run = (async () => {
    const out: { id: string; ok: boolean; error?: string }[] = [];
    const due = await db.outbound
      .where('userId')
      .equals(user.id)
      .filter((o) => (o.status === 'queued' || o.status === 'sending') && !!o.sendAt)
      .toArray();
    for (const o of due) {
      const late = now.getTime() - new Date(o.sendAt!).getTime();
      if (o.status === 'sending') {
        // a send interrupted mid-flight (tab closed): never resend blindly
        if (late > STALE_QUEUE_MS) {
          const m = await transition(o.id, ['sending'], {
            status: 'failed',
            sendAt: undefined,
            error:
              'Orbit could not confirm this was sent. Check your Gmail Sent folder before sending it again.',
          });
          if (m) out.push({ id: o.id, ok: false, error: m.error });
        }
        continue;
      }
      if (late < 0) continue;
      if (late > STALE_QUEUE_MS) {
        const m = await transition(o.id, ['queued'], {
          status: 'failed',
          sendAt: undefined,
          error: 'Orbit was closed before the undo window ended. Review it and send again.',
        });
        if (m) out.push({ id: o.id, ok: false, error: m.error });
        continue;
      }
      const claimed = await transition(o.id, ['queued'], { status: 'sending' });
      if (!claimed) continue;
      const r = await deliver(user, claimed, now);
      out.push(r.ok ? { id: o.id, ok: true } : { id: o.id, ok: false, error: r.error });
    }
    return out;
  })();
  draining = run;
  try {
    return await run;
  } finally {
    draining = undefined;
  }
}

/** Send a claimed (`sending`) message through the Gmail API. */
async function deliver(
  user: User,
  msg: OutboundMessage,
  now: Date,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const fail = async (error: string) => {
    await db.outbound.update(msg.id, { status: 'failed', error, sendAt: undefined });
    await notify(user.id, 'system', 'Not sent', error);
    return { ok: false as const, error };
  };
  // integrity: the text sent is the text approved
  if (!msg.bodyFinal || msg.bodyFinalHash !== (await sha256Hex(msg.bodyFinal)))
    return fail('Approval did not match the text. Nothing was sent.');
  const person = await db.people.get(msg.personId);
  if (!person || person.hiddenAt) return fail('This person is hidden.');
  if (!msg.toEmail) return fail(`There is no email address for ${person.firstName}.`);
  const env = await envelopeFor(msg, msg.subject);
  if (!env.subject) return fail('This email has no subject.');
  let r: { id: string; threadId: string };
  try {
    r = await gmailSend({
      to: msg.toEmail,
      subject: env.subject,
      body: msg.bodyFinal,
      fromEmail: user.email,
      fromName: user.fullName,
      threadId: env.externalThreadId,
      inReplyTo: env.inReplyTo,
      references: env.references,
      orbitId: msg.id,
    });
  } catch (e) {
    return fail(String((e as Error).message ?? e));
  }
  try {
    await finalizeSent(
      user,
      { ...msg, subject: env.subject },
      { providerMessageId: r.id, providerThreadId: r.threadId },
      now,
    );
  } catch (e) {
    // it went out: record that much, never leave it in `sending`
    try {
      await db.outbound.update(msg.id, {
        status: 'sent',
        sentAt: now.toISOString(),
        sendAt: undefined,
        providerMessageId: r.id,
        externalThreadId: r.threadId,
      });
      await notify(
        user.id,
        'system',
        'Sent',
        chatBehind(e)
          ? 'Orbit sent it but could not update the chat. Check its stage.'
          : 'Orbit sent it and updated the chat, but could not save all of it to their history. Check their page.',
      );
    } catch {}
  }
  return { ok: true };
}

const TRIGGER_KIND: Partial<
  Record<OutboundMessage['kind'], 'outreach' | 'bump' | 'schedule' | 'thank_you' | 'nurture'>
> = {
  outreach: 'outreach',
  bump: 'bump',
  schedule: 'schedule',
  thank_you: 'thank_you',
  nurture: 'nurture',
};

/** The bookkeeping after a send failed somewhere; `chatBehind` says whether the chat itself missed the update. */
class FinalizeError extends Error {
  constructor(
    cause: unknown,
    readonly chatBehind: boolean,
  ) {
    super('Could not finish recording a sent message', { cause });
  }
}

/** Whether a failure from `finalizeSent` left the chat (its stage, last contact) behind. Unknown errors count as yes. */
function chatBehind(e: unknown): boolean {
  return e instanceof FinalizeError ? e.chatBehind : true;
}

/**
 * Record a message that really went out, in this order: status, suggestion, feedback, audit, touchpoint, thread, then
 * the chat and its stage, recommendations, relationship strength and fresh suggestions. Each step runs even when an
 * earlier one fails, so one failed write (a full disk on the touchpoint, say) cannot leave the card pending or the chat
 * behind for a message that is already out. The first failure is rethrown at the end as a `FinalizeError` that says
 * whether the chat was updated, so the caller tells the student exactly what to check.
 */
async function finalizeSent(
  user: User,
  msg: OutboundMessage,
  provider: { providerMessageId?: string; providerThreadId?: string },
  now: Date,
): Promise<void> {
  let failure: unknown;
  let chatMissed = false;
  const step = async (run: () => Promise<unknown>): Promise<boolean> => {
    try {
      await run();
      return true;
    } catch (e) {
      failure ??= e;
      return false;
    }
  };
  let suggestion: Suggestion | undefined;
  let chat: CoffeeChat | undefined;
  await step(async () => {
    suggestion = msg.suggestionId ? await db.suggestions.get(msg.suggestionId) : undefined;
  });
  chatMissed = !(await step(async () => {
    chat = await chatFor(msg.personId, msg.kind, msg.chatId);
    if (!chat && msg.kind === 'outreach') chat = await openChatForOutreach(user, msg, suggestion, now);
  }));
  await step(() =>
    db.outbound.update(msg.id, {
      status: 'sent',
      sentAt: now.toISOString(),
      sendAt: undefined,
      error: undefined,
      chatId: msg.chatId ?? chat?.id,
      providerMessageId: provider.providerMessageId,
      externalThreadId: provider.providerThreadId ?? msg.externalThreadId,
    }),
  );
  if (suggestion) {
    const s = suggestion;
    await step(() => db.suggestions.update(s.id, { status: 'sent', decidedAt: now.toISOString() }));
    const edited = (msg.bodyFinal ?? '').trim() !== msg.bodyDraft.trim();
    await step(() =>
      feedback(user.id, edited ? 'edit' : 'approve', {
        suggestionId: s.id,
        outboundMessageId: msg.id,
        editDistance: edited ? Math.abs((msg.bodyFinal ?? '').length - msg.bodyDraft.length) : 0,
        editBefore: edited ? msg.bodyDraft : undefined,
        editAfter: edited ? msg.bodyFinal : undefined,
      } as never),
    );
  }
  await step(() =>
    audit(user.id, 'message.sent', {
      objectTable: 'outbound',
      objectId: msg.id,
      metadata: {
        channel: msg.channel,
        kind: msg.kind,
        hash: msg.bodyFinalHash,
        via: provider.providerMessageId ? 'gmail_api' : 'handoff_confirmed',
      },
    }),
  );
  await step(() =>
    addTouchpoint({
      userId: user.id,
      personId: msg.personId,
      kind: msg.channel === 'linkedin' ? 'linkedin_out' : 'email_out',
      occurredAt: now.toISOString(),
      refTable: 'outbound',
      refId: msg.id,
      summary: `${msg.channel === 'linkedin' ? 'LinkedIn message' : 'Email'}: ${msg.subject ?? MESSAGE_KIND_LABELS[msg.kind]}`,
      weight: msg.channel === 'linkedin' ? 0.5 : 0.6,
    }),
  );
  if (provider.providerMessageId && provider.providerThreadId) {
    const { providerMessageId, providerThreadId } = provider;
    await step(() => recordSentEmail(user, msg, providerMessageId, providerThreadId, chat, now));
  }
  if (chat) {
    const known = chat;
    const updated = await step(async () => {
      const fresh = (await db.chats.get(known.id)) ?? known;
      const changes: Partial<CoffeeChat> = {
        lastOutboundAt: now.toISOString(),
        updatedAt: now.toISOString(),
        outreachChannel: fresh.outreachChannel ?? msg.channel,
      };
      if (msg.kind === 'outreach') changes.firstOutreachAt = fresh.firstOutreachAt ?? now.toISOString();
      if (msg.kind === 'bump') changes.bumpCount = fresh.bumpCount + 1;
      await db.chats.update(fresh.id, changes);
      Object.assign(fresh, changes);
      chat = fresh;
      // a 'reply' only moves the stage when it settles a time; an answer to a question is just a reply
      const kind =
        msg.kind === 'reply'
          ? suggestion?.kind === 'schedule_confirm' || suggestion?.kind === 'schedule_propose'
            ? 'schedule'
            : 'other'
          : (TRIGGER_KIND[msg.kind] ?? 'other');
      await evaluateTrigger(fresh, { type: 'outbound_sent', kind }, { table: 'outbound', id: msg.id }, now);
    });
    chatMissed ||= !updated;
  }
  if (msg.kind === 'outreach')
    await step(() =>
      db.recommendations
        .where('personId')
        .equals(msg.personId)
        .filter((r) => r.userId === user.id && (r.status === 'new' || r.status === 'saved'))
        .modify({ status: 'converted' }),
    );
  await step(() => recomputePersonStrength(msg.personId, now));
  await step(() => evaluateImmediateSuggestions(user.id, { personId: msg.personId, chatId: chat?.id }, now));
  if (failure !== undefined) throw new FinalizeError(failure, chatMissed);
}

/** Outreach approved from a recommendation (or anywhere without a chat) opens the chat it starts. */
async function openChatForOutreach(
  user: User,
  msg: OutboundMessage,
  suggestion: Suggestion | undefined,
  now: Date,
): Promise<CoffeeChat | undefined> {
  const person = await db.people.get(msg.personId);
  if (!person) return undefined;
  const referrer = await findReferrerFor(user.id, person);
  const fromRec = !!suggestion?.payload.recommendationId;
  const chat: CoffeeChat = {
    id: newId('c'),
    userId: user.id,
    personId: person.id,
    organizationId: person.currentOrganizationId,
    stage: 'identified',
    stageEnteredAt: now.toISOString(),
    source: fromRec ? 'recommendation' : 'manual',
    goalTags: [],
    outreachChannel: msg.channel,
    bumpCount: 0,
    priority: 2,
    referrerPersonId: referrer?.id,
    referrerName: referrer?.firstName,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await db.chats.add(chat);
  await db.stageEvents.add({
    id: newId('se'),
    userId: user.id,
    chatId: chat.id,
    toStage: 'identified',
    status: 'applied',
    actor: 'user',
    reason: fromRec ? 'recommendation:approved' : 'user:start',
    createdAt: now.toISOString(),
    decidedAt: now.toISOString(),
  });
  if (suggestion && !suggestion.chatId) await db.suggestions.update(suggestion.id, { chatId: chat.id });
  return chat;
}

/**
 * Link a Gmail API send to its thread right away: the thread row (created if new) points at the chat, the chat points
 * at the thread, and the sent message is stored with its real Message-ID so the next message threads and the next
 * sync does not count it twice.
 */
async function recordSentEmail(
  user: User,
  msg: OutboundMessage,
  providerMessageId: string,
  providerThreadId: string,
  chat: CoffeeChat | undefined,
  now: Date,
): Promise<void> {
  let thread = await db.threads
    .where('externalThreadId')
    .equals(providerThreadId)
    .filter((t) => t.userId === user.id)
    .first();
  if (!thread) {
    thread = {
      id: newId('th'),
      userId: user.id,
      externalThreadId: providerThreadId,
      subject: msg.subject,
      messageCount: 0,
      participantEmails: msg.toEmail ? [msg.toEmail.toLowerCase()] : [],
      participantPersonIds: [msg.personId],
      category: 'networking',
      categoryConfidence: 1,
      isNetworking: true,
      chatId: chat?.id,
      classifiedAt: now.toISOString(),
      classifiedBy: 'heuristic',
    };
    await db.threads.add(thread);
  } else if (!thread.chatId && chat) await db.threads.update(thread.id, { chatId: chat.id });
  if (chat && !chat.threadId) {
    await db.chats.update(chat.id, { threadId: thread.id });
    chat.threadId = thread.id;
  }
  if (await db.messages.where('externalMessageId').equals(providerMessageId).first()) return;
  // best effort: the Message-ID Gmail assigned, so the next message can carry In-Reply-To and References
  let headers: Record<string, string> = {};
  try {
    headers = gmailHeaders(await gmailGet(providerMessageId, 'metadata'));
  } catch {}
  const message: EmailMessage = {
    id: newId('m'),
    userId: user.id,
    threadId: thread.id,
    externalMessageId: providerMessageId,
    direction: 'outbound',
    fromEmail: user.email.toLowerCase(),
    fromName: user.fullName,
    toEmails: msg.toEmail ? [msg.toEmail.toLowerCase()] : [],
    ccEmails: [],
    sentAt: now.toISOString(),
    subject: msg.subject,
    bodyText: msg.bodyFinal ?? msg.bodyDraft,
    headers: { ...headers, 'x-orbit-message-id': msg.id },
    isAutomated: false,
    processedAt: now.toISOString(),
  };
  await db.messages.add(message);
  const all = await db.messages.where('threadId').equals(thread.id).sortBy('sentAt');
  await db.threads.update(thread.id, {
    messageCount: all.length,
    firstMessageAt: all[0]?.sentAt,
    lastMessageAt: all[all.length - 1]?.sentAt,
    snippet: message.bodyText.slice(0, 140),
  });
}

export async function dismissSuggestion(userId: string, s: Suggestion, reason: string): Promise<void> {
  const now = new Date().toISOString();
  await db.suggestions.update(s.id, { status: 'dismissed', decidedAt: now });
  await feedback(userId, 'dismiss', {
    suggestionId: s.id,
    reason: `${reason}|${s.kind}:${s.personId ?? ''}`,
  });
  if (s.outboundMessageId)
    await transition(s.outboundMessageId, ['draft', 'failed', 'queued', 'handed_off'], {
      status: 'cancelled',
    });
  if (reason === 'already_did') await recordAlreadyDone(s);
}

export async function snoozeSuggestion(userId: string, s: Suggestion, days: number): Promise<void> {
  const until = new Date();
  until.setDate(until.getDate() + days);
  until.setHours(6, 0, 0, 0);
  await db.suggestions.update(s.id, {
    status: 'snoozed',
    snoozedUntil: until.toISOString(),
    decidedAt: new Date().toISOString(),
  });
  await feedback(userId, 'snooze', { suggestionId: s.id, reason: `${days}d` });
}
