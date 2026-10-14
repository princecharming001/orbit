import type { ReplyClassExample } from './reply-signals-v2-train';

/**
 * Reply classes v2, held-out part (about 20% of the objection, not-now and unsubscribe examples). Written with the
 * tuning part and set aside before the rules in email/replyClass.ts were written; nothing here was used to tune them.
 */
export const HOLDOUT_V2: ReplyClassExample[] = [
  // objection
  {
    id: 'v2h-obj-outreach-switching',
    cls: 'objection',
    body: "We're pretty invested in Outreach at this point and the switching cost is real.",
  },
  {
    id: 'v2h-obj-valuation',
    cls: 'objection',
    body: "Your valuation is well above where we'd be comfortable for a company at this stage.",
  },
  {
    id: 'v2h-obj-spreadsheets',
    cls: 'objection',
    body: "I don't think our team would use it, they live in spreadsheets.",
  },
  {
    id: 'v2h-obj-recruiting-firm',
    cls: 'objection',
    body: 'Thanks, but we already work with a recruiting firm on all our engineering hires.',
  },
  {
    id: 'v2h-obj-base-too-low',
    cls: 'objection',
    body: 'The equity sounds great but the base is too low for me to leave my current job.',
  },
  {
    id: 'v2h-obj-hospitals',
    cls: 'objection',
    body: "I'm skeptical that hospitals will buy this. Sales cycles there are brutal.",
  },
  {
    id: 'v2h-obj-microsoft-shop',
    cls: 'objection',
    body: "We're a Microsoft shop, so anything that only works with Google Workspace is a non-starter.",
  },
  {
    id: 'v2h-obj-single-cell',
    cls: 'objection',
    body: "Our research is on single-cell methods, so I'm not sure there's real overlap with your work on causal inference.",
  },
  {
    id: 'v2h-obj-cost-sticking',
    cls: 'objection',
    body: 'Cost is the sticking point. We spend a fraction of that on our current setup.',
  },
  // not now
  {
    id: 'v2h-nn-planning-march',
    cls: 'not_now',
    body: "This sounds great but we're in the middle of planning season. Follow up in March?",
  },
  {
    id: 'v2h-nn-deadline-friday',
    cls: 'not_now',
    body: "I'm on a deadline through next Friday. Could you check back the week after?",
  },
  {
    id: 'v2h-nn-next-fund',
    cls: 'not_now',
    body: "We're not raising our next fund until next year, so reach back out then.",
  },
  {
    id: 'v2h-nn-table-offsite',
    cls: 'not_now',
    body: 'Can we table this until after our offsite in two weeks?',
  },
  {
    id: 'v2h-nn-down-the-road',
    cls: 'not_now',
    body: "I'd be interested down the road, just not right now. Let's stay in touch.",
  },
  {
    id: 'v2h-nn-soc2-spring',
    cls: 'not_now',
    body: "We're heads down on SOC 2 until spring. Reach out again then and we can take a look.",
  },
  {
    id: 'v2h-nn-q3',
    cls: 'not_now',
    body: "Our team is mid-hiring for other roles, so I'd say revisit in Q3.",
  },
  {
    id: 'v2h-nn-holidays-january',
    cls: 'not_now',
    body: "Super busy with the holidays coming up. Let's pick this up in January.",
  },
  {
    id: 'v2h-nn-too-soon',
    cls: 'not_now',
    body: "Too soon for us, we haven't even finished onboarding our last tool. Maybe later in the year.",
  },
  // unsubscribe
  { id: 'v2h-unsub-remove-thanks', cls: 'unsubscribe', body: 'Please remove me from your list. Thanks.' },
  { id: 'v2h-unsub-stop-sending', cls: 'unsubscribe', body: 'Stop sending me emails.' },
  { id: 'v2h-unsub-word', cls: 'unsubscribe', body: 'Unsubscribe.' },
  { id: 'v2h-unsub-dont-contact', cls: 'unsubscribe', body: "Please don't contact me again." },
  {
    id: 'v2h-unsub-appreciate-stop',
    cls: 'unsubscribe',
    body: "I'd appreciate it if you'd stop emailing me.",
  },
  { id: 'v2h-unsub-this-list', cls: 'unsubscribe', body: 'Take me off this list.' },
  {
    id: 'v2h-unsub-future-emails',
    cls: 'unsubscribe',
    body: 'Not interested. Remove me from future emails.',
  },
  { id: 'v2h-unsub-stop-reaching', cls: 'unsubscribe', body: 'Please stop reaching out to me.' },
  { id: 'v2h-unsub-opt-out', cls: 'unsubscribe', body: 'opt out' },
];
