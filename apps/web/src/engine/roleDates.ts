// How a role's dates read on a page: "Jun 2023 to Present · 2 yrs 5 mos". Shared by About's LinkedIn history and the
// Prep deck, so the two never disagree. Never an en dash between the dates.
import type { Affiliation } from '@orbit/core';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2023-06" → "Jun 2023", "2021" → "2021". */
export function monthYear(d: string | undefined): string | undefined {
  if (!d) return undefined;
  const m = /^(\d{4})(?:-(\d{1,2}))?/.exec(d);
  if (!m) return undefined;
  const month = m[2] ? MONTHS[Number(m[2]) - 1] : undefined;
  return month ? `${month} ${m[1]}` : m[1];
}

/** How long a stint lasted (or has lasted): "2 yrs 3 mos", "8 mos". */
export function stintLength(
  start: string | undefined,
  end: string | undefined,
  now: Date,
): string | undefined {
  const a = start ? /^(\d{4})(?:-(\d{1,2}))?/.exec(start) : null;
  if (!a) return undefined;
  const b = end ? /^(\d{4})(?:-(\d{1,2}))?/.exec(end) : null;
  const from = Number(a[1]) * 12 + (a[2] ? Number(a[2]) - 1 : 0);
  const to = b
    ? Number(b[1]) * 12 + (b[2] ? Number(b[2]) - 1 : 11)
    : now.getUTCFullYear() * 12 + now.getUTCMonth();
  const months = Math.max(1, to - from + 1);
  const y = Math.floor(months / 12);
  const mo = months % 12;
  return [y ? `${y} yr${y > 1 ? 's' : ''}` : '', mo ? `${mo} mo${mo > 1 ? 's' : ''}` : '']
    .filter(Boolean)
    .join(' ');
}

/** "Jun 2023 to Present" (no length). */
export function roleDates(a: Pick<Affiliation, 'startDate' | 'endDate' | 'isCurrent'>): string | undefined {
  const from = monthYear(a.startDate);
  const to = a.isCurrent ? 'Present' : a.endDate ? monthYear(a.endDate) : undefined;
  return from && to ? `${from} to ${to}` : (from ?? to);
}

/** "Jun 2023 to Present · 2 yrs 5 mos" for a job; the dates alone for a school. */
export function roleSpan(
  a: Pick<Affiliation, 'kind' | 'startDate' | 'endDate' | 'isCurrent'>,
  now: Date,
): string {
  const long =
    a.kind === 'employment' ? stintLength(a.startDate, a.isCurrent ? undefined : a.endDate, now) : undefined;
  return [roleDates(a), long].filter(Boolean).join(' · ');
}

/** Current roles first, then by when they started, newest first. */
export const byRecency = (x: Affiliation, y: Affiliation) =>
  Number(y.isCurrent) - Number(x.isCurrent) || (y.startDate ?? '').localeCompare(x.startDate ?? '');
