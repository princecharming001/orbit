import type { ReplySignal } from '../../types';

/**
 * A corpus of real-shaped student recruiting mail, used to pin the heuristic email understanding.
 *
 * Every message is read as ingest reads it: quoted history stripped, signature split off, then classified with
 * the student's zone (America/Los_Angeles) on Monday 5 October 2026 at 9:00 AM Pacific. Expected times are
 * written as the sender's wall clock: "Thu 10/8 14:00" in the stated zone when there is one (`zone`), otherwise
 * in the student's zone.
 */
export const CORPUS_NOW = new Date('2026-10-05T16:00:00Z');
export const CORPUS_TZ = 'America/Los_Angeles';

export interface CorpusMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  from: string;
  /** display name on the From line, when it matters for sender detection */
  fromName?: string;
  subject?: string;
  body: string;
  headers?: Record<string, string>;
  expect: {
    signal: ReplySignal;
    /** "Thu 10/8 14:00" or "Tue 10/6 14:00-16:00"; empty array means no times may be found */
    times?: string[];
    zone?: string;
    automated?: boolean;
    returnDate?: string;
    /** text that must survive quote and signature stripping */
    bodyKeeps?: string[];
    /** text that must be removed by quote and signature stripping */
    bodyDrops?: string[];
    offers?: number;
    asks?: number;
    /** a soft decline that says when to try again */
    followUpAfter?: string;
    /** they declined a call but offered email */
    prefersEmail?: boolean;
    /** a vacation responder judged from its text alone */
    autoReplyBody?: boolean;
    /** title and company read from the signature */
    title?: string;
    company?: string;
  };
}

const ALEX = 'alex.rivera@cornell.edu';
const gmailQuote = (who: string, email: string, quoted: string) =>
  `\n\nOn Mon, Oct 5, 2026 at 8:12 AM ${who} <\n${email}> wrote:\n\n${quoted
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')}\n`;

export const MESSAGES: CorpusMessage[] = [
  // ---- positive first replies -------------------------------------------------------------------------------
  {
    id: 'pos-thanks-reaching-out',
    direction: 'inbound',
    from: 'priya.sharma@figma.com',
    body: 'Hi Alex,\n\nThanks for reaching out! Happy to chat sometime next week. Let me know what works for you.\n\nBest,\nPriya',
    expect: { signal: 'reply_positive', times: [], asks: 0 },
  },
  {
    id: 'pos-hop-on-call',
    direction: 'inbound',
    from: 'marcus.lee@evercore.com',
    body: "Thanks for reaching out, Alex. I'd be happy to hop on a call next week.\n\nMarcus",
    expect: { signal: 'reply_positive', times: [] },
  },
  {
    id: 'pos-send-times',
    direction: 'inbound',
    from: 'dana.ortiz@bain.com',
    body: "Totally, happy to connect. I'm pretty flexible next week, so send over a few times that work for you.\n\nCheers,\nDana",
    expect: { signal: 'reply_positive', times: [], asks: 0 },
  },
  {
    id: 'pos-fellow-alum-question',
    direction: 'inbound',
    from: 'sam.cho@stripe.com',
    body: 'Absolutely, always glad to help a fellow Cornellian. What are you hoping to learn about?',
    expect: { signal: 'question', times: [] },
  },
  {
    id: 'question-before-setup',
    direction: 'inbound',
    from: 'jordan.west@mckinsey.com',
    body: 'Thanks for the note. Before we set something up, what are you hoping to get out of the conversation?',
    expect: { signal: 'question', times: [] },
  },
  {
    id: 'question-resume',
    direction: 'inbound',
    from: 'li.wang@databricks.com',
    body: 'Happy to chat! Could you send me your resume beforehand?\n\nThanks,\nLi',
    expect: { signal: 'question', asks: 1 },
  },
  {
    id: 'pos-defer-week-after',
    direction: 'inbound',
    from: 'nina.patel@google.com',
    body: "Sorry, can't do it this week, I'm out at a conference. Happy to find a time the week after though.",
    expect: { signal: 'reply_positive', times: [] },
  },
  {
    id: 'pos-capital-one-human',
    direction: 'inbound',
    from: 'sarah.chen@capitalone.com',
    body: 'Hi Alex, happy to chat! Would Thursday at 2pm work?\n\nSarah Chen\nSenior Associate | Capital One\n(703) 555-0142',
    expect: {
      signal: 'scheduling_proposal',
      times: ['Thu 10/8 14:00'],
      automated: false,
      bodyDrops: ['703'],
    },
  },
  // ---- scheduling proposals ---------------------------------------------------------------------------------
  {
    id: 'sched-et',
    direction: 'inbound',
    from: 'mike.ross@goldmansachs.com',
    body: 'Sure! Does Thursday at 2pm ET work for you?',
    expect: { signal: 'scheduling_proposal', times: ['Thu 10/8 14:00'], zone: 'America/New_York' },
  },
  {
    id: 'sched-plain',
    direction: 'inbound',
    from: 'priya.sharma@figma.com',
    body: `Sure, happy to. Does Thursday at 2pm work?${gmailQuote('Alexander Rivera', ALEX, "Hi Priya,\nI'm a junior at Cornell. Would you be open to a quick chat?")}`,
    expect: {
      signal: 'scheduling_proposal',
      times: ['Thu 10/8 14:00'],
      bodyDrops: ['wrote:', 'junior at Cornell'],
    },
  },
  {
    id: 'sched-ranges',
    direction: 'inbound',
    from: 'ana.lopez@coinbase.com',
    body: "Happy to help! I'm free Tuesday from 2 to 4pm, or Wednesday between 10 and noon.",
    expect: { signal: 'scheduling_proposal', times: ['Tue 10/6 14:00-16:00', 'Wed 10/7 10:00-12:00'] },
  },
  {
    id: 'sched-time-before-day',
    direction: 'inbound',
    from: 'kevin.zhao@robinhood.com',
    body: "Yes! Let's do 11:30am Friday.",
    expect: { signal: 'scheduling_proposal', times: ['Fri 10/9 11:30'] },
  },
  {
    id: 'sched-noon',
    direction: 'inbound',
    from: 'rae.kim@figma.com',
    body: 'How does Thursday at noon sound?',
    expect: { signal: 'scheduling_proposal', times: ['Thu 10/8 12:00'] },
  },
  {
    id: 'sched-dates-et',
    direction: 'inbound',
    from: 'tom.baker@jpmorgan.com',
    body: 'Would Thurs 10/8 at 2pm ET work? If not, Fri 10/9 at 11am ET is open too.',
    expect: {
      signal: 'scheduling_proposal',
      times: ['Thu 10/8 14:00', 'Fri 10/9 11:00'],
      zone: 'America/New_York',
    },
  },
  {
    id: 'sched-booking-link',
    direction: 'inbound',
    from: 'priya.sharma@figma.com',
    body: 'Hi Alex,\n\nHappy to chat.\n\nGrab any slot here: https://calendly.com/priya-sharma/20min\n\nBest,\nPriya',
    expect: {
      signal: 'scheduling_proposal',
      times: [],
      bodyKeeps: ['https://calendly.com/priya-sharma/20min'],
    },
  },
  {
    id: 'sched-all-pacific',
    direction: 'inbound',
    from: 'jen.wu@doordash.com',
    body: 'Times (all Pacific): Tue 10/13 1-1:30pm or Wed 10/14 9-9:30am.',
    expect: {
      signal: 'scheduling_proposal',
      times: ['Tue 10/13 13:00-13:30', 'Wed 10/14 09:00-09:30'],
      zone: 'America/Los_Angeles',
    },
  },
  {
    id: 'sched-eastern-ordinal',
    direction: 'inbound',
    from: 'grace.huang@blackstone.com',
    body: "Of course! I'm on Eastern time. Would 4pm on Monday the 12th work?",
    expect: { signal: 'scheduling_proposal', times: ['Mon 10/12 16:00'], zone: 'America/New_York' },
  },
  {
    id: 'sched-around-after',
    direction: 'inbound',
    from: 'omar.haddad@stripe.com',
    body: 'Happy to chat! Thursday around 2 or Friday after 4 both work on my end.',
    expect: { signal: 'scheduling_proposal', times: ['Thu 10/8 14:00', 'Fri 10/9 16:00'] },
  },
  {
    id: 'sched-tomorrow',
    direction: 'inbound',
    from: 'beth.adams@deloitte.com',
    body: 'Sure thing. How about tomorrow at 3?',
    expect: { signal: 'scheduling_proposal', times: ['Tue 10/6 15:00'] },
  },
  {
    id: 'sched-month-name-pt',
    direction: 'inbound',
    from: 'luis.garcia@pinterest.com',
    body: "Let's say Oct 14 at 10:30am PT.\n\nLuis",
    expect: { signal: 'scheduling_proposal', times: ['Wed 10/14 10:30'], zone: 'America/Los_Angeles' },
  },
  {
    id: 'sched-weekday-noise',
    direction: 'inbound',
    from: 'chris.park@tiktok.com',
    body: "Haha I ran the Sunday 10K race, so Monday I'm wrecked. Tuesday at 11?",
    expect: { signal: 'scheduling_proposal', times: ['Tue 10/6 11:00'] },
  },
  {
    id: 'sched-anytime-after',
    direction: 'inbound',
    from: 'ella.ross@linkedin.com',
    body: "I'm free Thursday, anytime after 2pm. Just send an invite!",
    expect: { signal: 'scheduling_proposal', times: ['Thu 10/8 14:00'], automated: false },
  },
  {
    id: 'sched-date-with-weekday',
    direction: 'inbound',
    from: 'yusuf.ali@palantir.com',
    body: 'Monday, October 12 at 10:00 AM CT works best for me.',
    expect: { signal: 'scheduling_proposal', times: ['Mon 10/12 10:00'], zone: 'America/Chicago' },
  },
  // ---- confirmations ------------------------------------------------------------------------------------------
  {
    id: 'confirm-see-you',
    direction: 'inbound',
    from: 'priya.sharma@figma.com',
    body: 'Confirmed, see you then!',
    expect: { signal: 'scheduling_confirmation' },
  },
  {
    id: 'confirm-talk-thursday',
    direction: 'inbound',
    from: 'marcus.lee@evercore.com',
    body: 'Perfect, talk Thursday!',
    expect: { signal: 'scheduling_confirmation', times: [] },
  },
  {
    id: 'confirm-accepted',
    direction: 'inbound',
    from: 'dana.ortiz@bain.com',
    body: 'Accepted the invite. Looking forward to it.\n\nSent from my iPhone',
    expect: { signal: 'scheduling_confirmation', bodyDrops: ['iPhone'] },
  },
  {
    id: 'confirm-zoom-link',
    direction: 'inbound',
    from: 'priya.sharma@figma.com',
    body: 'Great, that works.\n\nHere is the Zoom link for Thursday: https://zoom.us/j/8921234567\n\nTalk soon,\nPriya',
    expect: { signal: 'scheduling_confirmation', bodyKeeps: ['https://zoom.us/j/8921234567'] },
  },
  {
    id: 'confirm-see-you-time',
    direction: 'inbound',
    from: 'kevin.zhao@robinhood.com',
    body: 'Sounds good, see you Thursday at 2pm.',
    expect: { signal: 'scheduling_confirmation', times: ['Thu 10/8 14:00'] },
  },
  {
    id: 'confirm-meeting-id',
    direction: 'inbound',
    from: 'li.wang@databricks.com',
    body: 'Happy to chat! The meeting ID is 892 1234 5678 and passcode 1234.\n\nSee you Thursday.\nLi',
    expect: { signal: 'scheduling_confirmation', times: [], bodyKeeps: ['892 1234 5678'] },
  },
  {
    id: 'confirm-cell',
    direction: 'inbound',
    from: 'beth.adams@deloitte.com',
    body: "Sure thing.\n\nI'll send a Google Meet invite. My cell is 415-555-0100 if anything comes up.\n\nBeth",
    expect: { signal: 'scheduling_confirmation', bodyKeeps: ['415-555-0100'] },
  },
  // ---- reschedules and counter-proposals ------------------------------------------------------------------------
  {
    id: 'counter-wednesday',
    direction: 'inbound',
    from: 'nina.patel@google.com',
    body: "I'm not available Tuesday but Wednesday at 2pm works.",
    expect: { signal: 'scheduling_proposal', times: ['Wed 10/7 14:00'] },
  },
  {
    id: 'counter-unfortunately',
    direction: 'inbound',
    from: 'grace.huang@blackstone.com',
    body: "Unfortunately Tuesday doesn't work for me anymore. Could you do Thursday at 3?",
    expect: { signal: 'scheduling_proposal', times: ['Thu 10/8 15:00'] },
  },
  {
    id: 'resched-push',
    direction: 'inbound',
    from: 'tom.baker@jpmorgan.com',
    body: "I can't make it Thursday anymore, something came up on my end. Can we push to Friday same time?",
    expect: { signal: 'reschedule', times: [] },
  },
  {
    id: 'counter-no-longer-works',
    direction: 'inbound',
    from: 'omar.haddad@stripe.com',
    body: 'Unfortunately Thursday no longer works. Would Friday at 2pm work instead?',
    expect: { signal: 'scheduling_proposal', times: ['Fri 10/9 14:00'] },
  },
  {
    id: 'resched-something-came-up',
    direction: 'inbound',
    from: 'luis.garcia@pinterest.com',
    body: 'Something came up, can we reschedule? So sorry about that.',
    expect: { signal: 'reschedule' },
  },
  {
    id: 'counter-vacation',
    direction: 'inbound',
    from: 'yusuf.ali@palantir.com',
    body: "I'm on vacation next week, but how about the week after? Tuesday the 20th at 2pm?",
    expect: { signal: 'scheduling_proposal', times: ['Tue 10/20 14:00'] },
  },
  {
    id: 'resched-moved-invite',
    direction: 'inbound',
    from: 'ethan.cole@anthropic.com',
    body: "A conflict just landed on Tuesday, sorry about that. I moved our calendar invite to Thursday at 11:30am, same link. Let me know if that doesn't work.",
    expect: { signal: 'scheduling_confirmation', times: ['Thu 10/8 11:30'] },
  },
  {
    id: 'intro-you-two',
    direction: 'inbound',
    from: 'priya.shah@stripe.com',
    body: 'Hi Sebastian and Alex,\n\nAs promised, introducing you two. Sebastian, Alex is a junior who asked me good questions about payments. Alex, Sebastian is a staff engineer at Plaid. Over to you both.\n\nPriya',
    expect: { signal: 'intro_offer' },
  },
  {
    id: 'out-accept-with-thanks',
    direction: 'outbound',
    from: 'alex.rivera@cornell.edu',
    body: 'Perfect, see you Tuesday at 4pm. Thanks again for making time.',
    expect: { signal: 'scheduling_proposal', times: ['Tue 10/6 16:00'] },
  },
  // ---- declines -----------------------------------------------------------------------------------------------
  {
    id: 'decline-not-able',
    direction: 'inbound',
    from: 'ken.ito@mckinsey.com',
    body: 'Unfortunately I am not able to take calls this quarter. Best of luck with the search!',
    expect: { signal: 'reply_decline' },
  },
  {
    id: 'decline-pass',
    direction: 'inbound',
    from: 'lauren.price@bcg.com',
    body: "Thanks for thinking of me, but I'm going to pass for now.",
    expect: { signal: 'reply_decline' },
  },
  {
    id: 'decline-remove',
    direction: 'inbound',
    from: 'pat.quinn@citadel.com',
    body: 'Please remove me from your list.',
    expect: { signal: 'reply_decline' },
  },
  {
    id: 'decline-no-coffee-chats',
    direction: 'inbound',
    from: 'ravi.menon@meta.com',
    body: "I'm not taking any coffee chats right now, sorry.",
    expect: { signal: 'reply_decline' },
  },
  {
    id: 'decline-soft-slammed',
    direction: 'inbound',
    from: 'amy.tran@airbnb.com',
    body: "I'm slammed this quarter, maybe in the new year?",
    expect: { signal: 'reply_decline' },
  },
  {
    id: 'decline-soft-bandwidth',
    direction: 'inbound',
    from: 'joe.martin@uber.com',
    body: "I don't have bandwidth for calls right now, sorry. Good luck!",
    expect: { signal: 'reply_decline' },
  },
  {
    id: 'decline-soft-left',
    direction: 'inbound',
    from: 'kate.byrne@gmail.com',
    body: 'I actually no longer work at Google, sorry! Best of luck.',
    expect: { signal: 'reply_decline' },
  },
  {
    id: 'redirect-colleague',
    direction: 'inbound',
    from: 'ben.fox@figma.com',
    body: "I'm not the right person for this, but my colleague Sarah Kim runs our APM program and would be a better contact.",
    expect: { signal: 'intro_offer' },
  },
  // ---- out of office ------------------------------------------------------------------------------------------
  {
    id: 'ooo-auto-until-date',
    direction: 'inbound',
    from: 'sarah.chen@capitalone.com',
    subject: 'Automatic reply: Cornell junior, quick question',
    headers: { 'auto-submitted': 'auto-replied', precedence: 'bulk' },
    body: 'Thank you for your email. I am out of the office until Monday, October 19 with limited access to email. I will respond when I return.',
    expect: { signal: 'out_of_office', automated: true, returnDate: '2026-10-19', times: [] },
  },
  {
    id: 'ooo-parental-leave',
    direction: 'inbound',
    from: 'mike.ross@goldmansachs.com',
    subject: 'Out of Office: Coffee chat?',
    headers: { 'x-autoreply': 'yes' },
    body: "Hi, I'm on parental leave through 11/30. For anything urgent, please contact my team.",
    expect: { signal: 'out_of_office', automated: true, returnDate: '2026-11-30' },
  },
  {
    id: 'ooo-hand-typed',
    direction: 'inbound',
    from: 'ella.ross@linkedin.com',
    body: "Heads up, I'm traveling for work and out of office until Thursday. Will get back to you after.",
    expect: { signal: 'out_of_office', automated: false, returnDate: '2026-10-08' },
  },
  // ---- intros and referrals -----------------------------------------------------------------------------------
  {
    id: 'intro-looping-in',
    direction: 'inbound',
    from: 'dana.ortiz@bain.com',
    body: "Of course! Looping in Sarah (cc'd), who leads our associate recruiting. Sarah, Alex is a junior at Cornell and would love 15 minutes with you.\n\nBest,\nDana",
    expect: { signal: 'intro_offer', offers: 1 },
  },
  {
    id: 'intro-ccing',
    direction: 'inbound',
    from: 'marcus.lee@evercore.com',
    body: 'CCing Sarah from our team who can speak to the analyst program.',
    expect: { signal: 'intro_offer' },
  },
  {
    id: 'intro-offer-anyone',
    direction: 'inbound',
    from: 'priya.sharma@figma.com',
    body: "Great questions. Let me know if you'd like an intro to anyone on the data team.",
    expect: { signal: 'intro_offer' },
  },
  {
    id: 'referral-pass-resume',
    direction: 'inbound',
    from: 'sam.cho@stripe.com',
    body: "I'll pass your resume along to our university recruiter.",
    expect: { signal: 'referral_offer' },
  },
  {
    id: 'referral-submitted',
    direction: 'inbound',
    from: 'li.wang@databricks.com',
    body: 'Just submitted a referral for you in our system. You should get an email from the recruiting team.',
    expect: { signal: 'referral_offer' },
  },
  {
    id: 'referral-good-word',
    direction: 'inbound',
    from: 'kevin.zhao@robinhood.com',
    body: 'Send me your resume and the req number and I can put in a good word.',
    expect: { signal: 'referral_offer' },
  },
  {
    id: 'referral-when-posting',
    direction: 'inbound',
    from: 'nina.patel@google.com',
    body: 'Happy to refer you when the posting goes up.',
    expect: { signal: 'referral_offer' },
  },
  {
    id: 'intro-meet',
    direction: 'inbound',
    from: 'grace.huang@blackstone.com',
    body: 'Alex, meet Dana. Dana runs growth at Figma and was a Cornell econ major too. I will let you two take it from here.',
    expect: { signal: 'intro_offer' },
  },
  {
    id: 'referral-after-chat',
    direction: 'inbound',
    from: 'priya.sharma@figma.com',
    body: "Great chatting with you too! I passed your resume along and the hiring manager wants to set up a phone screen. I'll have our recruiter reach out.",
    expect: { signal: 'referral_offer' },
  },
  // ---- thank-yous and neutral ---------------------------------------------------------------------------------
  {
    id: 'thanks-inbound-after-chat',
    direction: 'inbound',
    from: 'marcus.lee@evercore.com',
    body: 'Thanks for the great chat today, Alex. Good luck with recruiting.',
    expect: { signal: 'thank_you' },
  },
  {
    id: 'thanks-met-last-friday',
    direction: 'inbound',
    from: 'chris.park@tiktok.com',
    body: 'We met last Friday at 5 at the career fair, it was great to meet you.',
    expect: { signal: 'thank_you', times: [] },
  },
  {
    id: 'neutral-take-a-look',
    direction: 'inbound',
    from: 'amy.tran@airbnb.com',
    body: "Got it, I'll take a look this weekend.",
    expect: { signal: 'reply_neutral', times: [] },
  },
  {
    id: 'friend-at-3',
    direction: 'inbound',
    from: 'joe.martin@uber.com',
    body: 'My friend at 3 Capital might be a better contact for this.',
    expect: { signal: 'intro_offer', times: [] },
  },
  {
    id: 'monaco',
    direction: 'inbound',
    from: 'kate.byrne@gmail.com',
    body: "I'll be in Monaco at 5 for a conference, so email is the best way to reach me this month.",
    expect: { signal: 'reply_neutral', times: [] },
  },
  // ---- the student's own mail ---------------------------------------------------------------------------------
  {
    id: 'out-thanks-conversation',
    direction: 'outbound',
    from: ALEX,
    body: 'Hi Priya,\n\nThank you again for the great conversation yesterday. Your point about owning one project end-to-end really stuck with me.\n\nBest,\nAlex',
    expect: { signal: 'thank_you' },
  },
  {
    id: 'out-thanks-great-chatting',
    direction: 'outbound',
    from: ALEX,
    body: 'It was great chatting with you yesterday, really appreciated your advice on the APM process.',
    expect: { signal: 'thank_you' },
  },
  {
    id: 'out-thanks-advice',
    direction: 'outbound',
    from: ALEX,
    body: "Thank you for the advice today, Priya. I'll follow up with Sarah like you suggested.",
    expect: { signal: 'thank_you' },
  },
  {
    id: 'out-thanks-time',
    direction: 'outbound',
    from: ALEX,
    body: 'Thanks so much for your time today!',
    expect: { signal: 'thank_you' },
  },
  {
    id: 'out-propose',
    direction: 'outbound',
    from: ALEX,
    body: 'Thanks for getting back to me! Would Thursday at 2pm or Friday at 10am PT work?',
    expect: {
      signal: 'scheduling_proposal',
      times: ['Thu 10/8 14:00', 'Fri 10/9 10:00'],
      zone: 'America/Los_Angeles',
    },
  },
  // ---- round 2: week scopes, soft declines, short confirmations, email-only, responders, senders ---------------
  {
    id: 'counter-vacation-week-after',
    direction: 'inbound',
    from: 'yusuf.ali@palantir.com',
    body: "I'm on vacation next week, but how about the week after? Tuesday at 2pm?",
    expect: { signal: 'scheduling_proposal', times: ['Tue 10/20 14:00'], autoReplyBody: false },
  },
  {
    id: 'sched-next-week-open',
    direction: 'inbound',
    from: 'grace.liu@databricks.com',
    body: "I'm fully booked this week, but next week is wide open. Tues 10am or Wed 4pm?\n\nGrace",
    expect: { signal: 'scheduling_proposal', times: ['Tue 10/13 10:00', 'Wed 10/14 16:00'] },
  },
  {
    id: 'sched-traveling-next-week',
    direction: 'inbound',
    from: 'ben.okafor@bain.com',
    body: "I'm traveling next week. Would Thursday at 2pm work?",
    expect: { signal: 'scheduling_proposal', times: ['Thu 10/8 14:00'] },
  },
  {
    id: 'sched-day-next-week',
    direction: 'inbound',
    from: 'nina.shah@airbnb.com',
    body: 'Sure thing. Could you do Tuesday next week at 11?',
    expect: { signal: 'scheduling_proposal', times: ['Tue 10/13 11:00'] },
  },
  {
    id: 'sched-next-thursday',
    direction: 'inbound',
    from: 'kai.wong@notion.so',
    body: 'Happy to. How about next Thursday at 3pm?',
    expect: { signal: 'scheduling_proposal', times: ['Thu 10/15 15:00'] },
  },
  {
    id: 'sched-booked-solid-offer',
    direction: 'inbound',
    from: 'eva.martin@mckinsey.com',
    body: 'Monday is booked solid, but does Tues 10am work?',
    expect: { signal: 'scheduling_proposal', times: ['Tue 10/6 10:00'] },
  },
  {
    id: 'sched-if-that-works',
    direction: 'inbound',
    from: 'raj.iyer@citadel.com',
    body: 'I can do Thursday at 2pm, let me know if that works.',
    expect: { signal: 'scheduling_proposal', times: ['Thu 10/8 14:00'] },
  },
  {
    id: 'confirm-perfect-talk',
    direction: 'inbound',
    from: 'priya.patel@figma.com',
    body: 'Perfect, talk Thursday!',
    expect: { signal: 'scheduling_confirmation', times: [] },
  },
  {
    id: 'confirm-works-for-me',
    direction: 'inbound',
    from: 'tom.becker@stripe.com',
    body: 'Thursday at 2pm works for me. Talk then.',
    expect: { signal: 'scheduling_confirmation', times: ['Thu 10/8 14:00'] },
  },
  {
    id: 'confirm-all-set',
    direction: 'inbound',
    from: 'lena.fischer@blackstone.com',
    body: "You're all set, see you Thursday.\n\nSent from my iPhone",
    expect: { signal: 'scheduling_confirmation', bodyDrops: ['Sent from my iPhone'] },
  },
  {
    id: 'decline-slammed-january',
    direction: 'inbound',
    from: 'marco.rossi@google.com',
    body: "Hi Alex, I'm pretty slammed this quarter but maybe in the new year? Feel free to ping me again in January.\n\nMarco",
    expect: { signal: 'reply_decline', followUpAfter: '2027-01-01' },
  },
  {
    id: 'decline-bandwidth-luck',
    direction: 'inbound',
    from: 'sara.cohen@meta.com',
    body: "Thanks for reaching out. I don't really have bandwidth for calls right now. Best of luck with the search!",
    expect: { signal: 'reply_decline' },
  },
  {
    id: 'decline-left-company',
    direction: 'inbound',
    from: 'jordan.lee@gmail.com',
    body: 'I no longer work at Google, so probably not much help on that front. Sorry!',
    expect: { signal: 'reply_decline' },
  },
  {
    id: 'email-only-questions',
    direction: 'inbound',
    from: 'amy.zhang@goldmansachs.com',
    body: "I don't do coffee chats during recruiting season, but happy to answer a couple of questions over email.\n\nBest,\nAmy",
    expect: { signal: 'question', prefersEmail: true, times: [] },
  },
  {
    id: 'question-after-thanks',
    direction: 'inbound',
    from: 'will.turner@jpmorgan.com',
    body: "thanks for the note. Can you tell me a bit more about what you're hoping to get out of the conversation?",
    expect: { signal: 'question' },
  },
  {
    id: 'ooo-template-no-header',
    direction: 'inbound',
    from: 'felix.wagner@deloitte.com',
    subject: 'Re: Cornell junior, quick question',
    body: 'Thanks for your email. I am traveling this week with limited access to email and will get back to you when I return.',
    expect: { signal: 'out_of_office', returnDate: '2026-10-12', autoReplyBody: true, automated: false },
  },
  {
    id: 'founder-hello-inbox',
    direction: 'inbound',
    from: 'hello@tinystartup.io',
    fromName: 'Maya Chen',
    body: 'Hey Alex, love that you are into dev tools. Happy to chat, grab any time on my Calendly: https://calendly.com/maya-chen/20min',
    expect: {
      signal: 'scheduling_proposal',
      automated: false,
      bodyKeeps: ['https://calendly.com/maya-chen/20min'],
    },
  },
  {
    id: 'campus-recruiting-alias',
    direction: 'inbound',
    from: 'university-recruiting@goldman.com',
    fromName: 'Goldman Sachs University Recruiting',
    body: 'Thank you for your interest in the Goldman Sachs Summer Analyst program. Your application has been received and is under review.',
    expect: { signal: 'reply_neutral', automated: true },
  },
  {
    id: 'docusign-envelope',
    direction: 'inbound',
    from: 'dse_NA4@docusign.net',
    body: 'Please review and sign your offer letter.',
    expect: { signal: 'reply_neutral', automated: true },
  },
  {
    id: 'sig-pipe-name-title-company',
    direction: 'inbound',
    from: 'priya.patel@figma.com',
    fromName: 'Priya Patel',
    body: 'Happy to chat next week.\n\nBest,\nPriya Patel | Product Manager | Figma\n415-555-0100',
    expect: {
      signal: 'reply_positive',
      title: 'Product Manager',
      company: 'Figma',
      bodyDrops: ['415-555-0100'],
    },
  },
  {
    id: 'sig-title-team-org-line',
    direction: 'inbound',
    from: 'dev.patel@figma.com',
    fromName: 'Dev Patel',
    body: 'Sure, happy to share what I know.\n\nThanks,\nDev\nSenior Product Manager, Growth\nFigma',
    expect: { signal: 'reply_positive', title: 'Senior Product Manager, Growth', company: 'Figma' },
  },
  {
    id: 'out-outreach',
    direction: 'outbound',
    from: ALEX,
    body: "Hi Priya, I'm a junior at Cornell studying CS and saw your work on Figma's growth team. Would you be open to a brief chat sometime in the next few weeks?",
    expect: { signal: 'other', times: [] },
  },
  {
    id: 'out-linkedin-thanks',
    direction: 'outbound',
    from: ALEX,
    body: 'Thanks for connecting on LinkedIn! I would love to hear about your path into PM. Would you have 15 minutes next week?',
    expect: { signal: 'other' },
  },
  {
    id: 'out-accept',
    direction: 'outbound',
    from: ALEX,
    body: 'Thanks, Thursday at 2pm works for me. Sending an invite now.',
    expect: { signal: 'scheduling_proposal', times: ['Thu 10/8 14:00'] },
  },
  {
    id: 'out-intro-thanks',
    direction: 'outbound',
    from: ALEX,
    body: 'Thank you for the intro, Mark! Moving you to bcc. Sam, would any of these times work? Tue 10am or Wed 3pm.',
    expect: { signal: 'scheduling_proposal', times: ['Tue 10/6 10:00', 'Wed 10/7 15:00'] },
  },
];

export interface CorpusThread {
  id: string;
  subject: string;
  messages: { from: string; direction: 'inbound' | 'outbound'; body: string; isAutomated?: boolean }[];
  expect: { category: string; isNetworking: boolean };
}

export const THREADS: CorpusThread[] = [
  {
    // the person introduced writes first, in a new thread: nothing in it says "coffee chat", but it is one
    id: 'introduced-person-books-time',
    subject: "Connecting after Sana's note",
    messages: [
      {
        from: 'sebastian.garcia@gs.com',
        direction: 'inbound',
        body: "Hi Alex,\n\nGlad Sana connected us. I'm around Tuesday at 4pm if that works for you.\n\nSebastian",
      },
      {
        from: ALEX,
        direction: 'outbound',
        body: 'Perfect, see you Tuesday at 4pm. Thanks again for making time.',
      },
    ],
    expect: { category: 'networking', isNetworking: true },
  },
  {
    id: 'student-outreach-only',
    subject: 'Cornell student - quick question',
    messages: [
      {
        from: ALEX,
        direction: 'outbound',
        body: "Hi Priya, I'm a junior at Cornell studying CS and saw your work on Figma's growth team. Would you be open to a brief chat sometime in the next few weeks? I'd really value your perspective on breaking into PM.",
      },
    ],
    expect: { category: 'networking', isNetworking: true },
  },
  {
    id: 'student-outreach-reply',
    subject: 'Cornell student - quick question',
    messages: [
      {
        from: ALEX,
        direction: 'outbound',
        body: "Hi Priya, I'm a junior at Cornell studying CS and saw your work on Figma's growth team. Would you be open to a brief chat sometime in the next few weeks?",
      },
      { from: 'priya@figma.com', direction: 'inbound', body: 'Sure, happy to. Does Thursday at 2pm work?' },
    ],
    expect: { category: 'networking', isNetworking: true },
  },
  {
    id: 'student-outreach-sophomore',
    subject: 'Quick question from a Cornell sophomore',
    messages: [
      {
        from: ALEX,
        direction: 'outbound',
        body: "Hi Marcus, I'm a sophomore at Cornell and came across your profile. I'd love to hear how you got into investment banking from a non-target. Any chance you'd have 15 minutes in the next couple weeks?",
      },
    ],
    expect: { category: 'networking', isNetworking: true },
  },
  {
    id: 'student-outreach-alias',
    subject: 'Hello from a fellow Cornellian',
    messages: [
      {
        from: 'ar123@cornell.edu',
        direction: 'inbound',
        body: "Hi Sam, I noticed you also went to Cornell and now work at Stripe. I'm exploring roles in fintech and wondered if you'd be willing to share your perspective on the industry.",
      },
    ],
    expect: { category: 'networking', isNetworking: true },
  },
  {
    id: 'recruiter-phone-screen',
    subject: 'Next steps - Software Engineer Intern',
    messages: [
      {
        from: 'recruiting@stripe.com',
        direction: 'inbound',
        body: "Hi Alex, thanks for connecting with us at the career fair. We'd like to move you forward to a 45 minute technical phone screen with one of our engineers. Please use the link below to pick a time that works for you.",
      },
    ],
    expect: { category: 'recruiting_process', isNetworking: false },
  },
  {
    id: 'recruiter-oa',
    subject: 'Interview availability',
    messages: [
      {
        from: 'talent@databricks.com',
        direction: 'inbound',
        body: 'Congrats on passing the OA! The team would like to connect for a 60-minute interview. Please send over your availability for next week.',
      },
    ],
    expect: { category: 'recruiting_process', isNetworking: false },
  },
  {
    id: 'recruiter-cold-pitch',
    subject: 'Opportunity at Jane Street',
    messages: [
      {
        from: 'jordan@janestreet.com',
        direction: 'inbound',
        body: "Hi Alex, I'm a recruiter at Jane Street and came across your profile. We're hiring for our quant trading intern program and I think your background could be a great fit. Would you have 30 minutes to connect this week so I can tell you more about the role and our team?",
      },
    ],
    expect: { category: 'recruiting_process', isNetworking: false },
  },
  {
    id: 'networking-turns-referral',
    subject: 'Re: Coffee chat follow up',
    messages: [
      {
        from: ALEX,
        direction: 'outbound',
        body: 'Thanks so much for your time yesterday, really enjoyed hearing about your path into product at Figma.',
      },
      {
        from: 'priya@figma.com',
        direction: 'inbound',
        body: "Great chatting with you too! I passed your resume along and the hiring manager wants to set up a phone screen. I'll have our recruiter reach out.",
      },
    ],
    expect: { category: 'networking', isNetworking: true },
  },
  {
    id: 'rejection',
    subject: 'Your application to Google',
    messages: [
      {
        from: 'jobs-noreply-ish@google.com',
        direction: 'inbound',
        body: 'Thank you for your interest in Google. Unfortunately we will not be moving forward with your application at this time. We encourage you to connect with us again in the future.',
      },
    ],
    expect: { category: 'recruiting_process', isNetworking: false },
  },
  {
    id: 'professor-statement',
    subject: 'Personal statement',
    messages: [
      {
        from: 'prof.miller@cornell.edu',
        direction: 'inbound',
        body: "I read your personal statement draft. Let's go over it in office hours Thursday.",
      },
      { from: ALEX, direction: 'outbound', body: 'Thank you, see you Thursday.' },
    ],
    expect: { category: 'personal', isNetworking: false },
  },
  {
    id: 'roommate-payment',
    subject: 'rent',
    messages: [
      {
        from: 'jamie@gmail.com',
        direction: 'inbound',
        body: 'Hey, send me your half of the payment for October when you can.',
      },
      { from: ALEX, direction: 'outbound', body: 'Done, just sent it on Venmo.' },
    ],
    expect: { category: 'personal', isNetworking: false },
  },
  {
    id: 'ta-verify',
    subject: 'PS3',
    messages: [
      {
        from: 'ta.cs3110@cornell.edu',
        direction: 'inbound',
        body: 'Please verify your submission on Gradescope before Friday.',
      },
    ],
    expect: { category: 'other', isNetworking: false },
  },
  {
    id: 'shipping',
    subject: 'Your order has shipped',
    messages: [
      {
        from: 'orders@amazon.com',
        direction: 'inbound',
        body: 'Your order #123 has shipped. Tracking number 1Z999.',
        isAutomated: true,
      },
    ],
    expect: { category: 'automated', isNetworking: false },
  },
  {
    id: 'intro-thread',
    subject: 'Intro: Alex <> Sam',
    messages: [
      {
        from: ALEX,
        direction: 'outbound',
        body: 'Hi Dana, thanks again for chatting last week. Would you be open to introducing me to someone on the growth team?',
      },
      {
        from: 'dana@figma.com',
        direction: 'inbound',
        body: "Of course! Looping in Sam (cc'd) who leads growth. Sam, Alex is a Cornell junior who'd love 15 minutes.",
      },
    ],
    expect: { category: 'networking', isNetworking: true },
  },
];
