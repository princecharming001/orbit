/**
 * The student's "never" rules (plan 24), read for what a draft can be checked against. The rules are free text
 * ("Never mention my GPA. No exclamation marks."); the ones a message can visibly break become checks: a quoted
 * phrase, a thing never to mention, exclamation marks, emoji, a referral ask, grades. A rule that cannot be checked
 * ("never sound desperate") still reaches the model as written; it is just not enforced here.
 */

export interface NeverCheck {
  /** the student's own words for the rule, one sentence */
  rule: string;
  /** whether a message body breaks it */
  breaks: (body: string) => boolean;
}

const NEGATION = /\b(never|don'?t|do not|dont|avoid|no|not|stop|without)\b/i;
const VAGUE = new Set([
  'it',
  'that',
  'this',
  'anything',
  'things',
  'stuff',
  'them',
  'me',
  'him',
  'her',
  'anyone',
  'people',
  'too much',
]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `phrase` appears in `body` as whole words, ignoring case and curly quotes. */
function hasPhrase(body: string, phrase: string): boolean {
  const norm = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(norm(phrase))}($|[^\\p{L}\\p{N}])`, 'iu');
  return re.test(norm(body));
}

/** The rule text split into sentences and "and"-joined clauses that each say one thing. */
function clauses(text: string): string[] {
  return text
    .split(
      /[\n.;!?]+|,\s*(?:and\s+)?(?=(?:never|don'?t|do not|no|avoid)\b)|\s+and\s+(?=(?:never|don'?t|do not|no|avoid)\b)/i,
    )
    .map((c) => c.trim())
    .filter((c) => c.length > 1);
}

/** The thing after "never mention" ("my GPA" -> "GPA"), or undefined when it is too vague to check. */
function mentionTarget(clause: string): string | undefined {
  const m =
    /\b(?:never|don'?t|do not|dont|avoid)\s+(?:ever\s+)?(?:mention(?:ing)?|say(?:ing)?|bring(?:ing)? up|talk(?:ing)? about|reference|referencing|include|including|write|use|using|call me)\s+(.+)$/i.exec(
      clause,
    );
  if (!m) return undefined;
  const words = m[1]!
    .replace(/^["'‘“]+|["'’”]+$/g, '')
    .replace(/\b(in|to|on|with|when|unless|because|anywhere|ever|at all|please)\b.*$/i, '')
    .replace(/^(my|the|that|about|any|a|an|our)\s+/i, '')
    .trim()
    .split(/\s+/)
    .slice(0, 4);
  const phrase = words.join(' ').trim();
  if (phrase.length < 2 || VAGUE.has(phrase.toLowerCase())) return undefined;
  return phrase;
}

function sentence(c: string): string {
  const t = c.trim();
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}`;
}

/** The checks a draft can be held to, from the student's never rules (none for no rules, or none checkable). */
export function neverDoChecks(text: string | undefined): NeverCheck[] {
  if (!text?.trim()) return [];
  const out: NeverCheck[] = [];
  const add = (rule: string, breaks: (body: string) => boolean) => out.push({ rule, breaks });
  for (const raw of clauses(text)) {
    const c = raw.toLowerCase();
    if (!NEGATION.test(c)) continue;
    const rule = sentence(raw);
    // quoted words: never say "circle back"
    for (const q of raw.matchAll(/["“]([^"”]{2,60})["”]|(?:^|\s)'([^']{2,60})'(?=\s|$|[,.])/g)) {
      const phrase = (q[1] ?? q[2])!.trim();
      if (phrase) add(rule, (b) => hasPhrase(b, phrase));
    }
    if (/exclamation/.test(c)) add(rule, (b) => /!/.test(b));
    if (/\bemoji/.test(c)) add(rule, (b) => /\p{Extended_Pictographic}/u.test(b));
    if (/\breferr/.test(c) && /\b(ask|asking|request|requesting|mention|for)\b/.test(c))
      add(rule, (b) => /\breferr(al|als|ed|ing)?\b|\brefer me\b/i.test(b));
    if (/\b(gpa|grades?)\b/.test(c)) add(rule, (b) => /\bgpa\b|\bgrade point\b/i.test(b));
    const target = mentionTarget(raw);
    if (target && !/\b(gpa|grades?|referrals?|exclamation|emojis?)\b/i.test(target))
      add(rule, (b) => hasPhrase(b, target));
  }
  return out;
}

/** The never rules a message breaks, in the student's words (empty when it keeps them all). */
export function brokenNeverRules(body: string, neverDo: string | undefined): string[] {
  return [
    ...new Set(
      neverDoChecks(neverDo)
        .filter((c) => c.breaks(body))
        .map((c) => c.rule),
    ),
  ];
}
