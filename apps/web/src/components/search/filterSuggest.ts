/**
 * What the search filters suggest as the student types: the values their own people already carry (most common
 * first, with how many), then the built-in lists. Everything stays free text: a suggestion is help, never the only
 * choice. Nothing here calls LinkedIn.
 */
import type { Person } from '@orbit/core';
import { suggestCompanies } from '../../data/companies';
import { INDUSTRY_OPTIONS, LOCATION_OPTIONS, ROLE_OPTIONS } from '../../data/options';
import { suggestSchools } from '../../data/schools';
import { db } from '../../db/schema';
import type { Suggestion } from '../../ui/Suggest';

export type FilterField = 'titles' | 'places' | 'companies' | 'schools' | 'keywords';

interface Counted {
  value: string;
  n: number;
}

const KEPT_MS = 60_000;
const kept = new Map<string, { at: number; rows: Promise<Person[]> }>();

function peopleOf(userId: string): Promise<Person[]> {
  const hit = kept.get(userId);
  if (hit && Date.now() - hit.at < KEPT_MS) return hit.rows;
  const rows = db.people
    .where('userId')
    .equals(userId)
    .filter((p) => !p.hiddenAt)
    .toArray()
    .catch(() => [] as Person[]);
  kept.set(userId, { at: Date.now(), rows });
  return rows;
}

/** for tests: forget the people read for suggestions */
export function forgetFilterSuggestions(): void {
  kept.clear();
}

const tidy = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

async function counted(userId: string, of: (p: Person) => string | undefined): Promise<Counted[]> {
  const out = new Map<string, Counted>();
  for (const p of await peopleOf(userId)) {
    const value = tidy(of(p));
    if (!value || value.length > 80) continue;
    const key = value.toLowerCase();
    const cur = out.get(key);
    if (cur) cur.n++;
    else out.set(key, { value, n: 1 });
  }
  return [...out.values()].sort((a, b) => b.n - a.n || a.value.localeCompare(b.value));
}

/** how well `value` answers what is typed: the start of it, the start of a word in it, or somewhere inside */
function score(value: string, q: string): number {
  const v = value.toLowerCase();
  if (!q) return 1;
  if (v.startsWith(q)) return 3;
  if (v.split(/[\s,/&()-]+/).some((w) => w.startsWith(q))) return 2;
  return v.includes(q) ? 1 : 0;
}

const known = (n: number) => `${n} ${n === 1 ? 'person' : 'people'} you know`;

/** the student's own values first, then the built-in list, best match first, no value twice */
function merge(mine: Counted[], listed: readonly string[], query: string, limit: number): Suggestion[] {
  const q = query.toLowerCase().trim();
  const rows: (Suggestion & { rank: number })[] = [];
  const seen = new Set<string>();
  const add = (value: string, rank: number, sub?: string) => {
    const key = value.toLowerCase();
    const s = score(value, q);
    if (!s || seen.has(key)) return;
    seen.add(key);
    rows.push({ value, sub, rank: s * 100 + rank });
  };
  for (const m of mine) add(m.value, 10 + Math.min(m.n, 9), known(m.n));
  for (const [i, value] of listed.entries()) add(value, Math.max(0, 9 - i * 0.01));
  return rows
    .sort((a, b) => b.rank - a.rank || a.value.length - b.value.length)
    .slice(0, limit)
    .map(({ rank: _rank, ...s }) => s);
}

const PLACES = LOCATION_OPTIONS.filter((p) => p !== 'Open to anywhere');

/**
 * Suggestions for one filter field. An empty query gives the common choices (the student's own network first), so
 * the field can be filled by picking alone.
 */
export async function suggestFilter(
  userId: string,
  field: FilterField,
  query: string,
  limit = 8,
): Promise<Suggestion[]> {
  const q = query.trim();
  if (field === 'titles') return merge(await counted(userId, (p) => p.currentTitle), ROLE_OPTIONS, q, limit);
  if (field === 'places') return merge(await counted(userId, (p) => p.location), PLACES, q, limit);
  if (field === 'keywords') return merge([], INDUSTRY_OPTIONS, q, limit);
  if (field === 'companies') {
    if (q) return suggestCompanies(q, [], limit);
    const mine = await counted(userId, (p) => p.currentOrganizationRaw);
    return mine.slice(0, limit).map((m) => ({ value: m.value, sub: `${known(m.n)} there` }));
  }
  // schools: the ones the student's people went to, then the full list once two letters are typed
  const mine = merge(await counted(userId, (p) => p.school), [], q, limit);
  if (q.length < 2) return mine;
  const listed = await suggestSchools(q, limit).catch(() => [] as Suggestion[]);
  const seen = new Set(mine.map((m) => m.value.toLowerCase()));
  return [...mine.slice(0, 3), ...listed.filter((s) => !seen.has(s.value.toLowerCase()))].slice(0, limit);
}
