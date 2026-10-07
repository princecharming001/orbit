import type { EmailMessage, Person } from '../types';

/** Words that make a message an introduction ("Alex, meet Sana", "Intro: you two should meet", "introducing you"). */
const INTRO_CUE =
  /\b(meet|introduc\w*|intro|connect(?:ing)? (?:you|the two of you)|you two should|you should (?:talk|meet|connect)|put(?:ting)? you (?:two )?in touch)\b/i;

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
 * line, at least one other known person on it too, introduction wording, and that person named in the message.
 * A CC alone is not an introduction; the sender has to say who they are bringing in.
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
  const text = `${msg.subject ?? ''}\n${msg.bodyText}`;
  if (!INTRO_CUE.test(text)) return undefined;
  const others = recipients.filter((e) => !mine.has(e) && e !== lower(msg.fromEmail));
  const introducedIds: string[] = [];
  for (const e of others) {
    const p = people.find((x) => x.emails.some((y) => lower(y) === e));
    if (!p?.isHuman || p.id === msg.fromPersonId || introducedIds.includes(p.id)) continue;
    const first = p.firstName.trim();
    if (first.length < 2) continue;
    // a proper name, capitalised: "Will" or "Grace" as a name, not "will" or "grace" as words
    const cap = first[0]!.toUpperCase() + first.slice(1);
    const named = new RegExp(`\\b${cap.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(msg.bodyText);
    if (named) introducedIds.push(p.id);
  }
  if (!introducedIds.length) return undefined;
  return { introducerId: msg.fromPersonId, introducedIds, messageId: msg.id, at: msg.sentAt };
}
