/**
 * Discover's feed of new people (plan 17 D): people not in the student's network, found on LinkedIn by searches
 * built from their goals, their resume and who they actually write to (core/recommend/discover.ts), a page at a time
 * with LinkedIn's cursor. Pages are kept in this browser (the `kv` table), so a reload shows the same people and the
 * next scroll continues each search where it stopped; tomorrow's searches pick up the same cursors.
 *
 * Nobody is added to Orbit until the student acts on a card (save, warm up, write, ask for an intro). People already
 * in Orbit (by LinkedIn member id, profile link, or name and company), the student themself, and people the student
 * turned down never come back. LinkedIn searches are rationed: Orbit's proxy allows 100 search calls a day per
 * account and lets Discover's searches fill at most 70 of them (orbit-connectors LEDGER_CEILINGS, shared with chat
 * and the Map search), and Discover itself runs at most DISCOVER_SEARCHES_PER_DAY; when either runs out the feed
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
  WhyReason,
} from '@orbit/core';
import {
  buildDiscoverProfile,
  buildWarmUpPlan,
  cleanName,
  cleanRole,
  DISCOVER_MIN_MATCH,
  DISCOVER_MIN_SCORE,
  directorOrAbove,
  discoverQueries,
  junkProfile,
  linkedInSlug,
  newId,
  nextDiscoverQuery,
  normalizeCompany,
  rankScore,
  roleFromHeadline,
  scoreDiscoverCandidate,
  stripDiacritics,
  tieBand,
  titleStatus,
  whyFromReasons,
  whyThem,
  worthSuggesting,
} from '@orbit/core';
import { feedback } from '../db/repo';
import { db } from '../db/schema';
import type { LinkedInFound } from '../integrations/unipile';
import { evaluateImmediateSuggestions, startWarmUpOrOutreach } from './brief';
import { addLinkedInFound, linkedInSearchReady, rememberFound, searchLinkedInLive } from './linkedinSearch';
import {
  type LoadedPointContext,
  loadPointContext,
  type PersonPoint,
  personPoints,
  whySignalsFor,
} from './personPoints';
import { introducerIdFor, isColdRecommendation, loadDiscoverSignals, waitingOnThem } from './recommend';
import { currentResumeFacets } from './resume';

/** LinkedIn searches Discover may run per account per day, well inside the proxy's 70 for Discover (of 100). */
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

/** Changes to the feed state, one at a time per student: a write never lands on top of another's half-done one. */
const writing = new Map<string, Promise<unknown>>();
function serial<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const before = writing.get(userId) ?? Promise.resolve();
  const next = before.then(fn, fn);
  writing.set(
    userId,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Save what a load of more people found. A search takes seconds, and the student may dismiss or act on a card
 * meanwhile: those lists are theirs, so they are read fresh at save time, never written back from the load's copy.
 */
function saveLoaded(userId: string, s: FeedState): Promise<void> {
  return serial(userId, async () => {
    const latest = await readFeedState(userId);
    await saveFeedState(userId, { ...s, dismissed: latest.dismissed, acted: latest.acted });
  });
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

/** A search result as the feed keeps it (exported for the simulation, which stores pages the way a search does). */
export function entryFrom(
  f: LinkedInFound,
  q: { key: string; why: string; school?: string; company?: string; title?: string },
  school: string,
  at: string,
) {
  const { title, org } = roleFromHeadline(f.headline);
  return {
    memberId: f.memberId,
    name: f.name,
    headline: f.headline,
    // a role, never a self-description ("Experienced and versatile Product Manager" is a Product Manager)
    title: cleanRole(title),
    // LinkedIn's company filter matched their current company: it stands when the headline names none
    company: org ?? (q.company?.trim() || undefined),
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
      await saveLoaded(user.id, state);
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
      await saveLoaded(user.id, state);
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
  await saveLoaded(user.id, state);
  if (added) return { status: 'ok', added };
  return nextDiscoverQuery(queries, state.queries) ? { status: 'ok', added: 0 } : { status: 'exhausted' };
}

// ---- the view ----------------------------------------------------------------------------------------------------

/** The three meters on a card and the score the page ranks by (core rankScore), each 0..1. */
export interface CardMetrics {
  /** how well they fit the student's goals */
  match: number;
  /** how warm the path to them is */
  reach: number;
  /** how likely they are to answer the student */
  odds: number;
  score: number;
}

export interface FoundCard {
  kind: 'found';
  /** the add id ("li:" + member id) */
  id: string;
  entry: FoundEntry;
  /** their name as a card shows it ("CHAYA M." reads "Chaya M.") */
  name: string;
  /** their role, never a self-description from the headline */
  role?: string;
  scored: DiscoverScore;
  /** why them, strongest first: a specific reason leads */
  why: WhyReason[];
  metrics: CardMetrics;
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
  name: string;
  why: WhyReason[];
  /** what else is worth knowing about them (personPoints) */
  points: PersonPoint[];
  metrics: CardMetrics;
  /** an intro when someone on the route can introduce them, a warm-up when they know the student only from
   * LinkedIn, a first message when they know each other */
  action: 'intro' | 'warm_up' | 'write';
  reason?: { code: string; text: string };
  introducer?: Person;
}

export type DiscoverCard = FoundCard | NetworkCard;

export interface DiscoverView {
  /** new people worth meeting, best first */
  found: FoundCard[];
  /** people in the network worth reaching now: saved first, then by score */
  network: NetworkCard[];
  /** the proactive picks at the top: the strongest few, each with one action */
  suggestions: DiscoverCard[];
  /** everything else, best first (saved people lead) */
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

/** How many picks "Suggested for you" holds at most, and how many from one company. */
const PICKS = 4;
const PICKS_PER_COMPANY = 2;

const cardCompany = (c: DiscoverCard) =>
  normalizeCompany(c.kind === 'found' ? c.entry.company : c.person.currentOrganizationRaw);
const cardRole = (c: DiscoverCard) => (c.kind === 'found' ? c.role : c.person.currentTitle);
/** The person who is the way in: the friend at their company, or the introducer on the route. */
const wayIn = (c: DiscoverCard) => (c.kind === 'found' ? c.colleague?.personId : c.introducer?.id);

/**
 * Could this card be a pick: worth writing to now with one clear action. Not someone far out on LinkedIn with no way
 * in, a director or VP with no one to introduce them, a name with only an initial, or a card whose action is to save.
 */
export function pickable(c: DiscoverCard): boolean {
  if (c.kind === 'network' && c.rec.status === 'saved') return false;
  if (c.action === 'save') return false;
  if (cleanName(c.name).quality !== 'full') return false;
  if (c.kind === 'found' && (c.entry.distance ?? 3) >= 3 && !c.colleague) return false;
  if (directorOrAbove(cardRole(c)) && !wayIn(c)) return false;
  return !!c.why[0]?.anchor;
}

/**
 * The proactive picks: the strongest few by the score the feed is ranked by, at most two at one company and one per
 * friend asked for an intro, so the row is four different reasons to write today.
 */
export function pickSuggestions(cards: DiscoverCard[], n = PICKS): DiscoverCard[] {
  const perCompany = new Map<string, number>();
  const asked = new Set<string>();
  const out: DiscoverCard[] = [];
  for (const c of [...cards].sort((a, b) => b.metrics.score - a.metrics.score)) {
    if (out.length >= n) break;
    if (!pickable(c)) continue;
    const co = cardCompany(c);
    const via = wayIn(c);
    if (co && (perCompany.get(co) ?? 0) >= PICKS_PER_COMPANY) continue;
    if (via && asked.has(via)) continue;
    if (co) perCompany.set(co, (perCompany.get(co) ?? 0) + 1);
    if (via) asked.add(via);
    out.push(c);
  }
  return out;
}

function foundAction(scored: DiscoverScore, colleague: boolean, warmUpEnabled: boolean): FoundAction {
  if (colleague) return 'intro';
  if (scored.reach < 0.2) return 'save';
  return warmUpEnabled ? 'warm_up' : 'write';
}

/** One person, once: by name and company. The stronger card stays. */
function dedupe<T extends DiscoverCard>(cards: T[]): T[] {
  const seen = new Set<string>();
  return cards.filter((c) => {
    const co = cardCompany(c);
    const k = `${looseName(c.name)}|${co}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Score every kept person and lay out the page. Only people with a specific reason to meet them are shown (core
 * worthSuggesting), with a Match and a rank above the floor: when that leaves few, the page says that's everyone
 * rather than padding. Read inside a live query.
 */
export async function discoverView(
  user: User,
  now = new Date(),
  /**
   * `pointCtx`: what the network cards say about their people, when the page read it in its own live query (it reads
   * many tables a LinkedIn sync writes to, so the page keeps it out of this one and passes `readContext: false`:
   * someone it does not cover yet is shown once it does). Without it the view reads it here.
   */
  opts: { pointCtx?: LoadedPointContext; readContext?: boolean } = {},
): Promise<DiscoverView> {
  const [ctx, connected, settings, recs, chats] = await Promise.all([
    loadContext(user, now),
    linkedInSearchReady(user),
    db.settings.get(user.id),
    db.recommendations
      .where('userId')
      .equals(user.id)
      .filter((r) => r.status === 'new' || r.status === 'saved')
      .toArray(),
    db.chats.where('userId').equals(user.id).toArray(),
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

  // ---- new people ----
  const score = (e: FoundEntry, role: string | undefined, mate?: Person) =>
    scoreDiscoverCandidate(
      {
        name: e.name,
        title: role,
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
  const candidates: {
    e: FoundEntry;
    role?: string;
    name: string;
    initial: boolean;
    mate?: Person;
    s: DiscoverScore;
  }[] = [];
  for (const e of state.people) {
    if (gone.has(e.memberId) || known(e)) continue;
    // a role read again on every view: a page kept from before keeps a self-description ("Experienced and
    // versatile Product Manager") as its title
    const role = cleanRole(e.title);
    if (junkProfile({ name: e.name, title: role, company: e.company, headline: e.headline })) continue;
    const status = titleStatus(role ?? e.headline);
    if (status === 'student' || status === 'aspiring') continue;
    const n = cleanName(e.name);
    const mate = (byOrg.get(normalizeCompany(e.company)) ?? []).sort((a, b) => b.strength - a.strength)[0];
    candidates.push({
      e,
      role,
      name: n.name,
      initial: n.quality === 'initial',
      mate,
      s: score(e, role, mate),
    });
  }
  candidates.sort((a, b) => b.s.score - a.s.score);
  // one friend at a big company is not an introduction to all of it: each is named as the way in for their
  // INTROS_PER_COLLEAGUE best matches; the others are scored and reasoned without them
  const asked = new Map<string, number>();
  for (const c of candidates) {
    if (!c.mate) continue;
    const n = (asked.get(c.mate.id) ?? 0) + 1;
    asked.set(c.mate.id, n);
    if (n <= INTROS_PER_COLLEAGUE) continue;
    c.mate = undefined;
    c.s = score(c.e, c.role);
  }
  const found: FoundCard[] = [];
  for (const { e, role, name, initial, mate, s } of candidates) {
    const why = whyFromReasons(
      s.reasons,
      { title: role, company: e.company, headline: e.headline, mutualCount: e.mutualCount },
      { filler: false },
    );
    const metrics: CardMetrics = {
      match: s.fit,
      reach: s.reach,
      odds: s.odds,
      score: rankScore({ match: s.fit, reach: s.reach, odds: s.odds, initialName: initial }),
    };
    if (!worthSuggesting(why, s.goalLink) || s.fit < DISCOVER_MIN_MATCH || metrics.score < DISCOVER_MIN_SCORE)
      continue;
    found.push({
      kind: 'found',
      id: `li:${e.memberId}`,
      entry: e,
      name,
      role,
      scored: s,
      why,
      metrics,
      reason: { code: why[0]!.kind, text: why[0]!.text },
      action: foundAction(s, !!mate, warmUpEnabled),
      colleague: mate ? { personId: mate.id, firstName: mate.firstName } : undefined,
    });
  }
  found.sort((a, b) => b.metrics.score - a.metrics.score);

  // ---- people in the network ----
  const byId = new Map(people.map((p) => [p.id, p]));
  const inChat = new Set(chats.map((c) => c.personId));
  const candidatesNet = recs
    .map((rec) => ({ rec, person: byId.get(rec.personId) }))
    .filter(
      (x): x is { rec: Recommendation; person: Person } =>
        !!x.person &&
        !x.person.hiddenAt &&
        !x.person.doNotContact &&
        x.person.isHuman &&
        // already in a chat (to contact, waiting, declined, archived): the board has them, Discover does not
        !inChat.has(x.person.id),
    );
  const given = opts.pointCtx;
  const covered = (id: string) => opts.readContext !== false || !!given?.forIds.has(id);
  const pointCtx = !candidatesNet.length
    ? undefined
    : opts.readContext === false || (given && candidatesNet.every((x) => given.forIds.has(x.person.id)))
      ? given
      : await loadPointContext(
          user,
          candidatesNet.map((x) => x.person.id),
          now,
          people,
        );
  const network: NetworkCard[] = [];
  for (const { rec, person } of candidatesNet) {
    if (!pointCtx) break;
    if (!covered(person.id)) continue;
    if (waitingOnThem(person.id, pointCtx.touchpoints, now)) continue;
    const n = cleanName(person.displayName);
    if (n.quality === 'junk' || (!person.currentTitle?.trim() && !person.currentOrganizationRaw?.trim()))
      continue;
    const introId = introducerIdFor(rec);
    const introducer = introId ? byId.get(introId) : undefined;
    const pctx = { ...pointCtx, dossier: pointCtx.dossiers.get(person.id) };
    const why = whyThem(whySignalsFor(person, rec, pctx, introducer), { filler: false });
    const saved = rec.status === 'saved';
    if (!saved && (!worthSuggesting(why, true) || rec.fitScore < DISCOVER_MIN_MATCH)) continue;
    const metrics: CardMetrics = {
      match: rec.fitScore,
      reach: rec.reachScore,
      odds: rec.responsePrior,
      score: rankScore({
        match: rec.fitScore,
        reach: rec.reachScore,
        odds: rec.responsePrior,
        initialName: n.quality === 'initial',
      }),
    };
    if (!saved && metrics.score < DISCOVER_MIN_SCORE) continue;
    const cold = isColdRecommendation(person, rec);
    network.push({
      kind: 'network',
      id: rec.id,
      rec,
      person,
      name: n.name,
      why,
      points: personPoints(person, rec, pctx),
      metrics,
      action: cold && introducer ? 'intro' : cold && warmUpEnabled ? 'warm_up' : 'write',
      reason: why[0] ? { code: why[0].kind, text: why[0].text } : undefined,
      introducer,
    });
  }
  const isSaved = (c: DiscoverCard) => c.kind === 'network' && c.rec.status === 'saved';
  const byRank = (a: DiscoverCard, b: DiscoverCard) =>
    (isSaved(b) ? 1 : 0) - (isSaved(a) ? 1 : 0) || b.metrics.score - a.metrics.score;
  const net = dedupe(network.sort(byRank));
  const all = dedupe<DiscoverCard>([...found, ...net].sort(byRank));
  // a short list keeps its full cards: one pick for every three people, four at most
  const suggestions = pickSuggestions(all, Math.min(PICKS, Math.floor(all.length / 3)));
  const picked = new Set(suggestions.map((c) => c.id));
  const feed = all.filter((c) => !picked.has(c.id));
  const queries = discoverQueries(profile);
  return {
    found: all.filter((c): c is FoundCard => c.kind === 'found'),
    network: net,
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
  const done = await serial(userId, async () => {
    const s = await readFeedState(userId, now);
    const e = s.people.find((p) => p.memberId === memberId);
    if (!e || s.dismissed.some((d) => d.memberId === memberId)) return false;
    s.dismissed.push({ memberId, reason, title: e.title, company: e.company, at: now.toISOString() });
    await saveFeedState(userId, s);
    return true;
  });
  if (!done) return false;
  await feedback(userId, 'recommendation_dismiss', { reason, refTable: 'discover_found', refId: memberId });
  return true;
}

/** Undo a dismissal. */
export async function restoreFound(userId: string, memberId: string, now = new Date()): Promise<boolean> {
  return serial(userId, async () => {
    const s = await readFeedState(userId, now);
    const n = s.dismissed.length;
    s.dismissed = s.dismissed.filter((d) => d.memberId !== memberId);
    if (s.dismissed.length === n) return false;
    await saveFeedState(userId, s);
    return true;
  });
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
  await serial(user.id, async () => {
    const fresh = await readFeedState(user.id, now);
    if (!fresh.acted.some((a) => a.memberId === memberId))
      fresh.acted.push({ memberId, personId, action, at: now.toISOString() });
    await saveFeedState(user.id, fresh);
  });
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
