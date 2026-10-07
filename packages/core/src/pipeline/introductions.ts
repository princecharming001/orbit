import type { EmailMessage, Person } from '../types';

/**
 * Reading introductions in group email.
 *
 * The question for every inbound message with the student on it: is the sender introducing the student to someone
 * else on the To or CC line ("Alex, meet Sam", "looping in Ana", "Introduction: Alex / Sam"), is it an answer inside
 * an introduction thread ("Thanks for the intro, Lena", "moving Lena to bcc", a reply-all with times), or neither
 * ("great to meet you both", "let's meet Tuesday", a CC with no introduction, an assistant brought in to schedule)?
 *
 * The text is read as sentences and clauses (split at punctuation and dashes). Each clause is first checked for
 * thanks about an introduction or a bcc move; such clauses only ever mark the people in them as thanked (the
 * introducer, seen from a reply). Every other clause can carry introduction cues, scored per person on the thread:
 *
 *  - STRONG (3): a cue pointed at the person: "meet Sam", "introduce Sam", "connecting you with Sam", "you should
 *    talk to Sam", "looping in Sam", "+Sam", "Sam (cc'd)", "Sam is happy to chat", "Sam is the friend I mentioned",
 *    "this is Sam", "Alex, Sam. Sam, Alex.", a subject "Alex <> Sam"; or the person is in a sentence whose
 *    introducing verb is aimed at someone ("Sam, please meet Alex", "I would like to introduce Alex to you, Sam").
 *  - GENERIC (2): the message carries an introducing phrase that names no one ("connecting you two", "making the
 *    introduction", "you two should talk", "Alex is a junior I mentor", subject "Introduction: ...") and the person
 *    is named in it; or the message has the shape of an introduction: a new thread that says who a copied person
 *    is ("Mei is an engineer at Databricks") with nothing showing they are copied for another reason ("Sam and I",
 *    "Tom will run your mock case", "cc'd for the paperwork"), a note to the person about the student who is copied
 *    ("Marcus, Alex (cc) built the plugin. Worth a chat?"), or a sentence to the person about the student ("Siobhan,
 *    Alex is deciding between Bain and McKinsey").
 *
 * Decision order:
 *  1. Gates: a human message that is not machine mail. An inbound one needs the student on the To or CC line. An
 *     outbound one (the student's own) can be an `intro_reply`, never an introduction.
 *  2. People who cannot be introduced are set aside: the sender, the student, the introducer and the people already
 *     introduced on the thread (`prior`), anyone thanked for the intro or moved to bcc, an assistant brought in
 *     to schedule ("cc'ing my EA Jordan to set up time", "Jordan (cc'd) can find us 30 min"), and anyone pointed at
 *     only in sentences that copy them for an administrative reason ("cc'd Chris from our HR team for the
 *     paperwork", "for visibility since she's coordinating"). A clause offering to introduce later ("Would you like
 *     me to introduce you to someone at McKinsey?") carries no cue at all.
 *  3. Everyone left scoring at least 2 is introduced: `introduction`.
 *  4. Otherwise the message is an `intro_reply` when the thread already holds an introduction, someone is thanked
 *     for one, someone is moved to bcc, the reply speaks to the person on the thread and then gives the student a
 *     time ("Ines, you are too kind. Alex, Monday at 11?"), or the subject answers an introduction subject
 *     ("Re: Intro: Alex <> Sam").
 *  5. Otherwise `none`.
 *
 * Whatever the decision, `possible` keeps the fallback's evidence for each person the cues did not settle (named,
 * said who they are, pointed to as someone to talk to, against logistics and shared work), so the app can ask
 * "Did Lena introduce you to Sam?" about a group email the cues missed (`possibleIntroduction`) instead of losing it.
 *
 * Deterministic and dependency-free: small lexicons and anchored patterns, no model. The labelled corpus in
 * `__tests__/fixtures/intro-corpus.ts` pins it.
 */

export interface Introduction {
  /** the person who wrote the introduction */
  introducerId: string;
  /** the people introduced to the student (on the To or CC line and named in the message) */
  introducedIds: string[];
  messageId: string;
  at: string;
}

export type IntroductionKind = 'introduction' | 'intro_reply' | 'none';

export interface IntroductionReading {
  kind: IntroductionKind;
  /** the sender, when the message is an introduction */
  introducerId?: string;
  /** the people introduced to the student */
  introducedIds: string[];
  /** where the student is on the message: an introduction often puts the student on CC */
  studentOn?: 'to' | 'cc';
  /** people thanked on the message (the introducer, seen from a reply) */
  thankedIds: string[];
  /** people thanked for an introduction or moved to bcc: the one who made it */
  introThankedIds: string[];
  /** people brought in only to find a time (an assistant): never an introduction */
  schedulerIds: string[];
  /** the rule that decided, for debugging and the corpus report */
  reason: string;
  /**
   * How much the message looks like an introduction of each person on it whom the cues did not settle, for the
   * fallback question ("Did Lena introduce you to Sam?"). Read whatever the decision; see `possibleIntroduction`.
   */
  possible: PossibleCue[];
}

/** The fallback's evidence that the sender may be introducing one person on the message. */
export interface PossibleCue {
  personId: string;
  score: number;
  /** what added up, for debugging and the corpus report */
  cues: string[];
}

export interface IntroductionContext {
  /** the student's names ("Alex", "Alex Rivera"), so "Sam, meet Alex" and "Alex <> Sam" are understood */
  studentNames?: string[];
  /** the introduction already recorded on the thread: answers in it are replies, not new introductions */
  prior?: Pick<Introduction, 'introducerId' | 'introducedIds'>;
}

type Msg = Pick<
  EmailMessage,
  | 'id'
  | 'direction'
  | 'isAutomated'
  | 'fromPersonId'
  | 'fromEmail'
  | 'toEmails'
  | 'ccEmails'
  | 'subject'
  | 'bodyText'
  | 'sentAt'
>;
type IntroPerson = Pick<Person, 'id' | 'firstName' | 'emails' | 'isHuman'> &
  Partial<Pick<Person, 'lastName'>>;

const STRONG = 3;
const GENERIC = 2;
const THRESHOLD = 2;

// ---- text helpers ------------------------------------------------------------------------------------------------

/** "José" and "Jose" are the same name; curly apostrophes are straight ones. */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').replace(/[‘’]/g, "'");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (alt: string, flags: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}'])(?:${alt})(?![\\p{L}\\p{N}])`, `${flags}u`);

/** Sentences: split at end punctuation and line breaks. */
const sentencesOf = (text: string) =>
  text
    .split(/(?<!\b(?:Co|Inc|Ltd|Corp|Dr|Prof|Mr|Ms|Mrs|Jr|Sr|St|vs|etc|e\.g|i\.e))(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
/** Clauses: split at commas, semicolons, colons, brackets and dashes ("Alex - meet Sam", "Alex — meet Sam"). */
const CLAUSE_SPLIT = /\s*(?:[,;:()]|\s-{1,2}\s|[–—]+)\s*/;
const clausesOf = (sentence: string) => sentence.split(CLAUSE_SPLIT).filter((c) => c.trim());

// ---- lexicons ----------------------------------------------------------------------------------------------------

/** Between a verb and the name: "my former colleague Sam", "our friend Ana". */
const DESC =
  '(?:(?:my|our|his|her|their)\\s+)?(?:(?:old|former|good|dear|great|close|wonderful)\\s+)?(?:(?:friend|colleague|teammate|coworker|co-worker|advisor|adviser|mentor|manager|boss|partner|classmate|roommate|cofounder|co-founder|student)\\s+)?(?:(?:professor|prof\\.?|dr\\.?|mr\\.?|ms\\.?|mrs\\.?)\\s+)?';
const MODAL =
  "(?:should|must|need\\s+to|have\\s+to|ought\\s+to|gotta|have\\s+got\\s+to|'ve\\s+got\\s+to|will\\s+want\\s+to|'ll\\s+want\\s+to|might\\s+want\\s+to|may\\s+want\\s+to|really\\s+should|definitely\\s+should|would\\s+enjoy|'d\\s+enjoy|will\\s+enjoy|'ll\\s+enjoy|'ll\\s+love|will\\s+love)(?:\\s+(?:really|definitely|absolutely|totally|honestly|probably|also))?";

/** Being on the message: "cc'd", "copied", "on cc", "on this thread", "added here". */
const CC_STATE =
  "(?:cc'?d|cc'?ed|cced|copied|on\\s+cc|in\\s+cc|on\\s+(?:this|the)\\s+(?:thread|email|chain)|added(?:\\s+here)?|included|looped\\s+in|on\\s+here|reading\\s+along(?:\\s+on\\s+cc)?)";
/** Words for the student in an introduction ("a Cornell junior"), not a job title ("a senior engineer"). */
const STUDENT_WORD =
  '(?:student|junior|sophomore|senior|freshman|undergrad|mentee|candidate|kid)\\b(?!\\s+(?:engineer|manager|associate|analyst|vp|director|designer|partner|scientist|consultant|developer|researcher|lead|banker|trader|recruiter|product|software|data))';

/** Cues written just before a name, matched against the clause up to the name (lowercased). */
const BEFORE_NAME: RegExp[] = [
  // "Meet Sam", "please meet Sam", "you should meet Sam", "I'd like you to meet Sam", "I wanted you to meet my
  // former colleague Sam"
  new RegExp(
    `(?:^\\s*(?:(?:and|also|so|now|hi|hey)\\s+)*(?:please\\s+)?|\\bplease\\s+(?:also\\s+)?|\\byou(?:\\s+(?:two|both|all|guys))?\\s+${MODAL}\\s+(?:to\\s+)?(?:also\\s+)?|\\b(?:like|love|want|wanted|get|getting|invite|encourage|asked?)\\s+(?:for\\s+)?you(?:\\s+(?:two|both))?\\s+to\\s+(?:also\\s+)?)(?:meet|get\\s+to\\s+know)\\s+${DESC}$`,
  ),
  // "introducing you to Sam", "I'd like to introduce Sam", "an introduction to José", "making an intro to Olu"
  new RegExp(`\\b(?:introduc(?:e|es|ed|ing)|presenting)\\s+(?:you\\s+(?:both\\s+|two\\s+)?to\\s+)?${DESC}$`),
  new RegExp(`\\bintro(?:duction)?s?\\s+(?:to|for|with)\\s+${DESC}$`),
  // "connecting you with Kai", "putting you in touch with Marcus", "you have been matched with José"
  new RegExp(
    `\\b(?:connect(?:s|ed|ing)?|put(?:ting)?\\s+(?:you\\s+)?in\\s+touch|match(?:ed)?|hook(?:s|ed|ing)?\\s+(?:you\\s+)?up)\\s+(?:you\\s+(?:both\\s+|two\\s+)?)?(?:with|to)\\s+${DESC}$`,
  ),
  // "you should talk to Ana", "I'd also suggest you talk to David", "for McKinsey questions talk to Siobhan"
  new RegExp(
    `(?:^\\s*(?:(?:and|also|so|definitely|honestly|really)\\s+)*|\\b(?:you|u)\\s+(?:${MODAL}|could|can)\\s+(?:also\\s+)?|\\b(?:suggest|recommend)\\s+(?:that\\s+)?(?:you\\s+)?(?:also\\s+)?|\\bquestions?\\s+|\\bworth\\s+|\\b(?:out\\s+of|from|enjoy|benefit\\s+from|value\\s+in)\\s+)(?:talk(?:ing)?|speak(?:ing)?|chat(?:ting)?|connect(?:ing)?|get(?:ting)?\\s+in\\s+touch)\\s+(?:to|with)\\s+${DESC}$`,
  ),
  // "looping in Ana", "cc'ing Rui", "I've cc'd Olu", "adding Nadia", "copying eli"
  new RegExp(
    `\\b(?:loop(?:s|ed|ing)?\\s+in|add(?:s|ed|ing)?|bring(?:s|ing)?\\s+in|cc(?:'?(?:s|ed|d|ing))?|cc-ing|copy(?:ing)?|copied)\\s+(?:in\\s+)?${DESC}$`,
  ),
  // "pointing you to Ana", "handing you over to Priya", "I'd refer you to Kofi"
  new RegExp(
    `\\b(?:point(?:s|ed|ing)?|send(?:s|ing)?|sent|pass(?:es|ed|ing)?|hand(?:s|ed|ing)?|refer(?:s|red|ring)?|direct(?:s|ed|ing)?)\\s+(?:you|u|this(?:\\s+one)?|it)\\s+(?:along\\s+|over\\s+|on\\s+|off\\s+)?(?:to|toward|towards)\\s+${DESC}$`,
  ),
  // "you're gonna love eli", "you will like Sam"
  new RegExp(
    `\\b(?:you're|you\\s+are|ur|you'll|you\\s+will|u\\s+will|u'll)\\s+(?:gonna\\s+|going\\s+to\\s+|really\\s+)?(?:love|like|enjoy)\\s+(?:meeting\\s+|talking\\s+to\\s+)?${DESC}$`,
  ),
  // "the person you want for rates questions is Marcus", "the one to ask about fraud is Ana"
  new RegExp(
    `\\b(?:person|one|guy|people|folks)\\s+(?:you\\s+(?:want|need|should\\s+(?:talk\\s+to|ask|meet))|to\\s+(?:ask|talk\\s+to|speak\\s+(?:to|with)))\\b[^.!?]{0,40}?\\s(?:is|are)\\s+${DESC}$`,
  ),
  // "+Marcus"
  /^\s*\+\s*$/,
  // "Alex, this is Mark", "here is Sam"
  new RegExp(`^\\s*(?:(?:and|also)\\s+)?(?:this\\s+is|here\\s+is|here's)\\s+${DESC}$`),
];

/** Cues split around the name: "looping Mark in", "bringing Tom into this thread", "asked Ana to help". */
const AROUND_NAME: [RegExp, RegExp][] = [
  [
    new RegExp(
      `\\b(?:loop(?:s|ed|ing)?|bring(?:s|ing)?|brought|add(?:s|ed|ing)?|pull(?:s|ed|ing)?)\\s+${DESC}$`,
    ),
    /^\s+(?:in|into|here)\b(?!\s+on\s+(?:your|the|our|my)\b)/,
  ],
  // "Alex, say hello to Kenji"; not "say hi to Kenji for me"
  [
    /(?:^|\byou\s+should\s+|\bplease\s+|,\s*)\s*say\s+(?:hi|hello|hey)\s+to\s+$/,
    /^(?!(?:\s+[\p{L}'-]+)?\s+(?:for|when|if|at|from|tomorrow|tonight|on)\b)/u,
  ],
  // "I thought you and Nadia should meet", "you and Kai would get along"
  [
    /\byou\s+(?:and|&)\s+$/,
    /^(?:\s+[\p{L}'-]+)?\s+(?:should|must|need\s+to|have\s+to|ought\s+to|would|'d|will|'ll|could)\s+(?:really\s+|definitely\s+|totally\s+|also\s+|absolutely\s+)?(?:meet|talk|connect|chat|speak|get\s+(?:to\s+know|along|together|coffee)|know\s+each\s+other|hit\s+it\s+off|compare\s+notes)\b(?!\s+(?:(?:up\s+)?(?:at|in|outside|by)\s+(?:the|our|a|an|\d|reception)|tomorrow|tonight|today|on\s+(?:mon|tue|wed|thu|fri|sat|sun)))/u,
  ],
  [
    new RegExp(`\\b(?:asked|told)\\s+${DESC}$`),
    /^\s+(?:to\s+(?:help|chat|talk|connect|meet|speak|share|join|jump\s+in|chime\s+in|weigh\s+in|get\s+in\s+touch|reach\s+out|email|contact|write|call)|about\s+you|you(?:'d|\s+would|\s+might)\b)/,
  ],
];

/** Cues written just after the name, matched against the rest of the sentence (lowercased). */
const AFTER_NAME: RegExp[] = [
  // "Kai (cc'd)", "Mei Lin (cc)", "Grace (copied)", "talk to Siobhan, cc'd here", "Sam's on cc now",
  // "(David) is copied"; not "Nadia is cc'd for the paperwork"
  new RegExp(
    `^\\)?(?:\\s+[\\p{L}'-]+)?(?:\\s+(?:and|&)\\s+[\\p{L}'-]+)?\\s*(?:\\(\\s*(?:also\\s+)?(?:cc|${CC_STATE})(?:\\s+here)?\\s*\\)|,\\s*(?:who\\s+(?:is|'s)\\s+)?${CC_STATE}(?:\\s+here)?\\b|(?:\\s+is|'s|\\s+has\\s+been)\\s+(?:now\\s+|also\\s+)?${CC_STATE}(?:\\s+(?:here|now))?)(?!\\s*,?\\s*(?:and|&)\\s+(?:i|me|myself)\\s+(?:both\\s+|also\\s+|really\\s+|just\\s+)*(?:enjoyed|loved|liked|appreciated|saw|read|reviewed|watched|attended|noticed|heard|judged|interviewed|will|'ll|are|am|would|'d|can|could|look|wanted|want|need|have\\s+(?:reviewed|read|seen|been\\s+(?:reviewing|reading|looking))|were\\s+(?:so\\s+|really\\s+|both\\s+)*(?:impressed|thrilled|blown|delighted|excited|happy|glad|sorry))\\b)(?!\\s*(?:for|so|since|because|as|in\\s+case|to\\s+(?!share|help|answer|talk|chat|walk|tell|explain|give|offer|introduce|connect|meet))\\b)(?!\\s*(?:and\\s+)?(?:will|can|'ll|is\\s+going\\s+to|would)\\s+(?:send|forward|process|handle|share\\s+the|book|schedule|set\\s+up|confirm|add\\s+you|coordinate|bring|walk\\s+you|run\\s+the|track|file)\\b)(?!\\s*(?:and\\s+)?(?:has|have|had|already|just)\\s+(?:already\\s+)?(?:submitted|sent|signed|approved|confirmed|filed|shared|forwarded|reviewed|booked|scheduled|processed)\\b)`,
    'u',
  ),
  // "you will find Ana on cc", "dana is on here too", "Siobhan's email is on this thread"
  /^(?:\s+[\p{L}'-]+)?(?:'s\s+(?:email|address)\s+is|\s+is|'s)?\s+(?:also\s+|now\s+)?(?:on\s+cc|on\s+here|reading\s+along|on\s+(?:this|the)\s+(?:thread|email|chain))(?:\s+(?:too|now|as\s+well))?\s*(?:[,.!;]|and\b|$)/u,
  // "Sam said yes", "Kai is happy to talk to you", "José agreed to a conversation", "Ana said she would be glad",
  // "I spoke to Marcus and he's happy to chat"
  /^(?:\s+[\p{L}'-]+)?(?:,?\s+and\s+(?:he|she|they))?\s*(?:(?:is|'s|would\s+be|will\s+be|said\s+(?:she|he|they)(?:'d|\s+would)\s+be|is\s+more\s+than)\s+(?:(?:very|really|super|more\s+than|so)\s+)?(?:happy|glad|keen|willing|open|delighted|excited|game)\s+to\s+(?:talk|chat|help|connect|speak|meet|share|answer|hop|grab)|said\s+yes|agreed\s+to\s+(?:a\s+)?(?:chat|call|talk|conversation|connect|meet|help|speak)|is\s+expecting|knows\s+you\s+(?:might|will|may)|offered\s+to\s+(?:talk|chat|help|speak|meet)|was\s+kind\s+enough\s+to)/u,
  // "Rui is your person", "Ana is the best person to ask"
  /^(?:\s+[\p{L}'-]+)?\s*(?:is|'s|would\s+be|will\s+be)\s+(?:your|the\s+(?:right|best|perfect|ideal)|the|a\s+(?:great|good|perfect))\s+(?:person|guy|contact|go-to|one|resource|expert|egg|sounding\s+board)\s*(?:to\s+(?:ask|talk|speak|contact|reach|email)|for\b|i\s+(?:mentioned|told)|$|[,.!;])/u,
  // "Siobhan is at McKinsey and offered to share her experience"
  /^[^.!?]{0,60}?\b(?:has\s+(?:kindly\s+)?)?(?:offered|agreed|volunteered)\s+to\s+(?:talk|chat|help|speak|meet|share|answer|walk|run|do|give|be\s+your)/u,
  // "Rui runs the platform team and is now cc'd", "Marcus has been at Goldman for six years and is on this thread"
  new RegExp(
    `^[^.!?]{0,70}?\\band\\s+(?:is|'s|are)\\s+(?:now\\s+|also\\s+)?${CC_STATE}(?:\\s+(?:here|now|on\\s+(?:this|the)\\s+(?:thread|email|chain|note)))?\\s*(?:[.!,;]|$)`,
    'u',
  ),
  // "Sam and Rui are both at Contoso and would be glad to talk", "Mark is our design lead and happy to chat"
  /^[^.!?]{0,60}?\b(?:(?:would|'d|will|'ll)\s+be|is|are|and)\s+(?:very\s+|more\s+than\s+|really\s+|super\s+)?(?:happy|glad|keen|delighted|willing)\s+to\s+(?:talk|chat|help|connect|speak|meet|share|answer)/u,
  // "Tom is the person I mentioned", "Olu is the friend I mentioned"
  /^(?:\s+[\p{L}'-]+)?\s*(?:\([^)]*\)\s*)?(?:is|was)\s+the\s+(?:[\p{L}'-]+\s+){0,3}?(?:i|we)\s+(?:mentioned|told\s+you\s+about|spoke\s+(?:about|of)|was\s+telling\s+you\s+about)/u,
];

/** After "meet Kai": a place or a time means meeting him, not being introduced ("Meet Kai at the front desk"). */
const MEETING_AFTER =
  /^(?:\s+[\p{L}'-]+)?\s*(?:(?:and|&)\s+[\p{L}\s]{0,30}?)?(?:at\s+(?:the|our|a|an|\d|reception)|in\s+(?:the|our|front)\b|outside\b|downstairs\b|by\s+the\b|on\s+(?:mon|tue|wed|thu|fri|sat|sun)|tomorrow|tonight|today|this\s+(?:week|morning|afternoon|evening|weekend)|next\s+(?:week|month)|in\s+person|for\s+(?:coffee|lunch|dinner|drinks|breakfast)|after\s+class)/u;

/**
 * Introducing phrases that name no one: the people named elsewhere in the message are the ones introduced.
 * Matched against clauses that are not thanks, so "thanks for connecting us" never counts.
 */
const GENERIC_CUES: RegExp[] = [
  /\bintroduc(?:e|es|ed|ing)\s+(?:you|y'all|both\s+of\s+you|you\s+both|you\s+two|the\s+two\s+of\s+you|each\s+other)\b(?!rsel)/,
  /\b(?:make|makes|making|made|do|doing)\s+(?:an?\s+|the\s+|this\s+)?(?:quick\s+|brief\s+|virtual\s+|warm\s+|e-?mail\s+)?intro(?:duction)?s?\b/,
  /\b(?:quick|brief|virtual|warm|e-?mail|double\s+opt-?in)\s+intro(?:duction)?s?\b/,
  /\bconnect(?:ing)?\s+(?:you\s+(?:two|both|all|here|as\s+promised)\b|the\s+two\s+of\s+you|you\s*$)/,
  /\bput(?:ting)?\s+you\s+(?:two\s+|both\s+)?in\s+touch\b/,
  /\byou\s+(?:two|both|all)\s+(?:should|need\s+to|must|have\s+to|gotta|ought\s+to|will|'ll|would|can|could|might)\s+(?:really\s+|definitely\s+|totally\s+|also\s+)?[\p{L}]+/u,
  /\blet\s+you\s+(?:two|both)\b/,
  /\bfor\s+you\s+(?:two|both)\s+to\b/,
  /\b(?:he|she|they)\b[^.!?]{0,60}?\b(?:offered|agreed|volunteered)\s+to\s+(?:talk|chat|help|speak|meet|share|answer|be\s+your)/,
  /\b(?:he|she|they)\s+(?:said\s+(?:he|she|they)\s+)?(?:would|'d|will|'ll)\s+love\s+to\s+(?:hear|chat|talk|meet|help|connect)\b/,
  // "He founded Adeyemi & Co. and is copied here", "He is copied on this email"
  new RegExp(
    `\\b(?:he|she|they)\\b[^.!?]{0,60}?\\b(?:is|are|'s|'re|has\\s+been)\\s+(?:now\\s+|also\\s+)?${CC_STATE}(?:\\s+(?:here|now|on\\s+(?:this|the)\\s+(?:thread|email|chain|note)))?\\s*(?:and\\b|[,.!:;]|$)`,
  ),
  /\b(?:person|name|contact)s?\s+for\s+your\s+list\b/,
  /\bput(?:ting)?\b[^.!?]{0,40}?\bon\s+(?:this|the\s+same|a|one)\s+(?:thread|email|chain)\b/,
  new RegExp(`\\b(?:he|she|they)\\b[^.!?]{0,60},\\s*${CC_STATE}(?:\\s+here)?\\s*[.!]?\\s*$`),
  /\b[\p{L}'-]+\s+and\s+you\s+(?:need|should|have|ought)\s+to\s+(?:talk|meet|connect|chat)\b/u,
  /\b(?:find|see)\s+(?:him|her|them)\s+(?:on\s+cc|copied|cc'?d|here|on\s+(?:this|the)\s+(?:thread|email))\b/,
  /\b(?:copied|cc'?d|cc'?ing|looped\s+in|added|adding|introducing|meet)\s+(?:two|three|a\s+few|some|a\s+couple\s+of)\s+(?:friends|people|colleagues|folks|contacts|names)\b/,
  new RegExp(`^\\s*(?:and\\s+)?(?:is|are)\\s+(?:now\\s+|also\\s+)?${CC_STATE}(?:\\s+here)?\\s*[.!]?\\s*$`),
  /\b(?:you\s+(?:and|&)\s+[\p{L}'-]+|you\s+(?:two|both))\s+(?:would|will|'d|'ll|should)\s+(?:really\s+)?(?:get\s+along|hit\s+it\s+off|click|have\s+(?:a\s+lot|plenty|lots)\s+to\s+(?:talk|discuss))/u,
  // "he'd be happy to talk", "said she'd make time for you"
  /\b(?:he|she|they)(?:'d|\s+would|'s|\s+is|\s+are|'re)\s+(?:be\s+)?(?:very\s+|more\s+than\s+|really\s+)?(?:happy|glad|keen|willing|open|delighted)\s+to\s+(?:talk|chat|help|connect|speak|meet|share|answer)|\b(?:he|she|they)(?:'d|\s+would|'ll|\s+will)\s+(?:make|find)\s+(?:some\s+)?time\b/,
  /\bover\s+to\s+you\s+(?:two|both)\b/,
  /\btake\s+it\s+from\s+here\b/,
  /\b(?:i'?ll|i\s+will|let\s+me)\s+(?:now\s+)?(?:step\s+back|bow\s+out|get\s+out\s+of\s+the\s+way|drop\s+off(?:\s+(?:the|this)\s+thread)?)\b/,
  /\b(?:should|ought\s+to)\s+know\s+each\s+other\b/,
  /\b(?:people|folks|friends|contacts|someone|somebody|a\s+person|a\s+friend|a\s+colleague)\s+(?:to\s+meet|you\s+should\s+(?:meet|talk\s+to|know|speak\s+(?:to|with))|worth\s+(?:meeting|knowing|talking\s+to)|to\s+(?:know|talk\s+to))\b/,
  /\bexpecting\s+(?:your|you\b|to\s+hear)/,
  new RegExp(
    `\\b(?:both|they|he|she)(?:\\s+(?:are|is|have\\s+been|has\\s+been)|'re|'s)?\\s+(?:now\\s+|also\\s+)?${CC_STATE}(?:\\s+(?:here|now|on\\s+(?:this|the)\\s+(?:thread|email|chain|note)))?\\s*(?:and\\b(?!\\s+(?:will|can|'ll))|[,.!:;]|$)`,
  ),
  new RegExp(
    `\\b(?:he|she|they)\\s+(?:is|'s|are)\\s+(?:a|an)\\s+(?:[\\p{L}'&-]+\\s+){0,4}?${STUDENT_WORD}`,
    'u',
  ),
  /\b(?:he|she|they)\s+knows?\s+you\s+(?:might|will|may)\b/,
  /\bhere\s+is\s+the\s+(?:student|junior|sophomore|senior|freshman|candidate|mentee)\b/,
  /\b(?:the|a|my|our)\s+(?:[\p{L}'-]+\s+){0,3}?(?:student|junior|sophomore|senior|freshman|undergrad|mentee|candidate|kid)(?:\s+(?:founder|engineer|researcher|designer|developer|builder))?\s+(?:i|we)\s+(?:mentioned|told\s+you\s+about|mentor|spoke\s+(?:about|of))\b/u,
];

/** "Alex is a junior at Cornell": describing the student to the person introduced. */
const studentDescription = (student: string) =>
  new RegExp(
    `(?<![\\p{L}])(?:${student})(?:\\s*\\([^)]*\\))?\\s+(?:is|'s)\\s+(?:a|an|the|my|our)\\s+(?:[\\p{L}'&-]+\\s+){0,4}?${STUDENT_WORD}`,
    'iu',
  );

const THANKS =
  '(?:thanks|thank\\s+(?:you|u|ya)|thanku|thx|thnx|ty|tysm|many\\s+thanks|much\\s+appreciated|appreciate[ds]?|grateful|gracias|merci|danke|grazie|obrigad[oa])';
/** What a reply thanks the introducer for. */
const INTRO_OBJECT =
  "(?:intro(?:duction)?s?(?!\\s+to\\s+(?:the|our|my|a|an|this|that|your)\\b)|introducing\\s+(?:us|me)|presentacion|connection|connecting\\s+(?:us|me)|loop(?:ing)?\\s+me\\s+in|the\\s+cc|cc'?ing\\s+me|thinking\\s+of\\s+me|putting\\s+us\\s+in\\s+touch|(?:the\\s+)?match|pairing|referral|setting\\s+(?:this|it|us)\\s+up|making\\s+this\\s+happen)";
/** Thanks for an introduction: "thanks for the warm intro", "appreciate you connecting us", "great intro". */
const INTRO_THANKS: RegExp[] = [
  /\b(?:for|on|re|about)\s+the\s+(?:kind\s+|warm\s+|quick\s+|lovely\s+)?intro(?:duction)?\b(?!\s+to\s+(?:the|our|my|a|an|this|that|your)\b)/,
  new RegExp(`\\b${THANKS}\\b[^.!?]{0,40}?\\b${INTRO_OBJECT}`),
  /\b(?:great|lovely|wonderful|perfect|fantastic|awesome|amazing|kind|nice|thoughtful|generous)\s+(?:intro(?:duction)?|connection)\b/,
  /\b(?:connected|introduced)\s+us\b|\bput\s+us\s+in\s+touch\b|\bany\s+friend\s+of\b/,
];
/** A clause that is only thanks, so it thanks whoever it is addressed to: "Thanks Lena", "Thank you, Priya!". */
const BARE_THANKS = new RegExp(
  `^\\s*(?:(?:and|haha|lol|oh|ah|aw+|wow|omg|ok|okay)\\s+)*${THANKS}(?:\\s+(?:so\\s+much|again|a\\s+lot|a\\s+ton|a\\s+million|both|as\\s+always|as\\s+ever|once\\s+again))?(?:\\s+[\\p{L}'-]+)?\\s*[!.]*\\s*$`,
  'u',
);
/** "Moving Lena to bcc", "(bcc)", "bcc'ing Lena". */
const BCC =
  /\b(?:mov(?:e|ed|es|ing)\s+(?:[\p{L}'-]+\s+){0,2}?to\s+bcc|to\s+bcc\b|bcc'?(?:ing|ed|d)\b|in\s+bcc\b|on\s+bcc\b)|^\s*bcc'?d?\s*$/u;

/** An assistant brought in to find a time: a scheduling hand-off, not an introduction. */
const SCHEDULER_ROLE =
  /\b(?:ea|executive\s+assistant|assistant|chief\s+of\s+staff|scheduler|coordinator|who\s+(?:manages|runs|handles|keeps)\s+my\s+(?:calendar|schedule|diary))\b/;
const SCHEDULER_TASK =
  /\bto\s+(?:help\s+)?(?:set\s+up|find|schedule|book|coordinate|arrange|lock\s+in|nail\s+down|grab|get)\s+(?:a\s+|some\s+)?(?:time|times|slot|slots|\d+\s*(?:min(?:ute)?s?)|call|meeting|chat)\b|\bfor\s+scheduling\b|\bto\s+schedule\b|\b(?:find|book|grab|schedule|set\s+up|get|hold)\s+us\s+(?:a\s+|some\s+)?(?:time|slot|\d+\s*(?:min(?:ute)?s?)|call|meeting|room)\b|\bfind\s+(?:a\s+)?(?:slot|time)\s+for\s+us\b/;

/**
 * An offer to introduce later, not an introduction yet: a double opt-in question ("Would you like me to introduce you
 * to someone at McKinsey?") or an introduction to people not named ("happy to introduce you to a few folks at Google
 * once you've narrowed down teams"). Such a clause carries no cue, and a name in it ("a couple of people on Sam's
 * team") is not being introduced.
 */
const OFFER_QUESTION =
  /\b(?:would\s+you\s+like\s+(?:me\s+)?to|(?:do\s+you\s+)?want\s+me\s+to|shall\s+i|should\s+i|would\s+it\s+help\s+if\s+i)\s+(?:\w+\s+){0,2}?(?:introduc|connect|put\s+you|make\s+(?:an?\s+)?intro|intro)/;
const OFFER_UNNAMED =
  /\b(?:introduc(?:e|ing)|connect(?:ing)?|put(?:ting)?\s+you\s+in\s+touch|intro(?:duction)?s?)\s+(?:you\s+)?(?:to|with)\s+(?:someone|somebody|anyone|anybody|a\s+few|a\s+couple|a\s+handful|some|several|other|more|people|folks|others)\b/;

/**
 * Someone copied for an administrative reason: "cc'd Chris from our HR team for the paperwork", "for visibility since
 * she's coordinating the practice group", "who handles our internship applications", "so he has your availability".
 * A copy cue in such a sentence is not an introduction.
 */
const ADMIN_PURPOSE = new RegExp(
  [
    '\\bfor\\s+(?:the\\s+|your\\s+|any\\s+)?(?:paperwork|visibility|awareness|context|reference|records?|onboarding|logistics|forms?|offer\\s+letter|background\\s+check|benefits|payroll|reimbursements?|expenses?|invoices?|badges?|compliance|approval|sign-?off|fyi)\\b',
    '\\bfor\\s+(?:the\\s+|your\\s+|any\\s+)?(?:contract|paperwork|legal|visa|tax|payroll|benefits|housing|relocation|logistics|travel|billing|grading)\\s+questions?\\b',
    "\\bfyi\\b|\\bkeep(?:ing)?\\s+(?:[\\p{L}'-]+\\s+){1,2}in\\s+the\\s+loop\\b",
    "\\bsince\\s+(?:he|she|they)(?:'s|'re|\\s+is|\\s+are)\\s+(?:coordinating|organizing|organising|handling|managing|approving|processing|in\\s+charge\\s+of)\\b",
    '\\b(?:who|that)\\s+(?:handles|processes|manages|coordinates|owns|approves|will\\s+(?:handle|process|send|issue|book|update|file|approve)|can\\s+(?:process|issue|update|file|approve))\\s+(?:(?:our|the|your|all|any)\\s+)?(?:[\\p{L}-]+\\s+){0,2}?(?:applications?|paperwork|onboarding|logistics|forms?|badges?|payroll|benefits|reimbursements?|scheduling|travel|contracts?|i-9|invoices?|expenses?|grades?|access|laptop|accounts?)\\b',
    '\\bfrom\\s+(?:(?:our|the)\\s+)?(?:hr|human\\s+resources|people\\s+ops|payroll|legal|facilities|benefits|it\\s+(?:team|department|office))\\b|\\b(?:on|in)\\s+(?:our|the)\\s+(?:hr|human\\s+resources|people\\s+ops|payroll|legal|facilities|benefits|it)\\s+(?:team|department|office)\\b',
    '\\bto\\s+(?:process|sort\\s+out|issue|file|approve|finalize|finalise|update\\s+your)\\b',
    '\\bso\\s+(?:he|she|they)\\s+(?:has|have|knows|can\\s+(?:update|process|send|issue|book|file|approve|add|track|confirm))\\b',
    '\\b(?:has|have|holds|needs)\\s+your\\s+(?:[\\p{L}-]+\\s+){0,2}?(?:forms?|paperwork|receipts?|availability|address|documents?|contract|badge|invoices?|expenses?|details)\\b',
    "\\b(?:cc'?d|copied|looped\\s+in|on\\s+cc|included)\\s+(?:as|since\\s+(?:he|she|they))\\s+(?:the\\s+|our\\s+)?(?:[\\p{L}-]+\\s+)?coordinat\\w*",
    '\\bfor\\s+your\\s+(?:it\\s+)?(?:setup|set-up|laptop|access|accounts?|equipment)\\b',
    '\\bquestions?\\s+about\\s+(?:the\\s+|your\\s+)?(?:deadlines?|dates?|logistics|paperwork|forms?|timing|start\\s+dates?|application\\s+(?:process|portal)|reimbursements?|housing|relocation|visas?)\\b',
  ].join('|'),
  'u',
);

/** Subject cues: "Intro: Alex <> Sam", "Introduction - Eli Brooks", "Connecting you". */
const SUBJECT_INTRO =
  /\b(?:intro(?:duction)?s?|introducing|connecting)\b(?!\s+(?:call|chat|deck|meeting|session|class|course|video|slides|program|reading|to\s+(?:the|our|my|a|an|this|that|your)\b))/;
const SUBJECT_PAIR =
  /([\p{L}][\p{L}'-]*)(?:\s+[\p{L}][\p{L}'-]*)?(?:\s*\([^)]*\))?\s*(?:<>|<->|\/\/|\/|\bx\b|\+|&)\s*([\p{L}][\p{L}'-]*)/gu;
const REPLY_PREFIX = /^\s*(?:(?:re|aw|sv|antw|r)\s*:\s*)+/i;
const FORWARD_PREFIX = /^\s*(?:(?:fwd?|wg|tr)\s*:\s*)+/i;

/** "Rui runs the data platform", "Sam is a friend from Northwind": a person described to the student. */
const DESCRIBED =
  /^(?:\s+[\p{L}'-]+)?\s+(?:(?:is|'s|was)\s+(?:now\s+|also\s+)?(?:a|an|the|on|in|at|my|our|one)\b|(?:runs|leads|heads|manages|works|worked|did|went|started|founded|built|covers|trades|invests|owns|spent|joined|moved|made|switched)\b)/u;

/**
 * What a sentence naming someone says when it is not presenting them: they act with the sender ("Sam and I"), on
 * logistics or feedback ("Tom will run your mock case", "Marcus took a look"), they are copied for a task ("cc'd
 * for the paperwork"), the sender meets them, or asks them for something ("Hannah, could you share...?").
 */
const notPresenting = (n: string) =>
  new RegExp(
    [
      `\\b${n}\\s+(?:and|&)\\s+(?:i|me|myself)\\b|\\b(?:i|me)\\s+(?:and|&)\\s+${n}\\b|\\bwith\\s+${n}\\b`,
      `\\b${n}(?:\\s+[\\p{L}'-]+)?\\s+(?:will|would|'ll|might|may|can|could)\\s+(?!(?:also\\s+)?be\\s+(?:a\\s+|the\\s+)?(?:great|good|helpful|useful|happy|glad|perfect|right|best|wonderful|fantastic)\\b)`,
      `\\b${n}(?:\\s+[\\p{L}'-]+)?\\s+(?:says|said(?!\\s+(?:yes|(?:he|she|they)(?:'d|\\s+would)))|mentioned|enjoyed|loved|liked|took|looked|reviewed|read|submitted|presented|wrote|sent|asked|ran|hosted|recommended|organized|organised)\\b`,
      `\\b${n}\\s+(?:is|'s)\\s+(?:joining|coming|presenting|organizing|hosting|running|speaking|judging|my\\s+(?:manager|boss|coordinator))\\b`,
      `\\b${n}(?:\\s+[\\p{L}'-]+)?\\s+(?:is|'s|has\\s+been)\\s+(?:${CC_STATE})(?:\\s+here)?\\s+(?:for|so|since|to|because|as|in\\s+case)\\b`,
      `\\bmeet(?:ing)?\\s+${n}\\b`,
      `^\\s*(?:hi\\s+|hey\\s+)?${n}\\s*,[^.!]*\\?\\s*$|^\\s*${n}\\s*,\\s*(?:please|could\\s+you|can\\s+you|would\\s+you)\\b`,
    ].join('|'),
    'u',
  );
/** Meeting arrangements in the message: the people named are coming along, not being introduced. */
const ARRANGES_MEETING =
  /\blet'?s\s+meet\b|\bmeet\s+(?:you|u|me|us|up|there)\b|\b(?:great|nice|lovely|good|pleasure|fun)\s+(?:to\s+)?meet(?:ing)?\b|\bcome\s+(?:meet|say)\b|\bjoin\s+(?:us|you)\b|\bsee\s+you\s+(?:there|then)\b|\b(?:want|like)\s+to\s+meet\b|\bcan\s+we\s+meet\b/;

/** Shared work handed out ("you are paired for the final project", "Dana owns the dashboard and you own the write-up"). */
const WORK_SPLIT =
  /\byou\s+(?:own|take|handle|have)\s+the\b|\b(?:paired|partnered|teamed\s+up)\b|\b(?:proposals?|drafts?|reports?)\s+(?:are|is)\s+due\b|\b(?:course|teaching)\s+staff\b|\bgraders?\b/;

/** Who someone is, in the present tense: "Mei is an engineer at Databricks", "Rui runs platform at Contoso". */
const roleDescribed = (n: string) =>
  new RegExp(
    `\\b${n}\\)?(?:\\s+[\\p{L}'-]+)?(?:\\s*\\([^)]*\\))?\\s*(?:(?:is|'s)\\s+(?:now\\s+|also\\s+)?(?:a|an|our|my|their)\\s+(?:[\\p{L}'&-]+\\s+){0,4}?(?:engineer|scientist|analyst|associate|partner|vp|director|manager|designer|founder|investor|angel|lead|head|recruiter|banker|trader|consultant|professor|researcher|alum|alumna|alumnus|friend|colleague|mentor|pm|developer|architect|principal)\\b|(?:is|'s)\\s+(?:now\\s+)?(?:at\\s+\\p{Lu}|on\\s+the\\s+[\\p{L}\\s-]{0,30}?team\\b|in\\s+(?:restructuring|analytics|banking|consulting|product|design|engineering|recruiting|growth|sales|trading)\\b)|\\s(?:runs|leads|heads|manages|works\\s+(?:at|on|in)|covers|trades|invests|owns|sits\\s+on|does\\s+[\\p{L}-]+\\s+at)\\b)`,
    'iu',
  );

/** The fallback: words around a person the student is pointed to ("ask her", "knows the team", "went through it"). */
const POSSIBLE_TALK =
  /\b(?:talk(?:ing)?\s+(?:to|with)|chat(?:ting)?\s+(?:to|with)|speak(?:ing)?\s+(?:to|with)|ask\s+(?:him|her|them)|questions|advice|help\s+you|happy\s+to\s+help|glad\s+to\s+help|learn\s+from|hear\s+from|get\s+in\s+touch|reach\s+out|write\s+to|knows?\b|insights?|perspective|went\s+through|did\s+the\s+same|same\s+(?:path|program|rotation|switch|jump)|(?:great|good|right|best)\s+(?:person|resource|contact)|generous\s+with|worth\s+(?:a\s+)?(?:chat|call|talking|conversation)|mentor(?:s|ed|ing)?|loves?\s+helping|happy\s+to|glad\s+to|say\s+(?:hi|hello)|(?:plenty|lots|a\s+lot)\s+to\s+talk\s+about)/;
/** The fallback: wording around introducing, even where it points at no one ("cc", "meet", "e-meet", "over to you"). */
const POSSIBLE_PRESENTING =
  /\b(?:meet|e-?meet|introduc\w*|intros?|connect(?:ing)?|loop(?:ing|ed)?\s+in|cc'?(?:d|ed|ing)?|copy(?:ing)?|copied|adding|added|bring(?:ing)?\s+in|put(?:ting)?\s+you|in\s+touch|over\s+to\s+you|take\s+it\s+from\s+here|each\s+other|you\s+(?:two|both))\b/;
/** The fallback: who someone is, after their name or a pronoun ("Rui, who runs platform", "She is at McKinsey"). */
const POSSIBLE_ROLE =
  "(?:who\\s+(?:runs|leads|heads|works|worked|did|went|is|was|has|knows|built|started|founded|joined|spent|covers|manages)|(?:is|'s|was)\\s+(?:now\\s+)?(?:a|an|at|on|in|the|my|our|one)\\b|(?:runs|ran|leads|led|heads|manages|works|worked|did|went|started|founded|built|covers|trades|invests|joined|spent|switched|graduated|studied|interned|taught|mentors))";
/** The fallback: the person acts with the sender or on the work at hand ("Sam and I", "Kai set up your desk"). */
const POSSIBLE_COUNTER = (n: string) =>
  new RegExp(
    [
      `\\b${n}(?:\\s+[\\p{L}'-]+)?(?:\\s*\\([^)]*\\))?\\s+(?:and|&)\\s+(?:i|me|myself)\\b|\\b(?:i|me)\\s+(?:and|&)\\s+${n}\\b`,
      `\\b${n}(?:\\s+[\\p{L}'-]+)?\\s+(?:will|'ll|is\\s+going\\s+to|is|'s)\\s+(?:send|forward|share|bring|book|schedule|set\\s+up|confirm|handle|process|run|host|give|giving|present|presenting|join|joining|cover|covering|lead|leading|organize|organizing|putting\\s+together|teach|teaching|judge|judging|sit\\s+in|sitting\\s+in)\\b`,
      `\\b${n}(?:\\s+[\\p{L}'-]+)?\\s+(?:says|mentioned|enjoyed|loved|liked|took|looked|reviewed|read|submitted|presented|wrote|sent|asked|hosted|recommended|organized|organised|moved|approved|set\\s+up|made|gave|shared|forwarded|booked|signed|added\\s+you|demoed|needs|wants|has\\s+(?:already|your))\\b`,
      `\\b(?:see|saw|seeing|thank|thanks|congratulate)\\s+(?:you\\s+and\\s+)?${n}\\b|\\b${n}\\s+(?:let\\s+me\\s+know|told\\s+me)\\b`,
      `\\b${n}(?:\\s+[\\p{L}'-]+)?(?:\\s*\\([^)]*\\))?\\s+(?:submitted|judged|posted|approved|went\\s+through\\s+your|(?:is|'s)\\s+(?:my|our)\\s+(?:manager|boss|coordinator|ta|assistant)|(?:is|'s)\\s+running|would\\s+know\\s+better)\\b`,
      `\\b${n}'s\\s+(?:talk|lecture|class|session|presentation|team\\s+(?:dinner|offsite|event)|birthday|party|wedding)\\b`,
    ].join('|'),
    'u',
  );
/** The fallback: a day, a clock time or a place to be, what a note about a meeting or an event carries. */
const POSSIBLE_WHEN_WHERE =
  /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:front\s+desk|reception|lobby|room\s+\w+|open\s+house|day\s+one|tomorrow|tonight|tmrw)\b/;
/** The fallback: logistics in a message, what a copy for the work at hand talks about. */
const POSSIBLE_LOGISTICS =
  /\b(?:attach(?:ed|ing)?|agenda|invite|invitation|deadline|forms?|room|badge|receipts?|slides|packet|syllabus|grades?|assignment|rsvp|parking|zoom\s+link|dial-in|panel|superday|offer\s+letter|reimburse\w*|paperwork|signature|survey|portal|sign\s+up|recording|reservation|dinner|lunch|party|congrats|congratulations|thanks\s+for\s+coming|moved\s+our)\b/;

/** A reply that arranges the call: a day, a clock time, a calendar link. */
const ARRANGES_TIME =
  /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(?:mon|tue|wed|thu|thurs|fri)\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:calendly|calendar|a few times|a couple (?:of )?times|some times|times that work|what times|what works|when works|free\s+(?:next|this|on|at))\b/i;

/** First names that are also everyday words: in lowercase they are words, not names. */
const COMMON_WORD_NAMES = new Set([
  'will',
  'mark',
  'grace',
  'may',
  'june',
  'april',
  'rose',
  'hope',
  'faith',
  'joy',
  'pat',
  'bill',
  'art',
  'sunny',
  'summer',
  'dawn',
  'rich',
  'sky',
  'drew',
  'chase',
  'max',
  'gene',
]);

/** Words that may sit next to names in a clause that only addresses people: "Hi Sam and Alex", "Dear Ana". */
const GREETING_WORDS = new Set([
  'hi',
  'hey',
  'hello',
  'dear',
  'and',
  '&',
  'both',
  'all',
  'yo',
  'good',
  'morning',
]);

// ---- the reader --------------------------------------------------------------------------------------------------

interface Candidate {
  person: IntroPerson;
  /** the capitalised first name, folded ("Jose") */
  name: string;
  score: number;
  strong: boolean;
  thanked: boolean;
  /** thanked for an introduction or moved to bcc, not just "thanks Sam" */
  introThanked: boolean;
  /** thanked for anything ("Nadia, thank you for setting this up") */
  looseThanked: boolean;
  scheduler: boolean;
  /** pointed at only in sentences that copy them for an administrative reason ("cc'd for the paperwork") */
  admin: boolean;
  /** pointed at in a sentence with no administrative reason */
  plainStrong: boolean;
}

/** `offer`: an offer to introduce later ("Would you like me to introduce you to someone at McKinsey?") */
type ClauseKind = 'plain' | 'thanks' | 'bare' | 'bcc' | 'offer';
const THANKING: ReadonlySet<ClauseKind> = new Set(['thanks', 'bare', 'bcc']);

/**
 * Reads one message for an introduction: who introduces whom to the student, or whether it is a reply inside an
 * introduction thread. See the decision order at the top of this file.
 */
export function readIntroduction(
  msg: Msg,
  people: IntroPerson[],
  userEmails: string[],
  ctx: IntroductionContext = {},
): IntroductionReading {
  const out = (
    kind: IntroductionKind,
    reason: string,
    extra: Partial<IntroductionReading> = {},
  ): IntroductionReading => ({
    kind,
    introducedIds: [],
    thankedIds: [],
    introThankedIds: [],
    schedulerIds: [],
    possible: [],
    reason,
    ...extra,
  });
  const lower = (e: string) => e.trim().toLowerCase();
  const mine = new Set(userEmails.map(lower));
  const to = msg.toEmails.map(lower);
  const cc = msg.ccEmails.map(lower);
  const studentOn = to.some((e) => mine.has(e)) ? 'to' : cc.some((e) => mine.has(e)) ? 'cc' : undefined;
  const inbound = msg.direction === 'inbound';
  if (msg.isAutomated) return out('none', 'machine mail');
  if (inbound && !studentOn) return out('none', 'student not on the message');
  const sender = msg.fromPersonId ? people.find((p) => p.id === msg.fromPersonId) : undefined;
  if (inbound && (!msg.fromPersonId || (sender && !sender.isHuman))) return out('none', 'not from a person');

  // the people on the message who could be introduced
  const from = lower(msg.fromEmail);
  const candidates: Candidate[] = [];
  for (const e of [...to, ...cc]) {
    if (mine.has(e) || e === from) continue;
    const p = people.find((x) => x.emails.some((y) => lower(y) === e));
    if (!p || !p.isHuman || p.id === msg.fromPersonId || candidates.some((c) => c.person.id === p.id))
      continue;
    const first = fold(p.firstName.trim());
    if (first.length < 2) continue;
    candidates.push({
      person: p,
      name: first[0]!.toUpperCase() + first.slice(1),
      score: 0,
      strong: false,
      thanked: false,
      introThanked: false,
      looseThanked: false,
      scheduler: false,
      admin: false,
      plainStrong: false,
    });
  }
  const isCandidateWord = (w: string) => candidates.some((c) => c.name.toLowerCase() === w.toLowerCase());

  const students = (ctx.studentNames ?? [])
    .map((n) => fold(n.trim()))
    .filter((n) => n.length >= 2)
    .sort((a, b) => b.length - a.length);
  const studentAlt = students.length ? students.map(escapeRe).join('|') : undefined;
  const isStudentWord = (w: string) => !!studentAlt && new RegExp(`^(?:${studentAlt})$`, 'i').test(w);
  const namesStudent = (text: string) => !!studentAlt && wordRe(studentAlt, 'i').test(text);
  /** "Professor Chen", "Dr. Lin": a title and surname name the person as their first name does */
  const byTitle = (text: string) =>
    candidates.reduce((t, c) => {
      const last = fold(c.person.lastName?.trim() ?? '');
      return last.length < 2
        ? t
        : t.replace(
            new RegExp(
              `\\b(?:professor|prof\\.?|dr\\.?|mr\\.?|ms\\.?|mrs\\.?)\\s+${escapeRe(last)}\\b`,
              'gi',
            ),
            c.name,
          );
    }, text);
  const body = byTitle(fold(msg.bodyText ?? ''));
  // typed without capitals ("alex meet sam!"): names may be lowercase too (the sign-off line aside)
  const caseless = !/[A-Z]/.test(body.replace(/\bI\b/g, '').replace(/\n[^\n]*$/, ''));
  // a name typed in lowercase ("dana is on cc") in mail that is otherwise capitalised: only when the capitalised
  // form never appears and the name is not an everyday word ("will", "mark", "grace")
  const lowerOnly = new Set(
    candidates
      .filter(
        (c) =>
          !COMMON_WORD_NAMES.has(c.name.toLowerCase()) &&
          !wordRe(escapeRe(c.name), '').test(fold(msg.bodyText ?? '')) &&
          wordRe(escapeRe(c.name.toLowerCase()), '').test(fold(msg.bodyText ?? '')),
      )
      .map((c) => c.person.id),
  );
  const mentions = (text: string, c: Candidate, anyCase: boolean) => {
    const re = wordRe(escapeRe(c.name), anyCase || lowerOnly.has(c.person.id) ? 'gi' : 'g');
    const found: number[] = [];
    for (let m = re.exec(text); m; m = re.exec(text)) found.push(m.index);
    return found;
  };
  /** A cue pointed at the name between `before` and `after` (lowercased clause and sentence text). */
  const anchoredAt = (before: string, after: string) => {
    // "Sam's team" is not a cue, "eli's cc'd" is
    if (/^'s\b/.test(after)) return AFTER_NAME.some((re) => re.test(after));
    const meetHere = /\bmeet\s+[\p{L}\s'-]*$/u.test(before);
    // the second name of a list: "meet Sam and Rui", "looping in Ana and Rui"
    const heads = [before];
    for (const re of [
      /(?<![\p{L}'-])([\p{L}'-]+)\s+(?:and|&)\s+$/u,
      /(?<![\p{L}'-])([\p{L}'-]+)\s+[\p{L}'-]+\s+(?:and|&)\s+$/u,
    ]) {
      const listed = re.exec(before);
      if (listed && (isCandidateWord(listed[1]!) || isStudentWord(listed[1]!)))
        heads.push(before.slice(0, listed.index));
    }
    return (
      (heads.some((h) => BEFORE_NAME.some((re) => re.test(h))) && !(meetHere && MEETING_AFTER.test(after))) ||
      AROUND_NAME.some(([b, a]) => b.test(before) && a.test(after)) ||
      AFTER_NAME.some((re) => re.test(after))
    );
  };
  /** the sentence being read copies someone for an administrative reason */
  let adminSentence = false;
  const mark = (c: Candidate, score: number) => {
    c.score = Math.max(c.score, score);
    if (score >= STRONG) c.strong = true;
    if (score >= STRONG && adminSentence) c.admin = true;
    else if (score >= STRONG) c.plainStrong = true;
  };

  // ---- the subject: a new subject carries cues; a reply's subject only tells that this answers an intro thread
  const rawSubject = byTitle(fold(msg.subject ?? ''));
  const isReplySubject = REPLY_PREFIX.test(rawSubject);
  const subject = rawSubject.replace(REPLY_PREFIX, '').replace(FORWARD_PREFIX, '').trim();
  const subjectLower = subject.toLowerCase();
  const introTo = /\bintro(?:duction)?\s+to\s+([\p{L}'-]+)/u.exec(subjectLower);
  const subjectIntro =
    SUBJECT_INTRO.test(subjectLower) &&
    !/\b(?:thanks|thank\s+you)\b/.test(subjectLower) &&
    // "Intro to Systems": "intro to" counts only before a person
    (!introTo || isCandidateWord(introTo[1]!) || isStudentWord(introTo[1]!));
  const pairNames = new Set<string>();
  for (const m of subject.matchAll(SUBJECT_PAIR)) {
    const pair = [m[1]!, m[2]!];
    if (pair.every((w) => isStudentWord(w) || isCandidateWord(w)) && pair.some(isCandidateWord))
      for (const w of pair) pairNames.add(w.toLowerCase());
  }

  // ---- the body, sentence by sentence
  let genericCue = !isReplySubject && (subjectIntro || pairNames.size > 0);
  let bccCue = false;
  /** an offer to introduce later ("Would you like me to introduce you to someone at McKinsey?") */
  let offerCue = false;
  let unnamedThanks = false;
  /** a reply that opens by thanking someone ("Thanks Professor!") */
  let bareThanks = false;
  const studentDesc = studentAlt ? studentDescription(studentAlt) : undefined;
  /** candidates named outside thanks clauses */
  const mentioned = new Set<string>();
  /** the sender speaks to the student by name ("Alex, ..."), and to these people, and describes these people */
  let studentAddressed = false;
  const spokenTo = new Set<string>();
  /** people the sender tells about the student ("Sam, Alex is the junior I mentor") */
  const tellsAbout = new Set<string>();
  const described = new Set<string>();

  let namedBefore: Candidate[] = [];
  for (const sentence of sentencesOf(body)) {
    const clauses = clausesOf(sentence);
    // where each clause starts in the sentence (a name can repeat: "David (David) is copied")
    const starts: number[] = [];
    clauses.reduce((from, cl) => {
      const at = Math.max(from, sentence.indexOf(cl, from));
      starts.push(at);
      return at + cl.length;
    }, 0);
    const lowerSentence = sentence.toLowerCase();
    adminSentence = ADMIN_PURPOSE.test(lowerSentence);
    const kinds: ClauseKind[] = clauses.map((cl) => {
      const l = cl.toLowerCase();
      if (BCC.test(l)) return 'bcc';
      if (OFFER_QUESTION.test(l) || OFFER_UNNAMED.test(l)) return 'offer';
      if (INTRO_THANKS.some((re) => re.test(l))) return 'thanks';
      if (BARE_THANKS.test(l)) return 'bare';
      return 'plain';
    });
    if (kinds.includes('bcc')) bccCue = true;
    if (kinds.includes('offer')) offerCue = true;
    const introThanks = kinds.some((k) => k === 'thanks' || k === 'bcc');
    const thank = (c: Candidate) => {
      c.thanked = true;
      if (introThanks) c.introThanked = true;
    };
    const loose = clauses.map((cl) =>
      new RegExp(
        `\\b${THANKS}\\b|^\\s*(?:of\\s+course|absolutely|sure\\s+thing|with\\s+pleasure|my\\s+pleasure|happy\\s+to\\s+help|glad\\s+to\\s+help|anything\\s+for\\s+you|happy\\s+to|glad\\s+to)\\s*[!.]*\\s*$|\\b(?:ofc|of\\s+course|legend)\\b|\\b(?:you(?:'re|\\s+are)|ur|u\\s+r)\\s+(?:too\\s+kind|so\\s+kind|the\\s+best|a\\s+(?:gem|star|legend))|\\byou\\s+rock\\b|\\b(?:that(?:'s|\\s+is)|how)\\s+(?:very\\s+|so\\s+)?kind\\b|^\\s*(?:so|very|too|how)\\s+kind\\s+of\\s+you\\b|\\bcheers\\s+for\\b|\\bmuch\\s+obliged\\b`,
      ).test(cl.toLowerCase()),
    );
    // a clause that is only names (and greeting words): whom the sentence speaks to
    const vocative = clauses.map((cl) => {
      const words = cl
        .replace(/[!.?]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
      return (
        words.length > 0 &&
        words.length <= 5 &&
        words.every((w) => GREETING_WORDS.has(w.toLowerCase()) || isStudentWord(w) || isCandidateWord(w)) &&
        words.some((w) => isStudentWord(w) || isCandidateWord(w))
      );
    });
    // an introducing verb in this sentence aimed at someone not on the candidate list ("please meet Alex",
    // "introduce Alex to you"): everyone named in the sentence is the one introduced
    let aimed = false;
    /** this sentence introduces (so a name in it is not just being thanked) */
    let introducing = false;
    clauses.forEach((cl, i) => {
      if (kinds[i] !== 'plain') return;
      const l = cl.toLowerCase();
      if (GENERIC_CUES.some((re) => re.test(l)) || studentDesc?.test(cl)) introducing = genericCue = true;
      // "I promised Alex I would connect him with you"
      if (
        new RegExp(
          `\\b(?:connect|introduc|put|flag|send|pass|forward|refer|point)\\w*\\s+(?:him|her|them${studentAlt ? `|${studentAlt.toLowerCase()}` : ''})\\s*(?:\\([^)]*\\)\\s*)?,?\\s*(?:(?:with|to|in\\s+touch\\s+with)\\s+you\\b|on\\s+your\\s+radar|your\\s+way|for\\s+you\\b)`,
        ).test(lowerSentence)
      )
        aimed = true;
      if (studentAlt) {
        const s = wordRe(studentAlt, 'gi');
        for (let m = s.exec(cl); m; m = s.exec(cl)) {
          const before = l.slice(0, m.index);
          const after = l.slice(m.index + m[0].length);
          if (BEFORE_NAME.some((re) => re.test(before)) && !MEETING_AFTER.test(after)) aimed = true;
        }
        // "alex meet sam", "alex this is eli": the student's name opens the clause; "eli meet alex": it closes it
        if (new RegExp(`^\\s*(?:${studentAlt})\\s+(?:meet|this\\s+is)\\s`, 'i').test(cl)) aimed = true;
        if (new RegExp(`^\\s*[\\p{L}'-]+\\s+(?:meet|this\\s+is)\\s+(?:${studentAlt})\\b`, 'iu').test(cl))
          aimed = true;
      }
      if (/(?:^|\bplease\s+)meet\s+(?:you\s+(?:two|both)|each\s+other)\b/.test(l)) aimed = true;
      if (/\bintroduc(?:e|es|ing)\s+(?:my|our)\s/.test(l)) aimed = true;
    });
    if (aimed) introducing = genericCue = true;
    /** candidates this sentence only addresses ("Ines, you are the best, thanks for making the connection") */
    const addressed: Candidate[] = [];

    for (const c of candidates) {
      clauses.forEach((cl, i) => {
        const at = mentions(cl, c, caseless || kinds[i] !== 'plain' || vocative[i]!);
        if (!at.length) return;
        if (loose[i] || (vocative[i] && loose.some(Boolean))) c.looseThanked = true;
        if (kinds[i] === 'offer') return;
        if (kinds[i] !== 'plain') {
          // "Thanks Lena", "appreciate the intro, Lena", "moving Lena to bcc"
          thank(c);
          return;
        }
        // a name on its own next to a thanks clause: "Lena, great intro, thank you", "Thank you, Priya!"
        if (vocative[i] && (THANKING.has(kinds[i + 1] ?? 'plain') || THANKING.has(kinds[i - 1] ?? 'plain'))) {
          thank(c);
          return;
        }
        if (vocative[i]) {
          addressed.push(c);
          spokenTo.add(c.person.id);
          // "Siobhan, Alex is deciding between Bain and McKinsey": the sender tells the person about the student
          const rest = sentence.slice(starts[i]! + cl.length).replace(/^[\s,:;\u2013\u2014-]+/, '');
          if (
            studentAlt &&
            new RegExp(
              `^(?:${studentAlt})(?:\\s*\\([^)]*\\))?\\s+(?:is|'s|(?:has|had)\\s+(?:been|built|done|worked|written|published|interned|spent|led|run|shipped|started|a|an|some|lots|real|great|strong)|was|wants|would|built|asked|just|recently|did|loves|reached|graduated|studies|interned|spent|made|wrote|hopes|plans|ran|led|won)\\b`,
              'i',
            ).test(rest)
          )
            tellsAbout.add(c.person.id);
        }
        mentioned.add(c.person.id);
        const l = cl.toLowerCase();
        const offset = starts[i]!;
        for (const idx of at) {
          const before = l.slice(0, idx);
          const after = lowerSentence.slice(offset + idx + c.name.length);
          const meetHere = /\bmeet\s+[\p{L}\s'-]*$/u.test(before);
          const anchored = anchoredAt(before, after);
          if (DESCRIBED.test(after)) described.add(c.person.id);
          if (!anchored) continue;
          introducing = true;
          mark(c, STRONG);
          // "cc'ing my EA Jordan to set up time", "looping in my assistant Jordan to find 30 minutes"
          if (
            !meetHere &&
            (SCHEDULER_ROLE.test(lowerSentence) ||
              (SCHEDULER_TASK.test(lowerSentence) && !/\byou\s+(?:two|both)\b/.test(lowerSentence)))
          )
            c.scheduler = true;
        }
        if (aimed) mark(c, STRONG);
      });
      // "my EA Jordan", "Jordan, who manages my calendar": an assistant however they were brought in
      const n = escapeRe(c.name.toLowerCase());
      if (
        new RegExp(
          `\\b${n}\\s*,?\\s*\\(?\\s*(?:my|our)\\s+(?:ea|assistant|executive\\s+assistant|chief\\s+of\\s+staff|scheduler|coordinator)\\b|\\b(?:my|our)\\s+(?:ea|assistant|executive\\s+assistant|chief\\s+of\\s+staff|scheduler)\\s+${n}\\b|\\b${n}\\b[^.]{0,30}\\bwho\\s+(?:manages|runs|handles|keeps)\\s+my\\s+(?:calendar|schedule|diary)`,
        ).test(lowerSentence)
      )
        c.scheduler = true;
    }
    if (kinds.includes('bare') && !namesStudent(sentence)) bareThanks = true;
    if (clauses.some((cl, i) => vocative[i] && kinds[i] === 'plain' && namesStudent(cl)))
      studentAddressed = true;
    // "I spoke to Marcus and he's happy to chat, cc'ing him here": a pronoun brought in, with one person named in
    // the sentence or the one before (and not the one spoken to: "Hannah, can you add them to the folder?")
    const namedHere = candidates.filter((c) => !c.thanked && mentions(sentence, c, caseless).length);
    const named = namedHere.length ? namedHere : namedBefore;
    // "He's been on the desk for eight years. I've copied him.": a sentence about them by pronoun keeps them in view
    if (namedHere.length || !/^\s*(?:he|she|they)\b/i.test(sentence)) namedBefore = namedHere;
    if (
      named.length === 1 &&
      !addressed.includes(named[0]!) &&
      clauses.some(
        (cl, i) =>
          kinds[i] === 'plain' &&
          /\b(?:(?:asked|told)\s+(?:him|her|them)\s+to\s+(?:jump\s+in|chime\s+in|weigh\s+in|help|join|reach\s+out|get\s+in\s+touch)|(?:loop(?:s|ed|ing)?|bring(?:s|ing)?|brought|pull(?:s|ed|ing)?)\s+(?:him|her|them)\s+in(?!\s+on\b)|(?:loop(?:s|ed|ing)?\s+in|cc(?:'?(?:ed|d|ing))?|cc-ing|add(?:s|ed|ing)?|copy(?:ing)?|copied)\s+(?:him|her|them)\b(?!\s+to\s+(?:the|this|our|my|your|a)\s+(?!thread|email|chain|conversation|note)[\p{L}]))/u.test(
            cl.toLowerCase(),
          ),
      )
    ) {
      introducing = true;
      mark(named[0]!, STRONG);
      if (SCHEDULER_ROLE.test(lowerSentence)) named[0]!.scheduler = true;
    }
    // the rest of a list after a cue: "I have copied Grace (Huang Capital) and Mei (Databricks)"; and a sentence
    // that ends by saying its one person is copied: "An analytics contact: Sam Patel, head of analytics, copied."
    const strongHere = candidates.filter((c) => c.strong && mentions(sentence, c, caseless).length);
    const namedNow = candidates.filter((c) => !c.thanked && mentions(sentence, c, caseless).length);
    for (const c of namedNow) {
      if (c.strong) continue;
      const listed = clauses.some(
        (cl, i) =>
          kinds[i] === 'plain' &&
          new RegExp(`^\\s*(?:and|&)\\s+${escapeRe(c.name)}\\b`, caseless ? 'i' : '').test(cl),
      );
      if (listed && strongHere.length) {
        mark(c, STRONG);
        introducing = true;
      }
    }
    if (
      namedNow.length === 1 &&
      new RegExp(`,\\s*${CC_STATE}(?:\\s+here)?\\s*[.!]?\\s*$`).test(lowerSentence)
    ) {
      mark(namedNow[0]!, STRONG);
      introducing = true;
    }
    // a sentence that thanks and introduces no one thanks whoever it addresses
    if (kinds.some((k) => THANKING.has(k)) && !introducing) for (const c of addressed) thank(c);
    // "Alex, Siobhan." / "Kai, Alex.": a sentence of names only, the student's and the person's
    if (vocative.every(Boolean) && namesStudent(sentence))
      for (const c of addressed)
        if (!c.thanked) {
          mark(c, STRONG);
          genericCue = true;
        }
    // thanks for the intro that names no one on the thread, and not the student ("thanks for introducing us, Alex")
    if (
      kinds.includes('thanks') &&
      !candidates.some((c) => mentions(sentence, c, true).length) &&
      !namesStudent(sentence)
    )
      unnamedThanks = true;
  }
  adminSentence = false;

  // "Alex, Sam. Sam, Alex." / "Alex — Mark. Mark — Alex." / "alex this is eli, eli this is alex"
  const swaps = [
    /(?:^|[\s.!;])([\p{L}][\p{L}'-]*)\s*(?:,|[-–—]{1,2})\s*([\p{L}][\p{L}'-]*)\s*[.;!]\s*\2\s*(?:,|[-–—]{1,2})\s*\1(?=\s*[.;!]|\s*$)/gimu,
    /(?:^|[\s.!;])([\p{L}][\p{L}'-]*),?\s+this\s+is\s+([\p{L}][\p{L}'-]*)\s*[,.;]\s*\2,?\s+this\s+is\s+\1\b/gimu,
  ];
  for (const re of swaps)
    for (const m of body.matchAll(re))
      for (const c of candidates)
        if ([m[1]!, m[2]!].some((w) => w.toLowerCase() === c.name.toLowerCase())) {
          mark(c, STRONG);
          mentioned.add(c.person.id);
          genericCue = true;
        }

  // a new subject can point at the person like the body does ("u should talk to eli")
  if (!isReplySubject)
    for (const c of candidates)
      for (const idx of mentions(subjectLower, c, true))
        if (anchoredAt(subjectLower.slice(0, idx), subjectLower.slice(idx + c.name.length))) {
          mark(c, STRONG);
          mentioned.add(c.person.id);
        }
  // the subject names the person next to intro wording ("Intro: Alex <> Sam", "Nadia / Alex")
  if (!isReplySubject)
    for (const c of candidates)
      if (pairNames.has(c.name.toLowerCase()) || (subjectIntro && mentions(subject, c, true).length)) {
        mark(c, STRONG);
        mentioned.add(c.person.id);
      }

  // the sender speaks to the student and to the person, and tells the student who the person is: "Alex, Rui runs
  // the data platform at Contoso. Rui, thank you for making the time."
  if (!isReplySubject && studentAddressed && !WORK_SPLIT.test(body.toLowerCase()))
    for (const c of candidates)
      if (spokenTo.has(c.person.id) && described.has(c.person.id) && !c.thanked) mark(c, GENERIC);

  // a new thread from a third party that names someone it copies, with nothing else to say about them, is
  // presenting them when it says who they are ("Alex, Mei is an engineer at Databricks who invests on the side.")
  const others =
    candidates.length +
    [...to, ...cc].filter(
      (e) =>
        !mine.has(e) && e !== from && !candidates.some((c) => c.person.emails.some((x) => lower(x) === e)),
    ).length;
  const workSplit = WORK_SPLIT.test(body.toLowerCase());
  if (inbound && !isReplySubject && others <= 2 && !ARRANGES_MEETING.test(body.toLowerCase()) && !workSplit)
    for (const c of candidates) {
      if (c.thanked || c.looseThanked || c.scheduler || !mentioned.has(c.person.id)) continue;
      const counter = notPresenting(escapeRe(c.name.toLowerCase()));
      const where = sentencesOf(body).filter((x) => mentions(x, c, caseless).length);
      const role = roleDescribed(escapeRe(c.name));
      if (
        where.length &&
        !where.some((x) => counter.test(x.toLowerCase())) &&
        where.some((x) => role.test(caseless ? x.replace(/^./, (ch) => ch.toUpperCase()) : x))
      )
        mark(c, GENERIC);
    }

  if (inbound && !isReplySubject && !workSplit)
    for (const c of candidates)
      if (tellsAbout.has(c.person.id) && !c.thanked && !c.looseThanked && !c.scheduler) mark(c, GENERIC);

  // the sender writes to the person about the student, who is copied: "Marcus, Alex (cc) built the plugin. Worth a
  // chat?"
  // (or writes to that one person only, describing the student or asking for time: "Professor Chen, Alex Rivera
  // (cc) is a strong junior with systems experience.")
  const toOthers = to.filter((e) => !mine.has(e) && e !== from);
  const asksForTime =
    /\b(?:would\s+you|could\s+you|can\s+you|any\s+chance|might\s+you|open\s+to|spare|make\s+time|take\s+a\s+call|have\s+time|up\s+for)\b/i.test(
      body,
    );
  if (inbound && !isReplySubject && studentOn === 'cc' && namesStudent(body))
    for (const c of candidates)
      if (
        (spokenTo.has(c.person.id) ||
          (toOthers.length === 1 && (asksForTime || !!studentDesc?.test(body)))) &&
        to.some((e) => c.person.emails.some((x) => lower(x) === e)) &&
        !c.thanked &&
        !c.looseThanked &&
        !c.scheduler
      )
        mark(c, GENERIC);

  // anyone named in a message that introduces
  if (genericCue) for (const c of candidates) if (mentioned.has(c.person.id)) mark(c, GENERIC);

  // ---- the fallback's evidence: a person named in a short group email from a third party, said to be someone the
  // student could talk to, with nothing showing they are copied for another reason
  const lowerBody = body.toLowerCase();
  const possible: PossibleCue[] = [];
  if (inbound && !ctx.prior && others <= 3) {
    const bodySentences = sentencesOf(body);
    const presentingWords = POSSIBLE_PRESENTING.test(lowerBody) || POSSIBLE_PRESENTING.test(subjectLower);
    for (const c of candidates) {
      if (c.scheduler || c.admin || c.thanked || c.looseThanked) continue;
      const inSubject = !isReplySubject && mentions(subject, c, true).length > 0;
      if (!mentioned.has(c.person.id) && !inSubject) continue;
      const at = bodySentences.flatMap((x, i) => (mentions(x, c, caseless).length ? [i] : []));
      const where = at.map((i) => bodySentences[i]!);
      // the sentence after a mention that goes on about them: "He leads analytics at Contoso."
      const after = at
        .map((i) => bodySentences[i + 1] ?? '')
        .filter((x) => x && !candidates.some((o) => o !== c && mentions(x, o, caseless).length));
      const next = after.filter((x) => /^\s*(?:he|she|they)\b/i.test(x));
      const cues: string[] = [];
      let score = 0;
      const add = (n: number, cue: string) => {
        score += n;
        cues.push(`${n > 0 ? '+' : ''}${n} ${cue}`);
      };
      add(1, 'named');
      if (!isReplySubject) add(1, 'a new thread');
      const role = roleDescribed(escapeRe(c.name));
      const n = escapeRe(c.name.toLowerCase());
      if (
        where.some((x) => role.test(caseless ? x.replace(/^./, (ch) => ch.toUpperCase()) : x)) ||
        where.some((x) => new RegExp(`\\b${n}\\b[^.!?]{0,40}?\\b${POSSIBLE_ROLE}`, 'iu').test(x)) ||
        next.some((x) => new RegExp(`^\\s*(?:he|she|they)\\b[^.!?]{0,30}?\\b${POSSIBLE_ROLE}`, 'iu').test(x))
      )
        add(1, 'says who they are');
      // "Worth a conversation.": the sentence after them, when it names no one else
      if ([...where, ...after].some((x) => POSSIBLE_TALK.test(x.toLowerCase()))) add(1, 'someone to talk to');
      if (presentingWords) add(1, 'presenting words');
      if (
        studentDesc?.test(body) ||
        tellsAbout.has(c.person.id) ||
        bodySentences.some((x) => namesStudent(x) && POSSIBLE_PRESENTING.test(x.toLowerCase()))
      )
        add(1, 'presents the student');
      if (POSSIBLE_WHEN_WHERE.test(lowerBody)) add(-1, 'a time or a place');
      const counter = POSSIBLE_COUNTER(n);
      if (where.some((x) => counter.test(x.toLowerCase()))) add(-2, 'acts with the sender or on the work');
      if (ARRANGES_MEETING.test(lowerBody)) add(-1, 'arranges a meeting');
      if (/\b(?:have|had|already)\s+(?:already\s+)?met\b/.test(lowerBody)) add(-2, 'they have met');
      if (workSplit) add(-2, 'shared work');
      if (ADMIN_PURPOSE.test(lowerBody)) add(-2, 'an administrative copy');
      if (offerCue) add(-2, 'an offer to introduce later');
      if (POSSIBLE_LOGISTICS.test(lowerBody)) add(-1, 'logistics');
      possible.push({ personId: c.person.id, score, cues });
    }
  }

  // ---- decide
  const prior = ctx.prior;
  const excluded = (c: Candidate) =>
    c.scheduler ||
    (c.admin && !c.plainStrong) ||
    (c.thanked && !c.strong) ||
    (!!prior && (prior.introducerId === c.person.id || prior.introducedIds.includes(c.person.id)));
  const thankedIds = candidates.filter((c) => c.thanked).map((c) => c.person.id);
  const introThankedIds = candidates.filter((c) => c.introThanked).map((c) => c.person.id);
  const schedulerIds = candidates.filter((c) => c.scheduler).map((c) => c.person.id);
  const introduced = inbound
    ? candidates.filter((c) => !excluded(c) && c.score >= THRESHOLD).map((c) => c.person.id)
    : [];
  if (introduced.length)
    return out('introduction', 'introducing cues name them', {
      introducerId: msg.fromPersonId,
      introducedIds: introduced,
      studentOn,
      thankedIds,
      introThankedIds,
      schedulerIds,
      possible,
    });
  const answersIntroSubject =
    isReplySubject &&
    (subjectIntro || pairNames.size > 0 || /<>|\bintro(?:duction)?s?\b|\bopt-?in\b/i.test(subject));
  const replyReason = prior
    ? 'the thread already holds an introduction'
    : candidates.some((c) => c.introThanked) || (isReplySubject && thankedIds.length)
      ? 'thanks the introducer'
      : bccCue
        ? 'moves the introducer to bcc'
        : unnamedThanks
          ? 'thanks for the introduction'
          : isReplySubject && bareThanks
            ? 'a reply that opens with thanks'
            : isReplySubject &&
                /\be-?meet(?:ing)?\b|\bmeet(?:ing)?\s+you\s+(?:over|via|by)\s+e-?mail\b|\bvirtually\s+meet|\bmeet(?:ing)?\s+you\s+virtually\b/i.test(
                  body,
                )
              ? 'a reply to people just introduced ("nice to e-meet")'
              : // a reply-all with no subject line at all reads like one with "Re:"
                (isReplySubject || !subject) &&
                  candidates.some((c) => c.looseThanked) &&
                  ARRANGES_TIME.test(body)
                ? 'thanks someone on the thread and arranges the call'
                : isReplySubject &&
                    candidates.some((c) => spokenTo.has(c.person.id) && !c.scheduler) &&
                    studentAddressed &&
                    ARRANGES_TIME.test(body)
                  ? 'speaks to the person on the thread, then to the student with a time'
                  : answersIntroSubject
                    ? 'answers an introduction subject'
                    : undefined;
  if (replyReason)
    return out('intro_reply', replyReason, {
      studentOn,
      thankedIds,
      introThankedIds,
      schedulerIds,
      possible,
    });
  return out('none', schedulerIds.length ? 'an assistant brought in to schedule' : 'no introducing cue', {
    studentOn,
    thankedIds,
    introThankedIds,
    schedulerIds,
    possible,
  });
}

/**
 * Whether an inbound group email introduces the student to someone: a human sender, the student on the To or CC
 * line, at least one other known person on it, and wording that introduces that person (see `readIntroduction`).
 * A CC alone is not an introduction, "meet" used for meeting is not one, and neither is an answer inside an
 * introduction thread.
 */
export function detectIntroduction(
  msg: Msg,
  people: IntroPerson[],
  userEmails: string[],
  ctx: IntroductionContext = {},
): Introduction | undefined {
  const r = readIntroduction(msg, people, userEmails, ctx);
  if (r.kind !== 'introduction' || !msg.fromPersonId) return undefined;
  return {
    introducerId: msg.fromPersonId,
    introducedIds: r.introducedIds,
    messageId: msg.id,
    at: msg.sentAt,
  };
}

/** The fallback asks only when the evidence reaches this (see `possibleIntroduction`). */
export const POSSIBLE_INTRO_THRESHOLD = 4;

export interface PossibleIntroduction {
  /** the sender, who may have made the introduction */
  introducerId: string;
  /** the new people on the message the sender may be introducing, most likely first */
  personIds: string[];
  messageId: string;
  at: string;
  score: number;
}

/**
 * The fallback for an introduction the cues missed: a group email from someone the student knows, with the student
 * and at least one new person on the To or CC line, that `readIntroduction` did not call an introduction (nor a reply
 * in one) but whose evidence for a new person reaches `POSSIBLE_INTRO_THRESHOLD`. The app then asks the student
 * ("Did Lena introduce you to Sam?") instead of guessing either way. Rare by design: on the labelled corpus it asks
 * about a small share of the messages that are not introductions (see the corpus test).
 */
export function possibleIntroduction(
  msg: Pick<EmailMessage, 'id' | 'direction' | 'fromPersonId' | 'sentAt'>,
  reading: IntroductionReading,
  opts: { senderKnown: boolean; knownIds?: Iterable<string> },
): PossibleIntroduction | undefined {
  if (reading.kind !== 'none' || msg.direction !== 'inbound' || !msg.fromPersonId || !opts.senderKnown)
    return undefined;
  const known = new Set(opts.knownIds ?? []);
  const hits = reading.possible
    .filter((p) => p.personId !== msg.fromPersonId && !known.has(p.personId))
    .filter((p) => p.score >= POSSIBLE_INTRO_THRESHOLD)
    .sort((a, b) => b.score - a.score);
  if (!hits.length) return undefined;
  return {
    introducerId: msg.fromPersonId,
    personIds: hits.map((p) => p.personId),
    messageId: msg.id,
    at: msg.sentAt,
    score: hits[0]!.score,
  };
}
