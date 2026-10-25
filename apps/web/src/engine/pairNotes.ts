/**
 * What the student says about two people on a route (plan 21 §3.5): "they don't really know each other" (the pair is
 * never a hop until the student undoes it) or "they're close" (a strong tie of its own). The cheapest and most
 * reliable evidence Orbit will ever get, so it wins over everything read automatically. Kept in this browser.
 */
import { pairKeyOf } from '@orbit/core';
import { db, type PairNote } from '../db/schema';
import { callApi, isServerUser } from '../integrations/orbitApi';

const ordered = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);
const noteId = (userId: string, a: string, b: string, kind: PairNote['kind']) => {
  const [x, y] = ordered(a, b);
  return `${userId}:${x}|${y}:${kind}`;
};

type Listener = () => void;
const listeners = new Set<Listener>();

/** Hear when the student changes what they said about a pair (the routes are recomputed). */
export function subscribePairNotes(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const changed = () => {
  for (const fn of listeners) fn();
};

/**
 * In account mode the server ranks routes too (the chat, the morning brief), so it hears the student's word: the
 * same correction through /pairs/*. This browser's note applies at once either way; a failed call is retried the next
 * time the student changes that pair.
 */
function tellServer(
  userId: string,
  a: string,
  b: string,
  route: '/pairs/block' | '/pairs/unblock' | '/pairs/close' | '/pairs/unclose',
) {
  if (!isServerUser(userId)) return;
  void callApi(route, { aPersonId: a, bPersonId: b }).catch(() => undefined);
}

/** Say a note about two people. Saying one kind takes the other back: a pair is not both close and strangers. */
export async function setPairNote(
  userId: string,
  a: string,
  b: string,
  kind: PairNote['kind'],
  now: Date = new Date(),
): Promise<void> {
  if (a === b) return;
  const [x, y] = ordered(a, b);
  await db.transaction('rw', db.pairNotes, async () => {
    await db.pairNotes.delete(noteId(userId, x, y, kind === 'blocked' ? 'close' : 'blocked'));
    await db.pairNotes.put({
      id: noteId(userId, x, y, kind),
      userId,
      aId: x,
      bId: y,
      kind,
      at: now.toISOString(),
    });
  });
  tellServer(userId, x, y, kind === 'blocked' ? '/pairs/block' : '/pairs/close');
  changed();
}

/** Take a note back. */
export async function clearPairNote(
  userId: string,
  a: string,
  b: string,
  kind: PairNote['kind'],
): Promise<void> {
  await db.pairNotes.delete(noteId(userId, a, b, kind));
  tellServer(userId, a, b, kind === 'blocked' ? '/pairs/unblock' : '/pairs/unclose');
  changed();
}

export interface PairNotes {
  /** pair keys (`a|b`, a < b) the student said do not really know each other */
  blocked: Set<string>;
  /** pairs the student said are close */
  close: { aId: string; bId: string; at: string }[];
}

/** Everything the student has said about pairs. */
export async function pairNotesFor(userId: string): Promise<PairNotes> {
  const rows = await db.pairNotes.where('userId').equals(userId).toArray();
  return {
    blocked: new Set(rows.filter((r) => r.kind === 'blocked').map((r) => pairKeyOf(r.aId, r.bId))),
    close: rows.filter((r) => r.kind === 'close').map((r) => ({ aId: r.aId, bId: r.bId, at: r.at })),
  };
}

/** What the student said about one pair, if anything. */
export async function pairNoteOf(
  userId: string,
  a: string,
  b: string,
): Promise<PairNote['kind'] | undefined> {
  if (await db.pairNotes.get(noteId(userId, a, b, 'blocked'))) return 'blocked';
  if (await db.pairNotes.get(noteId(userId, a, b, 'close'))) return 'close';
  return undefined;
}
