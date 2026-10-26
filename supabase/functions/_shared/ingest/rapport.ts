/**
 * Reply rapport on the server (plan 27): how warm one stored inbound message reads toward the student, written to
 * messages.extraction.rapport after the reply classifier has run (classification rewrites the extraction). The
 * lexical reading (core `replyRapport` with VADER valence) always; Haiku's reading replaces it when Claude is
 * configured, the reply has some length and the student has not turned the tone reading off. The text goes only to
 * Claude; nothing is logged.
 *
 * `backfillRapport` reads up to a year of a user's stored replies that have no reading yet: lexical for all of them,
 * Haiku for the newest few, then everyone is rescored (rapport.backfill, once per user per version).
 */
import {
  RAPPORT_CUES,
  RAPPORT_LLM_GUIDE,
  type RapportReading,
  rapportFromLlm,
  replyRapport,
} from '@orbit/core/scoring/rapport';
import { vaderValence } from '@orbit/core/scoring/vader';
import { stripQuotedReply } from '@orbit/core/text/email';
import { z } from 'zod/v4';
import type { Claude } from '../claude.ts';
import type { Db } from '../db.ts';

export const RAPPORT_SYSTEM = `You read a message someone wrote to a student and judge ${RAPPORT_LLM_GUIDE}`;

export const RapportSchema = z.object({
  warmth: z.number(),
  familiarity: z.enum(['stranger', 'professional', 'friendly', 'friend']),
  effort: z.number(),
  cues: z.array(z.enum(RAPPORT_CUES)),
});

/** Replies shorter than this keep the lexical reading: there is little for the model to read. */
const LLM_MIN_CHARS = 20;

type MessageRow = {
  id: string;
  thread_id: string;
  from_person_id: string | null;
  direction: string;
  is_automated: boolean;
  body_text: string | null;
  snippet: string | null;
  sent_at: unknown;
  first_name: string | null;
  tone: boolean | null;
};

async function loadMessages(
  db: Db,
  userId: string,
  where: { ids?: string[]; since?: string; limit?: number },
) {
  return db.sql<MessageRow>`
    select m.id, m.thread_id, m.from_person_id, m.direction, m.is_automated, m.body_text, m.snippet, m.sent_at,
           u.first_name, (u.settings ->> 'read_reply_tone')::boolean as tone
      from orbit.messages m join orbit.users u on u.id = m.user_id
     where m.user_id = ${userId}::uuid and m.direction = 'in' and not m.is_automated
       and coalesce(m.body_text, m.snippet) is not null
       and (${where.ids ?? null}::uuid[] is null or m.id = any(${where.ids ?? null}::uuid[]))
       and (${where.since ?? null}::timestamptz is null
            or (m.sent_at > ${where.since ?? null}::timestamptz and not (coalesce(m.extraction, '{}'::jsonb) ? 'rapport')))
     order by m.sent_at desc
     limit ${where.limit ?? 1000}::int`;
}

/** The student's message the reply answers: their last one before it in the thread. */
async function answering(db: Db, m: MessageRow): Promise<string | undefined> {
  const [row] = await db.sql<{ body_text: string | null; snippet: string | null }>`
    select body_text, snippet from orbit.messages
     where thread_id = ${m.thread_id}::uuid and direction = 'out' and sent_at < ${m.sent_at}::timestamptz
     order by sent_at desc limit 1`;
  const t = row?.body_text ?? row?.snippet;
  return t ? stripQuotedReply(t) : undefined;
}

async function readOne(
  db: Db,
  userId: string,
  m: MessageRow,
  claude: Claude | undefined,
  useLlm: boolean,
): Promise<RapportReading> {
  const text = stripQuotedReply(m.body_text ?? m.snippet ?? '').trim();
  const prior = await answering(db, m);
  let reading = replyRapport({
    text,
    studentFirstName: m.first_name ?? undefined,
    answering: prior,
    valence: vaderValence,
  });
  if (useLlm && m.tone !== false && claude?.configured && text.length >= LLM_MIN_CHARS) {
    const r = await claude.structured({
      task: 'classify',
      system: RAPPORT_SYSTEM,
      user: `${prior ? `<student>\n${prior.slice(0, 1500)}\n</student>\n` : ''}<reply>\n${text.slice(0, 3000)}\n</reply>`,
      schema: RapportSchema,
      userId,
    });
    if (r.ok) reading = rapportFromLlm(r.data);
  }
  await db.sql`
    update orbit.messages set extraction = coalesce(extraction, '{}'::jsonb) || jsonb_build_object('rapport', ${reading}::jsonb)
     where id = ${m.id}::uuid`;
  return reading;
}

/** Reads one stored inbound message; returns the person to rescore, or undefined when it is not a human reply. */
export async function readRapport(
  db: Db,
  userId: string,
  messageId: string,
  deps: { claude?: Claude },
): Promise<{ personId?: string; reading?: RapportReading }> {
  const [m] = await loadMessages(db, userId, { ids: [messageId], limit: 1 });
  if (!m) return {};
  const reading = await readOne(db, userId, m, deps.claude, true);
  return { personId: m.from_person_id ?? undefined, reading };
}

export const RAPPORT_BACKFILL_DAYS = 365;
/** Replies the model reads in a backfill, newest first; the rest keep the lexical reading. */
export const RAPPORT_BACKFILL_LLM = 60;

/** A year of stored replies without a reading get one. Returns how many were read. */
export async function backfillRapport(
  db: Db,
  userId: string,
  deps: { claude?: Claude; now: Date },
): Promise<number> {
  const since = new Date(deps.now.getTime() - RAPPORT_BACKFILL_DAYS * 86_400_000).toISOString();
  const rows = await loadMessages(db, userId, { since, limit: 2000 });
  let n = 0;
  for (const m of rows) {
    await readOne(db, userId, m, deps.claude, n < RAPPORT_BACKFILL_LLM);
    n++;
  }
  return n;
}
