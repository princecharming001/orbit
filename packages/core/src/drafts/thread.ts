/**
 * Where a thread stands, read from what is on record, so a draft never contradicts it: a bump never goes to someone
 * who has answered, a scheduling note never ignores the time they offered, and a months-old sign-off ("Good luck
 * with recruiting this fall") is not answered with "Thank you for the reply. Would either of these work?".
 */

export interface ThreadState {
  lastInboundBody?: string;
  lastInboundAt?: string;
  firstOutboundAt?: string;
  asksOfUser?: string[];
  proposedTimes?: { startIso: string; raw: string }[];
  lastSignal?: string;
  subject?: string;
}

const DAY = 86_400_000;

/** Signals that leave the student something to answer. */
const ANSWERABLE = new Set([
  'reply_positive',
  'scheduling_proposal',
  'scheduling_confirmation',
  'reschedule',
  'question',
  'referral_offer',
  'intro_offer',
]);

/**
 * Whether their last message still waits on an answer from the student: a question, a time, a yes that asked for
 * times, from the last three weeks. A sign-off ("Best of luck with the search"), a thanks, or a yes from months ago
 * waits on nothing; writing again then needs its own reason (a check-in), not a reply.
 */
export function inboundNeedsAnswer(t: ThreadState | undefined, now: Date): boolean {
  if (!t?.lastInboundAt) return false;
  if (t.asksOfUser?.length || t.proposedTimes?.length) return true;
  const age = now.getTime() - new Date(t.lastInboundAt).getTime();
  return ANSWERABLE.has(t.lastSignal ?? '') && age <= 21 * DAY;
}

/** They wrote back after the student's first note (an out-of-office or a bounce does not count as an answer). */
export function answeredAfterOutreach(t: ThreadState | undefined): boolean {
  if (!t?.lastInboundAt) return false;
  if (t.lastSignal === 'out_of_office') return false;
  if (!t.firstOutboundAt) return true;
  return new Date(t.lastInboundAt).getTime() > new Date(t.firstOutboundAt).getTime();
}

/** Their last line asked to hear how things turn out ("Keep me posted", "let me know where you end up"). */
export function askedForUpdate(body: string | undefined): boolean {
  return /\b(keep me (posted|updated|in the loop)|let me know (how|where|what) (it|things|you|recruiting)|let me know how it goes|keep in touch)\b/i.test(
    body ?? '',
  );
}

/**
 * What the thread is about, from the subject the student wrote ("Cornell junior, your move from design to PM" is about
 * "your move from design to PM"). Undefined for a subject that names no topic ("Cornell junior, quick question",
 * "Intro: Alex <> Theo").
 */
export function subjectTopic(subject: string | undefined): string | undefined {
  let s = (subject ?? '')
    .replace(/^\s*((re|fwd?|aw)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || /^(intro|introduction|introducing|connecting)\b/i.test(s) || /<>|\bmeet\b/i.test(s)) return undefined;
  const comma = s.indexOf(', ');
  if (comma > 0 && comma < 45) s = s.slice(comma + 2);
  s = s
    .replace(/,\s*(a |one )?(quick )?question (about|on)\b.*$/i, '')
    .replace(/^(a |one )?(quick |small )?(question|follow-up|note) (about|on|re)\s+/i, '')
    .replace(/^about\s+/i, '')
    .replace(/[?.!]+$/, '')
    .trim();
  if (!s || s.split(' ').length < 2 || s.length > 70) return undefined;
  if (
    /^(quick question|question|following up|follow up|checking in|thank you|thanks|congratulations|hello|hi)\b/i.test(
      s,
    )
  )
    return undefined;
  if (/\b(next steps|times? for|a small ask|process question|trying once more|update since)\b/i.test(s))
    return undefined;
  // "Ramp Software Engineering Intern: next steps" names a role, not something to talk about
  if (/:/.test(s)) return undefined;
  return s.charAt(0).toLowerCase() === s.charAt(0) || /^(Your|The)\b/.test(s)
    ? s.replace(/^(Your|The)\b/, (w) => w.toLowerCase())
    : s;
}
