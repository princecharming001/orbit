import { useLiveQuery } from 'dexie-react-hooks';
import { RefreshCw } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AddPersonButton } from '../components/AddPerson';
import { FindPeople } from '../components/account/FindPeople';
import { LinkedInImportButton } from '../components/LinkedInImport';
import { StrengthDots } from '../components/people/shared';
import { RoleLine } from '../components/SuggestionCard';
import { db } from '../db/schema';
import { recommendationsRefresh, startWarmUpOrOutreach } from '../engine/brief';
import {
  dismissRecommendation,
  introducerIdFor,
  isColdRecommendation,
  outreachChannelFor,
  RECOMMENDATION_DISMISS_REASONS,
  type RecommendationDismissReason,
  restoreRecommendation,
  saveRecommendation,
} from '../engine/recommend';
import { isServerUser } from '../integrations/orbitApi';
import { useSession } from '../state/session';
import { Avatar, Button, Chip, cx, EmptyState, Input, PageHeader, Tabs, useToast } from '../ui';

/**
 * Discover: people from the student's own network worth a coffee chat, and in account mode a second tab, Find
 * people, that searches beyond it (plan 16 §6).
 */
export function Discover() {
  const { userId } = useSession();
  const [params, setParams] = useSearchParams();
  if (!userId || !isServerUser(userId)) return <NetworkDiscover />;
  const tab = params.get('tab') === 'find' ? 'find' : 'network';
  const tabs = (
    <Tabs
      value={tab}
      onChange={(t) => setParams(t === 'find' ? { tab: 'find' } : {}, { replace: true })}
      items={[
        { value: 'network', label: 'Your network' },
        { value: 'find', label: 'Find people' },
      ]}
    />
  );
  if (tab === 'network') return <NetworkDiscover tabs={tabs} />;
  return (
    <div>
      <PageHeader
        title="Discover"
        subtitle="Search beyond your network for investors, customers, candidates, mentors and collaborators. Orbit ranks them by fit and how easy they are to reach."
      />
      {tabs}
      <FindPeople userId={userId} />
    </div>
  );
}

function NetworkDiscover({ tabs }: { tabs?: ReactNode }) {
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
        ? 'Everyone in your network who fits your goals already has a chat with you on the People board. Add more people at your target companies, or import your LinkedIn connections, for new suggestions.'
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
      outreachChannelFor(p ?? {}),
      'recommendation',
      opts,
    );
    if (r.draft) nav(`/people/${personId}?open=${r.draft.id}`);
    else {
      // stay on the list: the student is still choosing who to meet, and the first step waits in Drafts
      toast.push({
        text: `Warm-up started for ${p?.firstName}. The first step is in Drafts.`,
        tone: 'good',
        ttl: 8000,
        action: { label: 'Open in Drafts', onClick: () => nav(`/inbox?person=${personId}`) },
      });
    }
  };
  const drop = async (id: string, reason: RecommendationDismissReason, label: string) => {
    await dismissRecommendation(user.id, id, reason);
    toast.push({
      text: `Removed (${label.toLowerCase()}). Orbit learns from this for the next list.`,
      action: { label: 'Undo', onClick: () => restoreRecommendation(id) },
      ttl: 6000,
    });
  };
  return (
    <div>
      <PageHeader
        title="Discover"
        subtitle="People worth a coffee chat, best fit and easiest to reach first."
        actions={
          <Button onClick={refresh} disabled={busy}>
            <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Refresh
          </Button>
        }
      />
      {tabs}
      <div className="mb-4 flex flex-wrap gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search your network"
          aria-label="Search your network"
          className="w-full @[40rem]:w-80"
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
                <Link to="/people?view=board">
                  <Button variant="secondary">Open the board</Button>
                </Link>
              )}
            </div>
          }
        />
      ) : (
        <>
          <div className="stagger grid @3xl:grid-cols-2 @7xl:grid-cols-3 @[104rem]:grid-cols-4 gap-3 [&>*]:min-w-0">
            {list.map((r) => {
              const p = byId.get(r.personId);
              if (!p) return null;
              // someone the student was pointed to, or in their own club, is written to directly
              const cold = isColdRecommendation(p, r);
              const introId = introducerIdFor(r);
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
                        {r.reasons.slice(0, 2).map((x) => (
                          <li key={x.code}>· {x.text}</li>
                        ))}
                      </ul>
                      <div className="mt-3 grid grid-cols-2 gap-3 max-w-[300px]" data-testid="rec-scores">
                        <ScoreBar
                          label="Match"
                          value={r.fitScore}
                          title="How well their role and company fit your goals, out of 100"
                        />
                        <ScoreBar
                          label="Reach"
                          value={r.reachScore}
                          title="How easy they are to reach, out of 100"
                        />
                      </div>
                      {cold && (
                        <p className="mt-1.5 text-[12px] text-warn" data-testid="rec-warmup-why">
                          {introducer
                            ? `${introducer.firstName} could introduce you, which lands warmer than a cold note.`
                            : 'You only know them from LinkedIn: a short warm-up first gets a warmer reply.'}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-auto pt-3 flex flex-wrap items-center gap-2">
                    {cold && introducer ? (
                      // someone the student knows can introduce them: that beats a warm-up with a stranger
                      <Link to={`/map?reach=${p.id}`} data-testid="rec-intro" className="max-w-full">
                        <Button
                          variant="primary"
                          size="sm"
                          className="whitespace-normal! h-auto! min-h-8 py-1 text-left"
                        >
                          Intro through {introducer.firstName}
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
                        variant="ghost"
                        onClick={() => start(p.id, { skipWarmUp: true })}
                        data-testid="rec-write-now"
                        title="Skip the warm-up and write the first message now"
                      >
                        Write now
                      </Button>
                    )}
                    {r.status !== 'saved' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Keep them at the top of Discover"
                        onClick={async () => {
                          await saveRecommendation(r.id);
                          toast.push({
                            text: `Saved ${p.firstName}. Saved people stay at the top of Discover until you write to them.`,
                          });
                        }}
                      >
                        Save
                      </Button>
                    )}
                    {/* the reasons stay folded away until the student says the person is not a fit */}
                    <details className="group ml-auto text-[12px]">
                      <summary className="list-none cursor-pointer h-8 px-3 rounded-full inline-flex items-center text-ink-3 hover:text-ink hover:bg-canvas-2 transition-colors [&::-webkit-details-marker]:hidden">
                        Not a fit?
                      </summary>
                      <div
                        className="pop-in mt-1.5 flex flex-wrap items-center gap-1"
                        role="group"
                        aria-label="Not a fit? Tell Orbit why"
                      >
                        {(
                          Object.entries(RECOMMENDATION_DISMISS_REASONS) as [
                            RecommendationDismissReason,
                            string,
                          ][]
                        ).map(([k, l]) => (
                          <button
                            key={k}
                            type="button"
                            className="px-2.5 h-7 rounded-full border border-line bg-canvas text-ink-2 hover:text-ink hover:border-[#d4d2ce] transition-colors"
                            onClick={() => drop(r.id, k, l)}
                          >
                            {l}
                          </button>
                        ))}
                      </div>
                    </details>
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

/** A score out of 100 as a short bar: easier to compare down a list of cards than two numbers. */
function ScoreBar({ label, value, title }: { label: string; value: number; title: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div
      title={title}
      role="meter"
      aria-label={label}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="flex items-baseline justify-between text-[11.5px] text-ink-3">
        <span>{label}</span>
        <span className="tabular text-ink-2">{pct}</span>
      </div>
      <div className="mt-1 h-1 rounded-full bg-line-2 overflow-hidden">
        <div
          className={cx(
            'h-full rounded-full',
            pct >= 70 ? 'bg-accent' : pct >= 50 ? 'bg-accent/60' : 'bg-ink-3/40',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
