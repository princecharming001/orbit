/**
 * A role read from a LinkedIn headline. Only the headline's first part says where someone works ("Product @ Google |
 * Growing Ads for SMBs at scale" works at Google, not at "scale"): the parts after a bar or a dot are what they do.
 *
 * A headline is what someone wrote about themselves, not their profile's current position, so callers keep what it
 * gives below a title or company from a profile's experience. A role that is not current ("Former Analyst at Goldman",
 * "ex-Google", "Incoming SWE Intern @ Meta", "Aspiring PM") gives no title and no company: `notCurrent` says why.
 */
const PARTS = /\s+[|·•]\s+|\s+[–—-]\s+/;
const AT = /^(.+?)\s+(?:at|@)\s*(.+)$|^(.+?)\s*@\s*(.+)$/i;
/** A first part that names a past, future or wished-for role, not where they are now. */
/** "CEO of Pond AI", "Co-Founder & CEO of Foam", "Head of Growth of Ramp" is not one (its "of" is the title's own) */
const LEAD_OF =
  /^((?:(?:co-?)?founder|ceo|cto|coo|cfo|cpo|cmo|president|chair(?:man|woman|person)?|managing (?:director|partner)|general partner|partner|owner|principal)(?:\s*(?:&|and|,|\/)\s*(?:(?:co-?)?founder|ceo|cto|coo|cfo|cpo|president|chair))*)\s+of\s+(.+)$/i;
/** A sentence's end: a full stop then a capital, never after a short form ("Sr. Product Manager", "(prev. JPM)") */
const SENTENCE =
  /(?<!\b(?:Sr|Jr|Snr|Dr|Mr|Mrs|Ms|St|Prof|Mgr|Asst|Assoc|Eng|Gen|Corp|Co|Inc|Ltd|No|vs|prev|Prev|ex|Ex|approx|U\.S|e\.g|i\.e))\.\s+(?=\p{Lu})/u;
const NOT_NOW =
  /^(?:former(?:ly)?|ex[\s-]|ex$|previously|prev\.?|past|retired|incoming|future|soon[\s-]to[\s-]be|aspiring|seeking|looking\s+for|open\s+to)\b/i;

export function roleFromHeadline(headline: string | undefined): {
  title?: string;
  org?: string;
  /** the first part names a past, future or wished-for role: nothing in it is where they are now */
  notCurrent?: true;
} {
  // the role is the first part, and only its first sentence ("CEO of Pond AI. A platform with 7K builders")
  const first = headline?.trim().split(PARTS)[0]?.split(SENTENCE)[0]?.trim();
  if (!first) return {};
  if (NOT_NOW.test(first)) return { notCurrent: true };
  const lead = LEAD_OF.exec(first);
  if (lead) {
    const org = lead[2]!
      .split(/\s*[,;]\s+/)[0]!
      .replace(/[.,;!]+$/, '')
      .trim();
    if (org && org.length <= 60) return { title: lead[1]!.trim(), org };
  }
  const m = AT.exec(first);
  if (!m) return { title: first.length <= 80 ? first : undefined };
  const title = (m[1] ?? m[3])!.trim().replace(/[,;]$/, '');
  const org = (m[2] ?? m[4])!
    .trim()
    // "Intern at Google, CS @ Berkeley": the company ends where the next clause starts
    .split(/\s*[,;]\s+|\s+\/\s+/)[0]!
    .replace(/\s*\(.*\)$/, '')
    .replace(/[.,;!]+$/, '')
    .trim();
  return { title: title || undefined, org: org || undefined };
}

/**
 * True when the text reads like a LinkedIn headline rather than a job title: it names a company ("Analyst at
 * Goldman", "PM @ Stripe"), strings several parts together with bars or dots, or is a sentence-length line.
 */
export function looksLikeHeadline(text: string | undefined): boolean {
  const t = text?.trim() ?? '';
  if (!t) return false;
  return (
    /\s(?:at|@)\s|@\s?\p{Lu}/u.test(t) ||
    /\s+[|·•]\s+/.test(t) ||
    /\s+[–—]\s+/.test(t) ||
    NOT_NOW.test(t) ||
    t.length > 60
  );
}
