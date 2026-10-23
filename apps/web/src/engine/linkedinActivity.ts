/**
 * LinkedIn activity in closeness (plan 17 B). With LinkedIn connected live in this browser, Orbit reads the student's
 * 1:1 LinkedIn chats (the whole history the first time, then what is new) and the comments and reactions on their
 * posts, and turns them into touches on the people they already have:
 *
 * - direct messages: one `linkedin_in` / `linkedin_out` touch per person per day per direction, dated by that day's
 *   first message that way (so reply latency is honest), counted like email in the tie score;
 * - posts: `linkedin_comment_in` (they commented on the student's post), `linkedin_comment_out` (the student commented
 *   on theirs) and `linkedin_reaction_in` (they reacted), weak and capped in the tie score.
 *
 * People are matched by their LinkedIn member id only: a name is never enough to say who wrote (two Sam Lees are two
 * people), and nobody new is created from it. Every touch has a stable reference, so reading the same message twice
 * writes nothing twice. A read cut short keeps its place (the proxy's signed cursor) and continues next time; the
 * checkpoint only moves once a read reached the end. Strengths are recomputed for everyone touched.
 *
 * Runs after the live connection sync (and so after the daily re-sync); a history read left unfinished continues
 * when the app opens. Never for an Orbit account (its server holds LinkedIn) or the sample student.
 */
import type { Person, TouchpointKind, User } from '@orbit/core';
import { newId, TOUCHPOINT_WEIGHTS } from '@orbit/core';
import { recomputePersonStrength } from '../db/repo';
import { db } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { isServerUser } from '../integrations/orbitApi';
import {
  type LinkedInDm,
  type LinkedInPostItem,
  linkedInChatHistory,
  linkedInPostActivity,
  unipileConfigured,
} from '../integrations/unipile';
import { LIVE_SOON, liveLinkedInAccount } from './linkedinLive';

/** Proxy calls per run for the chat history (each reads up to ~24 pages); the rest continues on the next run. */
export const DM_CALLS_PER_RUN = 12;
/** Proxy calls per run for post engagement (each a few LinkedIn reads; the proxy also caps them per day). */
export const POST_CALLS_PER_RUN = 6;
/** Post engagement is read at most this often. */
export const POSTS_EVERY_MS = 20 * 60 * 60_000;
/** On app open, an unfinished history read continues at most this often. */
export const CONTINUE_EVERY_MS = 15 * 60_000;

/** What the activity reader keeps on the live LinkedIn row, next to the connection sync's and reply reader's state. */
export interface ActivityState {
  /** the newest message the chat history read has seen; the next read starts just before it */
  dmAfter?: string;
  /** a history read cut short: the proxy's cursor to continue it, and the newest message it had seen so far */
  dmCursor?: string;
  dmPendingLatest?: string;
  /** when the chat history was last read */
  dmCheckedAt?: string;
  /** the student's posts read to the end, with the comment and reaction counts they had then */
  postsSeen?: Record<string, string>;
  /** the student's own comments were read back to here */
  commentsSince?: string;
  postsCheckedAt?: string;
}

export type ActivityResult =
  | {
      ok: true;
      /** LinkedIn messages read in this run */
      messages: number;
      /** comments and reactions read in this run */
      engagement: number;
      /** people whose history changed */
      people: number;
      /** the history was read to the end (false: it continues next time) */
      complete: boolean;
    }
  | { ok: false; reason: 'not_connected' | 'unconfigured' | 'error'; message: string };

const none: ActivityResult = { ok: true, messages: 0, engagement: 0, people: 0, complete: true };
const time = (at: string | undefined) => (at ? Date.parse(at) : Number.NaN);
const later = (a: string | undefined, b: string | undefined) => (!a ? b : !b ? a : a > b ? a : b);

/**
 * Record LinkedIn direct messages with one person as touches: one per day each way, dated by the day's first message
 * that way. Idempotent; a message read later that is earlier in its day moves the touch to it. Returns whether any
 * touch was added or moved.
 */
export async function recordDmTouches(
  userId: string,
  person: Pick<Person, 'id' | 'firstName' | 'displayName' | 'linkedinMemberId'>,
  messages: Pick<LinkedInDm, 'at' | 'out' | 'text'>[],
): Promise<boolean> {
  const days = new Map<string, { at: string; n: number; out: boolean }>();
  for (const m of messages) {
    const t = time(m.at);
    if (!Number.isFinite(t)) continue;
    const at = new Date(t).toISOString();
    const key = `${at.slice(0, 10)}:${m.out ? 'out' : 'in'}`;
    const d = days.get(key);
    if (!d) days.set(key, { at, n: 1, out: m.out });
    else {
      d.n++;
      if (at < d.at) d.at = at;
    }
  }
  const name = person.firstName || person.displayName;
  const member = person.linkedinMemberId ?? person.id;
  let changed = false;
  for (const [key, d] of days) {
    const kind: TouchpointKind = d.out ? 'linkedin_out' : 'linkedin_in';
    const refId = `${member}:${key}`;
    const existing = await db.touchpoints
      .where('[personId+refTable+refId]')
      .equals([person.id, 'linkedin_dm', refId])
      .first();
    if (existing) {
      if (d.at < existing.occurredAt) {
        await db.touchpoints.update(existing.id, { occurredAt: d.at });
        changed = true;
      }
      continue;
    }
    await db.touchpoints.add({
      id: newId('tp'),
      userId,
      personId: person.id,
      kind,
      occurredAt: d.at,
      refTable: 'linkedin_dm',
      refId,
      summary: d.out ? `LinkedIn message to ${name}` : `LinkedIn message from ${name}`,
      weight: TOUCHPOINT_WEIGHTS[kind],
    });
    changed = true;
  }
  return changed;
}

const POST_KIND: Record<LinkedInPostItem['kind'], TouchpointKind> = {
  comment_in: 'linkedin_comment_in',
  comment_out: 'linkedin_comment_out',
  reaction_in: 'linkedin_reaction_in',
};

/** One comment or reaction as a touch on the person it was with. Returns whether it was new. */
async function recordPostTouch(
  userId: string,
  person: Pick<Person, 'id' | 'firstName' | 'displayName'>,
  item: LinkedInPostItem,
): Promise<boolean> {
  const kind = POST_KIND[item.kind];
  const refId = `${item.kind}:${item.id}`;
  const existing = await db.touchpoints
    .where('[personId+refTable+refId]')
    .equals([person.id, 'linkedin_posts', refId])
    .first();
  if (existing) return false;
  const name = person.firstName || person.displayName;
  await db.touchpoints.add({
    id: newId('tp'),
    userId,
    personId: person.id,
    kind,
    occurredAt: new Date(time(item.at)).toISOString(),
    refTable: 'linkedin_posts',
    refId,
    summary:
      item.kind === 'comment_in'
        ? `${name} commented on your post${item.text ? `: ${item.text}` : ''}`
        : item.kind === 'comment_out'
          ? `You commented on ${name}'s post${item.text ? `: ${item.text}` : ''}`
          : `${name} reacted to your post`,
    weight: TOUCHPOINT_WEIGHTS[kind],
  });
  return true;
}

/** Everyone the student has, by LinkedIn member id (hidden people are left alone). */
async function peopleByMember(userId: string): Promise<Map<string, Person>> {
  const people = await db.people.where('userId').equals(userId).toArray();
  return new Map(
    people.filter((p) => p.linkedinMemberId && !p.hiddenAt).map((p) => [p.linkedinMemberId!, p] as const),
  );
}

/**
 * Read the student's LinkedIn chats and post engagement into touches, then rescore the people touched. `onProgress`
 * hears how many messages have been read so far. Post engagement is read at most once every 20 hours unless
 * `posts: true`.
 */
export async function syncLinkedInActivity(
  user: Pick<User, 'id'>,
  opts: {
    now?: Date;
    fetch?: typeof fetch;
    onProgress?: (messages: number) => void;
    posts?: boolean;
    dmCalls?: number;
  } = {},
): Promise<ActivityResult> {
  const now = opts.now ?? new Date();
  if (isServerUser(user.id) || usesMockConnectors(user.id)) return none;
  const row = await liveLinkedInAccount(user.id);
  if (!row || row.status === 'revoked' || !row.externalAccountId)
    return { ok: false, reason: 'not_connected', message: 'LinkedIn is not connected live.' };
  if (!unipileConfigured() || !row.accessToken)
    return { ok: false, reason: 'unconfigured', message: LIVE_SOON };
  const call = { token: row.accessToken, fetch: opts.fetch };
  const st = row.syncState as ActivityState;
  const next: ActivityState = {};
  const byMember = await peopleByMember(user.id);
  const touched = new Set<string>();

  // 1. direct messages: continue a read cut short, else everything since the checkpoint (or the whole history)
  let cursor = st.dmCursor;
  let latest = st.dmPendingLatest;
  const resumed = !!cursor;
  const after = st.dmAfter ? new Date(time(st.dmAfter) - 60_000).toISOString() : undefined;
  let messages = 0;
  let failure: string | undefined;
  for (let i = 0; i < (opts.dmCalls ?? DM_CALLS_PER_RUN); i++) {
    const r = await linkedInChatHistory(row.externalAccountId, cursor ? { cursor } : { after }, call);
    if (!r.ok) {
      if (r.reason === 'unconfigured') return { ok: false, reason: 'unconfigured', message: LIVE_SOON };
      failure = r.message;
      // a cursor from an earlier run that no longer works: the next run starts again from the checkpoint
      if (resumed && i === 0) cursor = undefined;
      break;
    }
    for (const chat of r.value.chats) {
      messages += chat.messages.length;
      const person = byMember.get(chat.memberId);
      if (person && (await recordDmTouches(user.id, person, chat.messages))) touched.add(person.id);
    }
    latest = later(latest, r.value.latest);
    cursor = r.value.cursor ?? undefined;
    opts.onProgress?.(messages);
    if (!cursor) break;
  }
  const complete = !cursor && !failure;
  if (complete) {
    // read to the end: the newest message is the checkpoint (nothing at all: the start of this read)
    next.dmAfter = later(st.dmAfter, latest) ?? now.toISOString();
    next.dmCursor = undefined;
    next.dmPendingLatest = undefined;
  } else {
    // cut short or failed: keep the place, so the rest is read next time and nothing is skipped
    next.dmCursor = cursor;
    next.dmPendingLatest = cursor ? latest : undefined;
  }
  next.dmCheckedAt = now.toISOString();

  // 2. post engagement, at most about once a day
  let engagement = 0;
  const postsDue =
    opts.posts ??
    !(Number.isFinite(time(st.postsCheckedAt)) && now.getTime() - time(st.postsCheckedAt) < POSTS_EVERY_MS);
  if (postsDue && !failure) {
    const seen = { ...(st.postsSeen ?? {}) };
    let postCursor: string | undefined;
    let ownDone = false;
    let ok = true;
    for (let i = 0; i < POST_CALLS_PER_RUN; i++) {
      const r = await linkedInPostActivity(
        row.externalAccountId,
        postCursor ? { cursor: postCursor } : { seen, commentsSince: st.commentsSince },
        call,
      );
      if (!r.ok) {
        ok = false;
        break;
      }
      for (const item of r.value.items) {
        engagement++;
        const person = byMember.get(item.memberId);
        if (person && (await recordPostTouch(user.id, person, item))) touched.add(person.id);
      }
      for (const p of r.value.postsRead) seen[p.socialId] = p.seen;
      ownDone ||= r.value.ownDone;
      postCursor = r.value.cursor ?? undefined;
      if (!postCursor || r.value.limited) break;
    }
    next.postsSeen = seen;
    // the student's own comments: the checkpoint moves only once they were read to the end
    if (ownDone) next.commentsSince = now.toISOString();
    if (ok) next.postsCheckedAt = now.toISOString();
  }

  for (const id of touched) await recomputePersonStrength(id, now);
  // the connection sync and the reply reader write this row too: merge into what is there now
  const fresh = await liveLinkedInAccount(user.id);
  await db.integrations.update(row.id, { syncState: { ...(fresh?.syncState ?? row.syncState), ...next } });
  if (failure && !messages) return { ok: false, reason: 'error', message: failure };
  return { ok: true, messages, engagement, people: touched.size, complete };
}

/**
 * On app open: continue a chat history read that was cut short, at most every quarter hour. New messages in between
 * reach closeness through the reply reader and the daily re-sync. Never throws.
 */
export async function autoSyncLinkedInActivity(
  user: Pick<User, 'id'>,
  now = new Date(),
): Promise<ActivityResult | undefined> {
  if (isServerUser(user.id) || usesMockConnectors(user.id)) return undefined;
  const row = await liveLinkedInAccount(user.id);
  if (!row || row.status === 'revoked' || !row.externalAccountId) return undefined;
  const st = row.syncState as ActivityState;
  if (!st.dmCursor) return undefined;
  const checked = time(st.dmCheckedAt);
  if (Number.isFinite(checked) && now.getTime() - checked < CONTINUE_EVERY_MS) return undefined;
  return syncLinkedInActivity(user, { now, posts: false }).catch(() => undefined);
}
