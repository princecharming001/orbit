/**
 * The voice lint: what makes assistant text read as a machine (docs/plan/19-orbi-persona.md, section 1). Tests run
 * every line the router can say, and the system prompt's own examples, through it; the sim's judge reads the same
 * list. It flags the tells people notice: dashes, exclamation marks, service and praise openers, "As an AI", closing
 * offers, hedging, "not just X", and markdown in chat.
 */

/** Phrases Orbi never says, as the student would read them. */
export const BANNED_PHRASES: RegExp[] = [
  /\bgreat question\b/i,
  /\bgood question\b/i,
  /\bi'?d be (?:happy|glad|delighted) to\b/i,
  /\bhappy to help\b/i,
  /\bcertainly\b/i,
  /\babsolutely[,.!]/i,
  /\bas an ai\b/i,
  /\bi'?m just an ai\b/i,
  /\bas a language model\b/i,
  /\blet me know if\b/i,
  /\bfeel free to\b/i,
  /\bi hope this helps\b/i,
  /\bhope that helps\b/i,
  /\bdon'?t hesitate\b/i,
  /\bi understand your frustration\b/i,
  /\bi apologi[sz]e for (?:any|the) (?:confusion|inconvenience)\b/i,
  /\bsorry for (?:any|the) (?:confusion|inconvenience)\b/i,
  /\bdelve\b/i,
  /\bseamless(?:ly)?\b/i,
  /\bnot just \w+[^.]*,\s*(?:it'?s|but)\b/i,
  /\bit'?s worth noting\b/i,
  /\bin conclusion\b/i,
  /\bto summari[sz]e\b/i,
  /\bin summary\b/i,
  /\bi'?m here to help\b/i,
  /\bhow can i assist\b/i,
  /\bis there anything else\b/i,
];

/** What is wrong with a line of assistant text, in words; empty when it reads like a person. */
export function voiceProblems(text: string): string[] {
  const out: string[] = [];
  if (/[—–]/.test(text)) out.push('a dash');
  if (/!/.test(text)) out.push('an exclamation mark');
  if (/\p{Extended_Pictographic}/u.test(text)) out.push('an emoji');
  if (/(^|\n)\s*(?:#{1,6}\s|[-*•]\s|\d+[.)]\s)/.test(text)) out.push('a list or heading');
  if (/\*\*[^*]+\*\*/.test(text)) out.push('bold');
  for (const re of BANNED_PHRASES) {
    const m = text.match(re);
    if (m) out.push(`"${m[0]}"`);
  }
  return out;
}

/** True when the line reads like a person: nothing in it that the voice lint flags. */
export function soundsHuman(text: string): boolean {
  return voiceProblems(text).length === 0;
}
