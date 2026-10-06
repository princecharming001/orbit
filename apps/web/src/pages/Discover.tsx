import { useLiveQuery } from 'dexie-react-hooks';
import { RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { feedback } from '../db/repo';
import { db } from '../db/schema';
import { recommendationsRefresh, startWarmUpOrOutreach } from '../engine/brief';
import { useSession } from '../state/session';
import { Avatar, Button, Chip, cx, EmptyState, Input, PageHeader, useToast } from '../ui';
import { StrengthDots } from './Pipeline';

export function Discover() {
  const { user, userId, goals } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const recs =
    useLiveQuery(
      () =>
        userId
          ? db.recommendations
              .where('userId')
              .equals(userId)
              .filter((r) => r.status === 'new' || r.status === 'saved')
              .toArray()
          : [],
      [userId],
    ) ?? [];
  const people =
    useLiveQuery(() => (userId ? db.people.where('userId').equals(userId).toArray() : []), [userId]) ?? [];
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const tcCount =
    useLiveQuery(() => (userId ? db.targetCompanies.where('userId').equals(userId).count() : 0), [userId]) ??
    0;
  const list = recs.sort(
    (a, b) => (b.status === 'saved' ? 1 : 0) - (a.status === 'saved' ? 1 : 0) || b.score - a.score,
  );
  const searchHits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return people
      .filter(
        (p) =>
          p.isHuman &&
          !p.hiddenAt &&
          (p.displayName.toLowerCase().includes(s) ||
            (p.currentOrganizationRaw ?? '').toLowerCase().includes(s) ||
            (p.currentTitle ?? '').toLowerCase().includes(s)),
      )
      .slice(0, 12);
  }, [q, people]);
  if (!user) return null;
  // Tell the student what is actually missing instead of a generic checklist.
  const missing = {
    people: people.filter((p) => p.isHuman && !p.hiddenAt).length === 0,
    goals: !goals?.targetFunctions.length && !tcCount,
  };
  const emptyHint = missing.people
    ? 'Orbit recommends people from your own network, and it is empty. Import your LinkedIn connections or connect Google, then generate recommendations.'
    : missing.goals
      ? 'Tell Orbit which functions and companies you are recruiting for, then generate recommendations.'
      : 'Nobody in your network matches your goals yet. Import more connections or add target companies, then try again.';
  const refresh = async () => {
    setBusy(true);
    await recommendationsRefresh(user);
    // Count what the page will actually show (new and saved), not what the ranker produced this run.
    const shown = await db.recommendations
      .where('userId')
      .equals(user.id)
      .filter((r) => r.status === 'new' || r.status === 'saved')
      .count();
    setBusy(false);
    toast.push({
      text: shown
        ? `${shown} recommendation${shown === 1 ? '' : 's'} ready.`
        : 'No new recommendations yet. See the note below for what would help.',
    });
  };
  const start = async (personId: string) => {
    const p = byId.get(personId);
    const r = await startWarmUpOrOutreach(
      user,
      personId,
      p?.primaryEmail ? 'gmail' : 'linkedin',
      'recommendation',
    );
    if (r.draft) nav(`/people/${personId}?draft=outreach`);
    else {
      toast.push({
        text: `Warm-up started for ${p?.firstName}. First step is on Today.`,
        tone: 'good',
        ttl: 5000,
      });
      nav('/today');
    }
  };
  return (
    <div>
      <PageHeader
        title="Discover"
        subtitle="People worth a coffee chat, ranked by fit, reachability and how likely they are to reply."
        actions={
          <Button onClick={refresh} disabled={busy}>
            <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Refresh
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search your network: name, company, title"
          aria-label="Search your network"
          className="w-full sm:w-80"
        />
        <Link to="/map?reach=1">
          <Button variant="secondary">Find a path to someone</Button>
        </Link>
      </div>
      {searchHits.length > 0 && (
        <div className="mb-6 border border-line rounded-[var(--radius-card)] divide-y divide-line">
          {searchHits.map((p) => (
            <div key={p.id} className="p-3 flex items-center gap-3">
              <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={30} />
              <div className="min-w-0 flex-1">
                <Link to={`/people/${p.id}`} className="font-medium hover:underline">
                  {p.displayName}
                </Link>
                <div className="text-[12px] text-ink-3 truncate">
                  {[p.currentTitle, p.currentOrganizationRaw].filter(Boolean).join(' · ')}
                </div>
              </div>
              <StrengthDots v={p.strength} />
              <Button size="sm" variant="primary" onClick={() => start(p.id)}>
                Start
              </Button>
            </div>
          ))}
        </div>
      )}
      {list.length === 0 ? (
        <EmptyState
          title="No recommendations yet"
          body={emptyHint}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {missing.people && (
                <Link to="/settings/integrations">
                  <Button variant="primary">Import connections</Button>
                </Link>
              )}
              {missing.goals && (
                <Link to="/settings/goals">
                  <Button variant={missing.people ? 'secondary' : 'primary'}>Set your goals</Button>
                </Link>
              )}
              <Button variant={missing.people || missing.goals ? 'secondary' : 'primary'} onClick={refresh}>
                Generate recommendations
              </Button>
            </div>
          }
        />
      ) : (
        <div className="grid md:grid-cols-2 gap-3 [&>*]:min-w-0">
          {list.map((r) => {
            const p = byId.get(r.personId);
            if (!p) return null;
            const cold = p.strength < 0.2 && !p.primaryEmail;
            return (
              <div
                key={r.id}
                className={cx(
                  'bg-canvas border rounded-[var(--radius-card)] p-4 fade-up',
                  r.status === 'saved' ? 'border-accent/50' : 'border-line',
                )}
                data-testid="rec-card"
              >
                <div className="flex items-start gap-3">
                  <Link to={`/people/${p.id}`}>
                    <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={44} />
                  </Link>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link to={`/people/${p.id}`} className="font-medium hover:underline truncate">
                        {p.displayName}
                      </Link>
                      {p.isAlumni && (
                        <Chip tone="accent" className="h-5">
                          Alum
                        </Chip>
                      )}
                      {r.status === 'saved' && <Chip className="h-5">Saved</Chip>}
                    </div>
                    <div className="text-[13px] text-ink-2 truncate">
                      {[p.currentTitle, p.currentOrganizationRaw].filter(Boolean).join(' · ')}
                    </div>
                    <ul className="mt-2 text-[13px] text-ink-2 space-y-0.5">
                      {r.reasons.slice(0, 3).map((x) => (
                        <li key={x.code}>· {x.text}</li>
                      ))}
                    </ul>
                    <div className="mt-2 flex items-center gap-3 text-[12px] text-ink-3">
                      <span className="inline-flex items-center gap-1">
                        Reach <StrengthDots v={r.reachScore} label="Reach" />
                      </span>
                      <span>Fit {Math.round(r.fitScore * 100)}</span>
                      {cold && (
                        <Chip tone="warn" className="h-5">
                          Warm-up first
                        </Chip>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button variant="primary" size="sm" onClick={() => start(p.id)} data-testid="rec-start">
                    {cold ? 'Start warm-up' : 'Start outreach'}
                  </Button>
                  {r.status !== 'saved' && (
                    <Button size="sm" onClick={() => db.recommendations.update(r.id, { status: 'saved' })}>
                      Save
                    </Button>
                  )}
                  <div
                    className="sm:ml-auto flex flex-wrap gap-1 text-[12px]"
                    role="group"
                    aria-label="Not a fit? Tell Orbit why"
                  >
                    {[
                      ['wrong_role', 'Wrong role'],
                      ['wrong_company', 'Wrong company'],
                      ['know_them', 'Know them'],
                      ['not_now', 'Not now'],
                    ].map(([k, l]) => (
                      <button
                        key={k}
                        className="px-2 h-6 rounded-md text-ink-3 hover:bg-canvas-2 hover:text-ink"
                        onClick={async () => {
                          await db.recommendations.update(r.id, { status: 'dismissed', dismissedReason: k });
                          await feedback(user.id, 'recommendation_dismiss', {
                            reason: k,
                            refTable: 'recommendations',
                            refId: r.id,
                          });
                        }}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
