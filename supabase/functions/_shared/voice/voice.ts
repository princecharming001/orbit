/**
 * The student's voice on the server (plan 29 §B2.4).
 *
 * The card: the browser learns it from what the student wrote and sends it through /settings/profile
 * (`users.settings.style_card`, shape checked here); `voice.card` rebuilds it from the sent mail the server holds when
 * the student asks to relearn. Exemplars: every sent Gmail message of 25 words or more gets an embedding through the
 * same gte-small adapter the memories use, as it is ingested (never blocking the ingest) and, for mail stored before
 * that, through `voice.embed_sent`, which embeds the last 200 for one user on demand. Edits: a server draft keeps the
 * words Orbit wrote (`body_original`), so an edited approve or an edit pushed from a browser writes one
 * orbit.draft_edits row per draft, the distillation's evidence. Notes: `voice.distill` reads the last thirty edits
 * into at most eight notes (users.settings.voice_notes) the student keeps or forgets; drafting reads the ones in force
 * into the card (compose/context.ts styleCardOf).
 */
import type { VoiceNote, VoiceResponse } from '@orbit/core/server/api';
import { buildStyleCard, defaultStyleCard, mergeStyleCard, STYLE_MIN_SAMPLES } from '@orbit/core/style/card';
import {
  activeVoiceNotes,
  cardProse,
  decideVoiceNote,
  editObservations,
  type LearnedNote,
  meanVoiceScore,
  mergeVoiceNotes,
  VOICE_DISTILL_SYSTEM,
  VOICE_EDITS_FOR_DISTILL,
  VOICE_JUDGE_MIN,
  VOICE_JUDGE_SYSTEM,
  VOICE_NOTES_MAX,
  type VoiceEdit,
  voiceCheck,
  voiceDistillUser,
  voiceJudgeUser,
  voiceScore,
  wordEditDistance,
} from '@orbit/core/style/voice';
import { stripQuotedReply, wordCount } from '@orbit/core/text/email';
import type { StyleCard } from '@orbit/core/types';
import { z } from 'zod/v4';
import type { ClaudeResult } from '../claude.ts';
import { exemplars } from '../compose/context.ts';
import type { Db } from '../db.ts';
import { embeddable } from '../memory/memory.ts';
import type { Queue } from '../queue.ts';
import { vec } from '../rows.ts';
import type { Embed, Services } from '../services.ts';
import { NO_SOURCES } from '../sources/states.ts';

/** Sent mail shorter than this is not an example of how the student writes (the exemplars' own floor). */
export const EXEMPLAR_MIN_WORDS = 25;
/** `voice.embed_sent` embeds this many of the newest sent messages. */
export const EMBED_SENT_LIMIT = 200;
/** The card is rebuilt from at most this many sent messages, newest first. */
const CARD_SAMPLES = 150;

// ---- the card as the browser sends it -----------------------------------------------------------------------------

const text = (max: number) => z.string().max(max);
const list = (n: number, max: number) => z.array(text(max)).max(n);

/** What a style card may hold; anything else is refused, so a malformed card never reaches a prompt. */
export const StyleCardS = z.object({
  greetingPatterns: list(6, 80),
  signoffs: list(6, 160),
  formality: z.number().min(0).max(1),
  avgSentenceWords: z.number().min(0).max(200),
  avgMessageWords: z.number().min(0).max(2000),
  contractions: z.boolean(),
  exclamationsPerMessage: z.number().min(0).max(50),
  emoji: z.boolean(),
  characteristicPhrases: list(12, 120),
  avoid: list(50, 120),
  notes: text(4000),
  builtFromCount: z.number().int().min(0).max(1_000_000),
  version: z.number().int().min(0).max(1000),
  sources: z
    .partialRecord(z.enum(['email', 'linkedin', 'orbit', 'pasted']), z.number().int().min(0))
    .optional(),
  custom: z.boolean().optional(),
});

/** The card from a request: undefined leaves it, null removes it, and a card of the wrong shape is refused. */
export function parseStyleCard(v: unknown): StyleCard | null | undefined | { error: string } {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const r = StyleCardS.safeParse(v);
  if (!r.success) {
    const i = r.error.issues[0];
    return { error: `styleCard.${i?.path.join('.') || 'card'}: ${i?.message ?? 'invalid'}` };
  }
  return r.data as StyleCard;
}

// ---- sent mail into embeddings ---------------------------------------------------------------------------------

/** One embedding, or null for text gte-small cannot read (mostly non-Latin), a missing model, or any failure. */
export async function embedSafely(embed: Embed, raw: string): Promise<number[] | null> {
  const t = raw.trim().slice(0, 2000);
  if (!t || !embeddable(t)) return null;
  try {
    const e = await embed(t);
    return e?.length ? e : null;
  } catch {
    return null;
  }
}

/** What a sent message is embedded as: its own words, the quoted thread below them left out. */
export function exemplarText(body: string | null): string | null {
  if (!body) return null;
  const t = stripQuotedReply(body).trim();
  return wordCount(t) >= EXEMPLAR_MIN_WORDS ? t : null;
}

/**
 * Embeds the given sent messages one after another and stores each vector. The first null answer for a readable
 * text means the model is not there: the rest are left for `voice.embed_sent`. Never throws.
 */
export async function embedMessages(
  db: Db,
  embed: Embed | undefined,
  rows: { id: string; body: string | null }[],
): Promise<number> {
  if (!embed) return 0;
  let n = 0;
  for (const r of rows) {
    const t = exemplarText(r.body);
    if (!t) continue;
    const e = await embedSafely(embed, t);
    if (!e) {
      if (embeddable(t)) break;
      continue;
    }
    try {
      await db.sql`update orbit.messages set embedding = ${vec(e)}::vector where id = ${r.id}::uuid`;
      n++;
    } catch {
      // a failed write leaves this one for the backfill
    }
  }
  return n;
}

/** `voice.embed_sent`: the newest sent messages without an embedding, up to `limit`, embedded now. */
export async function embedSent(
  db: Db,
  embed: Embed,
  userId: string,
  limit = EMBED_SENT_LIMIT,
): Promise<{ embedded: number; looked: number }> {
  const rows = await db.sql<{ id: string; body_text: string | null }>`
    select id, body_text from orbit.messages
     where user_id = ${userId}::uuid and direction = 'out' and body_text is not null and not is_automated
     order by sent_at desc limit ${limit}::int`;
  const todo = rows.filter((r) => r.body_text);
  const missing = await db.sql<{ id: string }>`
    select id from orbit.messages where id = any(${todo.map((r) => r.id)}::uuid[]) and embedding is null`;
  const want = new Set(missing.map((r) => r.id));
  const embedded = await embedMessages(
    db,
    embed,
    todo.filter((r) => want.has(r.id)).map((r) => ({ id: r.id, body: r.body_text })),
  );
  return { embedded, looked: rows.length };
}

// ---- the card from sent mail ----------------------------------------------------------------------------------

/**
 * `voice.card`: the card learned again from the sent mail the server holds, laid over the stored one the way the
 * browser does it (what the student set by hand wins). With too few messages the stored card stays.
 */
export async function relearnCard(
  db: Db,
  userId: string,
  now: Date,
  /** message providers of the optional sources out of use (plan 43 §3.2): never learned from */
  excludedProviders: readonly string[] = NO_SOURCES.excluded.providers,
): Promise<StyleCard | null> {
  const [u] = await db.sql<{
    settings: Record<string, unknown>;
    first_name: string | null;
    full_name: string | null;
  }>`
    select settings, first_name, full_name from orbit.users where id = ${userId}::uuid`;
  if (!u) return null;
  const sent = await db.sql<{ body_text: string }>`
    select body_text from orbit.messages
     where user_id = ${userId}::uuid and direction = 'out' and body_text is not null and not is_automated
       and provider <> all(${[...excludedProviders]}::text[])
     order by sent_at desc limit ${CARD_SAMPLES}::int`;
  const first = u.first_name ?? u.full_name?.split(/\s+/)[0] ?? '';
  const preset = u.settings?.tone_preset;
  const learned = buildStyleCard(
    sent.map((m) => stripQuotedReply(m.body_text)),
    first,
    preset === 'direct' || preset === 'formal' ? preset : 'warm',
  );
  if (learned.builtFromCount === 0) return null;
  const stored = StyleCardS.safeParse(u.settings?.style_card);
  const card = mergeStyleCard(learned, stored.success ? (stored.data as StyleCard) : undefined);
  await db.sql`
    update orbit.users set settings = settings || jsonb_build_object('style_card', ${card}::jsonb,
                                                                     'voice_relearned_at', ${now.toISOString()}::text)
     where id = ${userId}::uuid`;
  return card;
}

// ---- edits --------------------------------------------------------------------------------------------------------

/** Two bodies are the same words when they match after whitespace is evened out. */
const sameWords = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/**
 * One edited draft into orbit.draft_edits: what Orbit first wrote (`body_original`) against the body as it stands.
 * Nothing when the words are the same; an edit made again replaces the draft's row. Returns whether a row was written.
 */
export async function recordDraftEdit(
  db: Db,
  d: {
    id: string;
    user_id: string;
    kind: string;
    body: string;
    body_original?: string | null;
    ask?: { replyToMessageId?: string } | null;
  },
): Promise<boolean> {
  const before = d.body_original;
  if (!before || sameWords(before, d.body)) return false;
  const distance = wordEditDistance(before, d.body);
  const replyTo = d.ask?.replyToMessageId;
  const [m] = replyTo
    ? await db.sql<{ reply_class: string | null }>`
        select reply_class from orbit.messages where id = ${replyTo}::uuid and user_id = ${d.user_id}::uuid`
    : [];
  const cls = m?.reply_class ?? null;
  const updated = await db.sql`
    update orbit.draft_edits set after = ${d.body}, distance = ${distance}::int, reply_class = coalesce(${cls}, reply_class)
     where draft_id = ${d.id}::uuid and user_id = ${d.user_id}::uuid returning id`;
  if (updated.length) return true;
  await db.sql`
    insert into orbit.draft_edits (user_id, draft_id, kind, reply_class, before, after, distance)
    values (${d.user_id}::uuid, ${d.id}::uuid, ${d.kind}, ${cls}, ${before}, ${d.body}, ${distance}::int)
    on conflict (draft_id) where draft_id is not null do update
      set after = excluded.after, distance = excluded.distance`;
  return true;
}

/**
 * An edit a browser recorded (`/sync/push`, table draft_edits): kept under its own id, or folded into the row the
 * server already has for the same draft. The draft is named only when it is the student's own.
 */
export async function pushDraftEdit(
  db: Db,
  userId: string,
  id: string,
  e: {
    draftId?: string | null;
    kind: string;
    replyClass?: string | null;
    before: string;
    after: string;
    distance: number;
    createdAt?: string | null;
  },
): Promise<Record<string, unknown> | undefined> {
  const [own] = e.draftId
    ? await db.sql<{ id: string }>`
        select id from orbit.drafts where id = ${e.draftId}::uuid and user_id = ${userId}::uuid`
    : [];
  const draftId = own?.id ?? null;
  if (draftId) {
    const [r] = await db.sql<Record<string, unknown>>`
      update orbit.draft_edits set after = ${e.after}, distance = ${e.distance}::int
       where draft_id = ${draftId}::uuid and user_id = ${userId}::uuid and id <> ${id}::uuid
      returning id, draft_id, kind, distance, created_at`;
    if (r) return r;
  }
  const [r] = await db.sql<Record<string, unknown>>`
    insert into orbit.draft_edits (id, user_id, draft_id, kind, reply_class, before, after, distance, created_at)
    values (${id}::uuid, ${userId}::uuid, ${draftId}::uuid, ${e.kind}, ${e.replyClass ?? null}, ${e.before}, ${e.after},
            ${e.distance}::int, coalesce(${e.createdAt ?? null}::timestamptz, now()))
    on conflict (id) do update set after = excluded.after, distance = excluded.distance
     where orbit.draft_edits.user_id = ${userId}::uuid
    returning id, draft_id, kind, distance, created_at`;
  // undefined: the id is another student's row
  return r;
}

// ---- notes learned from the edits --------------------------------------------------------------------------------

/** The notes stored for a user (users.settings.voice_notes), the malformed ones left out. */
export function notesOf(settings: Record<string, unknown> | null | undefined): VoiceNote[] {
  const v = settings?.voice_notes;
  if (!Array.isArray(v)) return [];
  return v.filter(
    (n): n is VoiceNote =>
      !!n &&
      typeof n === 'object' &&
      typeof (n as VoiceNote).id === 'string' &&
      typeof (n as VoiceNote).text === 'string' &&
      Array.isArray((n as VoiceNote).evidence),
  );
}

/** The card a user's drafts follow: their own (learned or set), else the tone preset. */
export function storedCard(settings: Record<string, unknown>, firstName: string): StyleCard {
  const c = StyleCardS.safeParse(settings?.style_card);
  if (c.success && ((c.data.builtFromCount ?? 0) >= STYLE_MIN_SAMPLES || c.data.custom))
    return c.data as StyleCard;
  const preset = settings?.tone_preset;
  return defaultStyleCard(preset === 'direct' || preset === 'formal' ? preset : 'warm', firstName);
}

const DistillS = z.object({
  notes: z
    .array(
      z.object({
        text: z.string().max(400),
        // "" when the note is not about one phrase
        avoid: z.string().max(200),
        evidence: z.array(z.string().max(80)).max(40),
      }),
    )
    .max(VOICE_NOTES_MAX * 2),
});

export interface DistillResult {
  /**
   * how the notes were found: Claude, the plain observations without it, nothing (new) to read yet, or the edits
   * sent through Message Batches (the notes are merged when the answer comes, `applyDistill`)
   */
  by: 'claude' | 'observations' | 'too_few_edits' | 'batched';
  added: VoiceNote[];
  notes: VoiceNote[];
}

/** The newest edit time a distillation has read (users.settings.voice_distilled_at); the next reads only later ones. */
export const DISTILLED_AT = 'voice_distilled_at';

type EditRow = { id: string; kind: string; before: string; after: string; created_at: Date | string };

/**
 * `voice.distill`: the edits since the last distillation (plan 35 C1: the last thirty were re-read every night) and
 * the card to Claude, with the notes the student kept and forgot, which answers at most eight one-line notes in the
 * student's words, each with the edits behind it; without Claude (no key, the budget spent, a refusal) the plain
 * observations stand in. `full` (a relearn, or no distillation yet) reads the last thirty. The notes are merged into
 * users.settings.voice_notes inside one transaction against the notes as they are then, so a note forgotten while
 * Claude was reading stays forgotten and is never learned again; notes learned earlier stay unless pushed out.
 * `batch` (the nightly job) sends the edits through Message Batches when it can (plan 35 C2).
 */
export async function distillVoice(
  s: Services,
  userId: string,
  opts: { full?: boolean; batch?: boolean } = {},
): Promise<DistillResult> {
  const db = s.db;
  const [u] = await db.sql<{ settings: Record<string, unknown>; first_name: string | null }>`
    select settings, first_name from orbit.users where id = ${userId}::uuid`;
  const last = u?.settings?.[DISTILLED_AT];
  const since = !opts.full && typeof last === 'string' && !Number.isNaN(Date.parse(last)) ? last : null;
  const rows = await db.sql<EditRow>`
    select id, kind, before, after, created_at from orbit.draft_edits
     where user_id = ${userId}::uuid and (${since}::timestamptz is null or created_at > ${since}::timestamptz)
     order by created_at desc limit ${VOICE_EDITS_FOR_DISTILL}::int`;
  // nothing new since the last reading; or, the first time, too little to read anything from
  if (!u || rows.length === 0 || (!since && rows.length < 2))
    return { by: 'too_few_edits', added: [], notes: notesOf(u?.settings) };
  const current = notesOf(u.settings);
  const card = storedCard(u.settings ?? {}, u.first_name ?? '');
  const edits: VoiceEdit[] = rows.map((r) => ({ id: r.id, kind: r.kind, before: r.before, after: r.after }));
  const request = {
    task: 'voice_distill' as const,
    system: VOICE_DISTILL_SYSTEM,
    user: voiceDistillUser({
      card,
      edits,
      kept: current.filter((n) => n.keptAt && !n.forgottenAt).map((n) => n.text),
      forgotten: current.filter((n) => n.forgottenAt).map((n) => n.text),
    }),
    schema: DistillS,
    userId,
  };
  if (opts.batch && s.claude.structuredBatch && s.claude.batching) {
    const q = await s.claude.structuredBatch(request, {
      handler: 'voice.distill',
      payload: { editIds: rows.map((r) => r.id) },
      dedupeKey: `voice.distill:${userId}`,
    });
    if (q.queued || q.reason === 'duplicate') return { by: 'batched', added: [], notes: current };
  }
  return applyDistill(s, userId, rows, await s.claude.structured(request));
}

/** A batched distillation's answer (batchJobs.ts): the same edits, read back by id, and the notes merged. */
export async function distillFromBatch(
  s: Services,
  userId: string,
  editIds: string[],
  answer: (schema: typeof DistillS) => Promise<ClaudeResult<z.infer<typeof DistillS>>>,
): Promise<DistillResult> {
  const rows = await s.db.sql<EditRow>`
    select id, kind, before, after, created_at from orbit.draft_edits
     where user_id = ${userId}::uuid and id = any(${editIds}::uuid[]) order by created_at desc`;
  const r = await answer(DistillS);
  if (!rows.length) {
    const [u] = await s.db.sql<{ settings: Record<string, unknown> }>`
      select settings from orbit.users where id = ${userId}::uuid`;
    return { by: 'too_few_edits', added: [], notes: notesOf(u?.settings) };
  }
  return applyDistill(s, userId, rows, r);
}

async function applyDistill(
  s: Services,
  userId: string,
  rows: EditRow[],
  r: ClaudeResult<z.infer<typeof DistillS>>,
): Promise<DistillResult> {
  const edits: VoiceEdit[] = rows.map((x) => ({ id: x.id, kind: x.kind, before: x.before, after: x.after }));
  const ids = new Set(edits.map((e) => e.id));
  let by: DistillResult['by'] = 'observations';
  let learned: LearnedNote[];
  if (r.ok) {
    by = 'claude';
    learned = r.data.notes
      .map((n) => ({
        text: n.text,
        avoid: n.avoid.trim() || null,
        evidence: n.evidence.filter((e) => ids.has(e)),
      }))
      // a note with nothing behind it is a guess
      .filter((n) => n.evidence.length > 0)
      .slice(0, VOICE_NOTES_MAX);
  } else learned = editObservations(edits);
  // the newest edit read: one made while Claude was reading is read next time
  const newest = rows.map((x) => new Date(x.created_at).getTime()).reduce((a, b) => Math.max(a, b), 0);
  const out = await s.db.begin(async (tx) => {
    const [fresh] = await tx.sql<{ settings: Record<string, unknown> }>`
      select settings from orbit.users where id = ${userId}::uuid for update`;
    const merged = mergeVoiceNotes(notesOf(fresh?.settings), learned, {
      now: s.now(),
      newId: () => crypto.randomUUID(),
    });
    const prior = fresh?.settings?.[DISTILLED_AT];
    const mark = Math.max(newest, typeof prior === 'string' ? Date.parse(prior) || 0 : 0);
    await tx.sql`
      update orbit.users set settings = settings || jsonb_build_object('voice_notes', ${JSON.stringify(merged.notes)}::jsonb,
                                                                       'voice_relearned_at', ${s.now().toISOString()}::text,
                                                                       ${DISTILLED_AT}::text, ${new Date(mark).toISOString()}::text)
       where id = ${userId}::uuid`;
    return merged;
  });
  return { by, added: out.added, notes: out.notes };
}

/** Keep or forget one note; a forgotten one stays stored so the distillation never brings it back. */
export async function decideNote(
  db: Db,
  userId: string,
  id: string,
  action: 'keep' | 'forget',
  now: Date,
): Promise<VoiceNote | undefined> {
  return db.begin(async (tx) => {
    const [u] = await tx.sql<{ settings: Record<string, unknown> }>`
      select settings from orbit.users where id = ${userId}::uuid for update`;
    const r = decideVoiceNote(notesOf(u?.settings), id, action, now);
    if (!r.note) return undefined;
    await tx.sql`
      update orbit.users set settings = settings || jsonb_build_object('voice_notes', ${JSON.stringify(r.notes)}::jsonb)
       where id = ${userId}::uuid`;
    return r.note;
  });
}

/** Recent drafts read for "sounds like you": the newest twenty Orbit wrote in the last thirty days. */
const SCORE_DRAFTS = 20;

/**
 * GET /voice: the card and its sentences, the notes in force, and how much the recent drafts sound like the
 * student (0 to 3: the judge's scores where it ran, the voice check's elsewhere; null with no recent drafts).
 */
export async function voiceStatus(db: Db, userId: string, now: Date): Promise<VoiceResponse> {
  const [u] = await db.sql<{ settings: Record<string, unknown>; first_name: string | null }>`
    select settings, first_name from orbit.users where id = ${userId}::uuid`;
  const settings = u?.settings ?? {};
  const stored = StyleCardS.safeParse(settings.style_card);
  const card = storedCard(settings, u?.first_name ?? '');
  const notes = notesOf(settings);
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const drafts = await db.sql<{ id: string; subject: string | null; body: string }>`
    select id, subject, coalesce(body_original, body) as body from orbit.drafts
     where user_id = ${userId}::uuid and created_at >= ${since}::timestamptz and channel = 'gmail'
       and status in ('draft', 'approved', 'scheduled', 'sending', 'sent')
     order by created_at desc limit ${SCORE_DRAFTS}::int`;
  const judged = new Map(
    (
      await db.sql<{ target_id: string; score: number }>`
        select target_id, (details->>'score')::int as score from orbit.audit_log
         where user_id = ${userId}::uuid and action = 'draft.voice_judge' and created_at >= ${since}::timestamptz`
    ).map((r) => [r.target_id, Number(r.score)]),
  );
  const scores = drafts.map((d) =>
    judged.has(d.id) ? judged.get(d.id)! : voiceScore(voiceCheck(d, { card, notes })),
  );
  const relearned = settings.voice_relearned_at;
  return {
    card: stored.success ? (stored.data as StyleCard) : null,
    cardProse: cardProse(card),
    notes: activeVoiceNotes(notes),
    soundsLikeYou: meanVoiceScore(scores),
    relearnedAt: typeof relearned === 'string' ? relearned : null,
  };
}

/**
 * POST /voice/relearn: the sent mail embedded (the exemplars), the card learned again from it, and the edits read
 * into notes, as three background jobs, at most once a minute.
 */
export async function queueRelearn(queue: Queue, userId: string, now: Date): Promise<boolean> {
  const minute = now.toISOString().slice(0, 16);
  const a = await queue.enqueue({
    kind: 'voice.embed_sent',
    userId,
    payload: { limit: EMBED_SENT_LIMIT },
    dedupeKey: `voice.embed_sent:${userId}:${minute}`,
  });
  await queue.enqueue({
    kind: 'voice.card',
    userId,
    payload: {},
    dedupeKey: `voice.card:${userId}:${minute}`,
  });
  await queue.enqueue({
    kind: 'voice.distill',
    userId,
    payload: { reason: 'relearn' },
    dedupeKey: `voice.distill:${userId}:${minute}`,
  });
  return a !== null;
}

// ---- the check before Orbit sends on its own ----------------------------------------------------------------------

const JudgeS = z.object({ score: z.number().int().min(0).max(3), reason: z.string().max(400) });

/**
 * The judge for an auto first message (plan 29 §B2.4c): Claude reads the draft beside the student's closest sent
 * mail and answers 0 to 3, "written by the same person?". Undefined when it cannot run (fewer than two exemplars, no
 * key, the budget spent): the caller then holds the draft for a tap. Every score is kept in the audit log, where
 * "sounds like you" reads it.
 */
export async function judgeVoice(
  s: Pick<Services, 'claude' | 'db'>,
  userId: string,
  draft: { id: string; subject: string | null; body: string },
  examples: string[],
): Promise<{ score: number; reason: string } | undefined> {
  if (examples.length < 2) return undefined;
  const r = await s.claude.structured({
    task: 'voice_judge',
    system: VOICE_JUDGE_SYSTEM,
    user: voiceJudgeUser(draft, examples),
    schema: JudgeS,
    userId,
  });
  if (!r.ok) return undefined;
  await s.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'system', 'draft.voice_judge', 'drafts', ${draft.id},
            ${{ score: r.data.score, reason: r.data.reason }}::jsonb)`;
  return r.data;
}

export type VoiceGate = { ok: true } | { ok: false; problems: string[]; score?: number };

/**
 * Before Orbit sends a draft it approved itself (plan 29 §B6): the voice check against the card, the notes in force
 * and the student's closest sent mail; for a first message also the judge, which must say 2 or more. A failure is the
 * list of what did not sound like them, in their words.
 */
export async function voiceGate(
  s: Pick<Services, 'claude' | 'db' | 'embed'>,
  u: { settings: Record<string, unknown>; first_name: string | null },
  d: { id: string; user_id: string; person_id: string; kind: string; subject: string | null; body: string },
  opts: { firstMessage: boolean },
): Promise<VoiceGate> {
  const card = storedCard(u.settings ?? {}, u.first_name ?? '');
  const notes = notesOf(u.settings);
  const examples = await exemplars(
    s,
    d.user_id,
    d.person_id,
    `${d.kind} ${d.subject ?? ''} ${d.body.slice(0, 400)}`,
  ).catch(() => [] as string[]);
  const check = voiceCheck({ body: d.body, subject: d.subject }, { card, notes, exemplars: examples });
  if (!check.ok) return { ok: false, problems: check.problems.map((p) => p.detail) };
  if (!opts.firstMessage) return { ok: true };
  const judged = await judgeVoice(s, d.user_id, d, examples);
  if (!judged)
    return { ok: false, problems: ['Orbit could not compare it with enough of your sent mail to be sure.'] };
  if (judged.score < VOICE_JUDGE_MIN) return { ok: false, problems: [judged.reason], score: judged.score };
  return { ok: true };
}
