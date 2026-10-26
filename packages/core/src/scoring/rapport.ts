/**
 * Reply rapport (plan 27): how warm, personal and invested someone is in what they write to the student, read from
 * the words of one reply. Pure and synchronous. A lexical reading is made the moment a reply is stored, on every
 * channel; the reply classifier's LLM reading replaces it when it arrives. Readings feed the tie score's f16
 * (`rapport`), a shrunk, decayed mean that can move a score by a few points at most: structure dominates, wording adds
 * (Gilbert & Karahalios, CHI 2009).
 *
 * Sources: the warm and formal markers adapt the politeness strategies of Danescu-Niculescu-Mizil et al. (ACL 2013,
 * ConvoKit, MIT) and split them into closeness (questions about the student, offers, personal news, plans together)
 * and distance (deference, formal openers and sign-offs). Style matching is the function-word LSM of Ireland and
 * Pennebaker (2011) over closed word classes listed here. Valence comes from VADER (Hutto & Gilbert 2014,
 * `vader-sentiment`, Apache-2.0), passed in by the caller (`@orbit/core/vader`) so the lexicon loads only where it
 * is used.
 */

export const RAPPORT_VERSION = 1;

export const RAPPORT_CUES = [
  'asks_about_you',
  'offers_help',
  'personal_news',
  'plans_together',
  'congratulates',
  'glad_to_hear',
  'casual',
  'uses_your_name',
  'thoughtful',
  'formal',
  'distant',
  'asked_to_stop',
  'hostile',
] as const;
export type RapportCue = (typeof RAPPORT_CUES)[number];

export interface RapportReading {
  /** −1 cold … 0 neutral … +1 warm toward the student */
  score: number;
  /** the LLM reading replaces the lexical one when it arrives */
  by: 'lexical' | 'llm';
  /** labels only, never quotes */
  cues: RapportCue[];
  /** 0..1: short or ambiguous text is low */
  confidence: number;
  v: typeof RAPPORT_VERSION;
}

/** Text valence in [−1, 1] (VADER's compound score). */
export type Valence = (text: string) => number;

export interface RapportInput {
  /** their reply, quotes and signature already stripped */
  text: string;
  /** the student's first name, for "uses your name" */
  studentFirstName?: string;
  /** the student's message this answers, for effort and style matching */
  answering?: string;
  valence?: Valence;
}

const WARM_CUES: Partial<Record<RapportCue, number>> = {
  asks_about_you: 0.35,
  offers_help: 0.35,
  personal_news: 0.3,
  plans_together: 0.25,
  congratulates: 0.25,
  glad_to_hear: 0.2,
  thoughtful: 0.2,
  casual: 0.15,
  uses_your_name: 0.1,
};

// Each pattern is matched case-insensitively against the whole reply.
const PATTERNS: [RapportCue, RegExp][] = [
  [
    'asks_about_you',
    /\b(how (are|have) you|how'?s (it going|everything|life|school|the (semester|job|search|internship|program))|how (did|is|was) (your|the) [a-z]+|what (have|are) you been|what about you|how about you|hope (you'?re|you are|all is|everything|school|the semester|your)|how (are|is) (things|everything)|you doing)\b/i,
  ],
  [
    'offers_help',
    /\b(happy to (help|chat|connect|introduce|intro|share|talk|hop on|look|review|refer|pass)|glad to (help|chat|connect|introduce)|(i'?d|i would) (be )?(love|happy|glad) to|i can (intro|introduce|connect you|put you in touch|send|share|refer|pass|ask|forward|look)|let me (intro|introduce|connect you|know if (i|there'?s anything))|feel free to (reach out|ping|text|call|email|send)|reach out (any ?time|whenever)|any ?time\b|my door is (always )?open|count on me)/i,
  ],
  [
    'personal_news',
    /\b(i (just )?(got|started|moved|joined|became|bought|finished|graduated|launched)|we (just )?(had|moved|got|welcomed|bought)|(my|our) (wife|husband|partner|fianc[eé]e?|kids?|son|daughter|baby|dog|family|wedding|new (job|role|team|place|house))|i'?m (now|currently) (at|working|living|based))\b/i,
  ],
  [
    'plans_together',
    /\b(let'?s (grab|get|meet|catch|chat|hop|find|do|set|plan)|catch up|next time (you|i|we)|when you'?re (in|back|around|free|next)|we should (grab|get|meet|catch|chat)|keep in touch|talk soon|see you (soon|then|there|next))\b/i,
  ],
  [
    'congratulates',
    /\b(congrat(s|ulations)|so proud|proud of you|well[- ]deserved|huge news|amazing news|great news)\b/i,
  ],
  [
    'glad_to_hear',
    /\b((great|so good|good|lovely|nice|fun) to (hear|see) from you|great to hear|so glad|really glad|excited|thrilled|delighted|made my day|love (this|that|to hear))\b/i,
  ],
  [
    'casual',
    /(\b(haha+|hah|lol|lmao|omg|yeah|yep|yup|hey|heya|hiya|cheers|thx|ty|xx|xo|no worries|for sure|sounds fun)\b|:\)|:-\)|:D|\p{Extended_Pictographic})/iu,
  ],
  [
    'formal',
    /(^\s*(dear|to whom)\b|\b(sincerely|kind regards|best regards|warm regards|respectfully|yours truly|regards,)\b|\b(we regret|please be advised|kindly note)\b)/im,
  ],
  [
    'distant',
    /\b(not the (right|best) (person|contact)|wrong person|don'?t (really )?know you|who is this|how did you get (my|this)|i don'?t (do|take) (calls|coffee chats|informational)|i (don'?t|do not) have (the )?(time|bandwidth) for|not interested|unable to help|can'?t help you)\b/i,
  ],
  [
    'asked_to_stop',
    /\b(stop (emailing|messaging|contacting|reaching out|writing)|(please )?(remove|unsubscribe) me|do not (contact|email|message) me|don'?t (contact|email|message) me|leave me alone)\b/i,
  ],
  ['hostile', /\b(spam(ming)?|annoying|inappropriate|unprofessional|harass(ing|ment)?)\b/i],
];

const words = (text: string): string[] => text.toLowerCase().match(/[a-z']+/g) ?? [];

// Closed word classes for style matching (LSM): the categories Ireland & Pennebaker use, listed in code.
const FUNCTION_CLASSES: Record<string, Set<string>> = {
  personal: new Set(
    'i me my mine myself we us our ours ourselves you your yours yourself yourselves he him his she her hers they them their theirs'.split(
      ' ',
    ),
  ),
  impersonal: new Set(
    'it its itself this that these those something anything everything nothing someone anyone'.split(' '),
  ),
  articles: new Set('a an the'.split(' ')),
  prepositions: new Set(
    'about above across after against along among around at before behind below beside between by during for from in inside into near of off on onto out over through to toward under until up upon with within without'.split(
      ' ',
    ),
  ),
  auxiliary: new Set(
    "am is are was were be been being have has had do does did will would shall should can could may might must i'm you're we're they're it's i've you've we've i'd you'd i'll you'll we'll".split(
      ' ',
    ),
  ),
  adverbs: new Set(
    'very really just so too also then now here there even only quite rather almost always never often'.split(
      ' ',
    ),
  ),
  conjunctions: new Set(
    'and but or so because if although though while whereas unless since nor yet'.split(' '),
  ),
  negations: new Set(
    "no not never none nobody nothing neither nor don't can't won't isn't aren't wasn't didn't doesn't".split(
      ' ',
    ),
  ),
  quantifiers: new Set('all some many much more most few several any each every both lot lots'.split(' ')),
};

/** Language style matching in [0, 1] over the closed word classes; undefined when either text is too short. */
export function styleMatch(a: string, b: string): number | undefined {
  const wa = words(a);
  const wb = words(b);
  if (wa.length < 15 || wb.length < 15) return undefined;
  const share = (ws: string[], set: Set<string>) => ws.filter((w) => set.has(w)).length / ws.length;
  const parts = Object.values(FUNCTION_CLASSES).map((set) => {
    const pa = share(wa, set);
    const pb = share(wb, set);
    return 1 - Math.abs(pa - pb) / (pa + pb + 0.0001);
  });
  return parts.reduce((s, x) => s + x, 0) / parts.length;
}

const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));

/**
 * The lexical reading of one reply. Brevity is never negative on its own ("ok" is neutral, not cold); a decline is
 * about the ask, not the relationship, so only distancing, a request to stop, or hostility reads cold; formal
 * register pulls warmth toward neutral without making it negative.
 */
export function replyRapport(input: RapportInput): RapportReading {
  const text = input.text.trim();
  const ws = words(text);
  const cues = new Set<RapportCue>();
  for (const [cue, re] of PATTERNS) if (re.test(text)) cues.add(cue);
  const name = input.studentFirstName?.trim();
  if (
    name &&
    name.length >= 2 &&
    new RegExp(`\\b${name.replace(/[^\p{L}\p{N}' -]/gu, '')}\\b`, 'iu').test(text)
  )
    cues.add('uses_your_name');
  const theirs = input.answering ? words(input.answering).length : 0;
  if (ws.length >= 60 && ws.length >= Math.max(20, theirs)) cues.add('thoughtful');

  // a name in "Dear Alex" is register, not warmth
  if (cues.has('formal')) cues.delete('uses_your_name');
  let sum = 0;
  for (const c of cues) sum += WARM_CUES[c] ?? 0;
  if (input.valence && ws.length >= 3) sum += 0.25 * clamp(input.valence(text));
  if (cues.has('formal')) sum *= 0.5;
  if (cues.has('distant')) sum -= 0.45;
  if (cues.has('hostile')) sum -= 0.8;
  const lsm = input.answering ? styleMatch(text, input.answering) : undefined;
  if (lsm !== undefined) sum += 0.1 * clamp((lsm - 0.5) * 2);
  let score = Math.tanh(sum);
  if (cues.has('asked_to_stop')) score = -1;

  const cueCount = [...cues].filter((c) => c !== 'formal').length;
  const base = ws.length < 4 ? 0.3 : ws.length < 15 ? 0.6 : 0.85;
  const confidence = Math.max(base, cueCount ? 0.7 : 0);
  return {
    score: Math.round(clamp(score) * 1000) / 1000,
    by: 'lexical',
    cues: RAPPORT_CUES.filter((c) => cues.has(c)),
    confidence,
    v: RAPPORT_VERSION,
  };
}

/** The reply classifier's rapport fields (browser `llmSignal`, server `classify.message`). */
export interface LlmRapport {
  /** −2 cold … +2 warm toward the student, separate from their answer to the ask */
  warmth: number;
  familiarity: 'stranger' | 'professional' | 'friendly' | 'friend';
  /** 0 minimal … 2 a long, thoughtful reply */
  effort: number;
  cues?: string[];
}

const FAMILIARITY: Record<LlmRapport['familiarity'], number> = {
  stranger: -0.05,
  professional: 0,
  friendly: 0.1,
  friend: 0.2,
};

/** The LLM's rapport fields as a reading; its cues are kept only when they are known labels. */
export function rapportFromLlm(r: LlmRapport): RapportReading {
  const known = new Set<string>(RAPPORT_CUES);
  const cues = RAPPORT_CUES.filter((c) => (r.cues ?? []).includes(c) && known.has(c));
  let score =
    clamp((Number(r.warmth) || 0) / 2) * 0.8 +
    (FAMILIARITY[r.familiarity] ?? 0) +
    clamp(r.effort, 0, 2) * 0.03;
  if (cues.includes('asked_to_stop')) score = -1;
  return {
    score: Math.round(clamp(score) * 1000) / 1000,
    by: 'llm',
    cues,
    confidence: 0.9,
    v: RAPPORT_VERSION,
  };
}

/** A stored reading, if the value is one (jsonb from the server, a Dexie row). */
export function asRapportReading(x: unknown): RapportReading | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const r = x as Partial<RapportReading>;
  if (typeof r.score !== 'number' || !Number.isFinite(r.score)) return undefined;
  return {
    score: clamp(r.score),
    by: r.by === 'llm' ? 'llm' : 'lexical',
    cues: Array.isArray(r.cues) ? RAPPORT_CUES.filter((c) => r.cues!.includes(c)) : [],
    confidence: typeof r.confidence === 'number' ? clamp(r.confidence, 0, 1) : 0.6,
    v: RAPPORT_VERSION,
  };
}

/** The LLM instructions for the rapport fields, shared by both classifiers so they read replies the same way. */
export const RAPPORT_LLM_GUIDE = `rapport: how the sender feels about the student, separate from their answer to the request.
- warmth −2..2: 2 = clearly warm and personal (asks about the student, offers help or intros, shares their own news, suggests meeting up); 0 = neutral or businesslike, including short replies such as "ok" or "sounds good"; −2 = distant, annoyed, or asks not to be contacted. A polite decline that wishes the student well is warm, not cold.
- familiarity: stranger, professional, friendly, or friend, from how they write to the student.
- effort 0..2: 0 a one-liner, 1 a normal reply, 2 a long, thoughtful reply.
- cues: any of ${RAPPORT_CUES.join(', ')} that apply.`;
