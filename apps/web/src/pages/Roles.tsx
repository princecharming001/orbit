/**
 * Plan 44, Roles for you: the tab. The student's profile is read from their resume or LinkedIn and corrected by them;
 * Orbit lists open roles that fit with a score out of 10, the reasons and the gaps, and who the student knows at each
 * company; one tap turns a role into a target with the plan of who to reach.
 *
 * Plan 45: a small recruiting workspace with the way in first. Tabs For you, Saved, Applied, Companies; a search box
 * and filters (the way in among them); the roles as cards beside the one open (a drawer on a narrow screen), ranked
 * by the fit plus who the student knows there. The page keeps its view, filters and place while the student is away
 * (state/viewState), and the matches themselves in the browser's database, so a reload or an offline visit shows the
 * last ones.
 */
import {
  type DismissReason,
  type MatchStatus,
  normalizeCompany,
  type RoleMatch,
  type User,
} from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { RefreshCw, UserRound } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CompaniesView, companyGroups } from '../components/roles/CompaniesView';
import { openProfileReview, ProfileSetup } from '../components/roles/ProfileSetup';
import { RoleCards, RoleCardsSkeleton } from '../components/roles/RoleCards';
import { RoleFiltersBar } from '../components/roles/RoleFilters';
import { RolePanel } from '../components/roles/RolePanel';
import { RolesCoverage } from '../components/roles/RolesCoverage';
import { db } from '../db/schema';
import { useFeature } from '../engine/features';
import {
  actOnMatch,
  bestStretches,
  DEFAULT_FILTERS,
  filterMatches,
  findWayIn,
  keptMatches,
  keptProfile,
  keptSearch,
  PROFILE_LEVEL_WORDS,
  pathOf,
  pathsFor,
  proposedProfile,
  type RoleFilters,
  type RoleIntro,
  type RolesRun,
  RUN_KEY,
  readWhen,
  refreshMatches,
  roleOpened,
  rolesMode,
  runSearch,
  savedMatches,
  searchRunning,
  sortMatches,
  syncProfile,
  tableMatches,
  watchCompany,
  watching as watchingOf,
  whereTheyAre,
} from '../engine/roles';
import { introsFor } from '../engine/rolesWayIn';
import { planForPosting } from '../engine/targetPlan';
import { useSession } from '../state/session';
import { useViewState } from '../state/viewState';
import { Button, Drawer, EmptyState, PageHeader, SkeletonRows, Tabs, useToast, useWorking } from '../ui';

type View = 'roles' | 'saved' | 'applied' | 'companies';

/** What the page keeps while the student is away: the view, the filters, the card the keyboard is on. */
interface RolesPlace {
  view: View;
  filters: RoleFilters;
  active?: string;
  editing: boolean;
}
const PLACE: RolesPlace = { view: 'roles', filters: DEFAULT_FILTERS, editing: false };

export function RolesPage() {
  const { user, userId } = useSession();
  const on = useFeature('roles', userId);
  if (!user) return null;
  if (!on || rolesMode(user.id) === 'off')
    return (
      <div data-testid="roles-off">
        <EmptyState
          title="Roles is not on for you yet"
          body="Roles needs an Orbit account, and Orbit turns it on for everyone at once. Nothing to do until then."
        />
      </div>
    );
  return <RolesBody user={user} />;
}

/** Wide enough for the list and the open posting side by side (plan 45 §4.4); a drawer below this. */
const WIDE = '(min-width: 1100px)';
function useWide(): boolean {
  const query = () => typeof window !== 'undefined' && !!window.matchMedia?.(WIDE).matches;
  const [wide, setWide] = useState(query);
  useEffect(() => {
    const mq = window.matchMedia?.(WIDE);
    if (!mq) return;
    const on = () => setWide(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return wide;
}

/** "Student, Data Science, Berkeley": the profile in a few words for the button that opens it. */
function profileShort(p: { level: string; field?: string; school?: string }): string {
  const school = p.school
    ?.replace(/^University of California,\s*/i, 'UC ')
    .replace(/\bUniversity\b/i, '')
    .trim();
  return [PROFILE_LEVEL_WORDS[p.level as keyof typeof PROFILE_LEVEL_WORDS], p.field, school]
    .filter(Boolean)
    .join(', ');
}

function RolesBody({ user }: { user: User }) {
  const userId = user.id;
  const nav = useNavigate();
  const toast = useToast();
  const working = useWorking();
  const wide = useWide();
  const [params, setParams] = useSearchParams();
  const [place, setPlace] = useViewState<RolesPlace>(`roles:place:${userId}`, PLACE);
  const set = (part: Partial<RolesPlace>) => setPlace((p) => ({ ...p, ...part }));
  const [run] = useViewState<RolesRun>(RUN_KEY(userId), { phase: 'idle', run: 0 });
  const [busy, setBusy] = useState<string>();
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  );
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  // null: looked and there is none; undefined: still reading
  const kept = useLiveQuery(async () => (await keptProfile(userId)) ?? null, [userId]);
  const search = useLiveQuery(async () => (await keptSearch(userId)) ?? null, [userId]);
  const rows = useLiveQuery(() => keptMatches(userId), [userId]);
  const targets =
    useLiveQuery(() => db.targetCompanies.where('userId').equals(userId).toArray(), [userId]) ?? [];
  const watchList = useLiveQuery(() => watchingOf(userId), [userId]) ?? [];

  // a new browser, or another device built the profile: the server's copy, once a visit
  const synced = useRef(false);
  useEffect(() => {
    if (kept === null && !synced.current) {
      synced.current = true;
      // no confirmed profile on the server either, but one Orbit already read: the review screen opens on it
      void syncProfile(user).then((k) => {
        const proposed = k ? undefined : proposedProfile(userId);
        if (proposed) openProfileReview(userId, proposed);
      });
    }
  }, [kept, user]);

  // on arriving: a search left half read carries on; a finished one is brought up to date (free)
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !kept || search === undefined || place.editing) return;
    started.current = true;
    if (searchRunning(userId)) return;
    if (!search) void runSearch(user);
    else if (!search.done) void runSearch(user, { resume: true });
    else if (online) void refreshMatches(user);
  }, [kept, search, user, userId, online, place.editing]);

  const table = useMemo(() => tableMatches(rows ?? [], search ?? undefined), [rows, search]);
  const saved = useMemo(() => savedMatches(rows ?? []), [rows]);
  const savedOnly = useMemo(() => saved.filter((m) => m.status === 'saved'), [saved]);
  const applied = useMemo(() => saved.filter((m) => m.status !== 'saved'), [saved]);
  const companies = useMemo(
    () => [
      ...new Set([
        ...table.map((m) => m.job.companyName),
        ...saved.map((m) => m.job.companyName),
        ...targets.map((t) => t.nameRaw),
        ...watchList,
      ]),
    ],
    [table, saved, targets, watchList],
  );
  const companiesKey = companies.map((c) => normalizeCompany(c)).join('|');
  const paths = useLiveQuery(() => pathsFor(userId, companies), [userId, companiesKey]);
  // intros through friends, read in the background for the companies listed, best fits first (plan 45 §3)
  const [intros, setIntros] = useState<Map<string, RoleIntro[]>>(() => new Map());
  const introOrder = useMemo(
    () => sortMatches(table, 'fit').map((m) => m.job.companyName),
    // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the companies change, not each row
    [companiesKey],
  );
  useEffect(() => {
    let live = true;
    void introsFor(userId, introOrder, (k, got) => {
      if (live && got.length) setIntros((m) => new Map(m).set(k, got));
    });
    return () => {
      live = false;
    };
  }, [userId, introOrder]);
  const kinds = kept?.profile.kinds.filter((k) => k.on) ?? [];
  const ways = useMemo(() => ({ paths, intros }), [paths, intros]);
  const filtered = useMemo(
    () => sortMatches(filterMatches(table, place.filters, kinds, ways), place.filters.sort, paths, intros),
    [table, place.filters, kinds, ways, paths, intros],
  );
  const running = run.phase === 'running';
  const scoredStrong = table.some((m) => (m.fit?.score ?? 0) >= 6);
  const stretches = useMemo(
    () => (search?.done && !running && !scoredStrong && table.some((m) => m.fit) ? bestStretches(table) : []),
    [search?.done, running, scoredStrong, table],
  );
  const stretchIds = useMemo(() => new Set(stretches.map((m) => m.id)), [stretches]);
  const levels = useMemo(
    () => [...new Set(table.map((m) => m.job.level).filter((l): l is NonNullable<typeof l> => !!l))],
    [table],
  );
  const places = useMemo(() => {
    const n = new Map<string, number>();
    for (const m of table)
      for (const p of m.job.places) {
        const city = p.replace(/,\s*[A-Z]{2}$/, '').trim();
        if (city && !/^remote/i.test(city)) n.set(city, (n.get(city) ?? 0) + 1);
      }
    return [...n.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([c]) => c)
      .slice(0, 12);
  }, [table]);
  const groups = useMemo(
    () => companyGroups(table, paths, targets, watchList, place.filters.minFit),
    [table, paths, targets, watchList, place.filters.minFit],
  );

  // the cards the open tab lists
  const listed =
    place.view === 'saved'
      ? sortMatches(savedOnly, 'newest')
      : place.view === 'applied'
        ? sortMatches(applied, 'newest')
        : filtered.length
          ? filtered
          : stretches.length && place.filters.minFit >= 6
            ? stretches
            : [];

  // the role open beside the list: from the address (a chat card's row, a link), a click here, or on a wide screen
  // the first one listed
  const openId = params.get('role') ?? undefined;
  const fromAddress = openId ? rows?.find((r) => r.match.id === openId)?.match : undefined;
  const opened =
    fromAddress ??
    (wide && place.view !== 'companies'
      ? (listed.find((m) => m.id === place.active) ?? listed[0])
      : undefined);
  const open = (m: RoleMatch) => {
    roleOpened(userId, m);
    set({ active: m.id });
    const next = new URLSearchParams(params);
    next.set('role', m.id);
    setParams(next, { replace: !!openId });
  };
  const close = () => {
    const next = new URLSearchParams(params);
    next.delete('role');
    setParams(next, { replace: true });
  };
  useEffect(() => {
    const v = params.get('view');
    if (v === 'saved' || v === 'companies' || v === 'roles' || v === 'applied') set({ view: v });
  }, [params.get('view')]);

  const act = async (m: RoleMatch, status: MatchStatus, reason?: DismissReason) => {
    setBusy(m.id);
    try {
      const r = await actOnMatch(user, m, status, reason);
      if (!r.ok) {
        toast.push({ text: r.message, tone: 'bad' });
        return;
      }
      if (status === 'saved' && m.status === 'new')
        toast.push({ text: `Saved ${m.job.title} at ${m.job.companyName}.`, tone: 'good' });
      if (status === 'applied') toast.push({ text: `Marked applied. It is in Applied.`, tone: 'good' });
      if (status === 'dismissed')
        toast.push({
          text: `${m.job.title} at ${m.job.companyName} is hidden.`,
          action: {
            label: 'Undo',
            onClick: () => void actOnMatch(user, { ...m, status: 'dismissed' }, 'new'),
          },
        });
    } finally {
      setBusy(undefined);
    }
  };
  const toggleSave = (m: RoleMatch) => void act(m, m.status === 'new' ? 'saved' : 'new');
  const dismiss = (m: RoleMatch, reason: DismissReason) => {
    if (openId === m.id) close();
    void act(m, 'dismissed', reason);
  };
  const wayIn = (m: RoleMatch) =>
    working.run(`way:${m.id}`, `Planning your way into ${m.job.companyName}…`, async () => {
      const r = await findWayIn(user, m);
      toast.push({
        text: r.added
          ? `${m.job.companyName} is a target now, with your plan for ${m.job.title}.`
          : `Your plan for ${m.job.title} at ${m.job.companyName}.`,
        tone: 'good',
        sticky: true,
      });
      if (r.orgId) nav(`/companies/${r.orgId}?plan=${encodeURIComponent(r.plan.id)}`);
    });
  const companyWayIn = (company: string, m?: RoleMatch) => {
    if (m) return void wayIn(m);
    void working.run(`co:${normalizeCompany(company)}`, `Planning your way into ${company}…`, async () => {
      const plan = await planForPosting(user, { company, role: '' });
      const t = await db.targetCompanies.get(plan.targetCompanyId);
      toast.push({ text: `${company} is a target now.`, tone: 'good', sticky: true });
      if (t?.organizationId) nav(`/companies/${t.organizationId}?plan=${encodeURIComponent(plan.id)}`);
    });
  };
  const watch = async (name: string, on: boolean) => {
    const r = await watchCompany(user, name, on);
    if (!r.ok) toast.push({ text: r.message ?? 'That did not work. Try again.', tone: 'bad' });
    else if (on)
      toast.push({ text: `Watching ${name}. Orbit tells you when a role there fits.`, tone: 'good' });
  };

  if (kept === undefined)
    return (
      <div data-testid="roles-loading">
        <PageHeader title="Roles" />
        <SkeletonRows rows={6} divided />
      </div>
    );
  if (kept === null || place.editing)
    return (
      <div data-testid="roles-page">
        <PageHeader title="Roles" />
        <ProfileSetup
          user={user}
          kept={kept ?? undefined}
          onDone={() => {
            started.current = true;
            set({ editing: false, view: 'roles' });
          }}
          onCancel={kept ? () => set({ editing: false }) : undefined}
        />
      </div>
    );

  const total = search?.listed ?? 0;
  const read = search?.read ?? 0;
  const noneRead = running && table.length === 0;
  const panel = (m: RoleMatch, heading: boolean) => (
    <RolePanel
      key={m.id}
      match={m}
      user={user}
      heading={heading}
      path={pathOf(paths, m.job.companyName)}
      paths={paths}
      intros={intros.get(normalizeCompany(m.job.companyName))}
      sources={kept.profile.sources}
      onSave={() => toggleSave(m)}
      onStatus={(s) => void act(m, s)}
      onDismiss={(r) => dismiss(m, r)}
      onWayIn={() => void wayIn(m)}
      wayInBusy={working.busy === `way:${m.id}`}
    />
  );
  const empty =
    place.view === 'saved' ? (
      <div data-testid="roles-saved-empty">
        <EmptyState title="Nothing saved yet" body="Save a role and it waits here." />
      </div>
    ) : place.view === 'applied' ? (
      <div data-testid="roles-applied-empty">
        <EmptyState title="Nothing applied to yet" body="Press Apply on a role, then say you applied." />
      </div>
    ) : table.length ? (
      <div data-testid="roles-filtered-empty">
        <EmptyState
          title="No roles match"
          action={
            <Button onClick={() => set({ filters: { ...DEFAULT_FILTERS, sort: place.filters.sort } })}>
              Clear the filters
            </Button>
          }
        />
      </div>
    ) : !running && search?.done ? (
      <div data-testid="roles-empty">
        <EmptyState
          title="No open roles for this profile yet"
          body="Tick more kinds of role or add a place. Orbit reads new roles every night."
          action={<Button onClick={() => set({ editing: true })}>Edit your profile</Button>}
        />
      </div>
    ) : null;
  const cards = noneRead ? (
    <RoleCardsSkeleton />
  ) : listed.length ? (
    <RoleCards
      rows={listed}
      paths={paths}
      intros={intros}
      active={opened?.id ?? place.active}
      stretch={stretchIds}
      busy={busy}
      onActive={(id) => {
        const m = listed.find((r) => r.id === id);
        if (wide && m) open(m);
        else set({ active: id });
      }}
      onOpen={open}
      onSave={toggleSave}
      onDismiss={dismiss}
    />
  ) : (
    empty
  );
  return (
    <div data-testid="roles-page">
      <div className="mb-5 flex items-center justify-between gap-3">
        <h1 className="text-[26px] font-normal leading-[1.1] tracking-[-0.025em] sm:text-[30px]">Roles</h1>
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => set({ editing: true })}
            className="inline-flex h-9 min-w-0 items-center gap-2 rounded-full border border-line bg-canvas px-3.5 text-[13px] text-ink-2 hover:bg-canvas-2 hover:text-ink"
            title={whereTheyAre(kept.profile)}
            data-testid="roles-edit-profile"
          >
            <UserRound size={14} className="shrink-0 text-ink-3" aria-hidden />
            <span className="truncate" data-testid="roles-profile-line">
              {profileShort(kept.profile)}
            </span>
          </button>
          <button
            type="button"
            onClick={() => void runSearch(user, { fresh: true })}
            disabled={running || !online}
            title="Search again"
            aria-label="Search again"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-canvas text-ink-2 hover:bg-canvas-2 hover:text-ink disabled:opacity-50"
            data-testid="roles-search-again"
          >
            <RefreshCw size={14} className={running ? 'animate-spin' : undefined} aria-hidden />
          </button>
        </div>
      </div>
      <Tabs<View>
        value={place.view}
        onChange={(v) => set({ view: v })}
        items={[
          { value: 'roles', label: 'For you', count: table.length },
          { value: 'saved', label: 'Saved', count: savedOnly.length },
          { value: 'applied', label: 'Applied', count: applied.length },
          { value: 'companies', label: 'Companies', count: groups.open.length },
        ]}
      />

      {(kept.note || search?.note || (run.error && !running) || (!online && search?.at)) && (
        <div className="mb-3 space-y-1 text-[13px]">
          {kept.note && (
            <p className="text-ink-2" data-testid="roles-note-linkedin">
              {kept.note}
            </p>
          )}
          {search?.note && (
            <p className="text-ink-2" data-testid="roles-note-model">
              {search.note}
              {table.some((m) => !m.fit) ? ' Rows marked "Not read closely yet" have no score.' : ''}
            </p>
          )}
          {!online && search?.at && (
            <p className="text-ink-2" data-testid="roles-read-when">
              You are offline. These are the roles Orbit read before: {readWhen(search.at).toLowerCase()}.
            </p>
          )}
          {run.error && !running && (
            <p className="text-bad" role="alert" data-testid="roles-error">
              {run.offline
                ? 'Orbit could not be reached, so the search is paused. It carries on when you are back online.'
                : run.error}
            </p>
          )}
        </div>
      )}

      {place.view === 'roles' && table.length > 0 && (
        <div className="mb-4">
          <RoleFiltersBar
            filters={place.filters}
            onChange={(filters) => set({ filters })}
            kinds={kinds}
            levels={levels}
            places={places}
          />
        </div>
      )}

      {place.view === 'companies' ? (
        groups.open.length + groups.none.length ? (
          <CompaniesView
            open={groups.open}
            none={groups.none}
            paths={paths}
            watching={watchList}
            onOpen={open}
            onWatch={(n, on) => void watch(n, on)}
            onWayIn={companyWayIn}
            busy={working.busy?.startsWith('co:') ? working.busy.slice(3) : undefined}
          />
        ) : (
          <EmptyState title="No companies yet" body="Companies show here as roles are read." />
        )
      ) : (
        <>
          {place.view === 'roles' && running && (
            <div className="mb-3" aria-live="polite" data-testid="roles-reading">
              <div className="flex items-center justify-between text-[12.5px] text-ink-2">
                <span>
                  {total ? `Reading ${total} roles against your profile` : 'Finding roles that fit you'}
                </span>
                {total > 0 && (
                  <span className="tabular-nums text-ink-3">
                    {read} of {total} read
                  </span>
                )}
              </div>
              <span className="mt-1.5 block h-[3px] overflow-hidden rounded-full bg-line-2">
                <span
                  className="block h-full rounded-full bg-accent transition-[width] duration-500"
                  style={{ width: `${total ? Math.max(4, Math.round((read / total) * 100)) : 8}%` }}
                />
              </span>
            </div>
          )}
          {place.view === 'roles' &&
            stretches.length > 0 &&
            !filtered.length &&
            place.filters.minFit >= 6 && (
              <p className="mb-3 text-[13.5px]" data-testid="roles-no-strong">
                <span className="font-medium">No strong fits yet.</span>{' '}
                <span className="text-ink-2">The best five, as stretches.</span>{' '}
                <button
                  type="button"
                  className="text-ink-2 underline decoration-line underline-offset-4 hover:text-ink"
                  onClick={() => set({ editing: true })}
                >
                  Widen your profile
                </button>
              </p>
            )}
          {wide && listed.length > 0 ? (
            <div
              className="grid h-[calc(100dvh-260px)] min-h-[560px] grid-cols-[minmax(340px,420px)_minmax(0,1fr)] overflow-hidden rounded-[14px] border border-line bg-canvas"
              data-testid="roles-split"
            >
              <div className="min-h-0 overflow-y-auto border-r border-line-2">{cards}</div>
              <div className="min-h-0 overflow-y-auto px-7 py-6" data-testid="roles-open">
                {opened && panel(opened, true)}
              </div>
            </div>
          ) : listed.length > 0 ? (
            <div className="overflow-hidden rounded-[14px] border border-line bg-canvas">{cards}</div>
          ) : (
            cards
          )}
          {place.view === 'roles' && (
            <div className="mt-4 space-y-1">
              <RolesCoverage userId={userId} coverage={search?.coverage} onScored={open} />
              {online && search?.at && !running && (
                <p className="text-[12.5px] text-ink-3" data-testid="roles-read-when">
                  {readWhen(search.at)}.
                </p>
              )}
            </div>
          )}
        </>
      )}

      {!wide && (
        <Drawer
          open={!!opened}
          onClose={close}
          title={opened ? `${opened.job.title}` : ''}
          width={560}
          testId="role-drawer"
        >
          {opened && panel(opened, false)}
        </Drawer>
      )}
    </div>
  );
}
