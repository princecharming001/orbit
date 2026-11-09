/**
 * What the screen tells the photo queue (engine/photoQueue.ts), kept apart so the Avatar imports nothing heavy:
 * which people are on screen right now (their photos are fetched first), everyone a screen showed this visit (plan 35
 * B4: only they are fetched at all; the queue keeps the list across visits), and which photo links would not load (a
 * fresh one is due). All in memory: it is about this visit.
 */

/** person id -> how many Avatars show them, and when the latest appeared (a counter: later is higher) */
const onScreen = new Map<string, { count: number; seq: number }>();
/** person id -> the photo link that failed to load */
const broken = new Map<string, string>();
/** person id -> when a screen last showed them (ms), kept after they leave it */
const seenAt = new Map<string, number>();
const listeners = new Set<() => void>();
let seq = 0;

function notify(): void {
  for (const fn of listeners) fn();
}

/**
 * A screen shows this person (a row's Avatar, a dot on the Map big enough to carry a face). Cheap and silent, so the
 * Map can call it as it draws: their photo becomes one the queue may fetch.
 */
export function seenPerson(personId: string, at = Date.now()): void {
  seenAt.set(personId, at);
}

/** Everyone a screen showed this visit, with when they were last shown (ms). */
export function seenPeople(): Map<string, number> {
  return new Map(seenAt);
}

/** An Avatar for this person is on screen. Returns the call that says it left. */
export function photoWanted(personId: string): () => void {
  seenPerson(personId);
  const cur = onScreen.get(personId);
  onScreen.set(personId, { count: (cur?.count ?? 0) + 1, seq: ++seq });
  notify();
  return () => {
    const now = onScreen.get(personId);
    if (!now) return;
    if (now.count <= 1) onScreen.delete(personId);
    else onScreen.set(personId, { ...now, count: now.count - 1 });
  };
}

/** This person's photo link did not load. */
export function photoBroken(personId: string, src: string): void {
  if (broken.get(personId) === src) return;
  broken.set(personId, src);
  notify();
}

/** The link that failed to load for this person, if any. */
export function brokenPhoto(personId: string): string | undefined {
  return broken.get(personId);
}

/** Who is on screen, by person id, with a rank: the higher, the more recently they appeared. */
export function onScreenRank(): Map<string, number> {
  return new Map([...onScreen].map(([id, v]) => [id, v.seq]));
}

/** Hear about someone appearing or a photo failing, so a fetch can happen sooner. */
export function subscribePhotoSignals(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function resetPhotoSignalsForTests(): void {
  onScreen.clear();
  broken.clear();
  seenAt.clear();
  listeners.clear();
  seq = 0;
}
