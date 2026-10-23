import { useLiveQuery } from 'dexie-react-hooks';
import { RefreshCw } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AddPersonButton } from '../components/AddPerson';
import { FindPeople } from '../components/account/FindPeople';
import { LogoText } from '../components/CompanyLogo';
import {
  FoundCardView,
  type FoundHandlers,
  NetworkCardView,
  type NetworkHandlers,
  SuggestedRow,
} from '../components/discover/cards';
import { CardSkeleton, ScoreLegend } from '../components/discover/parts';
import { LinkedInImportButton } from '../components/LinkedInImport';
import { StrengthDots } from '../components/people/shared';
import { db } from '../db/schema';
import { recommendationsRefresh, startWarmUpOrOutreach } from '../engine/brief';
import {
  actOnFound,
  type DiscoverCard,
  discoverView,
  dismissFound,
  type LoadMoreOutcome,
  loadMoreDiscover,
  restoreFound,
} from '../engine/discoverFeed';
import { connectLinkedInLive, liveLinkedInAvailable } from '../engine/linkedinLive';
import { loadPointContext, personPoints, whyThemFor } from '../engine/personPoints';
import {
  dismissRecommendation,
  outreachChannelFor,
  restoreRecommendation,
  saveRecommendation,
  unsaveRecommendation,
} from '../engine/recommend';
import { isServerUser } from '../integrations/orbitApi';
import { useSession } from '../state/session';
import { Avatar, Button, EmptyState, Input, PageHeader, Tabs, useToast } from '../ui';

/**
 * Discover: an endless feed of people worth a coffee chat. New people first (found on LinkedIn by searches built from
 * the student's goals, resume and who they write to), with people already in the network worth reaching now mixed
 * in, and a row of proactive picks at the top. In account mode a second tab, Find people, searches through Orbit's
 * server (plan 16 §6).
 */
export function Discover() {
  const { userId } = useSession();
  const [params, setParams] = useSearchParams();
  if (!userId || !isServerUser(userId)) return <DiscoverFeed />;
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
  if (tab === 'network') return <DiscoverFeed tabs={tabs} />;
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

/** How many network people the page asks the ranker for each time it opens (the feed mixes them in). */
const NETWORK_BATCH = 20;

function DiscoverFeed({ tabs }: { tabs?: ReactNode }) {
  const { user, userId, goals } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // the network list is brought up to date each time the page opens, so someone just added shows up without a Refresh
  const [updating, setUpdating] = useState(true);
  const [q, setQ] = useState('');
  const [acting, setActing] = useState<string>();
  // people acted on or dismissed here leave the page at once: the feed is rebuilt from the database, which can lag a
  // few seconds behind while a LinkedIn sync is writing people
  const [goneHere, setGoneHere] = useState<Set<string>>(() => new Set());
  const goHere = (memberId: string) => setGoneHere((cur) => new Set(cur).add(memberId));
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<LoadMoreOutcome>();
  const [connecting, setConnecting] = useState(false);
  const view = useLiveQuery(() => (user ? discoverView(user) : undefined), [user?.id]);
  const people =
    useLiveQuery(() => (userId ? db.people.where('userId').equals(userId).toArray() : []), [userId]) ?? [];
  const tcCount =
    useLiveQuery(() => (userId ? db.targetCompanies.where('userId').equals(userId).count() : 0), [userId]) ??
    0;
  // people already in a chat are not recommended again; the empty list says so instead of "nobody matches"
  const inPipeline =
    useLiveQuery(() => (userId ? db.chats.where('userId').equals(userId).count() : 0), [userId]) ?? 0;
  useEffect(() => {
    if (!user) return;
    let live = true;
    recommendationsRefresh(user, new Date(), { batchSize: NETWORK_BATCH })
      .catch(() => undefined)
      .finally(() => live && setUpdating(false));
    return () => {
      live = false;
    };
  }, [user?.id]);

  const loadMore = useCallback(async () => {
    if (!user || loading) return;
    setLoading(true);
    try {
      setOutcome(await loadMoreDiscover(user));
    } catch (e) {
      setOutcome({ status: 'error', message: e instanceof Error ? e.message : 'Could not reach LinkedIn.' });
    } finally {
      setLoading(false);
    }
  }, [user, loading]);

  // the first page as soon as LinkedIn is ready, when the feed holds few new people
  const firstLoad = useRef(false);
  useEffect(() => {
    if (!view?.connected || firstLoad.current) return;
    firstLoad.current = true;
    if (view.found.length < 12) void loadMore();
  }, [view?.connected, view?.found.length, loadMore]);

  // the next page when the end of the feed comes into view; a load that found nobody new waits for the button
  const { ref: sentinel, inView } = useInView({ rootMargin: '400px 0px', fallbackInView: false });
  const canAutoLoad =
    !!view?.connected &&
    !loading &&
    (!outcome || (outcome.status === 'ok' && outcome.added > 0)) &&
    !view.exhausted &&
    !view.limitToday &&
    view.searchesLeft > 0;
  useEffect(() => {
    if (inView && canAutoLoad && firstLoad.current) void loadMore();
  }, [inView, canAutoLoad, loadMore]);

  // what each network card says about the person: read once for everyone on the page
  const networkIds = (view?.network ?? []).map((c) => c.person.id).join();
  const pointCtx = useLiveQuery(
    () => (user && networkIds ? loadPointContext(user, networkIds.split(',')) : undefined),
    [user?.id, networkIds],
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

  const start = async (personId: string, opts: { skipWarmUp?: boolean } = {}) => {
    const p = people.find((x) => x.id === personId);
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
  const networkH: NetworkHandlers = {
    onStart: (id, opts) => void start(id, opts),
    onToggleSave: async (card) => {
      const r = card.rec;
      if (r.status === 'saved') {
        await unsaveRecommendation(r.id);
        toast.push({
          text: `Unsaved ${card.person.firstName}.`,
          action: { label: 'Undo', onClick: () => void saveRecommendation(r.id) },
        });
        return;
      }
      await saveRecommendation(r.id);
      toast.push({
        text: `Saved ${card.person.firstName}. Saved people stay at the top of Discover until you write to them.`,
      });
    },
    onDismiss: async (card, reason, label) => {
      await dismissRecommendation(user.id, card.rec.id, reason);
      toast.push({
        text: `Removed (${label.toLowerCase()}). Orbit learns from this for the next list.`,
        action: { label: 'Undo', onClick: () => restoreRecommendation(card.rec.id) },
        ttl: 6000,
      });
    },
  };
  const foundH: FoundHandlers = {
    busy: acting,
    onAct: async (card, action) => {
      setActing(card.id);
      try {
        const first = card.entry.name.split(/\s+/)[0];
        const r = await actOnFound(user, card.entry.memberId, action);
        if (!r.ok) {
          toast.push({ text: r.message, tone: 'bad', ttl: 6000 });
          return;
        }
        goHere(card.entry.memberId);
        if (action === 'write' && r.draftId) nav(`/people/${r.personId}?open=${r.draftId}`);
        else if (action === 'intro') nav(`/map?reach=${r.personId}`);
        else if (action === 'warm_up')
          toast.push({
            text: `Warm-up started for ${first}. The first step is in Drafts.`,
            tone: 'good',
            ttl: 8000,
            action: { label: 'Open in Drafts', onClick: () => nav(`/inbox?person=${r.personId}`) },
          });
        else
          toast.push({
            text: `Saved ${first}. They are with your people, ready to write to.`,
            tone: 'good',
            ttl: 6000,
            action: { label: 'Open', onClick: () => nav(`/people/${r.personId}`) },
          });
      } finally {
        setActing(undefined);
      }
    },
    onDismiss: async (card, reason, label) => {
      await dismissFound(user.id, card.entry.memberId, reason);
      goHere(card.entry.memberId);
      toast.push({
        text: `Removed (${label.toLowerCase()}). Orbit learns from this for the next people it finds.`,
        action: {
          label: 'Undo',
          onClick: () => {
            setGoneHere((cur) => {
              const next = new Set(cur);
              next.delete(card.entry.memberId);
              return next;
            });
            void restoreFound(user.id, card.entry.memberId);
          },
        },
        ttl: 6000,
      });
    },
  };
  const refresh = async () => {
    setBusy(true);
    try {
      await recommendationsRefresh(user, new Date(), { batchSize: NETWORK_BATCH });
      if (view?.connected) await loadMore();
    } finally {
      setBusy(false);
    }
    const shown = await db.recommendations
      .where('userId')
      .equals(user.id)
      .filter((r) => r.status === 'new' || r.status === 'saved')
      .count();
    toast.push({
      text:
        shown || view?.found.length
          ? 'Discover is up to date.'
          : 'Nobody new yet. Add goals or connect LinkedIn.',
      ttl: 5000,
    });
  };
  const connect = async () => {
    setConnecting(true);
    try {
      const r = await connectLinkedInLive(user);
      if (r.ok) {
        toast.push({ text: 'LinkedIn connected. Finding people for you…', tone: 'good' });
        firstLoad.current = false;
      } else toast.push({ text: r.message, tone: r.reason === 'cancelled' ? undefined : 'bad', ttl: 8000 });
    } finally {
      setConnecting(false);
    }
  };

  const humans = people.filter((p) => p.isHuman && !p.hiddenAt).length;
  const missing = { people: humans === 0, goals: !goals?.targetFunctions.length && !tcCount };
  const emptyHint = missing.people
    ? 'Orbit recommends people from your own network, and it is empty so far. Add the people you know of by hand, or import your LinkedIn connections, and recommendations follow.'
    : missing.goals
      ? 'Tell Orbit which functions and companies you are recruiting for, and Discover fills in.'
      : inPipeline
        ? 'Everyone in your network who fits your goals already has a chat with you on the People board. Connect LinkedIn to find people beyond it.'
        : 'Nobody in your network matches your goals yet. Add people at your target companies or connect LinkedIn.';
  const shownHere = (c: DiscoverCard) => c.kind !== 'found' || !goneHere.has(c.entry.memberId);
  const feed: DiscoverCard[] = (view?.feed ?? []).filter(shownHere);
  const suggestions = (view?.suggestions ?? []).filter(shownHere);
  const nothing = !!view && !feed.length && !suggestions.length;
  const server = isServerUser(user.id);
  return (
    <div>
      <PageHeader
        title="Discover"
        subtitle="People worth a coffee chat: new people who fit your goals and the people you write to, and people you already know worth reaching now."
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
        {humans > 1 && (
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
                <LogoText person={p} className="text-[12px] text-ink-3">
                  {p.currentTitle ?? p.currentOrganizationRaw}
                </LogoText>
              </div>
              <StrengthDots v={p.strength} />
              <Button size="sm" variant="primary" onClick={() => start(p.id)}>
                Start
              </Button>
            </div>
          ))}
        </div>
      )}
      {view && !view.connected && !server && (
        <ConnectPrompt available={liveLinkedInAvailable(user)} busy={connecting} onConnect={connect} />
      )}
      {view && <SuggestedRow cards={suggestions} found={foundH} network={networkH} />}
      {!view || (nothing && (updating || loading)) ? (
        <div>
          {!view || updating ? (
            <p className="text-[13px] text-ink-3 mb-3" data-testid="discover-updating">
              Checking your network…
            </p>
          ) : null}
          <div className="grid @3xl:grid-cols-2 @7xl:grid-cols-3 gap-3">
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </div>
        </div>
      ) : nothing && !view.connected ? (
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
        <section aria-labelledby="discover-feed-h">
          <h2 id="discover-feed-h" className="sr-only">
            People to meet
          </h2>
          <ScoreLegend />
          <div
            role="feed"
            aria-busy={loading}
            data-testid="discover-feed"
            className="stagger grid @3xl:grid-cols-2 @7xl:grid-cols-3 @[104rem]:grid-cols-4 gap-3 [&>*]:min-w-0"
          >
            {feed.map((c) =>
              c.kind === 'found' ? (
                <FoundCardView key={c.id} card={c} h={foundH} />
              ) : (
                <NetworkCardView
                  key={c.id}
                  card={c}
                  h={networkH}
                  why={
                    pointCtx
                      ? whyThemFor(
                          c.person,
                          c.rec,
                          { ...pointCtx, dossier: pointCtx.dossiers.get(c.person.id) },
                          c.introducer,
                        )
                      : undefined
                  }
                  points={
                    pointCtx
                      ? personPoints(c.person, c.rec, {
                          ...pointCtx,
                          dossier: pointCtx.dossiers.get(c.person.id),
                        })
                      : undefined
                  }
                />
              ),
            )}
            {loading && view.connected && (
              <>
                <CardSkeleton />
                <CardSkeleton />
              </>
            )}
          </div>
          <div ref={sentinel} className="h-px" aria-hidden />
          <FeedFooter
            connected={view.connected}
            loading={loading}
            outcome={outcome}
            exhausted={view.exhausted}
            limitToday={view.limitToday}
            searchesLeft={view.searchesLeft}
            hasQueries={view.hasQueries}
            onMore={loadMore}
          />
        </section>
      )}
    </div>
  );
}

/** LinkedIn is not connected live here: say what connecting adds, and connect in place. */
function ConnectPrompt({
  available,
  busy,
  onConnect,
}: {
  available: boolean;
  busy: boolean;
  onConnect: () => void;
}) {
  return (
    <div
      className="mb-6 border border-line bg-canvas rounded-[var(--radius-card)] p-4 flex flex-col @[40rem]:flex-row @[40rem]:items-center gap-3"
      data-testid="discover-connect"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium text-[14.5px]">See people beyond your network</p>
        <p className="text-[13px] text-ink-3 mt-0.5">
          {available
            ? 'Connect your LinkedIn and Orbit finds new people who fit your goals and the people you write to, with mutual connections and alumni first. Nobody is added until you choose them.'
            : 'Live LinkedIn is not switched on in this copy of Orbit yet. Until then, Discover ranks the people you already have.'}
        </p>
      </div>
      {available && (
        <Button variant="primary" onClick={onConnect} disabled={busy} data-testid="discover-connect-button">
          {busy ? 'Connecting…' : 'Connect LinkedIn'}
        </Button>
      )}
    </div>
  );
}

/** The end of the feed: more on request, or why there is no more today. */
function FeedFooter({
  connected,
  loading,
  outcome,
  exhausted,
  limitToday,
  searchesLeft,
  hasQueries,
  onMore,
}: {
  connected: boolean;
  loading: boolean;
  outcome?: LoadMoreOutcome;
  exhausted: boolean;
  limitToday: boolean;
  searchesLeft: number;
  hasQueries: boolean;
  onMore: () => void;
}) {
  if (!connected) return null;
  const line = (text: string, testId: string, action?: ReactNode) => (
    <div className="mt-6 flex flex-col items-center gap-2 text-center" data-testid={testId}>
      {text && <p className="text-[13px] text-ink-3 max-w-md">{text}</p>}
      {action}
    </div>
  );
  if (loading) return line('Finding more people…', 'discover-loading');
  if (!hasQueries || outcome?.status === 'no_queries')
    return line(
      'Tell Orbit the roles and companies you are recruiting for, and it finds people who fit.',
      'discover-no-goals',
      <Link to="/settings/goals">
        <Button size="sm">Set your goals</Button>
      </Link>,
    );
  if (limitToday || outcome?.status === 'limit')
    return line('LinkedIn searches are used up for today. More people tomorrow.', 'discover-limit');
  if (searchesLeft <= 0 || outcome?.status === 'budget')
    return line("That's today's new people. More tomorrow.", 'discover-tomorrow');
  if (exhausted || outcome?.status === 'exhausted')
    return line(
      "That's everyone Orbit found for your goals. Add target companies or roles for more.",
      'discover-exhausted',
    );
  if (outcome?.status === 'error')
    return line(
      `Could not load more people: ${outcome.message}`,
      'discover-error',
      <Button size="sm" onClick={onMore}>
        Try again
      </Button>,
    );
  return line(
    outcome?.status === 'ok' && outcome.added === 0 ? 'No one new on that page.' : '',
    'discover-more',
    <Button size="sm" onClick={onMore} data-testid="discover-load-more">
      Load more people
    </Button>,
  );
}
