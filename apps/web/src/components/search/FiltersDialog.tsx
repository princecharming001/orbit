import type { Need } from '@orbit/core/search';
import { SENIORITIES, TITLE_FAMILIES } from '@orbit/core/search';
import { Briefcase, Building2, GraduationCap, Search, SlidersHorizontal, X } from 'lucide-react';
import { type InputHTMLAttributes, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  countFilters,
  EMPTY_FILTERS,
  FAMILY_LABELS,
  type FilterForm,
  SENIORITY_LABELS,
} from '../../engine/peopleSearch';
import { Button, cx, useDialog } from '../../ui';
import { Suggest, type Suggestion } from '../../ui/Suggest';
import { type FilterField, suggestFilter } from './filterSuggest';
import { NeedToggle } from './NeedToggle';

type Section = 'role' | 'companies' | 'education' | 'advanced';

const SECTIONS: { id: Section; label: string; icon: ReactNode; words: string }[] = [
  {
    id: 'role',
    label: 'Role and location',
    icon: <Briefcase size={16} />,
    words: 'role location job title title groups seniority city country place',
  },
  {
    id: 'companies',
    label: 'Companies',
    icon: <Building2 size={16} />,
    words: 'companies current company previous company employer',
  },
  {
    id: 'education',
    label: 'Education',
    icon: <GraduationCap size={16} />,
    words: 'education school university college',
  },
  {
    id: 'advanced',
    label: 'Advanced',
    icon: <SlidersHorizontal size={16} />,
    words: 'advanced keywords network connections who to search',
  },
];

/** The boxed input the chip fields type into: one component for the field's life, so the cursor is never lost. */
function BoxInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="h-11 w-full rounded-[8px] border border-line bg-canvas-2/50 px-3.5 text-[14px] outline-none focus:border-ink focus:bg-canvas placeholder:text-[#a59f97]"
    />
  );
}

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * A boxed field that takes several entries: suggestions open under it as the student types (and before, the common
 * choices), a click or the arrows and Enter pick one, Enter or a comma adds exactly what is typed, and the entries
 * sit under it as chips.
 */
function ChipBox({
  values,
  onChange,
  placeholder,
  label,
  testId,
  suggest,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  label: string;
  testId: string;
  /** matches for what is typed; an empty query asks for the common choices */
  suggest?: (query: string) => Suggestion[] | Promise<Suggestion[]>;
}) {
  const [draft, setDraft] = useState('');
  // the arrows moved the highlight: Enter then picks that row; before that, Enter adds what is typed
  const moved = useRef(false);
  const has = (v: string) => values.some((x) => x.toLowerCase() === v.toLowerCase());
  // what the list last offered: one of these is a whole entry, commas and all ("University of California, Berkeley")
  const offered = useRef(new Set<string>());
  const add = (raw: string, whole = false) => {
    const next = [...values];
    for (const part of whole ? [raw] : raw.split(',')) {
      const t = tidy(part);
      if (t && !next.some((x) => x.toLowerCase() === t.toLowerCase())) next.push(t);
    }
    if (next.length !== values.length) onChange(next);
    setDraft('');
    moved.current = false;
  };
  const find = async (query: string): Promise<Suggestion[]> => {
    const typed = tidy(query);
    const got = suggest ? (await suggest(typed)).filter((s) => !has(s.value)) : [];
    offered.current = new Set(got.map((s) => s.value));
    if (!typed || has(typed)) return got;
    // what is typed leads the list, so Enter and the first row are the same thing
    const same = got.find((s) => s.value.toLowerCase() === typed.toLowerCase());
    return same
      ? [same, ...got.filter((s) => s !== same)]
      : [{ value: typed, label: `Add "${typed}"` }, ...got];
  };
  return (
    <div data-testid={testId}>
      <Suggest
        value={draft}
        onChange={(v) => {
          moved.current = false;
          if (v.includes(',') && !offered.current.has(v)) add(v);
          else setDraft(v);
        }}
        suggest={find}
        onPick={(s) => add(s.value, true)}
        minChars={0}
        input={BoxInput}
        onKeyDown={(e) => {
          const open = e.currentTarget.getAttribute('aria-expanded') === 'true';
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') moved.current = true;
          else if (e.key === 'Enter') {
            // Enter never saves the dialog by accident
            if (moved.current && open) return;
            e.preventDefault();
            if (draft.trim()) add(draft);
          } else if (e.key === 'Escape' && open)
            // closes the suggestions, not the dialog
            e.stopPropagation();
          else if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1));
        }}
        onBlur={() => draft.trim() && add(draft)}
        placeholder={placeholder}
        aria-label={label}
        data-testid={`${testId}-input`}
      />
      {values.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {values.map((v) => (
            <span
              key={v}
              className="inline-flex h-8 items-center gap-2 rounded-[6px] bg-canvas-2 pl-3 pr-1.5 text-[13.5px] text-ink"
              data-testid={`${testId}-chip`}
            >
              {v}
              <button
                type="button"
                onClick={() => onChange(values.filter((x) => x !== v))}
                className="inline-flex h-5 w-5 items-center justify-center rounded text-ink-3 hover:bg-line hover:text-ink"
                aria-label={`Remove ${v}`}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Choices where any number can be on: a row of quiet pills. */
function Toggles<T extends string>({
  options,
  values,
  onChange,
  labels,
  testId,
}: {
  options: readonly T[];
  values: T[];
  onChange: (next: T[]) => void;
  labels: Record<T, string>;
  testId: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid={testId}>
      {options.map((o) => {
        const on = values.includes(o);
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? values.filter((x) => x !== o) : [...values, o])}
            className={cx(
              'h-8 rounded-[6px] border px-2.5 text-[13px] transition-colors',
              on ? 'border-ink bg-ink text-white' : 'border-line bg-canvas text-ink-2 hover:border-[#cfccc6]',
            )}
            data-testid={`${testId}-${o}`}
          >
            {labels[o]}
          </button>
        );
      })}
    </div>
  );
}

function Field({
  title,
  hint,
  need,
  onNeed,
  onClear,
  children,
  testId,
}: {
  title: ReactNode;
  /** how several entries combine ("Matches any") */
  hint?: string;
  need?: Need;
  onNeed?: (n: Need) => void;
  onClear?: () => void;
  children: ReactNode;
  testId: string;
}) {
  return (
    <section className="py-5 first:pt-0" data-testid={testId}>
      <div className="mb-2.5 flex min-h-8 flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[14.5px] font-medium text-ink">{title}</h3>
          {hint && <span className="text-[12.5px] text-ink-3">{hint}</span>}
        </div>
        <div className="flex items-center gap-3">
          {need && onNeed && (
            <NeedToggle
              value={need}
              onChange={onNeed}
              label={typeof title === 'string' ? title : 'This filter'}
              testId={`${testId}-need`}
            />
          )}
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              className="text-[13px] text-ink-3 hover:text-ink"
              data-testid={`${testId}-clear`}
            >
              Clear
            </button>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}

/**
 * The filters of a search, by section: role and location, companies, education, advanced. Nothing runs until Save
 * changes; closing without saving keeps the search as it was.
 */
export function FiltersDialog({
  open,
  filters,
  onClose,
  onSave,
  /** people outside the student's network can be searched at all (an Orbit account) */
  canSearchOutside,
  userId,
}: {
  open: boolean;
  filters: FilterForm;
  onClose: () => void;
  onSave: (next: FilterForm) => void;
  canSearchOutside: boolean;
  /** whose people the fields suggest from */
  userId: string;
}) {
  const [f, setF] = useState<FilterForm>(filters);
  const [section, setSection] = useState<Section>('role');
  const [find, setFind] = useState('');
  const [roleTab, setRoleTab] = useState<'titles' | 'groups'>('titles');
  const titleId = useId();
  const ref = useDialog(open, onClose);
  useEffect(() => {
    if (!open) return;
    setF({ ...filters });
    setFind('');
    setSection('role');
    setRoleTab(filters.families.length && !filters.titles.length ? 'groups' : 'titles');
  }, [open, filters]);
  if (!open) return null;
  const set = (patch: Partial<FilterForm>) => setF((cur) => ({ ...cur, ...patch }));
  const hints = (field: FilterField) => (query: string) => suggestFilter(userId, field, query);
  const q = find.trim().toLowerCase();
  const shown = SECTIONS.filter((s) => !q || `${s.label} ${s.words}`.toLowerCase().includes(q));
  const active = shown.find((s) => s.id === section) ?? shown[0];
  const setIn: Record<Section, number> = {
    role: countFilters({
      ...EMPTY_FILTERS,
      titles: f.titles,
      families: f.families,
      seniority: f.seniority,
      places: f.places,
    }),
    companies: countFilters({
      ...EMPTY_FILTERS,
      currentCompanies: f.currentCompanies,
      companies: f.companies,
    }),
    education: f.schools.length ? 1 : 0,
    advanced: countFilters({ ...EMPTY_FILTERS, keywords: f.keywords, reach: f.reach }),
  };
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/25" />
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-[min(720px,calc(100dvh-32px))] w-full max-w-[960px] flex-col rounded-[10px] border border-line bg-canvas shadow-[0_24px_60px_rgba(0,0,0,0.12)] pop-in focus:outline-none"
        data-testid="filters-dialog"
      >
        <div className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-line px-5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="-ml-1.5 rounded-md p-1.5 hover:bg-canvas-2"
              aria-label="Close without saving"
              data-testid="filters-close"
            >
              <X size={16} />
            </button>
            <h2 id={titleId} className="text-[17px] font-medium">
              Edit filters
            </h2>
          </div>
          <Button variant="primary" onClick={() => onSave(f)} data-testid="filters-save">
            Save changes
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav
            className="shrink-0 border-b border-line p-3 sm:w-[236px] sm:border-b-0 sm:border-r"
            aria-label="Filter sections"
          >
            <label className="relative block">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
              <input
                value={find}
                onChange={(e) => setFind(e.target.value)}
                placeholder="Search filters"
                aria-label="Search filters"
                className="h-10 w-full rounded-[8px] border border-line bg-canvas pl-9 pr-3 text-[14px] outline-none focus:border-ink placeholder:text-[#a59f97]"
                data-testid="filters-find"
              />
            </label>
            <ul className="mt-3 flex gap-1 overflow-x-auto sm:block sm:space-y-1">
              {shown.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setSection(s.id)}
                    aria-current={active?.id === s.id ? 'true' : undefined}
                    className={cx(
                      'flex h-10 w-full items-center gap-2.5 whitespace-nowrap rounded-[8px] border px-3 text-[14px] transition-colors',
                      active?.id === s.id
                        ? 'border-accent/30 bg-accent-soft font-medium text-accent'
                        : 'border-transparent text-ink hover:bg-canvas-2',
                    )}
                    data-testid={`filters-section-${s.id}`}
                  >
                    {s.icon}
                    <span className="flex-1 text-left">{s.label}</span>
                    {setIn[s.id] > 0 && (
                      <span className="text-[12px] tabular-nums text-ink-3">
                        {setIn[s.id]}
                        <span className="sr-only"> set</span>
                      </span>
                    )}
                  </button>
                </li>
              ))}
              {shown.length === 0 && (
                <li className="px-3 py-2 text-[13px] text-ink-3">No filter by that name.</li>
              )}
            </ul>
          </nav>
          <div className="min-h-0 flex-1 divide-y divide-line overflow-y-auto px-6 py-5">
            {active?.id === 'role' && (
              <>
                <Field
                  title={
                    <span className="inline-flex gap-4" role="tablist" aria-label="Job title or title groups">
                      {(['titles', 'groups'] as const).map((t) => (
                        <button
                          key={t}
                          type="button"
                          role="tab"
                          aria-selected={roleTab === t}
                          onClick={() => setRoleTab(t)}
                          className={cx(roleTab === t ? 'text-ink' : 'font-normal text-ink-3 hover:text-ink')}
                          data-testid={`filters-role-tab-${t}`}
                        >
                          {t === 'titles' ? 'Job title' : 'Title groups'}
                        </button>
                      ))}
                    </span>
                  }
                  need={f.roleNeed}
                  onNeed={(roleNeed) => set({ roleNeed })}
                  onClear={
                    f.titles.length + f.families.length ? () => set({ titles: [], families: [] }) : undefined
                  }
                  testId="filter-titles"
                >
                  {roleTab === 'titles' ? (
                    <ChipBox
                      values={f.titles}
                      onChange={(titles) => set({ titles })}
                      placeholder="Add a title or keyword"
                      label="Job title"
                      testId="filter-titles-box"
                      suggest={hints('titles')}
                    />
                  ) : (
                    <>
                      <p className="mb-2.5 text-[12.5px] text-ink-3">
                        A group covers every title of that kind of work, whatever the wording.
                      </p>
                      <Toggles
                        options={TITLE_FAMILIES}
                        values={f.families}
                        onChange={(families) => set({ families })}
                        labels={FAMILY_LABELS}
                        testId="filter-families"
                      />
                    </>
                  )}
                </Field>
                <Field
                  title="Seniority"
                  hint="Matches any"
                  onClear={f.seniority.length ? () => set({ seniority: [] }) : undefined}
                  testId="filter-seniority"
                >
                  <Toggles
                    options={SENIORITIES}
                    values={f.seniority}
                    onChange={(seniority) => set({ seniority })}
                    labels={SENIORITY_LABELS}
                    testId="filter-seniority-options"
                  />
                </Field>
                <Field
                  title="Location"
                  hint="Matches any"
                  need={f.placesNeed}
                  onNeed={(placesNeed) => set({ placesNeed })}
                  onClear={f.places.length ? () => set({ places: [] }) : undefined}
                  testId="filter-places"
                >
                  <ChipBox
                    values={f.places}
                    onChange={(places) => set({ places })}
                    placeholder="Add a city or country"
                    label="Location"
                    testId="filter-places-box"
                    suggest={hints('places')}
                  />
                </Field>
              </>
            )}
            {active?.id === 'companies' && (
              <>
                <Field
                  title="Current company"
                  hint="Matches any"
                  onClear={f.currentCompanies.length ? () => set({ currentCompanies: [] }) : undefined}
                  testId="filter-current"
                >
                  <ChipBox
                    values={f.currentCompanies}
                    onChange={(currentCompanies) => set({ currentCompanies })}
                    placeholder="Add a company"
                    label="Current company"
                    testId="filter-current-box"
                    suggest={hints('companies')}
                  />
                </Field>
                <Field
                  title="Current and previous companies"
                  hint="Matches any"
                  need={f.companiesNeed}
                  onNeed={(companiesNeed) => set({ companiesNeed })}
                  onClear={f.companies.length ? () => set({ companies: [] }) : undefined}
                  testId="filter-companies"
                >
                  <ChipBox
                    values={f.companies}
                    onChange={(companies) => set({ companies })}
                    placeholder="Add a company"
                    label="Current and previous companies"
                    testId="filter-companies-box"
                    suggest={hints('companies')}
                  />
                </Field>
              </>
            )}
            {active?.id === 'education' && (
              <Field
                title="School"
                hint="Matches any"
                onClear={f.schools.length ? () => set({ schools: [] }) : undefined}
                testId="filter-schools"
              >
                <ChipBox
                  values={f.schools}
                  onChange={(schools) => set({ schools })}
                  placeholder="Add a school or university"
                  label="School"
                  testId="filter-schools-box"
                  suggest={hints('schools')}
                />
              </Field>
            )}
            {active?.id === 'advanced' && (
              <>
                <Field
                  title="Keywords"
                  hint="Matches any"
                  need={f.keywordsNeed}
                  onNeed={(keywordsNeed) => set({ keywordsNeed })}
                  onClear={f.keywords.length ? () => set({ keywords: [] }) : undefined}
                  testId="filter-keywords"
                >
                  <ChipBox
                    values={f.keywords}
                    onChange={(keywords) => set({ keywords })}
                    placeholder="Add a keyword"
                    label="Keywords"
                    testId="filter-keywords-box"
                    suggest={hints('keywords')}
                  />
                </Field>
                <Field title="Who to search" testId="filter-reach">
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Who to search">
                    {(
                      [
                        ['everyone', 'Everyone Orbit can find'],
                        ['mine', 'Only people I know'],
                      ] as const
                    ).map(([v, label]) => (
                      <button
                        key={v}
                        type="button"
                        aria-pressed={f.reach === v}
                        onClick={() => set({ reach: v })}
                        className={cx(
                          'h-8 rounded-[6px] border px-2.5 text-[13px] transition-colors',
                          f.reach === v
                            ? 'border-ink bg-ink text-white'
                            : 'border-line bg-canvas text-ink-2 hover:border-[#cfccc6]',
                        )}
                        data-testid={`filter-reach-${v}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {!canSearchOutside && (
                    <p className="mt-2 text-[12.5px] text-ink-3">
                      People outside your network are searched once you sign in to Orbit.
                    </p>
                  )}
                </Field>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
