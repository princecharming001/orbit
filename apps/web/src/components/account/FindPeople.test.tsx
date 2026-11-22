/**
 * Find people as a table: one sentence is read into filters and criteria, the results list the student's own people
 * and new ones together with a match, a path and an answer per criterion; the two dialogs change the search and run
 * it again; a new person is added alone or with others; an address is looked up only when asked (plan 35 C3).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_FILTERS,
  newCriterion,
  type PeopleSearchResult,
  type ResultRow,
  type SearchForm,
} from '../../engine/peopleSearch';

const search = vi.hoisted(() => ({ interpretAsk: vi.fn(), runPeopleSearch: vi.fn() }));
const sourcing = vi.hoisted(() => ({ findEmail: vi.fn(), addSourced: vi.fn() }));
const hints = vi.hoisted(() => ({ suggestFilter: vi.fn() }));
vi.mock('../search/filterSuggest', () => hints);
vi.mock('../../engine/peopleSearch', async (orig) => ({
  ...(await orig<typeof import('../../engine/peopleSearch')>()),
  ...search,
}));
vi.mock('../../engine/sourcing', async (orig) => ({
  ...(await orig<typeof import('../../engine/sourcing')>()),
  ...sourcing,
}));
vi.mock('../../state/session', () => ({ useSession: () => ({ user: { id: 'u1', school: 'Berkeley' } }) }));
vi.mock('../../integrations/orbitApi', async (orig) => ({
  ...(await orig<typeof import('../../integrations/orbitApi')>()),
  isServerUser: () => true,
}));
// a logo is a lookup of its own; the table only needs the name beside it
vi.mock('../CompanyLogo', () => ({ CompanyLogo: () => null }));

import { FindPeople } from './FindPeople';

const crit = newCriterion('Works at a venture capital firm', 'must');
const FORM: SearchForm = {
  ask: 'seed investors',
  filters: { ...EMPTY_FILTERS, titles: ['investor', 'partner'], families: ['investing'], keywords: ['seed'] },
  criteria: [crit],
};
const own: ResultRow = {
  key: 'p:p1',
  personId: 'p1',
  name: 'Ana Own',
  title: 'Partner',
  company: 'Accel',
  linkedinUrl: 'https://www.linkedin.com/in/ana',
  path: { kind: 'direct', label: 'You know them', level: 3 },
  match: 100,
  checks: [{ id: crit.id, answer: 'yes', evidence: 'Partner at Accel' }],
};
const fresh: ResultRow = {
  key: 'r:r1',
  recommendationId: 'r1',
  name: 'Maya Chen',
  title: 'Principal',
  company: 'Seed Fund',
  path: { kind: 'intro', label: 'Sam Warm', personId: 'p9', level: 2 },
  match: 82,
  checks: [{ id: crit.id, answer: 'unknown' }],
  emailStatus: 'not looked up',
};
const other: ResultRow = {
  ...fresh,
  key: 'r:r2',
  recommendationId: 'r2',
  name: 'Leo Grant',
  path: undefined,
  match: 60,
};

const result = (rows: ResultRow[], over: Partial<PeopleSearchResult> = {}): PeopleSearchResult => ({
  form: FORM,
  rows,
  counts: { network: rows.filter((r) => r.personId).length, outside: rows.filter((r) => !r.personId).length },
  notes: [],
  unchecked: false,
  ...over,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  search.interpretAsk.mockResolvedValue({ form: FORM, by: 'model' });
  hints.suggestFilter.mockResolvedValue([]);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

const $ = (id: string, within: ParentNode = document.body) =>
  within.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const $$ = (id: string, within: ParentNode = document.body) => [
  ...within.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
];
const click = (el: Element | null) => act(async () => (el as HTMLElement).click());
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function searchFor(rows: ResultRow[], over: Partial<PeopleSearchResult> = {}) {
  search.runPeopleSearch.mockResolvedValue(result(rows, over));
  await act(async () => {
    root.render(
      <MemoryRouter>
        <FindPeople userId="u1" />
      </MemoryRouter>,
    );
  });
  await type($('find-query') as HTMLInputElement, 'seed investors');
  await click($('find-search'));
}

describe('Find people: the results table', () => {
  it('has no purpose pills, and the tools appear only once a search has been read', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <FindPeople userId="u1" />
        </MemoryRouter>,
      );
    });
    expect(host.querySelector('[data-testid^="find-purpose-"]')).toBeNull();
    expect($('find-tools')).toBeNull();
    expect(($('find-search') as HTMLButtonElement).disabled).toBe(true);
  });

  it('reads the sentence, runs the search, and lists everyone in one table with its columns', async () => {
    await searchFor([own, fresh]);
    expect(search.interpretAsk).toHaveBeenCalledWith('seed investors');
    expect(search.runPeopleSearch).toHaveBeenCalledWith({ id: 'u1', school: 'Berkeley' }, FORM);
    expect($('find-count')!.textContent).toBe('2 matches');
    // titles and groups are one filter, keywords another
    expect($('find-filters')!.textContent).toBe('2');
    expect($('find-criteria')!.textContent).toBe('1');
    const heads = [...host.querySelectorAll('thead th')].map((th) => th.textContent?.trim());
    expect(heads).toEqual([
      'Name',
      'Profiles',
      'Paths',
      'Title',
      'Company',
      'Match',
      'Works at a venture capital firm',
      'Add',
    ]);
    const [a, b] = $$('find-result');
    expect(a!.dataset.own).toBe('true');
    expect($('find-name', a!)!.getAttribute('href')).toBe('/people/p1');
    expect($('find-linkedin', a!)!.getAttribute('href')).toBe('https://www.linkedin.com/in/ana');
    expect($('find-match', a!)!.textContent).toBe('100%');
    expect($('find-thumb', a!)!.dataset.answer).toBe('yes');
    expect($('find-thumb', a!)!.getAttribute('aria-label')).toBe('Yes: Partner at Accel');
    expect($('result-path', a!)!.dataset.kind).toBe('direct');
    expect($('result-path-bars', a!)!.dataset.level).toBe('3');
    // someone the student already has is never offered Add or a tick box
    expect($('find-add', a!)).toBeNull();
    expect($('find-pick', a!)).toBeNull();
    // the new person: a path through someone warm, a dash where nothing is known, and Add
    expect(b!.dataset.own).toBe('false');
    expect($('find-name', b!)!.tagName).toBe('SPAN');
    expect($('result-path', b!)!.textContent).toContain('Sam Warm');
    expect($('find-thumb', b!)!.dataset.answer).toBe('unknown');
    expect($('find-add', b!)).not.toBeNull();
    expect($('find-split')!.textContent).toBe('1 you already know, 1 new.');
  });

  it('someone with no way in says so instead of an empty cell', async () => {
    await searchFor([other]);
    expect($$('find-result')[0]!.textContent).toContain('No path yet');
  });

  it('nobody found: says so with what to try; the notes and a failed outside search are said under the table', async () => {
    await searchFor([], { notes: [] });
    expect($('find-empty')!.textContent).toContain('No one found yet');
    expect($('find-results')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    await searchFor([own], {
      notes: ['Not searched yet: Apollo.'],
      outsideMessage: 'Orbit could not reach its server.',
      unchecked: true,
    });
    expect($('find-quiet')!.textContent).toContain('Not searched yet: Apollo.');
    expect($('find-outside-error')!.textContent).toBe('Orbit could not reach its server.');
    expect($('find-unchecked')).not.toBeNull();
  });
});

describe('Find people: criteria and filters change the search', () => {
  it('Criteria: edit one, add a nice to have, Update runs the search again with them', async () => {
    await searchFor([own, fresh]);
    await click($('find-criteria'));
    const dialog = $('criteria-dialog')!;
    expect(($('criterion-text', dialog) as HTMLInputElement).value).toBe('Works at a venture capital firm');
    expect($('criterion-need-must', dialog)!.getAttribute('aria-pressed')).toBe('true');
    await click($('criterion-add', dialog));
    const texts = $$('criterion-text', dialog) as HTMLInputElement[];
    expect(texts).toHaveLength(2);
    await type(texts[1]!, '  Invests at seed stage ');
    await click($$('criterion-need-nice', dialog)[1]!);
    search.runPeopleSearch.mockClear();
    await click($('criteria-save', dialog));
    expect($('criteria-dialog')).toBeNull();
    const next = search.runPeopleSearch.mock.calls[0]![1] as SearchForm;
    expect(next.criteria.map((c) => [c.text, c.need])).toEqual([
      ['Works at a venture capital firm', 'must'],
      ['Invests at seed stage', 'nice'],
    ]);
    // the filters were not touched
    expect(next.filters).toEqual(FORM.filters);
  });

  it('Criteria: removing one and leaving an empty line saves only what is written; Cancel changes nothing', async () => {
    await searchFor([own]);
    await click($('find-criteria'));
    await click($('criterion-add'));
    await click($('criterion-remove'));
    search.runPeopleSearch.mockClear();
    await click($('criteria-save'));
    expect((search.runPeopleSearch.mock.calls[0]![1] as SearchForm).criteria).toEqual([]);
    search.runPeopleSearch.mockClear();
    await click($('find-criteria'));
    await click($('criteria-cancel'));
    expect(search.runPeopleSearch).not.toHaveBeenCalled();
  });

  it('Filters: shows what the search has, by section; add a place as nice to have and Save changes runs again', async () => {
    await searchFor([own, fresh]);
    await click($('find-filters'));
    const dialog = $('filters-dialog')!;
    expect($$('filter-titles-box-chip', dialog).map((c) => c.textContent)).toEqual(['investor', 'partner']);
    // the title groups tab holds the group the search already has
    await click($('filters-role-tab-groups', dialog));
    expect($('filter-families-investing', dialog)!.getAttribute('aria-pressed')).toBe('true');
    await click($('filter-seniority-options-vp', dialog));
    const place = $('filter-places-box-input', dialog) as HTMLInputElement;
    await type(place, 'London');
    await act(async () => {
      place.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect($$('filter-places-box-chip', dialog).map((c) => c.textContent)).toEqual(['London']);
    await click($('filter-places-need-nice', dialog));
    // another section: the keyword the search has, and who to search
    await click($('filters-section-advanced', dialog));
    expect($$('filter-keywords-box-chip', dialog).map((c) => c.textContent)).toEqual(['seed']);
    await click($('filter-reach-mine', dialog));
    search.runPeopleSearch.mockClear();
    await click($('filters-save', dialog));
    expect($('filters-dialog')).toBeNull();
    const next = search.runPeopleSearch.mock.calls[0]![1] as SearchForm;
    expect(next.filters).toEqual({
      ...FORM.filters,
      seniority: ['vp'],
      places: ['London'],
      placesNeed: 'nice',
      reach: 'mine',
    });
    expect(next.criteria).toEqual(FORM.criteria);
  });

  it('Filters: Clear empties a group, the section search narrows the list, and closing saves nothing', async () => {
    await searchFor([own]);
    await click($('find-filters'));
    await click($('filter-titles-clear'));
    expect($$('filter-titles-box-chip')).toHaveLength(0);
    await type($('filters-find') as HTMLInputElement, 'school');
    expect($('filters-section-education')).not.toBeNull();
    expect($('filters-section-role')).toBeNull();
    expect($('filter-schools')).not.toBeNull();
    search.runPeopleSearch.mockClear();
    await click($('filters-close'));
    expect($('filters-dialog')).toBeNull();
    expect(search.runPeopleSearch).not.toHaveBeenCalled();
    // opened again, it starts from the search as it is: the cleared titles are back
    await click($('find-filters'));
    expect($$('filter-titles-box-chip')).toHaveLength(2);
  });
});

describe('Find people: adding and emails', () => {
  it('Filters: a field suggests as you type; a click picks one, Enter adds what is typed, Escape closes only the list', async () => {
    hints.suggestFilter.mockImplementation(async (_user: string, field: string, q: string) =>
      field === 'schools' && q.toLowerCase().startsWith('uc b')
        ? [{ value: 'University of California, Berkeley', sub: 'Berkeley, CA' }]
        : field === 'schools' && !q
          ? [{ value: 'Stanford University', sub: '4 people you know' }]
          : [],
    );
    await searchFor([own]);
    await click($('find-filters'));
    const dialog = $('filters-dialog')!;
    await click($('filters-section-education', dialog));
    const school = $('filter-schools-box-input', dialog) as HTMLInputElement;
    const options = () => $$('suggest-option').map((o) => o.textContent);
    const key = (k: string) =>
      act(async () => {
        school.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      });
    const settle = () => act(async () => {});
    // before a letter is typed: the common choices, to pick from
    await act(async () => school.focus());
    await settle();
    expect(options()).toEqual(['Stanford University4 people you know']);
    await type(school, 'uc berkeley');
    await settle();
    expect(hints.suggestFilter).toHaveBeenLastCalledWith('u1', 'schools', 'uc berkeley');
    // what is typed leads, then the matches
    expect(options()).toEqual(['Add "uc berkeley"', 'University of California, BerkeleyBerkeley, CA']);
    // Escape closes the list and leaves the dialog open
    await key('Escape');
    expect($('suggest-menu')).toBeNull();
    expect($('filters-dialog')).not.toBeNull();
    // a click on a suggestion adds it as a chip and empties the box
    await type(school, 'uc b');
    await settle();
    await click($$('suggest-option')[1]!);
    const chips = () => $$('filter-schools-box-chip', dialog).map((c) => c.textContent);
    expect(chips()).toEqual(['University of California, Berkeley']);
    expect(school.value).toBe('');
    // what is already chosen is not offered again
    await type(school, 'uc b');
    await settle();
    expect(options()).toEqual(['Add "uc b"']);
    // Enter adds exactly what is typed
    await key('Enter');
    expect(chips()).toEqual(['University of California, Berkeley', 'uc b']);
    // the arrows move to a suggestion and Enter picks it
    hints.suggestFilter.mockResolvedValue([{ value: 'Harvard University' }]);
    await type(school, 'harv');
    await settle();
    await key('ArrowDown');
    await key('Enter');
    expect(chips()).toEqual(['University of California, Berkeley', 'uc b', 'Harvard University']);
    search.runPeopleSearch.mockClear();
    await click($('filters-save', dialog));
    expect((search.runPeopleSearch.mock.calls[0]![1] as SearchForm).filters.schools).toEqual([
      'University of California, Berkeley',
      'uc b',
      'Harvard University',
    ]);
  });

  it('every text filter asks for suggestions for its own field', async () => {
    await searchFor([own]);
    await click($('find-filters'));
    const dialog = $('filters-dialog')!;
    const asked = async (section: string, input: string) => {
      if (section !== 'role') await click($(`filters-section-${section}`, dialog));
      hints.suggestFilter.mockClear();
      await type($(input, dialog) as HTMLInputElement, 'a');
      await act(async () => {});
      return hints.suggestFilter.mock.calls.at(-1)?.[1];
    };
    expect(await asked('role', 'filter-titles-box-input')).toBe('titles');
    expect(await asked('role', 'filter-places-box-input')).toBe('places');
    expect(await asked('companies', 'filter-current-box-input')).toBe('companies');
    expect(await asked('companies', 'filter-companies-box-input')).toBe('companies');
    expect(await asked('education', 'filter-schools-box-input')).toBe('schools');
    expect(await asked('advanced', 'filter-keywords-box-input')).toBe('keywords');
  });

  it('Add puts one person in, and the row then opens their page', async () => {
    sourcing.addSourced.mockResolvedValue({
      ok: true,
      people: [{ id: 'new1', displayName: 'Maya Chen', chatId: 'c' }],
    });
    await searchFor([own, fresh]);
    await click($('find-add'));
    expect(sourcing.addSourced).toHaveBeenCalledWith({ id: 'u1' }, ['r1']);
    const row = $$('find-result')[1]!;
    expect($('find-add', row)).toBeNull();
    expect($('find-open', row)!.getAttribute('href')).toBe('/people/new1');
    expect($('find-name', row)!.getAttribute('href')).toBe('/people/new1');
  });

  it('picking everyone new and Add 2 adds them in one go, each row to its own person', async () => {
    sourcing.addSourced.mockResolvedValue({
      ok: true,
      people: [
        { id: 'n1', displayName: 'Maya Chen', chatId: 'c1' },
        { id: 'n2', displayName: 'Leo Grant', chatId: 'c2' },
      ],
    });
    await searchFor([own, fresh, other]);
    expect($('find-add-picked')).toBeNull();
    await click($('find-pick-all'));
    expect($('find-add-picked')!.textContent).toContain('Add 2');
    await click($('find-add-picked'));
    expect(sourcing.addSourced).toHaveBeenCalledWith({ id: 'u1' }, ['r1', 'r2']);
    expect($$('find-open').map((a) => a.getAttribute('href'))).toEqual(['/people/n1', '/people/n2']);
    expect($('find-add-picked')).toBeNull();
  });

  it('a failed add says why and leaves the row as it was', async () => {
    sourcing.addSourced.mockResolvedValue({ ok: false, message: 'Orbit could not add them just now.' });
    await searchFor([fresh]);
    await click($('find-add'));
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('Orbit could not add them just now.');
    expect($('find-add')).not.toBeNull();
  });

  it('an address is looked up only on the tap, and the found one replaces the button', async () => {
    sourcing.findEmail.mockResolvedValue({
      ok: true,
      value: { email: 'maya@seedfund.vc', emailConfidence: 'verified', emailStatus: 'found' },
    });
    await searchFor([fresh]);
    expect(sourcing.findEmail).not.toHaveBeenCalled();
    await click($('find-email-lookup'));
    expect(sourcing.findEmail).toHaveBeenCalledWith({ id: 'u1' }, { recommendationId: 'r1' });
    expect($('find-email-lookup')).toBeNull();
    expect($('find-email')!.getAttribute('href')).toBe('mailto:maya@seedfund.vc');
    expect($('find-email')!.getAttribute('title')).toBe('maya@seedfund.vc');
  });

  it('someone already in Orbit with no address has the greyed logo too, and a click looks theirs up', async () => {
    sourcing.findEmail.mockResolvedValue({
      ok: true,
      value: { email: 'ana@accel.com', emailConfidence: 'pattern', emailStatus: 'found' },
    });
    await searchFor([own]);
    const lookup = $('find-email-lookup')!;
    expect(lookup.getAttribute('title')).toBe('Find their email');
    expect(lookup.querySelector('svg')!.getAttribute('class')).toContain('grayscale');
    await click(lookup);
    expect(sourcing.findEmail).toHaveBeenCalledWith({ id: 'u1' }, { personId: 'p1' });
    // found: the logo in colour, a link to write to them
    expect($('find-email')!.getAttribute('href')).toBe('mailto:ana@accel.com');
    expect($('find-email')!.querySelector('svg')!.getAttribute('class')).not.toContain('grayscale');
  });

  it('a miss says no email was found; someone with an address shows no lookup', async () => {
    sourcing.findEmail.mockResolvedValue({ ok: true, value: { emailStatus: 'not found' } });
    await searchFor([
      fresh,
      { ...other, email: 'leo@fund.vc', emailConfidence: 'guess', emailStatus: undefined },
    ]);
    expect($$('find-email-lookup')).toHaveLength(1);
    expect($('find-email')!.getAttribute('title')).toBe('leo@fund.vc (a guess, not confirmed)');
    await click($('find-email-lookup'));
    // still the greyed logo, and a click looks again
    expect($('find-email-none')!.getAttribute('aria-label')).toBe(
      'No email found for Maya Chen yet. Look again',
    );
    expect($('find-email-none')!.querySelector('svg')!.getAttribute('class')).toContain('grayscale');
    await click($('find-email-none'));
    expect(sourcing.findEmail).toHaveBeenCalledTimes(2);
  });
});
