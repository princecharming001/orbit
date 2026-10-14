/**
 * Replies to the student's outreach and the answers Orbit drafts in their voice (plan 16 §8), account mode only:
 * listing, drafting, approving (LinkedIn needs a second, explicit tap), free slots and booking. Nothing here sends on
 * its own: approval hands the draft to the server's send window, and the result says what actually happened.
 */
import type { ReplyClass, ReplyItem, ServerDraft, Slot, User } from '@orbit/core';
import { callApi, isAccountMode, isServerUser, NO_SERVER, SIGN_IN_FIRST } from '../integrations/orbitApi';

export const REPLY_CLASS_LABELS: Record<ReplyClass, string> = {
  interested: 'Interested',
  scheduling: 'Picking a time',
  question: 'Asked a question',
  objection: 'Has a concern',
  referral: 'Pointed you to someone',
  not_now: 'Not now',
  out_of_office: 'Out of office',
  decline: 'Declined',
  unsubscribe: 'Asked not to be contacted',
  thanks: 'Said thanks',
  other: 'Other',
};

/** Classes worth answering with times on offer. */
export const SLOT_CLASSES: ReadonlySet<ReplyClass> = new Set(['interested', 'scheduling']);

/** Classes Orbit does not draft an answer to (§8.3). */
export const NO_DRAFT_CLASSES: ReadonlySet<ReplyClass> = new Set(['unsubscribe']);

type Fail = { ok: false; message: string };
const notHere = (): Fail => ({ ok: false, message: isAccountMode() ? SIGN_IN_FIRST : NO_SERVER });

export async function listReplies(
  user: Pick<User, 'id'>,
): Promise<{ ok: true; replies: ReplyItem[] } | Fail> {
  if (!isServerUser(user.id)) return notHere();
  const r = await callApi('/replies/list', {});
  return r.ok ? { ok: true, replies: r.value.replies } : { ok: false, message: r.message };
}

export async function draftReply(
  user: Pick<User, 'id'>,
  messageId: string,
): Promise<{ ok: true; draft: ServerDraft } | Fail> {
  if (!isServerUser(user.id)) return notHere();
  const r = await callApi('/replies/draft', { messageId });
  return r.ok ? { ok: true, draft: r.value.draft } : { ok: false, message: r.message };
}

/** The draft still asks the student for a fact ([ASK USER: …], §8.6): it cannot be approved yet. */
export function blockingQuestions(
  draft: Pick<ServerDraft, 'needsInput' | 'body'>,
  body = draft.body,
): string[] {
  if (!/\[ASK USER:/i.test(body)) return [];
  const inBody = [...body.matchAll(/\[ASK USER:\s*([^\]]+)\]/gi)].map((m) => m[1]!.trim());
  return inBody.length ? inBody : draft.needsInput;
}

export type ApproveOutcome = { ok: true; draft: ServerDraft; text: string } | Fail;

/** What happened to an approved draft, in plain words; "sent" only when the server says it was sent. */
export function approvedText(d: ServerDraft, tz?: string): string {
  const when = d.sendAt
    ? new Date(d.sendAt).toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: tz || undefined,
      })
    : undefined;
  if (d.status === 'sent') return 'Sent.';
  if (d.status === 'sending') return 'Sending now.';
  if (d.status === 'scheduled' || d.status === 'approved')
    return when
      ? `Approved. It goes out ${when}, and you can still cancel it until then.`
      : 'Approved. It goes out in the next send window.';
  if (d.status === 'failed') return 'It could not be sent. Open Drafts to try again.';
  return 'Saved.';
}

/**
 * Approve a draft for sending: the student's edits go up first, then /drafts/approve. A LinkedIn message needs
 * `confirm` from a second tap; a draft that still asks a question is refused here, before the server sees it.
 */
export async function approveServerDraft(
  user: Pick<User, 'id' | 'timezone'>,
  draft: ServerDraft,
  opts: { body?: string; subject?: string | null; confirm?: boolean } = {},
): Promise<ApproveOutcome> {
  if (!isServerUser(user.id)) return notHere();
  const body = opts.body ?? draft.body;
  const open = blockingQuestions(draft, body);
  if (open.length) return { ok: false, message: `Answer this first: ${open[0]}` };
  if (draft.channel === 'linkedin' && !opts.confirm)
    return { ok: false, message: 'LinkedIn messages need one more tap to confirm.' };
  const subject = opts.subject === undefined ? draft.subject : opts.subject;
  if (body !== draft.body || subject !== draft.subject) {
    const push = await callApi('/sync/push', {
      changes: [{ table: 'drafts', op: 'upsert', id: draft.id, row: { body, subject } }],
    });
    if (!push.ok) return { ok: false, message: push.message };
    const res = push.value.results?.[0];
    if (res && !res.ok) return { ok: false, message: res.error?.message ?? 'Your edit could not be saved.' };
  }
  const r = await callApi('/drafts/approve', {
    draftId: draft.id,
    ...(draft.channel === 'linkedin' ? { confirm: true } : {}),
  });
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, draft: r.value.draft, text: approvedText(r.value.draft, user.timezone) };
}

export async function freeSlots(
  user: Pick<User, 'id'>,
  personId?: string,
): Promise<{ ok: true; slots: Slot[]; tz: string } | Fail> {
  if (!isServerUser(user.id)) return notHere();
  const r = await callApi('/calendar/slots', { personId, count: 3 });
  return r.ok ? { ok: true, slots: r.value.slots, tz: r.value.tz } : { ok: false, message: r.message };
}

export type BookOutcome = { ok: true; eventId?: string; consentUrl?: string } | Fail;

/** Create the calendar event for an agreed time (after the student approved it). */
export async function bookCall(
  user: Pick<User, 'id'>,
  draftId: string,
  slotStart: string,
): Promise<BookOutcome> {
  if (!isServerUser(user.id)) return notHere();
  const r = await callApi('/calendar/book', { draftId, slotStart });
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, eventId: r.value.eventId, consentUrl: r.value.needsConsent?.url };
}
