/**
 * What the student says about themselves in chat, read without a model (plan 17 §G): clear first-person statements
 * only ("I'm targeting PM roles", "I want to work in NYC", "I'm a junior at Cornell", "I interned at Stripe", "don't
 * contact Maya Chen"), each kept with the student's own words as its quote. Questions, hedges ("maybe", "thinking
 * about", "if"), other people's plans ("my friend wants PM roles"), commands and sensitive topics give nothing: a
 * statement Orbit is not sure of is never stored.
 *
 * The same module checks what a model extracted: every memory's quote must be the student's own words, no memory may
 * touch a sensitive category, and every goal target must be something the student actually said.
 */
import { looksLikeCompany, looksLikeSchool } from '../resume/schools';
import type { MemoryKind } from '../server/api';
import { functionsIn, industriesIn, locationsIn, roleForFunction } from './vocab';

export const MEMORY_TEXT_MAX = 200;

export interface StatedMemory {
  kind: MemoryKind;
  /** in the third person about the student, at most 200 characters ("Prefers morning calls") */
  text: string;
  /** the student's own words it came from */
  quote: string;
  /** 0..1 */
  importance: number;
  /** the person it is about, by the name the student used ("Maya Chen") */
  personName?: string;
}

/** Recruiting targets read from a statement, in the names the Goals page stores. */
export interface RecruitingHints {
  /** function codes (pm, swe, ib, ...) */
  functions: string[];
  /** the roles the Goals page shows ("Product Manager") */
  roles: string[];
  industries: string[];
  locations: string[];
  organizations: string[];
  employment?: 'internship' | 'full_time';
  /** "Summer 2027 internship", only when the student named the season and year */
  cycleLabel?: string;
  /** "startup" when they said startups or early stage */
  stage?: string;
  /** what they said they are after ("product manager internships at fintech startups in New York") */
  phrase: string;
  quote: string;
}

/** Facts for the profile, used only to fill fields that are empty. */
export interface ProfileHints {
  school?: string;
  majors?: string[];
  graduationYear?: number;
  standing?: string;
  currentCity?: string;
  quote: string;
}

export interface Statements {
  memories: StatedMemory[];
  recruiting?: RecruitingHints;
  profile?: ProfileHints;
}

// ---- sensitive topics ---------------------------------------------------------------------------------------------

/**
 * Categories never remembered automatically (the server's research guards, plus the first person): age, ethnicity,
 * religion, health, family, sexuality, politics, immigration status.
 */
const SENSITIVE: { category: string; re: RegExp }[] = [
  {
    category: 'age',
    re: /\b\d{1,3}[- ]years?[- ]old\b|\baged \d{1,3}\b|\bborn in (19|20)\d\d\b|\bage \d{1,3}\b|\bmy (?:age|birthday)\b/i,
  },
  {
    category: 'ethnicity',
    re: /\b(ethnicity|ethnic background|racial|race is|caucasian|african[- ]american|asian[- ]american|hispanic|latino|latina|latinx)\b/i,
  },
  {
    category: 'religion',
    re: /\b(christian|muslim|jewish|hindu|buddhist|sikh|atheist|catholic|protestant|mormon|religious|religion|faith|church|mosque|synagogue|temple|pray(?:ing)?|ramadan)\b/i,
  },
  {
    category: 'health',
    re: /\b(diagnos(ed|is)|illness|sick|cancer|chronic|disabilit(y|ies)|disabled|pregnan(t|cy)|surgery|mental health|depress(ed|ion)|anxiety|adhd|autis(m|tic)|therapy|therapist|medication|in recovery|rehab)\b/i,
  },
  {
    category: 'family',
    re: /\b(married|divorced|divorce|widow(ed|er)?|spouse|wedding|(?:my|his|her|their|your) (wife|husband|partner|boyfriend|girlfriend|fianc[eé]e?|kids?|children|child|daughter|son|baby|mom|dad|mother|father|parents?|family)|(father|mother|parent) of (two|three|four|\d))\b/i,
  },
  { category: 'sexuality', re: /\b(gay|lesbian|bisexual|transgender|queer|lgbtq?\+?|sexual orientation)\b/i },
  {
    category: 'politics',
    re: /\b(democrat(ic)?|republican|political views?|voted for|votes for|campaigned for|donated to (the )?(campaign|party)|liberal|conservative)\b/i,
  },
  {
    category: 'immigration',
    re: /\b(visa status|undocumented|green card|citizenship status|immigration status|daca)\b/i,
  },
];

/** The sensitive category a text touches, if any. */
export function sensitiveTopic(text: string): string | undefined {
  return SENSITIVE.find((s) => s.re.test(text))?.category;
}

// ---- quotes -------------------------------------------------------------------------------------------------------

/** Lowercase words only, for checking that a quote is the student's own words. */
export function squashWords(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim();
}

/** The quote appears in what the student wrote (ignoring case, punctuation and spacing). */
export function quoteIsFrom(quote: string, said: string): boolean {
  const q = squashWords(quote);
  return q.length >= 3 && squashWords(said).includes(q);
}

/** A key for "the same memory": lowercase words, no punctuation, no leading "is/was/the student". */
export function memoryKey(text: string): string {
  return squashWords(text)
    .replace(/^(?:the student |student |they |they're |is |was )+/, '')
    .trim();
}

// ---- helpers ------------------------------------------------------------------------------------------------------

const clip = (s: string, n = MEMORY_TEXT_MAX) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const uniq = <T>(xs: T[]) => [...new Set(xs)];

/** "my resume" → "their resume", "me" → "them": the student's words, said about the student. */
export function thirdPerson(s: string): string {
  return s
    .replace(/\bI'm\b/gi, "they're")
    .replace(/\bI've\b/gi, "they've")
    .replace(/\bI'd\b/gi, "they'd")
    .replace(/\bI'll\b/gi, "they'll")
    .replace(/\bmyself\b/gi, 'themselves')
    .replace(/\bmine\b/gi, 'theirs')
    .replace(/\bmy\b/gi, 'their')
    .replace(/\bme\b/gi, 'them')
    .replace(/\bI\b/g, 'they');
}

/** Trailing filler that is not part of the object ("PM roles right now" → "PM roles"). */
function trimObject(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(
      /[\s,]+(?:right now|for now|at the moment|these days|this (?:year|cycle|semester|term)|mainly|mostly|ideally|hopefully|honestly|if possible|lol|haha|thanks|thank you|please)\s*$/i,
      '',
    )
    .replace(/[\s,;:.!-]+$/g, '')
    .replace(/^(?:a|an|the|some)\s+/i, (m) => m.toLowerCase())
    .trim();
}

const STANDALONE_CAPS = new Set(
  [
    'i',
    "i'm",
    'pm',
    'pms',
    'apm',
    'swe',
    'sde',
    'ib',
    'mbb',
    'ai',
    'ml',
    'vc',
    'vcs',
    'ux',
    'ui',
    'pe',
    'nyc',
    'sf',
    'la',
    'dc',
    'ny',
    'us',
    'usa',
    'faang',
    'maang',
    'manga',
    'big',
    'big tech',
    'big four',
    'big 4',
    'bulge',
    'summer',
    'fall',
    'spring',
    'winter',
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
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
    'linkedin',
    'orbit',
  ].map((s) => s.toLowerCase()),
);

const NAME_TOKEN = String.raw`[A-Z0-9][\w&.'’+-]*`;
const NAME = String.raw`${NAME_TOKEN}(?:\s+(?:of\s+|de\s+)?${NAME_TOKEN})*`;
const NAME_RUN = new RegExp(String.raw`^(${NAME}(?:\s*(?:,|\bor\b|\band\b)\s*${NAME})*)`);

/** Company names in an object phrase: capitalised names after at/with/like/including, or leading it. */
export function organizationsIn(phrase: string, leading = false): string[] {
  const starts: number[] = leading ? [0] : [];
  for (const m of phrase.matchAll(/\b(?:at|with|like|including|such as|to|for)\s+/gi))
    starts.push((m.index ?? 0) + m[0].length);
  const out: string[] = [];
  for (const s of starts) {
    const run = phrase.slice(s).match(NAME_RUN);
    if (!run) continue;
    for (const raw of run[1]!.split(/\s*(?:,|\bor\b|\band\b)\s*/)) {
      const name = raw.replace(/[.,;:]+$/, '').trim();
      if (!name || name.length < 2) continue;
      const first = name.split(/\s+/)[0]!.toLowerCase();
      if (STANDALONE_CAPS.has(name.toLowerCase()) || STANDALONE_CAPS.has(first)) continue;
      if (/^\d+$/.test(name)) continue;
      if (locationsIn(name).length || industriesIn(name).length || functionsIn(name).length) continue;
      out.push(name);
    }
  }
  return uniq(out);
}

/** Recruiting targets in an object phrase, or undefined when it names none. */
export function recruitingHintsFrom(
  object: string,
  quote: string,
  opts: { strong: boolean; leadingOrgs?: boolean },
): RecruitingHints | undefined {
  const phrase = trimObject(object);
  if (!phrase) return undefined;
  const functions = functionsIn(phrase);
  const industries = industriesIn(phrase);
  const locations = locationsIn(phrase);
  const organizations = organizationsIn(phrase, opts.leadingOrgs ?? opts.strong);
  const employment: RecruitingHints['employment'] = /\b(intern(?:ship)?s?|co-?ops?)\b/i.test(phrase)
    ? 'internship'
    : /\b(full[- ]time|new[- ]grad|entry[- ]level|first job)\b/i.test(phrase)
      ? 'full_time'
      : undefined;
  const jobWord =
    /\b(roles?|jobs?|positions?|internships?|interns?|opportunit(?:y|ies)|offers?|careers?|co-?ops?|full[- ]time|new[- ]grad|recruiting|companies|firms|startups?)\b/i.test(
      phrase,
    );
  if (!functions.length && !industries.length && !locations.length && !organizations.length && !employment)
    return undefined;
  // "I'm looking for Sarah's email" is not a job search: a weak verb needs a kind of work, a field or a job word
  if (!opts.strong && !functions.length && !industries.length && !jobWord) return undefined;
  const season = phrase.match(/\b(summer|fall|autumn|spring|winter)\s+(?:of\s+)?'?(20\d\d|\d\d)\b/i);
  const year = season ? (season[2]!.length === 2 ? `20${season[2]}` : season[2]!) : undefined;
  const fullTimeYear = phrase.match(/\b(?:full[- ]time|new[- ]grad)\b[^.]*?\b(20\d\d)\b/i)?.[1];
  const cycleLabel = season
    ? `${cap(season[1]!.toLowerCase())} ${year} ${employment === 'full_time' ? 'full-time' : 'internship'}`
    : fullTimeYear
      ? `Full-time ${fullTimeYear}`
      : undefined;
  return {
    functions,
    roles: functions.map((f) => roleForFunction(f)).filter((r): r is string => !!r),
    industries,
    locations,
    organizations,
    employment,
    cycleLabel,
    stage: /\b(start-?ups?|early[- ]stage|seed[- ]stage)\b/i.test(phrase) ? 'startup' : undefined,
    phrase: clip(phrase, 80),
    quote,
  };
}

// ---- clauses ------------------------------------------------------------------------------------------------------

const LEAD =
  /^(?:(?:also|and|but|so|btw|by the way|fyi|oh|ok(?:ay)?|well|honestly|actually|basically|anyway|right now|currently|for now|at the moment|these days|this (?:year|semester|cycle|summer|fall|spring)|for context|for reference|just so you know|just fyi|heads up|quick note|note|hey|hi|hello|yeah|yes|yep|no|nope|sure|cool|thanks|thank you|ps|p\.s\.)[,:!.]?\s+)+/i;

/** Words that make a statement unsure, hypothetical or about someone else's advice: such a clause gives nothing. */
const HEDGE =
  /\b(maybe|might|perhaps|possibly|probably|not sure|unsure|undecided|thinking (?:about|of)|considering|wondering|if|whether|hypothetically|kind of|sort of|i guess|i think|i feel like|could|should|would(?! (?:like|rather|prefer|love))|wish|someday|one day|supposed to|told me|said i|says i|suggested|recommended i)\b/i;

/** Requests to Orbit, not statements about the student. */
const COMMAND =
  /^(?:please |can you |could you |pls )?(?:find|draft|write|show|list|open|send|tell|add|remember|forget|delete|remove|help|search|look up|lookup|book|schedule|move|mark|update|change|set|make|give|get me|create|import|export|connect|explain|summari[sz]e|research|ask|reply|plan|track)\b/i;

const QUESTION_START =
  /^(?:who|what|when|where|why|how|which|whose|whom|should|can|could|would|will|do|does|did|is|are|am|was|were|have|has|had|shall|may|isn't|aren't|don't|doesn't)\b/i;

interface Clause {
  text: string;
  question: boolean;
}

function clausesOf(text: string): Clause[] {
  const out: Clause[] = [];
  const sentences = text
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .split(/(?<=[.!?;])\s+|\n+/);
  for (const sentence of sentences) {
    const question = /\?\s*["')]*\s*$/.test(sentence);
    // "I'm a junior at Cornell and I'm targeting PM roles": two statements
    const pieces = sentence.split(/,?\s+(?:and|but|so|while|plus|also)\s+(?=(?:i|i'm|im|i've|i'd|my)\b)/i);
    pieces.forEach((p, i) => {
      const t = p
        .replace(/^[\s"'(]+|[\s"')]+$/g, '')
        .replace(/[.!?;,]+$/g, '')
        .trim();
      if (t) out.push({ text: t, question: question && i === pieces.length - 1 });
    });
  }
  return out;
}

/** "im" → "i'm", "i am" → "i'm", "i would like" → "i'd like", so one pattern covers how students type. */
function normalizeClause(t: string): string {
  return t
    .replace(LEAD, '')
    .replace(/^im\b/i, "I'm")
    .replace(/^i am\b/i, "I'm")
    .replace(/^ive\b/i, "I've")
    .replace(/^id\b/i, "I'd")
    .replace(/^i would\b/i, "I'd")
    .replace(/^i'm currently\b/i, "I'm")
    .replace(/^currently,?\s+/i, '')
    .replace(/^dont\b/i, "don't")
    .trim();
}

// ---- rules --------------------------------------------------------------------------------------------------------

const ADV =
  '(?:(?:currently|now|mainly|mostly|primarily|really|only|also|actively|definitely|seriously|still|very|super|most|honestly|basically|just|totally) )*';

/** I'm + a verb of looking: "I'm targeting X", "I'm recruiting for X". The verb decides the memory's wording. */
const IM_SEEKING = new RegExp(
  String.raw`^I'm ${ADV}(targeting|aiming (?:for|at)|going (?:for|after)|set on|recruiting (?:for|in)|applying (?:to|for)|interviewing for|in the market for|trying to (?:get|land|break into|find)|hoping to (?:get|land|break into|find)|looking (?:for|at|into)|searching for|hunting for|interested in|focused on|focusing on|pursuing)\s+(.+)$`,
  'i',
);

const WANT_TO =
  /^(?:I'd (?:really )?(?:like|love)|I (?:really )?(?:want|wanna|hope|plan|aim|intend|need)|I'm (?:planning|hoping|trying|aiming|looking))\s+to\s+(work|be|become|get|land|find|do|break into|go into|end up|pursue|recruit for|apply (?:to|for)|intern|move|relocate|stay)\s+(.+)$/i;

const MY_GOAL =
  /^my (?:main |primary |current |top |big |biggest |only |real |ultimate )?(?:goal|target|focus|plan|aim|dream|priority)(?: (?:this|for this|for the|for next) (?:year|cycle|summer|semester|fall|spring))?\s*(?:is|=|:)\s*(?:to\s+)?(?:(get|land|find|break into|work|be|become|do|recruit for|apply to|intern)\s+)?(.+)$/i;

const FOUNDER =
  /^(?:we're|we are|I'm) (?:currently |now |actively )?(raising|fundraising for|closing|hiring(?: for)?|looking to hire|building|starting|founding) (.+)$/i;

const STANDING =
  /^I'm (?:a |an )?(?:rising |current |graduating )?(freshman|sophomore|junior|senior|first[- ]year|second[- ]year|third[- ]year|fourth[- ]year|final[- ]year|grad(?:uate)? student|master'?s student|mba student|mba candidate|ph\.?d\.? (?:student|candidate)|undergrad(?:uate)?(?: student)?|new grad|college student)\b(.*)$/i;

const MAJOR_AT = /^I'm (?:a |an )(?:double )?(.+?) (?:major|student)(?:\s+(?:at|from)\s+(.+))?$/i;
const ATTEND = /^I (?:go to|attend|study at)\s+(.+)$/i;
const STUDY =
  /^(?:I'm |I )(?:double[- ])?(?:study|studying|major in|majoring in|concentrat(?:e|ing) in)\s+(.+?)(?:\s+at\s+(.+))?$/i;
const MY_MAJOR = /^my (?:major|majors|concentration) (?:is|are)\s+(.+)$/i;
const GRADUATING =
  /^(?:I'm (?:the )?class of|I graduate(?: in| this| next)?|I'm graduating(?: in)?|I'll graduate(?: in)?|I'm going to graduate(?: in)?)\s+(?:(?:spring|summer|fall|winter|may|june|december|dec|january|jan)\s+(?:of\s+)?)?'?(20\d\d|\d\d)\b/i;

const EXPERIENCE =
  /^I (?:interned|worked|was an? (.+?)|did an? (?:(.+?) )?internship|had an? (?:(.+?) )?internship|spent (?:last|this|the) summer(?: interning| working)?) (at|for|with) (.+?)(?:\s+as an? (.+?))?(?:\s+(?:last|this|in the|during the) (?:summer|year|spring|fall|semester|winter)|\s+in (?:20\d\d|the summer(?: of 20\d\d)?)|\s+(?:back )?in (?:high school|college))?$/i;
/** "I was a PM intern at X": the words before "at" must be a role. */
const TITLE_LIKE =
  /\b(intern|analyst|engineer|developer|associate|manager|consultant|assistant|researcher|fellow|designer|scientist|specialist|representative|tutor|ta|founder|co-?founder|lead|director|trader|banker|editor|writer|organizer|coordinator|officer|volunteer|contractor|apprentice)s?\b/i;

const CURRENT_JOB =
  /^(?:I'm (?:interning|working|employed)|I (?:currently )?work) (?:at|for) (.+?)(?:\s+as an? (.+?))?(?:\s+(?:this|right now) (?:summer|semester|year))?$/i;

const DONT_CONTACT =
  /^(?:please )?(?:don't|do not|never|stop) (?:ever )?(?:contact(?:ing)?|email(?:ing)?|e-mail|messag(?:e|ing)|reach(?:ing)? out to|text(?:ing)?|dm(?:ing)?|ping(?:ing)?|writ(?:e|ing) to|cold email(?:ing)?|bother(?:ing)?|suggest(?:ing)?|recommend(?:ing)?)\s+(.+)$/i;
const DONT_WANT_CONTACT =
  /^I (?:don't|do not|never) want (?:you )?to (?:contact|email|message|reach out to|talk to|hear from|text|dm)\s+(.+)$/i;

const NOT_INTERESTED =
  /^I'm not (?:at all |really |even )?(interested in|looking (?:for|at|into)|targeting|recruiting for|applying (?:to|for)|doing|pursuing|into|open to)\s+(.+)$/i;
const DONT_WANT =
  /^I (?:don't|do not|never) want (?:to (?:work in|work at|work for|work on|go into|do|recruit for|apply to|be in|live in|move to)\s+)?(.+)$/i;

const CANT = /^I (?:can't|cannot|can not|won't be able to|am unable to|'m unable to)\s+(.+)$/i;
const AVAILABLE = /^I'm (only )?(?:available|free)\s+(.+)$/i;
const AWAY =
  /^I'm (?:going to be |gonna be )?(busy|away|traveling|travelling|abroad|studying abroad|out of (?:town|the country|office)|unavailable|on vacation|offline)\b\s*(.*)$/i;
/** "free tomorrow at 3", "busy today": true for a day, not worth keeping. */
const TRANSIENT =
  /\b(today|tonight|tomorrow|this (?:morning|afternoon|evening)|right now|now|at the moment|rn)\b/i;
const DEADLINE = /^I (?:need|have) to (.+?) (by|before|until) (.+)$/i;

const PREFER =
  /^I(?:'d| would)? (?:really |usually |generally |strongly )?(prefer|rather|like to|love to|always|never|usually|typically|tend to|hate|dislike|don't like|do not like)\s+(.+)$/i;

const OUTCOME =
  /^I (?:just |finally )?(got|received|accepted|signed|landed|secured|have|'ve got|got back|took) (?:an? |the |my |their )?((?:return |full[- ]time |internship |verbal |written )?offers?|internships?|interviews?|first round|final rounds?|superday|referrals?|jobs?|positions?|roles?)(?:\s+(?:from|at|with|for)\s+(.+))?$/i;
const REJECTED = /^I (?:was|got) (?:rejected|turned down|declined) (?:by|from|at)\s+(.+)$/i;

const BASED = /^(?:I'm |I )(?:based|live|living|located) in\s+(.+)$/i;
const MOVING = /^I'm (?:moving|relocating) to\s+(.+)$/i;

const NOT_AN_OBJECT =
  /^(?:it|that|this|these|those|them|you|your|the draft|the message|this one|that one|one)\b/i;
/** Things a student "can't" do that are about the app, not their life ("I can't find the button"). */
const CANT_APP =
  /^(?:find|see|remember|believe|wait|figure|get it|log|open|load|access|tell|seem|understand|stand|click|upload|download|connect|sign|read|hear)\b/i;

/** A person's name as the student typed it: 1 to 4 capitalised words, nothing else. */
function personNameIn(s: string): string | undefined {
  const t = s.replace(/\s+(?:again|anymore|any more|ever|for now|please|until .+)$/i, '').trim();
  return /^[A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,3}$/u.test(t) &&
    !/^(?:anyone|anybody|people|recruiters?|them|him|her)$/i.test(t)
    ? t
    : undefined;
}

/** Majors as a list: "CS and Econ" → ["CS", "Econ"]; "computer science" → ["Computer Science"]. */
function majorsOf(s: string): string[] {
  return s
    .replace(/\s+(?:with a minor in|minoring in|and minoring in)\s+.+$/i, '')
    .split(/\s*(?:,|&|\band\b|\bplus\b|\/)\s*/i)
    .map((m) =>
      m
        .replace(/^(?:a |the )?(?:double major in |degree in |major in |b\.?s\.? in |b\.?a\.? in )/i, '')
        .replace(/\s+(?:major|degree)$/i, '')
        .trim(),
    )
    .filter((m) => m.length >= 2 && m.split(/\s+/).length <= 4 && !/^(?:for|abroad|hard|late|now)$/i.test(m))
    .map((m) => (m === m.toLowerCase() ? m.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : m))
    .map((m) => m.replace(/\bOf\b|\bAnd\b/g, (w) => w.toLowerCase()));
}

const ACADEMIC_SUBJECT =
  /\b(computer science|cs|economics|econ|finance|math(?:ematics)?|statistics|stats|physics|chemistry|biology|psychology|psych|history|english|philosophy|political science|poli ?sci|government|engineering|data science|business|marketing|accounting|cognitive science|cog ?sci|neuroscience|sociology|architecture|design|information science|info ?sci|mechanical|electrical|computer engineering|ece|eecs|operations research|public policy|international relations|anthropology|linguistics|journalism|communications|biomedical|chemical|industrial|applied math|music|art|film)\b/i;

/** The school in "at Cornell studying CS" / "at the University of Michigan". */
function schoolIn(s: string): string | undefined {
  const name = s
    .replace(/^(?:the )?/i, (m) => (m ? '' : m))
    .replace(/\s*,?\s*(?:studying|majoring|where|and|in|doing|class of|graduating)\b.*$/i, '')
    .replace(/[.,;]+$/, '')
    .trim();
  const proper = /^(?:the\s+)?[A-Z]/.test(name) ? name.replace(/^the\s+/i, '') : undefined;
  return proper && looksLikeSchool(proper) && !looksLikeCompany(proper) ? proper : undefined;
}

/** "In New York City" / "Boston, MA" as the student wrote it, or undefined when it is not a place. */
function placeIn(s: string): string | undefined {
  const t = trimObject(s)
    .replace(/\s+(?:for|with|since|until|right now|now)\b.*$/i, '')
    .trim();
  const known = locationsIn(t);
  if (known.length === 1) return known[0];
  return /^[A-Z][\p{L}.'’-]+(?:[\s,]+[A-Z][\p{L}.'’-]+){0,3}$/u.test(t) ? t : undefined;
}

type RuleOut = { memory?: StatedMemory; recruiting?: RecruitingHints; profile?: Omit<ProfileHints, 'quote'> };

const SEEK_WORDS: Record<string, { text: string; strong: boolean }> = {
  targeting: { text: 'Targeting', strong: true },
  'aiming for': { text: 'Aiming for', strong: true },
  'aiming at': { text: 'Aiming for', strong: true },
  'going for': { text: 'Going for', strong: true },
  'going after': { text: 'Going after', strong: true },
  'set on': { text: 'Set on', strong: true },
  'recruiting for': { text: 'Recruiting for', strong: true },
  'recruiting in': { text: 'Recruiting in', strong: true },
  'applying to': { text: 'Applying to', strong: true },
  'applying for': { text: 'Applying for', strong: true },
  'interviewing for': { text: 'Interviewing for', strong: true },
  'in the market for': { text: 'Looking for', strong: true },
  'looking for': { text: 'Looking for', strong: false },
  'looking at': { text: 'Looking at', strong: false },
  'looking into': { text: 'Looking into', strong: false },
  'searching for': { text: 'Looking for', strong: false },
  'hunting for': { text: 'Looking for', strong: false },
  'interested in': { text: 'Interested in', strong: false },
  'focused on': { text: 'Focused on', strong: false },
  'focusing on': { text: 'Focused on', strong: false },
  pursuing: { text: 'Pursuing', strong: false },
};

function seekingVerb(v: string): { text: string; strong: boolean } {
  const k = v.toLowerCase().replace(/\s+/g, ' ');
  if (SEEK_WORDS[k]) return SEEK_WORDS[k]!;
  // "trying to land", "hoping to break into"
  const m = k.match(/^(?:trying|hoping) to (get|land|break into|find)$/);
  if (m) return { text: `Wants to ${m[1]}`, strong: true };
  return { text: cap(k), strong: false };
}

/** Non-recruiting things a student may be looking for: kept as a memory, never as recruiting targets. */
const OTHER_SEEKING =
  /^(?:an? |some |more )?(mentors?|co-?founders?|cofounders?|investors?|funding|customers?|clients?|advice|advisors?|collaborators?|research (?:collaborators?|partners?)|a lab|a research position|people to hire|engineers to hire)\b/i;

function seeking(verb: string, object: string, quote: string): RuleOut | undefined {
  const v = seekingVerb(verb);
  const obj = trimObject(object);
  if (!obj || NOT_AN_OBJECT.test(obj)) return undefined;
  if (OTHER_SEEKING.test(obj))
    return {
      memory: {
        kind: 'goal_detail',
        text: clip(`${v.text} ${thirdPerson(obj)}`),
        quote,
        importance: 0.75,
      },
    };
  const hints = recruitingHintsFrom(obj, quote, { strong: v.strong });
  if (!hints) return undefined;
  return {
    memory: { kind: 'goal_detail', text: clip(`${v.text} ${thirdPerson(obj)}`), quote, importance: 0.8 },
    recruiting: hints,
  };
}

function wantTo(verb: string, object: string, quote: string): RuleOut | undefined {
  const v = verb.toLowerCase();
  const obj = trimObject(object);
  if (!obj || NOT_AN_OBJECT.test(obj)) return undefined;
  const said = `${v} ${obj}`;
  if (v === 'move' || v === 'relocate' || v === 'stay') {
    const place = placeIn(obj.replace(/^(?:to|in|near)\s+/i, ''));
    if (!place) return undefined;
    const known = locationsIn(place);
    return {
      memory: {
        kind: 'preference',
        text: clip(
          `Wants to ${v} ${/^(?:to|in|near)\b/i.test(obj) ? '' : v === 'stay' ? 'in ' : 'to '}${obj}`.replace(
            /\s+/g,
            ' ',
          ),
        ),
        quote,
        importance: 0.7,
      },
      recruiting: known.length
        ? {
            functions: [],
            roles: [],
            industries: [],
            locations: known,
            organizations: [],
            phrase: obj,
            quote,
          }
        : undefined,
    };
  }
  if (OTHER_SEEKING.test(obj)) return undefined;
  const hints = recruitingHintsFrom(said, quote, {
    strong: [
      'work',
      'intern',
      'recruit for',
      'apply to',
      'apply for',
      'break into',
      'go into',
      'become',
      'be',
      'land',
    ].includes(v),
    leadingOrgs: ['apply to', 'apply for', 'recruit for'].includes(v),
  });
  if (!hints) return undefined;
  // "be in New York" is a place; "be a PM" a role
  if ((v === 'be' || v === 'become') && !hints.functions.length && !hints.locations.length) return undefined;
  return {
    memory: { kind: 'goal_detail', text: clip(`Wants to ${thirdPerson(said)}`), quote, importance: 0.8 },
    recruiting: hints,
  };
}

/** The rules, most specific first; the first that matches a clause decides it. */
function readClause(c: string, quote: string): RuleOut | undefined {
  let m: RegExpMatchArray | null;

  // never contact someone
  if ((m = c.match(DONT_CONTACT) ?? c.match(DONT_WANT_CONTACT))) {
    const who = trimObject(m[1]!);
    if (!who || NOT_AN_OBJECT.test(who)) return undefined;
    const person = personNameIn(who);
    return {
      memory: {
        kind: 'constraint',
        text: clip(`Does not want to contact ${thirdPerson(who)}`),
        quote,
        importance: 0.9,
        personName: person,
      },
    };
  }
  if ((m = c.match(NOT_INTERESTED))) {
    const obj = trimObject(m[2]!);
    if (!obj || NOT_AN_OBJECT.test(obj)) return undefined;
    return {
      memory: {
        kind: 'constraint',
        text: clip(`Not ${m[1]!.toLowerCase()} ${thirdPerson(obj)}`),
        quote,
        importance: 0.75,
      },
    };
  }
  if ((m = c.match(DONT_WANT))) {
    const obj = trimObject(m[1]!);
    // "I don't want to bother you": only the ways of working the pattern names are constraints
    if (!obj || NOT_AN_OBJECT.test(obj) || /^to\b/i.test(obj) || obj.split(/\s+/).length > 14)
      return undefined;
    const verb = c.match(
      /want (to (?:work in|work at|work for|work on|go into|do|recruit for|apply to|be in|live in|move to))/i,
    )?.[1];
    return {
      memory: {
        kind: 'constraint',
        text: clip(`Does not want ${verb ? `${verb} ` : ''}${thirdPerson(obj)}`),
        quote,
        importance: 0.75,
      },
    };
  }

  // looking for work
  if ((m = c.match(IM_SEEKING))) return seeking(m[1]!, m[2]!, quote);
  if ((m = c.match(WANT_TO))) return wantTo(m[1]!, m[2]!, quote);
  if ((m = c.match(MY_GOAL))) {
    const verb = m[1]?.toLowerCase();
    const obj = trimObject(m[2]!);
    if (!obj || NOT_AN_OBJECT.test(obj)) return undefined;
    const hints = recruitingHintsFrom(obj, quote, { strong: true, leadingOrgs: verb === 'apply to' });
    if (!hints && !OTHER_SEEKING.test(obj)) return undefined;
    return {
      memory: {
        kind: 'goal_detail',
        text: clip(`Goal: ${verb ? `${verb} ` : ''}${thirdPerson(obj)}`),
        quote,
        importance: 0.85,
      },
      recruiting: hints,
    };
  }
  if ((m = c.match(FOUNDER))) {
    const verb = m[1]!.toLowerCase();
    const obj = trimObject(m[2]!);
    if (!obj || NOT_AN_OBJECT.test(obj)) return undefined;
    if (
      /^(?:building|starting|founding)$/.test(verb) &&
      !/\b(start-?up|company|app|platform|product|business|nonprofit)\b/i.test(obj)
    )
      return undefined;
    if (verb === 'closing' && !/\b(round|seed|pre-seed|series)\b/i.test(obj)) return undefined;
    return {
      memory: {
        kind: 'goal_detail',
        text: clip(`${cap(verb === 'looking to hire' ? 'looking to hire' : verb)} ${thirdPerson(obj)}`),
        quote,
        importance: 0.8,
      },
    };
  }

  // who they are
  if ((m = c.match(STANDING))) {
    const standing = m[1]!.toLowerCase();
    const rest = m[2]!.trim();
    const at = rest.match(/\b(?:at|from)\s+(.+)$/i);
    const school = at ? schoolIn(at[1]!) : undefined;
    const study = rest.match(/\b(?:studying|majoring in|doing|in)\s+(.+?)(?=\s+at\b|$)/i);
    const majors = study && ACADEMIC_SUBJECT.test(study[1]!) ? majorsOf(study[1]!) : undefined;
    // "a junior at heart" is not a school; keep the standing only when the rest is a school or a subject
    if (rest && !school && !majors?.length) {
      if (at || study) return undefined;
      if (!/^[,.]?\s*$/.test(rest)) return undefined;
    }
    const text = `Is a ${standing}${school ? ` at ${school}` : ''}${majors?.length ? ` studying ${majors.join(' and ')}` : ''}`;
    return {
      memory: { kind: 'note', text: clip(text), quote, importance: 0.6 },
      profile: { standing, school, majors },
    };
  }
  if ((m = c.match(GRADUATING))) {
    const y = m[1]!.length === 2 ? Number(`20${m[1]}`) : Number(m[1]);
    if (y < 2000 || y > 2100) return undefined;
    return {
      memory: { kind: 'note', text: `Graduates in ${y}`, quote, importance: 0.6 },
      profile: { graduationYear: y },
    };
  }
  if ((m = c.match(STUDY) ?? c.match(MY_MAJOR)) && ACADEMIC_SUBJECT.test(m[1]!)) {
    const subject = m[1]!;
    const majors = majorsOf(subject.replace(/\s+at\s+.+$/i, ''));
    if (!majors.length) return undefined;
    const school = m[2] ? schoolIn(m[2]) : undefined;
    return {
      memory: {
        kind: 'note',
        text: clip(`Studies ${majors.join(' and ')}${school ? ` at ${school}` : ''}`),
        quote,
        importance: 0.6,
      },
      profile: { majors, school },
    };
  }
  if ((m = c.match(MAJOR_AT)) && ACADEMIC_SUBJECT.test(m[1]!)) {
    const majors = majorsOf(m[1]!);
    if (!majors.length) return undefined;
    const school = m[2] ? schoolIn(m[2]) : undefined;
    if (m[2] && !school) return undefined;
    return {
      memory: {
        kind: 'note',
        text: clip(`Studies ${majors.join(' and ')}${school ? ` at ${school}` : ''}`),
        quote,
        importance: 0.6,
      },
      profile: { majors, school },
    };
  }
  if ((m = c.match(ATTEND))) {
    const school = schoolIn(m[1]!);
    if (!school) return undefined;
    return {
      memory: { kind: 'note', text: `Goes to ${school}`, quote, importance: 0.6 },
      profile: { school },
    };
  }

  // where they have worked
  if ((m = c.match(EXPERIENCE))) {
    const role = (m[1] ?? m[2] ?? m[3] ?? m[6])?.trim();
    const org = trimObject(m[5]!);
    if (!org || NOT_AN_OBJECT.test(org) || org.split(/\s+/).length > 8) return undefined;
    // "I worked with Maya on a project" is about a person, not an employer
    if (m[4]!.toLowerCase() === 'with' && /^I (?:worked|was)/i.test(c)) return undefined;
    // "I was a junior at Cornell" is a school, read elsewhere; "I was a member of ..." has no employer
    if (m[1] && !TITLE_LIKE.test(m[1])) return undefined;
    if (looksLikeSchool(org) && !looksLikeCompany(org) && !/\b(lab|center|centre|office)\b/i.test(org))
      return undefined;
    const verb = /^I interned/i.test(c) || /internship|summer/i.test(c) ? 'Interned' : 'Worked';
    return {
      memory: {
        kind: 'note',
        text: clip(
          `${verb} at ${thirdPerson(org)}${role ? ` as ${/^an? /i.test(role) ? '' : /^[aeiou]/i.test(role) ? 'an ' : 'a '}${thirdPerson(role)}` : ''}`,
        ),
        quote,
        importance: 0.6,
      },
    };
  }
  if ((m = c.match(CURRENT_JOB))) {
    const org = trimObject(m[1]!);
    if (!org || NOT_AN_OBJECT.test(org) || org.split(/\s+/).length > 8) return undefined;
    const role = m[2]?.trim();
    return {
      memory: {
        kind: 'note',
        text: clip(
          `Works at ${thirdPerson(org)}${role ? ` as ${/^[aeiou]/i.test(role) ? 'an' : 'a'} ${thirdPerson(role)}` : ''}`,
        ),
        quote,
        importance: 0.6,
      },
    };
  }

  // results
  if ((m = c.match(OUTCOME))) {
    const verb = m[1]!.toLowerCase();
    const what = m[2]!.toLowerCase();
    const from = m[3] ? trimObject(m[3]) : '';
    const has = verb === 'have' || verb === "'ve got";
    const article = /^(offers|internships|interviews|final rounds|referrals|jobs|positions|roles)$/.test(what)
      ? ''
      : /^[aeiou]/.test(what)
        ? 'an '
        : 'a ';
    const verbText = has
      ? 'Has'
      : verb === 'accepted' || verb === 'signed' || verb === 'took'
        ? cap(verb)
        : verb === 'got back'
          ? 'Got back'
          : 'Got';
    return {
      memory: {
        kind: has && /interview|round|superday/.test(what) ? 'goal_detail' : 'outcome',
        text: clip(
          `${verbText} ${article}${what}${from ? ` ${has ? 'with' : 'from'} ${thirdPerson(from)}` : ''}`,
        ),
        quote,
        importance: 0.75,
      },
    };
  }
  if ((m = c.match(REJECTED))) {
    const from = trimObject(m[1]!);
    if (!from) return undefined;
    return { memory: { kind: 'outcome', text: clip(`Was turned down by ${from}`), quote, importance: 0.6 } };
  }

  // time and constraints
  if ((m = c.match(CANT))) {
    const obj = trimObject(m[1]!);
    if (!obj || CANT_APP.test(obj) || NOT_AN_OBJECT.test(obj)) return undefined;
    return {
      memory: { kind: 'constraint', text: clip(`Cannot ${thirdPerson(obj)}`), quote, importance: 0.7 },
    };
  }
  if ((m = c.match(AVAILABLE))) {
    const obj = trimObject(m[2]!);
    if (!obj || TRANSIENT.test(obj)) return undefined;
    return {
      memory: {
        kind: 'constraint',
        text: clip(`${m[1] ? 'Only available' : 'Available'} ${thirdPerson(obj)}`),
        quote,
        importance: 0.7,
      },
    };
  }
  if ((m = c.match(AWAY))) {
    const rest = trimObject(m[2] ?? '');
    if (!rest || TRANSIENT.test(rest)) return undefined;
    return {
      memory: {
        kind: 'constraint',
        text: clip(`Is ${m[1]!.toLowerCase()} ${thirdPerson(rest)}`),
        quote,
        importance: 0.7,
      },
    };
  }
  if ((m = c.match(DEADLINE))) {
    return {
      memory: {
        kind: 'constraint',
        text: clip(`Needs to ${thirdPerson(trimObject(m[1]!))} ${m[2]!.toLowerCase()} ${trimObject(m[3]!)}`),
        quote,
        importance: 0.75,
      },
    };
  }
  if ((m = c.match(BASED))) {
    const place = placeIn(m[1]!);
    if (!place) return undefined;
    return {
      memory: { kind: 'note', text: `Lives in ${place}`, quote, importance: 0.5 },
      profile: { currentCity: place },
    };
  }
  if ((m = c.match(MOVING))) {
    const place = placeIn(m[1]!.replace(/\s+(?:in|after|this|next|once)\b.*$/i, ''));
    if (!place) return undefined;
    return {
      memory: { kind: 'note', text: clip(`Is moving to ${trimObject(m[1]!)}`), quote, importance: 0.6 },
    };
  }

  // how they like to work
  if ((m = c.match(PREFER))) {
    const verb = m[1]!.toLowerCase();
    const obj = trimObject(m[2]!);
    if (!obj || NOT_AN_OBJECT.test(obj) || obj.split(/\s+/).length < 2) return undefined;
    // "I like to work in NYC" is a target, read above; "I love it" is feedback, not a preference
    const lead: Record<string, string> = {
      prefer: 'Prefers',
      rather: 'Would rather',
      'like to': 'Likes to',
      'love to': 'Loves to',
      always: 'Always',
      never: 'Never',
      usually: 'Usually',
      typically: 'Usually',
      'tend to': 'Tends to',
      hate: 'Dislikes',
      dislike: 'Dislikes',
      "don't like": 'Dislikes',
      'do not like': 'Dislikes',
    };
    return {
      memory: {
        kind: 'preference',
        text: clip(`${lead[verb] ?? cap(verb)} ${thirdPerson(obj)}`),
        quote,
        importance: 0.6,
      },
    };
  }
  return undefined;
}

/** Whether the clause is the student's own plain statement (not a question, a hedge, a command or someone else's). */
function plainStatement(cl: Clause, c: string): boolean {
  if (cl.question) return false;
  if (HEDGE.test(c)) return false;
  if (sensitiveTopic(c)) return false;
  // "don't contact X" is an instruction about who to leave alone, so it may start like a command or a question
  if (DONT_CONTACT.test(c)) return true;
  if (QUESTION_START.test(c) || COMMAND.test(c)) return false;
  return /^(?:I\b|I'm\b|I've\b|I'd\b|my\b|we're\b|we are\b)/i.test(c);
}

/**
 * The clear statements in one message from the student. Empty when there are none. Each memory's quote is the clause
 * it came from, as the student wrote it.
 */
export function extractStatements(text: string): Statements {
  const out: Statements = { memories: [] };
  if (!text?.trim() || text.length > 4000) return out;
  for (const cl of clausesOf(text)) {
    const c = normalizeClause(cl.text);
    if (!c || c.length < 6 || !plainStatement(cl, c)) continue;
    const r = readClause(c, cl.text);
    if (!r) continue;
    if (r.memory && !sensitiveTopic(r.memory.text) && r.memory.text.length >= 6) {
      if (!out.memories.some((x) => memoryKey(x.text) === memoryKey(r.memory!.text)))
        out.memories.push(r.memory);
    }
    if (r.recruiting) out.recruiting = mergeHints(out.recruiting, r.recruiting);
    if (r.profile) {
      const p = r.profile;
      out.profile = {
        ...out.profile,
        ...(p.school ? { school: p.school } : {}),
        ...(p.majors?.length ? { majors: p.majors } : {}),
        ...(p.graduationYear ? { graduationYear: p.graduationYear } : {}),
        ...(p.standing ? { standing: p.standing } : {}),
        ...(p.currentCity ? { currentCity: p.currentCity } : {}),
        quote: out.profile ? `${out.profile.quote} ${cl.text}` : cl.text,
      };
    }
  }
  return out;
}

/** Two sets of targets as one (lists joined, the first cycle and phrase kept). */
export function mergeHints(a: RecruitingHints | undefined, b: RecruitingHints): RecruitingHints {
  if (!a) return b;
  return {
    functions: uniq([...a.functions, ...b.functions]),
    roles: uniq([...a.roles, ...b.roles]),
    industries: uniq([...a.industries, ...b.industries]),
    locations: uniq([...a.locations, ...b.locations]),
    organizations: uniq([...a.organizations, ...b.organizations]),
    employment: a.employment ?? b.employment,
    cycleLabel: a.cycleLabel ?? b.cycleLabel,
    stage: a.stage ?? b.stage,
    phrase: a.phrase,
    quote: `${a.quote} ${b.quote}`,
  };
}

/**
 * Keep only the targets the student actually said: function codes, industries and places Orbit's vocabulary finds in
 * their words, and company names that appear in them. Used on what a model read, so a guess never becomes a goal.
 */
export function groundHints(
  h: Partial<RecruitingHints>,
  said: string,
  quote: string,
): RecruitingHints | undefined {
  const words = squashWords(said);
  const fns = functionsIn(said);
  const inds = industriesIn(said);
  const locs = locationsIn(said);
  const functions = uniq((h.functions ?? []).map((f) => f.toLowerCase()).filter((f) => fns.includes(f)));
  const industries = uniq(
    (h.industries ?? []).flatMap((i) => industriesIn(i)).filter((i) => inds.includes(i)),
  );
  const locations = uniq((h.locations ?? []).flatMap((l) => locationsIn(l)).filter((l) => locs.includes(l)));
  const organizations = uniq(
    (h.organizations ?? [])
      .map((o) => o.trim())
      .filter((o) => o.length >= 2 && words.includes(squashWords(o)) && !locationsIn(o).length),
  );
  if (!functions.length && !industries.length && !locations.length && !organizations.length) return undefined;
  const employment = /\b(intern(?:ship)?s?|co-?ops?)\b/i.test(said)
    ? 'internship'
    : /\b(full[- ]time|new[- ]grad)\b/i.test(said)
      ? 'full_time'
      : undefined;
  return {
    functions,
    roles: functions.map((f) => roleForFunction(f)).filter((r): r is string => !!r),
    industries,
    locations,
    organizations,
    employment,
    cycleLabel: recruitingHintsFrom(said, quote, { strong: true })?.cycleLabel,
    stage: /\b(start-?ups?|early[- ]stage)\b/i.test(said) ? 'startup' : undefined,
    phrase: clip(trimObject(h.phrase ?? quote), 80),
    quote,
  };
}

/** Worth a model's look: a first-person sentence that is not only a question or a request to Orbit. */
export function mayHoldFacts(text: string): boolean {
  if (!text || text.trim().length < 20) return false;
  return clausesOf(text).some((cl) => {
    const c = normalizeClause(cl.text);
    if (cl.question || QUESTION_START.test(c) || COMMAND.test(c)) return false;
    return /\b(I|I'm|I've|I'd|my|me|we|we're|our)\b/i.test(c);
  });
}
