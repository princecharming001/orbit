import type { ExternalCandidate, IntroWeb, OrbitNode, Person, ReachPath } from '@orbit/core';
import {
  buildIntroWeb,
  combinedPairWeights,
  describeIntroChain,
  hasRealName,
  introStories,
  isKnownContact,
  MEDIUM_TIE,
  normalizeCompany,
  orbitGroupKey,
  TIE_BAND_LABELS,
  tieBand,
} from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { X } from 'lucide-react';
import { type CSSProperties, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAskIntro } from '../components/askIntro';
import { CompanyLogo, LogoText } from '../components/CompanyLogo';
import { MapPersonCard } from '../components/map/MapPersonCard';
import { PairNoteMenu } from '../components/map/PairNoteMenu';
import { ReachMutuals } from '../components/map/ReachMutuals';
import { ReachSearch } from '../components/map/ReachSearch';
import { RouteBadge } from '../components/map/RouteBadge';
import { useClosenessKey } from '../components/map/useCloseness';
import { type CardPlace, OrbitMap, useCoarsePointer } from '../components/OrbitMap';
import type { FocusSpec, WebSpec } from '../components/orbitScene';
import { LINEAGE } from '../components/orbitScene';
import { StrengthDots } from '../components/people/shared';
import { ResizeHandle, useResizableWidth } from '../components/ResizeHandle';
import { TargetPlanCard } from '../components/TargetPlanCard';
import { useWarmIntros, WarmIntrosPanel } from '../components/WarmIntrosPanel';
import { db } from '../db/schema';
import { draftMessage } from '../engine/brief';
import {
  buildReachGraph,
  type CompanyReach,
  isColdDirect,
  isUnambiguous,
  mutualStandings,
  type ReachCandidate,
  rankReachTargets,
  reachCandidates,
  reachCompany,
  reachPersonIn,
  targetCompanyMatcher,
  userTieWeight,
  WARMER_ROUTES_WHY,
  type WarmReachPath,
} from '../engine/graph';
import { checkHops, checkState, hopEvidenceVersion, subscribeHopEvidence } from '../engine/hopEvidence';
import { addLinkedInFound, type FoundView } from '../engine/linkedinSearch';
import { subscribePairNotes } from '../engine/pairNotes';
import { maintenanceRunning, watchMaintenance } from '../engine/sync';
import { planFromInput } from '../engine/targetPlan';
import { isJobLink, linkIn } from '../integrations/postings';
import { useSession } from '../state/session';
import { useShowReasoning } from '../state/showReasoning';
import { Avatar, Button, Card, Chip, cx, LinkedInMark, useToast } from '../ui';

type Filter = 'all' | 'targets' | 'alumni' | 'chats' | 'recent' | 'intros';

const FILTERS: [Filter, string][] = [
  ['all', 'Everyone'],
  ['targets', 'Target companies'],
  ['alumni', 'Alumni'],
  ['chats', 'In pipeline'],
  ['recent', 'Last 90 days'],
  ['intros', 'Introductions'],
];

/** How many people the pending-suggestion ripple marks at most: those behind the highest-priority suggestions. */
const RIPPLE_TOP = 3;
/** On a touch screen every control on the map page is at least 44 px tall, so a thumb lands on it. */
const TAP = 'pointer-coarse:min-h-11';
/** The longest the map waits for the day's maintenance before it lays out anyway. */
const MAINTENANCE_WAIT_MS = 2500;
/** How long the legend line keeps the news of someone joining or a chat booked. */
const NEWS_MS = 6000;

/** How many of each person's direct connections the map draws on hover. */
const HOVER_LINKS = 12;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Someone the search can offer: a person with a real name, not hidden. */
const named = (p: Person) => p.isHuman && !p.hiddenAt && hasRealName(p);

/** The student's tie to someone on a route, as on their card: "warm tie · 48". */
function tieWords(p: Person): string {
  const s = Math.round(userTieWeight(p) * 100);
  return `${TIE_BAND_LABELS[tieBand(s)].toLowerCase()} tie · ${s}`;
}

/** How well two people on a route know each other, in the route card's words (plan 21 §3.7). */
const HOP_WORDS = {
  close: 'close',
  know: 'know each other',
  connected: 'connected',
  unclear: 'unclear',
} as const;

export function MapPage() {
  const { userId, user } = useSession();
  // why a route goes through someone: hidden unless the student turned explanations on
  const reasons = useShowReasoning();
  // the side panel's width, dragged by its edge: at least 300px, and the orbit always keeps 440px
  const splitRef = useRef<HTMLDivElement>(null);
  const panel = useResizableWidth(
    'orbit:map-panel-width',
    { initial: 380, min: 300, reserve: 440 },
    splitRef,
  );
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const reachParam = params.get('reach');
  const touch = useCoarsePointer();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  // undefined while routes are being computed, so the panel never claims "no route" before it knows
  const [paths, setPaths] = useState<WarmReachPath[] | undefined>([]);
  // plan 21: routes re-ranked by evidence that landed while the student was reading; applied when they say so
  const [pendingPaths, setPendingPaths] = useState<WarmReachPath[]>();
  // the LinkedIn mutuals and Village introducers the current routes were ranked with, for re-ranking on new evidence
  const candidatesRef = useRef<ExternalCandidate[]>([]);
  /** re-rank the open routes after a short pause (new hop evidence, or someone on them rescored) */
  const recomputeRoutes = useRef<(() => void) | undefined>(undefined);
  // re-render when a LinkedIn read starts or ends, for the hops' "Checking…"
  useSyncExternalStore(subscribeHopEvidence, hopEvidenceVersion, hopEvidenceVersion);
  const [choices, setChoices] = useState<ReachCandidate[]>();
  const [pathIdx, setPathIdx] = useState(0);
  // the company the map is turned to: set the moment the student asks, from what the map already knows
  const [companyFocus, setCompanyFocus] = useState<{ key: string; label: string }>();
  // who the student knows there, for the panel: looked up in the background, so the map never waits on it
  const [company, setCompany] = useState<CompanyReach & { label: string }>();
  /** bumped whenever the view changes, so a lookup that finishes late cannot bring back a view the student left */
  const viewReq = useRef(0);
  const [target, setTarget] = useState<Person>();
  // plan 23 §4.1: a pasted job link becomes a plan in the panel
  const [job, setJob] = useState<
    { state: 'reading' } | { state: 'plan'; planId: string } | { state: 'error'; message: string }
  >();
  const jobPlan = useLiveQuery(
    () => (job?.state === 'plan' ? db.targetPlans.get(job.planId) : undefined),
    [job?.state === 'plan' ? job.planId : ''],
  );
  const [hover, setHover] = useState<string>();
  // where the person card goes: beside the dot, or at the top or bottom of a narrow map (the map picks it)
  const [hoverPlace, setHoverPlace] = useState<CardPlace>({ at: 'bottom', y: 0 });
  // a search that found no one: the line under the filters says so and the search box shakes once
  const [missed, setMissed] = useState<{ q: string; n: number }>();
  // the toast a search that found no one left up: the next search takes it down, so the screen never contradicts itself
  const missToast = useRef(0);
  const clearMiss = () => {
    if (missToast.current) toast.dismiss(missToast.current);
    missToast.current = 0;
  };
  const sayMiss = (q: string, text: string, ttl: number) => {
    setMissed((m) => ({ q: q.trim(), n: (m?.n ?? 0) + 1 }));
    clearMiss();
    missToast.current = toast.push({ text, ttl });
  };
  /** company lists in the panel show six people until the student asks for all of them */
  const [showAll, setShowAll] = useState<string>();
  // a search inside the introductions view: a person or a company the map turns to
  const [webFocus, setWebFocus] = useState<{ id?: string; group?: string; label: string }>();
  const [storyHover, setStoryHover] = useState<string>();
  /** people the map holds in grey "+N" dots: the panel explains those dots only when the map shows some */
  const [aggregated, setAggregated] = useState(0);
  const peopleQ = useLiveQuery(
    () => (userId ? db.people.where('userId').equals(userId).toArray() : []),
    [userId],
  );
  const orgsQ = useLiveQuery(() => db.organizations.toArray(), []);
  const chatsQ = useLiveQuery(
    () => (userId ? db.chats.where('userId').equals(userId).toArray() : []),
    [userId],
  );
  const pendingQ = useLiveQuery(
    () =>
      userId
        ? db.suggestions
            .where('userId')
            .equals(userId)
            .filter((s) => s.status === 'pending' && !!s.personId)
            .toArray()
        : [],
    [userId],
  );
  const tcsQ = useLiveQuery(
    () => (userId ? db.targetCompanies.where('userId').equals(userId).toArray() : []),
    [userId],
  );
  const pending = useMemo(() => pendingQ ?? [], [pendingQ]);
  const tcs = useMemo(() => tcsQ ?? [], [tcsQ]);
  const edges = useLiveQuery(
    () => (userId ? db.edges.where('userId').equals(userId).toArray() : []),
    [userId],
  );
  // the records an introduction leaves: an intro email on a thread, a "suggested I talk with you" fact
  const introThreads = useLiveQuery(
    () =>
      userId
        ? db.threads
            .where('userId')
            .equals(userId)
            .filter((t) => !!t.introduction)
            .toArray()
        : [],
    [userId],
  );
  const suggestedFacts = useLiveQuery(
    () =>
      userId
        ? db.facts
            .where('userId')
            .equals(userId)
            .filter((f) => f.sourceTable === 'suggested_by')
            .toArray()
        : [],
    [userId],
  );
  // the day's maintenance recomputes every tie's strength when the app opens: the map waits for it (a little while
  // at most), so people do not change rings straight after they have landed
  const maintaining = useSyncExternalStore(watchMaintenance, maintenanceRunning);
  const [waitedEnough, setWaitedEnough] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaitedEnough(true), MAINTENANCE_WAIT_MS);
    return () => clearTimeout(t);
  }, []);
  // the arrival waits for everything the map draws, so it plays on a quiet main thread
  const loading =
    !user ||
    (maintaining && !waitedEnough) ||
    [peopleQ, orgsQ, chatsQ, pendingQ, tcsQ, edges, introThreads, suggestedFacts].some(
      (q) => q === undefined,
    );
  const people = useMemo(() => peopleQ ?? [], [peopleQ]);
  const orgs = useMemo(() => orgsQ ?? [], [orgsQ]);
  const chats = useMemo(() => chatsQ ?? [], [chatsQ]);
  const orgMap = useMemo(() => new Map(orgs.map((o) => [o.id, o])), [orgs]);
  const stages = useMemo(
    () =>
      new Map(
        chats
          .filter((c) => !['archived', 'no_response', 'declined'].includes(c.stage))
          .map((c) => [c.personId, c.stage]),
      ),
    [chats],
  );
  // the ripple marks the people behind the most pressing suggestions only: when everyone ripples, no one stands out
  const pendingIds = useMemo(
    () =>
      new Set(
        [...pending]
          .sort((a, b) => b.priorityScore - a.priorityScore)
          .map((s) => s.personId!)
          .filter((id, i, all) => all.indexOf(id) === i)
          .slice(0, RIPPLE_TOP),
      ),
    [pending],
  );
  const isTarget = useMemo(() => targetCompanyMatcher(tcs, orgMap), [tcs, orgMap]);
  // only people the student knows: named, with real history (a newsletter sender or an address handle is not)
  const visible = useMemo(
    () => people.filter((p) => isKnownContact(p, { hasChat: stages.has(p.id) })),
    [people, stages],
  );
  const byId = useMemo(() => new Map(visible.map((p) => [p.id, p])), [visible]);
  // everyone the search can name (a target need not be someone the student already knows)
  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const highlightIds = useMemo(() => {
    if (filter === 'all' || filter === 'intros') return undefined;
    const now = Date.now();
    return new Set(
      visible
        .filter((p) =>
          filter === 'targets'
            ? isTarget(p)
            : filter === 'alumni'
              ? p.isAlumni
              : filter === 'chats'
                ? stages.has(p.id)
                : !!p.lastInteractionAt && now - new Date(p.lastInteractionAt).getTime() < 90 * 86_400_000,
        )
        .map((p) => p.id),
    );
  }, [filter, visible, isTarget, stages]);
  // a search with several matches lights them on the map, so the student sees where each one is before picking
  const choiceIds = useMemo(() => {
    if (!choices) return undefined;
    const keys = new Set(
      choices.filter((c) => c.kind === 'company').map((c) => `n:${normalizeCompany(c.label)}`),
    );
    const ids = new Set(choices.filter((c) => c.kind === 'person').map((c) => c.id));
    const orgIds = new Set(choices.filter((c) => c.kind === 'company').map((c) => c.id));
    return new Set(
      visible
        .filter(
          (p) =>
            ids.has(p.id) ||
            (!!p.currentOrganizationId && orgIds.has(p.currentOrganizationId)) ||
            keys.has(orbitGroupKey(p, orgMap)),
        )
        .map((p) => p.id),
    );
  }, [choices, visible, orgMap]);
  // Target companies: their wedges are tinted, and the panel lists them so one click turns the map to it
  const targetGroups = useMemo(() => {
    if (filter !== 'targets') return undefined;
    const groups = new Map<string, { key: string; label: string; orgId?: string; people: Person[] }>();
    for (const p of visible) {
      if (!isTarget(p)) continue;
      const key = orbitGroupKey(p, orgMap);
      const org = p.currentOrganizationId ? orgMap.get(p.currentOrganizationId) : undefined;
      const g = groups.get(key) ?? {
        key,
        label: org?.name ?? p.currentOrganizationRaw ?? 'Other',
        orgId: org?.id,
        people: [],
      };
      g.people.push(p);
      groups.set(key, g);
    }
    return [...groups.values()].sort(
      (a, b) => b.people.length - a.people.length || a.label.localeCompare(b.label),
    );
  }, [filter, visible, isTarget, orgMap]);
  const highlightGroups = useMemo(
    () => (targetGroups ? new Set(targetGroups.map((g) => g.key)) : undefined),
    [targetGroups],
  );
  // the referral web, built only from recorded introductions, referrals and suggestions
  const web: IntroWeb = useMemo(
    () =>
      buildIntroWeb({
        people: visible,
        edges: edges ?? [],
        threads: introThreads ?? [],
        chats,
        facts: suggestedFacts ?? [],
      }),
    [visible, edges, introThreads, chats, suggestedFacts],
  );
  const introducerOf = useMemo(() => new Map([...web.parent].map(([to, l]) => [to, l.fromId])), [web]);
  // each person's strongest direct connections inside the network, for the hover lines
  const connections = useMemo(() => {
    const out = new Map<string, { id: string; w: number }[]>();
    for (const [key, c] of combinedPairWeights(edges ?? [])) {
      const [a, b] = key.split('|') as [string, string];
      if (!byId.has(a) || !byId.has(b)) continue;
      for (const [x, y] of [
        [a, b],
        [b, a],
      ] as const) {
        const list = out.get(x);
        if (list) list.push({ id: y, w: c.weight });
        else out.set(x, [{ id: y, w: c.weight }]);
      }
    }
    return new Map(
      [...out].map(([id, list]) => [
        id,
        list
          .sort((x, y) => y.w - x.w)
          .slice(0, HOVER_LINKS)
          .map((x) => x.id),
      ]),
    );
  }, [edges, byId]);
  const firstNames = useMemo(() => {
    const count = new Map<string, number>();
    for (const id of web.members) {
      const f = byId.get(id)?.firstName ?? '';
      count.set(f, (count.get(f) ?? 0) + 1);
    }
    return count;
  }, [web, byId]);
  const nameOf = (id: string) => {
    const p = byId.get(id);
    if (!p) return 'someone';
    return (firstNames.get(p.firstName) ?? 0) > 1 ? p.displayName : p.firstName;
  };
  const stories = useMemo(() => introStories(web, nameOf), [web, firstNames, byId]);
  // someone new, or a chat booked, while the map is open: the legend line says it in words for a few seconds
  const [news, setNews] = useState<
    { kind: 'joined'; ids: string[] } | { kind: 'stage'; id: string; stage: string }
  >();
  const seen = useRef<{ people: Set<string>; stages: Map<string, string> }>(undefined);
  const newsTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(newsTimer.current), []);
  useEffect(() => {
    if (loading) return;
    const prev = seen.current;
    seen.current = { people: new Set(visible.map((p) => p.id)), stages: new Map(stages) };
    if (!prev) return;
    const born = visible.filter((p) => !prev.people.has(p.id)).map((p) => p.id);
    let next: typeof news;
    if (born.length) next = { kind: 'joined', ids: born };
    else
      for (const [id, stage] of stages)
        if (prev.stages.get(id) !== stage && (stage === 'scheduled' || stage === 'completed'))
          next = { kind: 'stage', id, stage };
    if (!next) return;
    setNews(next);
    clearTimeout(newsTimer.current);
    newsTimer.current = setTimeout(() => setNews(undefined), NEWS_MS);
  }, [visible, stages, loading]);
  const newsLine = (() => {
    if (!news) return '';
    if (news.kind === 'stage') {
      const p = byId.get(news.id);
      if (!p) return '';
      return news.stage === 'scheduled'
        ? `Your chat with ${p.displayName} is booked.`
        : `You had your chat with ${p.displayName}.`;
    }
    if (news.ids.length > 1) return `${news.ids.length} people joined your orbit.`;
    const p = byId.get(news.ids[0]!);
    if (!p) return '';
    const by = byId.get(introducerOf.get(p.id) ?? '');
    return by
      ? `${p.displayName} joined your orbit, introduced by ${by.displayName}.`
      : `${p.displayName} joined your orbit.`;
  })();
  const reachMode = !!reachParam;
  const webMode = filter === 'intros' && !reachMode;
  const suggestions = useMemo(() => {
    const q = query.trim();
    if (q.length < 1 || !peopleQ || !orgsQ) return [];
    if (webMode) {
      const low = q.toLowerCase();
      return [...web.members]
        .map((id) => byId.get(id))
        .filter(
          (p): p is Person =>
            !!p &&
            p.displayName
              .toLowerCase()
              .split(/\s+/)
              .some((w) => w.startsWith(low)),
        )
        .slice(0, 6)
        .map(
          (p): ReachCandidate => ({
            kind: 'person',
            id: p.id,
            label: p.displayName,
            sub: p.currentOrganizationRaw,
            score: 1,
          }),
        );
    }
    // people Orbit can name: an address handle or an initial is no one to reach
    return rankReachTargets(q, peopleQ.filter(named), orgsQ).slice(0, 6);
  }, [query, peopleQ, orgsQ, webMode, web, byId]);
  const pickSuggestion = (c: ReachCandidate) => {
    setQuery(c.label);
    clearMiss();
    if (webMode) return searchWeb(c.label);
    choose(c);
  };
  // resolve reach param (person id or '1' = open search)
  useEffect(() => {
    if (!userId || !reachParam || reachParam === '1') {
      setTarget(undefined);
      setPaths([]);
      if (!reachParam) {
        // a company result set by runSearch survives the reach=1 param update
        viewReq.current++;
        setCompanyFocus(undefined);
        setCompany(undefined);
        setChoices(undefined);
      }
      return;
    }
    viewReq.current++;
    clearMiss();
    let cancelled = false;
    (async () => {
      const p = await db.people.get(reachParam);
      if (cancelled) return;
      if (!p) {
        setTarget(undefined);
        setPaths([]);
        return;
      }
      setTarget(p);
      setJob(undefined);
      setCompanyFocus(undefined);
      setCompany(undefined);
      setChoices(undefined);
      setPaths(undefined);
      setPendingPaths(undefined);
      setPathIdx(0);
      candidatesRef.current = [];
      // Orbit's own routes show at once; LinkedIn mutuals and Village introducers join them when they answer. With no
      // route of its own, the panel keeps saying it is looking rather than "No route found" before they have.
      const { g } = await buildReachGraph(userId);
      if (cancelled) return;
      const local = reachPersonIn(g, p.id);
      if (local.length) setPaths(local);
      const extra = await reachCandidates(userId, p.id);
      if (cancelled) return;
      candidatesRef.current = extra;
      setPaths(extra.length ? reachPersonIn(g, p.id, 3, extra) : local);
      // plan 21: now that the student opened them, read how well the target's mutuals know them, best-first
      const mutualIds = extra.filter((c) => c.kind === 'linkedin_mutual').map((c) => c.introducerId);
      if (!user || !p.linkedinMemberId || !mutualIds.length) return;
      const standing = mutualStandings(g, p.id, mutualIds);
      const ranked = [...mutualIds].sort(
        (a, b) =>
          (standing.get(b)?.ask ?? 0) * (standing.get(b)?.know ?? 0) -
          (standing.get(a)?.ask ?? 0) * (standing.get(a)?.know ?? 0),
      );
      const people = (await db.people.bulkGet(ranked)).filter((x): x is Person => !!x);
      if (!cancelled) void checkHops(user, p, people);
    })();
    return () => {
      cancelled = true;
    };
  }, [reachParam, userId]);
  // plan 21: new evidence (a LinkedIn read landing) updates the hop words in place; a changed order waits behind
  // "Order changed" so routes never move under the student's hand. What the student says about a pair applies at once.
  useEffect(() => {
    if (!userId || !target) return;
    const id = target.id;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    const order = (ps: WarmReachPath[]) => ps.map((r) => r.hops.map((h) => h.toId).join('>')).join('|');
    const recompute = async (theirs: boolean) => {
      const { g } = await buildReachGraph(userId);
      if (!live) return;
      const next = reachPersonIn(g, id, 3, candidatesRef.current);
      setPaths((cur) => {
        if (!cur || theirs || order(cur) === order(next)) {
          setPendingPaths(undefined);
          return next;
        }
        setPendingPaths(next);
        const same = new Map(next.map((r) => [r.hops.map((h) => h.toId).join('>'), r]));
        return cur.map((r) => same.get(r.hops.map((h) => h.toId).join('>')) ?? r);
      });
    };
    recomputeRoutes.current = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void recompute(false), 1500);
    };
    const offEvidence = subscribeHopEvidence(() => recomputeRoutes.current?.());
    const offNotes = subscribePairNotes(() => void recompute(true));
    return () => {
      live = false;
      clearTimeout(timer);
      recomputeRoutes.current = undefined;
      offEvidence();
      offNotes();
    };
  }, [userId, target?.id]);
  // plan 27: someone on a route was rescored (a warm reply read): the routes re-rank like new evidence
  const routePeople = useMemo(() => (paths ?? []).flatMap((r) => r.hops.map((h) => h.toId)), [paths]);
  const routeCloseness = useClosenessKey(routePeople);
  const lastCloseness = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (routeCloseness === undefined) return;
    const ids = (s?: string) => s?.split('#')[0];
    if (lastCloseness.current !== undefined && ids(lastCloseness.current) === ids(routeCloseness))
      if (lastCloseness.current !== routeCloseness) recomputeRoutes.current?.();
    lastCloseness.current = routeCloseness;
  }, [routeCloseness]);
  const openCompany = async (orgIdOrName: string, label: string) => {
    if (!userId) return;
    const req = ++viewReq.current;
    clearMiss();
    setShowAll(undefined);
    setJob(undefined);
    // the map turns at once, from the layout it already has; the panel's lists arrive when the lookup is done
    const norm = normalizeCompany(orgIdOrName);
    const org = orgMap.get(orgIdOrName) ?? orgs.find((o) => !!norm && o.nameNormalized === norm);
    setChoices(undefined);
    setTarget(undefined);
    setPaths([]);
    setCompany(undefined);
    setCompanyFocus({
      key: org ? `n:${org.nameNormalized}` : `n:${normalizeCompany(label)}`,
      label: org?.name ?? label,
    });
    setParams({ reach: '1', company: label });
    const found = await reachCompany(userId, orgIdOrName);
    if (viewReq.current === req) setCompany({ ...found, label });
  };
  // a company link opened directly (or a reload) focuses that company again
  const companyParam = params.get('company');
  useEffect(() => {
    if (userId && reachParam === '1' && companyParam && !companyFocus && !choices)
      void openCompany(companyParam, companyParam);
  }, [userId, reachParam, companyParam]);
  /** Someone found on LinkedIn: they join Orbit (a chat at "to contact"), and the map shows the routes to them. */
  const chooseLinkedIn = async (f: FoundView) => {
    if (!user) return;
    const r = await addLinkedInFound(user, [f.id]);
    if (!r.ok) return void toast.push({ text: r.message, tone: 'neutral' });
    setQuery(f.name);
    toast.push({ text: `${f.name} is in your Orbit now.`, tone: 'good' });
    setParams({ reach: r.people[0]!.id });
  };
  const choose = (c: ReachCandidate) => {
    setChoices(undefined);
    if (c.kind === 'person') setParams({ reach: c.id });
    else void openCompany(c.id, c.label);
  };
  /** Inside the introductions view the search box looks only at the people in the web. */
  const searchWeb = (q: string) => {
    const norm = q.trim().toLowerCase();
    const comp = normalizeCompany(q);
    const members = [...web.members].map((id) => byId.get(id)).filter((p): p is Person => !!p);
    const person =
      members.find((p) => p.displayName.toLowerCase() === norm) ??
      members.find((p) =>
        p.displayName
          .toLowerCase()
          .split(/\s+/)
          .some((w) => w.startsWith(norm)),
      );
    if (person) return setWebFocus({ id: person.id, label: person.displayName });
    const atCompany = members.find(
      (p) => comp && orbitGroupKey(p, orgMap) === `n:${comp}` && normalizeCompany(p.currentOrganizationRaw),
    );
    if (atCompany)
      return setWebFocus({
        group: orbitGroupKey(atCompany, orgMap),
        label:
          orgMap.get(atCompany.currentOrganizationId ?? '')?.name ?? atCompany.currentOrganizationRaw ?? q,
      });
    sayMiss(q, 'No one by that name or company in your introductions yet.', 4000);
  };
  /** A job link (or "Software Engineer Intern at Stripe"): the posting read, the plan built, shown in the panel. */
  const openJob = async (q: string) => {
    if (!user) return;
    const req = ++viewReq.current;
    setTarget(undefined);
    setCompany(undefined);
    setChoices(undefined);
    setPaths([]);
    setJob({ state: 'reading' });
    if (reachParam !== '1') setParams({ reach: '1' });
    const r = await planFromInput(user, q).catch(() => ({
      ok: false as const,
      message: "Orbit couldn't build a plan just now.",
    }));
    if (viewReq.current !== req) return;
    if (!r.ok) return setJob({ state: 'error', message: r.message });
    setJob({ state: 'plan', planId: r.plan.id });
    // the map turns to the company the plan is for
    const norm = normalizeCompany(r.plan.posting.company);
    setCompanyFocus({ key: `n:${norm}`, label: r.plan.posting.company });
  };
  const runSearch = async (q: string) => {
    if (!userId || !q.trim()) return;
    clearMiss();
    if (webMode) return searchWeb(q);
    if (linkIn(q) && isJobLink(q)) return openJob(q);
    setJob(undefined);
    const req = ++viewReq.current;
    // what the map already holds; a search typed before the map finished loading reads the database
    const [allPeople, allOrgs] =
      peopleQ && orgsQ
        ? [peopleQ, orgsQ]
        : await Promise.all([db.people.where('userId').equals(userId).toArray(), db.organizations.toArray()]);
    if (viewReq.current !== req) return;
    const cands = rankReachTargets(q, allPeople.filter(named), allOrgs);
    if (cands.length && isUnambiguous(cands)) return choose(cands[0]!);
    if (cands.length) {
      // several plausible matches ("go" could be Google or Goldman Sachs): let the student pick
      setTarget(undefined);
      setCompanyFocus(undefined);
      setCompany(undefined);
      setPaths([]);
      setChoices(cands);
      if (reachParam !== '1') setParams({ reach: '1' });
      return;
    }
    const norm = normalizeCompany(q);
    const tc = norm ? tcs.find((t) => normalizeCompany(t.nameRaw) === norm) : undefined;
    if (tc) return openCompany(tc.organizationId ?? tc.nameRaw, tc.nameRaw);
    // the route or company the last search showed goes, so the map and the panel never answer an older question
    setTarget(undefined);
    setCompanyFocus(undefined);
    setCompany(undefined);
    setChoices(undefined);
    setPaths([]);
    if (reachParam && reachParam !== '1') setParams({ reach: '1' });
    else if (params.get('company')) setParams({ reach: '1' });
    sayMiss(
      q,
      'No one by that name or company in your network yet. Add them from LinkedIn or Discover.',
      5000,
    );
  };
  const openCluster = (node: OrbitNode) => {
    const g = node.groupKey;
    const group = node.cluster;
    if (!group) return;
    const org = [...orgMap.values()].find((o) => `n:${o.nameNormalized}` === g);
    // the "+N" dot bursts open on the map, and the panel lists everyone there
    if (org) void openCompany(org.id, org.name);
    else if (group.label !== 'Other companies' && g !== 'independent')
      void openCompany(group.label, group.label);
    else nav('/people?view=list');
  };
  const exitReach = () => {
    viewReq.current++;
    clearMiss();
    setParams({});
    setQuery('');
    setJob(undefined);
    setCompanyFocus(undefined);
    setCompany(undefined);
    setChoices(undefined);
  };
  /** Esc clears what the map is focused on, with the reverse animation: a search, a route, a filter. */
  const onEscape = useRef<() => void>(() => {});
  onEscape.current = () => {
    if (webFocus) setWebFocus(undefined);
    // a company the map has already turned to counts even before the address bar has caught up with it
    else if (reachMode || companyFocus) exitReach();
    else if (filter !== 'all') setFilter('all');
    else return;
    setQuery('');
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      onEscape.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!webMode) {
      setWebFocus(undefined);
      setStoryHover(undefined);
    }
  }, [webMode]);
  const askIntro = async (path: ReachPath) => {
    if (!target) return;
    await askIntroVia(path.hops[0]!.toId, target.id, path.score, path.hops);
  };
  // the same intro request for a warm intro path from Village, which names who introduces and to whom
  const askIntroVia = useAskIntro(user);
  const hovered = hover ? byId.get(hover) : undefined;
  const current = paths?.[pathIdx];
  // Village's warm intros to the target: shown on the route through the same person, or as a route of their own
  const targetIntros = useWarmIntros(user ?? undefined, target ?? undefined);
  const villageFor = (personId: string) =>
    targetIntros?.find((w) => w.introducer.personId === personId && w.targetPersonId === target?.id);
  // an introducer Orbit does not have yet is shown too, by name and LinkedIn; only someone Orbit has can be asked here
  const extraIntros = (targetIntros ?? []).filter(
    (w) =>
      w.introducer.personId !== target?.id &&
      !(
        w.introducer.personId &&
        (paths ?? []).some((p) => p.hops.length > 1 && p.hops[0]!.toId === w.introducer.personId)
      ),
  );
  const companyKey = companyFocus?.key;
  // the legend line and the chip on the map count the same people: those in the company's wedge
  const [companyCount, warmCount] = useMemo(() => {
    if (!companyKey) return [0, 0];
    let n = 0;
    let warm = 0;
    for (const p of visible)
      if (orbitGroupKey(p, orgMap) === companyKey) {
        n++;
        if (p.strength >= MEDIUM_TIE) warm++;
      }
    return [n, warm];
  }, [companyKey, visible, orgMap]);
  const status = paths === undefined ? 'searching' : paths.length ? 'found' : 'none';
  // a faint tie the student has to the target, offered after the warmer routes: the panel says why it comes last
  const coldDirect = paths?.find((p, i) => i > 0 && isColdDirect(p));
  const routeIds = current ? ['user', ...current.hops.map((h) => h.toId)].join('>') : '';
  const focus: FocusSpec | undefined = useMemo(() => {
    if (target)
      return { kind: 'reach', targetId: target.id, status, ids: routeIds ? routeIds.split('>') : [] };
    if (companyKey) return { kind: 'company', groupKey: companyKey, count: companyCount, warm: warmCount };
    return undefined;
  }, [target, status, routeIds, companyKey, companyCount, warmCount]);
  const webLit = webMode
    ? (storyHover ?? (hover && web.members.has(hover) ? hover : undefined) ?? webFocus?.id)
    : undefined;
  const webSpec: WebSpec | undefined = useMemo(
    () =>
      webMode
        ? {
            web,
            focusId: webLit,
            focusGroup: webLit ? undefined : webFocus?.group,
            // a search match turns the orbit to it; hovering never moves the dot under the pointer
            turnTo: webFocus ? { id: webFocus.id, group: webFocus.group } : undefined,
          }
        : undefined,
    [webMode, web, webLit, webFocus],
  );
  const clear = touch ? '' : ' Esc to clear.';
  // one line under the filters that says what the map shows, in words, whenever it changes
  const legend = (() => {
    if (missed && missed.q === query.trim())
      return `No one matches “${missed.q}” ${webMode ? 'in your introductions' : 'in your network'} yet.`;
    if (newsLine && !reachMode) return newsLine;
    if (reachMode) {
      if (job?.state === 'reading') return 'Reading the posting.';
      if (job?.state === 'plan' && jobPlan)
        return `Your plan for ${jobPlan.posting.company}, lit on the map.`;
      if (companyFocus)
        return `Showing ${plural(companyCount, 'person', 'people')} at ${companyFocus.label}${
          warmCount ? `, ${warmCount} warm` : ''
        }.${touch ? '' : ' Drag to turn the orbit, Esc to clear.'}`;
      if (target) {
        if (paths === undefined) return `Finding routes to ${target.displayName}.`;
        if (!current) return `No route to ${target.displayName} through your network yet.${clear}`;
        if (isColdDirect(current))
          return `You know ${target.displayName} only slightly, so a note straight to them would be a cold one.${clear}`;
        if (current.hops.length === 1) return `You know ${target.displayName} directly.${clear}`;
        const via = byId.get(current.hops[0]!.toId)?.firstName ?? 'someone';
        return `Route ${pathIdx + 1} of ${paths.length} to ${target.displayName}, through ${via}.${clear}`;
      }
      if (choices) return 'Several matches, lit on the map. Pick the one you meant.';
      return 'Type a name or a company to find a way in.';
    }
    switch (filter) {
      case 'targets':
        return `Showing ${plural(highlightIds?.size ?? 0, 'person', 'people')} at ${plural(
          targetGroups?.length ?? 0,
          'target company',
          'target companies',
        )}.${clear}`;
      case 'alumni':
        return `Showing ${plural(highlightIds?.size ?? 0, 'alum', 'alumni')}${user?.school ? ` of ${user.school}` : ''}.${clear}`;
      case 'chats':
        return `Showing ${plural(highlightIds?.size ?? 0, 'person', 'people')} in your pipeline.${clear}`;
      case 'recent':
        return `Showing ${plural(highlightIds?.size ?? 0, 'person', 'people')} you were in touch with in the last 90 days.${clear}`;
      case 'intros':
        if (!web.links.length) return 'No introductions recorded yet.';
        if (webFocus && !webLit && webFocus.group)
          return `Showing introductions at ${webFocus.label}.${clear}`;
        if (webFocus?.id && webLit === webFocus.id)
          return `Showing the introductions through ${webFocus.label}.${clear}`;
        return `${plural(web.links.length, 'introduction')} in ${plural(web.roots.length, 'chain')}. Each ring out from You is one more introduction. ${
          touch ? 'Tap' : 'Hover over'
        } a person to light up their chain.`;
      default:
        return 'Everyone you know, closest in the middle, each company a wedge.';
    }
  })();
  // a chain lit from the map, in words, unless the list already says exactly that
  const chainSentence = webLit ? describeIntroChain(web, webLit, nameOf) : '';
  const litSentence = stories.some((s) => s.text === chainSentence) ? '' : chainSentence;
  return (
    <div className="flex flex-col lg:flex-1 lg:min-h-0" data-testid="map-page">
      <div className="px-4 md:px-8 pt-5 pb-3 flex flex-wrap items-center gap-2 border-b border-line bg-canvas">
        <div className="min-w-0">
          <h1 className="text-[24px] font-normal tracking-[-0.02em]">
            {reachMode ? 'Reach' : webMode ? 'Introductions' : 'Your orbit'}
          </h1>
          <p className="text-[12px] text-ink-3">
            {reachMode
              ? 'Who can get you to someone, through people you already know.'
              : webMode
                ? 'Who introduced you to whom, generation by generation.'
                : highlightIds
                  ? `${highlightIds.size} of ${visible.length} people shown`
                  : `${visible.length} people`}
          </p>
        </div>
        <div className="w-full @[40rem]:w-auto @[40rem]:ml-auto flex items-center gap-2">
          {reachMode && (
            <Button variant="ghost" size="sm" className={TAP} onClick={exitReach}>
              <X size={14} /> Exit reach
            </Button>
          )}
        </div>
        {!reachMode && (
          <div className="w-full flex flex-wrap gap-1.5 mt-1" role="group" aria-label="Show">
            {FILTERS.map(([k, l]) => (
              <button
                key={k}
                onClick={() => {
                  setFilter(k);
                  setWebFocus(undefined);
                }}
                aria-pressed={filter === k}
                className={cx(
                  'h-7 px-2.5 rounded-full border text-[12px] shrink-0 whitespace-nowrap transition-colors pointer-coarse:h-11 pointer-coarse:px-3.5 pointer-coarse:text-[13px]',
                  filter === k ? 'bg-ink text-white border-ink' : 'border-line text-ink-2 hover:bg-canvas-2',
                )}
                data-testid={`map-filter-${k}`}
              >
                {l}
              </button>
            ))}
          </div>
        )}
        <p
          className="w-full text-[12px] text-ink-3 min-h-[18px] mt-0.5"
          aria-live="polite"
          data-testid="map-legend-line"
        >
          {legend}
        </p>
      </div>
      <div
        ref={splitRef}
        // the panel's width is the student's: they drag its edge, and it stays that way next time
        className="@4xl:flex-1 @4xl:min-h-0 grid grid-cols-1 @4xl:grid-cols-[minmax(0,1fr)_auto_var(--panel-w)]"
        style={{ '--panel-w': `${panel.width}px` } as CSSProperties}
      >
        <div
          className={cx(
            'relative min-w-0 overflow-hidden @4xl:h-auto @4xl:min-h-[420px] bg-[radial-gradient(circle_at_center,_#fff_0%,_#fbfaf9_70%)]',
            // on phones the routes sit under the canvas, so in reach mode the canvas leaves room for them
            // a phone's orbit is as wide as the screen, so the canvas is only as tall as that orbit needs (with
            // room for the top and bottom labels): no empty band above it pushing its bottom under the tab bar
            reachMode
              ? 'h-[min(48vh,420px)] min-h-[280px]'
              : 'h-[min(72vh,560px,calc(100vw_+_60px))] min-h-[340px]',
          )}
          data-testid="orbit-stage"
        >
          <OrbitMap
            people={visible}
            orgs={orgMap}
            stages={stages}
            pending={pendingIds}
            loading={loading}
            highlightIds={choiceIds ?? highlightIds}
            highlightGroups={highlightGroups}
            focus={focus}
            web={webSpec}
            connections={connections}
            introducerOf={introducerOf}
            onSelect={(id) => (reachMode ? setParams({ reach: id }) : nav(`/people/${id}`))}
            onSelectCluster={openCluster}
            personCard
            question={webFocus}
            onAggregated={setAggregated}
            onHover={(id, place) => {
              setHover(id);
              if (place) setHoverPlace(place);
            }}
          />
          {hovered && (
            // one card that follows the focus from dot to dot: it fades in when it first shows, not again with
            // each arrow key
            <div
              className={cx(
                'absolute bg-canvas border border-line rounded-[12px] p-3 shadow-[var(--shadow-card)] fade-up',
                // the map puts the card next to the dot on a wide map and at the top or bottom of a narrow one, never
                // over the person (on a phone the bottom only when it is clear of the tab bar); with a mouse the card
                // lets the pointer through
                'at' in hoverPlace ? 'left-3 right-3' : 'w-[260px]',
                touch ? '' : 'pointer-events-none',
              )}
              style={'at' in hoverPlace ? { top: hoverPlace.y } : { left: hoverPlace.x, top: hoverPlace.y }}
              data-place={'at' in hoverPlace ? hoverPlace.at : 'beside'}
              data-testid="map-tooltip"
            >
              <MapPersonCard
                person={hovered}
                stage={stages.get(hovered.id)}
                route={reachMode ? current : undefined}
                nameOf={(id) => byId.get(id)?.firstName ?? 'them'}
                touch={touch}
              />
            </div>
          )}
        </div>
        <ResizeHandle
          width={panel.width}
          onResize={panel.set}
          onReset={panel.reset}
          side="right"
          label="Resize the side panel"
          className="hidden @4xl:flex"
        />
        <aside
          // keyed on what the panel shows, so its cards cascade in again when the target changes
          key={`${reachParam === '1' ? '' : (reachParam ?? '')}|${target?.id ?? ''}|${company?.label ?? ''}|${webFocus?.label ?? ''}|${webMode}`}
          className="stagger min-w-0 min-h-[168px] border-t @4xl:border-t-0 @4xl:border-l border-line bg-canvas @4xl:overflow-y-auto scroll-thin p-4 space-y-3"
          data-testid="map-panel"
        >
          {user && (
            // the one search on the map, where the student acts: people and companies in their network as they type,
            // people on LinkedIn once they pause; in the introductions view, the people in the web
            <ReachSearch
              shake={missed && missed.q === query.trim() ? missed.n : 0}
              user={user}
              query={query}
              onQuery={(q) => {
                setQuery(q);
                clearMiss();
                if (webMode) {
                  if (!q) setWebFocus(undefined);
                  return;
                }
                // a search goes on in Reach, where its results have room
                if (q.trim() && !reachMode) setParams({ reach: '1' });
              }}
              network={suggestions}
              byId={peopleById}
              onPick={pickSuggestion}
              onPickLinkedIn={(f) => void chooseLinkedIn(f)}
              onSubmit={(q) => void runSearch(q)}
              compact={!!(target || companyFocus || choices)}
              placeholder={webMode ? 'Search your introductions' : 'Paste a job link, or a person or company'}
              hint={reachMode ? undefined : null}
              linkedIn={!webMode}
              autoFocus={reachMode}
            />
          )}
          {!reachMode && !webMode && (
            <>
              {targetGroups && (
                <Card padded>
                  <div className="font-medium text-[13px] mb-2">Target companies</div>
                  {targetGroups.length === 0 && (
                    <p className="text-[12px] text-ink-3">
                      No one at your target companies in your network yet.
                    </p>
                  )}
                  <ul className="space-y-1">
                    {targetGroups.map((g) => (
                      <li key={g.key}>
                        <button
                          className={cx(
                            'w-full flex items-center gap-2 text-left text-[13px] rounded-md px-2 py-1.5 hover:bg-canvas-2',
                            TAP,
                          )}
                          onClick={() => void openCompany(g.orgId ?? g.label, g.label)}
                          data-testid="map-company-row"
                        >
                          <CompanyLogo name={g.label} orgId={g.orgId} size={16} decorative />
                          <span className="font-medium truncate">{g.label}</span>
                          <span className="ml-auto text-ink-3 tabular shrink-0">
                            {plural(g.people.length, 'person', 'people')}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {/* how to read the map: a few quiet lines, not a card */}
              <div className="text-[12px] text-ink-3 leading-relaxed space-y-1.5 pt-1">
                <p>
                  {touch
                    ? 'Tap a person to see who they are; tap again to open them.'
                    : 'Hover a person to see who they know; click to open them. Drag to turn the orbit.'}
                </p>
                <p>
                  Companies read as wedges. Inner ring is close ties, outer is new or cold; the thin coloured
                  ring is pipeline stage.
                  {aggregated > 0 && ' A grey dot with a number stands for more people at that company.'}
                </p>
              </div>
            </>
          )}
          {webMode && (
            <>
              <div className="text-[13px] text-ink-2">
                Each line runs from the person who introduced you to the person they introduced you to, and
                each colour is one chain. A dashed line from You means you know that person directly.
              </div>
              <Card padded>
                <div className="font-medium text-[13px] mb-2">Your introductions</div>
                {stories.length === 0 && (
                  <p className="text-[12px] text-ink-3">
                    When someone introduces you by email, or you note who suggested a person, the chain shows
                    up here and on the map.
                  </p>
                )}
                <ul className="space-y-1">
                  {stories.map((s) => (
                    <li key={s.text}>
                      <button
                        className={cx(
                          'w-full flex items-start gap-2 text-left text-[13px] rounded-md px-2 py-1.5 hover:bg-canvas-2',
                          TAP,
                          // the chain lit from the map, when this entry already says it in words
                          !storyHover && chainSentence === s.text && 'bg-accent-soft/40',
                        )}
                        data-lit={!storyHover && chainSentence === s.text ? 'true' : undefined}
                        onMouseEnter={() => setStoryHover(s.focusId)}
                        onMouseLeave={() => setStoryHover(undefined)}
                        onFocus={() => setStoryHover(s.focusId)}
                        onBlur={() => setStoryHover(undefined)}
                        onClick={() => nav(`/people/${s.focusId}`)}
                        data-testid="map-intro-story"
                      >
                        <span
                          className="mt-1.5 w-2 h-2 rounded-full shrink-0"
                          style={{ background: LINEAGE[web.roots.indexOf(s.rootId) % LINEAGE.length] }}
                        />
                        <span>{s.text}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
              {/* a chain lit from the map, said in words (a chain hovered in the list already says it); below the list,
                  so nothing under the pointer moves when it appears */}
              {litSentence && !storyHover && (
                <Card padded className="border-accent/40 bg-accent-soft/30">
                  <p className="text-[13px]" data-testid="map-chain-sentence">
                    {litSentence}
                  </p>
                </Card>
              )}
            </>
          )}
          {choices && (
            <div>
              <div className="text-[13px] text-ink-2 mb-2">Several matches. Which one did you mean?</div>
              <ul className="space-y-1.5">
                {choices.map((c) => (
                  <li key={`${c.kind}:${c.id}`}>
                    <button
                      className="w-full text-left border border-line rounded-[10px] px-3 py-2 hover:bg-canvas-2"
                      onClick={() => choose(c)}
                      data-testid="reach-choice"
                    >
                      <span className="font-medium text-[13px]">{c.label}</span>
                      <span className="ml-2 text-[11px] text-ink-3">
                        {c.kind === 'company' ? 'Company' : 'Person'}
                      </span>
                      {c.sub && <div className="text-[12px] text-ink-3 truncate">{c.sub}</div>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {target && (
            <>
              <div className="flex items-center gap-3">
                <Avatar name={target.displayName} src={target.photoUrl} id={target.id} size={40} />
                <div className="min-w-0">
                  <Link
                    to={`/people/${target.id}`}
                    className={cx('font-medium hover:underline inline-flex items-center', TAP)}
                  >
                    {target.displayName}
                  </Link>
                  <LogoText person={target} className="text-[12px] text-ink-3">
                    {target.currentTitle ?? target.currentOrganizationRaw}
                  </LogoText>
                </div>
              </div>
              {paths === undefined && (
                <p className="text-[13px] text-ink-3" data-testid="reach-loading" aria-busy="true">
                  Finding routes through your network…
                </p>
              )}
              {pendingPaths && (
                <button
                  type="button"
                  className="inline-flex"
                  onClick={() => {
                    setPaths(pendingPaths);
                    setPendingPaths(undefined);
                    setPathIdx(0);
                  }}
                  data-testid="reach-order-changed"
                >
                  <Chip className="h-6" tone="warn">
                    Order changed · refresh
                  </Chip>
                </button>
              )}
              {paths?.length === 0 && (
                <p className="text-[13px] text-ink-3">
                  No route found through your network yet. Import more connections or start a warm-up.
                </p>
              )}
              {paths?.map((p, i) => {
                const first = byId.get(p.hops[0]!.toId);
                // the same introducer in Village's warm intros: said on the route, never listed twice
                const village = p.hops.length > 1 ? villageFor(p.hops[0]!.toId) : undefined;
                const selected = i === pathIdx;
                return (
                  <div
                    key={i}
                    className={cx(
                      'border rounded-[12px] transition-colors',
                      selected ? 'border-accent bg-accent-soft/40' : 'border-line hover:bg-canvas-2',
                    )}
                    data-testid="reach-path"
                  >
                    <button
                      type="button"
                      onClick={() => setPathIdx(i)}
                      aria-pressed={selected}
                      className="w-full text-left p-3 pb-2 rounded-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[12px] font-medium">
                          Route {i + 1} · {p.hops.length} hop{p.hops.length > 1 ? 's' : ''}
                        </span>
                        <span className="flex items-center gap-1">
                          {village && (
                            <Chip className="h-5" data-testid="reach-village">
                              Village · {village.warmthWord}
                            </Chip>
                          )}
                          {/* the route's strength out of 100: the chance the intro happens, every hop counted */}
                          <RouteBadge
                            path={p}
                            className="h-5"
                            testId={p.weak && !isColdDirect(p) ? 'reach-path-weak' : 'reach-path-score'}
                          />
                        </span>
                      </div>
                      <ol className="mt-2 space-y-1.5 text-[13px]">
                        {p.hops.map((h, k) => {
                          const to = byId.get(h.toId);
                          const from = byId.get(h.fromId);
                          // plan 21: past the student's own tie, how well the two know each other, and whether
                          // Orbit is still reading LinkedIn for it
                          const reading = [from?.linkedinMemberId, to?.linkedinMemberId].some((m) => {
                            const st = checkState(m);
                            return st === 'queued' || st === 'reading';
                          });
                          return (
                            <li key={k} className="flex items-start gap-2" data-testid="reach-hop">
                              <span className="text-ink-3 tabular w-4">{k + 1}.</span>
                              <span>
                                <span className="font-medium" title={h.text}>
                                  {to?.displayName ?? '…'}
                                </span>
                                {/* the student's own tie to the first person, with its score */}
                                {k === 0 && to && (
                                  <span className="text-ink-3" data-testid="reach-hop-tie">
                                    {' · '}your {tieWords(to)}
                                  </span>
                                )}
                                {/* past it, how well the two know each other, out of 100 */}
                                {k > 0 && h.band && (
                                  <span className="text-ink-3" data-testid="reach-hop-band">
                                    {' · '}
                                    {HOP_WORDS[h.band]} · {Math.round(h.weight * 100)}
                                    {h.fading ? ', quiet lately' : ''}
                                  </span>
                                )}
                                {k > 0 && reading && (
                                  <span className="text-ink-3" data-testid="reach-hop-checking">
                                    {' · '}Checking…
                                  </span>
                                )}
                                {reasons && (
                                  <>
                                    <br />
                                    <span className="text-ink-3">{h.text}</span>
                                  </>
                                )}
                              </span>
                            </li>
                          );
                        })}
                      </ol>
                      {p.weak && reasons && (
                        <p className="mt-1.5 text-[12px] text-ink-3">
                          You know {first?.firstName ?? 'them'} only slightly, but LinkedIn says{' '}
                          {first?.firstName ?? 'they'} knows {target.firstName}: a weaker route, and a real
                          one.
                        </p>
                      )}
                    </button>
                    {/* each route carries its own next step */}
                    {user && selected && p.hops.length > 1 && (
                      <div className="px-3 pb-1.5 space-y-1">
                        {p.hops.slice(1).map((h) => (
                          <PairNoteMenu
                            key={`${h.fromId}>${h.toId}`}
                            userId={user.id}
                            aId={h.fromId}
                            bId={h.toId}
                            aName={byId.get(h.fromId)?.firstName ?? 'They'}
                            bName={byId.get(h.toId)?.firstName ?? 'them'}
                            className="block"
                            named={p.hops.length > 2}
                          />
                        ))}
                      </div>
                    )}
                    <div className="px-3 pb-3">
                      {p.hops.length > 1 ? (
                        <Button
                          size="sm"
                          variant={selected ? 'primary' : 'secondary'}
                          className={TAP}
                          onClick={() => askIntro(p)}
                          data-testid="reach-path-action"
                        >
                          Ask {first?.firstName ?? 'them'} for an intro
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant={selected ? 'primary' : 'secondary'}
                          className={TAP}
                          onClick={() => nav(`/people/${target.id}?draft=outreach`)}
                          data-testid="reach-path-action"
                        >
                          Write to {target.firstName} directly
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
              {/* warm intros from Village through someone no route above goes through: one more route each */}
              {extraIntros.length > 0 && (
                <div className="space-y-2" data-testid="map-warm-intros">
                  {extraIntros.map((w, j) => {
                    // laid out like the routes above: numbered after them, one step per person, the source tagged
                    const steps = w.hops.slice(1);
                    return (
                      <div
                        key={`${w.introducer.name}:${w.hops.join('>')}`}
                        className="border border-line rounded-[12px] p-3 hover:bg-canvas-2 transition-colors"
                        data-testid="map-warm-intro"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[12px] font-medium">
                            Route {(paths?.length ?? 0) + j + 1} · {steps.length} hop
                            {steps.length > 1 ? 's' : ''}
                          </span>
                          <span className="flex items-center gap-1">
                            <Chip
                              className="h-5"
                              title="Found by Village, a warm-intro service that knows connections your own email and LinkedIn do not show"
                            >
                              Village
                            </Chip>
                            <Chip
                              className="h-5"
                              tone={
                                w.warmthWord === 'warm'
                                  ? 'good'
                                  : w.warmthWord === 'good'
                                    ? 'accent'
                                    : 'neutral'
                              }
                            >
                              {w.warmthWord}
                            </Chip>
                          </span>
                        </div>
                        <ol className="mt-2 space-y-1.5 text-[13px]">
                          {steps.map((name, k) => (
                            <li key={`${name}-${k}`} className="flex items-start gap-2">
                              <span className="text-ink-3 tabular w-4">{k + 1}.</span>
                              <span>
                                <span
                                  className="font-medium"
                                  title={k === steps.length - 1 ? w.note : undefined}
                                >
                                  {name}
                                </span>
                                {reasons && k === steps.length - 1 && w.note ? (
                                  <>
                                    <br />
                                    <span className="text-ink-3">{w.note}</span>
                                  </>
                                ) : null}
                              </span>
                            </li>
                          ))}
                        </ol>
                        {w.introducer.personId && w.targetPersonId ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            className={cx('mt-2', TAP)}
                            onClick={() => askIntroVia(w.introducer.personId!, w.targetPersonId!, w.warmth)}
                            data-testid="map-warm-intro-ask"
                          >
                            Ask {w.introducer.name.split(' ')[0]} for an intro
                          </Button>
                        ) : (
                          <p
                            className="mt-2 text-[12px] text-ink-3 flex items-center gap-1.5"
                            data-testid="map-warm-intro-outside"
                          >
                            {w.introducer.linkedinUrl && /linkedin\.com/i.test(w.introducer.linkedinUrl) && (
                              <LinkedInMark url={w.introducer.linkedinUrl} name={w.introducer.name} />
                            )}
                            {w.introducer.name.split(' ')[0]} is not in your Orbit yet; reach them on
                            LinkedIn.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {coldDirect && reasons && (
                <p className="text-[12.5px] text-ink-3" data-testid="reach-cold-note">
                  Route {paths!.indexOf(coldDirect) + 1} is writing to {target.firstName} yourself.{' '}
                  {coldDirect.hops[0]!.text}, a faint tie, so the routes through people you know come first.
                </p>
              )}
              {/* the target's LinkedIn mutuals, whether or not a route clears the bar, and for someone the student
                  knows too: they asked for a way in */}
              {user && (
                <ReachMutuals
                  user={user}
                  target={target}
                  onAsk={(personId, score) => void askIntroVia(personId, target.id, score)}
                />
              )}
            </>
          )}
          {job?.state === 'reading' && (
            <p className="text-[13px] text-ink-3" data-testid="job-plan-reading" aria-busy="true">
              Reading the posting and finding who can get you in…
            </p>
          )}
          {job?.state === 'error' && (
            <p className="text-[13px] text-ink-2" data-testid="job-plan-error">
              {job.message}
            </p>
          )}
          {job?.state === 'plan' && jobPlan && <TargetPlanCard plan={jobPlan} />}
          {companyFocus && !company && !job && (
            <>
              <div className="font-medium">{companyFocus.label}</div>
              <p className="text-[13px] text-ink-3" data-testid="company-loading" aria-busy="true">
                Looking up who you know at {companyFocus.label}…
              </p>
            </>
          )}
          {company && (
            <>
              <div className="font-medium flex items-center gap-2">
                <CompanyLogo
                  name={company.org?.name ?? company.label}
                  orgId={company.org?.id}
                  size={20}
                  decorative
                />
                {company.org?.name ?? company.label}
              </div>
              {user && (
                <WarmIntrosPanel
                  user={user}
                  company={company.org?.name ?? company.label}
                  onAsk={askIntroVia}
                />
              )}
              {(
                [
                  ['People you know there now', company.direct],
                  ['Saved to contact (not someone you know yet)', company.saved],
                  ['Former employees you know (last five years)', company.former],
                ] as const
              ).map(([title, list]) => (
                <div key={title}>
                  <div className="text-[12px] uppercase tracking-wide text-ink-3 mb-1">
                    {title} · {list.length}
                  </div>
                  {list.length === 0 && <p className="text-[12px] text-ink-3">None</p>}
                  <ul className="space-y-1.5">
                    {(showAll === title ? list : list.slice(0, 6)).map((d) => (
                      <li key={d.person.id} className="flex items-center gap-2 text-[13px]">
                        <Avatar
                          name={d.person.displayName}
                          src={d.person.photoUrl}
                          id={d.person.id}
                          size={22}
                        />
                        <button
                          className={cx('hover:underline truncate text-left', TAP)}
                          onClick={() => setParams({ reach: d.person.id })}
                        >
                          {d.person.displayName}
                        </button>
                        {d.person.isAlumni && <Chip>Alum</Chip>}
                        <span className="ml-auto">
                          <StrengthDots v={d.strength} />
                        </span>
                      </li>
                    ))}
                  </ul>
                  {list.length > 6 && showAll !== title && (
                    <button
                      className={cx(
                        'mt-1.5 text-[12px] text-ink underline decoration-[#cfcdc9] underline-offset-4 hover:decoration-ink',
                        TAP,
                      )}
                      onClick={() => setShowAll(title)}
                      data-testid="company-show-all"
                    >
                      Show all {list.length}
                    </button>
                  )}
                </div>
              ))}
              {company.twoHop.length > 0 && (
                <div>
                  <div className="text-[12px] uppercase tracking-wide text-ink-3 mb-1">
                    Routes through people you know
                  </div>
                  <p className="text-[12px] text-ink-3 mb-1.5" data-testid="company-routes-why">
                    {WARMER_ROUTES_WHY}
                  </p>
                  <ul className="space-y-1 text-[13px]" data-testid="company-routes">
                    {company.twoHop.map((t) => (
                      <li key={t.target.id}>
                        <button
                          className={cx('hover:underline font-medium', TAP)}
                          onClick={() => setParams({ reach: t.target.id })}
                        >
                          {t.target.displayName}
                        </button>{' '}
                        {/* the route Reach finds for this person in Orbit's own records (Reach adds LinkedIn mutuals) */}
                        <span className="text-ink-3">
                          {plural(t.path.hops.length, 'hop')}, via{' '}
                          {t.path.hops
                            .slice(0, -1)
                            .map((h) => byId.get(h.toId)?.firstName ?? 'someone')
                            .join(' then ')}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {user && (
                <Button
                  variant="primary"
                  size="sm"
                  className={TAP}
                  onClick={() => void openJob(company.org?.name ?? company.label)}
                  data-testid="company-plan"
                >
                  Plan my way in
                </Button>
              )}
              {company.org && (
                <Link
                  to={`/companies/${company.org.id}`}
                  className={cx('text-[13px] text-accent inline-flex items-center', TAP)}
                >
                  Open company page →
                </Link>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

export async function draftIntro(userId: string, personId: string) {
  const user = await db.users.get(userId);
  if (!user) return;
  return draftMessage(user, personId, 'intro_request', 'gmail');
}
