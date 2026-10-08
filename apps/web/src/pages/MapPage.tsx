import type { IntroWeb, OrbitNode, Person, ReachPath } from '@orbit/core';
import {
  buildIntroWeb,
  combinedPairWeights,
  describeIntroChain,
  introStories,
  newId,
  normalizeCompany,
  orbitGroupKey,
  REACH_BAND_LABELS,
  STAGE_LABELS,
} from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { type CardPlace, OrbitMap, useCoarsePointer } from '../components/OrbitMap';
import type { FocusSpec, WebSpec } from '../components/orbitScene';
import { LINEAGE } from '../components/orbitScene';
import { db } from '../db/schema';
import { draftMessage } from '../engine/brief';
import {
  type CompanyReach,
  isColdDirect,
  isUnambiguous,
  type ReachCandidate,
  rankReachTargets,
  reachCompany,
  reachPerson,
  targetCompanyMatcher,
  WARMER_ROUTES_WHY,
} from '../engine/graph';
import { maintenanceRunning, watchMaintenance } from '../engine/sync';
import { useSession } from '../state/session';
import { Avatar, Button, Card, Chip, cx, Input, useToast } from '../ui';
import { StrengthDots } from './Pipeline';

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

export function MapPage() {
  const { userId, user } = useSession();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const reachParam = params.get('reach');
  const touch = useCoarsePointer();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  // undefined while routes are being computed, so the panel never claims "no route" before it knows
  const [paths, setPaths] = useState<ReachPath[] | undefined>([]);
  const [choices, setChoices] = useState<ReachCandidate[]>();
  const [pathIdx, setPathIdx] = useState(0);
  // the company the map is turned to: set the moment the student asks, from what the map already knows
  const [companyFocus, setCompanyFocus] = useState<{ key: string; label: string }>();
  // who the student knows there, for the panel: looked up in the background, so the map never waits on it
  const [company, setCompany] = useState<CompanyReach & { label: string }>();
  /** bumped whenever the view changes, so a lookup that finishes late cannot bring back a view the student left */
  const viewReq = useRef(0);
  const [target, setTarget] = useState<Person>();
  const [hover, setHover] = useState<string>();
  // where the person card goes: beside the dot, or at the top or bottom of a narrow map (the map picks it)
  const [hoverPlace, setHoverPlace] = useState<CardPlace>({ at: 'bottom' });
  // a search that found no one: the line under the filters says so and the search box shakes once
  const [missed, setMissed] = useState<{ q: string; n: number }>();
  const searchForm = useRef<HTMLFormElement>(null);
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
  // each search that finds no one replays the shake, without remounting the box (the cursor stays in it)
  useEffect(() => {
    const el = searchForm.current;
    if (!el || !missed) return;
    el.classList.remove('shake-x');
    el.getBoundingClientRect();
    el.classList.add('shake-x');
  }, [missed]);
  /** company lists in the panel show six people until the student asks for all of them */
  const [showAll, setShowAll] = useState<string>();
  // a search inside the introductions view: a person or a company the map turns to
  const [webFocus, setWebFocus] = useState<{ id?: string; group?: string; label: string }>();
  const [storyHover, setStoryHover] = useState<string>();
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
  const visible = useMemo(() => people.filter((p) => p.isHuman && !p.hiddenAt), [people]);
  const byId = useMemo(() => new Map(visible.map((p) => [p.id, p])), [visible]);
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
      setCompanyFocus(undefined);
      setCompany(undefined);
      setChoices(undefined);
      setPaths(undefined);
      setPathIdx(0);
      const ps = await reachPerson(userId, p.id);
      if (!cancelled) setPaths(ps);
    })();
    return () => {
      cancelled = true;
    };
  }, [reachParam, userId]);
  const openCompany = async (orgIdOrName: string, label: string) => {
    if (!userId) return;
    const req = ++viewReq.current;
    clearMiss();
    setShowAll(undefined);
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
  const runSearch = async (q: string) => {
    if (!userId || !q.trim()) return;
    clearMiss();
    if (webMode) return searchWeb(q);
    const req = ++viewReq.current;
    // what the map already holds; a search typed before the map finished loading reads the database
    const [allPeople, allOrgs] =
      peopleQ && orgsQ
        ? [peopleQ, orgsQ]
        : await Promise.all([db.people.where('userId').equals(userId).toArray(), db.organizations.toArray()]);
    if (viewReq.current !== req) return;
    const cands = rankReachTargets(q, allPeople, allOrgs);
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
    else nav('/people');
  };
  const exitReach = () => {
    viewReq.current++;
    clearMiss();
    setParams({});
    setQuery('');
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
    if (!user || !target) return;
    const connectorId = path.hops[0]!.toId;
    const connector = await db.people.get(connectorId);
    if (!connector) return;
    const s = {
      id: newId('s'),
      userId: user.id,
      kind: 'intro_request' as const,
      personId: connectorId,
      priorityScore: 0.55,
      reasonText: `Ask ${connector.firstName} to introduce you to ${target.displayName}`,
      signals: { path: path.score },
      payload: {
        target: {
          name: target.displayName,
          title: target.currentTitle,
          org: target.currentOrganizationRaw,
          why: target.currentOrganizationRaw ? `their work at ${target.currentOrganizationRaw}` : undefined,
        },
        channel: connector.primaryEmail ? 'gmail' : 'linkedin',
      },
      status: 'pending' as const,
      dedupeKey: `intro:${connectorId}:${target.id}`,
      carriedOver: 0,
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    const existing = await db.suggestions.where('dedupeKey').equals(s.dedupeKey).first();
    if (!existing) {
      await db.suggestions.add(s);
      const { draftForSuggestion } = await import('../engine/brief');
      await draftForSuggestion(user, s);
    }
    toast.push({
      text: `Intro request drafted. It's in Drafts.`,
      tone: 'good',
      action: { label: 'Open', onClick: () => nav('/inbox') },
    });
  };
  const hovered = hover ? byId.get(hover) : undefined;
  const current = paths?.[pathIdx];
  const companyKey = companyFocus?.key;
  // the legend line and the chip on the map count the same people: those in the company's wedge
  const [companyCount, warmCount] = useMemo(() => {
    if (!companyKey) return [0, 0];
    let n = 0;
    let warm = 0;
    for (const p of visible)
      if (orbitGroupKey(p, orgMap) === companyKey) {
        n++;
        if (p.strength >= 0.3) warm++;
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
    <div className="-my-6 md:-mb-8 -mx-4 md:-mx-8 flex flex-col lg:flex-1 lg:min-h-0" data-testid="map-page">
      <div className="px-4 md:px-8 pt-5 pb-3 flex flex-wrap items-center gap-2 border-b border-line bg-canvas">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">
            {reachMode ? 'Reach' : webMode ? 'Introductions' : 'Your orbit'}
          </h1>
          <p className="text-[12px] text-ink-3">
            {reachMode
              ? 'Who can get you to someone, through people you already know.'
              : webMode
                ? 'Who introduced you to whom, generation by generation.'
                : highlightIds
                  ? `${highlightIds.size} of ${visible.length} people shown · inner ring = closest`
                  : `${visible.length} people · inner ring = closest`}
          </p>
        </div>
        <div className="w-full sm:w-auto sm:ml-auto flex items-center gap-2">
          <form
            ref={searchForm}
            onSubmit={(e) => {
              e.preventDefault();
              runSearch(query);
            }}
            className={cx('relative flex-1 sm:flex-none', missed && missed.q === query.trim() && 'shake-x')}
            data-testid="reach-form"
          >
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                // typing again takes the miss toast down: on a phone it sits over this box
                clearMiss();
                if (webMode && !e.target.value) setWebFocus(undefined);
              }}
              placeholder={webMode ? 'Search your introductions…' : 'Reach a person or company…'}
              className="pl-8 w-full sm:w-64 pointer-coarse:h-11 pointer-coarse:text-[16px]"
              data-testid="reach-input"
            />
          </form>
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
      <div className="lg:flex-1 lg:min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div
          className={cx(
            'relative min-w-0 overflow-hidden lg:h-auto lg:min-h-[420px] bg-[radial-gradient(circle_at_center,_#fff_0%,_#fafafc_70%)]',
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
            personCard={!reachMode}
            onHover={(id, place) => {
              setHover(id);
              if (place) setHoverPlace(place);
            }}
          />
          {hovered && !reachMode && (
            <div
              key={hovered.id}
              className={cx(
                'absolute bg-canvas border border-line rounded-[12px] p-3 shadow-[var(--shadow-card)] fade-up',
                // the map puts the card next to the dot on a wide map and at the top or bottom of a narrow one, never
                // over the person (on a phone the bottom only when it is clear of the tab bar); with a mouse the card
                // lets the pointer through
                'at' in hoverPlace
                  ? cx('left-3 right-3', hoverPlace.at === 'top' ? 'top-3' : 'bottom-3')
                  : 'w-[260px]',
                touch ? '' : 'pointer-events-none',
              )}
              style={'at' in hoverPlace ? undefined : { left: hoverPlace.x, top: hoverPlace.y }}
              data-place={'at' in hoverPlace ? hoverPlace.at : 'beside'}
              data-testid="map-tooltip"
            >
              <div className="flex items-center gap-2">
                <Avatar name={hovered.displayName} src={hovered.photoUrl} id={hovered.id} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{hovered.displayName}</div>
                  <div className="text-[12px] text-ink-3 truncate">
                    {[hovered.currentTitle, hovered.currentOrganizationRaw].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <Link
                  to={`/people/${hovered.id}`}
                  className={cx(
                    'text-[12px] text-accent shrink-0 pointer-events-auto',
                    // a thumb-sized target that does not make the card any taller
                    touch
                      ? 'inline-flex items-center justify-center min-h-11 min-w-11 -my-2 -mr-2 px-2'
                      : 'sm:hidden',
                  )}
                  data-testid="map-open-person"
                >
                  Open
                </Link>
              </div>
              <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-3">
                <StrengthDots v={hovered.strength} />{' '}
                {stages.get(hovered.id) ? <Chip>{STAGE_LABELS[stages.get(hovered.id)!]}</Chip> : null}
              </div>
            </div>
          )}
        </div>
        <aside
          className="min-w-0 border-t lg:border-t-0 lg:border-l border-line bg-canvas lg:overflow-y-auto scroll-thin p-4 space-y-3"
          data-testid="map-panel"
        >
          {!reachMode && !webMode && (
            <>
              <div className="text-[13px] text-ink-2">
                {touch
                  ? 'Tap a person to see who they are, and tap again to open their profile.'
                  : 'Hover over a person to see who they are and who they know, and click to open their profile. Drag to turn the orbit.'}{' '}
                Companies read as wedges. The thin coloured ring is pipeline stage, and a soft ripple marks
                the people your most pressing suggestions are about. A grey dot with a number stands for more
                people at that company.
              </div>
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
              <Card padded>
                <div className="font-medium text-[13px] mb-2">Legend</div>
                <ul className="text-[12px] text-ink-2 space-y-1">
                  <li>Inner ring: close ties (closeness 60 and up)</li>
                  <li>Middle ring: closeness 30 to 60</li>
                  <li>Outer: new or cold</li>
                </ul>
              </Card>
              <Button
                variant="primary"
                className={cx('w-full', TAP)}
                onClick={() => setParams({ reach: '1' })}
              >
                Find a path to someone
              </Button>
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
          {reachMode && !target && !companyFocus && !choices && (
            <div className="text-[13px] text-ink-2">
              Type a name (someone in your network) or a company above. Orbit finds up to three routes through
              people you know, with the reason each hop works.
            </div>
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
                  <div className="text-[12px] text-ink-3 truncate">
                    {[target.currentTitle, target.currentOrganizationRaw].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </div>
              {paths === undefined && (
                <p className="text-[13px] text-ink-3" data-testid="reach-loading" aria-busy="true">
                  Finding routes through your network…
                </p>
              )}
              {paths?.length === 0 && (
                <p className="text-[13px] text-ink-3">
                  No route found through your network yet. Import more connections or start a warm-up.
                </p>
              )}
              {coldDirect && (
                <p className="text-[13px] text-ink-2" data-testid="reach-cold-note">
                  {coldDirect.hops[0]!.text}. That tie is faint, so a note from you alone may go unanswered. A
                  word from someone who knows {target.firstName} carries more weight, which is why the routes
                  through people you know come first. Writing to {target.firstName} yourself is Route{' '}
                  {paths!.indexOf(coldDirect) + 1}.
                </p>
              )}
              {paths?.map((p, i) => (
                <button
                  key={i}
                  onClick={() => setPathIdx(i)}
                  className={cx(
                    'w-full text-left border rounded-[12px] p-3 transition-colors',
                    i === pathIdx ? 'border-accent bg-accent-soft/40' : 'border-line hover:bg-canvas-2',
                  )}
                  data-testid="reach-path"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-medium">
                      Route {i + 1} · {p.hops.length} hop{p.hops.length > 1 ? 's' : ''}
                    </span>
                    {isColdDirect(p) ? (
                      <Chip>Cold tie</Chip>
                    ) : (
                      <Chip tone={p.band === 'strong' ? 'good' : p.band === 'possible' ? 'warn' : 'neutral'}>
                        {REACH_BAND_LABELS[p.band]}
                      </Chip>
                    )}
                  </div>
                  <ol className="mt-2 space-y-1.5 text-[13px]">
                    {p.hops.map((h, k) => {
                      const to = byId.get(h.toId);
                      return (
                        <li key={k} className="flex items-start gap-2">
                          <span className="text-ink-3 tabular w-4">{k + 1}.</span>
                          <span>
                            <span className="font-medium">{to?.displayName ?? '…'}</span>
                            <br />
                            <span className="text-ink-3">{h.text}</span>
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </button>
              ))}
              {current && current.hops.length > 1 && (
                <Button variant="primary" className={cx('w-full', TAP)} onClick={() => askIntro(current)}>
                  Ask {byId.get(current.hops[0]!.toId)?.firstName ?? 'them'} for an intro
                </Button>
              )}
              {current && current.hops.length === 1 && (
                <Button
                  variant="primary"
                  className={cx('w-full', TAP)}
                  onClick={() => nav(`/people/${target.id}?draft=outreach`)}
                >
                  Write to {target.firstName} directly
                </Button>
              )}
            </>
          )}
          {companyFocus && !company && (
            <>
              <div className="font-medium">{companyFocus.label}</div>
              <p className="text-[13px] text-ink-3" data-testid="company-loading" aria-busy="true">
                Looking up who you know at {companyFocus.label}…
              </p>
            </>
          )}
          {company && (
            <>
              <div className="font-medium">{company.org?.name ?? company.label}</div>
              {(
                [
                  ['People there now', company.direct],
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
                        <Avatar name={d.person.displayName} id={d.person.id} size={22} />
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
                      className={cx('mt-1.5 text-[12px] text-accent hover:underline', TAP)}
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
                        {/* the same route, and the same count of hops, that Reach shows for this person */}
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
