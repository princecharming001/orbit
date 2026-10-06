import type { Person, ReachPath } from '@orbit/core';
import { newId, REACH_BAND_LABELS, STAGE_LABELS } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { OrbitMap } from '../components/OrbitMap';
import { db } from '../db/schema';
import { draftMessage } from '../engine/brief';
import { type CompanyReach, reachCompany, reachPerson } from '../engine/graph';
import { useSession } from '../state/session';
import { Avatar, Button, Card, Chip, cx, Input, useToast } from '../ui';
import { StrengthDots } from './Pipeline';

export function MapPage() {
  const { userId, user } = useSession();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const reachParam = params.get('reach');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'targets' | 'alumni' | 'chats' | 'recent'>('all');
  const [paths, setPaths] = useState<ReachPath[]>([]);
  const [pathIdx, setPathIdx] = useState(0);
  const [company, setCompany] = useState<CompanyReach>();
  const [target, setTarget] = useState<Person>();
  const [hover, setHover] = useState<string>();
  const people =
    useLiveQuery(() => (userId ? db.people.where('userId').equals(userId).toArray() : []), [userId]) ?? [];
  const orgs = useLiveQuery(() => db.organizations.toArray(), []) ?? [];
  const chats =
    useLiveQuery(() => (userId ? db.chats.where('userId').equals(userId).toArray() : []), [userId]) ?? [];
  const pending =
    useLiveQuery(
      () =>
        userId
          ? db.suggestions
              .where('userId')
              .equals(userId)
              .filter((s) => s.status === 'pending' && !!s.personId)
              .toArray()
          : [],
      [userId],
    ) ?? [];
  const tcs =
    useLiveQuery(
      () => (userId ? db.targetCompanies.where('userId').equals(userId).toArray() : []),
      [userId],
    ) ?? [];
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
  const pendingIds = useMemo(() => new Set(pending.map((s) => s.personId!)), [pending]);
  const targetNames = useMemo(() => new Set(tcs.map((t) => t.nameRaw.toLowerCase())), [tcs]);
  const visible = useMemo(() => people.filter((p) => p.isHuman && !p.hiddenAt), [people]);
  const highlightIds = useMemo(() => {
    if (filter === 'all') return undefined;
    const now = Date.now();
    return new Set(
      visible
        .filter((p) =>
          filter === 'targets'
            ? targetNames.has((p.currentOrganizationRaw ?? '').toLowerCase())
            : filter === 'alumni'
              ? p.isAlumni
              : filter === 'chats'
                ? stages.has(p.id)
                : !!p.lastInteractionAt && now - new Date(p.lastInteractionAt).getTime() < 90 * 86_400_000,
        )
        .map((p) => p.id),
    );
  }, [filter, visible, targetNames, stages]);
  const reachMode = !!reachParam;
  // resolve reach param (person id or '1' = open search)
  useEffect(() => {
    if (!userId || !reachParam || reachParam === '1') {
      setTarget(undefined);
      setPaths([]);
      if (!reachParam) setCompany(undefined); // a company result set by runSearch survives the reach=1 param update
      return;
    }
    (async () => {
      const p = await db.people.get(reachParam);
      if (p) {
        setTarget(p);
        setCompany(undefined);
        const ps = await reachPerson(userId, p.id);
        setPaths(ps);
        setPathIdx(0);
      }
    })();
  }, [reachParam, userId]);
  const runSearch = async (q: string) => {
    if (!userId) return;
    const s = q.trim().toLowerCase();
    if (!s) return;
    const hit =
      visible.find((p) => p.displayName.toLowerCase() === s) ??
      visible.find((p) => p.displayName.toLowerCase().includes(s));
    const orgHit = orgs.find((o) => o.nameNormalized === s) ?? orgs.find((o) => o.nameNormalized.includes(s));
    if (hit && (!orgHit || hit.displayName.toLowerCase().startsWith(s))) {
      setParams({ reach: hit.id });
      return;
    }
    if (orgHit || tcs.some((t) => t.nameRaw.toLowerCase().includes(s))) {
      setTarget(undefined);
      setPaths([]);
      setCompany(await reachCompany(userId, orgHit?.name ?? q));
      setParams({ reach: '1', company: q });
      return;
    }
    if (hit) setParams({ reach: hit.id });
    else
      toast.push({
        text: 'No one by that name or company in your network yet. Add them from LinkedIn or Discover.',
        ttl: 5000,
      });
  };
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
      text: `Intro request drafted. It's in Approvals.`,
      tone: 'good',
      action: { label: 'Open', onClick: () => nav('/inbox') },
    });
  };
  const hovered = hover ? visible.find((p) => p.id === hover) : undefined;
  const current = paths[pathIdx];
  const pathPeople = useMemo(() => new Map(visible.map((p) => [p.id, p])), [visible]);
  return (
    <div className="h-[calc(100vh-7rem)] md:h-[calc(100vh-3rem)] -my-6 -mx-4 md:-mx-8 flex flex-col">
      <div className="px-4 md:px-8 pt-5 pb-3 flex flex-wrap items-center gap-2 border-b border-line bg-canvas">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">
            {reachMode ? 'Reach' : 'Your orbit'}
          </h1>
          <p className="text-[12px] text-ink-3">
            {reachMode
              ? 'Who can get you to someone, through people you already know.'
              : `${visible.length} people · inner ring = closest`}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runSearch(query);
            }}
            className="relative"
          >
            <Search size={14} className="absolute left-2.5 top-2.5 text-ink-3" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Reach a person or company…"
              className="pl-8 w-64"
              data-testid="reach-input"
            />
          </form>
          {reachMode && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setParams({});
                setQuery('');
                setCompany(undefined);
              }}
            >
              <X size={14} /> Exit reach
            </Button>
          )}
        </div>
        {!reachMode && (
          <div
            className="w-full flex gap-1.5 mt-1 overflow-x-auto scroll-thin"
            role="group"
            aria-label="Show"
          >
            {(
              [
                ['all', 'Everyone'],
                ['targets', 'Target companies'],
                ['alumni', 'Alumni'],
                ['chats', 'In pipeline'],
                ['recent', 'Last 90 days'],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                onClick={() => setFilter(k)}
                className={cx(
                  'h-7 px-2.5 rounded-full border text-[12px] shrink-0 whitespace-nowrap',
                  filter === k ? 'bg-ink text-white border-ink' : 'border-line text-ink-2 hover:bg-canvas-2',
                )}
              >
                {l}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0 grid lg:grid-cols-[1fr_340px]">
        <div className="relative min-h-[420px] bg-[radial-gradient(circle_at_center,_#fff_0%,_#fafafc_70%)]">
          <OrbitMap
            people={visible}
            orgs={orgMap}
            stages={stages}
            pending={pendingIds}
            highlightPath={current}
            highlightIds={highlightIds}
            onSelect={(id) => (reachMode ? setParams({ reach: id }) : nav(`/people/${id}`))}
            onHover={setHover}
            focusId={target?.id}
          />
          {hovered && !reachMode && (
            <div className="absolute left-4 bottom-4 bg-canvas border border-line rounded-[12px] p-3 shadow-[var(--shadow-card)] w-[260px] fade-up">
              <div className="flex items-center gap-2">
                <Avatar name={hovered.displayName} src={hovered.photoUrl} id={hovered.id} size={32} />
                <div className="min-w-0">
                  <div className="font-medium truncate">{hovered.displayName}</div>
                  <div className="text-[12px] text-ink-3 truncate">
                    {[hovered.currentTitle, hovered.currentOrganizationRaw].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </div>
              <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-3">
                <StrengthDots v={hovered.strength} />{' '}
                {stages.get(hovered.id) ? <Chip>{STAGE_LABELS[stages.get(hovered.id)!]}</Chip> : null}
              </div>
            </div>
          )}
        </div>
        <aside className="border-l border-line bg-canvas overflow-y-auto scroll-thin p-4 space-y-3">
          {!reachMode && (
            <>
              <div className="text-[13px] text-ink-2">
                Hover a person for their name; click to open their profile. Companies read as wedges; the thin
                coloured ring is pipeline stage; a pulse means a pending suggestion.
              </div>
              <Card padded>
                <div className="font-medium text-[13px] mb-2">Legend</div>
                <ul className="text-[12px] text-ink-2 space-y-1">
                  <li>Inner ring: strong ties (closeness ≥ 60)</li>
                  <li>Middle: 30–60</li>
                  <li>Outer: new or cold</li>
                </ul>
              </Card>
              <Button variant="primary" className="w-full" onClick={() => setParams({ reach: '1' })}>
                Find a path to someone
              </Button>
            </>
          )}
          {reachMode && !target && !company && (
            <div className="text-[13px] text-ink-2">
              Type a name (someone in your network) or a company above. Orbit finds up to three routes through
              people you know, with the reason each hop works.
            </div>
          )}
          {target && (
            <>
              <div className="flex items-center gap-3">
                <Avatar name={target.displayName} src={target.photoUrl} id={target.id} size={40} />
                <div className="min-w-0">
                  <Link to={`/people/${target.id}`} className="font-medium hover:underline">
                    {target.displayName}
                  </Link>
                  <div className="text-[12px] text-ink-3 truncate">
                    {[target.currentTitle, target.currentOrganizationRaw].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </div>
              {paths.length === 0 && (
                <p className="text-[13px] text-ink-3">
                  No route found through your network yet.{' '}
                  {target.strength > 0.02
                    ? 'You already know them directly.'
                    : 'Import more connections or start a warm-up.'}
                </p>
              )}
              {paths.map((p, i) => (
                <button
                  key={i}
                  onClick={() => setPathIdx(i)}
                  className={cx(
                    'w-full text-left border rounded-[12px] p-3',
                    i === pathIdx ? 'border-accent bg-accent-soft/40' : 'border-line hover:bg-canvas-2',
                  )}
                  data-testid="reach-path"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-medium">
                      Route {i + 1} · {p.hops.length} hop{p.hops.length > 1 ? 's' : ''}
                    </span>
                    <Chip tone={p.band === 'strong' ? 'good' : p.band === 'possible' ? 'warn' : 'neutral'}>
                      {REACH_BAND_LABELS[p.band]}
                    </Chip>
                  </div>
                  <ol className="mt-2 space-y-1.5 text-[13px]">
                    {p.hops.map((h, k) => {
                      const to = pathPeople.get(h.toId);
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
                <Button variant="primary" className="w-full" onClick={() => askIntro(current)}>
                  Ask {pathPeople.get(current.hops[0]!.toId)?.firstName ?? 'them'} for an intro
                </Button>
              )}
              {current && current.hops.length === 1 && (
                <Button
                  variant="primary"
                  className="w-full"
                  onClick={() => nav(`/people/${target.id}?draft=outreach`)}
                >
                  Write to {target.firstName} directly
                </Button>
              )}
            </>
          )}
          {company && (
            <>
              <div className="font-medium">{company.org?.name ?? params.get('company')}</div>
              {[
                ['People there now', company.direct],
                ['Former employees you know', company.former],
                ['Alumni there', company.alumni],
              ].map(([title, list]) => (
                <div key={title as string}>
                  <div className="text-[12px] uppercase tracking-wide text-ink-3 mb-1">
                    {title as string} · {(list as { person: Person }[]).length}
                  </div>
                  {(list as { person: Person; strength: number }[]).length === 0 && (
                    <p className="text-[12px] text-ink-3">None</p>
                  )}
                  <ul className="space-y-1.5">
                    {(list as { person: Person; strength: number }[]).slice(0, 6).map((d) => (
                      <li key={d.person.id} className="flex items-center gap-2 text-[13px]">
                        <Avatar name={d.person.displayName} id={d.person.id} size={22} />
                        <button className="hover:underline" onClick={() => setParams({ reach: d.person.id })}>
                          {d.person.displayName}
                        </button>
                        <span className="ml-auto">
                          <StrengthDots v={d.strength} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {company.twoHop.length > 0 && (
                <div>
                  <div className="text-[12px] uppercase tracking-wide text-ink-3 mb-1">Two-hop routes</div>
                  <ul className="space-y-1 text-[13px]">
                    {company.twoHop.map((t) => (
                      <li key={t.target.id}>
                        <button
                          className="hover:underline font-medium"
                          onClick={() => setParams({ reach: t.target.id })}
                        >
                          {t.target.displayName}
                        </button>{' '}
                        <span className="text-ink-3">
                          via {pathPeople.get(t.path.hops[0]!.toId)?.firstName}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {company.org && (
                <Link to={`/companies/${company.org.id}`} className="text-[13px] text-accent">
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
