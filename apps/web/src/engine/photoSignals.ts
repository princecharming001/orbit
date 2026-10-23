/**
 * What the screen tells the photo queue (engine/photoQueue.ts), kept apart so the Avatar imports nothing heavy:
 * which people are on screen right now (their photos are fetched first) and which photo links would not load (a
 * fresh one is due). All in memory: it is about this visit.
 */

/** person id -> how many Avatars show them, and when the latest appeared (a counter: later is higher) */
const onScreen = new Map<string, { count: number; seq: number }>();
/** person id -> the photo link that failed to load */
const broken = new Map<string, string>();
const listeners = new Set<() => void>();
let seq = 0;

function notify(): void {
  for (const fn of listeners) fn();
}

/** An Avatar for this person is on screen. Returns the call that says it left. */
export function photoWanted(personId: string): () => void {
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
  listeners.clear();
  seq = 0;
}
