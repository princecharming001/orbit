/**
 * How the student actually types on a channel, so a draft reads like them and never switches casing halfway.
 *
 * What their own sent messages show (Orbit's owner, 2,100+ LinkedIn messages): a message is written in one casing
 * from start to finish (3% mixed); lowercase messages are lowercase all the way through, names, "i" and short forms
 * ("sf", "pm", "yc") included; casing follows the channel and drifts over time (LinkedIn went from 39% lowercase to
 * over 90%, email stays capitalised); and LinkedIn messages almost never carry a sign-off (5 of 509). So the casing
 * is read from the newest messages on the channel and applied to the whole draft, and a LinkedIn sign-off is kept
 * only for someone who signs theirs.
 */

export interface TypingStyle {
  casing: 'lower' | 'proper';
  /** they end messages on this channel with their name */
  signs: boolean;
  /** how many messages it was read from */
  from: number;
}

/** Messages read, newest first: enough to be sure, few enough to follow a change in habit. */
export const TYPING_SAMPLES = 40;
const MIN_SAMPLES = 5;
const LOWER_SHARE = 0.6;
const SIGN_SHARE = 0.3;

const hasWords = (s: string) => /[A-Za-z]{3}/.test(s) && s.trim().length > 20;

/** The text a message starts with, past a quoted reply or leading punctuation. */
const opening = (s: string) => s.replace(/^[\s"'(\-*•>]+/, '');

/**
 * Read the habit from the student's own sent messages on one channel, newest first. Undefined with too few to go on
 * (the draft then keeps the casing it was written in).
 */
export function learnTyping(newestFirst: string[], firstName?: string): TypingStyle | undefined {
  const samples = newestFirst.filter(hasWords).slice(0, TYPING_SAMPLES);
  if (samples.length < MIN_SAMPLES) return undefined;
  const lower = samples.filter((s) => /^[a-z]/.test(opening(s))).length;
  const name = firstName?.trim().toLowerCase();
  const signed = name
    ? samples.filter((s) => new RegExp(`(^|[\\s,\\-])${escapeRe(name)}[\\s.!]*$`, 'i').test(s.trim())).length
    : 0;
  return {
    casing: lower / samples.length >= LOWER_SHARE ? 'lower' : 'proper',
    signs: signed / samples.length >= SIGN_SHARE,
    from: samples.length,
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Links, addresses and handles keep their own letters (a lowercased link can break). */
const PROTECTED =
  /(https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+\.[\w.-]+|@\w+|\b[\w-]+\.(?:com|io|ai|co|org|net|dev|app|today)\b\S*)/g;

function mapUnprotected(text: string, fn: (part: string) => string): string {
  let out = '';
  let at = 0;
  for (const m of text.matchAll(PROTECTED)) {
    out += fn(text.slice(at, m.index)) + m[0];
    at = (m.index ?? 0) + m[0].length;
  }
  return out + fn(text.slice(at));
}

const SIGNOFF_WORDS =
  /^(best|thanks|thank you|thanks so much|cheers|regards|best regards|warmly|talk soon|all the best)[,.!]?$/i;

/** Drop a closing name (and the "Best," line above it) from the end of a message. */
export function dropSignoff(body: string, firstName: string): string {
  const name = firstName.trim().toLowerCase();
  if (!name) return body;
  const lines = body.replace(/\s+$/, '').split('\n');
  const last = lines[lines.length - 1]
    ?.trim()
    .replace(/^[-–—]\s*/, '')
    .toLowerCase();
  if (last !== name) return body;
  lines.pop();
  // "Best," or "Thanks," alone on the line above the name goes with it
  const above = lines[lines.length - 1]?.trim();
  if (above && SIGNOFF_WORDS.test(above)) lines.pop();
  return lines.join('\n').replace(/\s+$/, '');
}

/** Capital letters where a sentence starts, and "I", leaving every other word (and any link) as written. */
function properCase(text: string): string {
  const withI = mapUnprotected(text, (part) => part.replace(/\bi(?='(?:m|ll|d|ve|re)\b|\b)/g, 'I'));
  return withI.replace(/(^\s*|[.!?]\s+|\n\s*)([a-z])/g, (m, lead: string, c: string, at: number) => {
    const rest = withI.slice(at + lead.length);
    // a link or an address at the start of a sentence keeps its letters
    if (/^(https?:\/\/|www\.|[\w.+-]+@|[\w-]+\.(com|io|ai|co|org|net|dev|app|today)\b)/.test(rest)) return m;
    return lead + c.toUpperCase();
  });
}

/** The draft in the student's casing, start to finish, with a LinkedIn sign-off only if they sign theirs. */
export function applyTyping(
  body: string,
  style: TypingStyle | undefined,
  opts: { channel: 'gmail' | 'linkedin'; firstName?: string },
): string {
  if (!style) return body;
  let out = body;
  if (opts.channel === 'linkedin' && !style.signs && opts.firstName) out = dropSignoff(out, opts.firstName);
  out = style.casing === 'lower' ? mapUnprotected(out, (p) => p.toLowerCase()) : properCase(out);
  return out;
}
