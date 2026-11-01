/**
 * funnel.reply (plan 29 §B2.3, §B4): the two classes that can end in a call. For `interested`, the reply with three
 * free slots (the scheduling link too when the student has one), on its own at autopilot when the reply asked
 * nothing. For `scheduling`, the times the person named are matched against the slots Orbit offered (kept on the
 * draft they answered, `drafts.offered_slots`); when one matches and the calendar is still free, the call is booked
 * (`bookSlot`: the event with the invite, the chat moved to scheduled), the confirmation is drafted and sent through
 * the normal send path (on its own only when `autonomyAllows`), the sent draft's outcome becomes `booked`, and an
 * audit row says `call.booked`. The prep card follows from the event the way plan 22 raises it, on the browser's
 * next brief. A time that matches nothing gets the slots reply instead.
 */
import { extractProposedTimes } from '@orbit/core/email/triage';
import { composeDraft, loadReplyMessage } from '../compose/compose.ts';
import type { DraftMeta, DraftRow } from '../compose/drafts.ts';
import { NeedsReauth } from '../google.ts';
import { HttpError } from '../http.ts';
import { iso } from '../rows.ts';
import type { Services } from '../services.ts';
import {
  BUFFER_MIN,
  type Busy,
  bookSlot,
  freeBusy,
  SLOT_MINUTES,
  slotLabel,
  storedBusy,
} from '../slots/slots.ts';
import { validZone } from '../zones.ts';
import { type AutoReplyOutcome, approveIfAllowed, maybeAutoReply } from './replies.ts';

/** A named time within this many minutes of an offered slot is that slot. */
export const SLOT_MATCH_MIN = 15;
/** Where the student's app lives, for the consent link when the calendar scope is still missing. */
export const APP_URL = 'https://tryorbit.today';

export type FunnelOutcome =
  | AutoReplyOutcome
  | { action: 'booked'; eventId: string; slotStart: string; draftId: string; confirmation: AutoReplyOutcome }
  | { action: 'needs_consent'; url: string; slotStart: string };

/** The slots the student offered this person, newest draft first: the sent reply or first touch that carried them. */
export async function offeredSlotsFor(
  s: Services,
  userId: string,
  personId: string,
  before: Date,
): Promise<{ draft: DraftRow; slots: string[] } | undefined> {
  const rows = await s.db.sql<DraftRow>`
    select * from orbit.drafts
     where user_id = ${userId}::uuid and person_id = ${personId}::uuid and status = 'sent'
       and sent_at <= ${before}::timestamptz
       and (offered_slots is not null or ask->'slots' is not null)
     order by sent_at desc limit 3`;
  for (const d of rows) {
    const fromColumn = Array.isArray(d.offered_slots) ? (d.offered_slots as unknown[]) : [];
    const fromAsk = Array.isArray((d.ask as DraftMeta | null)?.slots) ? (d.ask as DraftMeta).slots! : [];
    const slots = [...fromColumn, ...fromAsk].filter((x): x is string => typeof x === 'string');
    if (slots.length) return { draft: d, slots: [...new Set(slots)] };
  }
  return undefined;
}

/** The offered slot a reply names, when one does: the first proposed time within SLOT_MATCH_MIN of a slot. */
export function matchOfferedSlot(
  text: string,
  offered: string[],
  reference: Date,
  timeZone?: string,
): string | undefined {
  const proposed = extractProposedTimes(text, reference, timeZone);
  for (const p of proposed) {
    const t = new Date(p.startIso).getTime();
    const hit = offered.find((o) => Math.abs(new Date(o).getTime() - t) <= SLOT_MATCH_MIN * 60_000);
    if (hit) return hit;
  }
  return undefined;
}

/** Still free: nothing on the calendar touches the slot (with the usual buffer). */
export async function slotStillFree(s: Services, userId: string, start: Date, tz: string): Promise<boolean> {
  const end = new Date(start.getTime() + SLOT_MINUTES * 60_000);
  const from = new Date(start.getTime() - BUFFER_MIN * 60_000);
  const to = new Date(end.getTime() + BUFFER_MIN * 60_000);
  let busy: Busy[];
  try {
    busy = await freeBusy(s, userId, from, to, tz);
  } catch (e) {
    if (!(e instanceof NeedsReauth) && !(e instanceof HttpError)) throw e;
    busy = await storedBusy(s.db, userId, from, to);
  }
  return !busy.some((b) => start.getTime() < b.end && end.getTime() > b.start);
}

/**
 * The funnel for one classified reply. `interested` and any `scheduling` reply without a matching time go to
 * `maybeAutoReply` (the slots reply). A matching time books the call when the calendar is free and the goal is not
 * paused, then drafts the confirmation and lets `approveIfAllowed` decide whether it goes on its own.
 */
export async function runReplyFunnel(
  s: Services,
  userId: string,
  messageId: string,
  opts: { appUrl?: string } = {},
): Promise<FunnelOutcome> {
  const db = s.db;
  const now = s.now();
  const m = await loadReplyMessage(db, userId, messageId);
  if (m.reply_class !== 'scheduling' || !m.from_person_id)
    return maybeAutoReply(db, userId, messageId, { services: s });
  const [full] = await db.sql<{ body_text: string | null; snippet: string | null }>`
    select body_text, snippet from orbit.messages where id = ${m.id}::uuid`;
  const offered = await offeredSlotsFor(s, userId, m.from_person_id, new Date(m.sent_at));
  if (!offered) return maybeAutoReply(db, userId, messageId, { services: s });
  const [u] = await db.sql<{ timezone: string; settings: Record<string, unknown> }>`
    select timezone, settings from orbit.users where id = ${userId}::uuid`;
  const [p] = await db.sql<{ timezone: string | null; first_name: string | null; display_name: string }>`
    select timezone, first_name, display_name from orbit.people where id = ${m.from_person_id}::uuid`;
  const userTz = validZone(u?.timezone) ?? 'America/New_York';
  const tz = validZone(p?.timezone) ?? userTz;
  const text = full?.body_text ?? full?.snippet ?? '';
  const slotStart = matchOfferedSlot(text, offered.slots, new Date(m.sent_at), tz);
  if (!slotStart) return maybeAutoReply(db, userId, messageId, { services: s });
  const start = new Date(slotStart);
  if (start.getTime() <= now.getTime()) return maybeAutoReply(db, userId, messageId, { services: s });

  // already booked for this reply (the funnel ran before, or the student tapped): the confirmation is what is left
  const [done] = await db.sql<{ external_id: string }>`
    select external_id from orbit.calendar_events
     where user_id = ${userId}::uuid and start_at = ${start}::timestamptz
       and ${m.from_person_id}::uuid = any(attendee_person_ids) and coalesce(status, 'confirmed') <> 'cancelled'`;
  let eventId = done?.external_id;
  // the calendar must still be free (plan 29 §B6): a slot taken since it was offered gets the slots reply instead
  if (!eventId && !(await slotStillFree(s, userId, start, userTz)))
    return maybeAutoReply(db, userId, messageId, { services: s });
  if (!eventId) {
    const booked = await bookSlot(
      s,
      userId,
      { draftId: offered.draft.id, slotStart },
      opts.appUrl ?? APP_URL,
      { actor: 'agent' },
    );
    if (booked.needsConsent) {
      // nothing can be booked until the student grants the calendar scope: the slots reply says the time works
      await maybeAutoReply(db, userId, messageId, { services: s });
      return { action: 'needs_consent', url: booked.needsConsent.url, slotStart };
    }
    eventId = booked.eventId!;
    await db.sql`update orbit.drafts set outcome = 'booked' where id = ${offered.draft.id}::uuid`;
    await db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${userId}::uuid, 'agent', 'call.booked', 'drafts', ${offered.draft.id},
              ${{ start: iso(start), eventId, messageId: m.id, personId: m.from_person_id }}::jsonb)`;
  }

  // the confirmation, in the thread, around the booked time and nothing else
  const label = slotLabel(start, new Date(start.getTime() + SLOT_MINUTES * 60_000), tz);
  const [existing] = await db.sql<DraftRow>`
    select * from orbit.drafts
     where user_id = ${userId}::uuid and ask->>'replyToMessageId' = ${m.id}
       and status not in ('discarded', 'cancelled')
     order by created_at desc limit 1`;
  let draft = existing;
  if (!draft) {
    try {
      draft = (
        await composeDraft(s, {
          userId,
          personId: m.from_person_id,
          kind: 'reply',
          channel: m.provider,
          replyToMessageId: m.id,
          actor: 'agent',
          confirmSlot: { start: slotStart, label },
        })
      ).draft;
    } catch (e) {
      if (e instanceof HttpError)
        return {
          action: 'booked',
          eventId,
          slotStart,
          draftId: offered.draft.id,
          confirmation: { action: 'none', reason: e.code },
        };
      throw e;
    }
  }
  const confirmation =
    draft.status !== 'draft'
      ? ({ action: 'auto_sent', draftId: draft.id } as AutoReplyOutcome)
      : // a confirmation answers someone who picked a time: the breaker (outreach only) never holds it
        await approveIfAllowed(s, userId, draft, 'scheduling', now, { offeredSlots: [slotStart] });
  return { action: 'booked', eventId, slotStart, draftId: draft.id, confirmation };
}
