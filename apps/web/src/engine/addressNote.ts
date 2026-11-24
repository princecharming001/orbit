/**
 * What to say beside an address before a message goes to it, when Orbit found the address itself (plan 35 C3). An
 * address built from the company's pattern or guessed can still be written to, but the student is told it is not
 * confirmed, wherever the recipient is shown before a send. One a verifier refused is said to have failed. Nothing
 * is said of an address from the student's own mail or contacts, a verified one, or one read on a page.
 */
import type { Person } from '@orbit/core';

export const UNCONFIRMED_NOTE = 'Guessed address, not confirmed';
export const FAILED_NOTE = 'This address did not pass a check';

type Found = Pick<Person, 'emailConfidence' | 'primaryEmail'>;

/** The person's address is one Orbit built or guessed, and nothing has confirmed it. */
export function addressUnconfirmed(person: Pick<Person, 'emailConfidence'> | undefined): boolean {
  return person?.emailConfidence === 'pattern' || person?.emailConfidence === 'guess';
}

/**
 * The note for the address a message is going to. `to` is the address shown when the draft names its own: the note
 * is about the person's stored address, so a different one the student chose gets none.
 */
export function addressNote(person: Found | undefined, to?: string): string | undefined {
  if (!person?.primaryEmail) return undefined;
  if (to && to.trim().toLowerCase() !== person.primaryEmail.trim().toLowerCase()) return undefined;
  if (person.emailConfidence === 'invalid') return FAILED_NOTE;
  return addressUnconfirmed(person) ? UNCONFIRMED_NOTE : undefined;
}
