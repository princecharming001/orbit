import type { EmailCategory, MessageExtraction, ProposedTime, ReplySignal } from '../types';

export interface TriageInput {
  subject?: string;
  messages: { fromEmail: string; direction: 'inbound' | 'outbound'; body: string; isAutomated: boolean }[];
  userEmails: string[];
}

export interface TriageResult {
  category: EmailCategory;
  isNetworking: boolean;
  confidence: number;
  topic: string;
}

const NETWORKING =
  /\b(coffee( chat)?|quick (call|chat)|informational|advice|your (path|journey|experience|story|role|team)|how (you|did you) (got|get) into|intro(duc(e|tion))?|connect(ing)?|catch ?up|mentor|alum(ni|nus|na)?|referr?al|(hear|learn) (more )?about (your|the|how|what)|\d{1,2}[- ]?min(ute)?s?( of your time| to (hear|chat|learn|talk))?|chat (about|re)|pick your brain|would love to (hear|learn|chat)|grab (a )?(coffee|call)|sent you an invite|looking forward to (speaking|chatting|our (call|chat))|thanks (so much )?for (your time|chatting|the (chat|call|conversation)))\b/i;
const RECRUITING =
  /\b(interview|online assessment|\bOA\b|hackerrank|codesignal|offer letter|background check|onboarding|application (status|received)|next (steps|round)|phone screen|technical screen|hiring (manager|team)|recruit(er|ing) (team|coordinator)|we regret|unfortunately we|position has been filled)\b/i;
const TRANSACTIONAL =
  /\b(order|receipt|invoice|payment|shipped|delivery|password|verify|verification code|your account|subscription|unsubscribe|statement)\b/i;

export function heuristicTriage(input: TriageInput): TriageResult {
  const text = `${input.subject ?? ''}\n${input.messages.map((m) => m.body.slice(0, 1500)).join('\n')}`;
  if (input.messages.every((m) => m.isAutomated))
    return { category: 'automated', isNetworking: false, confidence: 0.95, topic: input.subject ?? '' };
  const humans = input.messages.filter((m) => !m.isAutomated);
  const hasInboundHuman = humans.some((m) => m.direction === 'inbound');
  const hasOutboundHuman = humans.some((m) => m.direction === 'outbound');
  if (TRANSACTIONAL.test(text) && !NETWORKING.test(text))
    return { category: 'transactional', isNetworking: false, confidence: 0.7, topic: input.subject ?? '' };
  if (RECRUITING.test(text) && !NETWORKING.test(text))
    return {
      category: 'recruiting_process',
      isNetworking: false,
      confidence: 0.75,
      topic: input.subject ?? '',
    };
  const netHits = (text.match(NETWORKING) ?? []).length;
  if (netHits > 0) {
    const conf = Math.min(0.95, 0.65 + 0.1 * netHits + (hasInboundHuman && hasOutboundHuman ? 0.1 : 0));
    return { category: 'networking', isNetworking: true, confidence: conf, topic: input.subject ?? '' };
  }
  if (hasInboundHuman && hasOutboundHuman)
    return { category: 'personal', isNetworking: false, confidence: 0.5, topic: input.subject ?? '' };
  return { category: 'other', isNetworking: false, confidence: 0.5, topic: input.subject ?? '' };
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Extract simple proposed times like "Thursday at 2pm", "Tue 10:30am", "tomorrow 3pm", "next Monday 4 PM". */
export function extractProposedTimes(text: string, reference: Date): ProposedTime[] {
  const out: ProposedTime[] = [];
  const re =
    /\b(?:(next|this)\s+)?(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\b(?:\s*(?:,|at|@)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*(?:-|to|–)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?)?/gi;
  const tomorrow = /\btomorrow\b(?:\s*(?:,|at|@)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/gi;
  const push = (start: Date, end: Date | undefined, raw: string) => {
    if (out.some((o) => o.raw === raw)) return;
    out.push({ startIso: start.toISOString(), endIso: end?.toISOString(), raw });
  };
  const toHour = (
    h: string | undefined,
    m: string | undefined,
    ap: string | undefined,
    fallbackAp?: string,
  ): number | undefined => {
    if (!h) return undefined;
    let hour = Number.parseInt(h, 10);
    const a = (ap ?? fallbackAp ?? '').toLowerCase();
    if (a === 'pm' && hour < 12) hour += 12;
    if (a === 'am' && hour === 12) hour = 0;
    if (!a && hour >= 1 && hour <= 7) hour += 12; // "at 3" means 3pm
    return hour + (m ? Number.parseInt(m, 10) / 60 : 0);
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const hour = toHour(m[3], m[4], m[5], m[8]);
    if (hour === undefined) continue; // weekday without a time is too vague
    const dayAbbr = m[2]!.toLowerCase().slice(0, 3);
    const target = WEEKDAYS.findIndex((d) => d.startsWith(dayAbbr));
    const d = new Date(reference);
    let delta = (target - d.getDay() + 7) % 7;
    if (delta === 0 && (m[1]?.toLowerCase() === 'next' || d.getHours() > hour)) delta = 7;
    if (m[1]?.toLowerCase() === 'next' && delta < 7) delta += 0; // "next Monday" in casual US usage is the coming Monday
    d.setDate(d.getDate() + delta);
    d.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
    let end: Date | undefined;
    const endHour = toHour(m[6], m[7], m[8], m[5]);
    if (endHour !== undefined) {
      end = new Date(d);
      end.setHours(Math.floor(endHour), Math.round((endHour % 1) * 60), 0, 0);
    }
    push(d, end, m[0].trim());
  }
  while ((m = tomorrow.exec(text))) {
    const hour = toHour(m[1], m[2], m[3]);
    if (hour === undefined) continue;
    const d = new Date(reference);
    d.setDate(d.getDate() + 1);
    d.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
    push(d, undefined, m[0].trim());
  }
  return out;
}

export function heuristicSignal(
  body: string,
  direction: 'inbound' | 'outbound',
  reference: Date,
): { signal: ReplySignal; confidence: number; extraction: MessageExtraction } {
  const t = body.toLowerCase();
  const times = extractProposedTimes(body, reference);
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
    if (
      /\b(could you|can you|please send|send (me|over)|would you mind|let me know (which|what|your)|what (teams|roles|areas)|share your resume)\b/i.test(
        l,
      ) &&
      l.length < 220
    )
      extraction.asksOfUser.push(l);
    if (
      /\b(happy to (refer|intro|introduce|connect you|put you in touch|pass (along|on))|i can (refer|intro|introduce|connect)|i'?ll (refer|intro|introduce|put in a (good )?word|forward your resume))\b/i.test(
        l,
      ) &&
      l.length < 220
    )
      extraction.offers.push(l);
  }
  if (/\b(out of (the )?office|on (vacation|leave|pto)|away until|auto(-| )reply|automatic reply)\b/.test(t))
    return { signal: 'out_of_office', confidence: 0.9, extraction };
  if (direction === 'outbound') {
    if (
      /\b(thank(s| you) (so much )?(again )?for (your time|chatting|taking the time|the (chat|call|conversation)))\b/.test(
        t,
      )
    )
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
  if (
    /\b(not (able|the right|a good fit|taking|available)|unfortunately|can'?t (make|do) (it|this)|don'?t think i can|i'?m going to pass|please (don'?t|do not) (contact|email)|remove me|no longer (at|with))\b/.test(
      t,
    ) &&
    !/\b(but|however|instead)\b.*\b(happy|could|can)\b/.test(t)
  ) {
    extraction.sentiment = 'cool';
    return { signal: 'reply_decline', confidence: 0.75, extraction };
  }
  if (
    /\b(confirmed|see you (then|on)|sounds good,? (see you|talk)|calendar invite|sent (an|the) invite|booked|locked in|looking forward to (speaking|chatting|our call))\b/.test(
      t,
    )
  ) {
    extraction.sentiment = 'warm';
    return { signal: 'scheduling_confirmation', confidence: 0.8, extraction };
  }
  if (
    /\b(resched|push (it|this|our)|something came up|move (it|this|our)|can we do (another|a different)|conflict)\b/.test(
      t,
    )
  )
    return { signal: 'reschedule', confidence: 0.75, extraction };
  if (
    times.length ||
    /\b(does .* work|free (on|at|this|next)|available (on|at|this|next)|what (time|day)s? work|here are (a few|some) times|my availability|pick a (time|slot)|calendly|cal\.com|booking link)\b/.test(
      t,
    )
  ) {
    extraction.sentiment = 'warm';
    return { signal: 'scheduling_proposal', confidence: times.length ? 0.85 : 0.7, extraction };
  }
  if (extraction.offers.some((o) => /refer|word|forward/i.test(o))) {
    extraction.sentiment = 'warm';
    return { signal: 'referral_offer', confidence: 0.8, extraction };
  }
  if (
    extraction.offers.some((o) => /intro|introduce|connect you|in touch/i.test(o)) ||
    /\b(meet [A-Z][a-z]+|introducing|i'?d like you to meet|connecting you (with|to)|cc'?ing)\b/.test(body)
  ) {
    extraction.sentiment = 'warm';
    return { signal: 'intro_offer', confidence: 0.8, extraction };
  }
  if (
    /\b(thank(s| you)|appreciate)\b/.test(t) &&
    /\b(chat|call|conversation|time)\b/.test(t) &&
    direction === 'inbound'
  )
    return { signal: 'thank_you', confidence: 0.6, extraction };
  const positive =
    /\b(happy to|would love to|glad to|sure|absolutely|of course|sounds (great|good)|let'?s (do it|chat|find a time))\b/.test(
      t,
    );
  const endsWithQuestion = /\?\s*$/.test(body.trim());
  if (positive && !endsWithQuestion) {
    extraction.sentiment = 'warm';
    return { signal: 'reply_positive', confidence: 0.82, extraction };
  }
  if (endsWithQuestion || extraction.asksOfUser.length)
    return { signal: 'question', confidence: 0.6, extraction };
  if (positive) {
    extraction.sentiment = 'warm';
    return { signal: 'reply_positive', confidence: 0.7, extraction };
  }
  return { signal: 'reply_neutral', confidence: 0.55, extraction };
}
