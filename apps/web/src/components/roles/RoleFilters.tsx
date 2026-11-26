/**
 * Plan 45 §4.1: what sits above the roles. A search box (title, company, team, place, a skill the posting names),
 * then one row of filters: the kind of role, the level, a place, the way in (anyone, someone they know, someone or
 * an intro, no way in yet), the least fit, remote and visa; the order sits at the end. The page keeps them while the
 * student is away (state/viewState).
 */
import type { JobLevel, RoleKind } from '@orbit/core';
import { Search, X } from 'lucide-react';
import {
  DEFAULT_FILTERS,
  fitFloor,
  LEVEL_WORDS,
  type RoleFilters,
  type RolesSort,
  type WayInFilter,
} from '../../engine/roles';
import { cx, Select } from '../../ui';

const chip =
  'h-8 px-3 rounded-full border text-[12.5px] transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25';
const on = 'bg-ink border-ink text-white font-medium';
const off = 'bg-canvas border-line text-ink-2 hover:text-ink hover:bg-canvas-2';
const select = 'h-8 rounded-full text-[12.5px]';

export const WAY_IN_WORDS: Record<WayInFilter, string> = {
  any: 'Any way in',
  known: 'Someone I know',
  reach: 'Someone I know or an intro',
  none: 'No way in yet',
};

export const SORT_WORDS: Record<RolesSort, string> = {
  best: 'Best match',
  fit: 'Best fit',
  warmest: 'Easiest way in',
  newest: 'Newest',
};

export function RoleFiltersBar({
  filters,
  onChange,
  kinds,
  levels,
  places,
}: {
  filters: RoleFilters;
  onChange: (next: RoleFilters) => void;
  /** the kinds of role the profile searched */
  kinds: RoleKind[];
  /** the levels among the roles listed */
  levels: JobLevel[];
  /** places among the roles listed, most common first */
  places: string[];
}) {
  const set = (part: Partial<RoleFilters>) => onChange({ ...filters, ...part });
  const changed =
    !!filters.query ||
    filters.kinds.length > 0 ||
    filters.level !== 'any' ||
    !!filters.place ||
    filters.remote ||
    filters.noSponsorship ||
    filters.wayIn !== 'any' ||
    fitFloor(filters.minFit) !== DEFAULT_FILTERS.minFit;
  return (
    <div className="flex flex-col gap-2.5" data-testid="roles-filters">
      <div className="flex items-center gap-2">
        <label className="relative flex h-10 min-w-0 flex-1 items-center rounded-[10px] border border-line bg-canvas transition-colors focus-within:border-ink">
          <Search size={15} className="pointer-events-none absolute left-3 text-ink-3" aria-hidden />
          <input
            value={filters.query}
            onChange={(e) => set({ query: e.target.value })}
            placeholder="Search title, company or skill"
            aria-label="Search roles"
            className="h-full w-full rounded-[10px] bg-transparent pl-9 pr-9 text-[14px] outline-none placeholder:text-[#a59f97]"
            data-testid="roles-search"
          />
          {filters.query && (
            <button
              type="button"
              onClick={() => set({ query: '' })}
              aria-label="Clear the search"
              className="absolute right-2 inline-flex h-6 w-6 items-center justify-center rounded-full text-ink-3 hover:bg-canvas-2 hover:text-ink"
            >
              <X size={13} aria-hidden />
            </button>
          )}
        </label>
        <Select
          value={filters.sort}
          onChange={(e) => set({ sort: e.target.value as RolesSort })}
          aria-label="Order"
          className="h-10 w-[11rem] shrink-0 rounded-[10px] text-[13px]"
          data-testid="roles-sort"
        >
          {(Object.keys(SORT_WORDS) as RolesSort[]).map((s) => (
            <option key={s} value={s}>
              {SORT_WORDS[s]}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Select
          value={filters.wayIn}
          onChange={(e) => set({ wayIn: e.target.value as WayInFilter })}
          aria-label="Way in"
          className={cx(select, filters.wayIn !== 'any' && 'font-medium')}
          data-testid="roles-way-in-filter"
        >
          {(Object.keys(WAY_IN_WORDS) as WayInFilter[]).map((w) => (
            <option key={w} value={w}>
              {WAY_IN_WORDS[w]}
            </option>
          ))}
        </Select>
        {kinds.length > 1 && (
          <Select
            value={filters.kinds[0] ?? ''}
            onChange={(e) => set({ kinds: e.target.value ? [e.target.value] : [] })}
            aria-label="Kind of role"
            className={select}
            data-testid="roles-kind"
          >
            <option value="">Every kind</option>
            {kinds.map((k) => (
              <option key={k.title} value={k.title}>
                {k.title}
              </option>
            ))}
          </Select>
        )}
        <Select
          value={filters.level}
          onChange={(e) => set({ level: e.target.value as RoleFilters['level'] })}
          aria-label="Level"
          className={select}
          data-testid="roles-level"
        >
          <option value="any">Any level</option>
          {levels.map((l) => (
            <option key={l} value={l}>
              {LEVEL_WORDS[l]}
            </option>
          ))}
        </Select>
        <Select
          value={filters.place}
          onChange={(e) => set({ place: e.target.value })}
          aria-label="Place"
          className={cx(select, 'max-w-[13rem]')}
          data-testid="roles-place"
        >
          <option value="">Anywhere</option>
          {places.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Select>
        <Select
          value={String(fitFloor(filters.minFit))}
          onChange={(e) => set({ minFit: Number(e.target.value) })}
          aria-label="Least fit shown"
          className={select}
          data-testid="roles-min-fit"
        >
          {[80, 65, 50, 30, 0].map((n) => (
            <option key={n} value={n}>
              {n === 0 ? 'Any fit' : `Fit ${n}+`}
            </option>
          ))}
        </Select>
        <button
          type="button"
          aria-pressed={filters.remote}
          onClick={() => set({ remote: !filters.remote })}
          className={cx(chip, filters.remote ? on : off)}
          data-testid="roles-remote"
        >
          Remote
        </button>
        <button
          type="button"
          aria-pressed={filters.noSponsorship}
          onClick={() => set({ noSponsorship: !filters.noSponsorship })}
          className={cx(chip, filters.noSponsorship ? on : off)}
          title="Only roles that do not hold a visa against you"
          data-testid="roles-sponsorship"
        >
          Visa OK
        </button>
        {changed && (
          <button
            type="button"
            onClick={() => onChange({ ...DEFAULT_FILTERS, sort: filters.sort })}
            className="ml-1 h-8 rounded px-1.5 text-[12.5px] text-ink-3 hover:text-ink"
            data-testid="roles-filters-clear"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
