/**
 * A small, realistic mailbox for Maya Chen (maya@example.com, alias maya.chen@state.edu), relative to a fixed "now":
 *   T-priya    a two-way coffee-chat thread with Priya Patel (Figma)
 *   T-ats      applicant-tracking auto-mail (Greenhouse no-reply) and an Ashby scheduling mail
 *   T-club     a 12-person club thread where three people write
 *   T-intro    Lena Ortiz introduces Maya to Sam Rivera with Sam on CC; Sam and Maya answer
 *   T-news     a newsletter with List-Unsubscribe
 *   T-dan      Maya's outreach to Dan Fox and his request to be removed
 *   T-alias    a message Maya sent from her school alias
 * Bodies are plain text unless noted; nothing here is real.
 */
import type { MailSpec } from './fakeApis.ts';

export const NOW = Date.parse('2026-10-14T12:00:00Z');
export const ago = (days: number, hours = 0) =>
  new Date(NOW - days * 86_400_000 - hours * 3_600_000).toISOString();

export const MAYA = 'Maya Chen <maya@example.com>';
export const MAYA_ALIAS = 'Maya Chen <maya.chen@state.edu>';

const club = Array.from(
  { length: 11 },
  (_, i) => `Member ${String.fromCharCode(65 + i)} Lee <member${i + 1}@state.edu>`,
);

export function fixtureMailbox(): MailSpec[] {
  return [
    // a two-way thread
    {
      id: 'm-priya-1',
      threadId: 'T-priya',
      from: MAYA,
      to: ['Priya Patel <priya.patel@figma.com>'],
      subject: 'Coffee chat about product design at Figma?',
      body: "Hi Priya,\n\nI'm a junior at State studying HCI and came across your talk on design systems. Would you be open to a 20 minute call to hear how you got into product design?\n\nBest,\nMaya",
      at: ago(14),
      labels: ['SENT'],
    },
    {
      id: 'm-priya-2',
      threadId: 'T-priya',
      from: 'Priya Patel <priya.patel@figma.com>',
      to: [MAYA],
      subject: 'Re: Coffee chat about product design at Figma?',
      body: 'Hi Maya,\n\nHappy to chat! Would Tuesday at 2pm ET work?\n\nPriya\n\nOn Mon, Maya Chen <maya@example.com> wrote:\n> Hi Priya, would you be open to a 20 minute call?',
      at: ago(13, 20),
      headers: { 'In-Reply-To': '<m-priya-1@mail.example>' },
    },
    {
      id: 'm-priya-3',
      threadId: 'T-priya',
      from: MAYA,
      to: ['Priya Patel <priya.patel@figma.com>'],
      subject: 'Re: Coffee chat about product design at Figma?',
      body: 'Tuesday at 2pm ET works great. Thank you so much, talk then!\n\nMaya',
      at: ago(13, 18),
      labels: ['SENT'],
    },
    // applicant tracking: never people, never counted
    {
      id: 'm-ats-1',
      threadId: 'T-ats',
      from: 'Stripe Recruiting <no-reply@greenhouse.io>',
      to: [MAYA],
      subject: 'Thank you for applying to Stripe',
      body: 'Thanks for applying to the Software Engineering Intern role. We will review your application.',
      at: ago(20),
      headers: { 'Auto-Submitted': 'auto-generated' },
    },
    {
      id: 'm-ats-2',
      threadId: 'T-ats2',
      from: 'Jordan from Ramp <jordan@ashbyhq.com>',
      to: [MAYA],
      subject: 'Schedule your interview with Ramp',
      body: 'Please pick a time for your phone screen using the link below.',
      at: ago(18),
    },
    // a 12-person thread: people, but no ties and no closeness
    {
      id: 'm-club-1',
      threadId: 'T-club',
      from: 'Alex Kim <alex.kim@state.edu>',
      to: [MAYA, ...club],
      subject: 'Spring planning for the design club',
      body: 'Hi all, let us meet Thursday to plan the spring events. Please reply with ideas.\n\nAlex',
      at: ago(30),
    },
    {
      id: 'm-club-2',
      threadId: 'T-club',
      from: club[0]!,
      to: ['Alex Kim <alex.kim@state.edu>', MAYA, ...club.slice(1)],
      subject: 'Re: Spring planning for the design club',
      body: 'I can bring the projector. Thursday works.',
      at: ago(29),
    },
    {
      id: 'm-club-3',
      threadId: 'T-club',
      from: club[1]!,
      to: ['Alex Kim <alex.kim@state.edu>', MAYA, club[0]!, ...club.slice(2)],
      subject: 'Re: Spring planning for the design club',
      body: 'Count me in for Thursday.',
      at: ago(29, 2),
    },
    // a CC introduction
    {
      id: 'm-intro-1',
      threadId: 'T-intro',
      from: 'Lena Ortiz <lena@acme.vc>',
      to: [MAYA, 'Sam Rivera <sam@riveralabs.io>'],
      subject: 'Intro: Maya <> Sam',
      body: "Hi Sam,\n\nI'd like to introduce you to Maya Chen, a junior at State who is building a design tool for clubs. Maya, Sam runs product at Rivera Labs and has thought a lot about this space.\n\nI'll let you two take it from here.\n\nLena",
      at: ago(6),
    },
    {
      id: 'm-intro-2',
      threadId: 'T-intro',
      from: 'Sam Rivera <sam@riveralabs.io>',
      to: [MAYA],
      cc: ['Lena Ortiz <lena@acme.vc>'],
      subject: 'Re: Intro: Maya <> Sam',
      body: 'Thanks Lena (moving you to bcc)! Maya, great to meet you. Happy to chat next week, does Wednesday afternoon work?\n\nSam',
      at: ago(5, 20),
    },
    {
      id: 'm-intro-3',
      threadId: 'T-intro',
      from: MAYA,
      to: ['Sam Rivera <sam@riveralabs.io>'],
      cc: ['Lena Ortiz <lena@acme.vc>'],
      subject: 'Re: Intro: Maya <> Sam',
      body: 'Thank you Lena! Sam, Wednesday at 3pm ET works for me.\n\nMaya',
      at: ago(5, 18),
      labels: ['SENT'],
    },
    // a newsletter
    {
      id: 'm-news-1',
      threadId: 'T-news',
      from: 'The Weekly Brief <hello@briefnews.co>',
      to: [MAYA],
      subject: 'This week in design',
      body: 'Top stories this week. Unsubscribe at any time.',
      at: ago(3),
      headers: { 'List-Unsubscribe': '<mailto:unsub@briefnews.co>', Precedence: 'list' },
    },
    // outreach answered with "remove me"
    {
      id: 'm-dan-1',
      threadId: 'T-dan',
      from: MAYA,
      to: ['Dan Fox <dan@foxco.com>'],
      subject: 'Question about your work at FoxCo',
      body: "Hi Dan,\n\nI'm a student at State interested in climate hardware. Would you be open to a quick call?\n\nMaya",
      at: ago(9),
      labels: ['SENT'],
    },
    {
      id: 'm-dan-2',
      threadId: 'T-dan',
      from: 'Dan Fox <dan@foxco.com>',
      to: [MAYA],
      subject: 'Re: Question about your work at FoxCo',
      body: 'Please remove me from your list and stop emailing me.',
      at: ago(8),
    },
    // sent from the send-as alias
    {
      id: 'm-alias-1',
      threadId: 'T-alias',
      from: MAYA_ALIAS,
      to: ['Prof. Grace Hopper <ghopper@state.edu>'],
      subject: 'Office hours',
      body: 'Hi Professor Hopper, could I stop by office hours on Friday to ask about research?\n\nMaya',
      at: ago(2),
      labels: ['SENT'],
    },
  ];
}

/** n generated messages over two years: 30 correspondents, threads of 4, about one in eight sent by the user. */
export function bulkMailbox(n: number): MailSpec[] {
  const out: MailSpec[] = [];
  for (let i = 0; i < n; i++) {
    const thread = Math.floor(i / 4);
    const person = thread % 30;
    const outbound = i % 8 === 0;
    const them = `Contact ${person} Example <contact${person}@company${person % 7}.com>`;
    // spread over 2 years, newest first in id order
    const days = Math.floor((i / n) * 700) + 1;
    out.push({
      id: `bulk-${String(i).padStart(5, '0')}`,
      threadId: `bulk-thread-${thread}`,
      from: outbound ? MAYA : them,
      to: [outbound ? them : MAYA],
      subject: `Project update ${thread}`,
      body: outbound
        ? 'Thanks for the update, talk soon.'
        : 'Here is the latest on the project we discussed.',
      at: ago(days, i % 24),
      labels: outbound ? ['SENT'] : ['INBOX'],
    });
  }
  return out;
}
