/**
 * Long-term memory (§10): durable statements about the user or a person, embedded with gte-small (384 dims) through
 * an injectable `embed`. Adding text within cosine 0.92 of an existing memory refreshes that one instead; search
 * ranks by 0.7·cosine + 0.2·importance + 0.1·recency (30-day half-life on last_seen_at), and falls back to keyword
 * overlap for memories without an embedding (non-English text, or no model). Forget is a soft delete.
 * `extractMemories` is the §10.6 Haiku pass the chat runs after a turn; a memory whose quote is not the user's own
 * words is dropped, and sensitive categories are never extracted automatically.
 */
import type { MemoryItem, MemoryKind } from '@orbit/core/server/api';
import { z } from 'zod/v4';
import type { Claude } from '../claude.ts';
import type { Db } from '../db.ts';
import { HttpError } from '../http.ts';
import { sensitiveCategory } from '../research/guards';
import { iso, num, vec } from '../rows.ts';
import type { Embed } from '../services.ts';

export const DEDUPE_COSINE = 0.92;
export const HALF_LIFE_DAYS = 30;
export const MEMORY_KINDS: readonly MemoryKind[] = [
  'preference',
  'constraint',
  'goal_detail',
  'outcome',
  'person_fact',
  'note',
];
export const MEMORY_MAX_CHARS = 200;

type MemoryRow = {
  id: string;
  kind: MemoryKind;
  text: string;
  person_id: string | null;
  importance: number;
  created_at: Date;
  last_seen_at: Date;
};

const toItem = (r: MemoryRow): MemoryItem => ({
  id: r.id,
  kind: r.kind,
  text: r.text,
  personId: r.person_id,
  importance: num(r.importance),
  createdAt: iso(r.created_at)!,
  lastSeenAt: iso(r.last_seen_at)!,
});

/** gte-small is English-only: mostly non-Latin text is stored without an embedding and found by keyword. */
export function embeddable(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return false;
  const latin = letters.filter((c) => /[A-Za-z]/.test(c)).length;
  return latin / letters.length >= 0.8;
}

async function safeEmbed(embed: Embed, text: string): Promise<number[] | null> {
  if (!embeddable(text)) return null;
  try {
    const e = await embed(text);
    return e?.length ? e : null;
  } catch {
    return null;
  }
}

export interface AddMemory {
  text: string;
  kind: MemoryKind;
  personId?: string | null;
  importance?: number;
  source?: string;
  quote?: string | null;
}

export async function addMemory(
  db: Db,
  embed: Embed,
  userId: string,
  m: AddMemory,
  now: Date,
): Promise<{ memory: MemoryItem; deduped: boolean }> {
  const text = m.text.replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!text) throw new HttpError(400, 'bad_request', 'text is required');
  if (!MEMORY_KINDS.includes(m.kind)) throw new HttpError(400, 'bad_request', 'unknown memory kind');
  if (m.personId) {
    const [p] =
      await db.sql`select 1 from orbit.people where id = ${m.personId}::uuid and user_id = ${userId}::uuid`;
    if (!p) throw new HttpError(404, 'not_found', 'no such person');
  }
  const e = await safeEmbed(embed, text);
  const importance = Math.max(0, Math.min(1, m.importance ?? 0.5));
  if (e) {
    const [near] = await db.sql<MemoryRow & { sim: number }>`
      select id, kind, text, person_id, importance, created_at, last_seen_at,
             1 - (embedding <=> ${vec(e)}::vector) as sim
        from orbit.memories
       where user_id = ${userId}::uuid and deleted_at is null and embedding is not null
         and person_id is not distinct from ${m.personId ?? null}::uuid
       order by embedding <=> ${vec(e)}::vector limit 1`;
    if (near && num(near.sim) >= DEDUPE_COSINE) {
      const [row] = await db.sql<MemoryRow>`
        update orbit.memories set last_seen_at = ${now}::timestamptz, importance = greatest(importance, ${importance}::real)
         where id = ${near.id}::uuid
        returning id, kind, text, person_id, importance, created_at, last_seen_at`;
      return { memory: toItem(row!), deduped: true };
    }
  } else {
    const [same] = await db.sql<MemoryRow>`
      update orbit.memories set last_seen_at = ${now}::timestamptz
       where user_id = ${userId}::uuid and deleted_at is null and lower(text) = lower(${text})
         and person_id is not distinct from ${m.personId ?? null}::uuid
      returning id, kind, text, person_id, importance, created_at, last_seen_at`;
    if (same) return { memory: toItem(same), deduped: true };
  }
  const [row] = await db.sql<MemoryRow>`
    insert into orbit.memories (user_id, person_id, kind, text, embedding, importance, source, quote, created_at,
                                last_seen_at)
    values (${userId}::uuid, ${m.personId ?? null}::uuid, ${m.kind}, ${text}, ${e ? vec(e) : null}::vector,
            ${importance}::real, ${m.source ?? 'remember'}, ${m.quote ?? null}, ${now}::timestamptz, ${now}::timestamptz)
    returning id, kind, text, person_id, importance, created_at, last_seen_at`;
  return { memory: toItem(row!), deduped: false };
}

const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2),
  );

/** Keyword overlap in [0, 1] (the fallback for cosine). */
export function keywordScore(query: string, text: string): number {
  const q = tokens(query);
  if (!q.size) return 0;
  const t = tokens(text);
  let hit = 0;
  for (const w of q) if (t.has(w) || [...t].some((x) => x.startsWith(w) || w.startsWith(x))) hit++;
  return hit / q.size;
}

export const recency = (lastSeen: Date, now: Date) =>
  0.5 ** (Math.max(0, now.getTime() - lastSeen.getTime()) / (HALF_LIFE_DAYS * 86_400_000));

export async function searchMemories(
  db: Db,
  embed: Embed,
  userId: string,
  q: { query: string; personId?: string; limit?: number },
  now: Date,
): Promise<(MemoryItem & { score: number })[]> {
  const query = q.query.trim();
  if (!query) throw new HttpError(400, 'bad_request', 'query is required');
  const e = await safeEmbed(embed, query);
  const rows = await db.sql<MemoryRow & { sim: number | null }>`
    select id, kind, text, person_id, importance, created_at, last_seen_at,
           case when embedding is null or ${e ? vec(e) : null}::vector is null then null
                else 1 - (embedding <=> ${e ? vec(e) : null}::vector) end as sim
      from orbit.memories
     where user_id = ${userId}::uuid and deleted_at is null
       and (${q.personId ?? null}::uuid is null or person_id = ${q.personId ?? null}::uuid)
     order by last_seen_at desc
     limit 500`;
  const scored = rows.map((r) => {
    const cos = r.sim === null || r.sim === undefined ? keywordScore(query, r.text) : Math.max(0, num(r.sim));
    const score = 0.7 * cos + 0.2 * num(r.importance) + 0.1 * recency(new Date(r.last_seen_at), now);
    return { ...toItem(r), score: Math.round(score * 10_000) / 10_000 };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(50, q.limit ?? 8)));
}

export async function listMemories(db: Db, userId: string, personId?: string): Promise<MemoryItem[]> {
  const rows = await db.sql<MemoryRow>`
    select id, kind, text, person_id, importance, created_at, last_seen_at from orbit.memories
     where user_id = ${userId}::uuid and deleted_at is null
       and (${personId ?? null}::uuid is null or person_id = ${personId ?? null}::uuid)
     order by last_seen_at desc limit 500`;
  return rows.map(toItem);
}

export async function forgetMemory(db: Db, userId: string, id: string, now: Date): Promise<boolean> {
  const rows = await db.sql`
    update orbit.memories set deleted_at = ${now}::timestamptz
     where id = ${id}::uuid and user_id = ${userId}::uuid and deleted_at is null returning id`;
  return rows.length > 0;
}

// ---- extraction (§10.6) ----------------------------------------------------------------------------------------

export const MEMORY_PROMPT_VERSION = 'memory-extract-v1';

export const MEMORY_SYSTEM = [
  'Extract durable facts worth remembering for future conversations: preferences, constraints, details of goals, outcomes, and facts about specific people. Skip small talk and anything already in <known>. Each memory ≤ 200 characters, in third person about the user ("Prefers morning calls").',
  'Return {"memories": [{kind, text, person_name|null, importance: 0..1, quote}]}; quote must be the user\'s own words.',
].join('\n');

export const memorySchema = z.object({
  memories: z.array(
    z.object({
      kind: z.enum(['preference', 'constraint', 'goal_detail', 'outcome', 'person_fact', 'note']),
      text: z.string(),
      person_name: z.string().nullable(),
      importance: z.number(),
      quote: z.string(),
    }),
  ),
});

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ExtractedMemory {
  kind: MemoryKind;
  text: string;
  personName: string | null;
  importance: number;
  quote: string;
}

const squash = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim();

/**
 * The memories in the last two user turns (and the replies between them). Empty when Claude is unconfigured or
 * over budget. Every memory's quote must appear in what the user wrote, and none may be about a sensitive category.
 */
export async function extractMemories(
  claude: Claude,
  userId: string,
  turns: Turn[],
  known: string[] = [],
): Promise<ExtractedMemory[]> {
  const userTurns = turns.filter((t) => t.role === 'user').slice(-2);
  if (!userTurns.length) return [];
  const lastUserIdx = turns.lastIndexOf(userTurns[0]!);
  const window = turns.slice(Math.max(0, lastUserIdx));
  const r = await claude.structured({
    task: 'memory_extract',
    system: MEMORY_SYSTEM,
    user: `<known>${known.slice(0, 20).join('\n')}</known><turns>${window
      .map((t) => `${t.role}: ${t.text.replace(/<\/?turns>/g, '')}`)
      .join('\n')}</turns>`,
    schema: memorySchema,
    userId,
  });
  if (!r.ok) return [];
  const said = squash(userTurns.map((t) => t.text).join('\n'));
  const knownSet = new Set(known.map(squash));
  return r.data.memories
    .filter((m) => m.quote.trim() && said.includes(squash(m.quote)))
    .filter((m) => !sensitiveCategory(`${m.text} ${m.quote}`))
    .filter((m) => !knownSet.has(squash(m.text)))
    .map((m) => ({
      kind: m.kind,
      text: m.text.trim().slice(0, MEMORY_MAX_CHARS),
      personName: m.person_name,
      importance: Math.max(0, Math.min(1, Number.isFinite(m.importance) ? m.importance : 0.5)),
      quote: m.quote.trim(),
    }));
}
