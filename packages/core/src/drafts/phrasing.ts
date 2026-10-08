/**
 * Small language helpers for the drafting engine: turning stored note facts into grammatical second-person
 * clauses, short school names, the cycle phrase, and the function a recipient's title maps to.
 *
 * Facts are written by the student (or extracted from their notes) in the third person: "They recommended focusing
 * on one project story", "Alina offered to refer me when the posting goes up". A message speaks to the person, so
 * every fact that is spliced into a sentence goes through `clause()` first; a fact that cannot be made grammatical
 * is not used at all.
 */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const lower1 = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
/**
 * Lowercase the first letter only when the first word is an ordinary word ("Your promotion" -> "your promotion",
 * "Built a service" -> "built a service"), never "I" or a proper noun ("I had", "Ramp gave me").
 */
export function softLower(s: string): string {
  const w = s.split(/\s+/)[0] ?? '';
  if (/^I('|$)/.test(w) || /^[A-Z]{2,}/.test(w)) return s;
  const common =
    /^(your|the|a|an|my|our|their|his|her|this|that|these|those|it|its|there|just|took|finally|got|had|started|moved|switched|landed|joined)$/i;
  const irregularPast =
    /^(built|led|ran|won|grew|wrote|made|shipped|taught|drove|began|took|got|had|did|sold|set|cut|found|spent|went)$/i;
  if (common.test(w) || irregularPast.test(w) || /^[A-Z][a-z]+(ed|ing)$/.test(w)) return lower1(s);
  return s;
}
export const cap1 = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
/** Lowercase a field-of-study or title phrase, keeping acronyms ("Computer Science" -> "computer science", "CS and Math" -> "CS and math"). */
export const lowerPhrase = (s: string) =>
  s
    .split(' ')
    .map((w) => (/^[A-Z&]{2,6}$/.test(w) || /^[A-Z]{2,}\d*$/.test(w) ? w : w.toLowerCase()))
    .join(' ');
/** Collapse whitespace and drop trailing punctuation. */
export const strip = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.!;:,]+$/, '');

const SCHOOL_SHORT: Record<string, string> = {
  'massachusetts institute of technology': 'MIT',
  'california institute of technology': 'Caltech',
  'georgia institute of technology': 'Georgia Tech',
  'university of pennsylvania': 'Penn',
  'new york university': 'NYU',
  'university of california, berkeley': 'Berkeley',
  'university of california berkeley': 'Berkeley',
  'uc berkeley': 'Berkeley',
  'university of california, los angeles': 'UCLA',
  'university of southern california': 'USC',
  'the ohio state university': 'Ohio State',
  'university of texas at austin': 'UT Austin',
  'the university of texas at austin': 'UT Austin',
  'university of north carolina at chapel hill': 'UNC',
  'university of illinois urbana-champaign': 'UIUC',
  'university of illinois at urbana-champaign': 'UIUC',
  'washington university in st. louis': 'WashU',
  'boston university': 'BU',
  'boston college': 'BC',
  'london school of economics': 'LSE',
  'carnegie mellon university': 'Carnegie Mellon',
};

/** What students actually call their school: "Cornell", "Michigan", "Penn", "MIT". */
export function schoolShort(school: string | undefined): string {
  const t = (school ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const known = SCHOOL_SHORT[t.toLowerCase()];
  if (known) return known;
  const uc = t.match(/^(?:The )?University of California,? (?:at )?([A-Z][\w .'-]+)$/);
  if (uc) return `UC ${uc[1]!.trim()}`;
  const of = t.match(/^(?:The )?University of ([A-Z][\w.&'-]*(?: [A-Z][\w.&'-]*)*?)(?:,.*| at .*| in .*)?$/);
  if (of) return of[1]!;
  const suffix = t.match(/^(?:The )?(.+?) (?:University|College)$/);
  if (suffix && suffix[1]!.length >= 3) return suffix[1]!;
  return t;
}

/** "summer 2027 internship recruiting", "full-time recruiting", "recruiting": never "this cycle recruiting". */
export function cyclePhrase(label: string | undefined): string {
  const l = (label ?? '').trim();
  const m = l.match(/\b(summer|fall|spring|winter)\s+(\d{4})\b/i);
  if (m) return `${m[1]!.toLowerCase()} ${m[2]} ${/intern/i.test(l) ? 'internship ' : ''}recruiting`;
  if (/full[- ]?time|new grad/i.test(l)) return 'full-time recruiting';
  if (/intern/i.test(l)) return 'internship recruiting';
  return 'recruiting';
}
export const isInternCycle = (label: string | undefined) => /intern|summer/i.test(label ?? '');

export const FUNCTION_LABEL: Record<string, string> = {
  swe: 'software engineering',
  pm: 'product management',
  ib: 'investment banking',
  consulting: 'consulting',
  data: 'data science',
  design: 'product design',
  finance: 'finance',
  marketing: 'marketing',
  research: 'research',
  vc: 'venture capital',
  ops: 'operations',
  quant: 'quant',
};
const TITLE_FUNCTION: [RegExp, string][] = [
  [/product manag|\bpm\b|product lead|product owner|\bapm\b/i, 'pm'],
  [/design|\bux\b|\bui\b/i, 'design'],
  [/data scien|machine learning|\bml\b|analytics|data engineer/i, 'data'],
  [/quant|trader|trading/i, 'quant'],
  [/software|engineer|developer|\bswe\b|\bsde\b/i, 'swe'],
  [/invest|banking|\bm&a\b|capital markets|equity|leveraged/i, 'ib'],
  [/consult|engagement manager/i, 'consulting'],
  [/venture|\bvc\b/i, 'vc'],
  [/market/i, 'marketing'],
  [/operations|\bops\b/i, 'ops'],
  [/research/i, 'research'],
];
/** The function a title belongs to, whatever the student is targeting ("Investment Banking Analyst" -> "ib"). */
export function titleFunction(title: string | undefined): string | undefined {
  const t = title ?? '';
  for (const [re, key] of TITLE_FUNCTION) if (re.test(t)) return key;
  return undefined;
}
/** The student's target function only when it is the recipient's function too; undefined otherwise. */
export function matchedFunction(title: string | undefined, targets: string[]): string | undefined {
  const f = titleFunction(title);
  return f && targets.includes(f) ? f : undefined;
}
/** The student's target function that best matches the recipient's title, falling back to their first target. */
export function functionFor(title: string | undefined, targets: string[]): string | undefined {
  const t = title ?? '';
  for (const [re, key] of TITLE_FUNCTION) if (re.test(t) && targets.includes(key)) return key;
  return targets[0];
}
export function functionLabel(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return FUNCTION_LABEL[key] ?? key.replace(/[_-]+/g, ' ').toLowerCase();
}

const TITLE_ABBREVIATIONS: [RegExp, string][] = [
  [/\bSr\.?(?=\s|$)/gi, 'Senior'],
  [/\bJr\.?(?=\s|$)/gi, 'Junior'],
  [/\bAssoc\.?(?=\s|$)/gi, 'Associate'],
  [/\bAsst\.?(?=\s|$)/gi, 'Assistant'],
  [/\bMgr\.?(?=\s|$)/gi, 'Manager'],
  [/\bDir\.?(?=\s|$)/gi, 'Director'],
];

/**
 * "software engineer" from "Software Engineer II"; keeps acronyms. Abbreviations are spelled out ("Sr. Analyst" is
 * "senior analyst"), and a rank before a comma keeps its area ("VP, Analytics" is "VP of analytics", not "VP").
 */
export function roleNoun(title: string | undefined): string | undefined {
  if (!title) return undefined;
  let full = title.trim();
  for (const [re, word] of TITLE_ABBREVIATIONS) full = full.replace(re, word);
  const rank = full.match(
    /^((?:senior |executive |associate |assistant )?(?:S?VP|EVP|AVP|vice president|director|head))\s*,\s*([^,(]+)/i,
  );
  if (rank) full = `${rank[1]} of ${rank[2]!.trim()}`;
  const t = full
    .replace(/\s*[,(].*$/, '')
    .replace(/\s+(I{1,3}|IV|V|\d)$/, '')
    .trim();
  return t ? lowerPhrase(t) : undefined;
}
export const article = (noun: string) =>
  /^[aeiou]/i.test(noun) && !/^(uni|eu|one)/i.test(noun) ? 'an' : 'a';

// ---------------------------------------------------------------------------------------------------------------
// Fact clauses

export interface FactClause {
  /** the fact as a clause addressed to the person: "you offered to refer me when the posting goes up" */
  text: string;
  /** true when the clause has "you" as its subject */
  you: boolean;
  /** the verb right after "you" ("offered", "recommended", "said") */
  verb?: string;
  /** what follows the verb */
  rest?: string;
}

const LEAD_VERBS =
  /^(recommended|suggested|advised|urged|said|mentioned|offered|volunteered|agreed|promised|told|explained|noted|shared|talked|walked|described|pointed|emphasized|stressed|argued|ran|grew|moved|worked|joined|left|started|studied|went|spent|built|led|interned|founded|switched|transferred|asked|thinks|thought|believes|believed|loves|wanted|wants|plans|planned|leads|runs|works|manages|managed|prefers|preferred|enjoys|likes|hopes|expects|needs|uses|is|was|has|had|will|would|can|could|recently)$/i;
const ADVERBS = new Set([
  'also',
  'still',
  'just',
  'recently',
  'now',
  'often',
  'always',
  'never',
  'currently',
  'really',
  'actually',
  'once',
  'later',
  'then',
  'even',
  'already',
  'usually',
  'kindly',
]);
const IRREGULAR: Record<string, string> = {
  is: 'are',
  was: 'were',
  has: 'have',
  does: 'do',
  "isn't": "aren't",
  "wasn't": "weren't",
  "hasn't": "haven't",
  "doesn't": "don't",
};
/** Third-person verb -> the form that follows "you". */
function youVerb(w: string, singular: boolean): string {
  const l = w.toLowerCase();
  if (IRREGULAR[l]) return IRREGULAR[l]!;
  if (!singular) return l;
  if (/[^aeiou]ies$/.test(l)) return `${l.slice(0, -3)}y`;
  if (/(ss|sh|ch|x|zz)es$/.test(l) || l === 'goes') return l.slice(0, -2);
  if (/[^su'ia]s$/.test(l) && l.length > 3) return l.slice(0, -1);
  return l;
}

/**
 * Note shorthand that reads wrong in a message ("for McK", "after first round apps", "w/ her team"), written out. Only
 * forms that cannot mean anything else in a recruiting note are expanded.
 */
export function expandShorthand(s: string): string {
  return (
    s
      .replace(/\bMcK\b/g, 'McKinsey')
      .replace(/\bGS\b/g, 'Goldman Sachs')
      .replace(/\bJPM\b/g, 'J.P. Morgan')
      .replace(/\bBofA\b/g, 'Bank of America')
      .replace(/\bS&T\b/g, 'sales and trading')
      .replace(
        /\b(first|second|final|1st|2nd)[ -]round apps\b/gi,
        (_, r: string) => `${r.toLowerCase()}-round applications`,
      )
      .replace(/\b(my|the|summer|internship|recruiting|job|full-time) apps\b/gi, '$1 applications')
      .replace(/\bw\/o\s*/gi, 'without ')
      .replace(/\bw\/\s*/gi, 'with ')
      .replace(/\bb\/c\b/gi, 'because')
      .replace(/\bppl\b/gi, 'people')
      .replace(/\bmtg\b/gi, 'meeting')
      .replace(/\bmgr\b/gi, 'manager')
      // not shorthand, but a phrase the playbook keeps out of messages
      .replace(
        /\breach(ed|es|ing)? out to\b/gi,
        (_, x?: string) =>
          `${x === 'ed' ? 'got' : x === 'es' ? 'gets' : x === 'ing' ? 'getting' : 'get'} in touch with`,
      )
      .replace(/\bco-?workers?\b/gi, (m) => (m.endsWith('s') ? 'colleagues' : 'colleague'))
  );
}

/** In the student's notes "you" is the generic you (the candidate), never the person: make it "I". */
function genericYouToI(s: string): string {
  return s
    .replace(/\byou are\b/gi, 'I am')
    .replace(/\byou were\b/gi, 'I was')
    .replace(/\byou're\b/gi, "I'm")
    .replace(/\byou've\b/gi, "I've")
    .replace(/\byou'll\b/gi, "I'll")
    .replace(/\byou'd\b/gi, "I'd")
    .replace(/\byourself\b/gi, 'myself')
    .replace(/\byour\b/gi, 'my')
    .replace(
      /\b(to|for|with|at|help|helps|tell|told|give|gave|show|showed|let|ask|asked|make|made|from|about)\s+you\b/gi,
      '$1 me',
    )
    .replace(/\byou\b/gi, 'I');
}

/** Words after an object "her" ("send her my resume", "ask her about it"), not a possessive one ("her team"). */
const HER_AS_OBJECT =
  /^(about|to|for|with|if|whether|that|and|or|but|when|before|after|at|on|in|by|from|again|directly|a|an|the|my|some|any|this|these|those|how|what|why|where|who|so|back|up|out|once|soon|later|next|today|tomorrow|know|first|too|as|over)$/i;

/**
 * Convert a stored fact ("They recommended focusing on ...", "Alina offered to refer me ...") into a clause
 * addressed to the person ("you recommended focusing on ...", "you offered to refer me ..."). Returns undefined when
 * the fact cannot be made grammatical (a question, a third party as the subject, a fact about the student).
 */
export function clause(
  raw: string,
  person: { firstName?: string; fullName?: string; lastName?: string } = {},
): FactClause | undefined {
  let t = expandShorthand(strip(raw));
  if (!t || /[?\n]/.test(t) || t.split(' ').length > 34) return undefined;
  if ((t.match(/"/g) ?? []).length % 2) return undefined;
  t = genericYouToI(t);
  const names = [person.fullName, person.firstName, person.lastName]
    .filter((n): n is string => !!n && n.length > 1)
    .sort((a, b) => b.length - a.length)
    .map(esc);
  const nameRe = names.length ? `(?:${names.join('|')})` : '(?!x)x';
  let you = false;
  let singular = true;
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(?:they're|they are)\s+(.*)$/i))) {
    t = `you're ${m[1]}`;
    you = true;
  } else if ((m = t.match(/^(?:she's|he's)\s+(.*)$/i))) {
    t = `you're ${m[1]}`;
    you = true;
  } else if ((m = t.match(new RegExp(`^${nameRe}'s\\s+(.*)$`)))) {
    // "Alina's team is hiring" (possessive) vs "Alina's hiring" (contraction)
    const rest = m[1]!;
    if (/^(\w+ing|a|an|the|been)\b/.test(rest)) t = `you're ${rest}`;
    else t = `your ${rest}`;
    you = /^you're/.test(t);
  } else if ((m = t.match(new RegExp(`^(?:(they)|he|she|${nameRe})\\s+(.*)$`, 'i')))) {
    singular = !m[1];
    const words = m[2]!.split(' ');
    let i = 0;
    while (i < words.length - 1 && ADVERBS.has(words[i]!.toLowerCase())) i++;
    words[i] = youVerb(words[i]!, singular);
    t = `you ${words.join(' ')}`;
    you = true;
  } else if (/^(happy|glad|willing|open|keen|excited|more than happy) to\b/i.test(t)) {
    t = `you said you'd be ${lower1(t)}`;
    you = true;
  } else if (LEAD_VERBS.test(t.split(' ')[0]!)) {
    // subjectless note fragment: "Recommended reading Working Backwards", "Leads a small team on ..."
    const words = t.split(' ');
    words[0] = youVerb(words[0]!, true);
    t = `you ${words.join(' ')}`;
    you = true;
  } else if (/^(their|his|her)\s/i.test(t)) {
    t = t.replace(/^(their|his|her)\s/i, 'your ');
  } else if (/^(the|a|an|it|there|this|that)\b/i.test(t)) {
    t = lower1(t).replace(/^the (team|group|office|firm|company|desk|org)\b/i, 'your $1');
  } else if (/^(I|I'm|I've|I'll|I'd|my|we|our|me)\b/.test(t)) {
    return undefined; // about the student, not the person
  } else if (/^[A-Z]/.test(t)) {
    return undefined; // a third party or a proper noun as the subject; cannot address it to the person
  } else {
    t = lower1(t);
  }
  if (you) {
    // "their" after a company named in the clause ("the Ramp blog post on their ledger") is the company's
    const ownWords = new Set(
      [person.fullName, person.firstName, person.lastName]
        .flatMap((n) => (n ?? '').split(/\s+/))
        .filter(Boolean)
        .map((w) => w.toLowerCase()),
    );
    const orgBefore = (at: number) =>
      t
        .slice(0, at)
        .split(/\s+/)
        .slice(1)
        .some((w) => /^[A-Z][\p{L}&'-]+$/u.test(w) && w !== 'I' && !ownWords.has(w.toLowerCase()));
    t = t.replace(/\btheir\b/gi, (m, at: number) => (orgBefore(at) ? m : 'your'));
    t = t
      .replace(/\b(his)\b/gi, 'your')
      // "her colleague" in a note about her is the person's colleague: "your colleague" in a message to her
      .replace(
        /\bher (colleagues?|team(mates?)?|manager|boss|firm|group|office|company|friends?|classmates?|recruiters?|contacts?|old team|former team|desk|org)\b/gi,
        (m: string, noun: string, _t: string, at: number) => (orgBefore(at) ? m : `your ${noun}`),
      )
      // "update her after first-round applications": the person is the one to update
      .replace(
        /\b(update|tell|email|text|ping|message|thank|call|send|ask|remind|show|let|keep) (her|him)\b/gi,
        '$1 you',
      )
      .replace(/\b(themselves|himself|herself)\b/gi, 'yourself')
      .replace(/^you are\b/, "you're");
    // any other possessive "her" ("offered to send me her old prep doc") is theirs too, unless someone else is named
    // before it in the clause ("introduced me to Jenna and her team" keeps Jenna's team)
    t = t.replace(/\bher(\s+)([A-Za-z'-]+)/g, (m, sp: string, next: string, at: number) =>
      HER_AS_OBJECT.test(next) || orgBefore(at) ? m : `your${sp}${next}`,
    );
    if (names.length) t = t.replace(new RegExp(`\\b${nameRe}\\b`, 'g'), 'you');
  }
  t = t.replace(/\bthe (team|group|office|desk)\b(?= (is|are|was|were|will|has|plans|wants))/i, 'your $1');
  const vm = t.match(/^you (\S+)\s*(.*)$/);
  return { text: t, you, verb: vm?.[1], rest: vm?.[2] };
}

/** The first coordinated part of a clause: "focusing on one story for interviews and said the key is X" -> the first half. */
export function firstPart(s: string): string {
  return s
    .split(
      /;\s+|,?\s+and (?:then |also )?(?:said|added|mentioned|noted|recommended|suggested|told|offered|grew|is|was|thinks|would|wants|asked)\b/i,
    )[0]!
    .replace(/[\s,]+$/, '')
    .trim();
}

/** "what you said about focusing on X" / "your point that the key is Y" / "your advice to apply early". */
export function pointPhrase(c: FactClause | undefined): string | undefined {
  if (!c) return undefined;
  if (!c.you) return `your point that ${firstPart(c.text)}`;
  const v = c.verb?.toLowerCase() ?? '';
  let rest = firstPart(c.rest ?? '');
  if (!rest || rest.split(' ').length < 2) return undefined;
  if (/^(recommended|suggested|advised|urged)$/.test(v)) {
    rest = rest.replace(/^that\s+/, '');
    if (/^\w+ing\b/.test(rest)) return `what you said about ${rest}`;
    // "recommended I read the blog post" is the advice "to read the blog post"
    const todo = rest.match(
      /^(?:I|me)\s+(?:should\s+|to\s+)?(?!am\b|was\b|have\b|had\b|did\b|got\b)([a-z]+)\b(.*)$/,
    );
    if (todo && !/(ed|ing)$/.test(todo[1]!)) return `your advice to ${todo[1]}${todo[2]}`;
    if (/^(I|me)\b/.test(rest)) return `your advice that ${rest.replace(/^me\b/, 'I')}`;
    if (/^to\b/.test(rest)) return `your advice ${rest}`;
    return `your recommendation of ${rest}`;
  }
  if (
    /^(said|mentioned|explained|noted|told|pointed|emphasized|stressed|argued|thinks|thought|believes)$/.test(
      v,
    )
  ) {
    rest = rest.replace(/^(me|out)\s+/, '').replace(/^that\s+/, '');
    // "said to update her after first-round applications" is a request to keep them posted, which the closing line
    // already answers; thanking them for it as advice reads oddly
    if (/^to (update|keep|tell|email|text|ping|let|message|call|send) you\b/.test(rest)) return undefined;
    if (/^to\b/.test(rest)) return `your advice ${rest}`;
    if (/^(about|how|why|what)\b/.test(rest)) return `what you said ${rest}`;
    return `your point that ${rest}`;
  }
  return undefined;
}

/** "offering to refer me when the posting goes up" for "Thanks also for ...". */
export function offerPhrase(c: FactClause | undefined): string | undefined {
  if (!c?.you || !c.rest) return undefined;
  const v = c.verb?.toLowerCase() ?? '';
  const g: Record<string, string> = {
    offered: 'offering',
    volunteered: 'volunteering',
    agreed: 'agreeing',
    promised: 'promising',
  };
  if (g[v]) return `${g[v]} ${c.rest}`;
  if (v === 'said' && /^you'd be /.test(c.rest)) return `saying ${c.rest}`;
  return undefined;
}

/** The proposition behind a hook: "you're hiring interns in January", "your team is launching X in November". */
export function hookProposition(c: FactClause | undefined): string | undefined {
  if (!c) return undefined;
  const v = c.verb?.toLowerCase() ?? '';
  if (c.you && /^(said|mentioned|told|explained|noted)$/.test(v) && c.rest) {
    const r = c.rest
      .replace(/^(me|us)\s+/, '')
      .replace(/^that\s+/, '')
      .replace(/^the (team|group|office|firm|company|desk|org)\b/i, 'your $1');
    if (/^(I|me|my)\b/.test(r)) return undefined;
    return r;
  }
  return c.text;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
/** Whether a hook talks about something still ahead ("hiring in January" asked in October) or already done. */
export function hookTense(text: string, now: Date): 'future' | 'ongoing' | 'past' {
  const l = text.toLowerCase();
  const mi = MONTHS.findIndex((mo) => new RegExp(`\\b${mo}\\b`).test(l));
  if (mi >= 0) {
    const cur = now.getUTCMonth();
    const ahead = (mi - cur + 12) % 12;
    if (ahead === 0) return 'ongoing';
    if (/\b(will|going to|is|are|'re|plans?|planning|launching|hiring|starting|opening)\b/.test(l))
      return ahead <= 6 ? 'future' : 'past';
    return 'past';
  }
  if (/\b(will|going to|plans? to|planning|about to)\b/.test(l)) return 'future';
  if (/\b(is|are|'re)\s+\w+ing\b/.test(l)) return 'ongoing';
  return 'past';
}

const CONTRACTIONS: [RegExp, string][] = [
  [/\bI'm\b/g, 'I am'],
  [/\bI'd\b/g, 'I would'],
  [/\bI'll\b/g, 'I will'],
  [/\bI've\b/g, 'I have'],
  [/\b([Ii])t's\b/g, '$1t is'],
  [/\b([Tt])hat's\b/g, '$1hat is'],
  [/\b([Tt])here's\b/g, '$1here is'],
  [/\b([Hh])ere's\b/g, '$1ere is'],
  [/\b([Ww])hat's\b/g, '$1hat is'],
  [/\b([Yy])ou're\b/g, '$1ou are'],
  [/\b([Yy])ou'd\b/g, '$1ou would'],
  [/\b([Yy])ou've\b/g, '$1ou have'],
  [/\b([Yy])ou'll\b/g, '$1ou will'],
  [/\b([Ww])e're\b/g, '$1e are'],
  [/\b([Dd])on't\b/g, '$1o not'],
  [/\b([Dd])oesn't\b/g, '$1oes not'],
  [/\b([Dd])idn't\b/g, '$1id not'],
  [/\b([Ii])sn't\b/g, '$1s not'],
  [/\b([Ww])asn't\b/g, '$1as not'],
  [/\b([Aa])ren't\b/g, '$1re not'],
  [/\b([Hh])aven't\b/g, '$1ave not'],
  [/\b([Cc])an't\b/g, '$1annot'],
  [/\b([Ww])on't\b/g, '$1ill not'],
  [/\b([Ww])ouldn't\b/g, '$1ould not'],
  [/\b([Cc])ouldn't\b/g, '$1ould not'],
  [/\b([Ll])et's\b/g, '$1et us'],
];
/** For a student whose style card says no contractions. */
export function expandContractions(s: string): string {
  return CONTRACTIONS.reduce((acc, [re, to]) => acc.replace(re, to), s);
}

const CLUB_LIKE = /\b(club|society|association|council|chapter|committee|fraternity|sorority)\b/i;

/** "in Wolverine Consulting Group" for a student organisation, "at Comerica Bank" for an employer. */
export function inOrAt(org: string, title?: string): string {
  const club =
    CLUB_LIKE.test(org) ||
    /\b(president|treasurer|secretary|chair|member|captain)\b/i.test(title ?? '') ||
    /\b(student|campus|undergraduate)\b/i.test(org);
  return club ? `in ${org}` : `at ${org}`;
}

/**
 * A promise the student wrote in their own words ("Send her my resume by Monday"), said back to them with the person
 * named ("Send Aisha your resume by Monday"), so a list of promises never mixes "her", "my" and "(for Aisha)".
 */
export function promiseText(text: string, firstName?: string): string {
  let t = text
    .trim()
    .replace(/[.;]+$/, '')
    .replace(
      /^(?:I\s+(?:will|'ll|need to|have to|should|promised to|said I'd|said I would)|I'll|Will)\s+/i,
      '',
    )
    .replace(/^to\s+/i, '');
  const tokens = t.split(/(\s+)/);
  t = tokens
    .map((tok, i) => {
      const m = tok.match(/^([^A-Za-z']*)([A-Za-z][A-Za-z'-]*)(.*)$/);
      if (!m) return tok;
      const [, pre, word, post] = m as unknown as [string, string, string, string];
      const lower = word.toLowerCase();
      if (lower === 'my') return `${pre}your${post}`;
      if (lower === 'me') return `${pre}you${post}`;
      if (lower === 'myself') return `${pre}yourself${post}`;
      if (lower === 'mine') return `${pre}yours${post}`;
      if (!firstName) return tok;
      if (lower === 'him') return `${pre}${firstName}${post}`;
      if (lower === 'his') return `${pre}${firstName}'s${post}`;
      if (lower === 'her') {
        const next = tokens[i + 2]?.match(/[A-Za-z][A-Za-z'-]*/)?.[0];
        // "send her my resume", "email her by Friday", "thank her": the person; "her team": theirs
        return !next || /[.,;!?]$/.test(tok) || PROMISE_OBJECT_NEXT.test(next)
          ? `${pre}${firstName}${post}`
          : `${pre}${firstName}'s${post}`;
      }
      return tok;
    })
    .join('');
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}
const PROMISE_OBJECT_NEXT =
  /^(about|to|for|with|if|whether|that|and|or|but|when|before|after|at|on|in|by|from|again|a|an|the|my|your|some|any|this|these|those|how|what|why|where|who|back|up|once|soon|later|next|today|tomorrow|tonight|know|monday|tuesday|wednesday|thursday|friday|saturday|sunday|over)$/i;
