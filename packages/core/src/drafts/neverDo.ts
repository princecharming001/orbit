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
  // "that I go to community college", "that I'm an international student": the thing is what follows the verb
  const what = m[1]!
    .replace(/^that\s+/i, '')
    .replace(/^I\s+(?:go to|attend|am at|study at|went to|transferred from|am|was|have|had)\s+/i, '')
    .replace(/^I'm\s+(?=(an?|the)\s)/i, (x) => (/\bstudent\b/i.test(m[1]!) ? x : ''));
  // a bare "I go", "I am" left after the cut is not a phrase to look for
  if (/^(I|I'm|I am|I go)$/i.test(what.trim())) return undefined;
  const words = what
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

/** What a rule's subject means for this student: "my school" is their school's name, a student is their year. */
export interface NeverDoSubject {
  /** the student's school, as stored and as written in a message ("University of Michigan", "Michigan") */
  school?: string[];
}

const YEAR_NOUN =
  /\b(I'm|I am)\s+an?\s+(?:(?:first|second|third|fourth|final)-year|freshman|sophomore|junior|senior|undergrad(?:uate)?)\b/i;

/** A rule about not saying they are a student ("Don't say I'm a student"), read for the meaning, not the words. */
export function forbidsStudent(text: string | undefined): boolean {
  return clauses(text ?? '').some(
    (c) =>
      NEGATION.test(c) &&
      /\b(say|mention|call me|describe me as|introduce me as|write)\b[^.]*\b(student|undergrad|in school|in college)\b/i.test(
        c,
      ),
  );
}

/** A rule about not naming their school ("dont mention my school", "never say where I study"). */
export function forbidsSchool(text: string | undefined): boolean {
  return clauses(text ?? '').some(
    (c) =>
      NEGATION.test(c) &&
      /\b(mention|say|name|bring up|reference|include|talk about)\b[^.]*\b(my (school|university|college|uni)|where I (study|go to school))\b/i.test(
        c,
      ),
  );
}

/** A rule against one word ("Never use the word 'just'"): the word, in lower case. */
export function forbiddenWords(text: string | undefined): string[] {
  const out: string[] = [];
  for (const c of clauses(text ?? '')) {
    if (!NEGATION.test(c)) continue;
    for (const q of c.matchAll(/["“']([^"”']{1,40})["”']/g)) out.push(q[1]!.trim().toLowerCase());
  }
  return [...new Set(out)];
}

/** The checks a draft can be held to, from the student's never rules (none for no rules, or none checkable). */
export function neverDoChecks(text: string | undefined, subject: NeverDoSubject = {}): NeverCheck[] {
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
    // what the rule means, not only its words: "my school" is the school's name, "I'm a student" any year noun
    const schoolNames = forbidsSchool(raw)
      ? (subject.school ?? []).map((n) => n.trim()).filter((n) => n.length >= 2)
      : [];
    if (schoolNames.length) add(rule, (b) => schoolNames.some((n) => hasPhrase(b, n)));
    if (forbidsStudent(raw)) add(rule, (b) => /\bstudent\b/i.test(b) || YEAR_NOUN.test(b));
    if (/\bcommunity college\b/i.test(c)) add(rule, (b) => /\bcommunity college\b/i.test(b));
    const target = mentionTarget(raw);
    if (
      target &&
      !/\b(gpa|grades?|referrals?|exclamation|emojis?)\b/i.test(target) &&
      !(schoolNames.length && /^(my )?(school|university|college|uni)$/i.test(target)) &&
      !forbidsStudent(raw)
    )
      add(rule, (b) => hasPhrase(b, target));
  }
  return out;
}

/** The never rules a message breaks, in the student's words (empty when it keeps them all). */
export function brokenNeverRules(
  body: string,
  neverDo: string | undefined,
  subject: NeverDoSubject = {},
): string[] {
  return [
    ...new Set(
      neverDoChecks(neverDo, subject)
        .filter((c) => c.breaks(body))
        .map((c) => c.rule),
    ),
  ];
}
