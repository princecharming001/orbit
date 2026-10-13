/**
 * The People page's address: which view it shows and which filter it starts on. One page holds the board, the list
 * and the companies, so a link (from the chat, the map, an old bookmark) says which with `?view=` and `?f=`.
 */

import type { PeopleFilter } from '../../engine/search';

export type { PeopleFilter };
export type PeopleView = 'board' | 'list' | 'companies';

const VIEWS: PeopleView[] = ['board', 'list', 'companies'];
const FILTERS: PeopleFilter[] = ['all', 'alumni', 'strong', 'chats', 'targets', 'quiet', 'hidden'];

/** The view a People address asks for; the board when it names none (or an unknown one). */
export function peopleViewOf(params: URLSearchParams): PeopleView {
  const v = params.get('view');
  if (v === 'table') return 'list';
  return VIEWS.includes(v as PeopleView) ? (v as PeopleView) : 'board';
}

/** The filter a People address asks for: `f=` first, then the older `quiet=1`. */
export function peopleFilterOf(params: URLSearchParams): PeopleFilter {
  const f = params.get('f');
  if (FILTERS.includes(f as PeopleFilter)) return f as PeopleFilter;
  return params.get('quiet') === '1' ? 'quiet' : 'all';
}

/** A People address for this view and filter, leaving out what is already the default. */
export function peopleHref(view: PeopleView, filter: PeopleFilter = 'all'): string {
  const p = new URLSearchParams({ view });
  if (filter !== 'all') p.set('f', filter);
  return `/people?${p}`;
}
