import type { ReplyClass } from '../../email/replyClass';

/**
 * Reply classes v2 (plan 16 §8.1), tuning part: the three classes the v1 signal reader has no label for. Sales,
 * fundraising, hiring, research and student replies, on email and LinkedIn. The other eight classes are scored on
 * the v1 corpus (reply-signals-*.ts), mapped to the eleven classes in reply-signals.ts.
 */
export interface ReplyClassExample {
  id: string;
  cls: ReplyClass;
  body: string;
  /** the chat is still waiting on an answer to the student's ask */
  awaiting?: boolean;
}

export const TRAIN_V2: ReplyClassExample[] = [
  // objection: a concern about the offer (price, fit, the tool they already use, stage, terms) that could be answered
  {
    id: 'v2-obj-gong',
    cls: 'objection',
    body: "Thanks, but we already use Gong for call recording and we're pretty happy with it.",
  },
  {
    id: 'v2-obj-in-house',
    cls: 'objection',
    body: "Appreciate the note. We built something similar in-house last year, so I don't see us switching.",
  },
  {
    id: 'v2-obj-pricing-team-size',
    cls: 'objection',
    body: "Honestly the pricing is the issue. At that number it's hard to justify for a team our size.",
  },
  {
    id: 'v2-obj-salesforce-contract',
    cls: 'objection',
    body: "We're locked into a contract with Salesforce until next summer, so this isn't really on the table.",
  },
  {
    id: 'v2-obj-series-a-mandate',
    cls: 'objection',
    body: 'Interesting, but we invest at Series A and later. Pre-seed is outside our mandate.',
  },
  {
    id: 'v2-obj-thesis',
    cls: 'objection',
    body: "Climate software isn't really in our thesis, so I'm not the right investor for this one.",
  },
  {
    id: 'v2-obj-happy-at-stripe',
    cls: 'objection',
    body: "I'm really happy at Stripe and not looking to leave.",
  },
  {
    id: 'v2-obj-no-budget-procurement',
    cls: 'objection',
    body: 'There is no budget for anything like this, and procurement is a nightmare for us.',
  },
  {
    id: 'v2-obj-soc2',
    cls: 'objection',
    body: "Our security team won't approve a vendor without SOC 2, which it sounds like you don't have yet.",
  },
  {
    id: 'v2-obj-tried-before',
    cls: 'objection',
    body: 'We tried a tool like this two years ago and adoption was terrible, so the team is skeptical.',
  },
  {
    id: 'v2-obj-hubspot-different',
    cls: 'objection',
    body: "I don't see how this is different from what HubSpot already gives us.",
  },
  {
    id: 'v2-obj-overkill',
    cls: 'objection',
    body: "We're a three person team, this feels like overkill for us.",
  },
  {
    id: 'v2-obj-crowded-market',
    cls: 'objection',
    body: 'The market feels pretty crowded to me. What makes you think you can win against the incumbents?',
  },
  {
    id: 'v2-obj-arr-first',
    cls: 'objection',
    body: 'Your traction is a bit early for us. We usually want to see a few hundred thousand in ARR first.',
  },
  {
    id: 'v2-obj-venture-scale',
    cls: 'objection',
    body: "I'm not convinced the problem is big enough for a venture-scale outcome.",
  },
  {
    id: 'v2-obj-comp-above',
    cls: 'objection',
    body: 'Compensation would need to be well above what you mentioned for me to consider it.',
  },
  {
    id: 'v2-obj-relocating',
    cls: 'objection',
    body: "Relocating to Austin is a non-starter for me, I'm staying in New York.",
  },
  {
    id: 'v2-obj-lab-overlap',
    cls: 'objection',
    body: "Our lab doesn't really work on causal methods, so I'm not sure there's enough overlap for a collaboration.",
  },
  {
    id: 'v2-obj-agency',
    cls: 'objection',
    body: "Thanks, but we handle all of our recruiting through an agency and don't work with outside platforms.",
  },
  {
    id: 'v2-obj-vendor-policy',
    cls: 'objection',
    body: 'We have a policy against adding new vendors mid-year, and I doubt procurement would make an exception.',
  },
  {
    id: 'v2-obj-on-prem',
    cls: 'objection',
    body: "Not a fit for us, our data has to stay on-prem and you're cloud only.",
  },
  {
    id: 'v2-obj-erp-integration',
    cls: 'objection',
    body: "The integration with our ERP would be a big lift and we don't have engineering time for it.",
  },
  {
    id: 'v2-obj-per-seat',
    cls: 'objection',
    body: 'My concern is the price per seat. We have 400 reps and it adds up fast.',
  },
  {
    id: 'v2-obj-reporting-last-year',
    cls: 'objection',
    body: "We looked at you last year and the reporting wasn't where we needed it.",
  },
  {
    id: 'v2-obj-cfo-freeze',
    cls: 'objection',
    body: 'Seems like a nice product but our CFO has frozen all new software spend.',
  },
  {
    id: 'v2-obj-cap-table',
    cls: 'objection',
    body: "I'd worry about the cap table. Two angels already own a big chunk and that's a red flag for us.",
  },
  {
    id: 'v2-obj-solo-founders',
    cls: 'objection',
    body: "We generally don't back solo founders at this stage.",
  },
  {
    id: 'v2-obj-hardware',
    cls: 'objection',
    body: "Hardware is outside what our fund does, so this one isn't for us.",
  },
  {
    id: 'v2-obj-role-junior',
    cls: 'objection',
    body: "The role sounds more junior than what I'm doing now.",
  },
  {
    id: 'v2-obj-remote-only',
    cls: 'objection',
    body: "I'm only open to remote roles, and this one is in office five days a week.",
  },
  {
    id: 'v2-obj-snowflake',
    cls: 'objection',
    body: "We're committed to Snowflake and moving off it isn't something we'd consider.",
  },
  {
    id: 'v2-obj-legal-ai',
    cls: 'objection',
    body: 'This would need sign off from legal and they are very conservative about AI tools.',
  },
  {
    id: 'v2-obj-contract-minimum',
    cls: 'objection',
    body: "The contract minimum is too high for a pilot. We'd need something month to month.",
  },
  {
    id: 'v2-obj-roi',
    cls: 'objection',
    body: 'We get a lot of these pitches and the ROI never holds up once we run the numbers.',
  },
  {
    id: 'v2-obj-proof-pay',
    cls: 'objection',
    body: "Honestly, the space is too early for us to take a view. We'd want to see more proof that customers will pay.",
  },
  {
    id: 'v2-obj-linkedin-current-tool',
    cls: 'objection',
    body: 'hey, we use Apollo already for this and it does the job for us',
  },

  // not now: a timing push-back that invites coming back later
  {
    id: 'v2-nn-launch-january',
    cls: 'not_now',
    body: "Love this, but we're heads down on our launch. Can you reach back out in January?",
  },
  {
    id: 'v2-nn-q2-planning',
    cls: 'not_now',
    body: "Not the right time for us. Let's revisit after Q2 planning.",
  },
  {
    id: 'v2-nn-fund-spring',
    cls: 'not_now',
    body: "We're not deploying new capital until our next fund closes in the spring. Reach out then.",
  },
  {
    id: 'v2-nn-reorg',
    cls: 'not_now',
    body: "Timing is bad, we're mid-reorg. Circle back in a couple of months?",
  },
  {
    id: 'v2-nn-holidays-frozen',
    cls: 'not_now',
    body: 'Can you follow up after the holidays? Everything is frozen until then.',
  },
  {
    id: 'v2-nn-budgets-next-quarter',
    cls: 'not_now',
    body: "Interesting! We're finalizing budgets now though. Ping me next quarter.",
  },
  {
    id: 'v2-nn-hiring-next-year',
    cls: 'not_now',
    body: "I'm not hiring for that team until next year. Keep in touch and reach out then.",
  },
  {
    id: 'v2-nn-sales-team-mid-year',
    cls: 'not_now',
    body: "We're too early for this. Check back once we have a sales team, probably mid next year.",
  },
  {
    id: 'v2-nn-parental-leave',
    cls: 'not_now',
    body: "I'm out on parental leave starting next week. Let's pick this up in March.",
  },
  {
    id: 'v2-nn-push-new-year',
    cls: 'not_now',
    body: 'Could we push this to the new year? December is a blur.',
  },
  {
    id: 'v2-nn-roadmap-h2',
    cls: 'not_now',
    body: "This is on our roadmap but not until the second half of next year. Let's reconnect closer to then.",
  },
  {
    id: 'v2-nn-vendors-q1',
    cls: 'not_now',
    body: "We're evaluating vendors in Q1. Send me something then and I'll take a look.",
  },
  {
    id: 'v2-nn-conference-november',
    cls: 'not_now',
    body: 'My plate is full until the conference wraps up. Try me again in November.',
  },
  {
    id: 'v2-nn-head-of-sales',
    cls: 'not_now',
    body: "Not now, but maybe later this year once we've hired a head of sales.",
  },
  {
    id: 'v2-nn-further-along',
    cls: 'not_now',
    body: "Let's talk again when you're further along. Keep me posted on your progress.",
  },
  {
    id: 'v2-nn-next-spring',
    cls: 'not_now',
    body: "I'm not looking right now, but I might be open to it next spring.",
  },
  {
    id: 'v2-nn-hiring-freeze-july',
    cls: 'not_now',
    body: "We're in a hiring freeze until the end of the fiscal year. Reach out in July.",
  },
  {
    id: 'v2-nn-finals',
    cls: 'not_now',
    body: 'Swamped with finals. Can we connect after the semester ends?',
  },
  {
    id: 'v2-nn-new-role-settle',
    cls: 'not_now',
    body: "Just started a new role, so give me a few months to settle in and then let's chat.",
  },
  {
    id: 'v2-nn-migration',
    cls: 'not_now',
    body: "We're mid-migration. Once that's done in a couple of months I'd be happy to look.",
  },
  {
    id: 'v2-nn-busy-season-february',
    cls: 'not_now',
    body: 'Q4 is our busy season. Reach out again in February.',
  },
  {
    id: 'v2-nn-traveling-december',
    cls: 'not_now',
    body: "Would love to, but I'm traveling for the next six weeks. Can we revisit when I'm back in December?",
  },
  {
    id: 'v2-nn-board-meeting',
    cls: 'not_now',
    body: 'Bad timing on our end. Check in with me after our board meeting next month.',
  },
  {
    id: 'v2-nn-contract-next-fall',
    cls: 'not_now',
    body: 'We just signed with someone for this year, but our contract is up next fall. Worth reconnecting then.',
  },
  {
    id: 'v2-nn-peak-season',
    cls: 'not_now',
    body: "I can't take this on during peak season. Maybe in the slow months after Easter?",
  },
  {
    id: 'v2-nn-priority-quarter',
    cls: 'not_now',
    body: 'Not a priority this quarter. Happy to revisit next quarter.',
  },
  {
    id: 'v2-nn-fully-deployed',
    cls: 'not_now',
    body: 'Our fund is fully deployed for the year. Please keep us posted and reach out in early 2027.',
  },
  {
    id: 'v2-nn-budget-cycle-april',
    cls: 'not_now',
    body: "We won't make a decision on this until the new budget cycle in April. Circle back then.",
  },
  {
    id: 'v2-nn-six-months',
    cls: 'not_now',
    body: "Love what you're building, but it's too early for us to engage. Let's reconnect in six months.",
  },
  {
    id: 'v2-nn-grant-deadlines',
    cls: 'not_now',
    body: "I'm buried in grant deadlines through the end of the month. Could we talk in a few weeks?",
  },
  {
    id: 'v2-nn-launch-month',
    cls: 'not_now',
    body: 'Let me get through this product launch first. Ping me again in a month or so.',
  },
  {
    id: 'v2-nn-acquisition',
    cls: 'not_now',
    body: "We're pausing all new partnerships until the acquisition closes. Reach out after that and we can talk.",
  },
  {
    id: 'v2-nn-move-remind',
    cls: 'not_now',
    body: 'Things are hectic with the move. Can you remind me in a couple of weeks?',
  },
  {
    id: 'v2-nn-capacity-new-year',
    cls: 'not_now',
    body: 'The team is at capacity right now. Revisit in the new year?',
  },
  {
    id: 'v2-nn-applications-summer',
    cls: 'not_now',
    body: 'Not this cycle, but we open applications again next summer. Reach out then.',
  },
  {
    id: 'v2-nn-pilot-customer',
    cls: 'not_now',
    body: "Let's hold off for now and reconnect once you have a pilot customer or two.",
  },

  // unsubscribe: stop writing to me
  { id: 'v2-unsub-mailing-list', cls: 'unsubscribe', body: 'Please remove me from your mailing list.' },
  { id: 'v2-unsub-stop-emailing', cls: 'unsubscribe', body: 'Stop emailing me.' },
  { id: 'v2-unsub-lower', cls: 'unsubscribe', body: 'unsubscribe' },
  { id: 'v2-unsub-take-off-please', cls: 'unsubscribe', body: 'Take me off your list, please.' },
  { id: 'v2-unsub-do-not-contact', cls: 'unsubscribe', body: 'Please do not contact me again.' },
  {
    id: 'v2-unsub-not-interested-stop',
    cls: 'unsubscribe',
    body: "I'm not interested. Please stop reaching out.",
  },
  { id: 'v2-unsub-sequence', cls: 'unsubscribe', body: 'Remove me from this sequence.' },
  {
    id: 'v2-unsub-delete-email',
    cls: 'unsubscribe',
    body: "How did you get my email? Please delete it and don't write again.",
  },
  { id: 'v2-unsub-stop-caps', cls: 'unsubscribe', body: 'STOP' },
  { id: 'v2-unsub-unsubscribe-me', cls: 'unsubscribe', body: 'Please unsubscribe me from these emails.' },
  {
    id: 'v2-unsub-asked-twice',
    cls: 'unsubscribe',
    body: "I've asked twice already. Remove my address from your database.",
  },
  { id: 'v2-unsub-opt-me-out', cls: 'unsubscribe', body: 'Opt me out of any future emails.' },
  { id: 'v2-unsub-no-more', cls: 'unsubscribe', body: 'No more emails please.' },
  { id: 'v2-unsub-dont-email-again', cls: 'unsubscribe', body: "Don't email me again." },
  { id: 'v2-unsub-stop-messages', cls: 'unsubscribe', body: 'Please stop sending me these messages.' },
  { id: 'v2-unsub-kindly-remove', cls: 'unsubscribe', body: 'Kindly remove me from your contact list.' },
  {
    id: 'v2-unsub-whatever-list',
    cls: 'unsubscribe',
    body: 'Please take my name off whatever list this is.',
  },
  { id: 'v2-unsub-didnt-sign-up', cls: 'unsubscribe', body: "I didn't sign up for this. Unsubscribe me." },
  { id: 'v2-unsub-spamming', cls: 'unsubscribe', body: 'Stop spamming me.' },
  {
    id: 'v2-unsub-third-email',
    cls: 'unsubscribe',
    body: 'This is the third email. Please stop contacting me.',
  },
  { id: 'v2-unsub-remove-bare', cls: 'unsubscribe', body: 'Remove me.' },
  { id: 'v2-unsub-this-address', cls: 'unsubscribe', body: 'Do not email this address again.' },
  { id: 'v2-unsub-lose-email', cls: 'unsubscribe', body: 'Please lose my email address.' },
  {
    id: 'v2-unsub-opt-out-communication',
    cls: 'unsubscribe',
    body: "I'd like to opt out of further communication.",
  },
  { id: 'v2-unsub-cease', cls: 'unsubscribe', body: 'Please cease all contact.' },
  {
    id: 'v2-unsub-dont-follow-up',
    cls: 'unsubscribe',
    body: "Not interested, and please don't follow up.",
  },
  {
    id: 'v2-unsub-outreach-list',
    cls: 'unsubscribe',
    body: 'Take me off your outreach list immediately.',
  },
  { id: 'v2-unsub-linkedin-here', cls: 'unsubscribe', body: 'Please stop messaging me on here.' },
  {
    id: 'v2-unsub-dont-want-more',
    cls: 'unsubscribe',
    body: "I don't want to receive any more of these. Remove me please.",
  },
  { id: 'v2-unsub-do-not-contact-mark', cls: 'unsubscribe', body: 'Please mark me as do not contact.' },
  { id: 'v2-unsub-everything', cls: 'unsubscribe', body: 'Unsubscribe me from everything, thanks.' },
  {
    id: 'v2-unsub-about-anything',
    cls: 'unsubscribe',
    body: "Please don't reach out to me again about this or anything else.",
  },
  {
    id: 'v2-unsub-work-address',
    cls: 'unsubscribe',
    body: 'Can you stop emailing my work address? Thanks.',
  },
  { id: 'v2-unsub-from-system', cls: 'unsubscribe', body: 'Please remove this email from your system.' },
  { id: 'v2-unsub-end-these', cls: 'unsubscribe', body: 'End these emails, please.' },
  { id: 'v2-unsub-campaigns', cls: 'unsubscribe', body: 'Do not add me to any more campaigns.' },
];
