import type { Person } from '../types';
import { engagedBothWays, isReciprocal } from './strength';

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
 * in (a newsletter, a cold pitch) is not history, and neither is someone who only reacts to the student's posts.
 */
/** A chat stage that means the student has actually been in touch: past "to contact" and the warm-up. */
export function contactedStage(stage: string | undefined): boolean {
  return !!stage && stage !== 'identified' && stage !== 'warming';
}

/**
 * The student has history with this person: a LinkedIn connection (or their export), mail or messages both ways, a
 * chat past "to contact", or a tie Orbit's server scored. Someone added by hand or saved from a LinkedIn search has
 * none until they talk: Orbit never says the student knows them.
 */
export function hasHistoryWith(
  p: Pick<Person, 'strengthBreakdown' | 'linkedinConnectedOn' | 'sources' | 'tieScore'>,
  opts: { contacted?: boolean } = {},
): boolean {
  if (opts.contacted || p.linkedinConnectedOn) return true;
  if (p.sources?.some((s) => s === 'tracker_import' || s === 'linkedin_csv')) return true;
  if (!p.strengthBreakdown && (p.tieScore ?? 0) > 0) return true;
  return isReciprocal(p.strengthBreakdown?.counts) || engagedBothWays(p.strengthBreakdown?.counts);
}

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
    | 'tieScore'
  >,
  opts: { hasChat?: boolean } = {},
): boolean {
  if (!p.isHuman || p.hiddenAt || !hasRealName(p)) return false;
  if (opts.hasChat || p.linkedinConnectedOn) return true;
  if (p.sources?.some((s) => s === 'manual' || s === 'tracker_import' || s === 'linkedin_csv')) return true;
  // kept on Orbit's server (account mode): the history lives there, and its tie score is the evidence
  if (!p.strengthBreakdown && (p.tieScore ?? 0) > 0) return true;
  // comments and reactions on LinkedIn posts count only when they go both ways or sit next to direct messages
  return isReciprocal(p.strengthBreakdown?.counts) || engagedBothWays(p.strengthBreakdown?.counts);
}
