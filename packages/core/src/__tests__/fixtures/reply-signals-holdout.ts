import type { SignalExample } from './reply-signals';

/**
 * Reply-signal corpus, held-out part (about 20%). Written together with the tuning part and set aside before any tuning;
 * nothing here was used to change the heuristics. The test only asserts accuracy thresholds on it.
 */
export const HOLDOUT: SignalExample[] = [
  {
    id: 'pos-iphone',
    label: 'positive',
    body: 'Sure, happy to chat. Next week is pretty open for me.\n\nSent from my iPhone',
  },
  {
    id: 'pos-traveling-month',
    label: 'positive',
    body: "Happy to! I'm traveling a bit this month but should be able to make 20 minutes work. Shoot me some times.\n\nRaj Mehta\nSenior Associate, McKinsey & Company",
  },
  {
    id: 'pos-mornings',
    label: 'positive',
    body: 'Of course. Mornings are generally easier for me. Let me know what works for you.',
  },
  {
    id: 'pos-kindly-share',
    label: 'positive',
    body: 'Hello Alex,\n\nThank you for your message. I would be delighted to speak with you. Kindly share your availability for next week.\n\nWarm regards,\nPriya',
  },
  {
    id: 'pos-merci',
    label: 'positive',
    body: 'Merci for reaching out! Happy to chat about my move from Paris to the NYC office. Next week works.\n\nBien à vous,\nCamille',
  },
  {
    id: 'pos-slammed-through-wed',
    label: 'positive',
    body: "Hi Alex, I'd be glad to. I'm slammed through Wednesday, but Thursday or Friday should be fine; send me a time.",
  },
  { id: 'pos-love-this', label: 'positive', body: "Yes! Love this. Let's do it." },
  {
    id: 'pos-intro-thread-bcc',
    label: 'positive',
    body: 'Thanks Lena, moving you to bcc. Alex, great to meet you, happy to chat next week. Let me know what works.',
  },
  {
    id: 'pos-gracias',
    label: 'positive',
    body: 'Hola Alex! Claro, happy to chat about the Mexico City office. Send me a couple of times.\n\nSaludos,\nDiego',
  },
  {
    id: 'q-summer-or-ft',
    label: 'question',
    body: 'Thanks for reaching out. Are you looking at summer analyst roles or full time?',
  },
  {
    id: 'q-what-year',
    label: 'question',
    body: 'Hi! What year are you? We generally recruit juniors for the summer program.',
  },
  {
    id: 'q-apm-or-general',
    label: 'question',
    body: 'Hi Alex, happy to help where I can. Is this about the APM program or general PM advice?',
  },
  {
    id: 'q-career-fair',
    label: 'question',
    body: 'Could you remind me what we discussed at the career fair? I met a lot of students that day.',
  },
  {
    id: 'q-goals',
    label: 'question',
    body: "Happy to try to help. What specifically are you hoping to learn? I'd rather make it useful than generic.",
  },
  {
    id: 'email-schedule-doesnt-allow',
    label: 'email_only',
    body: "Hi Alex, my schedule doesn't really allow for calls these days, but feel free to send me your questions and I'll answer when I can.",
  },
  {
    id: 'email-not-allowed',
    label: 'email_only',
    body: "We're not allowed to do calls with candidates during recruiting season, but I can answer a few questions over email.",
  },
  {
    id: 'email-rather-not-call',
    label: 'email_only',
    body: "I'd prefer not to do a call, but feel free to send any questions my way.",
  },
  {
    id: 'prop-cant-monday-so',
    label: 'proposal',
    body: "I can't do Monday so Tuesday at 2pm works.",
    times: ['Tue 10/6 14:00'],
  },
  {
    id: 'prop-working-out-of-nyc',
    label: 'proposal',
    body: "I'm working out of the NYC office Tuesday at 2pm, happy to meet there.",
    times: ['Tue 10/6 14:00'],
  },
  {
    id: 'prop-wed-et-iphone',
    label: 'proposal',
    body: 'Hi Alex,\n\nThanks for your patience. Would Wednesday at 4:30pm ET work?\n\nBest,\nGreg\n\nSent from my iPhone',
    times: ['Wed 10/7 16:30'],
    zone: 'America/New_York',
  },
  {
    id: 'prop-slash-date',
    label: 'proposal',
    body: 'Could you do 10/7 at 9:30am?',
    times: ['Wed 10/7 09:30'],
  },
  {
    id: 'prop-wouldnt-easier',
    label: 'proposal',
    body: "Wouldn't it be easier to do Tuesday at 2pm? I'm in the city that day anyway.",
    times: ['Tue 10/6 14:00'],
  },
  {
    id: 'prop-range-pt',
    label: 'proposal',
    body: 'Hi Alex! Thursday 10/8, 12-12:30 PT?',
    times: ['Thu 10/8 12:00-12:30'],
    zone: 'America/Los_Angeles',
  },
  {
    id: 'prop-my-time-eastern',
    label: 'proposal',
    body: "Let's do Friday at 9am my time (Eastern).",
    times: ['Fri 10/9 09:00'],
    zone: 'America/New_York',
  },
  {
    id: 'prop-name-then-and',
    label: 'proposal',
    body: 'Thanks Alex! Friday at 11 Sam and I can both join, if that suits.',
    times: ['Fri 10/9 11:00'],
  },
  {
    id: 'prop-standup',
    label: 'proposal',
    body: 'We could do Thursday morning at 8:30 before my standup.',
    times: ['Thu 10/8 08:30'],
  },
  {
    id: 'prop-open-if-you-want',
    label: 'proposal',
    body: 'Hey! Wednesday at 11:30 is open on my end if you want it.',
    times: ['Wed 10/7 11:30'],
  },
  {
    id: 'prop-calendly',
    label: 'proposal',
    body: 'Happy to chat. Booking link here, grab whatever slot works: https://calendly.com/sam-r/15min',
    times: [],
  },
  {
    id: 'prop-monday-no-go',
    label: 'proposal',
    body: "Monday is a no-go for me, but Wednesday at 9 works if you're up early.",
    times: ['Wed 10/7 09:00'],
  },
  {
    id: 'prop-intro-reply-thanks-lena',
    label: 'proposal',
    body: 'Thanks Lena. Alex, happy to chat. Would Tuesday, October 13 at 2pm work?',
    times: ['Tue 10/13 14:00'],
  },
  {
    id: 'prop-something-came-up-new',
    label: 'proposal',
    body: 'Something came up Thursday, could we do Friday at 10am instead?',
    times: ['Fri 10/9 10:00'],
  },
  {
    id: 'prop-quoted-history',
    label: 'proposal',
    body: 'Sure! Would Wednesday at 1:30 work?\n\nBest,\nOmar\n\nOn Fri, Oct 2, 2026 at 4:12 PM Alex Rivera <alex.rivera@cornell.edu> wrote:\n> Hi Omar,\n> Would Monday at 2pm work for a quick chat?\n> Alex\n',
    times: ['Wed 10/7 13:30'],
  },
  {
    id: 'prop-ist-zone',
    label: 'proposal',
    body: 'Hi Alex, I am based in Bangalore. Could we do Wednesday 9pm IST?',
    times: ['Wed 10/7 21:00'],
    zone: 'Asia/Kolkata',
  },
  { id: 'conf-talk-then', label: 'confirmation', body: 'Sounds good, talk then.' },
  { id: 'conf-et-works-great', label: 'confirmation', body: 'Thursday at 2pm ET works great. See you then.' },
  { id: 'conf-got-invite', label: 'confirmation', body: 'Got the invite, accepted. Talk tomorrow!' },
  { id: 'conf-talk-thursday', label: 'confirmation', body: 'Perfect, thanks Alex. Talk to you Thursday.' },
  {
    id: 'conf-moved-invite',
    label: 'confirmation',
    body: "I've moved our invite to Thursday at 4pm, see you then.",
  },
  { id: 'conf-invite-sent', label: 'confirmation', body: 'Done, invite sent for Thu 10/8 at 3pm ET.' },
  {
    id: 'conf-quoted',
    label: 'confirmation',
    body: 'Works for me. See you Wednesday!\n\nOn Fri, Oct 2, 2026 at 4:12 PM Alex Rivera <alex.rivera@cornell.edu> wrote:\n> Hi Dana,\n> Would Wednesday at 3pm work?\n> Alex\n',
  },
  {
    id: 'resch-flight',
    label: 'reschedule',
    body: "I need to push our call, my flight got moved. I'll send some new times soon.",
  },
  {
    id: 'resch-bump-sick',
    label: 'reschedule',
    body: 'Hey, need to bump our chat, sick kid at home. Sorry!',
  },
  {
    id: 'resch-friday-week-after',
    label: 'reschedule',
    body: 'Hi Alex, I have to move our Friday chat. Would the week after work instead?',
  },
  { id: 'dh-pass-this-time', label: 'decline_hard', body: "I'll pass this time." },
  { id: 'dh-remove-list', label: 'decline_hard', body: 'Please take me off your list.' },
  {
    id: 'dh-not-a-good-fit',
    label: 'decline_hard',
    body: "Not a good fit for me to chat, sorry. I'm on the buy side now.",
  },
  { id: 'dh-dont-email', label: 'decline_hard', body: 'Please do not email me again.' },
  {
    id: 'dh-no-coffee-moment',
    label: 'decline_hard',
    body: "I'm not taking any coffee chats at the moment.",
  },
  {
    id: 'dh-no-informationals',
    label: 'decline_hard',
    body: "Respectfully, I don't do informational interviews.",
  },
  {
    id: 'dh-dont-take-calls-strangers',
    label: 'decline_hard',
    body: "Unfortunately I don't take calls with students I haven't met. Sorry!",
  },
  { id: 'dh-iphone', label: 'decline_hard', body: 'Not something I can do, sorry.\n\nSent from my iPhone' },
  {
    id: 'ds-brief-slammed',
    label: 'decline_soft',
    body: 'Slammed this quarter, maybe in the new year.',
    followUpAfter: '2027-01-01',
  },
  {
    id: 'ds-reorg-few-weeks',
    label: 'decline_soft',
    body: "Not a great time right now, we're in the middle of a reorg. Try me again in a few weeks.",
    followUpAfter: '2026-10-26',
  },
  {
    id: 'ds-fall-busy',
    label: 'decline_soft',
    body: 'Hi Alex, appreciate the note. Unfortunately this fall is really busy for me. Good luck with recruiting!',
  },
  {
    id: 'ds-underwater-november',
    label: 'decline_soft',
    body: "Wish I could help but I'm underwater until mid-November. Feel free to follow up then.",
    followUpAfter: '2026-11-01',
  },
  {
    id: 'ds-not-sure-right-person',
    label: 'decline_soft',
    awaiting: true,
    body: "Good luck with the search, Alex. I'm not sure I'm the right person, but I hope it goes well.",
  },
  {
    id: 'ds-no-longer-at',
    label: 'decline_soft',
    body: "Hi Alex, I'm no longer with Bain, so I'm not sure how useful I'd be. Good luck!",
  },
  {
    id: 'ooo-traveling-return',
    label: 'ooo',
    body: "Hi, I'm currently traveling with limited access to email and will respond when I return on 10/14.",
  },
  {
    id: 'ooo-vacation-hand',
    label: 'ooo',
    body: "Hey Alex, I'm on vacation this week, back Monday. Will reply properly then!",
  },
  {
    id: 'ooo-sabbatical',
    label: 'ooo',
    body: "Hi there, I'm on sabbatical until November 2 and not checking email regularly. Thanks for understanding.",
  },
  {
    id: 'intro-ana-rotation',
    label: 'intro',
    body: 'Happy to chat next week! You should talk to Ana on my team too, she did the same rotation.',
  },
  {
    id: 'intro-priya-shah',
    label: 'intro',
    body: 'Definitely happy to chat. You might also want to talk to Priya Shah, she ran the analyst program for years. Happy to connect you two after our call.',
  },
  {
    id: 'intro-lowercase-jen',
    label: 'intro',
    body: 'happy to hop on a call! also you should def talk to my friend jen at stripe, i can connect you',
  },
  {
    id: 'intro-offer-only',
    label: 'intro',
    body: 'Good luck this cycle. If it would help, I could intro you to a couple of people on the strategy team.',
  },
  {
    id: 'ih-looping-sam-meet',
    label: 'intro_handoff',
    body: "Looping in Sam (cc'd) who leads our analytics team. Sam, meet Alex, a junior at Cornell.",
  },
  {
    id: 'ih-better-off-chicago',
    label: 'intro_handoff',
    body: "You'd be better off talking to someone in the Chicago office. Copying Dana Lee, who leads the analyst class there.",
  },
  {
    id: 'ih-adding-rui',
    label: 'intro_handoff',
    body: 'Adding Rui here, he can find time with you next week.',
  },
  { id: 'ih-dash-meet', label: 'intro_handoff', body: 'Alex - meet Sam. Sam leads analytics at Northwind.' },
  {
    id: 'ih-rachel-better-fit',
    label: 'intro_handoff',
    body: "My colleague Rachel is a much better fit for your questions. I've cc'd her here so you two can connect.",
  },
  {
    id: 'ih-wrong-team',
    label: 'intro_handoff',
    body: "Hey Alex, I'm on the infra side so I'm not the right contact for design questions. Try Mei Lin on our design team, she's great.",
  },
  {
    id: 'ref-submitted-workday',
    label: 'referral',
    body: 'I just submitted a referral for you for the SWE intern role. You should get an email from Workday soon.',
  },
  { id: 'ref-good-word', label: 'referral', body: "Sure, I'll put in a good word with the recruiter." },
  {
    id: 'ref-which-role',
    label: 'referral',
    body: "Let me know which role and I'll refer you through our portal.",
  },
  {
    id: 'ref-forwarded-no-i',
    label: 'referral',
    body: "Forwarded your resume to Jenna on the hiring team. She'll be in touch if there's a fit.",
  },
  {
    id: 'ref-pass-that-along',
    label: 'referral',
    body: "I'll pass that along to my manager and get back to you.",
  },
  {
    id: 'ty-superday',
    label: 'thank_you',
    body: 'Thanks for the great conversation earlier. Good luck with the superday!',
  },
  {
    id: 'ty-nice-talking-resume',
    label: 'thank_you',
    body: 'Nice talking with you, Alex. Send me that resume when you have a sec.',
  },
  {
    id: 'ty-out-call-yesterday',
    label: 'thank_you',
    direction: 'outbound',
    body: "Thanks again for the call yesterday! I'll keep you posted on the application.",
  },
  {
    id: 'ty-out-lowercase',
    label: 'thank_you',
    direction: 'outbound',
    body: 'thanks so much for the chat today, super helpful!',
  },
  { id: 'neu-well-done', label: 'neutral', body: 'Wow, well done. Best of luck this summer!' },
  { id: 'neu-rooting', label: 'neutral', body: 'Good luck on the final round! Rooting for you.' },
  { id: 'neu-take-look', label: 'neutral', body: 'Thanks for sending, will take a look this week.' },
  {
    id: 'neu-small-world',
    label: 'neutral',
    body: 'Ha, small world! I was in the same frat. Anyway, best of luck!',
  },
  { id: 'neu-great-opportunity', label: 'neutral', body: 'Sounds like a great opportunity. Best of luck!' },
  { id: 'neu-way-to-go', label: 'neutral', body: 'Way to go! Best of luck with the rest of the summer.' },
  {
    id: 'out-bump',
    label: 'other',
    direction: 'outbound',
    body: "Just bumping this in case it got buried. Totally understand if now isn't a good time.",
  },
  {
    id: 'out-propose',
    label: 'proposal',
    direction: 'outbound',
    body: 'Thanks for getting back to me! Would Thursday at 2pm or Friday at 11am PT work?',
    times: ['Thu 10/8 14:00', 'Fri 10/9 11:00'],
    zone: 'America/Los_Angeles',
  },
  // Blind-test round: half of the replies a tester wrote without seeing the corpus, set aside before tuning.
  {
    id: 'bt-pos-what-times',
    label: 'positive',
    body: 'Yes of course!! Would love to. What times work for you?',
  },
  {
    id: 'bt-prop-monday-10am',
    label: 'proposal',
    body: 'Happy to chat! Monday works. 10am?',
    times: ['Mon 10/5 10:00'],
  },
  {
    id: 'bt-resched-thursday',
    label: 'reschedule',
    body: "I won't be able to make Thursday, I'm afraid. Can we find another time?",
  },
  {
    id: 'bt-dh-many-requests',
    label: 'decline_hard',
    body: "Hi Jordan,\n\nI appreciate you reaching out. I get a lot of these requests and unfortunately can't take them on. I wish you the best in your search.\n\nRegards,\nM. Patel",
  },
  { id: 'bt-dh-thx-but-no', label: 'decline_hard', body: 'thx but no' },
  {
    id: 'bt-ds-year-end-close',
    label: 'decline_soft',
    body: 'Timing is rough right now with year-end close. Reach back out in a couple months.',
  },
  {
    id: 'bt-ds-mentees-next-fall',
    label: 'decline_soft',
    body: "I'm not taking on any new mentees this year, sorry. Maybe reach out next fall?",
  },
  {
    id: 'bt-ih-rachel-bain',
    label: 'intro_handoff',
    body: "You should definitely talk to my old manager Rachel Green — she's at Bain now. Want me to introduce you?",
  },
  {
    id: 'bt-ref-program',
    label: 'referral',
    body: "We have an employee referral program; I'd be glad to put your name in.",
  },
  {
    id: 'bt-eo-phone-here',
    label: 'email_only',
    body: "Phone isn't great for me — I'm happy to answer a few questions here though.",
  },
  {
    id: 'bt-ty-follow-up-note',
    label: 'thank_you',
    body: 'Thank you for the follow-up note, glad it was helpful. Keep in touch!',
  },
  // Round five hold-out: fresh replies in the families the fifth blind round missed (an assistant or office scheduler
  // added, a "not this day" before another day, postpone, "won't be able to take this on", no call but email, a
  // referral put in, "pass along my best", a thank-you that starts with "appreciated"). Written before the fix and
  // scored blind at 9 of 24. The fix was written against the tuning part's blind misses and variants; its misses
  // here were in the same families and were visible while fixing, so read the after-fix 24 of 24 with that in mind.
  {
    id: 'r5h-pos-runs-calendar',
    label: 'positive',
    body: 'Happy to help. Adding Marisol, who runs my calendar, so she can find us 30 minutes.',
  },
  {
    id: 'r5h-pos-dave-schedule',
    label: 'positive',
    body: "Cc'ing Dave on my team, who manages my schedule; he'll get something set up.",
  },
  {
    id: 'r5h-pos-office-sort',
    label: 'positive',
    body: "Yes, let's do it. I've copied Priya from my office and she'll sort out a time.",
  },
  {
    id: 'r5h-pos-plus-assistant',
    label: 'positive',
    body: 'Sounds good. + Tom (my assistant) to coordinate.',
  },
  {
    id: 'r5h-prop-tuesday-no-good',
    label: 'proposal',
    body: "Tuesday's no good for me, unfortunately. Any chance Thursday afternoon works?",
  },
  {
    id: 'r5h-prop-not-this-week',
    label: 'proposal',
    body: "Can't do this week, sorry. How's Monday morning next week?",
  },
  {
    id: 'r5h-res-mind-postpone',
    label: 'reschedule',
    body: "Mind if we postpone? I've got a deadline tonight.",
  },
  {
    id: 'r5h-res-ok-postpone',
    label: 'reschedule',
    body: 'Would it be ok to postpone our call? My flight got moved.',
  },
  {
    id: 'r5h-dh-cant-take-on',
    label: 'decline_hard',
    body: 'I appreciate you thinking of me, but unfortunately I can’t take this on.',
  },
  {
    id: 'r5h-dh-wont-help',
    label: 'decline_hard',
    body: "Thanks for asking. Unfortunately I won't be able to help with this one.",
  },
  {
    id: 'r5h-dh-sadly-not-going-to',
    label: 'decline_hard',
    body: "Sadly I'm not going to be able to do this. Wishing you the best.",
  },
  {
    id: 'r5h-eo-call-hard',
    label: 'email_only',
    body: 'A call is hard to fit in right now, but happy to answer questions over email.',
  },
  {
    id: 'r5h-eo-cant-commit',
    label: 'email_only',
    body: "Can't commit to a call these days. Email me your questions though and I'll reply.",
  },
  {
    id: 'r5h-eo-calls-dont-work',
    label: 'email_only',
    body: "Calls don't really work with my schedule, but feel free to email any questions.",
  },
  {
    id: 'r5h-ref-job-id',
    label: 'referral',
    body: 'Happy to put in a referral for you. Send me the job ID when you have it.',
  },
  {
    id: 'r5h-ref-employee-referral',
    label: 'referral',
    body: 'I could submit an employee referral if you want, just say the word.',
  },
  {
    id: 'r5h-ref-req-number',
    label: 'referral',
    body: "Send me the req number and I'll put a referral in.",
  },
  {
    id: 'r5h-pos-pass-thanks',
    label: 'positive',
    body: 'Pass along my thanks to Professor Diaz! And yes, happy to chat next week.',
  },
  {
    id: 'r5h-pos-regards-dad',
    label: 'positive',
    body: 'Please pass my regards to your dad. Happy to find a time, what works for you?',
  },
  {
    id: 'r5h-ty-appreciated-chat',
    label: 'thank_you',
    body: 'Really appreciated our chat this morning. Thanks again for the thoughtful questions.',
  },
  {
    id: 'r5h-ty-appreciated-call',
    label: 'thank_you',
    body: 'Appreciated the call today, thanks for taking the time.',
  },
  {
    id: 'r5h-ih-looping-colleague',
    label: 'intro_handoff',
    body: "I'm not the right person for this, but looping in my colleague Ana, who runs our new grad program.",
  },
  {
    id: 'r5h-ques-what-team',
    label: 'question',
    body: 'Happy to answer what I can. What team are you hoping to join?',
  },
  {
    id: 'r5h-neutral-noted',
    label: 'neutral',
    body: "Noted, I'll keep an eye out for your application.",
  },
  // Round six hold-out: fresh replies in the families the sixth blind round missed (a hand-typed away note that defers
  // the reply, an intro offered as a question or as "happy to make the connection", a thank-you after a meeting that
  // says "a pleasure" or "enjoyed meeting you", a time in another city's clock accepted with "works for me"). Written
  // before the fix and scored once blind at 9 of 16, never tuned on; 15 of 16 after the fix, which was written against
  // the tuning part's misses and variants ("What a sweet note, thank you!" is still read as neutral).
  {
    id: 'r6h-ooo-patchy-signal',
    label: 'ooo',
    body: "Hey! I'm on a work trip with patchy signal this week. Will get back to you properly once I'm home.",
  },
  {
    id: 'r6h-ooo-abroad-wifi',
    label: 'ooo',
    body: "Quick note from abroad, the wifi here is unreliable. I'll respond in full when I'm back on the 19th.",
  },
  {
    id: 'r6h-ooo-camping',
    label: 'ooo',
    body: 'Camping till Sunday with no service, will answer when I get back!',
  },
  {
    id: 'r6h-pos-was-traveling',
    label: 'positive',
    body: 'Sorry for the slow reply, I was traveling with spotty wifi. Happy to chat, send me a few times.',
  },
  {
    id: 'r6h-intro-want-me',
    label: 'intro',
    body: 'Want me to connect you with a friend who recruits for Bain? Glad to do it.',
  },
  {
    id: 'r6h-intro-should-i',
    label: 'intro',
    body: 'Should I put you in touch with my old manager at Deloitte? She hires analysts every year.',
  },
  {
    id: 'r6h-intro-would-it-help',
    label: 'intro',
    body: 'Would it help if I introduced you to someone on the PM team at Google? Happy to make an introduction.',
  },
  {
    id: 'r6h-intro-interested',
    label: 'intro',
    body: 'Would you be interested in an intro to our head of design? Just say the word.',
  },
  {
    id: 'r6h-q-who-introduced',
    label: 'question',
    body: 'Who introduced you to me again? I want to thank them.',
  },
  {
    id: 'r6h-ty-pleasure-meeting',
    label: 'thank_you',
    body: 'It was a real pleasure meeting you yesterday. Thanks for the thoughtful questions.',
  },
  {
    id: 'r6h-ty-stopping-by',
    label: 'thank_you',
    body: 'Thanks for stopping by the booth today, really enjoyed talking with you.',
  },
  {
    id: 'r6h-ty-sweet-note',
    label: 'thank_you',
    body: 'What a sweet note, thank you! Loved hearing about your first week.',
  },
  {
    id: 'r6h-ty-enjoyed-meeting-team',
    label: 'thank_you',
    body: 'Thanks for coming in to meet the team. We all enjoyed meeting you.',
  },
  {
    id: 'r6h-pos-pleasure-happy',
    label: 'positive',
    body: 'Pleasure meeting you at the fair! Happy to chat more next week, send me a couple of times.',
  },
  {
    id: 'r6h-conf-new-york-time',
    label: 'confirmation',
    body: 'Friday at 10 New York time works for me.',
    times: ['Fri 10/9 10:00'],
    zone: 'America/New_York',
  },
  {
    id: 'r6h-prop-london-instead',
    label: 'proposal',
    body: 'Could we do Thursday at 4 London time instead?',
    times: ['Thu 10/8 16:00'],
    zone: 'Europe/London',
  },
];
