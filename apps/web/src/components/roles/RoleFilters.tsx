/**
 * Plan 44 §2.3: what sits above the Roles table. The kinds of role as chips (tap to filter), the level, a place,
 * remote, "needs no sponsorship", the least fit shown (6 by default) and the order (fit, newest, warmest path). The
 * page keeps them while the student is away (state/viewState).
 */
import type { JobLevel, RoleKind } from '@orbit/core';
import { DEFAULT_FILTERS, LEVEL_WORDS, type RoleFilters, type RolesSort } from '../../engine/roles';
import { cx, Select } from '../../ui';

const chip =
  'h-8 px-2.5 rounded-[6px] border text-[12.5px] transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25';
const on = 'bg-ink border-ink text-white font-medium';
const off = 'bg-canvas border-line text-ink-2 hover:text-ink hover:bg-canvas-2';

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
  const toggleKind = (title: string) =>
    set({
      kinds: filters.kinds.includes(title)
        ? filters.kinds.filter((k) => k !== title)
        : [...filters.kinds, title],
    });
  const changed =
    filters.kinds.length > 0 ||
    filters.level !== 'any' ||
    !!filters.place ||
    filters.remote ||
    filters.noSponsorship ||
    filters.minFit !== DEFAULT_FILTERS.minFit;
  return (
    <div className="flex flex-col gap-2" data-testid="roles-filters">
      {kinds.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Kinds of role">
          {kinds.map((k) => {
            const picked = filters.kinds.includes(k.title);
            return (
              <button
                key={k.title}
                type="button"
                aria-pressed={picked}
                onClick={() => toggleKind(k.title)}
                className={cx(chip, picked ? on : off)}
                title={k.why}
                data-testid="roles-kind-chip"
              >
                {k.title}
              </button>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Select
          value={filters.level}
          onChange={(e) => set({ level: e.target.value as RoleFilters['level'] })}
          aria-label="Level"
          className="h-8 text-[12.5px]"
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
          className="h-8 text-[12.5px]"
          data-testid="roles-place"
        >
          <option value="">Anywhere</option>
          {places.map((p) => (
            <option key={p} value={p}>
              {p}
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
          Needs no sponsorship
        </button>
        <Select
          value={String(filters.minFit)}
          onChange={(e) => set({ minFit: Number(e.target.value) })}
          aria-label="Least fit shown"
          className="h-8 text-[12.5px]"
          data-testid="roles-min-fit"
        >
          {[8, 7, 6, 5, 4, 1].map((n) => (
            <option key={n} value={n}>
              {n === 1 ? 'Every fit' : `Fit ${n} or more`}
            </option>
          ))}
        </Select>
        <Select
          value={filters.sort}
          onChange={(e) => set({ sort: e.target.value as RolesSort })}
          aria-label="Order"
          className="h-8 text-[12.5px]"
          data-testid="roles-sort"
        >
          <option value="fit">Best fit first</option>
          <option value="newest">Newest first</option>
          <option value="warmest">Warmest path first</option>
        </Select>
        {changed && (
          <button
            type="button"
            onClick={() => onChange({ ...DEFAULT_FILTERS, sort: filters.sort })}
            className="ml-1 h-8 rounded px-1 text-[12.5px] text-ink-3 underline decoration-line underline-offset-4 hover:text-ink"
            data-testid="roles-filters-clear"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
