/**
 * The student's voice on the server (plan 29 §B2.4).
 *
 * The card: the browser learns it from what the student wrote and sends it through /settings/profile
 * (`users.settings.style_card`, shape checked here); `voice.card` rebuilds it from the sent mail the server holds when
 * the student asks to relearn. Exemplars: every sent Gmail message of 25 words or more gets an embedding through the
 * same gte-small adapter the memories use, as it is ingested (never blocking the ingest) and, for mail stored before
 * that, through `voice.embed_sent`, which embeds the last 200 for one user on demand. Edits: a server draft keeps the
 * words Orbit wrote (`body_original`), so an edited approve or an edit pushed from a browser writes one
 * orbit.draft_edits row per draft, the distillation's evidence.
 */
import { buildStyleCard, mergeStyleCard } from '@orbit/core/style/card';
import { wordEditDistance } from '@orbit/core/style/voice';
import { stripQuotedReply, wordCount } from '@orbit/core/text/email';
import type { StyleCard } from '@orbit/core/types';
import { z } from 'zod/v4';
import type { Db } from '../db.ts';
import { embeddable } from '../memory/memory.ts';
import { vec } from '../rows.ts';
import type { Embed } from '../services.ts';

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
export async function relearnCard(db: Db, userId: string, now: Date): Promise<StyleCard | null> {
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
