/**
 * Friends (plan 29 Part A), the browser's side: two Orbit users pool their networks as signal, never content. Every
 * call here goes to orbit-api with the account; local mode gets `needs_account` and the one paragraph, since nothing
 * leaves the browser without an account (plans 14 and 24). The list and the asks are kept in Dexie (`friends`,
 * `friendAsks`) for the tab to read live; a friend's shared people are never a table here, they are read on demand
 * and live in the paths cache only.
 */
import type {
  Friend,
  FriendCloseness,
  FriendIntroAsk,
  FriendInvite,
  FriendShare,
  FriendShareMode,
  FriendSuggestion,
  FriendsLinkResponse,
  FriendsSuggestResponse,
  InviteSuggestion,
  PathTarget,
  ServerDraft,
  User,
  WarmPath,
} from '@orbit/core';
import { newId } from '@orbit/core';
import { db, type FriendAskRow, type FriendRow } from '../db/schema';
import { callApi, isAccountMode, isServerUser } from '../integrations/orbitApi';
import { findPathsOnServer, type ServerPath } from './paths';
import { queueChange } from './serverSync';

/** The empty state of the tab, word for word (plan 29 §A1). */
export const FRIENDS_EMPTY =
  'Friends pool their networks. You see who they know and how well, they see yours, and intros happen in one tap. Nothing else crosses: not your messages, notes or contact details.';

/** What a friend sees of the student, said once for the tab, the chat and the privacy page. */
export const FRIENDS_WHAT_CROSSES =
  'A friend sees name, title, company, public LinkedIn profile, school, whether someone is your alum, and a closeness word built from LinkedIn, your labels and your own answers. Never your emails, notes, drafts, scores, addresses or anyone you hid.';

/** Under the Friends title: what pooling is for, and the one line that matters about privacy. */
export const FRIENDS_SUBTITLE =
  'Pool networks for warm intros. Friends see who you know, never your messages.';

/** The tab in local mode: one paragraph, then the Google sign-in (plan 29 §A2.1). */
export const FRIENDS_NEEDS_ACCOUNT = `${FRIENDS_EMPTY} Friends needs an Orbit account, because in this copy nothing leaves your browser: sign in with Google to pool your network with a friend's.`;

export const SHARE_MODE_LABELS: Record<FriendShareMode, string> = {
  all: 'Everyone I know',
  companies: 'Only at these companies',
  none: 'Nothing yet',
};

export const CLOSENESS_WORDS: Record<FriendCloseness, string> = { 1: 'knows', 2: 'knows well', 3: 'close' };

/** "knows Dan", "knows Dan well", "is close to Dan": how a friend's closeness reads in a sentence. */
export function closenessPhrase(closeness: FriendCloseness, first: string): string {
  return closeness === 3
    ? `is close to ${first}`
    : closeness === 2
      ? `knows ${first} well`
      : `knows ${first}`;
}

export type FriendsFailReason = 'needs_account' | 'signed_out' | 'network' | 'rate_limited' | 'error';
export type FriendsFail = { ok: false; reason: FriendsFailReason; message: string; code?: string };
export type FriendsResult<T> = { ok: true; value: T } | FriendsFail;

/** Friends is an account feature: available only to a student signed in to an Orbit account. */
export function friendsAvailable(user: Pick<User, 'id'> | undefined): boolean {
  return !!user && isServerUser(user.id);
}

function needsAccount(): FriendsFail {
  return {
    ok: false,
    reason: 'needs_account',
    message: isAccountMode()
      ? 'Friends needs an Orbit account. Sign in with Google first (Settings, Account).'
      : 'Friends needs an Orbit account, and this copy of Orbit runs only on your device, so it is not available here.',
  };
}

type Api = Awaited<ReturnType<typeof callApi>>;
function fail(r: Extract<Api, { ok: false }>): FriendsFail {
  const reason: FriendsFailReason =
    r.reason === 'signed_out'
      ? 'signed_out'
      : r.reason === 'network'
        ? 'network'
        : r.reason === 'rate_limited'
          ? 'rate_limited'
          : 'error';
  return { ok: false, reason, message: r.message, code: r.code };
}

const stamp = () => new Date().toISOString();

async function keepFriends(ownerId: string, friends: Friend[]): Promise<void> {
  const at = stamp();
  await db.transaction('rw', db.friends, async () => {
    await db.friends.where('ownerId').equals(ownerId).delete();
    await db.friends.bulkPut(friends.map((f): FriendRow => ({ ...f, ownerId, pulledAt: at })));
  });
}

/** The friends and what is pending either way, from the server; the list the tab reads is kept here too. */
export async function listFriends(
  user: Pick<User, 'id'>,
): Promise<FriendsResult<{ friends: Friend[]; pending: FriendInvite[] }>> {
  if (!friendsAvailable(user)) return needsAccount();
  const r = await callApi('/friends', {});
  if (!r.ok) return fail(r);
  await keepFriends(user.id, r.value.friends);
  return { ok: true, value: r.value };
}

/** Invite by email (a request when they are on Orbit, a sign-in link when not), or a link to copy with no email. */
export async function inviteFriend(user: Pick<User, 'id'>, email?: string) {
  if (!friendsAvailable(user)) return needsAccount();
  const e = email?.trim();
  if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
    return { ok: false, reason: 'error', message: 'That is not an email address.' } as FriendsFail;
  const r = await callApi('/friends/invite', e ? { email: e } : {});
  if (!r.ok) return fail(r);
  return { ok: true as const, value: r.value };
}

/** Invite someone in the student's People by id: the server sends to the address it has for them. */
export async function invitePerson(user: Pick<User, 'id'>, personId: string) {
  if (!friendsAvailable(user)) return needsAccount();
  const r = await callApi('/friends/invite', { personId });
  if (!r.ok) return fail(r);
  return { ok: true as const, value: r.value };
}

/** People on Orbit the student may know, and people in their People worth inviting (plan 37 follow-up). */
export async function suggestFriends(user: Pick<User, 'id'>): Promise<FriendsResult<FriendsSuggestResponse>> {
  if (!friendsAvailable(user)) return needsAccount();
  const r = await callApi('/friends/suggest', {});
  if (!r.ok) return fail(r);
  return { ok: true, value: r.value };
}

/** Someone on Orbit by name (among people with a tie to the student) or by exact address. */
export async function searchOrbit(
  user: Pick<User, 'id'>,
  q: string,
): Promise<FriendsResult<FriendSuggestion[]>> {
  if (!friendsAvailable(user)) return needsAccount();
  const r = await callApi('/friends/search', { q });
  if (!r.ok) return fail(r);
  return { ok: true, value: r.value.results };
}

/** A friend request to someone on Orbit; they accept it from their Friends page. */
export async function requestFriend(user: Pick<User, 'id'>, userId: string) {
  if (!friendsAvailable(user)) return needsAccount();
  const r = await callApi('/friends/request', { userId });
  if (!r.ok) return fail(r);
  return { ok: true as const, value: r.value };
}

/** The standing invite link for a group chat; `reset` ends the old one and makes a new one. */
export async function inviteLink(
  user: Pick<User, 'id'>,
  reset = false,
): Promise<FriendsResult<FriendsLinkResponse>> {
  if (!friendsAvailable(user)) return needsAccount();
  const r = await callApi('/friends/link', reset ? { reset: true } : {});
  if (!r.ok) return fail(r);
  return { ok: true, value: r.value };
}

/** Accept a request or an invite code, sharing back in `mode` (everyone by default, plan 29 §A1). */
export async function acceptFriend(
  user: Pick<User, 'id'>,
  by: { code?: string; friendshipId?: string },
  mode: FriendShareMode = 'all',
  companyDomains: string[] = [],
): Promise<FriendsResult<Friend>> {
  if (!friendsAvailable(user)) return needsAccount();
  const r = await callApi('/friends/accept', { ...by, mode, companyDomains });
  if (!r.ok) return fail(r);
  await listFriends(user).catch(() => undefined);
  return { ok: true, value: r.value.friend };
}

export async function declineFriend(user: Pick<User, 'id'>, by: { code?: string; friendshipId?: string }) {
  if (!friendsAvailable(user)) return needsAccount();
  const r = await callApi('/friends/decline', by);
  if (!r.ok) return fail(r);
  return { ok: true as const, value: r.value };
}

/** End a friendship: visibility ends both ways at once, and the open asks between the two expire. */
export async function endFriendship(user: Pick<User, 'id'>, friendshipId: string) {
  if (!friendsAvailable(user)) return needsAccount();
  const r = await callApi('/friends/end', { friendshipId });
  if (!r.ok) return fail(r);
  await db.friends.delete(friendshipId).catch(() => undefined);
  await db.friendAsks
    .where('friendshipId')
    .equals(friendshipId)
    .modify((a) => {
      if (a.status === 'asked') a.status = 'expired';
    })
    .catch(() => undefined);
  return { ok: true as const, value: r.value };
}

/**
 * What the student shares: with one friend (`friendshipId`) or with everyone. The default for new friends is kept in
 * the settings row too, so the tab and the chat can say it without a call.
 */
export async function setShareMode(
  user: Pick<User, 'id'>,
  mode: FriendShareMode,
  opts: { friendshipId?: string; companyDomains?: string[] } = {},
) {
  if (!friendsAvailable(user)) return needsAccount();
  const companyDomains = (opts.companyDomains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean);
  const r = await callApi('/friends/settings', {
    ...(opts.friendshipId ? { friendshipId: opts.friendshipId } : {}),
    mode,
    companyDomains,
  });
  if (!r.ok) return fail(r);
  if (opts.friendshipId)
    await db.friends
      .update(opts.friendshipId, { myMode: mode, myCompanyDomains: companyDomains })
      .catch(() => 0);
  else {
    await db.settings
      .update(user.id, { friendShareMode: mode, friendShareDomains: companyDomains })
      .catch(() => 0);
    await db.friends
      .where('ownerId')
      .equals(user.id)
      .modify({ myMode: mode, myCompanyDomains: companyDomains })
      .catch(() => 0);
  }
  return { ok: true as const, value: r.value };
}

/** The student's own projection, row for row as a friend (or the one friend named) sees it (plan 29 §A1). */
export async function previewShares(user: Pick<User, 'id'>, friendshipId?: string) {
  if (!friendsAvailable(user)) return needsAccount();
  const r = await callApi('/friends/preview', friendshipId ? { friendshipId } : {});
  if (!r.ok) return fail(r);
  return { ok: true as const, value: r.value };
}

/** One friend's shared people, those at `company` when given; never stored. */
export async function friendShares(user: Pick<User, 'id'>, friendUserId: string, company?: string) {
  if (!friendsAvailable(user)) return needsAccount();
  const r = await callApi('/friends/shares', { friendUserId, ...(company ? { company } : {}) });
  if (!r.ok) return fail(r);
  return { ok: true as const, value: r.value };
}

/**
 * Hide a person from friends, or show them again (plan 29 §A1): a private person is never in the projection, and the
 * server drops their row the moment the flag lands. Local mode keeps the flag too, so it travels when an account comes.
 */
export async function markPrivate(personId: string, on: boolean, now = new Date()): Promise<boolean> {
  const person = await db.people.get(personId);
  if (!person) return false;
  const n = await db.people.update(personId, { private: on || undefined, updatedAt: now.toISOString() });
  // only an account has a server to tell; a local student's network never leaves this browser
  if (n > 0 && isServerUser(person.userId)) queueChange('people', personId);
  return n > 0;
}

async function keepAsks(ownerId: string, asks: FriendIntroAsk[]): Promise<void> {
  const at = stamp();
  const before = new Map(
    (await db.friendAsks.where('ownerId').equals(ownerId).toArray()).map((a) => [a.id, a]),
  );
  await db.transaction('rw', db.friendAsks, db.notifications, async () => {
    await db.friendAsks.where('ownerId').equals(ownerId).delete();
    await db.friendAsks.bulkPut(asks.map((a): FriendAskRow => ({ ...a, ownerId, pulledAt: at })));
    // the asker's side learns a friend forwarded (plan 29 §A4): one line, once, when the status turns
    for (const a of asks) {
      if (a.askerUserId !== ownerId || a.status !== 'forwarded') continue;
      const prev = before.get(a.id);
      if (prev && prev.status === 'forwarded') continue;
      if (!prev && before.size === 0) continue;
      const friendFirst = a.friendName.split(/\s+/)[0] ?? a.friendName;
      const targetFirst = a.targetName.split(/\s+/)[0] ?? a.targetName;
      await db.notifications.add({
        id: newId('n'),
        userId: ownerId,
        kind: 'system',
        title: `${friendFirst} forwarded your note to ${targetFirst}.`,
        body: `When ${targetFirst} replies, the thank-you to ${friendFirst} is the next step.`,
        link: '/friends',
        createdAt: at,
      });
    }
  });
}

/** The asks the student made and the ones friends made of them; kept here for the tab. */
export async function listAsks(
  user: Pick<User, 'id'>,
): Promise<FriendsResult<{ asked: FriendIntroAsk[]; received: FriendIntroAsk[] }>> {
  if (!friendsAvailable(user)) return needsAccount();
  const r = await callApi('/friends/asks', {});
  if (!r.ok) return fail(r);
  const v = r.value as { asked?: FriendIntroAsk[]; received?: FriendIntroAsk[] };
  const value = { asked: v.asked ?? [], received: v.received ?? [] };
  await keepAsks(user.id, [...value.asked, ...value.received]);
  return { ok: true, value };
}

/**
 * Ask a friend for an intro to one of the people they share (plan 29 §A4): the note is the forwardable blurb in the
 * student's words, and it goes to the friend, never to the person. Nothing is sent: the ask waits on the friend.
 */
export async function askFriendForIntro(
  user: Pick<User, 'id'>,
  friendUserId: string,
  targetPersonId: string,
  note: string,
): Promise<FriendsResult<FriendIntroAsk>> {
  if (!friendsAvailable(user)) return needsAccount();
  const text = note.trim();
  if (!text)
    return { ok: false, reason: 'error', message: 'Write the note your friend would forward first.' };
  const r = await callApi('/friends/asks', { friendUserId, targetPersonId, note: text });
  if (!r.ok) return fail(r);
  const ask = (r.value as { ask: FriendIntroAsk }).ask;
  await db.friendAsks.put({ ...ask, ownerId: user.id, pulledAt: stamp() }).catch(() => undefined);
  return { ok: true, value: ask };
}

/**
 * Answer a friend's ask: `forward` makes the forward draft to the student's own contact, with the friend in cc, that
 * the student approves like any draft; `decline` closes it and owes no reason.
 */
export async function respondToAsk(
  user: Pick<User, 'id'>,
  askId: string,
  action: 'forward' | 'decline',
  body?: string,
): Promise<FriendsResult<{ ask: FriendIntroAsk; draft: ServerDraft | null }>> {
  if (!friendsAvailable(user)) return needsAccount();
  const r = await callApi('/friends/asks/respond', { id: askId, action, ...(body ? { body } : {}) });
  if (!r.ok) return fail(r);
  await db.friendAsks.put({ ...r.value.ask, ownerId: user.id, pulledAt: stamp() }).catch(() => undefined);
  return { ok: true, value: r.value };
}

// ---- routes through friends (plan 29 §A5) ---------------------------------------------------------------------------

/** A route whose first hop is a friend on Orbit, as the Map, Reach and the company page draw it. */
export interface FriendRoute {
  pathId: string;
  friend: { userId: string; name: string; first: string };
  /** the person reached: the student's own row when they have them, else the friend's shared person */
  target: { nodeId: string; name: string; first: string; personId?: string; sharedPersonId?: string };
  /** how well the friend knows them, as a chance (0.35, 0.6, 0.85) and in words */
  closeness: FriendCloseness;
  phrase: string;
  /** the chance the intro happens, 0 to 1 */
  p: number;
  band: WarmPath['band'];
  path: ServerPath;
}

const FRIEND_NODE = /^friend:(.+)$/;
const FRIEND_PERSON_NODE = /^friend_person:(.+)$/;

/** A path's friend hop, when its first hop is a friend (`via` on the hops, plan 29 §A4). */
export function friendRouteOf(p: ServerPath): FriendRoute | undefined {
  const first = p.nodes[1];
  const via = p.hops[0]?.via ?? p.hops[1]?.via;
  const m = first ? FRIEND_NODE.exec(first) : null;
  if (!m || !via || via.kind !== 'friend') return undefined;
  const last = p.nodes[p.nodes.length - 1]!;
  const targetName = p.names?.[last] ?? 'someone';
  const hop = p.hops[1];
  const knowP = hop?.p ?? 0.35;
  const closeness: FriendCloseness = knowP >= 0.8 ? 3 : knowP >= 0.55 ? 2 : 1;
  const first_ = (s: string) => s.split(/\s+/)[0] ?? s;
  const shared = FRIEND_PERSON_NODE.exec(last)?.[1];
  return {
    pathId: p.id,
    friend: { userId: via.userId, name: via.name, first: first_(via.name) },
    target: {
      nodeId: last,
      name: targetName,
      first: first_(targetName),
      personId: shared ? undefined : last,
      sharedPersonId: shared,
    },
    closeness,
    phrase: hop?.phrase ?? closenessPhrase(closeness, first_(targetName)),
    p: p.p,
    band: p.band,
    path: p,
  };
}

/**
 * The routes through friends to a person or a company, from the server's ranked paths (findPathsOnServer, which also
 * keeps them by id for ask_for_intro). Empty without an account, without friends, or when nobody shares anyone there.
 */
export async function friendRoutes(user: Pick<User, 'id'>, target: PathTarget): Promise<FriendRoute[]> {
  if (!friendsAvailable(user)) return [];
  const r = await findPathsOnServer(user, target);
  if (!r.ok) return [];
  const out: FriendRoute[] = [];
  for (const p of r.value.paths) {
    const fr = friendRouteOf(p);
    if (fr) out.push(fr);
  }
  return out.sort((a, b) => b.p - a.p);
}

/** The shared people a friend knows at a company, as the company page line wants them: "Through friends: 3 people". */
export function throughFriendsLine(routes: FriendRoute[]): string {
  const people = new Set(routes.map((r) => r.target.nodeId));
  const n = people.size;
  return `Through friends: ${n} ${n === 1 ? 'person' : 'people'}`;
}

export type {
  Friend,
  FriendIntroAsk,
  FriendInvite,
  FriendShare,
  FriendShareMode,
  FriendSuggestion,
  InviteSuggestion,
};
