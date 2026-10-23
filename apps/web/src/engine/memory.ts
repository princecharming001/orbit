/**
 * Long-term memory (plan 16 §10, plan 17 §G): durable things the student told Orbit, which the chat can recall and
 * the student can see and delete (Settings, Memory). Signed in to an Orbit account they live on the server; otherwise
 * in this browser (engine/memoryLocal.ts), with the same calls and the same shapes.
 */
import type { ChatTurn, MemoryItem, MemoryKind, User } from '@orbit/core';
import { callApi, isAccountMode, isServerUser, NO_SERVER, SIGN_IN_FIRST } from '../integrations/orbitApi';
import { localForget, localMemories, localRemember, localSearch, toMemoryItem } from './memoryLocal';

export const MEMORY_KINDS: readonly MemoryKind[] = [
  'preference',
  'constraint',
  'goal_detail',
  'outcome',
  'person_fact',
  'note',
];

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  preference: 'Preference',
  constraint: 'Constraint',
  goal_detail: 'About a goal',
  outcome: 'Outcome',
  person_fact: 'About someone',
  note: 'Note',
};

type Fail = { ok: false; message: string };
const notHere = (): Fail => ({ ok: false, message: isAccountMode() ? SIGN_IN_FIRST : NO_SERVER });

/** Where this student's memories live: the server when signed in to their account, else this browser. */
export function memoryOnServer(user: Pick<User, 'id'>): boolean {
  return isServerUser(user.id);
}

export async function listMemories(
  user: Pick<User, 'id'>,
): Promise<{ ok: true; memories: MemoryItem[] } | Fail> {
  if (!isServerUser(user.id)) return { ok: true, memories: (await localMemories(user.id)).map(toMemoryItem) };
  const r = await callApi('/memory/list', {});
  return r.ok ? { ok: true, memories: r.value.memories } : { ok: false, message: r.message };
}

export async function searchMemories(
  user: Pick<User, 'id'>,
  query: string,
  opts: { personId?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<{ ok: true; memories: (MemoryItem & { score: number })[] } | Fail> {
  if (!isServerUser(user.id)) {
    const ranked = await localSearch(user.id, query, {
      personId: opts.personId,
      limit: opts.limit ?? 8,
      onlyMatches: true,
    });
    return { ok: true, memories: ranked.map((m) => ({ ...toMemoryItem(m), score: m.score })) };
  }
  const r = await callApi(
    '/memory/search',
    { query, personId: opts.personId, limit: opts.limit ?? 8 },
    { signal: opts.signal },
  );
  return r.ok ? { ok: true, memories: r.value.memories } : { ok: false, message: r.message };
}

export async function remember(
  user: Pick<User, 'id'>,
  m: { text: string; kind: MemoryKind; personId?: string },
): Promise<{ ok: true; memory: MemoryItem; deduped: boolean } | Fail> {
  const text = m.text.trim();
  if (!text) return { ok: false, message: 'Say what to remember.' };
  if (!isServerUser(user.id)) {
    const r = await localRemember(user.id, { ...m, text, source: 'remember', importance: 0.7 });
    return r
      ? { ok: true, memory: toMemoryItem(r.memory), deduped: r.deduped }
      : { ok: false, message: 'Say what to remember.' };
  }
  const r = await callApi('/memory/add', { text: text.slice(0, 500), kind: m.kind, personId: m.personId });
  return r.ok
    ? { ok: true, memory: r.value.memory, deduped: r.value.deduped }
    : { ok: false, message: r.message };
}

export async function forget(user: Pick<User, 'id'>, memoryId: string): Promise<{ ok: true } | Fail> {
  if (!isServerUser(user.id))
    return (await localForget(user.id, memoryId))
      ? { ok: true }
      : { ok: false, message: 'Orbit has no memory with that id.' };
  const r = await callApi('/memory/forget', { id: memoryId });
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}

/** What the server kept from the last chat turns (§10.6): the memories it found and how many are new. */
export async function extractFromChat(
  user: Pick<User, 'id'>,
  turns: ChatTurn[],
): Promise<{ ok: true; memories: MemoryItem[]; added: number } | Fail> {
  if (!isServerUser(user.id)) return notHere();
  if (!turns.length) return { ok: true, memories: [], added: 0 };
  const r = await callApi('/memory/extract', { turns });
  return r.ok
    ? { ok: true, memories: r.value.memories, added: r.value.added }
    : { ok: false, message: r.message };
}

/**
 * "Remembered" for the chat's snapshot: the memories closest to what the student just said (and, in this browser,
 * the most important ones when nothing matches), at most ~300 tokens.
 */
export async function rememberedLines(
  user: Pick<User, 'id'>,
  lastUserText: string | undefined,
  opts: { signal?: AbortSignal; maxChars?: number } = {},
): Promise<string[]> {
  if (!lastUserText?.trim()) return [];
  const r = isServerUser(user.id)
    ? await searchMemories(user, lastUserText.slice(0, 500), { limit: 8, signal: opts.signal })
    : {
        ok: true as const,
        memories: await localSearch(user.id, lastUserText.slice(0, 500), { limit: 8 }),
      };
  if (!r.ok) return [];
  const max = opts.maxChars ?? 1200;
  const out: string[] = [];
  let used = 0;
  for (const m of r.memories) {
    const line = `${m.id} ${m.text.replace(/\s+/g, ' ').trim().slice(0, 200)}`;
    if (used + line.length > max) break;
    out.push(line);
    used += line.length + 2;
  }
  return out;
}
