/**
 * The evidence rule (plan 32 §6.6, plan 44 §6.1): an answer counts only when the words it quotes are really in the
 * text it quotes. One copy for the browser's network search and the server's role scoring (moved here from
 * apps/web/src/engine/networkSearch/judge.ts, same behaviour), with a whole-word option for skills, so "Java" quoted
 * from a line that says "JavaScript" does not count.
 */

/** Lowercase, straight quotes, one space: how a quote and its text are compared. */
export const foldQuote = (s: string) =>
  s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

export interface QuoteOptions {
  /** the quote must start and end at word edges in the text, never inside a longer word */
  wholeWord?: boolean;
}

const wordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/**
 * A quote counts only when it is in the text (ignoring case, curly quotes and spacing) and says something: at least
 * three letters or digits. Returns the quote as it counts (outer quote marks off), or undefined.
 */
export function verifyQuote(
  text: string,
  quote: string | null | undefined,
  o: QuoteOptions = {},
): string | undefined {
  const q = (quote ?? '').trim().replace(/^["']|["']$/g, '');
  if (q.replace(/\W/g, '').length < 3) return undefined;
  const hay = foldQuote(text);
  const needle = foldQuote(q);
  if (!o.wholeWord) return hay.includes(needle) ? q : undefined;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const before = hay[i - 1];
    const after = hay[i + needle.length];
    const edgeStart = !wordChar(needle[0]) || !wordChar(before);
    const edgeEnd = !wordChar(needle[needle.length - 1]) || !wordChar(after);
    if (edgeStart && edgeEnd) return q;
  }
  return undefined;
}
