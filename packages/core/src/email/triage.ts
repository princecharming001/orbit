import { normalizeEmail } from '../text/normalize';
import type { EmailCategory, MessageExtraction, ProposedTime, ReplySignal } from '../types';
import { extractFirstDate, extractTimes } from './when';

export { extractFirstDate, hostTimeZone, resolveZone, statedMessageZone, zonedTimeToUtc } from './when';

export interface TriageInput {
  subject?: string;
  messages: { fromEmail: string; direction: 'inbound' | 'outbound'; body: string; isAutomated: boolean }[];
  /** every address the student sends from (primary, school alias, send-as); a message from one is outbound */
  userEmails: string[];
}

export interface TriageResult {
  category: EmailCategory;
  isNetworking: boolean;
  confidence: number;
  topic: string;
}

/** Networking vocabulary that can appear on either side of the thread. */
const NETWORKING =
  /\b(coffee( chat)?|informational( interview| call| chat)?|advice|your (path|journey|experience|story|career|background)|how (you|did you) (got|get|ended up|made the (move|switch)|broke) into|introduc(e|es|ed|ing|tion)|intro\b|catch ?up|mentor(ship)?|alum(ni|nus|na)?|referr?al|(hear|learn) (more )?about (your|the|how|what)|\d{1,2}[- ]?min(ute)?s? (of your time|to (hear|chat|learn|talk))|chat (about|re)\b|pick your brain|would love to (hear|learn|chat|connect)|grab (a )?(coffee|call)|sent you an invite|looking forward to (speaking|chatting|our (call|chat|conversation))|thanks( so much| again)? for (your time|chatting|the (chat|call|conversation))|(great|nice|lovely) (chatting|talking|speaking|to (meet|chat|connect)) with you|looping in|loop in|cc'?(ing|d)\b|(connected|introduced) us|for (making|taking the) time)/gi;
/** What a student writes when asking for a chat; only counted in the student's own messages. */
const OUTREACH =
  /\b((freshman|sophomore|junior|senior|student|undergrad|grad student|mba student|first[- ]year|second[- ]year) (at|studying|in)\b|came across your (work|profile|post|talk|article|background|team)|(would|will) you be (open|willing|available) to|your (perspective|insights?)|(break(ing)?|get(ting)?) into|learn (more )?from (you|your)|value your (perspective|advice|insight|time)|reach(ing)? out because|(also|fellow) (went to|alum|alumni|[a-z]+ (alum|grad|student))|any chance you'?d have|\d{1,2} minutes|love to (connect|hear|learn|chat)|(quick|brief|short) (call|chat|conversation)|exploring (roles|careers|opportunities|a career)|(15|20|30)[- ]min)/gi;
const RECRUITING =
  /\b((?<!informational )interview(s|ing)?\b|online assessment|\bOA\b|hackerrank|codesignal|coding challenge|offer letter|background check|onboarding|application (status|received|update)|your (application|candidacy)|next (steps|round)|phone screen|technical (screen|interview)|superday|final round|hiring (manager|team)|recruit(er|ing) (team|coordinator)|i'?m (a|the) (technical |university |campus )?recruiter|(university|campus) recruit(ing|er)|talent (acquisition|partner)|move you forward|moving forward with your|we regret|unfortunately we|position has been filled|(intern|internship|new grad) program|we'?re hiring|schedule your interview|availability for (a|an|the) [\w -]{0,20}interview)/gi;
/** Phrase-level transactional cues; single everyday words ("order", "statement", "payment") are not enough. */
const TRANSACTIONAL =
  /\b(your order|order #|order (number|confirmation|has shipped|shipped)|receipt|invoice|payment (received|due|confirmation|failed|declined)|verification code|verify your (email|account|identity)|reset your password|password reset|unsubscribe|account statement|billing (statement|update)|tracking number|has been delivered|out for delivery|subscription (renewal|confirmed|canceled))\b/gi;

const RECRUITER_LOCAL = /recruit|talent|university|campus|careers|hiring|staffing/i;

function hits(re: RegExp, text: string): number {
  re.lastIndex = 0;
  return text.match(re)?.length ?? 0;
}

/**
 * Category of a thread. Cues are counted (not just tested): networking vocabulary on both sides plus the
 * student's own outreach phrasing, recruiting-process vocabulary, and phrase-level transactional cues. Recruiting
 * wins only with at least two recruiting cues (or one plus a recruiter sender) that outnumber the networking ones,
 * and never on a thread the student started with a networking ask.
 */
export function heuristicTriage(input: TriageInput): TriageResult {
  const topic = input.subject ?? '';
  const mine = new Set(input.userEmails.map((e) => normalizeEmail(e)));
  const msgs = input.messages.map((m) => ({
    ...m,
    direction: mine.has(normalizeEmail(m.fromEmail)) ? ('outbound' as const) : m.direction,
  }));
  if (msgs.every((m) => m.isAutomated))
    return { category: 'automated', isNetworking: false, confidence: 0.95, topic };
  const humans = msgs.filter((m) => !m.isAutomated);
  const hasInboundHuman = humans.some((m) => m.direction === 'inbound');
  const hasOutboundHuman = humans.some((m) => m.direction === 'outbound');
  const all = `${topic}\n${humans.map((m) => m.body.slice(0, 1500)).join('\n')}`;
  const outText = humans
    .filter((m) => m.direction === 'outbound')
    .map((m) => m.body.slice(0, 1500))
    .join('\n');
  const net = hits(NETWORKING, all) + hits(OUTREACH, `${outText}\n${hasOutboundHuman ? topic : ''}`);
  const rec = hits(RECRUITING, all);
  const trans = hits(TRANSACTIONAL, all);
  const recruiterSender =
    humans.some((m) => m.direction === 'inbound' && RECRUITER_LOCAL.test(m.fromEmail.split('@')[0] ?? '')) ||
    /\bi'?m (a|the) [\w ]{0,20}recruiter\b/i.test(all);
  const studentInitiated = humans[0]?.direction === 'outbound';
  if (trans >= 2 && net === 0 && rec === 0)
    return { category: 'transactional', isNetworking: false, confidence: 0.7, topic };
  const recruitingWins =
    (rec >= 2 || (rec >= 1 && recruiterSender)) &&
    (rec >= net || (recruiterSender && !studentInitiated)) &&
    !(studentInitiated && net >= 2 && rec < net + 2);
  if (recruitingWins)
    return {
      category: 'recruiting_process',
      isNetworking: false,
      confidence: Math.min(0.9, 0.6 + 0.1 * Math.min(rec, 3)),
      topic,
    };
  if (net > 0) {
    const conf = Math.min(
      0.95,
      0.55 + 0.1 * Math.min(net, 3) + (hasInboundHuman && hasOutboundHuman ? 0.1 : 0),
    );
    return { category: 'networking', isNetworking: true, confidence: conf, topic };
  }
  if (trans >= 1 && !hasOutboundHuman)
    return { category: 'transactional', isNetworking: false, confidence: 0.55, topic };
  if (hasInboundHuman && hasOutboundHuman)
    return { category: 'personal', isNetworking: false, confidence: 0.5, topic };
  return { category: 'other', isNetworking: false, confidence: 0.5, topic };
}

/**
 * Proposed times in a message, resolved in `timeZone` (the student's zone) unless the text states one ("2pm ET",
 * "all times Pacific"); a stated zone is returned on each result as `timeZone`.
 */
export function extractProposedTimes(text: string, reference: Date, timeZone?: string): ProposedTime[] {
  return extractTimes(text, reference, { timeZone });
}

// ---------------------------------------------------------------------------------------------------------------
// reply signals
//
// How a reply is read (heuristicSignal):
//   1. The body is cut into sentences (end punctuation, line breaks) and each sentence into clauses at a contrast
//      ("but", "though", "however", "although"). A sentence ending in "?" is a question.
//   2. Each sentence and clause is matched against small lexicons, one per cue family below. Cues that can only be
//      read in context are checked in code where the context is known: an offer word inside a question about the
//      past ("which Sarah referred you?"), a "pass" that passes a resume along, "make sure" next to "sure".
//   3. The yes / no / not-now stance is scored with weights: a yes to a chat counts 3, a scheduling ask 2, a weak
//      "sure" 1; a hard no 3, a no to calls 2; a not-now 2. A clause that a later contrast clause answers the other
//      way ("I'm slammed this week, but happy to chat next week") counts half.
//   4. The decision order is documented on heuristicSignal.

/** A sentence and its clauses. */
interface Sentence {
  text: string;
  question: boolean;
  clauses: string[];
}

const CONTRAST = /,?\s+(?=\b(?:but|though|however|although)\b)|;\s*/i;

function sentencesOf(body: string): Sentence[] {
  return body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((text) => ({
      text,
      question: /\?["')\]]*$/.test(text),
      clauses: text
        .split(CONTRAST)
        .map((c) => c.trim())
        .filter(Boolean),
    }));
}

function anyOf(res: RegExp[], text: string): boolean {
  return res.some((re) => re.test(text));
}

// ---- lexicons --------------------------------------------------------------------------------------------------

const OOO =
  /\b(out of (the )?office|on (vacation|leave|pto|parental leave|maternity leave|paternity leave|holiday|sabbatical)|away (until|from|through)|auto(-| )?reply|automatic reply|(limited|intermittent|no|minimal) (access to )?(my )?e-?mail|currently (traveling|travelling|away|out)|(will|i'?ll) (get back to you|respond|reply)( to (you|your (e-?mail|message|note)))?( as soon as possible)? (when|once|upon|after) (i|my) return|back in the office|ooo)\b/i;
/** How a vacation responder opens: the first line reads like a template, not like a person answering. */
const AUTO_REPLY_OPENER =
  /^(?:(?:hi|hello|dear)[^\n]{0,30}\n+)?\s*(thank(s| you) for your (e-?mail|message|note|inquiry)|i am (currently )?(out of the office|away from (the|my) (office|desk)|on (annual |parental |maternity |paternity )?leave|ooo\b)|i will be (out of the office|away from)|automatic reply|this is an automat)/i;
const RETURN_PHRASE =
  /\b(?:until|through|thru|till|returning(?: to the office)?(?: on)?|return(?: to the office)? on|back(?: in the office| in office| at my desk| online)?(?: on)?)\s+([^\n]{0,60})/gi;

/** A no to a call ("I don't do coffee chats", "calls are tough for me", "I'll pass on a call", "Pass on a call for now"). */
const NO_CALL: RegExp[] = [
  /\b(don'?t|do not|can'?t|cannot|won'?t be able to|am not able to|'m not able to|unable to|no longer) (really )?(do|take|make time for|have time for|hop on|get on|jump on|schedule) (a |an |any )?(more )?(quick |live |phone |video |zoom )?(coffee chats?|calls?|phone calls?|video calls?|meetings?|zoom( calls)?|informational( interviews?| calls)?)\b/i,
  /\b(not|no longer|n'?t) (really )?(doing|taking) (any )?(more )?(informational |coffee |phone |video )?(coffee chats|chats|calls|meetings|informational|interviews)\b/i,
  /\b(not|n'?t) (allowed|permitted) to (do|take|have|hop on) (any )?(calls|meetings|chats|coffee chats)\b/i,
  /\b(rather|easier) (than|to skip) (a|the) (call|chat|meeting)\b/i,
  /\be-?mail is (easier|better|best)( for me)? than (a|the) (call|chat|meeting)\b/i,
  /(^|\b(going to|gonna|have to|need to|will|'ll|'d|would|should) )pass on (a|the|any|doing a|hopping on a|getting on a) (live |phone |video |zoom )?(call|chat|meeting|coffee( chat)?)\b/i,
  /\b(i'?d|i would) (rather|prefer) (not|to skip|to pass on) (to )?(do|have|hop on|jump on|get on|take|schedule|set up)? ?(a|the|any) (live |phone |video |zoom )?(call|chat|meeting|coffee( chat)?)\b/i,
  /\b(skip|forgo) (a|the) (call|meeting|zoom|chat)\b/i,
  /\b(schedule|calendar) (doesn'?t|does not|won'?t) (really )?allow (for )?(calls|meetings|chats)\b/i,
  // "calls are tough for me", "phone isn't great for me", "video calls aren't really doable"
  /\b(calls?|phone( calls?)?|video( calls?)?|zoom( calls?)?|live calls?|meetings?) (is|are) (really |pretty |a bit |kind of )?(tough|hard|difficult|tricky|impossible|rough|not (easy|possible|great|ideal|doable|realistic|an option))\b/i,
  /\b(calls?|phone( calls?)?|video( calls?)?|zoom( calls?)?|live calls?|meetings?) (isn'?t|aren'?t) (really |always |usually )?(great|good|ideal|easy|possible|doable|realistic|practical|an option)\b/i,
];
/** A yes to questions by email ("happy to answer a couple of questions over email", "send over questions"). */
const EMAIL_OK: RegExp[] = [
  /\b(answer|take|field|respond to|help with|help you with) (a few |a couple( of)? |some |any |your |the )?(questions?|anything|them) (over|via|by|through|on) e-?mail\b/i,
  /\b(over|via|by) e-?mail (instead|is (easier|better|best))\b/i,
  /\be-?mail (works|is) (better|easier|best)\b/i,
  /\b(e-?mail|send|shoot|drop|fire) (me )?(over |along )?(your|a few|a couple( of)?|any|some|the|over) ?questions\b/i,
  /\b(e-?mail|send|shoot) (them|those) (over|along|to me|my way)\b/i,
  /\bsend (any |your |a few |some )?questions my way\b/i,
  /\bfeel free to (e-?mail|send|shoot|write|drop) (me )?(over |along )?(me )?(your |any |a few |some )?questions\b/i,
  /\b(happy|glad) to (help|answer)[^.?!]{0,40}\b(over|via|by|through) e-?mail\b/i,
  /\b(answer|take|field|respond to|help with) (a few |a couple( of)? |some |any |your |the )?(questions?|anything) (here|in (this|the) (thread|chain|e-?mail)|in writing|over text)\b/i,
];

/** "pass it along", "pass this on to", "pass on your resume": a referral, not a no. */
const PASS_REFERRAL =
  /^pass(?:ing)?\s+(?:(?:it|this|that|these|them|him|her|your\s+\w+(?:\s+\w+)?|the\s+\w+|my\s+\w+)\s+)?(?:along\b|on\s+to\b|on\s*(?:$|[.,!;])|on\s+(?:your|to|her|his|my)\b|to\s+(?:my|our|the|a|an|[A-Z]))/i;
/** A "pass" that refuses: "I'll pass", "I'm going to pass this time", "have to pass on this one". */
function refusingPass(text: string): boolean {
  const re = /(?:^|\b(?:going to|gonna|will|'ll|have to|need to|must|i)\s+)(?:have to\s+)?(?=pass\b)/gi;
  // matchAll steps past an empty match (the `^` alternative before a leading "pass"); a bare exec loop would match
  // the same empty string at index 0 forever
  for (const m of text.matchAll(re)) {
    const rest = text.slice(m.index + m[0].length);
    if (!PASS_REFERRAL.test(rest) && !/^pass on (a|the|any|doing|hopping|getting) /i.test(rest)) return true;
  }
  return false;
}
/** An unambiguous no to the ask. */
const HARD_NO: RegExp[] = [
  /\b(am|'m|are|'re) not (able|in a position|permitted|allowed) to (chat|talk|meet|take|help|connect|do|speak)\b/i,
  /\bnot able to take (any )?(calls|meetings|chats)\b/i,
  /\b(aren'?t|are not|isn'?t|is not|not) (permitted|allowed) to (speak|talk|meet|chat|connect)\b/i,
  /\b(have to|need to|going to|will|'ll|must|'d have to) (decline|say no)\b/i,
  /\b(please )?(don'?t|do not) (contact|email|e-mail|message) me\b/i,
  /\b(remove|take) me (from|off)\b|\bunsubscribe me\b|\b(stop|quit) (emailing|contacting|messaging|writing to) me\b/i,
  /\bnot interested\b/i,
  /^(no thank you|no thanks)\b/i,
  /\b(don'?t|do not) have (the |any )?(time|capacity) (to|for) (a |an |any )?(quick )?(calls?|chats?|this|that|meetings?|coffee( chats?)?)\b(?![^.?!]{0,30}\b(this|next) week\b|[^.?!]{0,10}\b(today|tomorrow)\b)/i,
  /\b(can'?t|cannot) help\b|\bunable to (help|meet|chat|take)\b/i,
  /\bnot (a|the) (right|good) fit\b/i,
  /\bi'?d rather not\b(?!\s+(?:do|have|hop|jump|get|take|schedule|set))/i,
  /\bnot something i can (do|help with)\b/i,
  // a category of asks refused: "I can't take them on", "I don't take these on", "I'm not taking on mentees"
  /\b(can'?t|cannot|don'?t|do not|won'?t|unable to) (really )?(take|accept) (these|those|them|such requests|requests like this) on\b/i,
  /\b(can'?t|cannot|don'?t|do not|won'?t|unable to) (really )?((take on|accept) (these|those|such|requests like this)|(take on|accept|do) (this|these) kinds? of (things?|requests?))\b/i,
  /\b(not|no longer|n'?t) (taking|accepting|doing) (on )?(any )?(new |more )?(mentees|students|requests|informational interviews|coffee chats|calls|meetings)\b/i,
];
/** A bare no as its own clause: "thx but no", "Appreciate it, but no.", "nope, sorry". */
const BARE_NO = /^(?:(?:but|though|so)\s+)?(?:no|nope|nah)(?:[,\s]+(?:thanks|thank you|thx|sorry))?[.!]*$/i;
/**
 * A no limited to now ("not taking mentees this year", "can't right now"): a not-now, not a no. "This time", "this
 * round" and "for now" are not: "I'll pass this time" and "I'm going to pass for now" are a no (unless the message
 * invites a later try, see LATER_INVITE).
 */
const NOW_SCOPE =
  /\b(right now|at the moment|currently|these days|this (month|quarter|semester|term|year|fall|spring|summer|winter|cycle|season))\b/i;
/** When to come back: "in Q1", "next fall", "after the new year", "in a couple of months", "in December". */
const LATER_WHEN =
  '(?:(?:in|after|around|by|come|until|closer to|sometime in|once|early|mid|late)\\s+)?(?:the\\s+)?(?:new year|holidays|break|next (?:month|quarter|semester|term|year|fall|spring|summer|winter|cycle)|q[1-4]|january|february|march|april|may|june|july|august|september|october|november|december|spring|summer|fall|autumn|winter|(?:a\\s+)?(?:few|couple(?: of)?|several) (?:weeks|months)|later|then)\\b';
/**
 * An invitation to come back later ("try me again in Q1", "reach back out in a couple months", "ping me in December",
 * "let's reconnect in November"): whatever no came before it, it is a not-now.
 */
const LATER_INVITE = new RegExp(
  `\\b(?:circle back|check back|come back|get back in touch|reach (?:back )?out|reconnect|ping me|hit me up|try me|follow up|revisit|try again|(?:e-?mail|write|message|text) me|ask (?:me )?again)(?: again| back)?(?:[^.?!]{0,20}?\\s)?${LATER_WHEN}`,
  'i',
);
/** "Not now": busy, not this quarter, try me later, no longer there. */
const NOT_NOW: RegExp[] = [
  LATER_INVITE,
  /\b(slammed|swamped|underwater|crazy busy|super busy|really busy|so busy|hectic|heads[- ]down|stretched (too |pretty |a bit )?thin)\b/i,
  /\b(don'?t|do not) (really |currently |actually |quite )?have (much |the |any )?(bandwidth|capacity)\b|\bno bandwidth\b/i,
  /\b(don'?t|do not) (really |currently )?have (the |much )?time (for|to take) (calls|chats|meetings|coffee)\b/i,
  /\b(can'?t|cannot) (really )?take (on )?(any )?(more|new) (calls|chats|meetings)\b/i,
  /\bmaybe (in |in the |after the |around |next )?(new year|holidays|next (month|quarter|semester|year)|spring|summer|fall|winter|january|february|march|april|june|july|august|september|october|november|december)\b/i,
  // "things are pretty crazy right now", "work is nuts at the moment", "timing is rough"
  /\b(things are|things have been|it'?s|it is|life is|work is|i'?m|i am|we'?re|we are) (been )?(pretty |really |super |so |a bit |quite |kind of |kinda |just |absolutely |a little )?(crazy|nuts|insane|chaotic|wild|hectic)\b/i,
  /\btiming (is|'s) (pretty |really |a bit |just )?(rough|tough|bad|tricky|terrible|awful|not (great|good|ideal|right))\b|\btiming (isn'?t|is not) (great|good|ideal|right)\b|\bnot (the )?(best|right|ideal) timing\b/i,
  /\b(can'?t|cannot|won'?t be able to)( do it| make it| chat| talk| meet)? (this|next) (month|quarter|semester|term|year|fall|spring|summer|winter)\b/i,
  /\b(circle back|ping me|reach out|try me|follow up|revisit)( again)? (in|after|later|then)\b/i,
  /\b(not|isn'?t|is not) a (great|good) time\b|\bnot this (month|quarter|semester|term|year|fall|spring|summer|winter|cycle)\b/i,
  /\b(no longer|don'?t) work (at|for)\b|\bnot (at|with) [a-z]+ any ?more\b|\bleft (the company|[a-z]+ (last|in|a few))\b|\bno longer (at|with)\b/i,
  /\bnot sure (i'?m|i am|i'?d be|how) [^.?!]{0,20}\b(right|useful|helpful|much help)\b/i,
];
/** The sender says yes to a chat with the student themselves ("Happy to chat next week", "Let's find a time"). */
const YES_CHAT =
  /\b((happy|glad|delighted|would love|'d love|love|more than happy|'d be happy|be happy|be glad) to (chat|talk|meet|speak|connect|catch up|hop on|jump on|get on|grab|find (a|some) time|set (something|a time|up a (call|time|chat))|do a (call|chat|quick call)|share)|let'?s (chat|talk|meet|find (a|some) time|set (something|a time) up|grab|connect|do it)|count me in|i can make (some )?time|(i'?d|i would|would) (be )?(love|happy|glad|delighted) to\s*[.!,]|yes,? would love to)\b/i;
/** A weaker yes ("sure", "of course", "happy to help"). "Make sure" and "not sure" are not one. */
const YES_WEAK =
  /\b(happy to|would love to|glad to|sure|absolutely|of course|sounds (great|good)|i'?d be (happy|glad|delighted) to|i'?m (happy|glad) to|definitely|more than happy|be happy to|love to (chat|help|connect)|claro)\b/i;
const NOT_A_YES = /\b(make|making|not|for) sure\b/gi;
/** Asking the student to pick the time: the answer is times, not anything else. */
const SCHED_ASK: RegExp[] = [
  /\b(let me know|lmk) (what|which) (time|day)s? (works?|are best)\b|\b(let me know|lmk) what works\b/i,
  /\bwhat works (for you|best)\b|\bwhatever works( for you| best)?\b|\bwhen(ever)? works( for (you|u))?\b/i,
  /\b(send|shoot|share) (me |over )?(a |some |a few |a couple( of)? |your |any )?(times|windows|slots|options|availability|time)\b/i,
  /\bwhat (times?|days?|slots?) (work|are (good|best)|suit)\b|\byour availability\b|\bwhen (are|would) you (be )?free\b|\bpick (a|any|whatever) (time|slot|works)\b/i,
  /\bwhat (does|do) your (schedule|calendar|week|availability) look like\b/i,
  // "how does your week look?", "how's next week looking for you?"
  /\bhow(?:'s| does| do| is| are) (?:your|next|this) (?:week|schedule|calendar|availability|month)(?: (?:look(?:ing)?|shaping up))\b/i,
  /\bsend (me |over )?(a |the )?(calendar )?invite (for )?(whenever|any ?time|when)\b/i,
];
/** "Monday is booked, but Tues works", "...however I could do": a turn toward a time that works. */
const COUNTER =
  /\b(but|however|instead|though)\b[^.?!]{0,80}\b(happy|could(?!n['’]?t)|can(?!['’]?t|not)|(?<!(?:n['’]?t|not|no longer) )works?|(?<!feel )free|available|how about|what about|week after|open)\b/i;
/** A sign-off that closes the door when nothing in the message opens one. */
const PARTING =
  /\b(best of luck|good luck with (the|your|everything)|wish(ing)? you (the best|luck|all the best))\b/i;
/**
 * What turns a parting "best of luck" into a no on a chat that is not waiting on an answer: a refusal or an
 * apology ("We aren't hiring interns this cycle. Best of luck!"). Idioms with a negation are not refusals.
 */
const DECLINE_CUE = /\b(unfortunately|sorry|afraid|regret(tably)?|not|no|never|cannot|nothing)\b|n['’]t\b/i;
const NOT_A_REFUSAL =
  /\b(no (worries|problem|rush|pressure|doubt)|not a problem|not sure|can['’]?t wait|(don['’]?t|do not) (worry|hesitate)|(wouldn['’]?t|couldn['’]?t) be (happier|prouder|more)|no wonder|not bad)\b/gi;
/**
 * Warmth that makes "best of luck" a friendly close, not a no: congratulations, glad to have met, thanks for an
 * update or a thank-you, keep me posted. A plain "thanks for reaching out" is how many declines open, so it is not one.
 */
const WARM_CLOSE =
  /\b(congrat(s|ulations)?|(great|nice|lovely|good|so good|wonderful) (to (meet|see|hear|chat|connect|talk)|meeting|chatting|talking|seeing)|(great|awesome|amazing|exciting|fantastic|wonderful|terrific|good) news|(that'?s|this is|how) (awesome|great|amazing|exciting|fantastic|wonderful|terrific)|so (glad|happy|excited|proud)|proud of you|thank(s| you)( so much)? for (the|your) (update|thank[- ]you|kind (words|note)|note after|follow[- ]up|lovely note|sweet note)|thanks for (keeping me posted|following up|letting me know how|sharing (the|your) (news|update))|keep me posted|keep in touch|stay in touch|let me know how (it|things|everything) (goes|go|turns out)|enjoyed (our|the|meeting|chatting|talking))\b/i;

/** A capitalised word that can be a person's name: not a weekday, a month or a meeting tool. */
const NAME =
  '(?!(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\\b|(?:January|February|March|April|May|June|July|August|September|October|November|December)\\b|(?:Zoom|Teams|Google|Slack|LinkedIn|Tomorrow|Today|Next|This)\\b)[A-Z][a-z]+\\b';
/** Verbs that point the student to someone, at a sentence start or not ("Try Mei Lin", "talk to Ana"). */
const POINT_VERB =
  '(?:[Tt]alk(?:ing)?|[Ss]peak(?:ing)?|[Cc]hat(?:ting)?|[Rr]each(?:ing)? out|[Cc]onnect(?:ing)?|[Gg]et(?:ting)? in touch|[Aa]sk(?:ing)?|[Cc]ontact(?:ing)?|[Ee]mail(?:ing)?|[Tt]ry)';
/** Someone else, named or by role: who a redirect or a recommendation points to. */
const TARGET: RegExp[] = [
  /\b(my|our) ([a-z]+ ){0,2}?(colleague|teammate|coworker|co-worker|friend|manager|boss|partner|counterpart|director|lead|vp|associate|recruiter|mentor|classmate)s?\b/i,
  new RegExp(`\\b(?:connect|introduce|intro|put) you (?:in touch )?(?:with|to) ${NAME}`, 'i'),
  /\b(on|in) (my|our) ([a-z]+ ){1,3}?(team|group|desk)\b/i,
  /\bsomeone (on|in|at|from) (my|our|the)\b/i,
  /\b(recruiting|recruitment|talent|campus|university|hr|people) team\b/i,
  /[\w.+-]+@[\w-]+\.[\w.]+/,
  new RegExp(`\\b${POINT_VERB}(?: to| with)? (?:my friend )?${NAME}`),
  /\b(talk(ing)?|speak(ing)?|reach(ing)? out|connect(ing)?) (to|with) my (friend|colleague|teammate) [a-z]+\b/i,
  /\b[A-Z][a-z]+( [A-Z][a-z]+)? \((cc'?d|cc|copied|bcc'?d)\)/,
];
/** Sends the student elsewhere instead of (not as well as) a chat with the sender. */
const AWAY: RegExp[] = [
  /\bnot (really )?the (right|best) (person|contact|one)\b/i,
  /\b(a )?(much )?better (person|contact|fit)( (to|for|would be))?\b/i,
  /\bbetter off\b/i,
  /\b(talk(ing)?|speak(ing)?|reach(ing)? out|connect(ing)?|contact(ing)?|email(ing)?) (to |with )?[^.?!]{0,40}\binstead\b/i,
  /\bnot (really )?(my|in my) (area|wheelhouse|team|group|expertise|space)\b/i,
  /\bnot (in|on) that (group|team|side|role)( any ?more)?\b/i,
  /\bi'?m on the [a-z]+ side\b/i,
];
/** Points the student to someone ("you should talk to Ana", "I'd recommend reaching out to Marcus"). */
const RECOMMEND: RegExp[] = [
  /\b(you|u)( should| might| could| may|'d)( (also|def|definitely|really|probably|totally))?( want to)? (talk|speak|chat|reach out|connect|get in touch|meet)( (to|with))?\b/i,
  /\b(i'?d|i would|i)( also)? (recommend|suggest) (talking|reaching out|speaking|connecting|contacting|chatting|you (talk|reach out|connect))\b/i,
  new RegExp(`\\b[Tt]ry ${NAME}`),
  /\b(colleague|teammate|coworker|someone on (my|our) team)\b[^.?!]{0,40}\b(would be|is|might be|could)\b/i,
  /\b(would|could|might) (also )?be a (good|great) (person|contact) to\b/i,
];
/** An intro being made in this message ("Sam, meet Alex", "connecting you as promised", "I wanted to introduce Alex"). */
const INTRO_ACT: RegExp[] = [
  new RegExp(
    `\\b(?<!(?:nice|great|good|lovely|pleasure|glad|happy|excited|wonderful) to )(?<!(?:let'?s|we could|we can|could we|can we|to) )[Mm]eet ${NAME}`,
  ),
  new RegExp(`\\b[A-Z][a-z]+,? (please )?meet ${NAME}`),
  /\bi'?d like you to meet\b/i,
  /\b(connecting|introducing) (you|the two of you)( two| both)?( as promised| with| to)?\b/i,
  new RegExp(`\\b(?:[Ww]anted|[Ww]ant|[Ww]ould like|'d like) to introduce (you to )?${NAME}`),
  new RegExp(`\\b[Ii]ntroducing ${NAME}`),
];
/** Someone added to the thread ("Looping in Sam", "Adding my colleague Priya", "Carlos (cc)", "+ Hannah"). */
const ADDED: RegExp[] = [
  /\b(looping in|loop(ed)? in|cc'?(ing|d)|bcc'?ing)\b/i,
  /\b[AaCc](?:dding|opying)(?: in)? (?:(?:my|our) (?:[a-z]+ )?)?[A-Z][a-z]+/,
  /\((cc'?d|cc|copied|added|in cc)\)/i,
  /^\+\s?[A-Z][a-z]+/,
];
/** Any cue that someone was added, named or not; with an assistant role it is the sender's scheduler. */
const ADDED_CUE = /\b(looping in|loop(ed)? in|cc'?(ing|d)|copying|adding)\b/i;
/** Who handles the sender's calendar: an assistant or a scheduler of their own. */
const SCHEDULER_ROLE =
  /\bmy\s+(executive\s+|administrative\s+)?(ea|assistant|admin|scheduler|chief of staff|coordinator)\b/i;
/** The sender's own calendar ("handles my calendar", "get something on my calendar"), whoever is added for it. */
const OWN_CALENDAR =
  /\b((handles?|manages?|runs?|keeps?|owns?) my (calendar|schedule)|(get|put) (something|it|us) on my calendar)\b/i;
/**
 * A line that adds the sender's scheduler to the thread: the next step is sending times, not writing to a stranger.
 * Someone named "to find a time" with no assistant role ("Looping in Sam (cc'd) to find a time to chat with you")
 * is an intro to Sam, not the sender's calendar.
 */
function isSchedulerLine(line: string): boolean {
  return ADDED_CUE.test(line) && (SCHEDULER_ROLE.test(line) || OWN_CALENDAR.test(line));
}
/** "pass it along", "pass your resume on": the referral sense of "pass". */
const PASS_ALONG =
  'pass (?:(?:it|this|that|these|them|your resume|your info|your name|your note|your email|the resume|the note) )?along|pass (?:it|this|that|these|them|your resume|your info|your name|your note|your email|the resume|the note) on|pass on your';
/** Who offers: "I can", "I'll", "happy to", with an optional "also" ("I can also introduce you"). */
const OFFERER =
  "(?:i(?:'ll| will| can| could| would|(?:'d| would) be (?:happy|glad|more than happy) to|(?:'m| am) (?:happy|glad) to)|happy to|glad to|more than happy to|let me)\\s+(?:also\\s+|definitely\\s+|gladly\\s+|totally\\s+|happily\\s+)?";
/** A referral offered or made. */
const OFFER_REFER = new RegExp(
  `\\b(${OFFERER}(refer|${PASS_ALONG}|pass (it|this|that|these|them|your \\w+) (on )?to|put in a (good )?word|forward (your|it|this|them)|send (it|your resume)|pass (your|it along|along)|flag (you|your)|submit (you|your|a referral)|put (your name|your resume|your application) (in|forward|through|up)|put you forward|pass this along)|i (passed|forwarded|sent|submitted) your (resume|info|name|application)|forwarded your (resume|info|application)|(just )?submitted (a|my) referral|referred you|put in a (good )?word|${PASS_ALONG})\\b`,
  'i',
);
/** An intro offered for later ("I can introduce you", "let me know if you'd like an intro"). */
const OFFER_INTRO = new RegExp(
  `\\b(${OFFERER}(intro|introduce|connect you|put you in touch|make (an|that|the|a few|some) intros?|do an intro)|(want|like|need) an? intro|intro(duction)? to (anyone|someone|my|our|a few)|connect you (with|two)|put you in touch)\\b`,
  'i',
);
/** A question about the student or the past ("which Sarah referred you?"), where an offer word is not an offer. */
const ASKS_ABOUT =
  /^(?:sorry,?\s+|so,?\s+|and\s+|hmm,?\s+)?(which|who|what|when|where|did|was|were|has|have|how)\b(?![^?]*\b(i|me) (to )?(refer|intro|introduce|connect)\b)/i;
const RESCHEDULE =
  /\b(resched\w*|push (it|this|our|us|things|back)|push to|move (it|this|our|things)|something came up|(no longer|doesn'?t|does not|won'?t) work (for me )?any ?more|(can'?t|cannot) make it [a-z]+ any ?more|need to (change|move|shift|bump|cancel)|have to (cancel|move)|different (time|day)|bump (it|this|our)|rain ?check|(can'?t|cannot) make (it|that|our)|conflict|(won'?t|will not|can'?t|cannot|not) (be able to )?make (it|that|our|the (call|meeting|chat)|(mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|today|tonight)|missed (our|the|my|today'?s) (call|meeting|chat|zoom|coffee)|(can|could|shall|should) we (try|do (it|this)) again|(find|pick|set|grab|schedule|look for|suggest|propose) (another|a new|a different|a better) (time|day|slot))\b/i;
/** They moved the meeting themselves: the new time is already on the calendar, so it is booked, not offered. */
const MOVED_INVITE =
  /\b(i'?ve |i |just )?(moved|updated|shifted|rescheduled|changed|pushed)\s+(our|the|my)\s+(calendar\s+)?(invite|invitation|meeting|event|call)\b/i;
const DEFER =
  /\b((can'?t|cannot|won'?t be able to) (do|make) (it )?(this|that) week|(this|next) week (is|doesn'?t|won'?t|does not)|week after|after (the|my) (holidays|break|trip|conference))\b/i;
const CONFIRM =
  /\b(confirmed|see you (then|on|soon|there|tomorrow|next|(mon|tues|wednes|thurs|fri|satur|sun)day|mon|tue|tues|wed|thu|thur|thurs|fri)|talk (to you )?(then|soon|tomorrow|on (mon|tues|wednes|thurs|fri|satur|sun)day|(mon|tues|wednes|thurs|fri|satur|sun)day)|sounds good,? (see|talk)|(sent|accepted|got) (you )?(the|a|an|your) (calendar )?invite|invite sent|(just )?(sent|accepted) (the|your|an|it) ?(invite|invitation)|accepted the (invite|invitation|meeting)|invite accepted|booked (it|us|you|the (time|room|slot|call))|(you'?re|we'?re|it'?s|all) (booked|set)|locked in|(?<!(if|whether) )(that|this) works( for me)?(?! for you)|(?<!(if|whether) [a-z]+ )works (for me|great|perfectly)|(it'?s|that'?s) on (my|the) calendar|added (it )?to my calendar|(here'?s|here is|i'?ll send) the (zoom|meet|teams|google meet|video|dial-in|call) (link|info|details)|zoom link|meet link|(i'?ll|i will|i'?m going to|let me) send (you |over )?(a|an|the) (google meet |zoom |calendar |teams |video )?invite|perfect,? (talk|see|thanks))\b/i;
/** "Looking forward to it": a confirmation only when nothing in the message is still looking for a time. */
const WEAK_CONFIRM = /\blooking forward to (speaking|chatting|our (call|chat|conversation)|it|talking)\b/i;
/** Still looking for a time: "help us find a time", "to find a slot", "set up a time". */
const FIND_TIME =
  /\b(find|set up|schedule|pick|figure out|nail down|sort out|book) (a|some|the|a good) (time|slot|date)\b|\bhelp (us )?(find|schedule|set up|coordinate|book)\b/i;
const SCHED_CUE =
  /\b(does .{1,40} work|free (on|at|this|next)|available (on|at|this|next)|(do you have|are you|would you be|is there) (anything|any ?time|time|a (slot|window)|something|an opening|free|available|around|open)( free| open| available)?( on| later| earlier)?( this| next)? ((mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow)|here are (a few|some) times|my availability|pick a (time|slot)|grab (a|any) (time|slot)|calendly|cal\.com|booking link|how about|what about (mon|tue|wed|thu|fri)|would (any of )?(these|those|the following) (times )?work)\b/i;
/** A question that is about when to meet, or a check ("Still useful?"), rather than a question for the student. */
const SCHEDULING_QUESTION =
  /\b(does|do|would|will|could|can|might) [^?]{0,40}\b(work|suit)( for (you|u))?\s*\?|\b(free|available|open) (on|at|this|next|then|that|[a-z]+day)\b|\bwhat (time|day)s?\b|\bwhich (time|day|slot)s?\b|\bhow about\b|\bwhat about\b|\byour (schedule|calendar|availability)\b|\bwhen (works|is good|is best|are you free)\b/i;
const CHECK_QUESTION =
  /^(still (useful|helpful|interested)|make sense|sound good|sounds good|ok|okay|right|deal)\?$/i;
const ASK_OF_USER =
  /\b(could you|can you|please send|send (me|over)|would you mind|let me know (which|what|your)|what (teams|roles|areas)|share your resume)\b/i;
const INBOUND_THANKS =
  /\b(thank(s| you)( so much| again| a lot)? for (your time|the (great |lovely |nice |helpful )?(chat|call|conversation|time)|taking the time|chatting|talking|meeting|speaking)|(great|nice|lovely|good) (chatting|talking|speaking|meeting|to (meet|chat|talk|connect)) (with )?you|(a )?pleasure (meeting|chatting|talking|speaking)( with)? you|(really )?enjoyed (our|the) (chat|conversation|call|coffee)|thank(s| you)( so much| again| a lot)? for (the|your) (follow[- ]up|thank[- ]you|thank you) (note|message|email|e-mail))\b/i;
const OUTBOUND_THANKS =
  /\b(thank(s| you)( so much| again| a lot| a ton)*( for| for the| for your)? ?(great |wonderful |helpful |thoughtful |lovely )?(time|chat|call|conversation|advice|insights?|meeting|talking|chatting|speaking|help|perspective|coffee|lunch)|thank(s| you)( so much| again)* for (taking the time|making time|meeting with me|hopping on)|(great|wonderful|lovely|nice) (chatting|talking|speaking|to (meet|chat|talk)) with you|really (enjoyed|appreciated?) (our|the|your|you) ?(chat|conversation|call|time|advice|insights?|sharing|taking)|i really enjoyed (our|the) (chat|conversation|call))\b/i;
/** A gratitude word anywhere; used by ingest for a note sent right after a completed chat. */
export const GRATITUDE = /\b(thank(s| you)|grateful|appreciate[ds]?)\b/i;

const MONTH_NAMES = [
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
const SEASON_MONTH: Record<string, number> = { spring: 3, summer: 6, fall: 9, autumn: 9, winter: 12 };

/**
 * When a soft "not now" says to try again later ("ping me again in January", "maybe in the new year", "after the
 * holidays", "in a few weeks", "in Q1"), the first day it is fine to follow up, as YYYY-MM-DD in the student's zone.
 * The when of an explicit invitation ("busy until our launch in November. Ping me in December?") wins over any
 * other date in the message.
 */
export function followUpDate(text: string, reference: Date, timeZone?: string): string | undefined {
  const today = extractFirstDate('today', reference, timeZone);
  if (!today) return undefined;
  const invite = LATER_INVITE.exec(text);
  return (
    (invite ? laterDate(text.slice(invite.index).split(/[.?!\n]/)[0]!, today) : undefined) ??
    laterDate(text, today)
  );
}

function laterDate(text: string, today: string): string | undefined {
  const t = text.toLowerCase();
  const [y, m] = today.split('-').map(Number) as [number, number, number];
  const firstOf = (year: number, month: number) => {
    const yy = year + Math.floor((month - 1) / 12);
    const mm = ((month - 1) % 12) + 1;
    return `${yy}-${String(mm).padStart(2, '0')}-01`;
  };
  const after = (n: number) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  /** the first of a month-of-year still ahead: this year when it is later than now, otherwise next year */
  const ahead = (mo: number) => firstOf(mo > m ? y : y + 1, mo);
  const cue =
    '(?:in|after|around|by|until|come|early|mid|late|later in|sometime in|next)\\s+(?:the\\s+)?(?:early\\s+|mid[- ]?|late\\s+)?';
  const month = new RegExp(`${cue}(${MONTH_NAMES.join('|')})\\b`).exec(t);
  if (month) return ahead(MONTH_NAMES.indexOf(month[1]!) + 1);
  if (/\b(new year|after the (holidays|break)|next year)\b/.test(t)) return firstOf(y + 1, 1);
  // a quarter: "in Q1" is its first month, "after Q1" the month after it ends
  const quarter = /\b(after\s+|end of\s+)?q([1-4])\b/.exec(t);
  if (quarter) return ahead(quarter[1] ? 3 * Number(quarter[2]) + 1 : 3 * Number(quarter[2]) - 2);
  const season = new RegExp(`${cue}(spring|summer|fall|autumn|winter)\\b`).exec(t);
  if (season) return ahead(SEASON_MONTH[season[1]!]!);
  if (/\bnext (month|semester)\b/.test(t)) return firstOf(y, m + 1);
  if (/\bnext quarter\b|\b(a few|a couple( of)?|couple|few) months\b/.test(t)) return firstOf(y, m + 3);
  if (/\b(a few|a couple( of)?|couple|few|several) weeks\b/.test(t)) return after(21);
  if (/\bnext week\b/.test(t)) return after(7);
  return undefined;
}

/** A vacation responder: an out-of-office message whose first line reads like a template. */
export function isAutoReplyBody(body: string): boolean {
  return OOO.test(body) && AUTO_REPLY_OPENER.test(body.trim());
}

export interface SignalOptions {
  /** the student's IANA zone; times without a stated zone resolve in it */
  timeZone?: string;
  /**
   * The chat is waiting on the person's answer to the student's ask (outreach sent, replied, no response). Only then
   * does a bare "best of luck" read as a no; on a nurturing or scheduled chat it is a friendly close.
   */
  awaitingAnswer?: boolean;
}

function returnDate(text: string, reference: Date, timeZone?: string): string | undefined {
  RETURN_PHRASE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RETURN_PHRASE.exec(text))) {
    const d = extractFirstDate(m[1]!, reference, timeZone);
    if (d) return d;
  }
  // "traveling this week" / "out next week" with no date: back the Monday after
  const week = /\b(this|the rest of the|next) week\b/i.exec(text);
  if (week) {
    const monday = extractFirstDate('next monday', reference, timeZone);
    if (!monday) return undefined;
    if (week[1]!.toLowerCase() !== 'next') return monday;
    const d = new Date(`${monday}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  }
  return undefined;
}

/** Out-of-office text (auto-reply or hand-typed) and the return date (YYYY-MM-DD) when one is stated. */
export function detectOutOfOffice(
  body: string,
  reference: Date,
  opts: SignalOptions = {},
): { isOutOfOffice: boolean; returnDate?: string } {
  if (!OOO.test(body)) return { isOutOfOffice: false };
  return { isOutOfOffice: true, returnDate: returnDate(body, reference, opts.timeZone) };
}

// ---- stance ----------------------------------------------------------------------------------------------------

interface Stance {
  yes: number;
  /** a strong yes to a chat with the sender, or a scheduling ask */
  yesToChat: boolean;
  schedAsk: boolean;
  hardNo: number;
  notNow: number;
}

const SHORT_SCOPE =
  /\b(this|next) week\b|\b(today|tomorrow|tonight)\b|\b(until|through|thru|till) (mon|tues|wednes|thurs|fri|satur|sun)day\b/i;

function clauseStance(clause: string, noCallCounts: boolean): Omit<Stance, 'yesToChat' | 'schedAsk'> {
  const forYes = clause.replace(NOT_A_YES, ' ');
  const chat = YES_CHAT.test(forYes);
  const ask = anyOf(SCHED_ASK, clause);
  const yes = (chat ? 3 : 0) + (ask ? 2 : 0) + (!chat && YES_WEAK.test(forYes) ? 1 : 0);
  const no = anyOf(HARD_NO, clause) || refusingPass(clause) || BARE_NO.test(clause);
  // a no limited to now ("I'll pass for now", "not taking mentees this year") is a not-now
  const scoped = no && NOW_SCOPE.test(clause);
  const hardNo = (no && !scoped ? 3 : 0) + (noCallCounts && anyOf(NO_CALL, clause) ? 2 : 0);
  // busy for a few days ("slammed this week", "swamped through Wednesday") is a scheduling note, not a not-now
  const notNow = scoped ? 2 : anyOf(NOT_NOW, clause) ? (SHORT_SCOPE.test(clause) ? 1 : 2) : 0;
  return { yes, hardNo, notNow };
}

/**
 * Yes, no and not-now weights over the whole message. Within a sentence, a clause answered the other way by a later
 * contrast clause counts half: "I'd love to, but I'm swamped this quarter" is a not-now, "I'm swamped this week, but
 * happy to chat next week" a yes.
 */
function stanceOf(sentences: Sentence[], noCallCounts: boolean): Stance {
  const s: Stance = { yes: 0, yesToChat: false, schedAsk: false, hardNo: 0, notNow: 0 };
  for (const sent of sentences) {
    const parts = sent.clauses.map((c) => clauseStance(c, noCallCounts));
    parts.forEach((p, i) => {
      const later = parts.slice(i + 1);
      const answeredNo = later.some((q) => q.hardNo || q.notNow);
      const answeredYes = later.some((q) => q.yes);
      s.yes += answeredNo ? p.yes / 2 : p.yes;
      s.hardNo += answeredYes ? p.hardNo / 2 : p.hardNo;
      s.notNow += answeredYes ? p.notNow / 2 : p.notNow;
    });
    const forYes = sent.text.replace(NOT_A_YES, ' ');
    if (YES_CHAT.test(forYes)) s.yesToChat = true;
    if (anyOf(SCHED_ASK, sent.text)) s.schedAsk = true;
  }
  return s;
}

/**
 * Classify one message. Inbound decision order:
 *   1. out of office (a vacation responder always; a hand-typed one unless a time is offered)
 *   2. a redirect to someone else (an intro; `handoff` unless the sender also says yes to a chat of their own, or
 *      asks for times, and nothing sends the student away from them)
 *   3. reschedule or counter-proposal (a proposal when it names a new time); a vague "after the holidays" from
 *      someone who is not-now-ing is a soft decline instead
 *   4. no to a call but yes to email: a question with `prefersEmail`
 *   4b. the sender's assistant added to find a time, no time named yet: a yes
 *   5. confirmation (a proposal when it also asks about a new time); a closing "looking forward to it" only when
 *      nothing still looks for a time
 *   6. proposal (times, a booking link, "does Thursday work", "anything Friday morning?"), unless it is a hard no
 *      without a time
 *   7. hard decline (`decline: 'hard'`) when the no outweighs any yes and nothing counters it; a no limited to now,
 *      or followed by an invitation to try later, is a not-now instead
 *   8. referral offer, then intro offer (`handoff` when someone is introduced or added, or the sender points away
 *      from themselves, and the sender gave no yes and asked for no times)
 *   9. only the sender's assistant added: a yes
 *  10. thank-you after a conversation
 *  11. soft decline (`decline: 'soft'`, with `followUpAfter` when they say when); a bare "best of luck" only on an
 *      ask still waiting for an answer, or next to a refusal
 *  12. a question for the student (unless the only questions are about when to meet), then a yes, then a request,
 *      then neutral
 */
export function heuristicSignal(
  body: string,
  direction: 'inbound' | 'outbound',
  reference: Date,
  opts: SignalOptions = {},
): { signal: ReplySignal; confidence: number; extraction: MessageExtraction } {
  const t = body.toLowerCase();
  const times = extractProposedTimes(body, reference, opts.timeZone);
  const extraction: MessageExtraction = {
    proposedTimes: times,
    asksOfUser: [],
    offers: [],
    factsAboutSender: [],
    sentiment: 'neutral',
  };
  const sentences = sentencesOf(body);
  const lines = sentences.map((s) => s.text);
  const isOffer = (s: Sentence) =>
    (OFFER_REFER.test(s.text) || OFFER_INTRO.test(s.text) || anyOf(ADDED, s.text)) &&
    !isSchedulerLine(s.text) &&
    !(s.question && ASKS_ABOUT.test(s.text));
  for (const s of sentences) {
    if (s.text.length >= 220) continue;
    // a scheduling prompt ("let me know what works") is not a request for something the student must send
    if (ASK_OF_USER.test(s.text) && !anyOf(SCHED_ASK, s.text)) extraction.asksOfUser.push(s.text);
    if (isOffer(s)) extraction.offers.push(s.text);
  }
  // "I'm cc'ing my EA Jordan to set up time": the sender's scheduler, read as a yes; everything else stays
  const schedulerAdded = lines.some(isSchedulerLine);
  const rest = schedulerAdded ? sentences.filter((s) => !isSchedulerLine(s.text)) : sentences;
  const restBody = rest.map((s) => s.text).join('\n');
  const warm = (signal: ReplySignal, confidence: number) => {
    extraction.sentiment = 'warm';
    return { signal, confidence, extraction };
  };
  const decline = (kind: 'hard' | 'soft', confidence: number) => {
    extraction.sentiment = 'cool';
    extraction.decline = kind;
    if (kind === 'soft') {
      const later = followUpDate(body, reference, opts.timeZone);
      if (later) extraction.followUpAfter = later;
    }
    return { signal: 'reply_decline' as const, confidence, extraction };
  };

  if (direction === 'outbound') {
    const explicitAsk =
      /\b(would .{1,40} work|does .{1,40} work|how about|are you free|what (time|day)s? work|here are a few times|my availability)\b/.test(
        t,
      );
    // "Perfect, see you Tuesday at 4pm. Thanks again for making time." accepts a time; it is not the thank-you after
    const acceptsTime = times.length > 0 && (CONFIRM.test(body) || WEAK_CONFIRM.test(body));
    if (OUTBOUND_THANKS.test(body) && !explicitAsk && !acceptsTime)
      return { signal: 'thank_you', confidence: 0.9, extraction };
    if (
      times.length ||
      /\b(would (any of )?(these|those|the following) (times|work)|does .* work for you|here are a few times|my availability)\b/.test(
        t,
      )
    )
      return { signal: 'scheduling_proposal', confidence: 0.8, extraction };
    return { signal: 'other', confidence: 0.6, extraction };
  }

  const emailOk = anyOf(EMAIL_OK, body);
  const noCall = anyOf(NO_CALL, body);
  const stance = stanceOf(rest, !emailOk);
  // "Pass for now, but try me again in Q1": an invitation to come back makes any no a not-now
  if (LATER_INVITE.test(body) && stance.hardNo > 0) {
    stance.notNow += stance.hardNo;
    stance.hardNo = 0;
  }
  const yes = stance.yes > 0;
  const schedulingCue = times.length > 0 || SCHED_CUE.test(body);
  const countered = COUNTER.test(body);

  // 1. out of office, unless the message goes on to offer a time ("on vacation next week, but how about Tuesday?")
  if (OOO.test(body) && (isAutoReplyBody(body) || (!times.length && !countered && !SCHED_CUE.test(body)))) {
    const rd = returnDate(body, reference, opts.timeZone);
    if (rd) extraction.returnDate = rd;
    return { signal: 'out_of_office', confidence: 0.9, extraction };
  }

  // 2. a redirect to someone else is an intro, not a decline; with a yes to a chat of their own ("Happy to chat next
  // week! You should talk to Ana too", "Send me a few times, and I'd also recommend Ben") the next step is still with
  // the sender
  const away = anyOf(AWAY, restBody);
  const target = anyOf(TARGET, restBody) || anyOf(ADDED, restBody);
  const recommend = anyOf(RECOMMEND, restBody);
  if (target && (away || recommend) && !schedulingCue) {
    if (!extraction.offers.length)
      extraction.offers.push(lines.find((l) => anyOf(AWAY, l) || anyOf(RECOMMEND, l)) ?? body.slice(0, 200));
    if (!(stance.yesToChat || stance.schedAsk) || away) {
      extraction.handoff = true;
      return warm('intro_offer', 0.75);
    }
    // the yes is as clear as any other: the chat moves to replied and the student proposes times to the sender
    return warm('intro_offer', 0.8);
  }

  // 3. reschedule or counter-proposal: with a new time it is a proposal to confirm, without one a reschedule
  const vagueLater = DEFER.test(body) && !RESCHEDULE.test(body);
  if (RESCHEDULE.test(body) || (DEFER.test(body) && !yes)) {
    if (times.length && MOVED_INVITE.test(body)) return warm('scheduling_confirmation', 0.8);
    if (times.length) return warm('scheduling_proposal', 0.85);
    if (!(vagueLater && stance.notNow > stance.yes))
      return { signal: 'reschedule', confidence: 0.75, extraction };
  }
  if (DEFER.test(body) && yes && !times.length) return warm('reply_positive', 0.75);

  // 4. a no to a call that offers email instead: answer by email, never propose times
  if (noCall && emailOk) {
    extraction.prefersEmail = true;
    return warm('question', 0.7);
  }

  // the sender's assistant added to find a time, with no time named yet: a yes, and the times go to the thread
  if (schedulerAdded && !times.length) return warm('reply_positive', 0.8);

  // 5. "Monday is booked, but Tues 10am works?" offers a time; "Confirmed for Thursday at 2pm" confirms one; a
  // closing "looking forward to it" confirms only when nothing is still looking for a time
  const weakConfirm = WEAK_CONFIRM.test(body) && !stance.schedAsk && !FIND_TIME.test(body) && !schedulerAdded;
  if (CONFIRM.test(body) || weakConfirm) {
    if (times.length && (body.includes('?') || SCHED_CUE.test(body))) return warm('scheduling_proposal', 0.8);
    return warm('scheduling_confirmation', 0.8);
  }

  // 6, 7. a proposal unless it is a plain no; a no that outweighs any yes and offers nothing in its place
  const hardNo = stance.hardNo > 0 && stance.hardNo >= stance.yes && !countered;
  if (schedulingCue) {
    if (hardNo && !times.length) return decline('hard', 0.75);
    return warm('scheduling_proposal', times.length ? 0.85 : 0.7);
  }
  if (hardNo) return decline('hard', 0.75);

  // 8. offers: a referral, then an intro (a hand-off when someone is introduced or added and there is no yes)
  if (extraction.offers.some((o) => OFFER_REFER.test(o))) return warm('referral_offer', 0.8);
  const introduced = anyOf(INTRO_ACT, restBody);
  if (extraction.offers.length || introduced) {
    // a hand-off when someone is introduced or added, or the sender points away from themselves, with no yes
    if (!stance.yesToChat && !stance.schedAsk && (introduced || away || anyOf(ADDED, restBody)))
      extraction.handoff = true;
    return warm('intro_offer', 0.8);
  }

  // 9. only the sender's assistant was added, to find a time: a yes, and the times go to the thread
  if (schedulerAdded) return warm('reply_positive', 0.8);

  // 10. a thank-you after a conversation ("thanks for the chat today"), never "thanks for reaching out"
  const notNow = stance.notNow > 0 && stance.notNow > stance.yes && !countered;
  const infoQuestion = sentences.some(
    (s) =>
      s.question &&
      !CHECK_QUESTION.test(s.text) &&
      !SCHEDULING_QUESTION.test(s.text) &&
      !anyOf(SCHED_ASK, s.text),
  );
  const asksQuestion = sentences.some((s) => s.question);
  if (!notNow && INBOUND_THANKS.test(body) && !yes && !asksQuestion) return warm('thank_you', 0.7);

  // 11. not now; a bare "best of luck" closes the door only on an ask still waiting for an answer, or next to a no
  const partingNo =
    PARTING.test(body) &&
    !yes &&
    !WARM_CLOSE.test(body) &&
    !asksQuestion &&
    (opts.awaitingAnswer === true || DECLINE_CUE.test(body.replace(NOT_A_REFUSAL, ' ')));
  if (notNow || partingNo || (away && !target && !yes)) return decline('soft', 0.6);

  // 12. a question for the student beats a plain yes, unless they also asked for times
  if (infoQuestion && !stance.schedAsk) return { signal: 'question', confidence: 0.6, extraction };
  if (yes) return warm('reply_positive', 0.82);
  if (asksQuestion || extraction.asksOfUser.length)
    return { signal: 'question', confidence: 0.6, extraction };
  return { signal: 'reply_neutral', confidence: 0.55, extraction };
}
