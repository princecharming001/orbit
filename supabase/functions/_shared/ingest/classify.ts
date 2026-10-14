/**
 * Reply classification (§8.3, §8.6) for one stored inbound message:
 *   1. core `classifyReply` on the text (quotes and signature stripped there);
 *   2. below 0.75 confidence, and only when Claude is configured and within budget, Haiku classifies the newest
 *      message of the thread (oldest → newest, quotes stripped, at most 8 messages) with the §8.6 prompt and schema;
 *      any failure keeps the heuristic answer;
 *   3. messages.reply_class / reply_confidence / extraction are written;
 *   4. the user's sent draft the message answers (same thread, or In-Reply-To one of the user's sent messages) gets
 *      replied_at and reply_class;
 *   5. `unsubscribe` sets people.do_not_contact (honoured at once, §14.3);
 *   6. an intro request the sender was asked for moves to agreed (referral) or declined (decline) (§4.3).
 * The message text goes only to Claude; nothing is logged.
 */
import {
  classifyReply,
  REPLY_CLASS_LLM_THRESHOLD,
  REPLY_CLASSES,
  type ReplyClass,
} from '@orbit/core/email/replyClass';
import { stripQuotedReply } from '@orbit/core/text/email';
import { z } from 'zod/v4';
import type { Claude } from '../claude.ts';
import type { Db } from '../db.ts';
import { iso } from './util.ts';

export const REPLY_CLASSIFY_SYSTEM = `Classify the newest message in this thread as one of: interested, scheduling, question, objection, referral, not_now, out_of_office, decline, unsubscribe, thanks, other.
"unsubscribe" means they ask not to be contacted again. "referral" means they point to someone else. "not_now" means later, not never.
Extract proposed times (as written, with any time zone), a return date, referred people, and their question if any.`;

export const ReplyClassSchema = z.object({
  class: z.enum(REPLY_CLASSES as unknown as [ReplyClass, ...ReplyClass[]]),
  confidence: z.number(),
  proposed_times: z.array(z.string()),
  return_date: z.string().nullable(),
  referred_people: z.array(
    z.object({ name: z.string(), email: z.string().nullable(), org: z.string().nullable() }),
  ),
  question: z.string().nullable(),
});

export interface ClassifyResult {
  skipped?: 'not_found' | 'outbound' | 'automated' | 'no_text';
  replyClass?: ReplyClass;
  confidence?: number;
  by?: 'heuristic' | 'llm';
}

const THREAD_MAX = 8;

export async function classifyMessage(
  db: Db,
  userId: string,
  messageId: string,
  deps: { now: Date; claude?: Claude },
): Promise<ClassifyResult> {
  const [m] = await db.sql<{
    id: string;
    thread_id: string;
    direction: string;
    is_automated: boolean;
    from_person_id: string | null;
    in_reply_to: string | null;
    sent_at: unknown;
    body_text: string | null;
    snippet: string | null;
    thread_external_id: string;
    timezone: string;
  }>`
    select m.id, m.thread_id, m.direction, m.is_automated, m.from_person_id, m.in_reply_to, m.sent_at, m.body_text,
           m.snippet, t.external_id as thread_external_id, u.timezone
      from orbit.messages m join orbit.threads t on t.id = m.thread_id join orbit.users u on u.id = m.user_id
     where m.id = ${messageId}::uuid and m.user_id = ${userId}::uuid`;
  if (!m) return { skipped: 'not_found' };
  if (m.direction !== 'in') return { skipped: 'outbound' };
  if (m.is_automated) return { skipped: 'automated' };
  const text = (m.body_text ?? m.snippet ?? '').trim();
  if (!text) return { skipped: 'no_text' };
  const sentAt = iso(m.sent_at)!;

  // still waiting on an answer: the user's last sent draft to them has had no reply yet
  const awaiting = m.from_person_id
    ? (
        await db.sql`
          select 1 from orbit.drafts where user_id = ${userId}::uuid and person_id = ${m.from_person_id}::uuid
             and status = 'sent' and replied_at is null and sent_at <= ${sentAt}::timestamptz limit 1`
      ).length > 0
    : false;
  const h = classifyReply(text, {
    now: new Date(sentAt),
    timeZone: m.timezone,
    direction: 'inbound',
    awaitingAnswer: awaiting,
  });
  let cls: ReplyClass = h.class;
  let confidence = h.confidence;
  let by: 'heuristic' | 'llm' = 'heuristic';
  let llm: z.infer<typeof ReplyClassSchema> | undefined;

  if (confidence < REPLY_CLASS_LLM_THRESHOLD && deps.claude?.configured) {
    const thread = await db.sql<{
      direction: string;
      sent_at: unknown;
      body_text: string | null;
      snippet: string | null;
    }>`
      select direction, sent_at, body_text, snippet from orbit.messages
       where thread_id = ${m.thread_id}::uuid and sent_at <= ${sentAt}::timestamptz
       order by sent_at desc limit ${THREAD_MAX}::int`;
    const lines = thread
      .reverse()
      .map(
        (x) =>
          `<message from="${x.direction === 'out' ? 'me' : 'them'}" at="${iso(x.sent_at)}">\n${stripQuotedReply(
            x.body_text ?? x.snippet ?? '',
          ).slice(0, 4000)}\n</message>`,
      );
    const r = await deps.claude.structured({
      task: 'classify',
      system: REPLY_CLASSIFY_SYSTEM,
      user: `<thread>\n${lines.join('\n')}\n</thread>`,
      schema: ReplyClassSchema,
      userId,
    });
    if (r.ok) {
      llm = r.data;
      cls = r.data.class;
      confidence = Math.max(0, Math.min(1, r.data.confidence));
      by = 'llm';
    }
  }

  const extraction = {
    ...h.extraction,
    classifiedBy: by,
    signal: h.signal,
    ...(llm
      ? {
          llm: {
            proposedTimes: llm.proposed_times,
            returnDate: llm.return_date,
            referredPeople: llm.referred_people,
            question: llm.question,
          },
        }
      : {}),
    ...(h.question && !llm ? { question: h.question } : {}),
  };
  await db.sql`
    update orbit.messages set reply_class = ${cls}, reply_confidence = ${confidence}::real,
           extraction = ${extraction}::jsonb
     where id = ${m.id}::uuid`;

  // the sent draft this answers
  await db.sql`
    update orbit.drafts set replied_at = ${sentAt}::timestamptz, reply_class = ${cls}
     where id = (
       select d.id from orbit.drafts d
        where d.user_id = ${userId}::uuid and d.status = 'sent' and d.replied_at is null
          and d.sent_at <= ${sentAt}::timestamptz
          and (d.thread_external_id = ${m.thread_external_id}
            or d.provider_message_id in (
                 select o.external_id from orbit.messages o
                  where o.user_id = ${userId}::uuid and o.direction = 'out'
                    and o.rfc_message_id = ${m.in_reply_to ?? ''}))
        order by d.sent_at desc limit 1)`;

  if (cls === 'unsubscribe' && m.from_person_id) {
    await db.sql`
      update orbit.people set do_not_contact = true
       where id = ${m.from_person_id}::uuid and user_id = ${userId}::uuid and not do_not_contact`;
    await db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${userId}::uuid, 'system', 'people.do_not_contact', 'people', ${m.from_person_id},
              ${{ reason: 'unsubscribe', messageId: m.id }}::jsonb)`;
  }

  if ((cls === 'referral' || cls === 'decline') && m.from_person_id)
    await db.sql`
      update orbit.intro_requests set status = ${cls === 'referral' ? 'agreed' : 'declined'},
             outcome_at = ${sentAt}::timestamptz
       where id = (
         select r.id from orbit.intro_requests r
          where r.user_id = ${userId}::uuid and r.introducer_person_id = ${m.from_person_id}::uuid
            and r.status = 'asked' and r.asked_at <= ${sentAt}::timestamptz
            and exists (select 1 from orbit.drafts d
                         where d.user_id = ${userId}::uuid and d.person_id = r.introducer_person_id
                           and d.kind = 'intro_request' and d.status = 'sent'
                           and d.thread_external_id = ${m.thread_external_id})
          order by r.asked_at desc limit 1)`;

  return { replyClass: cls, confidence, by };
}
