import { normalizeCompany, TARGET_STATUS_LABELS, type TargetCompany } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { askIntroKey, useAskIntro } from '../components/askIntro';
import { CompanyLogo } from '../components/CompanyLogo';
import { RouteBadge } from '../components/map/RouteBadge';
import { PersonRow } from '../components/PersonRow';
import { TargetPlanCard } from '../components/TargetPlanCard';
import { db } from '../db/schema';
import { startWarmUpOrOutreach } from '../engine/brief';
import {
  COMPANY_TEAM_LABELS,
  type CompanyPerson,
  type CompanyReach,
  type CompanyTeam,
  reachCompany,
} from '../engine/graph';
import { setTargetStatus } from '../engine/settings';
import { planForPosting } from '../engine/targetPlan';
import { useSession } from '../state/session';
import { Button, Card, cx, NotFound, PageHeader, Skeleton, SkeletonRows, useToast, useWorking } from '../ui';

/** Rows drawn at first and each time the list's end scrolls into view: a big company never draws everyone at once. */
const PAGE = 40;

type Filter = 'all' | 'alumni' | CompanyTeam;

/**
 * A company as a target (plan 23 §4.2): who the student can reach there and how, grouped by team, each person with
 * the way in the Map shows and one button for it. The header sets the company as a target, or shows where the
 * application stands when it is one.
 */
export function CompanyPage() {
  const { id } = useParams();
  const { user, userId } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  // one slow click at a time on the page (planning, an intro request, a warm-up), each with its spinner
  const working = useWorking();
  const { ask: askIntro } = useAskIntro(user, working);
  // null means "looked it up and it is not there", undefined means "still loading".
  const org = useLiveQuery(async () => (id ? ((await db.organizations.get(id)) ?? null) : null), [id]);
  // a target matches by its organization, or by name when it was added before it had one
  const tc = useLiveQuery(
    async () =>
      userId && org
        ? db.targetCompanies
            .where('userId')
            .equals(userId)
            .filter(
              (t) =>
                t.organizationId === org.id ||
                (!!normalizeCompany(t.nameRaw) && normalizeCompany(t.nameRaw) === org.nameNormalized),
            )
            .first()
            // null: not a target; undefined: still reading (the header waits instead of offering "Set as target")
            .then((t) => t ?? null)
        : undefined,
    [userId, org?.id],
  );
  const [reach, setReach] = useState<CompanyReach>();
  const [reachFailed, setReachFailed] = useState(false);
  // the plan for this target, newest first (plan 23 §4.1)
  const plan = useLiveQuery(
    async () =>
      tc
        ? ((await db.targetPlans.where('targetCompanyId').equals(tc.id).toArray()).sort((a, b) =>
            b.builtAt.localeCompare(a.builtAt),
          )[0] ?? null)
        : undefined,
    [tc?.id],
  );
  const [filter, setFilter] = useState<Filter>('all');
  useEffect(() => {
    if (!userId || !org) return;
    // an answer for the company this page showed before is dropped; a failure ends the skeleton
    let live = true;
    setReachFailed(false);
    reachCompany(userId, org.id)
      .then((r) => live && setReach(r))
      .catch(() => live && setReachFailed(true));
    return () => {
      live = false;
    };
  }, [userId, org?.id]);
  if (org === undefined)
    return (
      <div
        className="loading-in"
        role="status"
        aria-busy="true"
        aria-label="Loading"
        data-testid="company-loading"
      >
        <Skeleton className="h-6 w-48 mb-2" />
        <Skeleton className="h-3 w-64 max-w-full mb-8" />
        <SkeletonRows rows={6} divided />
      </div>
    );
  if (org === null)
    return (
      <NotFound
        title="We can't find that company"
        body="It may have been merged with another record, or the link is out of date."
        to="/people?view=companies"
        linkLabel="Back to companies"
      />
    );
  const setAsTarget = async () => {
    if (!user) return;
    // the target and its plan at once (plan 23 §4.2): who to write to there, and when
    await working.run('target', `Planning your way into ${org.name}…`, async () => {
      await planForPosting(user, { company: org.name, role: '' });
      toast.push({
        text: `${org.name} is a target now. Your plan is at the bottom of the page.`,
        tone: 'good',
      });
    });
  };
  const act = async (c: CompanyPerson) => {
    if (!user) return;
    if (c.action === 'ask' && c.route.path) {
      await askIntro(c.route.path.hops[0]!.toId, c.person.id, c.route.score, c.route.path.hops);
      return;
    }
    if (c.action === 'warm_up') {
      await working.run(actKey(c), `Writing to ${c.person.firstName}…`, async () => {
        const r = await startWarmUpOrOutreach(user, c.person.id, 'linkedin', 'reach');
        if (r.draft) nav(`/people/${c.person.id}?open=${r.draft.id}`);
        else
          toast.push({
            text: `Warm-up started for ${c.person.firstName}. The first step is in Drafts.`,
            tone: 'good',
          });
      });
      return;
    }
    nav(`/people/${c.person.id}?draft=outreach`);
  };
  return (
    <div data-testid="company-page">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-3">
            <CompanyLogo name={org.name} orgId={org.id} size={32} decorative />
            {org.name}
          </span>
        }
        subtitle={[org.industry, org.sizeBucket ? `${org.sizeBucket} people` : undefined, org.domains[0]]
          .filter(Boolean)
          .join(' · ')}
        actions={
          tc === undefined ? (
            <Skeleton className="h-9 w-28 rounded-full" />
          ) : tc ? (
            <TargetChips target={tc} />
          ) : (
            <Button
              variant="primary"
              onClick={setAsTarget}
              loading={working.busy === 'target'}
              data-testid="company-set-target"
            >
              Set as target
            </Button>
          )
        }
      />
      {reachFailed && !reach ? (
        <p className="text-[13px] text-ink-3" data-testid="company-reach-error">
          Orbit could not work out who you can reach here. Reload the page to try again.
        </p>
      ) : !reach ? (
        <SkeletonRows rows={6} divided testId="company-reach-loading" />
      ) : (
        <CompanyBody
          name={org.name}
          reach={reach}
          filter={filter}
          setFilter={setFilter}
          onAct={(c) => void act(c)}
          busy={working.busy}
        />
      )}
      {tc && plan === null && user && reach && (
        <div className="mt-6">
          <Button
            onClick={() =>
              void working.run('plan', `Planning your way into ${org.name}…`, () =>
                planForPosting(user, {
                  company: org.name,
                  role: tc.role ?? '',
                  team: tc.team,
                  url: tc.postingUrl,
                }),
              )
            }
            loading={working.busy === 'plan'}
            data-testid="company-make-plan"
          >
            Plan my way in
          </Button>
        </div>
      )}
      {plan && (
        <section className="mt-6" data-testid="company-plan-card">
          <h2 className="label-mono mb-2">Suggested plan</h2>
          <TargetPlanCard plan={plan} />
        </section>
      )}
    </div>
  );
}

/** Where the application stands, one tap to change it. */
function TargetChips({ target }: { target: TargetCompany }) {
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      role="group"
      aria-label="Application"
      data-testid="company-target"
    >
      <span className="label-mono mr-1">Target</span>
      {(Object.keys(TARGET_STATUS_LABELS) as TargetCompany['status'][]).map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => void setTargetStatus(target.id, s)}
          aria-pressed={target.status === s}
          className={cx(
            'h-7 px-2.5 rounded-full border text-[12px] transition-colors pointer-coarse:h-11',
            target.status === s ? 'bg-ink text-white border-ink' : 'border-line text-ink-2 hover:bg-canvas-2',
          )}
          data-testid="company-target-status"
        >
          {TARGET_STATUS_LABELS[s]}
        </button>
      ))}
    </div>
  );
}

function CompanyBody({
  name,
  reach,
  filter,
  setFilter,
  onAct,
  busy,
}: {
  name: string;
  reach: CompanyReach;
  filter: Filter;
  setFilter: (f: Filter) => void;
  onAct: (c: CompanyPerson) => void;
  /** the `useWorking` key being worked on: that person's button spins */
  busy?: string;
}) {
  const people = reach.people;
  const counts = useMemo(() => {
    const m = new Map<CompanyTeam, number>();
    for (const c of people) m.set(c.team, (m.get(c.team) ?? 0) + 1);
    // biggest team first, Other always last
    return [...m].sort((a, b) => Number(a[0] === 'other') - Number(b[0] === 'other') || b[1] - a[1]);
  }, [people]);
  const shown = useMemo(
    () => people.filter((c) => (filter === 'all' ? true : filter === 'alumni' ? c.alum : c.team === filter)),
    [people, filter],
  );
  const groups = useMemo(() => {
    const order = counts.map(([t]) => t);
    const by = new Map<CompanyTeam, CompanyPerson[]>();
    for (const c of shown) by.set(c.team, [...(by.get(c.team) ?? []), c]);
    return order.filter((t) => by.has(t)).map((t) => ({ team: t, people: by.get(t)! }));
  }, [shown, counts]);
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [filter]);
  const { ref: more, inView } = useInView({ rootMargin: '400px' });
  useEffect(() => {
    if (inView) setLimit((l) => l + PAGE);
  }, [inView]);
  const known = people.filter((c) => c.route.kind === 'direct' && c.route.score >= 0.4).length;
  const warm = people.filter((c) => c.route.kind === 'warm').length;
  const alumni = people.filter((c) => c.alum).length;
  const best = people.reduce<CompanyPerson | undefined>(
    (b, c) => (c.route.path && (!b || c.route.score > b.route.score) ? c : b),
    undefined,
  );
  if (!people.length && !reach.former.length)
    return (
      <Card padded data-testid="company-empty">
        <p className="text-[14px]">Nobody in your network touches {name} yet.</p>
        <Link to={`/discover?q=${encodeURIComponent(name)}`} className="inline-block mt-3">
          <Button variant="primary">Find people there</Button>
        </Link>
      </Card>
    );
  let drawn = 0;
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-2 @3xl:grid-cols-4 gap-4" data-testid="company-stats">
        <Stat
          label="You know there"
          value={known}
          why="People there you know well enough to write to yourself."
        />
        <Stat
          label="Reachable warm"
          value={warm}
          why="People there you don't know yet, with someone you know who knows them."
        />
        <Stat label="Alumni there" value={alumni} why="People there who went to your school." />
        <Stat
          label="Best route"
          value={best ? <RouteBadge path={best.route.path} testId="company-best-route" /> : 'None yet'}
          why="The strongest way in to anyone there, out of 100."
        />
      </dl>
      {people.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Team" data-testid="company-teams">
          <TeamChip on={filter === 'all'} onClick={() => setFilter('all')} label="All teams" />
          {counts.map(([t, n]) => (
            <TeamChip
              key={t}
              on={filter === t}
              onClick={() => setFilter(t)}
              label={`${COMPANY_TEAM_LABELS[t]} · ${n}`}
            />
          ))}
          {alumni > 0 && (
            <TeamChip on={filter === 'alumni'} onClick={() => setFilter('alumni')} label="Alumni only" />
          )}
        </div>
      )}
      <div className="space-y-4" data-testid="company-list">
        {groups.map((g) => {
          if (drawn >= limit) return null;
          const rows = g.people.slice(0, limit - drawn);
          drawn += rows.length;
          return (
            <section key={g.team} data-testid="company-group" data-team={g.team}>
              <h2 className="label-mono mb-1">
                {COMPANY_TEAM_LABELS[g.team]} · {g.people.length}
              </h2>
              <ul className="divide-y divide-line-2">
                {rows.map((c) => (
                  <PersonRow
                    key={c.person.id}
                    person={c.person}
                    testId="company-person"
                    sub={
                      [c.person.currentTitle, c.alum && schoolLine(c)].filter(Boolean).join(' · ') ||
                      undefined
                    }
                    line={c.route.line}
                    badge={<RouteBadge path={c.route.path} />}
                    action={
                      <Button
                        size="sm"
                        variant={c.action === 'save' ? 'secondary' : 'primary'}
                        className="pointer-coarse:min-h-11"
                        onClick={() => onAct(c)}
                        loading={!!busy && busy === actKey(c)}
                        data-testid="company-person-action"
                      >
                        {actionLabel(c)}
                      </Button>
                    }
                  />
                ))}
              </ul>
            </section>
          );
        })}
        {shown.length > limit && <div ref={more} className="h-8" aria-hidden />}
      </div>
      {reach.former.length > 0 && (
        <section data-testid="company-former">
          <h2 className="label-mono mb-1">Former employees you know · {reach.former.length}</h2>
          <ul className="divide-y divide-line-2">
            {reach.former.slice(0, 12).map((f) => (
              <PersonRow
                key={f.person.id}
                person={f.person}
                sub={[f.person.currentTitle, f.person.currentOrganizationRaw].filter(Boolean).join(' at ')}
                line={f.endedAt ? `left ${f.endedAt.slice(0, 4)}` : 'worked there before'}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** The `useWorking` key of a person's button: their intro request, or their warm-up. */
function actKey(c: CompanyPerson): string {
  return c.action === 'ask' && c.route.path
    ? askIntroKey(c.route.path.hops[0]!.toId, c.person.id)
    : `warm:${c.person.id}`;
}

function schoolLine(c: CompanyPerson): string | undefined {
  return c.person.school ?? 'Alum';
}

function actionLabel(c: CompanyPerson): string {
  const first = c.person.firstName || c.person.displayName;
  if (c.action === 'ask') return `Ask ${c.route.via?.name ?? 'for an intro'}`;
  if (c.action === 'warm_up') return 'Warm up';
  if (c.action === 'save') return 'Save';
  return `Write to ${first}`;
}

function TeamChip({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cx(
        'h-7 px-2.5 rounded-full border text-[12px] whitespace-nowrap transition-colors pointer-coarse:h-11 pointer-coarse:px-3.5',
        on ? 'bg-ink text-white border-ink' : 'border-line text-ink-2 hover:bg-canvas-2',
      )}
      data-testid="company-team-chip"
    >
      {label}
    </button>
  );
}

function Stat({ label, value, why }: { label: string; value: React.ReactNode; why: string }) {
  return (
    <div className="min-w-0" title={why}>
      <dt className="label-mono">{label}</dt>
      <dd className="text-[22px] tracking-[-0.02em] tabular leading-tight mt-1" data-testid="company-stat">
        {value}
      </dd>
    </div>
  );
}
