/**
 * Discover's feed of new people (plan 17 D): people not in the student's network, found on LinkedIn by searches
 * built from their goals, their resume and who they actually write to (core/recommend/discover.ts), a page at a time
 * with LinkedIn's cursor. Pages are kept in this browser (the `kv` table), so a reload shows the same people and the
 * next scroll continues each search where it stopped; tomorrow's searches pick up the same cursors.
 *
 * Nobody is added to Orbit until the student acts on a card (save, warm up, write, ask for an intro). People already
 * in Orbit (by LinkedIn member id, profile link, or name and company), the student themself, and people the student
 * turned down never come back. LinkedIn searches are rationed: Orbit's proxy allows 40 a day per account (chat and
 * the Map search too), and Discover uses at most DISCOVER_SEARCHES_PER_DAY of them; when either runs out the feed
 * says "more tomorrow".
 */
import type {
  CoffeeChat,
  DiscoverReason,
  DiscoverScore,
  DismissSignal,
  Person,
  Recommendation,
  User,
} from '@orbit/core';
import {
  buildDiscoverProfile,
  buildWarmUpPlan,
  cardReason,
  discoverQueries,
  linkedInSlug,
  newId,
  nextDiscoverQuery,
  normalizeCompany,
  roleFromHeadline,
  scoreDiscoverCandidate,
  stripDiacritics,
  tieBand,
} from '@orbit/core';
import { feedback } from '../db/repo';
import { db } from '../db/schema';
import type { LinkedInFound } from '../integrations/unipile';
import { evaluateImmediateSuggestions, startWarmUpOrOutreach } from './brief';
import { addLinkedInFound, linkedInSearchReady, rememberFound, searchLinkedInLive } from './linkedinSearch';
import { introducerIdFor, loadDiscoverSignals } from './recommend';
import { currentResumeFacets } from './resume';

/** LinkedIn searches Discover may run per account per day (the proxy allows 40 for everything). */
export const DISCOVER_SEARCHES_PER_DAY = 15;
/** One "load more" runs at most this many searches, and stops once it has this many new people. */
const MAX_CALLS_PER_LOAD = 4;
const ENOUGH_NEW = 8;
/** How many new people at one company a friend there is suggested to introduce. */
const INTROS_PER_COLLEAGUE = 2;
/** People kept in the browser's feed; the oldest beyond this are dropped (they can be found again). */
const KEEP = 600;

const stateKey = (userId: string) => `discoverFeed:${userId}`;

/** A person a search found, as the feed keeps them. */
export interface FoundEntry {
  memberId: string;
  name: string;
  headline?: string;
  /** read from the headline's first part ("Software Engineer at Stripe") */
  title?: string;
  company?: string;
  location?: string;
  profileUrl?: string;
  pictureUrl?: string;
  distance?: number;
  mutualCount?: number;
  /** found by a search filtered on the student's school: LinkedIn matched it in their education */
  schoolEvidence?: boolean;
  queryKey: string;
  /** what the search that found them was for ("Cornell alumni at Stripe") */
  why: string;
  seenAt: string;
}

export type FoundAction = 'save' | 'warm_up' | 'write' | 'intro';

export interface FeedState {
  v: 1;
  /** the UTC day the counters belong to (the proxy counts by UTC day too) */
  day: string;
  searches: number;
  /** the day the proxy said the account had run all its searches */
  limitDay?: string;
  queries: Record<string, { cursor?: string; pages: number; done?: boolean }>;
  people: FoundEntry[];
  dismissed: { memberId: string; reason: string; title?: string; company?: string; at: string }[];
  acted: { memberId: string; personId: string; action: FoundAction; at: string }[];
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

function freshState(now: Date): FeedState {
  return { v: 1, day: dayOf(now), searches: 0, queries: {}, people: [], dismissed: [], acted: [] };
}

export async function readFeedState(userId: string, now = new Date()): Promise<FeedState> {
  const row = await db.kv.get(stateKey(userId));
  const v = row?.value as FeedState | undefined;
  const s = v && v.v === 1 && Array.isArray(v.people) ? v : freshState(now);
  // a new day: the day's counters start again, the cursors stay
  if (s.day !== dayOf(now)) return { ...s, day: dayOf(now), searches: 0 };
  return s;
}

async function saveFeedState(userId: string, s: FeedState): Promise<void> {
  const people = s.people.length > KEEP ? s.people.slice(-KEEP) : s.people;
  await db.kv.put({ key: stateKey(userId), value: { ...s, people } });
}

const looseName = (s: string | undefined) =>
  stripDiacritics(s ?? '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Who Orbit already has, by every key a search result can match on. */
function orbitIdentities(people: Person[], user: Pick<User, 'fullName' | 'linkedinUrl'>) {
  const members = new Set<string>();
  const slugs = new Set<string>();
  const nameCompany = new Set<string>();
  for (const p of people) {
    if (p.linkedinMemberId) members.add(p.linkedinMemberId);
    if (p.linkedinSlug) slugs.add(p.linkedinSlug.toLowerCase());
    const co = normalizeCompany(p.currentOrganizationRaw);
    if (co) nameCompany.add(`${looseName(p.displayName)}|${co}`);
  }
  const me = linkedInSlug(user.linkedinUrl);
  if (me) slugs.add(me.toLowerCase());
  const myName = looseName(user.fullName);
  return (f: Pick<FoundEntry, 'memberId' | 'profileUrl' | 'name' | 'company'>) => {
    if (members.has(f.memberId)) return true;
    const slug = linkedInSlug(f.profileUrl)?.toLowerCase();
    if (slug && slugs.has(slug)) return true;
    const co = normalizeCompany(f.company);
    if (co && nameCompany.has(`${looseName(f.name)}|${co}`)) return true;
    return !!myName && looseName(f.name) === myName;
  };
}

const sameSchool = (a: string | undefined, b: string | undefined) => {
  const x = looseName(a);
  const y = looseName(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

function entryFrom(
  f: LinkedInFound,
  q: { key: string; why: string; school?: string },
  school: string,
  at: string,
) {
  const { title, org } = roleFromHeadline(f.headline);
  return {
    memberId: f.memberId,
    name: f.name,
    headline: f.headline,
    title,
    company: org,
    location: f.location,
    profileUrl: f.profileUrl,
    pictureUrl: f.pictureUrl,
    distance: f.distance,
    mutualCount: f.mutualCount,
    schoolEvidence: !!q.school && sameSchool(q.school, school),
    queryKey: q.key,
    why: q.why,
    seenAt: at,
  } satisfies FoundEntry;
}

/** Everything the feed scores with: the student's profile for Discover, and who is already in Orbit. */
async function loadContext(user: User, now = new Date()) {
  const [goals, targetCompanies, resumeFacets, people, state] = await Promise.all([
    db.goals.get(user.id),
    db.targetCompanies.where('userId').equals(user.id).toArray(),
    currentResumeFacets(user.id),
    db.people.where('userId').equals(user.id).toArray(),
    readFeedState(user.id, now),
  ]);
  const foundDismissed: DismissSignal[] = state.dismissed.map((d) => ({
    reason: d.reason,
    title: d.title,
    company: d.company,
  }));
  const signals = await loadDiscoverSignals(user.id, foundDismissed);
  const profile = buildDiscoverProfile({
    user,
    goals,
    targetCompanies,
    resumeFacets,
    outreach: signals.outreach,
    dismissed: signals.dismissed,
  });
  return { profile, people, state };
}

export type LoadMoreOutcome =
  | { status: 'ok'; added: number }
  /** LinkedIn is not connected live in this browser */
  | { status: 'not_connected' }
  /** nothing to search for yet: no goals, target companies or school */
  | { status: 'no_queries' }
  /** Discover's share of today's searches is used: more tomorrow */
  | { status: 'budget' }
  /** the proxy says the account ran all of today's LinkedIn searches */
  | { status: 'limit'; message: string }
  /** every search has run out of pages */
  | { status: 'exhausted' }
  | { status: 'error'; message: string };

const inflight = new Map<string, Promise<LoadMoreOutcome>>();

/**
 * Fetch the next page(s) of new people: the next search by weight (core nextDiscoverQuery), from its saved cursor,
 * until enough new people came in or this load's searches are used. One load at a time per student.
 */
export function loadMoreDiscover(
  user: User,
  opts: { fetch?: typeof fetch; now?: Date } = {},
): Promise<LoadMoreOutcome> {
  const running = inflight.get(user.id);
  if (running) return running;
  const p = loadMore(user, opts).finally(() => inflight.delete(user.id));
  inflight.set(user.id, p);
  return p;
}

async function loadMore(user: User, opts: { fetch?: typeof fetch; now?: Date }): Promise<LoadMoreOutcome> {
  const now = opts.now ?? new Date();
  if (!(await linkedInSearchReady(user))) return { status: 'not_connected' };
  const { profile, people, state } = await loadContext(user, now);
  const today = dayOf(now);
  if (state.limitDay === today)
    return { status: 'limit', message: 'LinkedIn searches are used up for today.' };
  if (state.searches >= DISCOVER_SEARCHES_PER_DAY) return { status: 'budget' };
  const queries = discoverQueries(profile);
  if (!queries.length) return { status: 'no_queries' };
  const known = orbitIdentities(people, user);
  const skip = new Set([
    ...state.people.map((p) => p.memberId),
    ...state.dismissed.map((d) => d.memberId),
    ...state.acted.map((a) => a.memberId),
  ]);
  let added = 0;
  let calls = 0;
  const at = now.toISOString();
  while (calls < MAX_CALLS_PER_LOAD && added < ENOUGH_NEW) {
    if (state.searches >= DISCOVER_SEARCHES_PER_DAY) {
      await saveFeedState(user.id, state);
      return added ? { status: 'ok', added } : { status: 'budget' };
    }
    const q = nextDiscoverQuery(queries, state.queries);
    if (!q) break;
    const progress = state.queries[q.key] ?? { pages: 0 };
    const r = await searchLinkedInLive(user, q.keywords, {
      filters: { title: q.title, company: q.company, school: q.school, location: q.location },
      cursor: progress.cursor,
      fetch: opts.fetch,
    });
    calls++;
    state.searches++;
    if (!r.ok) {
      if (r.limit) state.limitDay = today;
      await saveFeedState(user.id, state);
      if (added) return { status: 'ok', added };
      return r.limit ? { status: 'limit', message: r.message } : { status: 'error', message: r.message };
    }
    progress.pages++;
    progress.cursor = r.cursor;
    if (!r.cursor || !r.people.length) progress.done = true;
    state.queries[q.key] = progress;
    for (const f of r.people) {
      const entry = entryFrom(f, q, user.school, at);
      if (skip.has(f.memberId)) {
        // found again by another search: keep the newer photo and count, and a school match as evidence
        const prev = state.people.find((p) => p.memberId === f.memberId);
        if (prev) {
          prev.pictureUrl = f.pictureUrl ?? prev.pictureUrl;
          prev.mutualCount = f.mutualCount ?? prev.mutualCount;
          prev.schoolEvidence ||= entry.schoolEvidence;
        }
        continue;
      }
      if (known(entry)) continue;
      skip.add(f.memberId);
      state.people.push(entry);
      added++;
    }
  }
  await saveFeedState(user.id, state);
  if (added) return { status: 'ok', added };
  return nextDiscoverQuery(queries, state.queries) ? { status: 'ok', added: 0 } : { status: 'exhausted' };
}

// ---- the view ----------------------------------------------------------------------------------------------------

export interface FoundCard {
  kind: 'found';
  /** the add id ("li:" + member id) */
  id: string;
  entry: FoundEntry;
  scored: DiscoverScore;
  reason: DiscoverReason;
  /** the one action the card leads with */
  action: FoundAction;
  /** someone the student knows well at their company, who could introduce them */
  colleague?: { personId: string; firstName: string };
}

export interface NetworkCard {
  kind: 'network';
  id: string;
  rec: Recommendation;
  person: Person;
  reason?: { code: string; text: string };
  introducer?: Person;
}

export type DiscoverCard = FoundCard | NetworkCard;

export interface DiscoverView {
  /** new people, best first */
  found: FoundCard[];
  /** people in the network worth reaching now: saved first, then by score */
  network: NetworkCard[];
  /** the proactive picks at the top, each with one action */
  suggestions: DiscoverCard[];
  /** everything else, new people first with network people mixed in */
  feed: DiscoverCard[];
  connected: boolean;
  searchesLeft: number;
  limitToday: boolean;
  /** every search Discover would run has no more pages */
  exhausted: boolean;
  hasQueries: boolean;
  warmUpEnabled: boolean;
}

/** Warm or closer: the student knows them well enough to ask a favour. */
function knowsWell(p: Person): boolean {
  const band = p.tieBand ?? tieBand(p.tieScore ?? p.strength * 100);
  return band === 'warm' || band === 'strong' || band === 'close';
}

/** After every `every` new people, one person from the network; saved network people lead. */
export function mixFeed<T extends DiscoverCard>(found: T[], network: T[], every = 3): T[] {
  const saved = network.filter((c) => c.kind === 'network' && c.rec.status === 'saved');
  const rest = network.filter((c) => !saved.includes(c));
  const out: T[] = [...saved];
  let n = 0;
  for (const f of found) {
    out.push(f);
    if (++n % every === 0 && rest.length) out.push(rest.shift()!);
  }
  return [...out, ...rest];
}

const PROACTIVE = new Set([
  'colleague',
  'mutuals',
  'alumni_target',
  'shared_org_now',
  'like_replied',
  'referred',
  'path',
]);

/**
 * The proactive picks: people with a reason to write now (someone who can introduce them, mutual connections, an
 * alum at a target company, someone like the people who replied), best first, at most `n`, new people first.
 */
export function pickSuggestions(found: FoundCard[], network: NetworkCard[], n = 4): DiscoverCard[] {
  const why = (c: DiscoverCard) =>
    c.kind === 'found'
      ? c.scored.reasons.some(
          (r) => PROACTIVE.has(r.code) && (r.code !== 'mutuals' || (c.entry.mutualCount ?? 0) >= 3),
        )
      : !!c.introducer || c.rec.reasons.some((r) => PROACTIVE.has(r.code));
  // different reasons and different people to ask, not four intros through one friend
  const byAsk = new Set<string>();
  const f = found
    .filter(why)
    .filter((c) => {
      if (!c.colleague) return true;
      if (byAsk.has(c.colleague.personId)) return false;
      byAsk.add(c.colleague.personId);
      return true;
    })
    .slice(0, n);
  const room = Math.max(0, Math.min(2, n - f.length));
  const net = network.filter((c) => c.rec.status !== 'saved' && why(c)).slice(0, room);
  return [...f, ...net].slice(0, n);
}

function foundAction(scored: DiscoverScore, colleague: boolean, warmUpEnabled: boolean): FoundAction {
  if (colleague) return 'intro';
  if (scored.reach < 0.2) return 'save';
  return warmUpEnabled ? 'warm_up' : 'write';
}

/** Score every kept person and lay out the page: picks, then the mixed feed. Read inside a live query. */
export async function discoverView(user: User, now = new Date()): Promise<DiscoverView> {
  const [ctx, connected, settings, recs] = await Promise.all([
    loadContext(user, now),
    linkedInSearchReady(user),
    db.settings.get(user.id),
    db.recommendations
      .where('userId')
      .equals(user.id)
      .filter((r) => r.status === 'new' || r.status === 'saved')
      .toArray(),
  ]);
  const { profile, people, state } = ctx;
  const warmUpEnabled = settings?.warmUpEnabled ?? true;
  const known = orbitIdentities(people, user);
  const gone = new Set([...state.dismissed.map((d) => d.memberId), ...state.acted.map((a) => a.memberId)]);
  const byOrg = new Map<string, Person[]>();
  for (const p of people) {
    if (p.hiddenAt || !p.isHuman || !knowsWell(p)) continue;
    const k = normalizeCompany(p.currentOrganizationRaw);
    if (k) byOrg.set(k, [...(byOrg.get(k) ?? []), p]);
  }
  const found: FoundCard[] = [];
  for (const e of state.people) {
    if (gone.has(e.memberId) || known(e)) continue;
    const mate = (byOrg.get(normalizeCompany(e.company)) ?? []).sort((a, b) => b.strength - a.strength)[0];
    const scored = scoreDiscoverCandidate(
      {
        name: e.name,
        title: e.title,
        company: e.company,
        headline: e.headline,
        location: e.location,
        distance: e.distance,
        mutualCount: e.mutualCount,
        schoolEvidence: e.schoolEvidence,
        colleague: mate ? { firstName: mate.firstName, strength: mate.strength } : undefined,
        why: e.why,
      },
      profile,
    );
    found.push({
      kind: 'found',
      id: `li:${e.memberId}`,
      entry: e,
      scored,
      reason: scored.reasons[0] ?? { code: 'search', text: e.why },
      action: foundAction(scored, !!mate, warmUpEnabled),
      colleague: mate ? { personId: mate.id, firstName: mate.firstName } : undefined,
    });
  }
  found.sort((a, b) => b.scored.score - a.scored.score);
  // one friend at a big company is not an introduction to all of it: each is named as the way in for their
  // INTROS_PER_COLLEAGUE best matches; the others lead with their next reason and a warm-up
  const asked = new Map<string, number>();
  for (const c of found) {
    if (!c.colleague) continue;
    const n = (asked.get(c.colleague.personId) ?? 0) + 1;
    asked.set(c.colleague.personId, n);
    if (n <= INTROS_PER_COLLEAGUE) continue;
    const rest = c.scored.reasons.filter((r) => r.code !== 'colleague');
    c.reason = rest[0] ?? { code: 'search', text: c.entry.why };
    c.action = foundAction(c.scored, false, warmUpEnabled);
    c.colleague = undefined;
  }
  const byId = new Map(people.map((p) => [p.id, p]));
  const network: NetworkCard[] = recs
    .map((rec): NetworkCard | undefined => {
      const person = byId.get(rec.personId);
      if (!person || person.hiddenAt) return undefined;
      const introId = introducerIdFor(rec);
      return {
        kind: 'network',
        id: rec.id,
        rec,
        person,
        reason: cardReason(rec.reasons.filter((r) => r.code !== 'alumni')),
        introducer: introId ? byId.get(introId) : undefined,
      };
    })
    .filter((c): c is NetworkCard => !!c)
    .sort(
      (a, b) =>
        (b.rec.status === 'saved' ? 1 : 0) - (a.rec.status === 'saved' ? 1 : 0) || b.rec.score - a.rec.score,
    );
  const suggestions = pickSuggestions(found, network);
  const picked = new Set(suggestions.map((c) => c.id));
  const feed = mixFeed<DiscoverCard>(
    found.filter((c) => !picked.has(c.id)),
    network.filter((c) => !picked.has(c.id)),
  );
  const queries = discoverQueries(profile);
  return {
    found,
    network,
    suggestions,
    feed,
    connected,
    searchesLeft: Math.max(0, DISCOVER_SEARCHES_PER_DAY - state.searches),
    limitToday: state.limitDay === dayOf(now),
    exhausted: queries.length > 0 && !nextDiscoverQuery(queries, state.queries),
    hasQueries: queries.length > 0,
    warmUpEnabled,
  };
}

// ---- acting on a card --------------------------------------------------------------------------------------------

/** Not a fit: the card goes, and its company or role teaches the next pages (and the network list). */
export async function dismissFound(
  userId: string,
  memberId: string,
  reason: string,
  now = new Date(),
): Promise<boolean> {
  const s = await readFeedState(userId, now);
  const e = s.people.find((p) => p.memberId === memberId);
  if (!e || s.dismissed.some((d) => d.memberId === memberId)) return false;
  s.dismissed.push({ memberId, reason, title: e.title, company: e.company, at: now.toISOString() });
  await saveFeedState(userId, s);
  await feedback(userId, 'recommendation_dismiss', { reason, refTable: 'discover_found', refId: memberId });
  return true;
}

/** Undo a dismissal. */
export async function restoreFound(userId: string, memberId: string, now = new Date()): Promise<boolean> {
  const s = await readFeedState(userId, now);
  const n = s.dismissed.length;
  s.dismissed = s.dismissed.filter((d) => d.memberId !== memberId);
  if (s.dismissed.length === n) return false;
  await saveFeedState(userId, s);
  return true;
}

export type ActOutcome =
  | { ok: true; personId: string; chatId?: string; draftId?: string }
  | { ok: false; message: string };

/**
 * The student acted on a new person: only now do they become a person in Orbit (with a chat at "to contact").
 * Save stops there; Start warm-up turns that chat into a warm-up; Write opens a first message; an intro leaves the
 * person ready for the Map's intro routes.
 */
export async function actOnFound(
  user: User,
  memberId: string,
  action: FoundAction,
  now = new Date(),
): Promise<ActOutcome> {
  const s = await readFeedState(user.id, now);
  const e = s.people.find((p) => p.memberId === memberId);
  if (!e) return { ok: false, message: 'That person is no longer in the list. Refresh and try again.' };
  const id = rememberFound({
    memberId: e.memberId,
    name: e.name,
    headline: e.headline,
    location: e.location,
    profileUrl: e.profileUrl,
    distance: e.distance,
    pictureUrl: e.pictureUrl,
    mutualCount: e.mutualCount,
  });
  const added = await addLinkedInFound(user, [id], now);
  if (!added.ok) return { ok: false, message: added.message };
  const { id: personId, chatId } = added.people[0]!;
  const fresh = await readFeedState(user.id, now);
  if (!fresh.acted.some((a) => a.memberId === memberId))
    fresh.acted.push({ memberId, personId, action, at: now.toISOString() });
  await saveFeedState(user.id, fresh);
  if (action === 'write') {
    const r = await startWarmUpOrOutreach(user, personId, 'linkedin', 'recommendation', { skipWarmUp: true });
    return { ok: true, personId, chatId: r.chat?.id ?? chatId, draftId: r.draft?.id };
  }
  if (action === 'warm_up') await startWarmUp(user, personId, chatId, now);
  return { ok: true, personId, chatId };
}

/**
 * Turn the "to contact" chat the add opened into a warm-up (a few days of light LinkedIn engagement before the first
 * message), the way Start warm-up does for someone already in Orbit.
 */
async function startWarmUp(user: User, personId: string, chatId: string, now: Date): Promise<void> {
  const [settings, person, chat] = await Promise.all([
    db.settings.get(user.id),
    db.people.get(personId),
    db.chats.get(chatId),
  ]);
  if (!person?.linkedinSlug || !chat || chat.stage !== 'identified' || chat.warmUp) {
    await startWarmUpOrOutreach(user, personId, 'linkedin', 'recommendation');
    return;
  }
  const at = now.toISOString();
  await db.chats.update(chatId, {
    stage: 'warming',
    stageEnteredAt: at,
    source: 'recommendation',
    warmUp: buildWarmUpPlan(person.linkedinSlug, now, settings?.warmUpDays ?? 4, user.timezone),
    updatedAt: at,
  } satisfies Partial<CoffeeChat>);
  await db.stageEvents.add({
    id: newId('se'),
    userId: user.id,
    chatId,
    fromStage: 'identified',
    toStage: 'warming',
    status: 'applied',
    actor: 'user',
    reason: 'warmup:started',
    createdAt: at,
    decidedAt: at,
  });
  await evaluateImmediateSuggestions(user.id, { chatId, personId }, now);
}
