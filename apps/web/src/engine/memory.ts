/**
 * Long-term memory (plan 16 §10): durable things the student told Orbit, kept on the server where the chat can
 * recall them and the student can see and delete them (Settings, Memory). Account mode only.
 */
import type { MemoryItem, MemoryKind, User } from '@orbit/core';
import { callApi, isAccountMode, isServerUser, NO_SERVER, SIGN_IN_FIRST } from '../integrations/orbitApi';

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

export async function listMemories(
  user: Pick<User, 'id'>,
): Promise<{ ok: true; memories: MemoryItem[] } | Fail> {
  if (!isServerUser(user.id)) return notHere();
  const r = await callApi('/memory/list', {});
  return r.ok ? { ok: true, memories: r.value.memories } : { ok: false, message: r.message };
}

export async function searchMemories(
  user: Pick<User, 'id'>,
  query: string,
  opts: { personId?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<{ ok: true; memories: (MemoryItem & { score: number })[] } | Fail> {
  if (!isServerUser(user.id)) return notHere();
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
  if (!isServerUser(user.id)) return notHere();
  const text = m.text.trim();
  if (!text) return { ok: false, message: 'Say what to remember.' };
  const r = await callApi('/memory/add', { text: text.slice(0, 500), kind: m.kind, personId: m.personId });
  return r.ok
    ? { ok: true, memory: r.value.memory, deduped: r.value.deduped }
    : { ok: false, message: r.message };
}

export async function forget(user: Pick<User, 'id'>, memoryId: string): Promise<{ ok: true } | Fail> {
  if (!isServerUser(user.id)) return notHere();
  const r = await callApi('/memory/forget', { id: memoryId });
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}

/** "Remembered" for the chat's snapshot: the memories closest to what the student just said, at most ~300 tokens. */
export async function rememberedLines(
  user: Pick<User, 'id'>,
  lastUserText: string | undefined,
  opts: { signal?: AbortSignal; maxChars?: number } = {},
): Promise<string[]> {
  if (!isServerUser(user.id) || !lastUserText?.trim()) return [];
  const r = await searchMemories(user, lastUserText.slice(0, 500), { limit: 8, signal: opts.signal });
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
