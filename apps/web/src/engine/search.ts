import { interactionCount, normalizeCompany, type Person } from '@orbit/core';

/**
 * Rank people for a typed query the way the command palette does: an exact name (or first name) first, then a
 * name that starts with what was typed ("Lena" finds Lena Novak before Elena Cohen), then a word in the name that
 * starts with it, then anything else that contains it (name, company, title); closer people first within a rank.
 * An empty query lists the closest people.
 */
export function rankPeople<P extends Person>(people: P[], query: string, limit = 8): P[] {
  const s = query.trim().toLowerCase();
  const visible = people.filter((p) => p.isHuman && !p.hiddenAt);
  if (!s) return visible.sort((a, b) => b.strength - a.strength).slice(0, limit);
  const rank = (p: Person) => {
    const name = p.displayName.toLowerCase();
    if (name === s || p.firstName.toLowerCase() === s) return 0;
    if (name.startsWith(s)) return 1;
    if (name.split(/\s+/).some((w) => w.startsWith(s))) return 2;
    if (name.includes(s)) return 3;
    return 4;
  };
  return visible
    .filter(
      (p) =>
        p.displayName.toLowerCase().includes(s) ||
        (p.currentOrganizationRaw ?? '').toLowerCase().includes(s) ||
        (p.currentTitle ?? '').toLowerCase().includes(s),
    )
    .sort((a, b) => rank(a) - rank(b) || b.strength - a.strength)
    .slice(0, limit);
}

/**
 * When the student last actually dealt with them: a message, a meeting, a note. Becoming LinkedIn connections (the
 * date in the LinkedIn file) or sharing a CC line is not a touch.
 */
export function lastTouch(p: Person): string | undefined {
  const b = p.strengthBreakdown;
  if (!b) return p.lastInteractionAt;
  return b.lastConversationAt ?? (interactionCount(b.counts) > 0 ? p.lastInteractionAt : undefined);
}

export type PeopleFilter = 'all' | 'alumni' | 'strong' | 'chats' | 'targets' | 'quiet' | 'hidden';
export type PeopleSort = 'strength' | 'recent' | 'name';

/**
 * The People page's list: search, one filter, one sort. `activeChat` is the people with a non-archived chat, `quiet`
 * the people whose chat went quiet. A target company matches by its name as typed or normalized ("McKinsey" covers
 * "McKinsey & Company").
 */
export function filterPeople<P extends Person>(
  people: P[],
  opts: {
    query?: string;
    filter?: PeopleFilter;
    sort?: PeopleSort;
    activeChat: Set<string>;
    targetNames: Set<string>;
    quiet?: Set<string>;
  },
): P[] {
  const s = (opts.query ?? '').trim().toLowerCase();
  const filter = opts.filter ?? 'all';
  const sort = opts.sort ?? 'strength';
  return people
    .filter((p) => (filter === 'hidden' ? !!p.hiddenAt : p.isHuman && !p.hiddenAt))
    .filter(
      (p) =>
        !s ||
        p.displayName.toLowerCase().includes(s) ||
        (p.currentOrganizationRaw ?? '').toLowerCase().includes(s) ||
        (p.currentTitle ?? '').toLowerCase().includes(s) ||
        (p.primaryEmail ?? '').includes(s),
    )
    .filter((p) =>
      filter === 'alumni'
        ? p.isAlumni
        : filter === 'strong'
          ? p.strength >= 0.6
          : filter === 'chats'
            ? opts.activeChat.has(p.id)
            : filter === 'targets'
              ? opts.targetNames.has((p.currentOrganizationRaw ?? '').toLowerCase()) ||
                (!!p.currentOrganizationRaw &&
                  opts.targetNames.has(normalizeCompany(p.currentOrganizationRaw)))
              : filter === 'quiet'
                ? !!opts.quiet?.has(p.id)
                : true,
    )
    .sort((a, b) =>
      sort === 'strength'
        ? b.strength - a.strength
        : sort === 'recent'
          ? (lastTouch(b) ?? '').localeCompare(lastTouch(a) ?? '')
          : a.displayName.localeCompare(b.displayName),
    );
}
