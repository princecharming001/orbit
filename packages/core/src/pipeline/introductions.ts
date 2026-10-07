import type { EmailMessage, Person } from '../types';

/**
 * Wording that introduces people whoever it names ("introducing you to", "Intro: Alex <> Sana", "you two should
 * talk", "putting you in touch", "making the introduction"). "Introduce" counts only when it is aimed at people
 * ("introduce you", "introducing you two"): "an introduction to the program" or "we introduced a new program" is not
 * one. "Meet" alone is not one either: "great to meet you both" and "Sana and I would love to meet with you" are not
 * introductions, so "meet" and "introduce" followed by a name count only next to the person introduced (see
 * `introducesByName`).
 */
const INTRO_CUE =
  /\b(introduc(?:e|es|ed|ing) (?:you\b|y'all\b|both of you\b|the two of you\b|each other\b)|(?<!\b(?:for|thanks|thank you) )(?:make|makes|making|made|do|doing) (?:an? |the |this )?(?:quick |brief |virtual |warm |e-?mail )?intro(?:duction)?s?\b|(?:quick|brief|virtual|warm|e-?mail) introduction|(?<!\bfor (?:the |this |an? |your )?)intro\b(?! (?:call|chat|meeting|session|class|course|video|to (?:the|our|my|a|an|this|that|your)\b))|connect(?:ing)? (?:you (?:two|both|with)|the two of you)|you two should|you should (?:talk|meet|connect)|put(?:ting)? you (?:two |both )?in touch)/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * "Alex, meet Sana", "I'd like you to meet Sana", "Meet Sana, who...", "Sana, meet Alex", or "I'd like to introduce
 * Sana": the meet points at the person, never "meet with you", "meet Thursday", "great to meet you" or "did you get
 * to meet Sana at the fair?".
 */
function introducesByName(body: string, cap: string): boolean {
  const name = escapeRe(cap);
  return (
    new RegExp(
      `(?:^|[.!?;:]\\s+|,\\s*|\\byou(?: two| both)? (?:to|should|must|have to|need to|ought to) |\\bplease )[Mm]eet ${name}\\b`,
      'm',
    ).test(body) ||
    new RegExp(`\\b${name}(?: [A-Z][\\p{L}'-]+)?, meet \\p{Lu}`, 'u').test(body) ||
    new RegExp(`\\b(?:[Ii]ntroduc(?:e|es|ed|ing)|[Ii]ntroduction to) ${name}\\b`).test(body)
  );
}

export interface Introduction {
  /** the person who wrote the introduction */
  introducerId: string;
  /** the people introduced to the student (on the To or CC line and named in the message) */
  introducedIds: string[];
  messageId: string;
  at: string;
}

/**
 * Whether an inbound group email introduces the student to someone: a human sender, the student on the To or CC
 * line, at least one other known person on it too, and introduction wording that names that person: an
 * introducing phrase anywhere plus their name in the message, or "meet" pointed at their name ("Alex, meet Sana",
 * "Sana, meet Alex"). A CC alone is not an introduction, and neither is "meet" used for meeting ("Sana and I would
 * love to meet with you", "great to meet you both"); the sender has to say who they are bringing in.
 */
export function detectIntroduction(
  msg: Pick<
    EmailMessage,
    | 'id'
    | 'direction'
    | 'isAutomated'
    | 'fromPersonId'
    | 'fromEmail'
    | 'toEmails'
    | 'ccEmails'
    | 'subject'
    | 'bodyText'
    | 'sentAt'
  >,
  people: Pick<Person, 'id' | 'firstName' | 'emails' | 'isHuman'>[],
  userEmails: string[],
): Introduction | undefined {
  if (msg.direction !== 'inbound' || msg.isAutomated || !msg.fromPersonId) return undefined;
  const lower = (e: string) => e.trim().toLowerCase();
  const mine = new Set(userEmails.map(lower));
  const recipients = [...msg.toEmails, ...msg.ccEmails].map(lower).filter(Boolean);
  if (!recipients.some((e) => mine.has(e))) return undefined;
  // a reply's subject is the thread's ("Re: Intro: Alex <> Sana"): only a new subject can carry the cue, so the
  // answers in an intro thread are not read as introductions of their own
  const subject = /^\s*(?:re|aw|sv)\s*:/i.test(msg.subject ?? '') ? '' : (msg.subject ?? '');
  const text = `${subject}\n${msg.bodyText}`;
  const cued = INTRO_CUE.test(text);
  const others = recipients.filter((e) => !mine.has(e) && e !== lower(msg.fromEmail));
  const introducedIds: string[] = [];
  for (const e of others) {
    const p = people.find((x) => x.emails.some((y) => lower(y) === e));
    if (!p || !p.isHuman || p.id === msg.fromPersonId || introducedIds.includes(p.id)) continue;
    const first = p.firstName.trim();
    if (first.length < 2) continue;
    // a proper name, capitalised: "Will" or "Grace" as a name, not "will" or "grace" as words
    const cap = first[0]!.toUpperCase() + first.slice(1);
    const named = cued
      ? new RegExp(`\\b${escapeRe(cap)}\\b`).test(msg.bodyText)
      : introducesByName(msg.bodyText, cap);
    if (named) introducedIds.push(p.id);
  }
  if (!introducedIds.length) return undefined;
  return { introducerId: msg.fromPersonId, introducedIds, messageId: msg.id, at: msg.sentAt };
}
