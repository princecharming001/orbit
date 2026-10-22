import type { Person } from '../types';
import { isReciprocal } from './strength';

/** A name part a person really has: two letters or more, letters only (and the odd apostrophe, dash or dot). */
const NAME_PART = /^[\p{L}][\p{L}'’.-]*[\p{L}]$/u;

/**
 * Orbit knows this person's name: a first and a last name made of letters. An address handle ("z.tech4future"), an
 * initial ("Y") or a team name with digits is not someone the student can be said to know.
 */
export function hasRealName(p: Pick<Person, 'firstName' | 'lastName' | 'displayName'>): boolean {
  const first = (p.firstName ?? '').trim();
  const last = (p.lastName ?? '').trim();
  if (!first || !last || /[@\d_]/.test(p.displayName ?? '')) return false;
  return (
    first.split(/\s+/).every((w) => NAME_PART.test(w)) && last.split(/\s+/).every((w) => NAME_PART.test(w))
  );
}

/**
 * Someone the student actually knows: named, and with real history: they wrote to each other, met, were introduced,
 * are connected on LinkedIn, or the student added them or is working on a chat with them. Mail that only ever came
 * in (a newsletter, a cold pitch) is not history.
 */
export function isKnownContact(
  p: Pick<
    Person,
    | 'firstName'
    | 'lastName'
    | 'displayName'
    | 'isHuman'
    | 'hiddenAt'
    | 'strengthBreakdown'
    | 'linkedinConnectedOn'
    | 'sources'
  >,
  opts: { hasChat?: boolean } = {},
): boolean {
  if (!p.isHuman || p.hiddenAt || !hasRealName(p)) return false;
  if (opts.hasChat || p.linkedinConnectedOn) return true;
  if (p.sources?.some((s) => s === 'manual' || s === 'tracker_import' || s === 'linkedin_csv')) return true;
  return isReciprocal(p.strengthBreakdown?.counts);
}
