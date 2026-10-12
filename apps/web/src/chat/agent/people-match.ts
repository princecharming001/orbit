/**
 * Name matching for the no-key router, lifted from the CommandPalette's ranking: an exact name or first name first,
 * then a name that starts with what was typed ("Lena" finds Lena Novak before Elena Cohen), then a word in the name
 * that starts with it, then anything that contains it (name, company or title); closer people first within a rank.
 */
export interface MatchablePerson {
  id: string;
  displayName: string;
  firstName: string;
  lastName: string;
  currentOrganizationRaw?: string;
  currentTitle?: string;
  strength: number;
  isHuman: boolean;
  hiddenAt?: string;
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function rankPerson(p: MatchablePerson, query: string): number {
  const s = fold(query);
  const name = fold(p.displayName);
  if (!s) return 4;
  if (name === s || fold(p.firstName) === s || fold(p.lastName) === s) return 0;
  if (name.startsWith(s)) return 1;
  if (name.split(' ').some((w) => w.startsWith(s))) return 2;
  if (name.includes(s)) return 3;
  // "priya p" or "p patel": every typed word starts a word of the name
  const words = s.split(' ');
  if (words.length > 1 && words.every((q) => name.split(' ').some((w) => w.startsWith(q)))) return 2;
  return 4;
}

/** People that match, best first. Company and title matches rank last (4). */
export function matchPeople<P extends MatchablePerson>(people: P[], query: string): P[] {
  const s = fold(query);
  if (!s) return [];
  return people
    .filter((p) => p.isHuman && !p.hiddenAt)
    .filter(
      (p) =>
        rankPerson(p, s) < 4 ||
        fold(p.currentOrganizationRaw ?? '').includes(s) ||
        fold(p.currentTitle ?? '').includes(s),
    )
    .sort((a, b) => rankPerson(a, s) - rankPerson(b, s) || b.strength - a.strength);
}

/**
 * The one person a name means, when it is not ambiguous: a single match, or a single person at the best rank when
 * that rank is an exact name or a name prefix. Otherwise the candidates, for the student to pick from.
 */
export function resolvePerson<P extends MatchablePerson>(
  people: P[],
  query: string,
): { person?: P; candidates: P[] } {
  const candidates = matchPeople(people, query);
  if (!candidates.length) return { candidates };
  const best = rankPerson(candidates[0]!, query);
  // a company or title match (rank 4) never names one person: "Stripe" is not someone
  if (best >= 4) return { candidates: candidates.slice(0, 6) };
  if (candidates.length === 1) return { person: candidates[0], candidates };
  const atBest = candidates.filter((p) => rankPerson(p, query) === best);
  if (atBest.length === 1 && best <= 1) return { person: atBest[0], candidates };
  return { candidates: candidates.slice(0, 6) };
}
