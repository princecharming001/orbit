/**
 * "Make it shorter" without a model: keep the greeting, the line that says who the student is or why they write,
 * the ask, any gap the student still has to fill, and the sign-off; drop the padding around them (hoping all is
 * well, understanding if they are busy, thanking in advance). The student reads the result in the card and can edit
 * it; nothing is sent.
 */

const GREETING = /^(hi|hey|hello|dear|good (morning|afternoon|evening))\b[^\n]{0,40}[,!.]?$/i;
const SIGN_OFF =
  /^(best|best regards|thanks|thank you|thanks again|many thanks|cheers|warmly|warm regards|regards|kind regards|all the best|talk soon|sincerely|take care)[,!.]?$/i;
/** Sentences that are politeness padding, not content. */
const FILLER =
  /\b(hope (you|this|all|your)|completely understand|totally understand|no worries if|no pressure|i know (you'?re|you are|how) busy|thanks (so much )?in advance|looking forward to hearing|i'?d love to hear (back|from you)|whatever time suits|happy to (fit|work) around|any time that works|i can make most times work|fully understand|if not,? no worries|appreciate (your|you taking the) time)\b/i;
/** The sentence that asks for something. */
const ASK =
  /\?|\b(would you|could you|can you|would it be|are you open|do you have|happy to chat|let me know|might you)\b/i;

function sentences(p: string): string[] {
  return p
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.?!])\s+(?=[A-Z0-9["'])/)
    .filter(Boolean);
}

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** A shorter version of a message, or the same text when there is nothing to cut. */
export function shortenMessage(body: string): string {
  const text = body.replace(/\r\n/g, '\n').trim();
  const paras = text.split(/\n\s*\n/);
  let greeting: string | undefined;
  if (paras.length && GREETING.test(paras[0]!.split('\n')[0]!.trim())) {
    const lines = paras[0]!.split('\n');
    greeting = lines.shift()!.trim();
    paras[0] = lines.join('\n');
  }
  // the sign-off: the last paragraph when it starts with "Best," and the like (the name and title lines after it)
  let signOff: string | undefined;
  const last = paras.at(-1)?.trim() ?? '';
  const lastLines = last.split('\n');
  const at = lastLines.findIndex((l) => SIGN_OFF.test(l.trim()));
  if (at >= 0) {
    signOff = lastLines.slice(at).join('\n');
    paras[paras.length - 1] = lastLines.slice(0, at).join('\n');
  } else if (paras.length > 1 && lastLines.length <= 3 && wordCount(last) <= 8) {
    signOff = last;
    paras.pop();
  }
  const body0 = paras.map((p) => p.trim()).filter(Boolean);
  const all = body0.flatMap(sentences);
  if (all.length <= 2) return text;
  const keep = new Set<number>();
  // the opening line (who they are, why them), the ask, and any gap the student still has to fill
  const firstReal = all.findIndex((s) => !FILLER.test(s));
  if (firstReal >= 0) keep.add(firstReal);
  const askAt = all.findIndex((s) => ASK.test(s) && !FILLER.test(s));
  if (askAt >= 0) keep.add(askAt);
  all.forEach((s, i) => {
    if (/\[[^\]]+\]/.test(s)) keep.add(i);
  });
  // one line of substance after the opening, when the message had several
  const second = all.findIndex((s, i) => !keep.has(i) && !FILLER.test(s) && i > (firstReal ?? 0));
  if (second >= 0 && keep.size < 3 && all.length >= 5) keep.add(second);
  const kept = all.filter((_, i) => keep.has(i));
  const middle = kept.join(' ');
  const out = [greeting, middle, signOff].filter(Boolean).join('\n\n');
  return wordCount(out) <= wordCount(text) * 0.85 ? out : text;
}
