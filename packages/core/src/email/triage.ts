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

const OOO =
  /\b(out of (the )?office|on (vacation|leave|pto|parental leave|maternity leave|paternity leave|holiday|sabbatical)|away (until|from|through)|auto(-| )?reply|automatic reply|(limited|intermittent|no|minimal) (access to )?(my )?e-?mail|currently (traveling|travelling|away|out)|(will|i'?ll) (get back to you|respond|reply)( to (you|your (e-?mail|message|note)))?( as soon as possible)? (when|once|upon|after) (i|my) return|back in the office|ooo)\b/i;
/** How a vacation responder opens: the first line reads like a template, not like a person answering. */
const AUTO_REPLY_OPENER =
  /^(?:(?:hi|hello|dear)[^\n]{0,30}\n+)?\s*(thank(s| you) for your (e-?mail|message|note|inquiry)|i am (currently )?(out of the office|away from (the|my) (office|desk)|on (annual |parental |maternity |paternity )?leave|ooo\b)|i will be (out of the office|away from)|automatic reply|this is an automat)/i;
const RETURN_PHRASE =
  /\b(?:until|through|thru|till|returning(?: to the office)?(?: on)?|return(?: to the office)? on|back(?: in the office| in office| at my desk| online)?(?: on)?)\s+([^\n]{0,60})/gi;
/** "I don't do coffee chats, but happy to answer questions over email": a no to a call, a yes to email. */
const NO_CALLS =
  /\b((don'?t|do not|can'?t|cannot|won'?t be able to|am not able to|'m not able to|unable to|no longer) (really )?(do|take|make time for|have time for|hop on|get on|jump on|schedule) (any )?(more )?(coffee chats?|calls?|phone calls?|video calls?|meetings?|zoom( calls)?|informational( interviews?)?)|(not|no longer) (doing|taking) (coffee chats|calls|meetings|informational)|(rather|easier) (than|to skip) (a|the) (call|chat|meeting)|(going to|gonna|have to|need to|will|'ll|'d|would|should) pass on (a|the|any|doing a|hopping on a|getting on a) (live |phone |video |zoom )?(call|chat|meeting|coffee( chat)?)|(i'?d|i would) (rather|prefer) (not|to skip|to pass on) (to )?(do|have|hop on|jump on|get on|take|schedule|set up)? ?(a|the|any) (live |phone |video |zoom )?(call|chat|meeting|coffee( chat)?)|(skip|forgo) (a|the) (call|meeting|zoom))\b/i;
const EMAIL_OK =
  /\b((answer|take|field|respond to|help with) (a few |a couple( of)? |some |any |your )?questions? (over|via|by|through|on) e-?mail|(over|via|by) e-?mail (instead|is (easier|better|best))|e-?mail (works|is) (better|easier|best)|(e-?mail|send) (me )?(over |along )?(your|a few|a couple( of)?|any|some) questions|feel free to (e-?mail|send|shoot|write|drop) (me )?(over |along )?(me )?(your |any |a few |some )?questions|(happy|glad) to (help|answer)[^.?!]{0,40}\b(over|via|by|through) e-?mail)\b/i;
/** Unambiguous "no". Redirects to a colleague are handled first and are intros, not declines. */
const HARD_DECLINE =
  /\b((am|'m) not (able|in a position) to (chat|talk|meet|take|help|connect|do)|not able to take (any )?(calls|meetings|chats)|(not|no longer) taking (any )?(calls|chats|meetings|coffee chats|informational)|i'?m going to (have to )?pass(?! (it|this|that|these|them|your|along|on your))|i('ll| will) (have to )?pass(?! (it|this|that|these|them|your|along|on your|the|her|his|my))|have to (pass|decline)|(please )?(don'?t|do not) (contact|email) me|remove me|unsubscribe me|not interested|(don'?t|do not) have (the )?(time|capacity) (to|for) (calls|chats|this|that|meetings)|can'?t help|unable to (help|meet|chat|take)|not (a|the) (right|good) fit)\b/i;
const SOFT_DECLINE =
  /\b(slammed|swamped|underwater|crazy busy|super busy|heads[- ]down|(don'?t|do not) (really |currently |actually |quite )?have (much |the |any )?(bandwidth|capacity)|(don'?t|do not) (really |currently )?have (the |much )?time (for|to take) (calls|chats|meetings|coffee)|no bandwidth|stretched (too )?thin|can'?t (really )?take (on )?(any )?(more|new) (calls|chats|meetings)|maybe (in the |after the )?(new year|next (month|quarter|semester|year)|spring|summer|fall|winter|january)|circle back (in|after|later)|ping me (again )?(in|after|later)|reach out again (in|after)|not a (great|good) time( right now)?|(no longer|don'?t) work (at|for)|not (at|with) [a-z]+ any ?more|left (the company|[a-z]+ (last|in|a few))|no longer (at|with))\b/i;
/** A sign-off that closes the door when nothing in the message opens one. */
const PARTING = /\b(best of luck|good luck with (the|your)|wish(ing)? you (the best|luck|all the best))\b/i;
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
const REDIRECT =
  /\b(not the (right|best) (person|contact)|(you should|you might want to|you'?d be better off|i'?d (recommend|suggest)|try) (talk(ing)? to|reach(ing)? out to|contact(ing)?|connect(ing)? with|email(ing)?|ask(ing)?)|(a )?better (person|contact|fit) (to|for|would be)|(colleague|teammate|coworker|someone on (my|our) team)\b[^.?!]{0,40}\b(would be|is|might be|could)\b)/i;
/** A redirect that sends the student elsewhere instead of (not as well as) a chat with the sender. */
const AWAY_REDIRECT =
  /\b(not the (right|best) (person|contact)|(a )?better (person|contact|fit) (to|for|would be)|(you should|you'?d be better off) (talk(ing)? to|reach(ing)? out to|contact(ing)?|email(ing)?))/i;
/** The sender says yes to a chat with the student themselves ("Happy to chat next week", "Let's find a time"). */
const YES_TO_CHAT =
  /\b((happy|glad|delighted|would love|'d love|love|more than happy|'d be happy|be happy) to (chat|talk|meet|speak|connect|hop on|jump on|get on|grab|find a time|set (something|a time|up a (call|time|chat))|do a (call|chat|quick call))|let'?s (chat|talk|meet|find a time|set (something|a time) up|grab|connect|do it)|count me in)\b/i;
/** A cue that someone was added to the thread. */
const ADDED_CUE = /\b(looping in|loop(ed)? in|cc'?(ing|d)|copying|adding)\b/i;
/** Who handles the sender's calendar: an assistant or a scheduler of their own. */
const SCHEDULER_ROLE =
  /\bmy\s+(executive\s+|administrative\s+)?(ea|assistant|admin|scheduler|chief of staff)\b/i;
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
const RESCHEDULE =
  /\b(resched\w*|push (it|this|our|us|things|back)|push to|move (it|this|our|things)|something came up|(no longer|doesn'?t|does not|won'?t) work (for me )?any ?more|(can'?t|cannot) make it [a-z]+ any ?more|need to (change|move|shift|bump|cancel)|have to (cancel|move)|different (time|day)|bump (it|this|our)|rain ?check|(can'?t|cannot) make (it|that|our)|conflict)\b/i;
/** They moved the meeting themselves: the new time is already on the calendar, so it is booked, not offered. */
const MOVED_INVITE =
  /\b(i'?ve |i |just )?(moved|updated|shifted|rescheduled|changed|pushed)\s+(our|the|my)\s+(calendar\s+)?(invite|invitation|meeting|event|call)\b/i;
const DEFER =
  /\b((can'?t|cannot|won'?t be able to) (do|make) (it )?(this|that) week|(this|next) week (is|doesn'?t|won'?t|does not)|week after|after (the|my) (holidays|break|trip|conference))\b/i;
const COUNTER =
  /\b(but|however|instead|though)\b[^.?!]{0,80}\b(happy|could|can|works?|free|available|how about|what about|week after|open)\b/i;
const CONFIRM =
  /\b(confirmed|see you (then|on|soon|there|tomorrow|next|(mon|tues|wednes|thurs|fri|satur|sun)day)|talk (to you )?(then|soon|tomorrow|on (mon|tues|wednes|thurs|fri|satur|sun)day|(mon|tues|wednes|thurs|fri|satur|sun)day)|sounds good,? (see|talk)|calendar invite|sent (you )?(an|the|a calendar|a) invite|(just )?(sent|accepted) (the|your|an|it) ?(invite|invitation)|accepted the (invite|invitation|meeting)|invite accepted|booked (it|us|you|the (time|room|slot|call))|(you'?re|we'?re|it'?s|all) (booked|set)|locked in|(?<!(if|whether) )(that|this) works( for me)?(?! for you)|(?<!(if|whether) [a-z]+ )works (for me|great|perfectly)|(it'?s|that'?s) on (my|the) calendar|added (it )?to my calendar|(here'?s|here is|i'?ll send) the (zoom|meet|teams|google meet|video|dial-in|call) (link|info|details)|zoom link|meet link|(i'?ll|i will|i'?m going to|let me) send (you |over )?(a|an|the) (google meet |zoom |calendar |teams |video )?invite|looking forward to (speaking|chatting|our (call|chat|conversation)|it|talking)|perfect,? (talk|see|thanks))\b/i;
const SCHED_CUE =
  /\b(does .{1,40} work|free (on|at|this|next)|available (on|at|this|next)|what (time|day)s? work|here are (a few|some) times|my availability|pick a (time|slot)|grab (a|any) (time|slot)|calendly|cal\.com|booking link|how about|what about (mon|tue|wed|thu|fri)|would (any of )?(these|those|the following) (times )?work)\b/i;
const SCHED_ASK =
  /\b(let me know (what|which) (time|day)s? (works?|are best)|let me know what works|what works (for you|best)|send (me |over )?(a few|some|your) (times|slots|availability)|what times work|your availability|when (are|would) you (be )?free|pick a (time|slot))\b/i;
const POSITIVE =
  /\b(happy to|would love to|glad to|sure|absolutely|of course|sounds (great|good)|let'?s (do it|chat|find a time|connect|set (something|a time) up|talk)|i'?d be (happy|glad|delighted) to|i'?m (happy|glad) to|definitely|count me in|more than happy|be happy to|love to (chat|help|connect))\b/i;
/** "pass it along", "pass this on", "pass on your resume": a referral; "pass on a call" is not. */
const PASS_ALONG =
  'pass (?:(?:it|this|that|these|them|your resume|your info|your name|your note|your email|the resume|the note) )?along|pass (?:it|this|that|these|them|your resume|your info|your name|your note|your email|the resume|the note) on|pass on your';
const OFFER_I = new RegExp(
  `\\b(happy to (refer|intro|introduce|connect you|put you in touch|${PASS_ALONG}|make an intro|do an intro|forward your)|i can (refer|intro|introduce|connect you|put you in touch|${PASS_ALONG}|forward|send (it|your resume))|i'?ll (refer|intro|introduce|connect you|put in a (good )?word|forward your|${PASS_ALONG}|flag (you|your))|i('ll| will| can) (pass|forward|send) (your|it along|along)|i (passed|forwarded|sent) your (resume|info|name)|(just )?submitted (a|my) referral|referred you|put in a (good )?word|(want|like|need) an? intro|intro(duction)? to (anyone|someone|my|our|a few)|connect you with|put you in touch|looping in|loop(ed)? in|cc'?(ing|d)|copying)\\b`,
  'i',
);
const OFFER_NAME =
  /\b([Ll]ooping in|[Cc]opying|[Aa]dding|CC'?ing|[Cc]c'?ing|CC'?d|[Ii]ntroducing) [A-Z][a-z]+/;
const INTRO_BODY =
  /\b(meet [A-Z][a-z]+|[A-Z][a-z]+, meet [A-Z][a-z]+|I'?d like you to meet|[Cc]onnecting you (with|to)|[Ii]ntroducing (you two|you both|the two of you|you to [A-Z][a-z]+))\b/;
const INBOUND_THANKS =
  /\b(thank(s| you)( so much| again| a lot)? for (your time|the (great |lovely |nice |helpful )?(chat|call|conversation|time)|taking the time|chatting|talking|meeting|speaking)|(great|nice|lovely|good) (chatting|talking|speaking|meeting|to (meet|chat|talk|connect)) (with )?you)\b/i;
const OUTBOUND_THANKS =
  /\b(thank(s| you)( so much| again| a lot| a ton)*( for| for the| for your)? ?(great |wonderful |helpful |thoughtful |lovely )?(time|chat|call|conversation|advice|insights?|meeting|talking|chatting|speaking|help|perspective)|thank(s| you)( so much| again)* for (taking the time|making time|meeting with me|hopping on)|(great|wonderful|lovely|nice) (chatting|talking|speaking|to (meet|chat|talk)) with you|really (enjoyed|appreciated?) (our|the|your|you) ?(chat|conversation|call|time|advice|insights?|sharing|taking)|i really enjoyed (our|the) (chat|conversation|call))\b/i;
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
 * holidays", "in a few weeks"), the first day it is fine to follow up, as YYYY-MM-DD in the student's zone.
 */
export function followUpDate(text: string, reference: Date, timeZone?: string): string | undefined {
  const t = text.toLowerCase();
  const today = extractFirstDate('today', reference, timeZone);
  if (!today) return undefined;
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
  const cue =
    '(?:in|after|around|by|until|come|early|mid|later in|sometime in)\\s+(?:the\\s+|early\\s+|mid[- ]?|late\\s+)?';
  const month = new RegExp(`${cue}(${MONTH_NAMES.join('|')})\\b`).exec(t);
  if (month) {
    const mo = MONTH_NAMES.indexOf(month[1]!) + 1;
    return firstOf(mo > m ? y : y + 1, mo);
  }
  if (/\b(new year|after the (holidays|break)|next year)\b/.test(t)) return firstOf(y + 1, 1);
  const season = new RegExp(`${cue}(spring|summer|fall|autumn|winter)\\b`).exec(t);
  if (season) {
    const mo = SEASON_MONTH[season[1]!]!;
    return firstOf(mo > m ? y : y + 1, mo);
  }
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

/**
 * Classify one message. Inbound order: out of office (a vacation responder always; a hand-typed one unless a time is
 * offered) → redirect to a colleague (an intro) → reschedule or counter-proposal → no-calls-but-email (a question,
 * `prefersEmail`) → confirmation (a proposal when it also asks about a new time) → proposal → hard decline →
 * referral / intro offers (`handoff` when a colleague is named or cc'd) → thank-you after a conversation → soft
 * decline ("slammed this quarter", with `followUpAfter` when they say when; a bare "best of luck" only when nothing
 * in the message is warm) → positive / question / neutral.
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
  const lines = body
    .split(/(?<=[.!?])\s+|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const l of lines) {
    if (l.length >= 220) continue;
    // a scheduling prompt ("let me know what works") is not a request for something the student must send
    if (
      /\b(could you|can you|please send|send (me|over)|would you mind|let me know (which|what|your)|what (teams|roles|areas)|share your resume)\b/i.test(
        l,
      ) &&
      !SCHED_ASK.test(l)
    )
      extraction.asksOfUser.push(l);
    if ((OFFER_I.test(l) || OFFER_NAME.test(l)) && !isSchedulerLine(l)) extraction.offers.push(l);
  }
  // "I'm cc'ing my EA Jordan to set up time": the sender's scheduler, read as a yes; everything else stays
  const schedulerAdded = lines.some(isSchedulerLine);
  const restBody = schedulerAdded ? lines.filter((l) => !isSchedulerLine(l)).join('\n') : body;
  const warm = (signal: ReplySignal, confidence: number) => {
    extraction.sentiment = 'warm';
    return { signal, confidence, extraction };
  };

  if (direction === 'outbound') {
    const explicitAsk =
      /\b(would .{1,40} work|does .{1,40} work|how about|are you free|what (time|day)s? work|here are a few times|my availability)\b/.test(
        t,
      );
    // "Perfect, see you Tuesday at 4pm. Thanks again for making time." accepts a time; it is not the thank-you after
    const acceptsTime = times.length > 0 && CONFIRM.test(body);
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

  const positive = POSITIVE.test(body);
  const schedulingCue = times.length > 0 || SCHED_CUE.test(body);
  // out of office, unless the message goes on to offer a time ("on vacation next week, but how about Tuesday at 2pm?")
  if (
    OOO.test(body) &&
    (isAutoReplyBody(body) || (!times.length && !COUNTER.test(body) && !SCHED_CUE.test(body)))
  ) {
    const rd = returnDate(body, reference, opts.timeZone);
    if (rd) extraction.returnDate = rd;
    return { signal: 'out_of_office', confidence: 0.9, extraction };
  }
  // a redirect to a colleague is an intro, not a decline; with a yes to a chat of their own ("Happy to chat next
  // week. My colleague Ana would be great too") the next step is still with the sender
  const yesToChat = YES_TO_CHAT.test(restBody);
  if (REDIRECT.test(restBody) && !schedulingCue) {
    if (!extraction.offers.length)
      extraction.offers.push(lines.find((l) => REDIRECT.test(l)) ?? body.slice(0, 200));
    if (!yesToChat || AWAY_REDIRECT.test(restBody)) {
      extraction.handoff = true;
      return warm('intro_offer', 0.75);
    }
    // the yes is as clear as any other: the chat moves to replied and the student proposes times to the sender
    return warm('intro_offer', 0.8);
  }
  // reschedule or counter-proposal: with a new time it is a proposal to confirm, without one a reschedule
  if (RESCHEDULE.test(body) || (DEFER.test(body) && !positive)) {
    if (times.length && MOVED_INVITE.test(body)) return warm('scheduling_confirmation', 0.8);
    if (times.length) return warm('scheduling_proposal', 0.85);
    return { signal: 'reschedule', confidence: 0.75, extraction };
  }
  if (DEFER.test(body) && positive) return warm('reply_positive', 0.75);
  // a no to a call that offers email instead: answer by email, never propose times
  if (NO_CALLS.test(body) && EMAIL_OK.test(body)) {
    extraction.prefersEmail = true;
    return warm('question', 0.7);
  }
  // "Monday is booked, but Tues 10am works?" offers a time; "Confirmed for Thursday at 2pm" confirms one
  if (CONFIRM.test(body)) {
    if (times.length && (body.includes('?') || SCHED_CUE.test(body))) return warm('scheduling_proposal', 0.8);
    return warm('scheduling_confirmation', 0.8);
  }
  if (schedulingCue) {
    if (HARD_DECLINE.test(body) && !times.length && !COUNTER.test(body)) {
      extraction.sentiment = 'cool';
      return { signal: 'reply_decline', confidence: 0.75, extraction };
    }
    return warm('scheduling_proposal', times.length ? 0.85 : 0.7);
  }
  if (HARD_DECLINE.test(body) && !COUNTER.test(body)) {
    extraction.sentiment = 'cool';
    return { signal: 'reply_decline', confidence: 0.75, extraction };
  }
  if (extraction.offers.some((o) => /refer|word|forward|resume|pass|submitted|flag/i.test(o)))
    return warm('referral_offer', 0.8);
  if (extraction.offers.length || INTRO_BODY.test(restBody)) {
    // someone else is already on the thread ("Looping in Sam (cc'd)", "Sam, meet Alex"): the next step is with
    // them, unless the sender also said yes to a chat of their own
    if (!yesToChat && (OFFER_NAME.test(restBody) || INTRO_BODY.test(restBody) || ADDED_CUE.test(restBody)))
      extraction.handoff = true;
    return warm('intro_offer', 0.8);
  }
  // only the sender's assistant was added, to find a time: a yes, and the times go to the thread
  if (schedulerAdded) return warm('reply_positive', 0.8);
  const softDecline = SOFT_DECLINE.test(body) && !COUNTER.test(body);
  const endsWithQuestion = /\?\s*$/.test(body.trim());
  // a thank-you after a conversation ("thanks for the chat today"), never "thanks for reaching out"
  if (!softDecline && INBOUND_THANKS.test(body) && !positive && !endsWithQuestion)
    return warm('thank_you', 0.7);
  // a bare "best of luck" closes the door only on an ask still waiting for an answer, or next to a refusal
  const partingNo =
    PARTING.test(body) &&
    !positive &&
    !WARM_CLOSE.test(body) &&
    !SCHED_ASK.test(body) &&
    !/\?/.test(body) &&
    (opts.awaitingAnswer === true || DECLINE_CUE.test(body.replace(NOT_A_REFUSAL, ' ')));
  if (softDecline || partingNo) {
    extraction.sentiment = 'cool';
    const later = followUpDate(body, reference, opts.timeZone);
    if (later) extraction.followUpAfter = later;
    return { signal: 'reply_decline', confidence: 0.6, extraction };
  }
  if (positive && !endsWithQuestion) return warm('reply_positive', 0.82);
  if (endsWithQuestion || extraction.asksOfUser.length)
    return { signal: 'question', confidence: 0.6, extraction };
  if (positive) return warm('reply_positive', 0.7);
  return { signal: 'reply_neutral', confidence: 0.55, extraction };
}
