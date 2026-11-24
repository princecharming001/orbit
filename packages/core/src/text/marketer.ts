/**
 * Is this someone selling to the student? Read from the messages of a person the student has never written back to.
 *
 * A student's LinkedIn and inbox fill with people who connect and pitch: an agency, a tool, a "quick 15 minutes to
 * show you". They are not part of the student's network, yet each became a person in Orbit, counted in searches and
 * suggestions. They are easy to spot, and the rule is kept strict on purpose, because the opposite mistake is the
 * costly one: someone real who asks for a call must never be set aside. So asking for a call is not selling. A
 * message has to say it is selling (what "we" offer, a free demo, a discount, a follow-up on a pitch nobody
 * answered), and that has to be said twice, or once together with a push for a meeting, or once by someone who kept
 * writing into silence. A bulk mail header (List-Unsubscribe) settles it alone.
 *
 * The caller decides who is asked about at all: only people the student never wrote to, never met, never put on
 * their pipeline and never noted anything about.
 */

export interface MarketerMessage {
  /** the message as written (subject and body); only the first few thousand characters are read */
  text: string;
  /** the mail carried a List-Unsubscribe header: a sending tool, not a person at a keyboard */
  unsubscribe?: boolean;
}

export interface MarketerVerdict {
  marketer: boolean;
  /** what in their messages says so, in plain words, most telling first */
  reasons: string[];
}

/** Says, in so many words, that something is being sold. */
const SELLING: [RegExp, string][] = [
  [
    /\bwe (help|work with|partner with|support|assist) (companies|founders|teams|business(es)?|startups|brands|agencies|clients|b2b|saas|e-?commerce|coaches|creators)\b/i,
    'Says who their company sells to',
  ],
  [
    /\b(our|my) (platform|agency|firm|company|services?|solution|software|tool|product|team of (developers|engineers|designers|experts))\b[^.!?\n]{0,60}\b(helps?|specializ|speciali[sz]es?|builds?|offers?|provides?|delivers?|automates?)\b/i,
    'Describes what their company offers',
  ],
  [
    /\bfree (trial|demo|audit|consult(ation)?|strategy (call|session)|sample|quote|assessment|growth plan)\b/i,
    'Offers something free to start',
  ],
  [
    /\b(book|schedule|grab|claim) (a|your) (free )?(demo|strategy call|discovery call|consultation)\b/i,
    'Asks to book a demo',
  ],
  [
    /\b\d{1,3}\s?% off\b|\bspecial offer\b|\blimited[- ]time\b|\bdiscount code\b|\bpromo code\b/i,
    'Offers a discount',
  ],
  [
    /\bare you the right person\b|\bwho (is|would be) the (right|best) person\b|\bpoint me (to|toward) the right person\b/i,
    'Asks who handles buying',
  ],
  [
    /\bunsubscribe\b|\bopt[- ]out\b|\bif you(?:'|’)?d (rather|prefer) not (to )?(hear|receive)\b/i,
    'Has an unsubscribe line',
  ],
  [
    /\b(generate|book|get|deliver|bring) (you |your team )?(\d+\+? )?(more )?(qualified |warm |sales )?(leads|meetings|appointments|clients|customers|demos)\b/i,
    'Promises leads or clients',
  ],
  [
    /\b(lead gen(eration)?|outsourc(e|ing)|white[- ]label|offshore (team|developers)|dev shop|seo services|link building|guest post|backlinks?|virtual assistants?|cold email (agency|service)|appointment setting)\b/i,
    'Sells an outsourced service',
  ],
  [
    /\b(i|we) (noticed|saw|came across|checked out|was looking at) (your|that your) (website|company|profile|post|linkedin|business|store)\b[^.!?\n]{0,120}\b(help|improve|increase|boost|grow|scale|optimi[sz]e|save you)\b/i,
    'Opens with their product after seeing the profile',
  ],
  [/\b(pricing|packages?) (start|starts|begin) (at|from)\b|\bstarting at \$\d/i, 'Quotes a price'],
];

/** Pushes for a meeting. On its own this is what real people do too, so it only counts beside a sign of selling. */
const PUSHING: RegExp[] = [
  // a follow-up into silence: people do it, sellers do it more
  /\b(bumping this|circling back|just following up|following up on my (last|previous|earlier) (email|message|note))\b/i,
  /\b(quick|brief|short) (call|chat|intro call|zoom)\b/i,
  /\b(10|15|20|30)[- ]?min(ute)?s?\b/i,
  /\b(calendly\.com|cal\.com\/|savvycal\.com|hubspot\.com\/meetings|chili ?piper|tidycal\.com)\b/i,
  /\bhop on a (quick )?(call|zoom)\b/i,
  /\b(open|interested) (to|in) (learning|hearing|exploring|seeing) more\b/i,
  /\bwould love to (show|share|walk you through|give you)\b/i,
  /\bworth a (quick )?(chat|conversation|call)\b/i,
];

/** Said once is enough: a discount, an unsubscribe line, a promise of leads. */
const DECISIVE = ['Offers a discount', 'Has an unsubscribe line', 'Promises leads or clients'];

const READ = 4000;

/** What one person's messages say. `marketer` is only meaningful for someone the student never wrote to. */
export function marketerVerdict(messages: MarketerMessage[]): MarketerVerdict {
  const said = messages.filter((m) => m.text?.trim() || m.unsubscribe);
  if (!said.length) return { marketer: false, reasons: [] };
  const reasons: string[] = [];
  if (said.some((m) => m.unsubscribe)) reasons.push('Sent by a mailing tool');
  let pushing = false;
  for (const m of said) {
    const text = (m.text ?? '').slice(0, READ);
    for (const [re, why] of SELLING) if (re.test(text) && !reasons.includes(why)) reasons.push(why);
    if (PUSHING.some((re) => re.test(text))) pushing = true;
  }
  const selling = reasons.filter((r) => r !== 'Sent by a mailing tool').length;
  const marketer =
    reasons.includes('Sent by a mailing tool') ||
    // nobody writes these to someone they know
    DECISIVE.some((r) => reasons.includes(r)) ||
    selling >= 2 ||
    (selling === 1 && pushing) ||
    // said it once, then kept writing into silence
    (selling === 1 && said.length >= 2);
  if (marketer && pushing && selling === 1) reasons.push('Pushes for a call');
  return { marketer, reasons: marketer ? reasons.slice(0, 3) : [] };
}
