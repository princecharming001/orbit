/**
 * Instagram and X in the browser (plan 43 §3.1, §3.4, §3.6, §4, §5): connecting each, where it stands, the accounts
 * attached to people, the "same person" questions and the checks for who could introduce the student to someone.
 *
 * Instagram and X work only for signed-in students (§2): their messages arrive on Orbit's server and the graph is kept
 * there, so every call goes to orbit-api. The sample student has a made-up Instagram and X instead
 * (integrations/socialMock.ts), so the whole flow can be shown and tested without a server.
 *
 * What is offered and what is on is never decided here: engine/sources.ts is the one place that knows.
 */
import type { OptionalSource } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { recomputeAllStrengths } from '../db/repo';
import { db, type SocialAskRow, type SocialLinkRow, type SocialLookupRow } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import {
  type ApiFailure,
  callApi,
  type InstagramStatusResponse,
  isServerUser,
  type SocialLookupResult,
  type XStatusResponse,
} from '../integrations/orbitApi';
import * as mock from '../integrations/socialMock';
import { loadSources, setShareFollowsKept, setSourceState, sourcesNow, useSources } from './sources';

export type Platform = 'instagram' | 'x';

export const PLATFORM_NAME: Record<Platform, string> = { instagram: 'Instagram', x: 'X' };

/** Plan 43 §9 and §4: said plainly before the student connects Instagram. */
export const INSTAGRAM_RISK =
  'Instagram does not allow automation, and an account can be warned or restricted. Orbit reads far more than it writes, stays under the limits, spaces its reads out, and never sends a message without your tap.';

/** Plan 43 §5: what Orbit stores from X, said before the student signs in (X requires consent for DMs). */
export const X_CONSENT_LINES = [
  'Who you follow on X, and who follows you back.',
  'Your last 30 days of X messages.',
  'Nothing you post, and Orbit never posts for you.',
] as const;
export const X_CONSENT_MORE =
  'X data is kept 30 days, then deleted. It is never shared with your Orbit friends. Checking someone on X costs money, so Orbit shows the price first and reads nothing until you say go.';

export type InstagramView = InstagramStatusResponse;
export type XView = XStatusResponse;

type Fail = { ok: false; message: string };
const fail = (message: string): Fail => ({ ok: false, message });

/** Instagram and X need an Orbit account, or the sample student's made-up ones (§2). */
export function socialSupported(userId: string | undefined): boolean {
  return !!userId && (isServerUser(userId) || usesMockConnectors(userId));
}

/**
 * Whether a platform's row, step, card and tools are shown: offered (sources.ts) and possible here. Undefined while
 * the sources are read.
 */
export function useSocialOffered(userId: string | undefined, platform: Platform): boolean | undefined {
  const s = useSources(userId);
  if (!userId) return false;
  if (!s) return undefined;
  return socialSupported(userId) && s.offered.includes(platform);
}

/** The platforms in use for this student now: offered, on, and possible here. */
export async function socialInUse(userId: string): Promise<Set<Platform>> {
  if (!socialSupported(userId)) return new Set();
  const s = await sourcesNow(userId);
  return new Set([...s.inUse].filter((x): x is Platform => x === 'instagram' || x === 'x'));
}

// ---- status -------------------------------------------------------------------------------------------------------

const statusKey = (userId: string, p: Platform) => `social:${p}:${userId}`;

/** The last status read, kept so the row shows at once and a screen can watch it. */
export async function keptStatus<P extends Platform>(
  userId: string,
  p: P,
): Promise<(P extends 'instagram' ? InstagramView : XView) | undefined> {
  return (await db.kv.get(statusKey(userId, p)))?.value as
    | (P extends 'instagram' ? InstagramView : XView)
    | undefined;
}

async function keep(userId: string, p: Platform, v: InstagramView | XView): Promise<void> {
  await db.kv.put({ key: statusKey(userId, p), value: v });
}

export function useSocialStatus<P extends Platform>(
  userId: string | undefined,
  p: P,
): (P extends 'instagram' ? InstagramView : XView) | undefined {
  return useLiveQuery(async () => (userId ? keptStatus(userId, p) : undefined), [userId, p]);
}

/** Ask where Instagram stands now (GET /instagram/status, or the demo's). The answer is kept. */
export async function refreshInstagram(userId: string): Promise<InstagramView | Fail> {
  if (usesMockConnectors(userId)) {
    const v = await mock.instagramStatus(userId);
    await keep(userId, 'instagram', v);
    return v;
  }
  const r = await callApi('/instagram/status', {});
  if (!r.ok) return fail(r.message);
  await keep(userId, 'instagram', r.value);
  return r.value;
}

/** Ask where X stands now (GET /x/status, or the demo's). The answer is kept. */
export async function refreshX(userId: string): Promise<XView | Fail> {
  if (usesMockConnectors(userId)) {
    const v = await mock.xStatus(userId);
    await keep(userId, 'x', v);
    return v;
  }
  const r = await callApi('/x/status', {});
  if (!r.ok) return fail(r.message);
  await keep(userId, 'x', r.value);
  return r.value;
}

/** Steps of Instagram's first days in plain words (plan 43 §4): what is read now, what comes next. */
export function instagramProgress(v: Pick<InstagramView, 'steps'> | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.steps;
  if (s.profile !== 'done') return 'Reading your profile';
  if (s.chats !== 'done') return 'Reading your chats';
  if (s.following !== 'done') return 'Reading who you follow';
  if (s.followers !== 'done') return 'Reading who follows you, 25 at a time over the next days';
  return undefined;
}

// ---- connecting ---------------------------------------------------------------------------------------------------

let poll = { everyMs: 2500, tries: 120 };
/** Tests shorten the wait for the hosted sign-in. */
export function setSocialPollForTests(p: { everyMs: number; tries: number } | undefined): void {
  poll = p ?? { everyMs: 2500, tries: 120 };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ConnectResult =
  | { ok: true; status: InstagramView['status']; replaced?: boolean }
  | { ok: false; message: string };

/**
 * Connect Instagram: Unipile's hosted sign-in opens in a window (the way live LinkedIn connects), and Orbit waits for
 * /instagram/status to leave "connecting". A different account than before stops at `different_account`, for the
 * student to say whether to replace the old one. `replace` answers that question yes.
 */
export async function connectInstagram(
  userId: string,
  opts: { replace?: boolean; signal?: AbortSignal } = {},
): Promise<ConnectResult> {
  if (usesMockConnectors(userId)) {
    const r = await mock.connectInstagram(userId, opts);
    await afterSwitch(userId);
    await refreshInstagram(userId);
    return r;
  }
  const start = await callApi('/instagram/connect/start', opts.replace ? { replace: true } : {}, {
    signal: opts.signal,
  });
  if (!start.ok)
    return fail(
      start.reason === 'unconfigured'
        ? 'Instagram is not set up on Orbit yet. Try again later.'
        : start.message,
    );
  if (start.value.replaced) {
    await loadSources(userId);
    const st = await refreshInstagram(userId);
    return { ok: true, status: 'ok' in st ? 'active' : st.status, replaced: true };
  }
  const url = start.value.url;
  if (!url) return fail('Instagram sign-in is unavailable right now.');
  const win =
    typeof window !== 'undefined' ? window.open(url, 'orbit-instagram', 'width=520,height=720') : null;
  if (!win) return fail('Your browser blocked the Instagram window. Allow pop-ups for Orbit and try again.');
  for (let i = 0; i < poll.tries; i++) {
    await sleep(poll.everyMs);
    if (opts.signal?.aborted) return fail('Stopped connecting Instagram.');
    const st = await refreshInstagram(userId);
    if ('ok' in st) continue;
    if (st.status === 'connecting' || st.status === 'not_connected') {
      if (win.closed && i > 2) return fail('The Instagram window was closed before sign-in finished.');
      continue;
    }
    try {
      win.close();
    } catch {}
    await loadSources(userId);
    if (st.status === 'error') return fail('Instagram sign-in did not finish. Try again.');
    return { ok: true, status: st.status };
  }
  return fail('Instagram sign-in timed out. Try again.');
}

/** Release the Instagram account at Unipile. What Orbit read is kept until the student removes it. */
export async function disconnectInstagram(userId: string): Promise<{ ok: true } | Fail> {
  if (usesMockConnectors(userId)) {
    await mock.disconnect(userId, 'instagram');
  } else {
    const r = await callApi('/instagram/disconnect', {});
    if (!r.ok) return fail(r.message);
  }
  await refreshInstagram(userId);
  return { ok: true };
}

/**
 * Sign in with X, after the consent screen: `consent` must be the student's yes to what Orbit stores. With an account
 * the browser leaves for X and comes back to /settings?x=connected (or failed); the demo connects at once.
 */
export async function connectX(
  userId: string,
  consent: boolean,
): Promise<{ ok: true; leaving: boolean } | Fail> {
  if (!consent) return fail('Agree to what Orbit stores from X first.');
  if (usesMockConnectors(userId)) {
    await mock.connectX(userId);
    await afterSwitch(userId);
    await refreshX(userId);
    return { ok: true, leaving: false };
  }
  const r = await callApi('/x/connect/start', { consent: true });
  if (!r.ok)
    return fail(r.reason === 'unconfigured' ? 'X is not set up on Orbit yet. Try again later.' : r.message);
  window.location.assign(r.value.url);
  return { ok: true, leaving: true };
}

/** Revoke Orbit's access at X. What Orbit read is kept until it expires or the student removes it. */
export async function disconnectX(userId: string): Promise<{ ok: true } | Fail> {
  if (usesMockConnectors(userId)) await mock.disconnect(userId, 'x');
  else {
    const r = await callApi('/x/disconnect', {});
    if (!r.ok) return fail(r.message);
  }
  await refreshX(userId);
  return { ok: true };
}

/** After a switch in this browser: closeness and the graph read the source again. */
async function afterSwitch(userId: string): Promise<void> {
  await recomputeAllStrengths(userId).catch(() => undefined);
}

/**
 * The student's switch for Instagram or X (On, Off, Removed), through sources.ts. Removing also deletes what the
 * demo kept in this browser; an account's server removes its own.
 */
export async function switchSocial(
  userId: string,
  p: Platform,
  state: 'on' | 'off' | 'removed',
): Promise<{ ok: true } | Fail> {
  const r = await setSourceState(p, state, userId);
  if (!r.ok) return r;
  if (state === 'removed') {
    if (usesMockConnectors(userId)) await mock.removeAll(userId, p);
    await forgetLocal(userId, p);
  }
  await afterSwitch(userId);
  if (p === 'instagram') await refreshInstagram(userId);
  else await refreshX(userId);
  return { ok: true };
}

/** What this browser holds from a platform, deleted (Removed). */
async function forgetLocal(userId: string, p: Platform): Promise<void> {
  await db.socialLinks
    .where('userId')
    .equals(userId)
    .filter((l) => l.platform === p)
    .delete();
  await db.socialAsks
    .where('userId')
    .equals(userId)
    .filter((a) => a.platform === p)
    .delete();
  await db.socialLookups
    .where('userId')
    .equals(userId)
    .filter((l) => l.platform === p)
    .delete();
  await db.socialTies
    .where('userId')
    .equals(userId)
    .filter((t) => t.platform === p)
    .delete();
  const kinds = p === 'instagram' ? ['instagram_in', 'instagram_out'] : ['x_in', 'x_out'];
  await db.touchpoints
    .where('userId')
    .equals(userId)
    .filter((t) => kinds.includes(t.kind))
    .delete();
}

/** "Let my Orbit friends find paths through who I follow on Instagram" (plan 43 §3.6). Never for X. */
export async function setShareFollows(userId: string, on: boolean): Promise<{ ok: true } | Fail> {
  if (isServerUser(userId)) {
    const state = (await sourcesNow(userId)).states.instagram ?? 'on';
    const r = await callApi('/sources/instagram', {
      state: state === 'off' ? 'off' : 'on',
      shareFollows: on,
    });
    if (!r.ok) return fail(r.message);
  }
  await setShareFollowsKept(userId, on);
  return { ok: true };
}

/** Whether friends may find paths through who the student follows on Instagram: off unless they said yes. */
export function useShareFollows(userId: string | undefined): boolean {
  const s = useSources(userId);
  return !!s?.shareFollows?.instagram;
}

/** The platforms Orbit sends on itself, on the student's tap: connected and in use (the rest hand off to the app). */
export async function socialSendsHere(userId: string): Promise<Set<string>> {
  const inUse = await socialInUse(userId);
  const out = new Set<string>();
  for (const p of inUse) {
    const st = await keptStatus(userId, p);
    if (!st || st.status === 'active') out.add(p);
  }
  return out;
}

/**
 * What the chat's model is told about the optional sources: only those this Orbit offers, each with where the student
 * stands ("Instagram on as @maya", "X off", "Texts not connected"). Nothing offered: nothing said.
 */
export async function optionalSourcesLine(userId: string): Promise<string[]> {
  const s = await sourcesNow(userId);
  const out: string[] = [];
  for (const src of s.offered) {
    if ((src === 'instagram' || src === 'x') && !socialSupported(userId)) continue;
    const name = src === 'imessage' ? 'Texts' : PLATFORM_NAME[src];
    const state = s.states[src] ?? 'not_connected';
    const st = src === 'imessage' ? undefined : await keptStatus(userId, src);
    out.push(
      state === 'on'
        ? `${name} on${st?.username ? ` as @${st.username}` : ''} (show_setup ${src === 'imessage' ? 'texts' : src} to manage)`
        : state === 'off'
          ? `${name} off (kept, not counted)`
          : `${name} offered, not connected (show_setup ${src === 'imessage' ? 'texts' : src})`,
    );
  }
  return out;
}

// ---- accounts attached to people ----------------------------------------------------------------------------------

/** A person's Instagram and X accounts, only for the platforms in use (an off source's handles are hidden). */
export function usePersonLinks(userId: string | undefined, personId: string | undefined): SocialLinkRow[] {
  const s = useSources(userId);
  const rows =
    useLiveQuery(
      async () => (personId ? db.socialLinks.where('personId').equals(personId).toArray() : []),
      [personId],
    ) ?? [];
  if (!userId || !socialSupported(userId) || !s) return [];
  return rows.filter((l) => s.inUse.has(l.platform as OptionalSource));
}

/** Where an account opens: the profile on the platform. */
export function profileUrl(l: Pick<SocialLinkRow, 'platform' | 'username' | 'accountId'>): string {
  if (l.platform === 'instagram') return `https://www.instagram.com/${encodeURIComponent(l.username ?? '')}/`;
  return l.username
    ? `https://x.com/${encodeURIComponent(l.username)}`
    : `https://x.com/i/user/${encodeURIComponent(l.accountId)}`;
}

/** "@maya.chen", or the platform's name when the handle is not known. */
export function handleOf(l: Pick<SocialLinkRow, 'platform' | 'username'>): string {
  return l.username ? `@${l.username}` : `${PLATFORM_NAME[l.platform]} account`;
}

export interface PickPerson {
  ok: false;
  pick: { id: string; name: string }[];
  message: string;
}

function pickFrom(r: ApiFailure): PickPerson | undefined {
  if (r.code !== 'pick_person') return undefined;
  const people = (r.body?.people as { id: string; name: string }[] | undefined) ?? [];
  return {
    ok: false,
    pick: people,
    message: 'Both have things of their own. Pick which one stays. This cannot be undone.',
  };
}

/** "Not their account": the account comes off the person, and its messages move to a person of its own (§3.4). */
export async function detachLink(userId: string, linkId: string): Promise<{ ok: true } | Fail> {
  const link = await db.socialLinks.get(linkId);
  if (usesMockConnectors(userId)) {
    await mock.detach(userId, linkId);
  } else {
    const r = await callApi(`/social/links/${linkId}`, {});
    if (!r.ok) return fail(r.message);
    await db.socialLinks.delete(linkId);
  }
  if (link) await afterSwitch(userId);
  return { ok: true };
}

/**
 * The student says an account is this person. 409 `pick_person`: both people have things of their own, so the
 * student picks which one stays (`keep`), which cannot be undone.
 */
export async function attachAccount(
  userId: string,
  a: { platform: Platform; accountId: string; personId: string; keep?: string },
): Promise<{ ok: true; linkId: string } | PickPerson | Fail> {
  if (usesMockConnectors(userId)) return mock.attach(userId, a);
  const r = await callApi('/social/links', a);
  if (r.ok) {
    await refreshAsks(userId);
    return { ok: true, linkId: r.value.linkId };
  }
  return pickFrom(r) ?? fail(r.message);
}

// ---- "is this the same person" -----------------------------------------------------------------------------------

/** The open questions, for the platforms in use. */
export function useOpenAsks(userId: string | undefined, personId?: string): SocialAskRow[] {
  const s = useSources(userId);
  const rows =
    useLiveQuery(
      async () =>
        userId
          ? (await db.socialAsks.where('userId').equals(userId).toArray()).filter(
              (a) => a.status === 'open' && (!personId || a.personId === personId),
            )
          : [],
      [userId, personId],
    ) ?? [];
  if (!userId || !socialSupported(userId) || !s) return [];
  return rows.filter((a) => s.inUse.has(a.platform as OptionalSource));
}

/** Read the open questions again (GET /social/asks): the server's answer has the handles and the names. */
export async function refreshAsks(userId: string): Promise<void> {
  if (!isServerUser(userId)) return;
  const r = await callApi('/social/asks', {});
  if (!r.ok) return;
  const now = new Date().toISOString();
  const open = new Set(r.value.asks.map((a) => a.id));
  await db.transaction('rw', db.socialAsks, async () => {
    const had = await db.socialAsks.where('userId').equals(userId).toArray();
    for (const h of had)
      if (h.status === 'open' && !open.has(h.id)) await db.socialAsks.update(h.id, { status: 'stale' });
    for (const a of r.value.asks)
      await db.socialAsks.put({
        id: a.id,
        userId,
        platform: a.platform,
        accountId: a.accountId,
        personId: a.personId,
        username: a.username ?? undefined,
        name: a.name ?? undefined,
        personName: a.personName,
        score: a.score,
        signals: a.signals ?? {},
        status: 'open',
        createdAt: had.find((h) => h.id === a.id)?.createdAt ?? now,
        updatedAt: now,
      });
  });
}

/** Yes or No to one question. Yes may need the student to pick which person stays. */
export async function answerAsk(
  userId: string,
  askId: string,
  answer: 'yes' | 'no',
): Promise<{ ok: true } | PickPerson | Fail> {
  if (usesMockConnectors(userId)) {
    const r = await mock.answer(userId, askId, answer);
    if (r.ok) await afterSwitch(userId);
    return r;
  }
  const r = await callApi(`/social/asks/${askId}`, { answer });
  if (!r.ok) return pickFrom(r) ?? fail(r.message);
  await db.socialAsks.update(askId, { status: r.value.status, updatedAt: new Date().toISOString() });
  return { ok: true };
}

/** The evidence on a question, both ways, in plain lines. */
export function askEvidence(a: Pick<SocialAskRow, 'signals'>): { for: string[]; against: string[] } {
  const s = a.signals ?? {};
  const lines = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
  const out = { for: lines(s.for), against: lines(s.against) };
  // a server that sends the signals by name: each one said in words
  if (!out.for.length && !out.against.length)
    for (const [k, v] of Object.entries(s)) {
      if (v === true || (typeof v === 'number' && v > 0))
        out.for.push(SIGNAL_WORDS[k] ?? k.replace(/_/g, ' '));
      if (typeof v === 'number' && v < 0) out.against.push(SIGNAL_WORDS[k] ?? k.replace(/_/g, ' '));
    }
  return out;
}

const SIGNAL_WORDS: Record<string, string> = {
  name: 'The same name',
  handle: 'The handle spells their name',
  employer: 'The bio names the same employer',
  school: 'The bio names the same school',
  link: 'The same personal link',
  picture: 'The same profile picture',
  neighbours: 'You follow some of the same people',
  place: 'The same city',
  publicFigure: 'A public figure has the same name',
  otherHandle: 'They list another handle',
};

/** "Is @jchen_22 on Instagram the Jason Chen you know from Stripe?" */
export function askQuestion(
  a: Pick<SocialAskRow, 'platform' | 'username' | 'personName'>,
  org?: string,
): string {
  return `Is @${a.username ?? 'this account'} on ${PLATFORM_NAME[a.platform]} the ${a.personName ?? 'person'} you know${org ? ` from ${org}` : ''}?`;
}

// ---- checks: who could introduce the student --------------------------------------------------------------------

export interface XQuote {
  quoteUsd: number;
  list: string;
  size: number;
  reason?: string;
}

export type CheckStart =
  | { ok: true; lookupId: string }
  | { ok: true; quote: XQuote }
  | { ok: false; message: string; code?: 'source_off' | 'no_account' };

/** X's check: the price agreed to goes with the yes, and a yes with no fresh price asks for the price again. */
export interface CheckOptions {
  confirm?: boolean;
  /** the price the student said yes to (X only) */
  quoteUsd?: number;
}

/**
 * "Check Instagram for Priya" / "Check X for Priya" (plan 43 §3.6, §5). X shows its price first: without `confirm` the
 * answer is a quote and nothing is read; with it, the check starts. The lookup is kept in this browser and followed
 * until it finishes.
 */
export async function startCheck(
  userId: string,
  platform: Platform,
  personId: string,
  opts: CheckOptions = {},
): Promise<CheckStart> {
  if (usesMockConnectors(userId)) return mock.startLookup(userId, platform, personId, opts);
  const r = await callApi('/social/lookups', {
    platform,
    personId,
    ...(opts.confirm ? { confirm: true } : {}),
    ...(opts.confirm && opts.quoteUsd !== undefined ? { quoteUsd: opts.quoteUsd } : {}),
  });
  if (!r.ok) {
    // the price is more than 15 minutes old (or was never asked): ask for it again rather than read anything
    if (r.code === 'quote_first' && opts.confirm) return startCheck(userId, platform, personId);
    if (r.code === 'source_off')
      return { ok: false, code: 'source_off', message: `${PLATFORM_NAME[platform]} is off.` };
    if (r.code === 'no_account') return { ok: false, code: 'no_account', message: r.message };
    return fail(r.message);
  }
  if (r.value.status === 'quote') {
    const q = r.value;
    return { ok: true, quote: { quoteUsd: q.quoteUsd, list: q.list, size: q.size, reason: q.reason } };
  }
  const now = new Date().toISOString();
  const id = r.value.lookupId;
  await db.socialLookups.put({
    id,
    userId,
    platform,
    targetPersonId: personId,
    status: r.value.status,
    createdAt: (await db.socialLookups.get(id))?.createdAt ?? now,
    updatedAt: now,
  });
  void followLookup(userId, id);
  return { ok: true, lookupId: id };
}

const following = new Set<string>();

/** Ask how a lookup stands until it is done (a job that can take minutes or hours on Instagram's budget). */
export async function followLookup(userId: string, lookupId: string): Promise<SocialLookupRow | undefined> {
  if (usesMockConnectors(userId) || following.has(lookupId)) return db.socialLookups.get(lookupId);
  following.add(lookupId);
  try {
    for (let i = 0; i < poll.tries; i++) {
      const r = await callApi(`/social/lookups/${lookupId}`, {});
      if (r.ok) {
        await db.socialLookups.update(lookupId, {
          status: r.value.status,
          ...(r.value.result ? { result: r.value.result as SocialLookupResult } : {}),
          updatedAt: new Date().toISOString(),
        });
        if (r.value.status === 'done' || r.value.status === 'failed') break;
      }
      await sleep(Math.max(poll.everyMs, 3000));
    }
  } finally {
    following.delete(lookupId);
  }
  return db.socialLookups.get(lookupId);
}

/** The newest check of a person on a platform, watched. */
export function useLatestLookup(
  userId: string | undefined,
  personId: string | undefined,
  platform: Platform,
): SocialLookupRow | undefined {
  return useLiveQuery(async () => {
    if (!userId || !personId) return undefined;
    const rows = (await db.socialLookups.where('targetPersonId').equals(personId).toArray()).filter(
      (l) => l.userId === userId && l.platform === platform,
    );
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }, [userId, personId, platform]);
}

/** "This reads about 400 people on X and costs about $4. Go ahead?" */
export function quoteLine(q: XQuote): string {
  const usd = q.quoteUsd >= 10 ? Math.round(q.quoteUsd) : Math.round(q.quoteUsd * 100) / 100;
  const people = q.size >= 100 ? Math.round(q.size / 50) * 50 : q.size;
  return `This reads about ${people.toLocaleString('en-US')} ${people === 1 ? 'person' : 'people'} on X and costs about $${usd}. Go ahead?`;
}

/** What a finished check says, in words (plan 43 §3.6). */
export function lookupSummary(
  l: Pick<SocialLookupRow, 'status' | 'platform' | 'result'>,
  targetFirst: string,
): string | undefined {
  const where = PLATFORM_NAME[l.platform];
  if (l.status === 'failed') return `Orbit could not finish checking ${where}. Try again later.`;
  if (l.status !== 'done') return undefined;
  const r = l.result;
  if (!r) return undefined;
  if (r.reason === 'private') return 'Their account is private.';
  if (r.reason === 'source_off') return `${where} is off.`;
  if (r.reason === 'sign_in') return `Sign in to ${where} again to check.`;
  if (r.bridges.length) return undefined;
  if (r.partial) return `${where} could not show all of it, so someone may still be missing.`;
  return `No one you know follows ${targetFirst} back on ${where}.`;
}

/** Open the platform's own chat with someone, for a draft the student sends there themselves. */
export function chatUrl(l: Pick<SocialLinkRow, 'platform' | 'username' | 'accountId'>): string {
  if (l.platform === 'instagram')
    return l.username ? `https://ig.me/m/${encodeURIComponent(l.username)}` : profileUrl(l);
  return `https://x.com/messages/compose?recipient_id=${encodeURIComponent(l.accountId)}`;
}
