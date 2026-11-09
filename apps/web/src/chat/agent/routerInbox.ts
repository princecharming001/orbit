/**
 * The no-key router's reading of an inbox question ("list my recent emails", "any new LinkedIn messages", "who
 * emailed me today", "unread mail from this week"): list_inbox's input, or undefined when it is not one.
 */

export interface InboxAsk {
  channel?: 'email' | 'linkedin';
  days?: number;
  unreadOnly?: boolean;
}

const VERB =
  "(?:list|show|check|read|get|fetch|pull up|open|see|give me|go through|what(?:'s| is| are)(?: in)?)";
const ADJ = "(?:recent|latest|new|last|unread|newest|today'?s|this week'?s)";
const WHAT = '(?:e-?mails?|mails?|gmail|inbox|messages|dms|linkedin(?: messages| dms| inbox)?)';
/** what may follow: a time, a channel or a sender, never a name straight after (that is "message Lena") */
const TAIL =
  '(?: (?:from|in|since|this|today|yesterday|on|over|for|of|during|last|past|lately|recently)(?: .*)?)?';

const ASKS: RegExp[] = [
  // "list my recent emails", "show me my linkedin messages from this week", "check my inbox", "fetch my emails"
  new RegExp(
    `^(?:can you |could you |please )?${VERB} (?:me )?(?:all )?(?:of )?(?:my )?(?:${ADJ} )*${WHAT}${TAIL}$`,
  ),
  // "my latest messages", "recent emails", "unread mail"
  new RegExp(`^(?:my (?:${ADJ} )*|(?:${ADJ} )+)${WHAT}${TAIL}$`),
  // "any new emails", "did i get any linkedin messages", "do i have unread mail"
  new RegExp(
    `^(?:any|did i (?:get|receive) any|do i have(?: any)?|have i got any) (?:${ADJ} )*${WHAT}${TAIL}$`,
  ),
  // "who emailed me", "who messaged me on linkedin today", "who wrote to me"
  /^who (?:has )?(?:e-?mailed|messaged|dm'?d|wrote to|texted|contacted) me(?: .*)?$/,
];

export function inboxAsk(lower: string): InboxAsk | undefined {
  const s = lower.replace(/[?.!]+$/, '').trim();
  if (s.length > 90 || !ASKS.some((r) => r.test(s))) return undefined;
  // "messages" alone after a draft word is about drafts or replies, not the inbox
  if (/\b(?:draft|drafts|reply|replies|send|sent|write|compose|template)\b/.test(s)) return undefined;
  const out: InboxAsk = {};
  if (/linkedin|\bdms?\b|dm'?d/.test(s)) out.channel = 'linkedin';
  else if (/e-?mail|\bmail|gmail|inbox/.test(s) && !/linkedin/.test(s))
    out.channel = /inbox/.test(s) ? undefined : 'email';
  if (out.channel === undefined) delete out.channel;
  const n = /\b(?:last|past) (\d{1,2}) days?\b/.exec(s);
  if (n) out.days = Math.min(30, Math.max(1, Number(n[1])));
  else if (/\btoday\b/.test(s)) out.days = 1;
  else if (/\byesterday\b/.test(s)) out.days = 2;
  else if (/\b(?:this|last|past) month\b/.test(s)) out.days = 30;
  if (/\bunread\b/.test(s)) out.unreadOnly = true;
  return out;
}
