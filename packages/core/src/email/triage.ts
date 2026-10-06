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
  /\b(coffee( chat)?|informational( interview| call| chat)?|advice|your (path|journey|experience|story|career|background)|how (you|did you) (got|get|ended up|made the (move|switch)|broke) into|introduc(e|es|ed|ing|tion)|intro\b|catch ?up|mentor(ship)?|alum(ni|nus|na)?|referr?al|(hear|learn) (more )?about (your|the|how|what)|\d{1,2}[- ]?min(ute)?s? (of your time|to (hear|chat|learn|talk))|chat (about|re)\b|pick your brain|would love to (hear|learn|chat|connect)|grab (a )?(coffee|call)|sent you an invite|looking forward to (speaking|chatting|our (call|chat|conversation))|thanks( so much| again)? for (your time|chatting|the (chat|call|conversation))|(great|nice|lovely) (chatting|talking|speaking|to (meet|chat|connect)) with you|looping in|loop in|cc'?(ing|d)\b)/gi;
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
  /\b(out of (the )?office|on (vacation|leave|pto|parental leave|maternity leave|paternity leave|holiday|sabbatical)|away (until|from|through)|auto(-| )?reply|automatic reply|(limited|intermittent) (access to )?email|currently (traveling|travelling|away|out)|ooo)\b/i;
const RETURN_PHRASE =
  /\b(?:until|through|thru|till|returning(?: to the office)?(?: on)?|return(?: to the office)? on|back(?: in the office| in office| at my desk| online)?(?: on)?)\s+([^\n]{0,60})/gi;
/** Unambiguous "no". Redirects to a colleague are handled first and are intros, not declines. */
const HARD_DECLINE =
  /\b((am|'m) not (able|in a position) to (chat|talk|meet|take|help|connect|do)|not able to take (any )?(calls|meetings|chats)|(not|no longer) taking (any )?(calls|chats|meetings|coffee chats|informational)|i'?m going to (have to )?pass(?! (it|your|along|on your))|i('ll| will) (have to )?pass(?! (it|your|along|on your|the|her|his|my))|have to (pass|decline)|(please )?(don'?t|do not) (contact|email) me|remove me|unsubscribe me|not interested|(don'?t|do not) have (the )?(time|capacity) (to|for) (calls|chats|this|that|meetings)|can'?t help|unable to (help|meet|chat|take)|not (a|the) (right|good) fit)\b/i;
const SOFT_DECLINE =
  /\b(slammed|swamped|underwater|crazy busy|super busy|heads[- ]down|(don'?t|do not) have (much |the |any )?(bandwidth|capacity)|no bandwidth|maybe (in the |after the )?(new year|next (month|quarter|semester|year)|spring|summer|fall|winter|january)|circle back (in|after|later)|ping me (again )?(in|after|later)|reach out again (in|after)|not a (great|good) time( right now)?|(no longer|don'?t) work (at|for)|not (at|with) [a-z]+ any ?more|left (the company|[a-z]+ (last|in|a few))|no longer (at|with))\b/i;
const REDIRECT =
  /\b(not the (right|best) (person|contact)|(you should|you might want to|you'?d be better off|i'?d (recommend|suggest)|try) (talk(ing)? to|reach(ing)? out to|contact(ing)?|connect(ing)? with|email(ing)?|ask(ing)?)|(a )?better (person|contact|fit) (to|for|would be)|(colleague|teammate|coworker|someone on (my|our) team)\b[^.?!]{0,40}\b(would be|is|might be|could)\b)/i;
const RESCHEDULE =
  /\b(resched\w*|push (it|this|our|us|things|back)|push to|move (it|this|our|things)|something came up|(no longer|doesn'?t|does not|won'?t) work (for me )?any ?more|(can'?t|cannot) make it [a-z]+ any ?more|need to (change|move|shift|bump|cancel)|have to (cancel|move)|different (time|day)|bump (it|this|our)|rain ?check|(can'?t|cannot) make (it|that|our)|conflict)\b/i;
const DEFER =
  /\b((can'?t|cannot|won'?t be able to) (do|make) (it )?(this|that) week|(this|next) week (is|doesn'?t|won'?t|does not)|week after|after (the|my) (holidays|break|trip|conference))\b/i;
const COUNTER =
  /\b(but|however|instead|though)\b[^.?!]{0,80}\b(happy|could|can|works?|free|available|how about|what about|week after|open)\b/i;
const CONFIRM =
  /\b(confirmed|see you (then|on|soon|there|tomorrow|next|(mon|tues|wednes|thurs|fri|satur|sun)day)|talk (to you )?(then|soon|tomorrow|on (mon|tues|wednes|thurs|fri|satur|sun)day|(mon|tues|wednes|thurs|fri|satur|sun)day)|sounds good,? (see|talk)|calendar invite|sent (you )?(an|the|a calendar|a) invite|(just )?(sent|accepted) (the|your|an|it) ?(invite|invitation)|accepted the (invite|invitation|meeting)|invite accepted|booked|locked in|(it'?s|that'?s) on (my|the) calendar|added (it )?to my calendar|(here'?s|here is|i'?ll send) the (zoom|meet|teams|google meet|video|dial-in|call) (link|info|details)|zoom link|meet link|(i'?ll|i will|i'?m going to|let me) send (you |over )?(a|an|the) (google meet |zoom |calendar |teams |video )?invite|looking forward to (speaking|chatting|our (call|chat|conversation)|it|talking)|perfect,? (talk|see|thanks))\b/i;
const SCHED_CUE =
  /\b(does .{1,40} work|free (on|at|this|next)|available (on|at|this|next)|what (time|day)s? work|here are (a few|some) times|my availability|pick a (time|slot)|grab (a|any) (time|slot)|calendly|cal\.com|booking link|how about|what about (mon|tue|wed|thu|fri)|would (any of )?(these|those|the following) (times )?work)\b/i;
const SCHED_ASK =
  /\b(let me know (what|which) (time|day)s? (works?|are best)|let me know what works|what works (for you|best)|send (me |over )?(a few|some|your) (times|slots|availability)|what times work|your availability|when (are|would) you (be )?free|pick a (time|slot))\b/i;
const POSITIVE =
  /\b(happy to|would love to|glad to|sure|absolutely|of course|sounds (great|good)|let'?s (do it|chat|find a time|connect|set (something|a time) up|talk)|i'?d be (happy|glad|delighted) to|i'?m (happy|glad) to|definitely|count me in|more than happy|be happy to|love to (chat|help|connect))\b/i;
const OFFER_I =
  /\b(happy to (refer|intro|introduce|connect you|put you in touch|pass (it |your resume |your info )?(along|on)|make an intro|do an intro|forward your)|i can (refer|intro|introduce|connect you|put you in touch|pass|forward|send (it|your resume))|i'?ll (refer|intro|introduce|connect you|put in a (good )?word|forward your|pass (it |your resume |your info |your name )?(along|on)|flag (you|your))|i('ll| will| can) (pass|forward|send) (your|it along|along)|i (passed|forwarded|sent) your (resume|info|name)|(just )?submitted (a|my) referral|referred you|put in a (good )?word|(want|like|need) an? intro|intro(duction)? to (anyone|someone|my|our|a few)|connect you with|put you in touch|looping in|loop(ed)? in|cc'?(ing|d)|copying)\b/i;
const OFFER_NAME =
  /\b([Ll]ooping in|[Cc]opying|[Aa]dding|CC'?ing|[Cc]c'?ing|CC'?d|[Ii]ntroducing) [A-Z][a-z]+/;
const INTRO_BODY =
  /\b(meet [A-Z][a-z]+|[A-Z][a-z]+, meet [A-Z][a-z]+|I'?d like you to meet|[Cc]onnecting you (with|to))\b/;
const INBOUND_THANKS =
  /\b(thank(s| you)( so much| again| a lot)? for (your time|the (great |lovely |nice |helpful )?(chat|call|conversation|time)|taking the time|chatting|talking|meeting|speaking)|(great|nice|lovely|good) (chatting|talking|speaking|meeting|to (meet|chat|talk|connect)) (with )?you)\b/i;
const OUTBOUND_THANKS =
  /\b(thank(s| you)( so much| again| a lot| a ton)*( for| for the| for your)? ?(great |wonderful |helpful |thoughtful |lovely )?(time|chat|call|conversation|advice|insights?|meeting|talking|chatting|speaking|help|perspective)|thank(s| you)( so much| again)* for (taking the time|making time|meeting with me|hopping on)|(great|wonderful|lovely|nice) (chatting|talking|speaking|to (meet|chat|talk)) with you|really (enjoyed|appreciated?) (our|the|your|you) ?(chat|conversation|call|time|advice|insights?|sharing|taking)|i really enjoyed (our|the) (chat|conversation|call))\b/i;
/** A gratitude word anywhere; used by ingest for a note sent right after a completed chat. */
export const GRATITUDE = /\b(thank(s| you)|grateful|appreciate[ds]?)\b/i;

export interface SignalOptions {
  /** the student's IANA zone; times without a stated zone resolve in it */
  timeZone?: string;
}

function returnDate(text: string, reference: Date, timeZone?: string): string | undefined {
  RETURN_PHRASE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RETURN_PHRASE.exec(text))) {
    const d = extractFirstDate(m[1]!, reference, timeZone);
    if (d) return d;
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
 * Classify one message. Inbound order: out of office (unless a time is offered) → redirect to a colleague (an
 * intro) → reschedule or counter-proposal → confirmation → proposal → hard decline → referral / intro offers →
 * soft decline → thank-you after a conversation → positive / question / neutral.
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
    if (OFFER_I.test(l) || OFFER_NAME.test(l)) extraction.offers.push(l);
  }
  const warm = (signal: ReplySignal, confidence: number) => {
    extraction.sentiment = 'warm';
    return { signal, confidence, extraction };
  };

  if (direction === 'outbound') {
    const explicitAsk =
      /\b(would .{1,40} work|does .{1,40} work|how about|are you free|what (time|day)s? work|here are a few times|my availability)\b/.test(
        t,
      );
    if (OUTBOUND_THANKS.test(body) && !explicitAsk)
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
  if (OOO.test(body) && !times.length && !COUNTER.test(body) && !SCHED_CUE.test(body)) {
    const rd = returnDate(body, reference, opts.timeZone);
    if (rd) extraction.returnDate = rd;
    return { signal: 'out_of_office', confidence: 0.9, extraction };
  }
  // a redirect to a colleague is an intro, not a decline
  if (REDIRECT.test(body) && !schedulingCue) {
    if (!extraction.offers.length)
      extraction.offers.push(lines.find((l) => REDIRECT.test(l)) ?? body.slice(0, 200));
    return warm('intro_offer', 0.75);
  }
  // reschedule or counter-proposal: with a new time it is a proposal to confirm, without one a reschedule
  if (RESCHEDULE.test(body) || (DEFER.test(body) && !positive)) {
    if (times.length) return warm('scheduling_proposal', 0.85);
    return { signal: 'reschedule', confidence: 0.75, extraction };
  }
  if (DEFER.test(body) && positive) return warm('reply_positive', 0.75);
  if (CONFIRM.test(body)) return warm('scheduling_confirmation', 0.8);
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
  if (extraction.offers.length || INTRO_BODY.test(body)) return warm('intro_offer', 0.8);
  if (SOFT_DECLINE.test(body) && !COUNTER.test(body)) {
    extraction.sentiment = 'cool';
    return { signal: 'reply_decline', confidence: 0.6, extraction };
  }
  const endsWithQuestion = /\?\s*$/.test(body.trim());
  // a thank-you after a conversation ("thanks for the chat today"), never "thanks for reaching out"
  if (INBOUND_THANKS.test(body) && !positive && !endsWithQuestion) return warm('thank_you', 0.7);
  if (positive && !endsWithQuestion) return warm('reply_positive', 0.82);
  if (endsWithQuestion || extraction.asksOfUser.length)
    return { signal: 'question', confidence: 0.6, extraction };
  if (positive) return warm('reply_positive', 0.7);
  return { signal: 'reply_neutral', confidence: 0.55, extraction };
}
