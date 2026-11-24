/**
 * Find people as a table: one sentence is read into filters and criteria, the results list the student's own people
 * and new ones together with a match, a path and an answer per criterion; the two dialogs change the search and run
 * it again; a new person is saved alone or with others, or, when the student's LinkedIn can send, asked to connect
 * with one click (the button says which); an address is looked up only when asked (plan 35 C3).
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
const sourcing = vi.hoisted(() => ({
  findEmail: vi.fn(),
  addSourced: vi.fn(),
  connectSourced: vi.fn(),
  canConnectOnLinkedIn: vi.fn(),
  requestsWaiting: vi.fn(),
}));
const hints = vi.hoisted(() => ({ suggestFilter: vi.fn() }));
const batch = vi.hoisted(() => ({ createBatch: vi.fn() }));
vi.mock('../../engine/batch', () => batch);
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

import { readPeopleTable } from '../../chat/ui/cards/shapes';
import { ToastProvider } from '../../ui';
import { carryFindPeople, FindPeople } from './FindPeople';

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
  // LinkedIn cannot send unless a test says it can: the button on someone new is Save
  sourcing.canConnectOnLinkedIn.mockResolvedValue(false);
  sourcing.requestsWaiting.mockResolvedValue(new Set());
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
        <ToastProvider>
          <FindPeople userId="u1" />
        </ToastProvider>
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
      'Connect or save',
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
    // someone the student already has is never offered Connect or Save; they can be picked like anyone, and start unpicked
    expect($('find-add', a!)).toBeNull();
    expect(($('find-pick', a!) as HTMLInputElement).checked).toBe(false);
    // the company opens its page in Orbit, or who the student knows there when Orbit has no page for it
    expect($('find-company', a!)!.getAttribute('href')).toBe('/map?reach=1&company=Accel');
    // the new person: a path through someone warm, a dash where nothing is known, and the button (Save here)
    expect(b!.dataset.own).toBe('false');
    expect($('find-name', b!)!.tagName).toBe('SPAN');
    expect($('result-path', b!)!.textContent).toContain('Sam Warm');
    expect($('find-thumb', b!)!.dataset.answer).toBe('unknown');
    expect($('find-add', b!)).not.toBeNull();
    expect($('find-split')!.textContent).toBe('1 you already know, 1 new.');
  });

  it('a row says who they are under their name, and the path names who to go through and why', async () => {
    await searchFor([
      {
        ...fresh,
        headline: 'Seed investor. First cheques into developer tools.',
        path: {
          kind: 'intro',
          label: 'Sam Warm',
          personId: 'p9',
          level: 1,
          note: 'Sam, a connection of yours, works at Seed Fund',
        },
      },
      {
        ...other,
        path: { kind: 'shared', label: 'Also from UC Berkeley', level: 1, note: 'Also from UC Berkeley' },
      },
    ]);
    const rows = [...document.querySelectorAll('[data-testid="find-result"]')];
    const first = rows[0] as HTMLElement;
    const second = rows[1] as HTMLElement;
    const inside = (el: HTMLElement, id: string) =>
      el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    expect(inside(first, 'find-headline')!.textContent).toBe(
      'Seed investor. First cheques into developer tools.',
    );
    // no headline, no second line
    expect(inside(second, 'find-headline')).toBeNull();
    const via = inside(first, 'result-path')!;
    expect(via.getAttribute('data-kind')).toBe('intro');
    expect(via.textContent).toContain('Sam Warm');
    expect(via.querySelector('a')!.getAttribute('href')).toBe('/people/p9');
    expect(via.querySelector('a')!.getAttribute('title')).toContain(
      'Sam, a connection of yours, works at Seed Fund',
    );
    const shared = inside(second, 'result-path')!;
    expect(shared.getAttribute('data-kind')).toBe('shared');
    expect(shared.textContent).toContain('Also from UC Berkeley');
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

describe('Find people: the search is still there after the page was away', () => {
  const mount = () =>
    act(async () => {
      root.render(
        <MemoryRouter>
          <FindPeople userId="u1" />
        </MemoryRouter>,
      );
    });
  // leaving the tab or opening someone's page unmounts the component; coming back mounts a new one
  const leave = () => {
    act(() => root.unmount());
    root = createRoot(host);
  };

  it('back from a profile, or back to the tab: the sentence, the rows, the picks and what was added', async () => {
    sourcing.addSourced.mockResolvedValue({ ok: true, people: [{ id: 'p77' }] });
    await searchFor([own, fresh, other]);
    await click($('find-add', $$('find-result')[1]!));
    await click($('find-pick', $$('find-result')[2]!));
    expect(search.runPeopleSearch).toHaveBeenCalledTimes(1);

    leave();
    await mount();
    // nothing is searched again: what was on the page is on the page
    expect(search.runPeopleSearch).toHaveBeenCalledTimes(1);
    expect(search.interpretAsk).toHaveBeenCalledTimes(1);
    expect(($('find-query') as HTMLInputElement).value).toBe('seed investors');
    expect($$('find-result').map((r) => $('find-name', r)?.textContent)).toEqual([
      'Ana Own',
      'Maya Chen',
      'Leo Grant',
    ]);
    expect($('find-count')?.textContent).toBe('3 matches');
    expect($('find-tools')).not.toBeNull();
    expect($('find-open', $$('find-result')[1]!)?.getAttribute('href')).toBe('/people/p77');
    expect($('find-add-picked')?.textContent).toContain('Save 1');
  });

  it('a search still running when the student left goes on, and its rows are there on return', async () => {
    let finish: (r: PeopleSearchResult) => void = () => {};
    search.runPeopleSearch.mockReturnValue(new Promise<PeopleSearchResult>((res) => (finish = res)));
    await mount();
    await type($('find-query') as HTMLInputElement, 'seed investors');
    await click($('find-search'));
    expect($('find-busy')).not.toBeNull();

    // to "Your network" and back while it loads: still loading, the same search, not a second one
    leave();
    await mount();
    expect($('find-busy')?.textContent).toMatch(/Searching/);
    expect(($('find-query') as HTMLInputElement).value).toBe('seed investors');
    expect(search.runPeopleSearch).toHaveBeenCalledTimes(1);

    // it finishes while the page is away
    leave();
    await act(async () => finish(result([own, fresh])));
    await mount();
    expect($('find-busy')).toBeNull();
    expect($$('find-result')).toHaveLength(2);
    expect(search.runPeopleSearch).toHaveBeenCalledTimes(1);
  });

  it("one person's search is never shown to another", async () => {
    await searchFor([own]);
    leave();
    await act(async () => {
      root.render(
        <MemoryRouter>
          <FindPeople userId="u2" />
        </MemoryRouter>,
      );
    });
    expect(($('find-query') as HTMLInputElement).value).toBe('');
    expect($$('find-result')).toHaveLength(0);
  });
});

describe('Find people inside a chat card: a search that already ran', () => {
  const seed = { query: 'seed investors', result: result([own, fresh, other]) };
  const mountCard = () =>
    act(async () => {
      root.render(
        <MemoryRouter>
          <FindPeople userId="u1" storeKey="chat-find:tool-1" seed={seed} embedded />
        </MemoryRouter>,
      );
    });

  it('shows the table as it came back, with no second search and no search box of its own', async () => {
    await mountCard();
    expect(search.runPeopleSearch).not.toHaveBeenCalled();
    expect(search.interpretAsk).not.toHaveBeenCalled();
    expect($$('find-result').map((r) => $('find-name', r)?.textContent)).toEqual([
      'Ana Own',
      'Maya Chen',
      'Leo Grant',
    ]);
    expect($('find-count')?.textContent).toBe('3 matches');
    // the sentence was said in the chat: the box is not shown, the filters and criteria still are
    expect(($('find-query') as HTMLInputElement).closest('form')!.className).toContain('hidden');
    expect($('find-filters')).not.toBeNull();
    expect($('find-criteria')).not.toBeNull();
  });

  it('works like the one in Discover: add, pick, and a filter change searches again in place', async () => {
    sourcing.addSourced.mockResolvedValue({ ok: true, people: [{ id: 'p77' }] });
    search.runPeopleSearch.mockResolvedValue(result([own]));
    await mountCard();
    await click($('find-add', $$('find-result')[1]!));
    expect($('find-open', $$('find-result')[1]!)?.getAttribute('href')).toBe('/people/p77');
    await click($$('find-pick')[0]!);
    expect($('find-picked')!.textContent).toContain('1 picked');
    await click($('find-criteria'));
    await click($('criteria-save'));
    expect(search.runPeopleSearch).toHaveBeenCalledTimes(1);
    expect($$('find-result')).toHaveLength(1);
  });

  it('two cards keep their own tables, and neither is Discover’s', async () => {
    await mountCard();
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <FindPeople
            userId="u1"
            storeKey="chat-find:tool-2"
            seed={{ query: 'designers', result: result([other]) }}
            embedded
          />
          <FindPeople userId="u1" />
        </MemoryRouter>,
      );
    });
    expect($$('find-result').map((r) => $('find-name', r)?.textContent)).toEqual(['Leo Grant']);
    expect($$('find-people')).toHaveLength(2);
  });

  it('"Discover" opens the same search there, picks and added people and all', async () => {
    sourcing.addSourced.mockResolvedValue({ ok: true, people: [{ id: 'p77' }] });
    await mountCard();
    await click($('find-add', $$('find-result')[1]!));
    await click($$('find-pick')[2]!);
    carryFindPeople('chat-find:tool-1', 'u1', seed);
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <FindPeople userId="u1" />
        </MemoryRouter>,
      );
    });
    expect(($('find-query') as HTMLInputElement).value).toBe('seed investors');
    expect(($('find-query') as HTMLInputElement).closest('form')!.className).not.toContain('hidden');
    expect($$('find-result')).toHaveLength(3);
    expect($('find-open', $$('find-result')[1]!)?.getAttribute('href')).toBe('/people/p77');
    expect($('find-picked')!.textContent).toContain('1 picked');
    expect(search.runPeopleSearch).not.toHaveBeenCalled();
  });

  it('a card never opened in this visit still carries its search to Discover from what the message kept', async () => {
    carryFindPeople('chat-find:never-mounted', 'u1', seed);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <FindPeople userId="u1" />
        </MemoryRouter>,
      );
    });
    expect($$('find-result')).toHaveLength(3);
  });

  it('what the message keeps is read back as the table, and anything else is not one', () => {
    const kept = JSON.parse(JSON.stringify({ ui: { items: [], table: seed }, forModel: {} }));
    const back = readPeopleTable(kept)!;
    expect(back.query).toBe('seed investors');
    expect(back.result.rows.map((r) => r.name)).toEqual(['Ana Own', 'Maya Chen', 'Leo Grant']);
    expect(back.result.form.criteria[0]!.text).toBe('Works at a venture capital firm');
    expect(readPeopleTable({ ui: { items: [] }, forModel: {} })).toBeUndefined();
    expect(
      readPeopleTable({ ui: { table: { query: 'x', result: { rows: [], form: FORM } } } }),
    ).toBeUndefined();
    expect(
      readPeopleTable({ ui: { table: { query: 'x', result: { rows: [{ nope: 1 }], form: FORM } } } }),
    ).toBeUndefined();
    expect(readPeopleTable(undefined)).toBeUndefined();
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

  it('Save puts one person in People, says so, and the row then opens their page', async () => {
    sourcing.addSourced.mockResolvedValue({
      ok: true,
      people: [{ id: 'new1', displayName: 'Maya Chen', chatId: 'c' }],
    });
    await searchFor([own, fresh]);
    // LinkedIn cannot send here: the button says Save, and saving is all it does
    expect($('find-add')!.textContent!.trim()).toBe('Save');
    expect($('find-add')!.getAttribute('data-action')).toBe('save');
    await click($('find-add'));
    expect(sourcing.addSourced).toHaveBeenCalledWith({ id: 'u1' }, ['r1']);
    expect(sourcing.connectSourced).not.toHaveBeenCalled();
    const row = $$('find-result')[1]!;
    expect($('find-add', row)).toBeNull();
    expect($('find-open', row)!.textContent).toBe('Saved, open');
    expect($('find-open', row)!.getAttribute('data-state')).toBe('saved');
    expect($('find-open', row)!.getAttribute('href')).toBe('/people/new1');
    expect($('find-name', row)!.getAttribute('href')).toBe('/people/new1');
    expect($('toasts')!.textContent).toContain('Saved Maya Chen to People.');
    // the old words are gone: nothing says "added" or "to contact"
    expect(document.body.textContent).not.toMatch(/Added|to contact/i);
  });

  const li = (r: ResultRow, slug: string): ResultRow => ({
    ...r,
    linkedinUrl: `https://www.linkedin.com/in/${slug}`,
  });
  const sentTo = (id: string, name: string) => ({
    ok: true,
    person: { id, displayName: name, chatId: `c-${id}` },
    sent: true,
    requested: true,
  });

  it('the button says what it does: Connect when LinkedIn can send to them, Save when it cannot', async () => {
    sourcing.canConnectOnLinkedIn.mockResolvedValue(true);
    await searchFor([
      own,
      li(fresh, 'maya-chen'),
      // no LinkedIn profile on the row: nothing to send a request to
      other,
      // already a 1st-degree connection on LinkedIn: nothing to request
      { ...li(other, 'cy-near'), key: 'r:r3', recommendationId: 'r3', name: 'Cy Near', connected: true },
    ]);
    expect(sourcing.canConnectOnLinkedIn).toHaveBeenCalledWith({ id: 'u1' });
    const rows = $$('find-result');
    // someone the student already has gets no button at all
    expect($('find-add', rows[0]!)).toBeNull();
    expect($('find-add', rows[1]!)!.textContent!.trim()).toBe('Connect');
    expect($('find-add', rows[1]!)!.getAttribute('data-action')).toBe('connect');
    expect($('find-add', rows[2]!)!.textContent!.trim()).toBe('Save');
    expect($('find-add', rows[3]!)!.textContent!.trim()).toBe('Save');
    expect($('find-add', rows[3]!)!.getAttribute('data-action')).toBe('save');
  });

  it('LinkedIn not connected, paused or signed out: every button is Save', async () => {
    sourcing.canConnectOnLinkedIn.mockResolvedValue(false);
    await searchFor([li(fresh, 'maya-chen'), li(other, 'leo-grant')]);
    expect($$('find-add').map((b) => b.textContent!.trim())).toEqual(['Save', 'Save']);
  });

  it('Connect sends one request and saves them: the row reads "Request sent, open"', async () => {
    sourcing.canConnectOnLinkedIn.mockResolvedValue(true);
    sourcing.connectSourced.mockResolvedValue(sentTo('new1', 'Maya Chen'));
    await searchFor([own, li(fresh, 'maya-chen')]);
    await click($('find-add'));
    expect(sourcing.connectSourced).toHaveBeenCalledTimes(1);
    expect(sourcing.connectSourced).toHaveBeenCalledWith({ id: 'u1' }, 'r1');
    // Connect is its own call: nothing is saved a second time through Save
    expect(sourcing.addSourced).not.toHaveBeenCalled();
    const row = $$('find-result')[1]!;
    expect($('find-add', row)).toBeNull();
    expect($('find-open', row)!.textContent).toBe('Request sent, open');
    expect($('find-open', row)!.getAttribute('data-state')).toBe('requested');
    expect($('find-open', row)!.getAttribute('href')).toBe('/people/new1');
    expect($('find-name', row)!.getAttribute('href')).toBe('/people/new1');
    expect($('toasts')!.textContent).toContain('Connection request sent to Maya Chen. Saved to People.');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('two fast clicks on Connect send one call', async () => {
    sourcing.canConnectOnLinkedIn.mockResolvedValue(true);
    let finish: (v: unknown) => void = () => {};
    sourcing.connectSourced.mockReturnValue(new Promise((res) => (finish = res)));
    await searchFor([li(fresh, 'maya-chen')]);
    const button = $('find-add')!;
    // both clicks land before the screen has drawn the button as busy
    await act(async () => {
      button.click();
      button.click();
    });
    expect(sourcing.connectSourced).toHaveBeenCalledTimes(1);
    expect(($('find-add') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish(sentTo('new1', 'Maya Chen')));
    expect($('find-open')!.textContent).toBe('Request sent, open');
    expect(sourcing.connectSourced).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['weekly_limit', "LinkedIn's weekly limit on connection requests is reached. Saved to People instead."],
    ['profile_not_found', 'LinkedIn could not find their profile. Saved to People instead.'],
    ['linkedin_not_active', 'LinkedIn is paused because you were away. Saved to People instead.'],
  ])(
    'LinkedIn refuses (%s): the reason is said in its own words and the row falls back to saved',
    async (code, reason) => {
      sourcing.canConnectOnLinkedIn.mockResolvedValue(true);
      sourcing.connectSourced.mockResolvedValue({
        ok: true,
        person: { id: 'new1', displayName: 'Maya Chen', chatId: 'c' },
        sent: false,
        requested: false,
        code,
        reason,
      });
      await searchFor([li(fresh, 'maya-chen')]);
      await click($('find-add'));
      // said at once, exactly as the server said it
      expect($('toasts')!.textContent).toContain(reason);
      const row = $$('find-result')[0]!;
      // saved, never shown as a request that went
      expect($('find-open', row)!.textContent).toBe('Saved, open');
      expect($('find-open', row)!.getAttribute('data-state')).toBe('saved');
      expect($('find-open', row)!.getAttribute('href')).toBe('/people/new1');
      // and it stays on the row after the toast has gone
      expect($('find-open', row)!.getAttribute('title')).toBe(reason);
      // no button is left to press a second time
      expect($('find-add', row)).toBeNull();
    },
  );

  it('a request already out is not sent again: the row reads "Request sent, open"', async () => {
    sourcing.canConnectOnLinkedIn.mockResolvedValue(true);
    sourcing.connectSourced.mockResolvedValue({
      ok: true,
      person: { id: 'new1', displayName: 'Maya Chen', chatId: 'c' },
      sent: false,
      requested: true,
      code: 'already_requested',
      reason: 'You already sent them a connection request. Saved to People.',
    });
    await searchFor([li(fresh, 'maya-chen')]);
    await click($('find-add'));
    expect($('find-open')!.textContent).toBe('Request sent, open');
    expect($('toasts')!.textContent).toContain('You already sent them a connection request.');
  });

  it('Connect that could not reach Orbit says why and leaves the button, for one more try', async () => {
    sourcing.canConnectOnLinkedIn.mockResolvedValue(true);
    sourcing.connectSourced.mockResolvedValue({
      ok: false,
      message: 'Orbit could not be reached. Try again.',
    });
    await searchFor([li(fresh, 'maya-chen')]);
    await click($('find-add'));
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('Orbit could not be reached. Try again.');
    expect($('find-add')!.textContent!.trim()).toBe('Connect');
    expect(($('find-add') as HTMLButtonElement).disabled).toBe(false);
    expect($('find-open')).toBeNull();
  });

  it('someone the student already has with a request still waiting says "Request sent", with no button', async () => {
    sourcing.canConnectOnLinkedIn.mockResolvedValue(true);
    sourcing.requestsWaiting.mockResolvedValue(new Set(['p1']));
    await searchFor([own, { ...own, key: 'p:p2', personId: 'p2', name: 'Bo Own' }]);
    expect(sourcing.requestsWaiting).toHaveBeenCalledWith(['p1', 'p2']);
    const rows = $$('find-result');
    expect($('find-requested', rows[0]!)!.textContent).toBe('Request sent');
    expect($('find-add', rows[0]!)).toBeNull();
    // a connection, or someone never asked, shows nothing there
    expect($('find-requested', rows[1]!)).toBeNull();
    expect($('find-add', rows[1]!)).toBeNull();
  });

  it('Save 2 and Write to the picked only ever save, even when Connect is on the rows', async () => {
    sourcing.canConnectOnLinkedIn.mockResolvedValue(true);
    sourcing.addSourced.mockResolvedValue({
      ok: true,
      people: [
        { id: 'n1', displayName: 'Maya Chen', chatId: 'c1' },
        { id: 'n2', displayName: 'Leo Grant', chatId: 'c2' },
      ],
    });
    await searchFor([li(fresh, 'maya-chen'), li(other, 'leo-grant')]);
    expect($$('find-add').map((b) => b.textContent!.trim())).toEqual(['Connect', 'Connect']);
    await click($('find-pick-all'));
    await click($('find-add-picked'));
    expect(sourcing.addSourced).toHaveBeenCalledWith({ id: 'u1' }, ['r1', 'r2']);
    expect(sourcing.connectSourced).not.toHaveBeenCalled();
    expect($$('find-open').map((a) => a.textContent)).toEqual(['Saved, open', 'Saved, open']);
    expect($('toasts')!.textContent).toContain('Saved Maya Chen and Leo Grant to People.');
  });

  it('picking everyone new and Save 2 saves them in one go, each row to its own person', async () => {
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
    expect($('find-add-picked')!.textContent).toContain('Save 2');
    await click($('find-add-picked'));
    expect(sourcing.addSourced).toHaveBeenCalledWith({ id: 'u1' }, ['r1', 'r2']);
    expect($$('find-open').map((a) => a.getAttribute('href'))).toEqual(['/people/n1', '/people/n2']);
    expect($('find-add-picked')).toBeNull();
  });

  it('nobody starts picked, whoever they are; any row can be picked and the count says how many', async () => {
    await searchFor([own, { ...own, key: 'p:p2', personId: 'p2', name: 'Bo Own', companyId: 'o1' }, fresh]);
    expect($$('find-pick').map((b) => (b as HTMLInputElement).checked)).toEqual([false, false, false]);
    expect(($('find-pick-all') as HTMLInputElement).checked).toBe(false);
    expect($('find-picked')).toBeNull();
    // nothing in the first column looks like a tick until the student makes one
    expect($$('find-result').every((r) => r.querySelector('td svg.lucide-check') === null)).toBe(true);
    expect($('find-company', $$('find-result')[1]!)!.getAttribute('href')).toBe('/companies/o1');
    await click($$('find-pick')[0]!);
    expect($$('find-pick').map((b) => (b as HTMLInputElement).checked)).toEqual([true, false, false]);
    expect($('find-picked')!.textContent).toContain('1 picked');
    // someone already in Orbit is never offered Save, picked or not
    expect($('find-add-picked')).toBeNull();
    await click($('find-pick-clear'));
    expect($$('find-pick').map((b) => (b as HTMLInputElement).checked)).toEqual([false, false, false]);
  });

  it('Shift-click picks everyone from the last row clicked to this one, and unpicks a range the same way', async () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map(
      (k): ResultRow => ({ ...own, key: `p:${k}`, personId: k, name: `Person ${k.toUpperCase()}` }),
    );
    await searchFor(five);
    const picks = () => $$('find-pick').map((b) => (b as HTMLInputElement).checked);
    const shiftClick = (el: Element) =>
      act(async () => {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
      });
    await click($$('find-pick')[1]!);
    await shiftClick($$('find-pick')[3]!);
    expect(picks()).toEqual([false, true, true, true, false]);
    expect($('find-picked')!.textContent).toContain('3 picked');
    // upward works too, from the row last clicked
    await shiftClick($$('find-pick')[0]!);
    expect(picks()).toEqual([true, true, true, true, false]);
    // a Shift-click on a picked row unpicks the range back to the last one clicked, that one included
    await click($$('find-pick')[4]!);
    await shiftClick($$('find-pick')[2]!);
    expect(picks()).toEqual([true, true, false, false, false]);
    // the box in the header picks everyone, then no one
    await click($('find-pick-all'));
    expect(picks()).toEqual([true, true, true, true, true]);
    await click($('find-pick-all'));
    expect(picks()).toEqual([false, false, false, false, false]);
  });

  it('Write to the picked: new people are saved first, and everyone goes to Send to many in the order shown', async () => {
    sourcing.addSourced.mockResolvedValue({ ok: true, people: [{ id: 'n1', displayName: 'Maya Chen' }] });
    batch.createBatch.mockResolvedValue({ id: 'b7' });
    await searchFor([own, fresh, other]);
    await click($$('find-pick')[0]!);
    await click($$('find-pick')[1]!);
    expect($('find-write-picked')!.textContent).toContain('Write to 2');
    await click($('find-write-picked'));
    expect(sourcing.addSourced).toHaveBeenCalledWith({ id: 'u1' }, ['r1']);
    expect(batch.createBatch).toHaveBeenCalledWith({ id: 'u1', school: 'Berkeley' }, ['p1', 'n1']);
  });

  it('Write to the picked stops when a new person could not be added, and says why', async () => {
    sourcing.addSourced.mockResolvedValue({ ok: false, message: 'Orbit could not add them just now.' });
    await searchFor([fresh]);
    await click($$('find-pick')[0]!);
    await click($('find-write-picked'));
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('Orbit could not add them just now.');
    expect(batch.createBatch).not.toHaveBeenCalled();
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
