import { useLiveQuery } from 'dexie-react-hooks';
import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AddPersonButton } from '../components/AddPerson';
import { LinkedInImportButton } from '../components/LinkedInImport';
import { RoleLine } from '../components/SuggestionCard';
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
  // the list is brought up to date each time the page opens, so someone just added shows up without a Refresh
  const [updating, setUpdating] = useState(true);
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
  // people already in a chat are not recommended again; the empty list says so instead of "nobody matches"
  const inPipeline =
    useLiveQuery(() => (userId ? db.chats.where('userId').equals(userId).count() : 0), [userId]) ?? 0;
  useEffect(() => {
    if (!user) return;
    let live = true;
    recommendationsRefresh(user)
      .catch(() => undefined)
      .finally(() => live && setUpdating(false));
    return () => {
      live = false;
    };
  }, [user?.id]);
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
    ? 'Orbit recommends people from your own network, and it is empty so far. Add the people you know of by hand, or import your LinkedIn connections, and recommendations follow.'
    : missing.goals
      ? 'Tell Orbit which functions and companies you are recruiting for, and Discover fills in from your network.'
      : inPipeline
        ? 'Everyone in your network who fits your goals is already in your Pipeline. Add more people at your target companies, or import your LinkedIn connections, for new suggestions.'
        : 'Nobody in your network matches your goals yet. Add people at your target companies or import more connections.';
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
        : missing.people
          ? 'No recommendations yet: your network is empty. Add a person or import your LinkedIn connections first.'
          : 'No new recommendations. Add people at your target companies or import more connections.',
      ttl: 6000,
    });
  };
  const start = async (personId: string, opts: { skipWarmUp?: boolean } = {}) => {
    const p = byId.get(personId);
    const r = await startWarmUpOrOutreach(
      user,
      personId,
      p?.primaryEmail ? 'gmail' : 'linkedin',
      'recommendation',
      opts,
    );
    if (r.draft) nav(`/people/${personId}?open=${r.draft.id}`);
    else {
      // stay on the list: the student is still choosing who to meet, and the first step waits on Today
      toast.push({
        text: `Warm-up started for ${p?.firstName}. The first step is on Today.`,
        tone: 'good',
        ttl: 8000,
        action: { label: 'Open on Today', onClick: () => nav(`/today?person=${personId}`) },
      });
    }
  };
  const drop = async (id: string, reason: string, label: string) => {
    await db.recommendations.update(id, { status: 'dismissed', dismissedReason: reason });
    await feedback(user.id, 'recommendation_dismiss', { reason, refTable: 'recommendations', refId: id });
    toast.push({
      text: `Removed (${label.toLowerCase()}). Orbit learns from this for the next list.`,
      action: {
        label: 'Undo',
        onClick: () => db.recommendations.update(id, { status: 'new', dismissedReason: undefined }),
      },
      ttl: 6000,
    });
  };
  return (
    <div>
      <PageHeader
        title="Discover"
        subtitle="People from your network worth a coffee chat. Saved people come first, then the best mix of how well they match your goals and how easy they are to reach."
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
          placeholder="Search your network"
          aria-label="Search your network"
          className="w-full sm:w-80"
        />
        {people.filter((p) => p.isHuman && !p.hiddenAt).length > 1 && (
          <Link
            to="/map?reach=1"
            title="Opens the Map, where you pick a person and see who could introduce you"
          >
            <Button variant="secondary">Find an intro on the Map</Button>
          </Link>
        )}
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
      {list.length === 0 && updating ? (
        <p className="text-[13px] text-ink-3" data-testid="discover-updating">
          Checking your network…
        </p>
      ) : list.length === 0 ? (
        <EmptyState
          title="No recommendations yet"
          body={emptyHint}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {/* the two things the message suggests, right here, whatever is missing */}
              <AddPersonButton variant={missing.people || !missing.goals ? 'primary' : 'secondary'} />
              <LinkedInImportButton />
              {missing.goals && (
                <Link to="/settings/goals">
                  <Button variant={missing.people ? 'secondary' : 'primary'}>Set your goals</Button>
                </Link>
              )}
              {!missing.people && !missing.goals && inPipeline > 0 && (
                <Link to="/pipeline">
                  <Button variant="secondary">Open Pipeline</Button>
                </Link>
              )}
            </div>
          }
        />
      ) : (
        <>
          <p className="text-[12px] text-ink-3 mb-3" data-testid="discover-legend">
            Match is how well their role and company fit your goals, out of 100. Reach is how easy they are to
            get to: through people you know, a shared school, or a past conversation. The order weighs both.
          </p>
          <div className="grid md:grid-cols-2 gap-3 [&>*]:min-w-0">
            {list.map((r) => {
              const p = byId.get(r.personId);
              if (!p) return null;
              // someone the student was pointed to, or in their own club, is written to directly
              const cold =
                p.strength < 0.2 &&
                !p.primaryEmail &&
                !r.reasons.some((x) => x.code === 'referred' || x.code === 'shared_org_now');
              const introId =
                r.bestPath && r.bestPath.hops.length >= 2 ? r.bestPath.hops[0]!.toId : undefined;
              const introducer = introId ? byId.get(introId) : undefined;
              return (
                <div
                  key={r.id}
                  className={cx(
                    'bg-canvas border rounded-[var(--radius-card)] p-4 fade-up flex flex-col',
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
                      <RoleLine title={p.currentTitle} company={p.currentOrganizationRaw} />
                      <ul className="mt-2 text-[13px] text-ink-2 space-y-0.5">
                        {r.reasons.slice(0, 3).map((x) => (
                          <li key={x.code}>· {x.text}</li>
                        ))}
                      </ul>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
                        <span title="How well their role and company fit your goals, out of 100">
                          Match {Math.round(r.fitScore * 100)}
                        </span>
                        <span title="How easy they are to reach, out of 100">
                          Reach {Math.round(r.reachScore * 100)}
                        </span>
                      </div>
                      {cold && (
                        <p className="mt-1.5 text-[12px] text-warn" data-testid="rec-warmup-why">
                          {introducer
                            ? `You only have ${p.firstName} on LinkedIn, but ${introducer.firstName} knows them: an intro gets a much warmer reply than a cold note.`
                            : `You only have ${p.firstName} on LinkedIn and have never talked, so Orbit suggests a short warm-up before your first message.`}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-auto pt-3 flex flex-wrap items-center gap-2">
                    {cold && introducer ? (
                      // someone the student knows can introduce them: that beats a warm-up with a stranger
                      <Link to={`/map?reach=${p.id}`} data-testid="rec-intro">
                        <Button variant="primary" size="sm">
                          Ask {introducer.firstName} for an intro
                        </Button>
                      </Link>
                    ) : null}
                    <Button
                      variant={cold && introducer ? 'secondary' : 'primary'}
                      size="sm"
                      onClick={() => start(p.id)}
                      data-testid="rec-start"
                    >
                      {cold ? 'Start warm-up' : 'Write first message'}
                    </Button>
                    {cold && (
                      // the same choice Today and the person page give: a student who already knows them writes now
                      <Button
                        size="sm"
                        onClick={() => start(p.id, { skipWarmUp: true })}
                        data-testid="rec-write-now"
                      >
                        Write now instead
                      </Button>
                    )}
                    {r.status !== 'saved' && (
                      <Button
                        size="sm"
                        onClick={async () => {
                          await db.recommendations.update(r.id, { status: 'saved' });
                          toast.push({
                            text: `Saved ${p.firstName}. Saved people stay at the top of Discover until you write to them.`,
                          });
                        }}
                      >
                        Save for later
                      </Button>
                    )}
                    <div
                      className="w-full flex flex-wrap items-center gap-1 text-[12px]"
                      role="group"
                      aria-label="Not a fit? Tell Orbit why"
                    >
                      <span className="text-ink-3 self-center mr-0.5">Not a fit?</span>
                      {[
                        ['wrong_role', 'Wrong role'],
                        ['wrong_company', 'Wrong company'],
                        ['know_them', 'Already know them'],
                        ['not_now', 'Not now'],
                      ].map(([k, l]) => (
                        <button
                          key={k}
                          className="px-2 h-7 rounded-md text-ink-3 hover:bg-canvas-2 hover:text-ink"
                          onClick={() => drop(r.id, k!, l!)}
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
        </>
      )}
    </div>
  );
}
