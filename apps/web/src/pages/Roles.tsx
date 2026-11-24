/**
 * Plan 44, Roles for you: the tab. The student's profile is read from their resume or LinkedIn and corrected by them;
 * Orbit lists open roles that fit with a score out of 10, the reasons and the gaps, and who the student knows at each
 * company; one tap turns a role into a target with the plan of who to reach.
 *
 * Three views of the same matches: Roles (one table, best fit first), Companies (grouped, with companies that have
 * nothing open), Saved. The page keeps its view, filters and place while the student is away (state/viewState), and
 * the matches themselves in the browser's database, so a reload or an offline visit shows the last ones.
 */
import {
  type DismissReason,
  type MatchStatus,
  normalizeCompany,
  type RoleMatch,
  type User,
} from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CompaniesView, companyGroups } from '../components/roles/CompaniesView';
import { ProfileSetup } from '../components/roles/ProfileSetup';
import { RoleFiltersBar } from '../components/roles/RoleFilters';
import { RolePanel } from '../components/roles/RolePanel';
import { RolesCoverage } from '../components/roles/RolesCoverage';
import { RolesTable, RolesTableSkeleton } from '../components/roles/RolesTable';
import { SavedView } from '../components/roles/SavedView';
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
  pathOf,
  pathsFor,
  type RoleFilters,
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
import { planForPosting } from '../engine/targetPlan';
import { useSession } from '../state/session';
import { useViewState } from '../state/viewState';
import {
  Button,
  Drawer,
  EmptyState,
  PageHeader,
  SkeletonRows,
  Spinner,
  Tabs,
  useToast,
  useWorking,
} from '../ui';

type View = 'roles' | 'companies' | 'saved';

/** What the page keeps while the student is away: the view, the filters, the picks, the row the keyboard is on. */
interface RolesPlace {
  view: View;
  filters: RoleFilters;
  picked: Set<string>;
  active?: string;
  editing: boolean;
}
const PLACE: RolesPlace = { view: 'roles', filters: DEFAULT_FILTERS, picked: new Set(), editing: false };

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

function RolesBody({ user }: { user: User }) {
  const userId = user.id;
  const nav = useNavigate();
  const toast = useToast();
  const working = useWorking();
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
      void syncProfile(user);
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
  const kinds = kept?.profile.kinds.filter((k) => k.on) ?? [];
  const filtered = useMemo(
    () => sortMatches(filterMatches(table, place.filters, kinds), place.filters.sort, paths),
    [table, place.filters, kinds, paths],
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

  // the role opened in the panel: from the address (a chat card's row, a link), or a click here
  const openId = params.get('role') ?? undefined;
  const opened = openId ? rows?.find((r) => r.match.id === openId)?.match : undefined;
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
    if (v === 'saved' || v === 'companies' || v === 'roles') set({ view: v });
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
        toast.push({ text: `Saved ${m.job.title} at ${m.job.companyName}. It is in Saved.`, tone: 'good' });
      if (status === 'dismissed')
        toast.push({
          text: `${m.job.title} at ${m.job.companyName} is hidden. Orbit uses why for later roles.`,
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

  // the range a Shift pick starts from: the last row picked or unpicked by a plain click
  const anchor = useRef<string | undefined>(undefined);
  const pick = (id: string, on: boolean, range: boolean) => {
    const list = place.view === 'roles' ? (stretches.length && !filtered.length ? stretches : filtered) : [];
    const from = range && anchor.current ? list.findIndex((r) => r.id === anchor.current) : -1;
    const to = list.findIndex((r) => r.id === id);
    setPlace((p) => {
      const next = new Set(p.picked);
      const span =
        from >= 0 && to >= 0 ? list.slice(Math.min(from, to), Math.max(from, to) + 1) : [list[to]!];
      for (const r of span) {
        if (!r) continue;
        if (on) next.add(r.id);
        else next.delete(r.id);
      }
      return { ...p, picked: next };
    });
    anchor.current = id;
  };
  const pickedRows = filtered.filter((m) => place.picked.has(m.id));
  const many = async (status: MatchStatus, reason?: DismissReason) => {
    for (const m of pickedRows) await actOnMatch(user, m, status, reason);
    set({ picked: new Set() });
    anchor.current = undefined;
    toast.push({
      text:
        status === 'saved'
          ? `Saved ${pickedRows.length} ${pickedRows.length === 1 ? 'role' : 'roles'}.`
          : `${pickedRows.length} ${pickedRows.length === 1 ? 'role is' : 'roles are'} hidden.`,
      tone: 'good',
    });
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
        <PageHeader
          title="Roles"
          subtitle="Open roles that fit what you have done, with a score out of 10 and who you know at each company."
        />
        <ProfileSetup
          user={user}
          kept={kept ?? undefined}
          onDone={() => {
            started.current = true;
            set({ editing: false, view: 'roles', picked: new Set() });
          }}
          onCancel={kept ? () => set({ editing: false }) : undefined}
        />
      </div>
    );

  const listed = search?.listed ?? 0;
  const read = search?.read ?? 0;
  const noneRead = running && table.length === 0;
  const tableRows = filtered.length
    ? filtered
    : stretches.length && place.filters.minFit >= 6
      ? stretches
      : [];
  return (
    <div data-testid="roles-page">
      <PageHeader
        title="Roles"
        subtitle={
          <span data-testid="roles-profile-line">
            {whereTheyAre(kept.profile)}.{' '}
            <button
              type="button"
              onClick={() => set({ editing: true })}
              className="underline decoration-line underline-offset-4 hover:text-ink hover:decoration-ink"
              data-testid="roles-edit-profile"
            >
              Edit what Orbit read
            </button>
          </span>
        }
        actions={
          <Button
            onClick={() => void runSearch(user, { fresh: true })}
            disabled={running || !online}
            title="Search again for roles that fit"
            data-testid="roles-search-again"
          >
            <RefreshCw size={14} aria-hidden /> Search again
          </Button>
        }
      />
      <Tabs<View>
        value={place.view}
        onChange={(v) => set({ view: v })}
        items={[
          { value: 'roles', label: 'Roles', count: table.length },
          { value: 'companies', label: 'Companies', count: groups.open.length },
          { value: 'saved', label: 'Saved', count: saved.length },
        ]}
      />
      <div className="mb-3 space-y-1.5">
        <RolesCoverage userId={userId} coverage={search?.coverage} onScored={open} />
        {search?.at && !running && (
          <p className="text-[12.5px] text-ink-3" data-testid="roles-read-when">
            {online
              ? `${readWhen(search.at)}.`
              : `You are offline. These are the roles Orbit read before: ${readWhen(search.at).toLowerCase()}.`}
          </p>
        )}
        {kept.note && (
          <p className="text-[12.5px] text-ink-2" data-testid="roles-note-linkedin">
            {kept.note}
          </p>
        )}
        {search?.note && (
          <p className="text-[12.5px] text-ink-2" data-testid="roles-note-model">
            {search.note} Rows marked "Not read closely yet" have no score.
          </p>
        )}
        {run.error && !running && (
          <p className="text-[12.5px] text-bad" role="alert" data-testid="roles-error">
            {run.offline
              ? 'Orbit could not be reached, so the search is paused. It carries on when you are back online.'
              : run.error}
          </p>
        )}
      </div>

      {place.view === 'roles' && (
        <>
          {running && (
            <p
              className="mb-3 flex items-center gap-2 text-[13px] text-ink-2"
              aria-live="polite"
              data-testid="roles-reading"
            >
              <Spinner />
              {listed
                ? `Reading ${listed} roles against your profile`
                : 'Finding roles that fit your profile'}
              {listed > 0 && (
                <span className="text-ink-3 tabular-nums">
                  {read} of {listed} read
                </span>
              )}
            </p>
          )}
          {table.length > 0 && (
            <div className="mb-3">
              <RoleFiltersBar
                filters={place.filters}
                onChange={(filters) => set({ filters, picked: new Set() })}
                kinds={kinds}
                levels={levels}
                places={places}
              />
            </div>
          )}
          {pickedRows.length > 0 && (
            <div className="mb-2 flex items-center gap-2 text-[13px] text-ink-3" data-testid="roles-picked">
              <span className="tabular-nums">{pickedRows.length} picked</span>
              <Button size="sm" onClick={() => void many('saved')} data-testid="roles-save-picked">
                Save {pickedRows.length}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void many('dismissed', 'other')}
                data-testid="roles-dismiss-picked"
              >
                Not for me
              </Button>
              <button
                type="button"
                className="rounded px-1 underline decoration-line underline-offset-4 hover:text-ink"
                onClick={() => {
                  set({ picked: new Set() });
                  anchor.current = undefined;
                }}
              >
                Clear
              </button>
            </div>
          )}
          {stretches.length > 0 && !filtered.length && place.filters.minFit >= 6 && (
            <div className="mb-3" data-testid="roles-no-strong">
              <p className="text-[15px] font-medium">No strong fits yet</p>
              <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-ink-3">
                Nothing scored 6 or more. Here are the best five anyway, as stretches. To find closer fits,
                tick more kinds of role or add a place in{' '}
                <button
                  type="button"
                  className="underline underline-offset-4 hover:text-ink"
                  onClick={() => set({ editing: true })}
                >
                  what Orbit read
                </button>
                .
              </p>
            </div>
          )}
          {noneRead ? (
            <RolesTableSkeleton />
          ) : tableRows.length ? (
            <RolesTable
              rows={tableRows}
              paths={paths}
              picked={place.picked}
              onPick={pick}
              onPickAll={(on) => {
                set({ picked: on ? new Set(tableRows.map((r) => r.id)) : new Set() });
                anchor.current = undefined;
              }}
              active={place.active}
              onActive={(id) => set({ active: id })}
              onOpen={open}
              onSave={toggleSave}
              onDismiss={dismiss}
              stretch={stretchIds}
              busy={busy}
            />
          ) : table.length ? (
            <div data-testid="roles-filtered-empty">
              <EmptyState
                title="No roles match these filters"
                body="Widen the level or the place, or show a lower fit."
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
                body="Tick more kinds of role, widen the levels, or add a place. Orbit also reads new roles every night."
                action={<Button onClick={() => set({ editing: true })}>Change what Orbit read</Button>}
              />
            </div>
          ) : null}
        </>
      )}

      {place.view === 'companies' &&
        (groups.open.length + groups.none.length ? (
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
        ))}

      {place.view === 'saved' &&
        (saved.length ? (
          <SavedView
            rows={saved}
            paths={paths}
            targets={targets}
            onOpen={open}
            onStatus={(m, s) => void act(m, s)}
          />
        ) : (
          <div data-testid="roles-saved-empty">
            <EmptyState
              title="Nothing saved yet"
              body="Save a role from the table and it waits here, with where it stands."
            />
          </div>
        ))}

      <Drawer
        open={!!opened}
        onClose={close}
        title={opened ? `${opened.job.title}` : ''}
        width={560}
        testId="role-drawer"
      >
        {opened && (
          <RolePanel
            match={opened}
            userId={userId}
            path={pathOf(paths, opened.job.companyName)}
            paths={paths}
            sources={kept.profile.sources}
            onSave={() => toggleSave(opened)}
            onStatus={(s) => void act(opened, s)}
            onDismiss={(r) => dismiss(opened, r)}
            onWayIn={() => void wayIn(opened)}
            wayInBusy={working.busy === `way:${opened.id}`}
            onDraft={(personId) => nav(`/people/${personId}?draft=outreach`)}
          />
        )}
      </Drawer>
    </div>
  );
}
