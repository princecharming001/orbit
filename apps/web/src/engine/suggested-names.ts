import { knownSizeBucket } from '@orbit/core';
import { isGivenName, WORDLIKE_GIVEN } from './given-names';

/**
 * Reads the prep tab's answer to "Is there anyone else you'd suggest I talk to?" into people.
 *
 * A wrong save is worse than a missed one: it invents a person ("Career Services") that the student is then told to
 * write to. So the reader returns three lists: names it is sure of (saved), names it is not sure of (the student is
 * asked to confirm them before anything is saved), and the parts that are not names at all (left in the field with a
 * note). Deterministic and dependency-free.
 *
 * Decision order:
 * 1. Split the answer into pieces: new lines, bullets, list numbers, commas, semicolons, "!" or "?", a full stop
 *    that ends a sentence, and "and" or "&" between people (never inside a company: "at Procter and Gamble").
 * 2. Read the company of each piece: "at", "from", "@" or a dash ("Tom Lee - Stripe"), "on the X team at",
 *    brackets ("Priya Shah (Stripe)"), or a relative clause ("who leads growth at Ramp"). A company that is a
 *    description ("the data team", "HR", "her old team") is dropped. A piece that is only a company ("Tom Lee,
 *    Stripe") or a clause about the last person ("Mark Chen, he runs sales at Ramp") belongs to the person before.
 * 3. Clean the name part: drop lead-ins ("definitely", "she said to talk to", "her manager"), trailing hedges
 *    ("too", "maybe"), leading roles ("Engineering Manager Tom Lee") and the clause after the name ("who...",
 *    "in sales", "on my team").
 * 4. Reject the piece when any word is a function word (pronouns, verbs, non-answers), a role, team, place, group
 *    or industry word, a contraction or possessive, or not a word at all; when it has more than four words; or when
 *    the whole phrase is a company ("Morgan Stanley").
 * 5. Decide:
 *    - one word: a name only with a company ("Tom at Stripe"); "Definitely Tom" alone is not enough to save;
 *    - a title and a surname ("Dr. Patel", "Professor Alvarez"): confirm;
 *    - two to four words typed with capitals: save;
 *    - in lowercase, starting with a given name from the list ("priya shah"): save, unless the given name is also a
 *      common word ("will park", "mark chen") or a later word looks like an English word ("tom rogers"), then
 *      confirm;
 *    - in lowercase without a known given name ("xiomara quispe"): confirm, unless a word looks like an English
 *      word ("grant writing"), then reject.
 */

export interface SuggestedName {
  name: string;
  org?: string;
}
export interface SuggestedNames {
  /** Read with confidence: saved straight away. */
  names: SuggestedName[];
  /** Probably a person, but the student confirms before anything is saved. */
  confirm: SuggestedName[];
  /** Text that is not a person; it stays in the field with a note. */
  skipped: string[];
}

type Verdict = { kind: 'save' | 'confirm'; name: string } | { kind: 'skip' };

/** Lowercase name particles that sit inside a name ("Ana de la Cruz", "Pieter van der Berg"). */
const PARTICLES = new Set('de la le del della da das dos di du van von der den ter bin al el y'.split(' '));

/** Words that make a phrase an answer, a description or a sentence rather than a name. */
const FUNCTION_WORDS = new Set(
  [
    'someone somebody anyone anybody everyone everybody noone nobody none nothing people person guy guys folks gal',
    'in on the a an of for with who whom what which that this these those there here to or and at from by about',
    'into via per than then as if but so because since when while where how why',
    'i me my mine you your yours he him his she her hers it its we us our they them their myself herself himself',
    'no not nope nah yes yeah yep ok okay sure unsure really idk dunno know knows knew think thought thinks',
    'is are was were be been being am do does did done doing have has had can could would should will might may',
    'must shall cant dont didnt wont isnt doesnt',
    'runs run works work worked working leads lead led manages managed said says say told tell ask asked mentioned',
    'suggested suggests recommended recommends introduced offered offers gave give send sent go going get got',
    'maybe definitely probably perhaps possibly also too just only still yet else other others more any all some',
    'one ones later soon sometime next time week thanks thank sorry tbd na hmm lol haha',
    'good great fine sounds question check look search find linkedin google email emails call text names name',
    'specific particular named comes come mind around',
  ]
    .join(' ')
    .split(' '),
);
/** Roles, teams, places, groups, events and industries: "career services", "VP Engineering", "Big Four firms". */
const DESCRIPTORS = new Set(
  [
    'recruiter recruiters recruiting recruitment manager managers colleague colleagues coworker coworkers boss',
    'bosses friend friends teammate teammates classmate classmates roommate mentor mentors advisor advisors adviser',
    'counselor counselors coach coaches professor professors prof teacher teachers ta tas tutor alum alumni alumna',
    'alumnae alumnus grad grads graduate graduates student students peer peers member members rep reps',
    'representative contact contacts expert experts banker bankers consultant consultants trader traders investor',
    'investors vc vcs hiring hr talent acquisition sourcer sourcers coordinator coordinators supervisor exec execs',
    'executive executives leadership chair founder founders cofounder cofounders co-founder owner staff staffer',
    'employee employees intern interns analyst analysts associate associates engineer engineers developer',
    'developers designer designers scientist scientists researcher researchers pm pms product program programs',
    'project head heads chief president officer senior junior sr jr vp vps svp evp avp cto ceo cfo coo cmo cpo cio',
    'director directors partner partners principal md mds lead leads',
    'engineering marketing sales finance accounting operations ops strategy research data science analytics',
    'design legal compliance security infrastructure platform growth support success customer customers business',
    'corporate development devops ml ai software hardware payments risk treasury audit tax advisory consulting',
    'banking investment investments equity capital markets trading wealth management asset assets private public',
    'venture ventures ib pe hf quant quantitative hedge fund funds people hr',
    'office offices center centre services service department departments dept team teams group groups club clubs',
    'society association network networks hours school schools college university campus firm firms company',
    'companies startup startups org orgs organization organizations agency bank banks desk division unit lab labs',
    'chapter community committee council board panel fair fairs event events meetup meetups conference',
    'conferences career careers handshake slack discord reddit website site portal page newsletter session',
    'sessions info information workshop workshops celebration summit fellowship fellows scholars scholarship',
    'internship internships rotation rotations class cohort tool tools list lists directory database',
    'coffee chat chats meeting meetings call calls intro intros introduction introductions referral referrals',
    'resume networking area hub branch location site floor',
    'big tech four large small top tier boutique bulge bracket elite middle market industry industries fintech',
    'biotech healthcare consumer retail media entertainment government nonprofit early new old former current',
    'several few many most lots lot bunch couple handful various multiple every each both either neither another',
    'plenty',
  ]
    .join(' ')
    .split(' '),
);
/** Companies whose names read like a person's: never saved as one. */
const NAMELIKE_COMPANIES = new Set([
  'morgan stanley',
  'goldman sachs',
  'jane street',
  'charles schwab',
  'raymond james',
  'edward jones',
  'grant thornton',
  'wells fargo',
  'ernst young',
  'booz allen',
  'booz allen hamilton',
  'oliver wyman',
  'johnson johnson',
  'procter gamble',
  'dow jones',
  'ralph lauren',
  'tory burch',
  'kate spade',
  'calvin klein',
  'tommy hilfiger',
  'marc jacobs',
  'michael kors',
  'hewlett packard',
  'walt disney',
  'lockheed martin',
  'warby parker',
  'jefferies',
  'piper sandler',
  'william blair',
  'houlihan lokey',
  'cantor fitzgerald',
  'baird',
]);
const HONORIFIC = /^(?:dr|mr|mrs|ms|mx|prof|professor)\.?$/i;
/** "don't", "she'll", "Tom's": a contraction or possessive is never part of a name ("O'Neil" and "D'Souza" are). */
const CONTRACTION = /(?:n't|'(?:s|re|ve|ll|d|m)|s')$/i;
const WORD = /^\p{L}[\p{L}'.-]*$/u;
/** Endings of English words that are rarely the end of a surname typed in lowercase ("grant writing"). */
const WORDISH =
  /(?:ing|tion|sion|ment|ness|ity|ics|ogy|ship|ance|ence|ism|ists?|ers|ful|less|ous|ive|able|ible)$/;

/** Lead-ins people type before a name: "definitely Tom Lee", "she said to talk to Ana", "her manager Tom Lee". */
const LEAD_IN = new RegExp(
  '^(?:(?:' +
    [
      'definitely|def|maybe|probably|prob|perhaps|possibly|also|especially|and|or|plus|oh|um|uh|so|ok|okay|yes|yeah',
      'try|ask|contact|email|ping|text|message|dm|thanks|thank you',
      '(?:you|i|we) (?:should|could|can|might|must)(?: (?:definitely|probably|also|maybe|really))? (?:talk|speak|reach out|chat|connect|meet|get in touch)(?: (?:to|with))?',
      '(?:talk(?:ing)?|speak(?:ing)?|reach(?:ing)? out|chat|connect(?:ing)?|get in touch) (?:to|with)',
      '\\p{L}+ (?:also )?(?:said|mentioned|suggested|recommended|thinks|thought)(?: (?:that|i should|to))?(?: (?:talk|speak|reach out|chat) (?:to|with))?',
      '(?:my|her|his|their|our|the) (?:old |former |current )?(?:friend|colleague|coworker|co-worker|teammate|manager|boss|mentor|cofounder|co-founder|roommate|classmate|sister|brother|cousin)',
    ].join('|') +
    ')\\s+)+',
  'iu',
);
/** Hedges after a name: "Fatima Malik too", "Priya Shah maybe". */
const TRAIL =
  /\s+(?:too|as well|also|maybe|probably|perhaps|i think|i guess|tho|though|for sure|definitely|lol|haha)$/i;
/** The clause after a name, which may name the company: "who leads growth at Ramp", "in sales", "on my team". */
const CLAUSE =
  /\s+(?:who|whom|since|because|bc|if|but|when|she|he|they|she's|he's|they're|tho|though|(?:on|in) (?:her|his|their|my|the|our)|in [\p{L}]+)\b.*$/iu;
/** "at Ramp", "from Stripe", "@ Stripe", "- Stripe", "on the payments team at Stripe". */
const ORG_AT = /\s+(?:at|from|@|-|–|—|on the .+? team at)\s+/i;
/** A piece that only describes the last person named: "he runs sales at Ramp", "who leads data at Plaid". */
const DESCRIBES_LAST =
  /^(?:who|he|she|they|he's|she's|they're|tho|though|but|since|because|bc|if|might|probably)\b/i;

const lower = (w: string) => w.toLowerCase().replace(/[.]$/, '');
const typedCapital = (w: string) => /^\p{Lu}/u.test(w);

/** "priya" -> "Priya", "o'neil" -> "O'Neil", "ELENA" -> "Elena"; words with capitals of their own ("McKay") stay. */
function titleWord(w: string): string {
  const base = w.length > 2 && w === w.toUpperCase() ? w.toLowerCase() : w;
  return base === base.toLowerCase()
    ? base.replace(/(^|['-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase())
    : base;
}

function isCompany(phrase: string): boolean {
  const key = phrase
    .toLowerCase()
    .replace(/\band\b|&/g, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return NAMELIKE_COMPANIES.has(key) || !!knownSizeBucket(phrase);
}

/**
 * The company named after "at", or undefined when it is a description rather than a company ("the data team",
 * "HR", "her old team"; but "her old team at Google" is Google). Lowercase companies are capitalised ("stripe").
 */
function readOrg(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let org = raw
    .replace(/[!?.]+$/, '')
    .replace(TRAIL, '')
    .trim();
  const inner = /\s(?:at|@)\s+(.+)$/i.exec(org);
  if (inner) org = inner[1]!.trim();
  const words = org.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 5) return undefined;
  const plain = words.map(lower);
  if (!isCompany(org)) {
    if (plain.some((w) => FUNCTION_WORDS.has(w) && w !== 'and' && w !== 'of' && w !== 'the'))
      return undefined;
    if (['the', 'a', 'an'].includes(plain[0]!)) return undefined;
    if (plain.some((w) => DESCRIPTORS.has(w))) return undefined;
  }
  if (org !== org.toLowerCase()) return org;
  return words
    .map((w) =>
      ['and', 'of', '&'].includes(w)
        ? w
        : /^[a-z]{2,4}$/.test(w) && !/[aeiou]/.test(w)
          ? w.toUpperCase()
          : /\d/.test(w)
            ? w
            : titleWord(w),
    )
    .join(' ');
}

/** Whether the text is a single company name, for "Tom Lee, Stripe". */
function onlyOrg(text: string): boolean {
  const t = text.replace(/[!?.]+$/, '').trim();
  if (isCompany(t)) return true;
  const words = t.split(/\s+/);
  if (words.length !== 1) return false;
  const w = words[0]!;
  return (
    typedCapital(w) &&
    WORD.test(w) &&
    !isGivenName(w) &&
    !FUNCTION_WORDS.has(lower(w)) &&
    !DESCRIPTORS.has(lower(w))
  );
}

/** Steps 3 to 5 for one piece's name part. */
function judgeName(raw: string, hasOrg: boolean): Verdict {
  const text = raw
    .replace(/[“”"]/g, '')
    .replace(/’/g, "'")
    .replace(/[.:!?]+$/, '')
    .trim()
    .replace(LEAD_IN, '')
    .replace(TRAIL, '')
    .replace(CLAUSE, '')
    .trim();
  let words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return { kind: 'skip' };
  if (words.some((w) => !WORD.test(w) || CONTRACTION.test(w))) return { kind: 'skip' };
  // a title: "Dr. Priya Patel" is Priya Patel; "Dr. Patel" is a person without a full name
  let title: string | undefined;
  if (words.length > 1 && HONORIFIC.test(words[0]!)) {
    title = words[0]!;
    words = words.slice(1);
    if (words.length > 1) title = undefined;
  }
  // leading roles before a name: "Engineering Manager Tom Lee", "recruiter Priya"
  let j = 0;
  while (!title && j < words.length && DESCRIPTORS.has(lower(words[j]!))) j++;
  if (j > 0 && j < words.length && (typedCapital(words[j]!) || isGivenName(words[j]!)))
    words = words.slice(j);
  const first = lower(words[0]!);
  const wordlikeFirst = WORDLIKE_GIVEN.has(first);
  const bad = (w: string, i: number) => {
    const l = lower(w);
    // "Will Park", "may chen": a given name that is also a word is judged by the rest of the phrase
    if (i === 0 && wordlikeFirst && words.length > 1) return DESCRIPTORS.has(l);
    return FUNCTION_WORDS.has(l) || DESCRIPTORS.has(l);
  };
  const core = words.filter((w, i) => !(i > 0 && i < words.length - 1 && PARTICLES.has(lower(w))));
  if (core.some((w, i) => bad(w, i))) return { kind: 'skip' };
  if (core.length > 4) return { kind: 'skip' };
  if (PARTICLES.has(first) || PARTICLES.has(lower(words[words.length - 1]!))) return { kind: 'skip' };
  if (isCompany(words.join(' '))) return { kind: 'skip' };
  const name = words
    .map((w, i) => (i > 0 && PARTICLES.has(w.toLowerCase()) ? w.toLowerCase() : titleWord(w)))
    .join(' ');
  if (title) return { kind: 'confirm', name: `${titleWord(title)} ${name}` };
  if (core.length === 1) {
    if (!hasOrg) return { kind: 'skip' };
    return typedCapital(words[0]!) || isGivenName(words[0]!)
      ? { kind: 'save', name }
      : { kind: 'confirm', name };
  }
  const capitals = core.every((w) => typedCapital(w));
  if (capitals) return { kind: 'save', name };
  const wordish = core.slice(1).some((w) => w === w.toLowerCase() && w.length >= 5 && WORDISH.test(w));
  if (isGivenName(first) && !wordlikeFirst)
    return wordish ? { kind: 'confirm', name } : { kind: 'save', name };
  return wordish ? { kind: 'skip' } : { kind: 'confirm', name };
}

/** Steps 1 and 2: split the answer into pieces with their company. */
export function readSuggestedNames(text: string): SuggestedNames {
  const names: SuggestedName[] = [];
  const confirm: SuggestedName[] = [];
  const skipped: string[] = [];
  /** The last person read without a company, which a following "Stripe" or "he runs sales at Ramp" completes. */
  let open: SuggestedName | undefined;
  const add = (v: Verdict, org: string | undefined, raw: string) => {
    if (v.kind === 'skip') {
      skipped.push(raw.trim());
      open = undefined;
      return;
    }
    const entry: SuggestedName = org ? { name: v.name, org } : { name: v.name };
    const list = v.kind === 'save' ? names : confirm;
    const same = [...names, ...confirm].find((n) => n.name.toLowerCase() === v.name.toLowerCase());
    if (same) {
      if (org && !same.org) same.org = org;
      open = undefined;
      return;
    }
    list.push(entry);
    open = org ? undefined : entry;
  };
  const isName = (t: string) => {
    const at = ORG_AT.exec(t);
    return judgeName(at ? t.slice(0, at.index) : t, !!at).kind !== 'skip';
  };

  const chunks = text
    .replace(/^\s*(?:\d+[.)]|[-•*])\s+/gm, '')
    .replace(/\s\d+[.)]\s+/g, '\n')
    .split(/[,;\n]|[!?]+\s*|(?<!\b(?:dr|mr|mrs|ms|mx|prof|st|\p{L}))\.\s+/iu);
  for (const chunk of chunks) {
    let part = (chunk ?? '').trim().replace(/[.]+$/, '').trim();
    if (!part) continue;
    // a clause about the last person: "Mark Chen, he runs sales at Ramp"
    if (DESCRIBES_LAST.test(part) && names.length + confirm.length > 0) {
      const at = /\b(?:at|from|@)\s+(.+)$/i.exec(part);
      const org = readOrg(at?.[1]);
      if (open && org) open.org = org;
      open = undefined;
      continue;
    }
    // "Tom Lee, Stripe": a company on its own completes the person before it
    if (open && onlyOrg(part)) {
      open.org = readOrg(part) ?? part;
      open = undefined;
      continue;
    }
    let org: string | undefined;
    const paren = /^(.*?)\s*\(([^)]+)\)(.*)$/.exec(part);
    if (paren) {
      part = `${paren[1]!.trim()} ${paren[3]!.trim()}`.trim();
      const inside = paren[2]!.trim();
      const at = /\b(?:at|@)\s+(.+)$/i.exec(inside);
      org = readOrg(at ? at[1] : inside);
    }
    const at = ORG_AT.exec(part);
    if (at && !org) {
      const people = part.slice(0, at.index).split(/\s+(?:and|&)\s+/i);
      // "at Stripe and Tom Lee": another person after the company only when it reads as a name (or has its own
      // "at"), taken from the end. A company with "and" in its name stays whole ("at Procter and Gamble"); a second
      // company ("at Goldman Sachs and Morgan Stanley") or a lone first name after a company ("at Stripe and Tom")
      // is neither part of the company nor a person, so it is reported as not saved
      let rest = part.slice(at.index + at[0].length);
      const tail: string[] = [];
      const notPeople: string[] = [];
      for (;;) {
        const m = /^(.+)\s+(?:and|&)\s+(.+?)$/i.exec(rest);
        if (!m || isCompany(rest)) break;
        const [, head, after] = m as unknown as [string, string, string];
        if (ORG_AT.test(after) || (!isCompany(after) && isName(after))) tail.push(after);
        else if (isCompany(after) || isCompany(head) || isGivenName(after.trim())) notPeople.push(after);
        else break;
        rest = head;
      }
      // the clause after the company is not part of it: "at Ramp, she did the same rotation" is split already, and
      // "at Ramp who leads growth" keeps Ramp
      rest = rest.replace(CLAUSE, '');
      org = readOrg(rest);
      // a lone description keeps its company in the field ("Data Team at Stripe"), so the note shows what was typed
      for (const name of people)
        add(judgeName(name, !!org), org, people.length === 1 ? `${name.trim()}${at[0]}${rest.trim()}` : name);
      skipped.push(...notPeople.reverse().map((s) => s.trim()));
      for (const t of tail.reverse()) {
        const r = readSuggestedNames(t);
        for (const n of r.names) add({ kind: 'save', name: n.name }, n.org, t);
        for (const n of r.confirm) add({ kind: 'confirm', name: n.name }, n.org, t);
        skipped.push(...r.skipped);
      }
      continue;
    }
    for (const piece of part.split(/\s+(?:and|&)\s+/i)) {
      if (open && onlyOrg(piece)) {
        open.org = readOrg(piece) ?? piece;
        open = undefined;
        continue;
      }
      // the company may sit in the clause after the name: "Priya Shah who leads growth at Ramp"
      const clause = CLAUSE.exec(piece.replace(TRAIL, ''));
      const clauseOrg = org ?? (clause ? readOrg(/\b(?:at|@)\s+(.+)$/i.exec(clause[0])?.[1]) : undefined);
      add(judgeName(piece, !!clauseOrg), clauseOrg, piece);
    }
  }
  return { names, confirm, skipped: skipped.filter(Boolean) };
}
