/**
 * People's LinkedIn photos, fetched a few at a time while the app is open. A LinkedIn search gives no picture for
 * most people outside the student's network, an export or a typed-in profile link gives none at all, and the links
 * LinkedIn does give expire after a few weeks. So everyone with a LinkedIn profile (a member id, a public name or a
 * link) and no working photo is asked about through the connector (/photo: the plain profile, no sections), people
 * on screen first, then the newest, and no one whose profile enrichment read in the last 45 days (that read
 * brought the photo). A few calls a minute at random spacing, a bounded number a day, each person at most once a week
 * whether it found one or not, and nothing while LinkedIn has asked Orbit to slow down (the pause enrichment keeps).
 * Someone without LinkedIn has nothing to fetch here: their Gravatar (engine/enrichment) or their initials stay.
 * The sample student's photos come from the mock connector.
 */
import type { Person, User } from '@orbit/core';
import { linkedInSlug } from '@orbit/core';
import { db } from '../db/schema';
import { mockLinkedInProfile } from '../integrations/connectorsMock';
import { type EnrichOutcome, type LinkedInPhoto, linkedInPhoto } from '../integrations/enrichmentProxy';
import { endActivity, startActivity } from './activity';
import { liveAccountFor } from './enrichment/sources';
import { allRecords, linkedInPaused, pauseLinkedIn, readBudget } from './enrichment/store';
import { brokenPhoto, onScreenRank, subscribePhotoSignals } from './photoSignals';
import { freshPhoto, isGravatarPhoto, isLinkedInPhoto, linkedInImageExpired } from './photos';

/** Calls a minute at most: each gap is this share of a minute plus up to as much again, at random. */
export const PHOTOS_PER_MINUTE = 4;
export const PHOTOS_PER_DAY = 20;
/** A person asked about (found or not) is not asked about again sooner than this. */
export const PHOTO_RETRY_MS = 7 * 86_400_000;
/** Someone whose profile enrichment read this recently already has the photo that read brought. */
export const PROFILE_READ_FRESH_MS = 45 * 86_400_000;
const GAP_MS = 60_000 / PHOTOS_PER_MINUTE;

let jitter = () => Math.random();
/** Unit-test hook: the random share of each gap (0 to 1). */
export function setPhotoJitterForTests(fn: (() => number) | undefined): void {
  jitter = fn ?? (() => Math.random());
}

type Identified = Pick<Person, 'linkedinMemberId' | 'linkedinSlug' | 'linkedinUrl'>;

/** Who to ask LinkedIn about: their member id, else their public profile name. */
export const photoIdentifier = (p: Identified): string | undefined =>
  p.linkedinMemberId ?? p.linkedinSlug ?? linkedInSlug(p.linkedinUrl);

/**
 * A photo worth asking LinkedIn for: someone with a LinkedIn profile and no photo, a Gravatar (LinkedIn's replaces
 * it), or a LinkedIn link that has expired or would not load. A photo from anywhere else (the student's own) stays.
 */
export function wantsPhoto(
  p: Identified & Pick<Person, 'id' | 'photoUrl' | 'hiddenAt' | 'isHuman'>,
  now = new Date(),
): boolean {
  if (p.hiddenAt || !p.isHuman || !photoIdentifier(p)) return false;
  const url = p.photoUrl;
  if (!url || isGravatarPhoto(url)) return true;
  if (!isLinkedInPhoto(url)) return false;
  return linkedInImageExpired(url, now) || brokenPhoto(p.id) === url;
}

/** Who first: people on screen (the ones that appeared last first), then the newest people. */
export function photoOrder<T extends Pick<Person, 'id' | 'createdAt'>>(
  people: T[],
  onScreen: Map<string, number>,
): T[] {
  return [...people].sort(
    (a, b) =>
      (onScreen.get(b.id) ?? -1) - (onScreen.get(a.id) ?? -1) || b.createdAt.localeCompare(a.createdAt),
  );
}

/** Where photos are fetched from: LinkedIn through the proxy, or the demo's mock connector. */
export interface PhotoSource {
  photo(identifier: string): Promise<EnrichOutcome<LinkedInPhoto>>;
}

/** The source for this student, or undefined when there is nothing to fetch with (no live LinkedIn). */
export async function photoSourceFor(user: Pick<User, 'id'>): Promise<PhotoSource | undefined> {
  const live = await liveAccountFor(user);
  if (!live) return undefined;
  if (live === 'mock')
    return {
      // the demo's own picture only: its made-up member ids are never written onto people
      photo: async (identifier) => {
        const p = await mockLinkedInProfile(user.id, identifier);
        return p
          ? { ok: true, value: { pictureUrl: p.pictureUrl } }
          : { ok: false, reason: 'not_found', message: 'Not in the demo.' };
      },
    };
  const { accountId, token } = live;
  return { photo: (identifier) => linkedInPhoto(accountId, identifier, { token }) };
}

type Tried = Record<string, string>;
const triedKey = (userId: string) => `photos:tried:${userId}`;
const dayKey = (userId: string) => `photos:day:${userId}`;

async function readTried(userId: string): Promise<Tried> {
  return ((await db.kv.get(triedKey(userId)))?.value as Tried | undefined) ?? {};
}

async function readUsed(userId: string, day: string): Promise<number> {
  const v = (await db.kv.get(dayKey(userId)))?.value as { day?: string; used?: number } | undefined;
  return v?.day === day ? (v.used ?? 0) : 0;
}

/** When the next call may go out, per student: the spacing holds across ticks and across callers. */
const nextCall = new Map<string, number>();

/**
 * What one tick did: `asked` one person about, `idle` nobody is waiting, `wait` the last call was too recent,
 * `paused` today's photos (or LinkedIn's patience) are used up, `off` nothing to fetch with.
 */
export type PhotoStep = 'asked' | 'idle' | 'wait' | 'paused' | 'off';

/** One tick of the queue: the next person's photo, when the pace and the day's allowance let it. */
export async function refreshOnePhoto(
  user: Pick<User, 'id'>,
  opts: { now?: Date; source?: PhotoSource } = {},
): Promise<{ step: PhotoStep; personId?: string }> {
  const now = opts.now ?? new Date();
  const source = opts.source ?? (await photoSourceFor(user));
  if (!source) return { step: 'off' };
  if (now.getTime() < (nextCall.get(user.id) ?? 0)) return { step: 'wait' };
  if (linkedInPaused(await readBudget(user.id, now), now)) return { step: 'paused' };
  const day = now.toISOString().slice(0, 10);
  const used = await readUsed(user.id, day);
  if (used >= PHOTOS_PER_DAY) return { step: 'paused' };
  const tried = await readTried(user.id);
  const records = await allRecords(user.id);
  const readRecently = (id: string) => {
    const at = records.get(id)?.profileAt;
    return !!at && now.getTime() - Date.parse(at) < PROFILE_READ_FRESH_MS;
  };
  const due = (await db.people.where('userId').equals(user.id).toArray()).filter(
    (p) =>
      wantsPhoto(p, now) &&
      now.getTime() - Date.parse(tried[p.id] ?? '1970-01-01') > PHOTO_RETRY_MS &&
      !readRecently(p.id),
  );
  const [p] = photoOrder(due, onScreenRank());
  if (!p) return { step: 'idle' };
  nextCall.set(user.id, now.getTime() + GAP_MS * (1 + jitter()));
  tried[p.id] = now.toISOString();
  await db.kv.put({ key: triedKey(user.id), value: tried });
  await db.kv.put({ key: dayKey(user.id), value: { day, used: used + 1 } });
  const r = await source.photo(photoIdentifier(p)!);
  if (!r.ok) {
    if (r.reason === 'throttled') {
      await pauseLinkedIn(user.id, now, 'LinkedIn asked Orbit to slow down. It carries on tomorrow.');
      return { step: 'paused', personId: p.id };
    }
    if (r.reason === 'limit') {
      await db.kv.put({ key: dayKey(user.id), value: { day, used: PHOTOS_PER_DAY } });
      return { step: 'paused', personId: p.id };
    }
    return { step: 'asked', personId: p.id };
  }
  await applyPhoto(p.id, r.value, now);
  return { step: 'asked', personId: p.id };
}

/** Write what LinkedIn said: the photo by the usual rule, and who they are on LinkedIn where Orbit had no id. */
async function applyPhoto(personId: string, photo: LinkedInPhoto, now: Date): Promise<void> {
  const p = await db.people.get(personId);
  if (!p) return;
  const patch: Partial<Person> = {};
  const next = freshPhoto(p.photoUrl, photo.pictureUrl);
  // a dead LinkedIn link with nothing to replace it: the initials, not a broken image
  const dead =
    isLinkedInPhoto(p.photoUrl) &&
    (linkedInImageExpired(p.photoUrl, now) || brokenPhoto(p.id) === p.photoUrl);
  if (next !== p.photoUrl) patch.photoUrl = next;
  else if (dead && !photo.pictureUrl) patch.photoUrl = undefined;
  if (photo.providerId && !p.linkedinMemberId) patch.linkedinMemberId = photo.providerId;
  if (photo.publicIdentifier && !p.linkedinSlug) {
    const url = `https://www.linkedin.com/in/${photo.publicIdentifier}`;
    patch.linkedinSlug = linkedInSlug(url) ?? photo.publicIdentifier;
    if (!p.linkedinUrl) patch.linkedinUrl = url;
  }
  if (Object.keys(patch).length) await db.people.update(p.id, { ...patch, updatedAt: now.toISOString() });
}

let autoRun = import.meta.env.MODE !== 'test';
/** Unit-test hook: the background loop is off under vitest unless a test turns it on. */
export function setPhotoQueueAutoRunForTests(on: boolean): void {
  autoRun = on;
}

export function resetPhotoQueueForTests(): void {
  nextCall.clear();
}

/**
 * Run the queue while the app is open: a tick every few seconds while people are waiting, a look every minute when
 * nobody is, sooner when someone appears on screen or a photo fails, and nothing while the tab is hidden. Returns
 * the call that stops it.
 */
export function startPhotoQueue(user: Pick<User, 'id'>): () => void {
  if (!autoRun) return () => undefined;
  let stopped = false;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dueAt = Number.POSITIVE_INFINITY;
  const schedule = (ms: number) => {
    const at = Date.now() + ms;
    if (timer && at >= dueAt) return;
    if (timer) clearTimeout(timer);
    dueAt = at;
    timer = setTimeout(() => void tick(), ms);
  };
  const tick = async () => {
    timer = undefined;
    dueAt = Number.POSITIVE_INFINITY;
    if (stopped) return;
    let wait = 60_000;
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
      busy = true;
      const r = await refreshOnePhoto(user).catch(() => ({ step: 'off' as const }));
      busy = false;
      // the status line says photos are coming while the queue asks, and nothing once it rests
      if (r.step === 'asked') startActivity('photos', 'Fetching profile photos', { quiet: true });
      else if (r.step !== 'wait') endActivity('photos');
      const gap = Math.max(500, (nextCall.get(user.id) ?? 0) - Date.now());
      wait = r.step === 'asked' || r.step === 'wait' ? gap : r.step === 'idle' ? 60_000 : 10 * 60_000;
    }
    if (!stopped) schedule(wait);
  };
  const unsubscribe = subscribePhotoSignals(() => {
    if (stopped || busy) return;
    schedule(Math.max(500, (nextCall.get(user.id) ?? 0) - Date.now()));
  });
  schedule(3000);
  return () => {
    stopped = true;
    endActivity('photos');
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}
