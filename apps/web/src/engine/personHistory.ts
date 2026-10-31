/**
 * A person's whole story with the student, for their page (Orbit accounts): the browser's copy holds only the
 * networking threads of the last 180 days, so a page asks the server for every thread they are on, its messages and
 * their meetings (POST /people/history), stores them like pulled rows (the timeline is built from them as they land)
 * and the Messages tab and timeline read them from there. Once per person per session, and again after ten minutes.
 */
import type { User } from '@orbit/core';
import { callApi, isServerUser } from '../integrations/orbitApi';
import { writeFromServer } from './serverSync';

const AGAIN_AFTER_MS = 10 * 60_000;
const loaded = new Map<string, number>();
const going = new Map<string, Promise<boolean>>();

/** Load their history from the server. True when it came (false outside account mode or when the call failed). */
export function loadPersonHistory(
  user: Pick<User, 'id'>,
  personId: string,
  now = Date.now(),
): Promise<boolean> {
  if (!isServerUser(user.id)) return Promise.resolve(false);
  const key = `${user.id}:${personId}`;
  const at = loaded.get(key);
  if (at && now - at < AGAIN_AFTER_MS) return Promise.resolve(true);
  const running = going.get(key);
  if (running) return running;
  const job = (async () => {
    const r = await callApi('/people/history', { personId });
    if (!r.ok) return false;
    const h = r.value;
    // threads first: the timeline reads each message's thread to know its channel
    await writeFromServer('threads', h.threads, user.id);
    await writeFromServer('messages', h.messages, user.id);
    await writeFromServer('calendar_events', h.events, user.id);
    loaded.set(key, now);
    return true;
  })()
    .catch(() => false)
    .finally(() => going.delete(key));
  going.set(key, job);
  return job;
}

/** Unit-test hook. */
export function resetPersonHistoryForTests(): void {
  loaded.clear();
  going.clear();
}
