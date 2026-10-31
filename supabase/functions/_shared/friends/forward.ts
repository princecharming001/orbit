/**
 * The forward (plan 29 §A4): when a friend says yes to an intro ask, Orbit writes the note the friend sends to their
 * own contact, with the asker's blurb quoted unchanged and the asker in cc, so a reply reaches the asker without the
 * contact's address ever crossing. The friend approves it like any draft; it never goes on its own and never on
 * LinkedIn. The shape follows plan 15 §2.12: the target by name, why the friend is passing it on, the blurb in
 * quotes, an out.
 */

export interface ForwardInput {
  /** the contact's first name */
  targetFirst: string;
  /** the asker, as the friend knows them */
  askerName: string;
  askerFirst: string;
  /** the forwardable blurb, the asker's own words */
  note: string;
  /** the friend's first name, the sign-off */
  meFirst: string;
}

export function forwardSubject(i: Pick<ForwardInput, 'askerFirst' | 'targetFirst'>): string {
  return `Intro: ${i.askerFirst} and ${i.targetFirst}`;
}

export function forwardBody(i: ForwardInput): string {
  const note = i.note.trim().replace(/^["“]+|["”]+$/g, '');
  return [
    `Hi ${i.targetFirst},`,
    `${i.askerName} asked me to put you two in touch. In their words:`,
    `"${note}"`,
    `Cc'ing ${i.askerFirst} so you two can take it from here. No pressure either way, and no need to reply to me.`,
    i.meFirst,
  ].join('\n\n');
}
