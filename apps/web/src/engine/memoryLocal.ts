/**
 * Memory in this browser (local mode, plan 17 §G): what the student told Orbit, kept in the `memories` table with the
 * same shape as the server's. Recall ranks with MiniSearch (BM25+ with prefix and fuzzy matching, MIT licence) the
 * way the server ranks with embeddings: 0.7 relevance + 0.2 importance + 0.1 recency (30-day half-life). Saving text
 * close to a memory already kept refreshes that one instead of adding a second.
 */
import type { MemoryItem, MemoryKind } from '@orbit/core';
import { memoryKey, newId, sensitiveTopic } from '@orbit/core';
import MiniSearch from 'minisearch';
import { db, type LocalMemory } from '../db/schema';

export const LOCAL_MEMORY_MAX = 500;
export const HALF_LIFE_DAYS = 30;
const TEXT_MAX = 200;

export interface LocalRemember {
  text: string;
  kind: MemoryKind;
  personId?: string;
  quote?: string;
  importance?: number;
  source?: LocalMemory['source'];
  sourceTurn?: LocalMemory['sourceTurn'];
}

export function toMemoryItem(m: LocalMemory): MemoryItem {
  return {
    id: m.id,
    kind: m.kind,
    text: m.text,
    personId: m.personId ?? null,
    importance: m.importance,
    createdAt: m.createdAt,
    lastSeenAt: m.lastSeenAt,
  };
}

/** The memories kept for this student (newest first), optionally only those about one person. */
export async function localMemories(userId: string, personId?: string): Promise<LocalMemory[]> {
  const rows = await db.memories.where('userId').equals(userId).toArray();
  return rows
    .filter((m) => !m.deletedAt && (!personId || m.personId === personId))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

const words = (s: string) =>
  new Set(
    memoryKey(s)
      .split(' ')
      .filter((w) => w.length > 2),
  );

/**
 * Two texts that say the same thing: equal once squashed, sharing at least 80% of their words, or one a fuller
 * version of the other ("Targeting PM internships" and "Targeting PM internships in New York").
 */
export function sameMemory(a: string, b: string): boolean {
  if (memoryKey(a) === memoryKey(b)) return true;
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return false;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  if (both / Math.max(A.size, B.size) >= 0.8) return true;
  // every word of the shorter one (at least three of them) is in the longer one, in the same order
  const [short, long] = A.size <= B.size ? [a, b] : [b, a];
  return both === Math.min(A.size, B.size) && both >= 3 && memoryKey(long).includes(memoryKey(short));
}

/**
 * Keep something the student said. Text close to a memory already kept (about the same person) refreshes that one,
 * and a longer version of it replaces its words. What Orbit read by itself is never about a sensitive topic.
 */
export async function localRemember(
  userId: string,
  m: LocalRemember,
  now = new Date(),
): Promise<{ memory: LocalMemory; deduped: boolean } | undefined> {
  const text = m.text.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
  if (!text) return undefined;
  const source = m.source ?? 'remember';
  if (source !== 'remember' && sensitiveTopic(`${text} ${m.quote ?? ''}`)) return undefined;
  const at = now.toISOString();
  const importance = Math.max(0, Math.min(1, m.importance ?? 0.5));
  const kept = await localMemories(userId);
  const near = kept.find((x) => (x.personId ?? null) === (m.personId ?? null) && sameMemory(x.text, text));
  if (near) {
    const longer = text.length > near.text.length && memoryKey(text).includes(memoryKey(near.text));
    const next: LocalMemory = {
      ...near,
      text: longer ? text : near.text,
      quote: longer ? (m.quote ?? near.quote) : (near.quote ?? m.quote),
      importance: Math.max(near.importance, importance),
      lastSeenAt: at,
    };
    await db.memories.put(next);
    return { memory: next, deduped: true };
  }
  const memory: LocalMemory = {
    id: newId('mem'),
    userId,
    kind: m.kind,
    text,
    quote: m.quote?.trim().slice(0, 500) || undefined,
    personId: m.personId,
    importance,
    source,
    sourceTurn: m.sourceTurn,
    createdAt: at,
    lastSeenAt: at,
  };
  await db.memories.add(memory);
  // a long-running student keeps the most useful 500: the least important, longest unseen go first
  if (kept.length + 1 > LOCAL_MEMORY_MAX) {
    const drop = [...kept]
      .sort((a, b) => a.importance - b.importance || a.lastSeenAt.localeCompare(b.lastSeenAt))
      .slice(0, kept.length + 1 - LOCAL_MEMORY_MAX);
    for (const d of drop) await localForget(userId, d.id, now);
  }
  return { memory, deduped: false };
}

/** Forget one memory: its words are blanked and it is marked deleted. */
export async function localForget(userId: string, id: string, now = new Date()): Promise<boolean> {
  const m = await db.memories.get(id);
  if (!m || m.userId !== userId || m.deletedAt) return false;
  await db.memories.put({ ...m, text: '', quote: undefined, deletedAt: now.toISOString() });
  return true;
}

export const recency = (lastSeen: string, now: Date) =>
  0.5 ** (Math.max(0, now.getTime() - new Date(lastSeen).getTime()) / (HALF_LIFE_DAYS * 86_400_000));

const STOP = new Set(
  "a an and are as at be but by do does for from had has have i i'm in is it its me my of on or our so that the their them they this to was we were what when where which who why will with you your about".split(
    ' ',
  ),
);
/** Queries that ask for everything ("what do you remember", "preferences and goals"). */
const GENERIC = new Set(
  'remember remembered know knows memory memories everything anything preferences preference goals goal stuff things'.split(
    ' ',
  ),
);

const tokenize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .split(/[^\p{L}\p{N}'&+#]+/u)
    .map((t) => t.replace(/^'+|'+$/g, ''))
    .filter((t) => t && !STOP.has(t));

export type RankedMemory = LocalMemory & { score: number; relevance: number };

/**
 * Memories ranked for a query: 0.7 relevance (BM25+ over the text and the student's words, normalised to the best
 * match) + 0.2 importance + 0.1 recency. With `onlyMatches`, memories the query does not touch are left out, unless
 * the query asks for everything.
 */
export async function localSearch(
  userId: string,
  query: string,
  opts: { personId?: string; limit?: number; now?: Date; onlyMatches?: boolean } = {},
): Promise<RankedMemory[]> {
  const now = opts.now ?? new Date();
  const kept = await localMemories(userId, opts.personId);
  if (!kept.length) return [];
  const index = new MiniSearch<{ id: string; text: string; quote: string }>({
    fields: ['text', 'quote'],
    tokenize,
    processTerm: (t) => (STOP.has(t) ? null : t),
    searchOptions: { prefix: true, fuzzy: 0.2, boost: { text: 2 }, combineWith: 'OR' },
  });
  index.addAll(kept.map((m) => ({ id: m.id, text: m.text, quote: m.quote ?? '' })));
  const q = tokenize(query);
  const hits = q.length ? index.search(q.join(' ')) : [];
  const best = Math.max(0, ...hits.map((h) => h.score));
  const relevance = new Map(hits.map((h) => [String(h.id), best > 0 ? h.score / best : 0]));
  const generic = q.length === 0 || q.every((t) => GENERIC.has(t));
  const ranked = kept
    .map((m) => {
      const rel = relevance.get(m.id) ?? 0;
      const score = 0.7 * rel + 0.2 * m.importance + 0.1 * recency(m.lastSeenAt, now);
      return { ...m, relevance: rel, score: Math.round(score * 10_000) / 10_000 };
    })
    .filter((m) => !opts.onlyMatches || generic || m.relevance > 0)
    .sort((a, b) => b.score - a.score || b.lastSeenAt.localeCompare(a.lastSeenAt));
  return ranked.slice(0, Math.max(1, Math.min(50, opts.limit ?? 8)));
}
