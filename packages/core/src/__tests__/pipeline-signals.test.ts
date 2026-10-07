import { describe, expect, it } from 'vitest';
import { buildDemoDataset } from '../demo/seed';
import {
  extractProposedTimes,
  followUpDate,
  heuristicSignal,
  heuristicTriage,
  isAutoReplyBody,
} from '../email/triage';
import { heuristicNoteExtraction } from '../notes/extract';
import { canTransition, decideTransition, PROPOSE_THRESHOLD } from '../pipeline/transitions';
import { generateCandidates } from '../suggestions/rules';
import {
  decodeEntities,
  decodeMimeWords,
  htmlToText,
  isAutomatedSender,
  isCalendarNotice,
  isRoleName,
  parseAddress,
  parseAddressList,
  splitSignature,
  stripQuotedReply,
} from '../text/email';
import { buildWarmUpPlan, warmUpProgress } from '../warmup/rules';

describe('transitions', () => {
  it('reads a time proposed before the student wrote (an intro answered first) as their reply (L9)', () => {
    for (const from of ['identified', 'warming'] as const)
      for (const signal of ['scheduling_proposal', 'scheduling_confirmation'])
        expect(decideTransition(from, { type: 'inbound_signal', signal, confidence: 0.85 })).toMatchObject({
          to: 'replied',
          reason: `inbound_signal:${signal}`,
        });
    expect(
      decideTransition('outreach_sent', {
        type: 'inbound_signal',
        signal: 'scheduling_proposal',
        confidence: 0.85,
      }),
    ).toMatchObject({ to: 'scheduling' });
  });

  it('follows the table', () => {
    expect(decideTransition('identified', { type: 'outbound_sent', kind: 'outreach' })).toMatchObject({
      to: 'outreach_sent',
    });
    expect(decideTransition('warming', { type: 'outbound_sent', kind: 'outreach' })).toMatchObject({
      to: 'outreach_sent',
    });
    expect(
      decideTransition('outreach_sent', {
        type: 'inbound_signal',
        signal: 'reply_positive',
        confidence: 0.9,
      }),
    ).toMatchObject({ to: 'replied' });
    expect(
      decideTransition('outreach_sent', {
        type: 'inbound_signal',
        signal: 'reply_decline',
        confidence: 0.95,
      })!.confidence,
    ).toBeLessThan(0.8);
    expect(decideTransition('scheduled', { type: 'event_ended', confidence: 0.95 })).toMatchObject({
      to: 'completed',
    });
    expect(decideTransition('completed', { type: 'outbound_sent', kind: 'thank_you' })).toMatchObject({
      to: 'followed_up',
    });
    expect(decideTransition('followed_up', { type: 'timer_followed_up_14d' })).toMatchObject({
      to: 'nurturing',
    });
    expect(
      decideTransition('outreach_sent', { type: 'timer_no_response', bumps: 2, maxBumps: 2, daysSilent: 15 }),
    ).toMatchObject({ to: 'no_response' });
    expect(
      decideTransition('completed', { type: 'inbound_signal', signal: 'reply_positive', confidence: 0.9 }),
    ).toBeUndefined();
    expect(canTransition('archived', 'scheduled', 'user')).toBe(true);
    expect(canTransition('archived', 'scheduled', 'system')).toBe(false);
  });
});

describe('triage and signals', () => {
  const ref = new Date('2026-10-05T12:00:00Z'); // Monday
  it('classifies networking threads', () => {
    const r = heuristicTriage({
      subject: 'Coffee chat?',
      messages: [
        {
          fromEmail: 'alex@cornell.edu',
          direction: 'outbound',
          body: 'Would you be open to a 20-minute call to hear about your path?',
          isAutomated: false,
        },
      ],
      userEmails: ['alex@cornell.edu'],
    });
    expect(r.isNetworking).toBe(true);
    const o = heuristicTriage({
      subject: 'Your order has shipped',
      messages: [
        {
          fromEmail: 'orders@amazon.com',
          direction: 'inbound',
          body: 'Your order #123 has shipped. Track your delivery.',
          isAutomated: true,
        },
      ],
      userEmails: [],
    });
    expect(o.category).toBe('automated');
    const rec = heuristicTriage({
      subject: 'Next steps',
      messages: [
        {
          fromEmail: 'recruiting@stripe.com',
          direction: 'inbound',
          body: 'Thanks for completing the online assessment. Next steps: a phone screen with the hiring manager.',
          isAutomated: false,
        },
      ],
      userEmails: [],
    });
    expect(rec.category).toBe('recruiting_process');
  });
  it('extracts proposed times', () => {
    const t = extractProposedTimes('Would Thursday at 2pm work? Or Fri 10:30am.', ref);
    expect(t.length).toBe(2);
    expect(new Date(t[0]!.startIso).getDay()).toBe(4);
    expect(new Date(t[0]!.startIso).getHours()).toBe(14);
    expect(new Date(t[1]!.startIso).getMinutes()).toBe(30);
  });
  it('classifies signals', () => {
    expect(heuristicSignal('Sure! Would Thursday at 2pm work?', 'inbound', ref).signal).toBe(
      'scheduling_proposal',
    );
    expect(
      heuristicSignal('Unfortunately I am not able to take calls this quarter.', 'inbound', ref).signal,
    ).toBe('reply_decline');
    expect(heuristicSignal('Happy to refer you when the posting goes up.', 'inbound', ref).signal).toBe(
      'referral_offer',
    );
    expect(heuristicSignal('Thanks so much for your time today!', 'outbound', ref).signal).toBe('thank_you');
    expect(heuristicSignal('I am out of office until Monday.', 'inbound', ref).signal).toBe('out_of_office');
    expect(heuristicSignal('Happy to chat, let me know what works.', 'inbound', ref).signal).toBe(
      'reply_positive',
    );
    expect(heuristicSignal('Confirmed, see you then!', 'inbound', ref).signal).toBe(
      'scheduling_confirmation',
    );
  });
});

describe('email understanding regressions', () => {
  const ref = new Date('2026-10-05T16:00:00Z'); // Monday 9:00 AM Pacific
  const PT = 'America/Los_Angeles';
  const at = (iso: string | undefined, tz = PT) =>
    iso
      ? new Date(iso).toLocaleString('en-US', {
          timeZone: tz,
          weekday: 'short',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : undefined;

  it('EU-01: honours an explicit zone and resolves the rest in the student zone', () => {
    const et = extractProposedTimes('Does Thursday at 2pm ET work for you?', ref, PT);
    expect(et[0]?.startIso).toBe('2026-10-08T18:00:00.000Z');
    expect(et[0]?.timeZone).toBe('America/New_York');
    const local = extractProposedTimes('Does Thursday at 2pm work for you?', ref, PT);
    expect(local[0]?.startIso).toBe('2026-10-08T21:00:00.000Z');
    expect(local[0]?.timeZone).toBeUndefined();
    // the same words for a student in New York
    expect(extractProposedTimes('Does Thursday at 2pm work?', ref, 'America/New_York')[0]?.startIso).toBe(
      '2026-10-08T18:00:00.000Z',
    );
    // across the DST change: Monday 2 November 10am Pacific is 18:00 UTC (PST)
    expect(extractProposedTimes('How about 11/2 at 10am?', ref, PT)[0]?.startIso).toBe(
      '2026-11-02T18:00:00.000Z',
    );
    expect(
      heuristicSignal('Sure! Does Thursday at 2pm ET work?', 'inbound', ref, { timeZone: PT }).extraction
        .proposedTimes[0]?.startIso,
    ).toBe('2026-10-08T18:00:00.000Z');
  });

  it('EU-05: dates, time before day, noon, ranges, around/after', () => {
    expect(at(extractProposedTimes('Thurs 10/8 at 2pm', ref, PT)[0]?.startIso)).toBe('Thu, 10/8, 2:00 PM');
    const r = extractProposedTimes('Tue 10/13 1-1:30pm', ref, PT)[0]!;
    expect([at(r.startIso), at(r.endIso)]).toEqual(['Tue, 10/13, 1:00 PM', 'Tue, 10/13, 1:30 PM']);
    expect(at(extractProposedTimes('2pm Thursday', ref, PT)[0]?.startIso)).toBe('Thu, 10/8, 2:00 PM');
    expect(at(extractProposedTimes('October 9 at 2pm', ref, PT)[0]?.startIso)).toBe('Fri, 10/9, 2:00 PM');
    expect(at(extractProposedTimes('Thursday the 8th at 2pm', ref, PT)[0]?.startIso)).toBe(
      'Thu, 10/8, 2:00 PM',
    );
    expect(at(extractProposedTimes('Thursday at noon', ref, PT)[0]?.startIso)).toBe('Thu, 10/8, 12:00 PM');
    expect(at(extractProposedTimes('Thursday evening at 6', ref, PT)[0]?.startIso)).toBe(
      'Thu, 10/8, 6:00 PM',
    );
    expect(
      extractProposedTimes('Thursday around 2 or Friday after 4', ref, PT).map((t) => at(t.startIso)),
    ).toEqual(['Thu, 10/8, 2:00 PM', 'Fri, 10/9, 4:00 PM']);
    expect(heuristicSignal("Yes! Let's do 11:30am Friday.", 'inbound', ref, { timeZone: PT }).signal).toBe(
      'scheduling_proposal',
    );
  });

  it('EU-06: ordinary words and past references are not proposed times', () => {
    for (const s of [
      'My friend at 3 Capital might be a better contact.',
      'I will be in Monaco at 5',
      'see the month at 3 summary',
      'we met last Friday at 5 and it was great',
      'I sat with her at 3 and we chatted',
    ])
      expect(extractProposedTimes(s, ref, PT)).toEqual([]);
    expect(
      extractProposedTimes("Sunday 10K race, so Monday I'm wrecked, haha. Tuesday at 11?", ref, PT).map((t) =>
        at(t.startIso),
      ),
    ).toEqual(['Tue, 10/6, 11:00 AM']);
    expect(
      heuristicSignal('My friend at 3 Capital might be a better contact.', 'inbound', ref).signal,
    ).not.toBe('scheduling_proposal');
  });

  it('EU-02: "thanks for reaching out, happy to chat" is a positive reply with no fake ask', () => {
    const r = heuristicSignal(
      'Hi Alex,\n\nThanks for reaching out! Happy to chat sometime next week. Let me know what works for you.\n\nBest,\nPriya',
      'inbound',
      ref,
    );
    expect(r.signal).toBe('reply_positive');
    expect(r.extraction.asksOfUser).toEqual([]);
    expect(
      heuristicSignal(
        "Thanks for reaching out, Alex. I'd be happy to hop on a call next week.",
        'inbound',
        ref,
      ).signal,
    ).toBe('reply_positive');
  });

  it('EU-04: reschedules and counter-proposals are not declines', () => {
    const sig = (b: string) => heuristicSignal(b, 'inbound', ref, { timeZone: PT }).signal;
    expect(sig("I'm not available Tuesday but Wednesday at 2pm works.")).toBe('scheduling_proposal');
    expect(sig("Unfortunately Tuesday doesn't work for me anymore. Could you do Thursday at 3?")).toBe(
      'scheduling_proposal',
    );
    expect(
      sig("I can't make it Thursday anymore, something came up on my end. Can we push to Friday same time?"),
    ).toBe('reschedule');
    expect(sig('Unfortunately I am not able to take calls this quarter.')).toBe('reply_decline');
  });

  it('EU-03: employees of companies that also send bulk mail are human; their mail subdomains are not', () => {
    for (const e of [
      'sarah.chen@capitalone.com',
      'jordan.lee@chase.com',
      'ppatel@linkedin.com',
      'mike@doordash.com',
      'ana@coinbase.com',
      'ana@robinhood.com',
      'ana@indeed.com',
      'ana@pinterest.com',
      'ana@tiktok.com',
      'ana@paypal.com',
      'ana@substack.com',
      'ana@lever.co',
      'ana@greenhouse.io',
      'ana@joinhandshake.com',
      'nina@google.com',
    ])
      expect(isAutomatedSender(e)).toBe(false);
    for (const e of [
      'messages-noreply@linkedin.com',
      'jobs@e.linkedin.com',
      'alerts@email.chase.com',
      'no-reply@us.greenhouse-mail.io',
      'invitations@linkedin.com',
      'calendar-notification@google.com',
      'notifications@calendly.com',
      'no-reply@zoom.us',
    ])
      expect(isAutomatedSender(e)).toBe(true);
  });

  it('EU-14: Sender, List-Id and X-Autoreply headers mark machine mail', () => {
    expect(
      isAutomatedSender('priya@figma.com', { sender: 'Google Calendar <calendar-notification@google.com>' }),
    ).toBe(true);
    expect(
      isAutomatedSender('priya@figma.com', { 'x-auto-response-suppress': 'All', 'x-autoreply': 'yes' }),
    ).toBe(true);
    expect(isAutomatedSender('priya@figma.com', { 'list-id': '<team.figma.com>' })).toBe(true);
    expect(isAutomatedSender('priya@figma.com', { sender: 'priya@figma.com' })).toBe(false);
    expect(
      isCalendarNotice(
        'Invitation: Coffee chat @ Thu Oct 8, 2pm - 2:30pm (PDT)',
        'Join with Google Meet\nInvitation from Google Calendar',
      ),
    ).toBe(true);
    expect(isCalendarNotice('Re: coffee chat', 'Accepted, see you then')).toBe(false);
  });

  it('EU-07: wrapped and localized attribution lines are cut', () => {
    const quoted = '\n\n> Hi Priya,\n> Would Thursday at 2pm work?\n>';
    expect(
      stripQuotedReply(
        `Sounds good, Thursday works.\n\nOn Tue, Oct 6, 2026 at 9:00 AM Alexander Rodriguez <\nalexander.rodriguez@cornell.edu> wrote:${quoted}`,
      ),
    ).toBe('Sounds good, Thursday works.');
    expect(
      stripQuotedReply(
        `Sounds good.\n\nOn Tue, Oct 6, 2026 at 9:00 AM Alexander Rodriguez <alexander.rodriguez@cornell.edu>\nwrote:${quoted}`,
      ),
    ).toBe('Sounds good.');
    expect(
      stripQuotedReply(
        `Klingt gut.\n\nAm 06.10.2026 um 09:00 schrieb Alex Rivera <alex@cornell.edu>:${quoted}`,
      ),
    ).toBe('Klingt gut.');
    expect(stripQuotedReply('Works for me.\n\nSent from my iPhone')).toBe('Works for me.');
    expect(stripQuotedReply('On Thursday I can do 2pm.\nLet me know.')).toBe(
      'On Thursday I can do 2pm.\nLet me know.',
    );
  });

  it('EU-08: links and numbers in the body survive signature splitting; signatures still parse', () => {
    expect(
      splitSignature(
        'Hi Alex,\n\nHappy to chat.\n\nGrab any slot here: https://calendly.com/priya/20min\n\nBest,\nPriya',
      ).body,
    ).toContain('calendly.com/priya/20min');
    const zoom = splitSignature(
      'Great, that works.\n\nHere is the Zoom link: https://zoom.us/j/8921234567\n\nTalk soon,\nPriya',
    );
    expect(zoom.body).toContain('zoom.us/j/8921234567');
    const cell = splitSignature('Sure thing.\n\nMy cell is 415-555-0100 if anything comes up.\n\nPriya');
    expect(cell.body).toContain('415-555-0100');
    const meeting = splitSignature(
      'Happy to chat! The meeting ID is 892 1234 5678 and passcode 1234.\n\nSee you Thursday.\nPriya',
    );
    expect(meeting.body).toContain('892 1234 5678');
    expect(meeting.phone).toBeUndefined();
    const sig = splitSignature(
      'Hi Alex,\n\nThanks for reaching out. Happy to chat next week.\n\nBest regards,\nPriya Sharma\nSenior Analyst | Goldman Sachs\n+1 212 555 0199\nlinkedin.com/in/priyasharma',
    );
    expect(sig.body).toBe('Hi Alex,\n\nThanks for reaching out. Happy to chat next week.');
    expect(sig.title).toBe('Senior Analyst');
    expect(sig.company).toBe('Goldman Sachs');
    expect(sig.phone).toBe('+1 212 555 0199');
    expect(sig.linkedinUrl).toBe('linkedin.com/in/priyasharma');
  });

  it('EU-09: intro and referral offers are recognised', () => {
    const sig = (b: string) => heuristicSignal(b, 'inbound', ref).signal;
    expect(sig("I'll pass your resume along to our university recruiter.")).toBe('referral_offer');
    expect(sig('Just submitted a referral for you in our system.')).toBe('referral_offer');
    expect(sig("Let me know if you'd like an intro to anyone on the data team.")).toBe('intro_offer');
    expect(sig("Looping in Sarah (cc'd), who leads our APM program.")).toBe('intro_offer');
    expect(sig('CCing Sarah from our team who can speak to the analyst program.')).toBe('intro_offer');
    expect(sig('Send me your resume and the req number and I can put in a good word.')).toBe(
      'referral_offer',
    );
  });

  it('EU-10: natural thank-you notes are thank-yous; asks and logistics are not', () => {
    const sig = (b: string) => heuristicSignal(b, 'outbound', ref).signal;
    for (const b of [
      'Thank you again for the great conversation yesterday. Your point about owning one project stuck with me.',
      'It was great chatting with you yesterday, really appreciated your advice on the APM process.',
      'Thank you for the advice today, Priya.',
      'Thanks for making time for me yesterday.',
    ])
      expect(sig(b)).toBe('thank_you');
    for (const b of [
      'Thanks for connecting on LinkedIn! I would love to hear about your path into PM. Would you have 15 minutes next week?',
      'Thanks, Thursday at 2pm works for me. Sending an invite now.',
      'Thanks in advance for your help, here are a few times that work: Tue 10am, Wed 3pm.',
      'Thanks for getting back to me. Does Friday at 11 work for you?',
    ])
      expect(sig(b)).not.toBe('thank_you');
  });

  it('EU-11/EU-12/EU-16: triage scores cues instead of gating on one word', () => {
    const me = 'alex@cornell.edu';
    const one = (subject: string, from: string, direction: 'inbound' | 'outbound', body: string) =>
      heuristicTriage({
        subject,
        messages: [{ fromEmail: from, direction, body, isAutomated: false }],
        userEmails: [me],
      });
    const weak = one(
      'Hi',
      'a@x.com',
      'inbound',
      'Thanks, I will catch up with the IT team about your printer.',
    );
    expect(weak.isNetworking).toBe(true);
    expect(weak.confidence).toBeLessThan(0.8);
    const strong = heuristicTriage({
      subject: 'Coffee chat?',
      messages: [
        {
          fromEmail: me,
          direction: 'outbound',
          body: 'Would love to hear about your path into PM. 15 minutes of your time for a coffee chat?',
          isAutomated: false,
        },
        {
          fromEmail: 'a@x.com',
          direction: 'inbound',
          body: 'Happy to chat about my experience. Looking forward to speaking!',
          isAutomated: false,
        },
      ],
      userEmails: [me],
    });
    expect(strong.confidence).toBeGreaterThan(weak.confidence);
    expect(
      one(
        'Next steps',
        'recruiting@stripe.com',
        'inbound',
        "We'd like to move you forward to a 45 minute technical phone screen. Please pick a time.",
      ).category,
    ).toBe('recruiting_process');
    expect(
      one('Hi', 'ta@cornell.edu', 'inbound', 'Please verify your submission on Gradescope.').category,
    ).not.toBe('transactional');
    expect(
      one('Your receipt', 'shop@x.com', 'inbound', 'Here is your receipt. Payment received for invoice 42.')
        .category,
    ).toBe('transactional');
  });

  it('EU-13: a message from any of the student addresses counts as outbound in triage', () => {
    const r = heuristicTriage({
      subject: 'Hello',
      messages: [
        {
          fromEmail: 'ar123@cornell.edu',
          direction: 'inbound',
          body: "I'm a junior at Cornell. Would you be open to a brief chat?",
          isAutomated: false,
        },
      ],
      userEmails: ['alex@cornell.edu', 'ar123@cornell.edu'],
    });
    expect(r.isNetworking).toBe(true);
  });

  it('EU-15: out-of-office replies carry a return date unless they offer a time', () => {
    const r = heuristicSignal(
      'I am out of the office until Monday, October 19 with limited access to email.',
      'inbound',
      ref,
      {
        timeZone: PT,
      },
    );
    expect(r.signal).toBe('out_of_office');
    expect(r.extraction.returnDate).toBe('2026-10-19');
    expect(
      heuristicSignal(
        "I'm on vacation next week, but how about the week after? Tuesday the 20th at 2pm?",
        'inbound',
        ref,
        {
          timeZone: PT,
        },
      ).signal,
    ).toBe('scheduling_proposal');
  });

  it('parses address lists with quoted commas and converts HTML mail with links', () => {
    expect(
      parseAddressList('"Doe, Jane" <jane@x.com>, bob@y.com; "Lee, Ann (Figma)" <ann@figma.com>'),
    ).toEqual(['"Doe, Jane" <jane@x.com>', 'bob@y.com', '"Lee, Ann (Figma)" <ann@figma.com>']);
    expect(parseAddress('"Doe, Jane" <Jane@X.com>')).toEqual({ email: 'jane@x.com', name: 'Doe, Jane' });
    const text = htmlToText(
      '<html><head><style>p{}</style></head><body><div dir="ltr"><p>Happy to chat&nbsp;&amp; grab a slot <a href="https://calendly.com/priya/20min">here</a>.</p><div>Talk soon,<br>Priya</div></div><div class="gmail_quote"><div class="gmail_attr">On Mon, Oct 5 Alex wrote:</div><blockquote>old</blockquote></div></body></html>',
    );
    expect(text).toBe(
      'Happy to chat & grab a slot here (https://calendly.com/priya/20min).\n\nTalk soon,\nPriya',
    );
  });
});

describe('email understanding regressions, round 2', () => {
  const ref = new Date('2026-10-05T16:00:00Z'); // Monday 9:00 AM Pacific
  const PT = 'America/Los_Angeles';
  const sig = (body: string) => heuristicSignal(body, 'inbound', ref, { timeZone: PT });
  const starts = (body: string) => sig(body).extraction.proposedTimes.map((t) => t.startIso);

  it('EU-17: a hand-typed vacation note that offers a time is a proposal in the right week', () => {
    const r = sig("I'm on vacation next week, but how about the week after? Tuesday at 2pm?");
    expect(r.signal).toBe('scheduling_proposal');
    expect(r.extraction.sentiment).toBe('warm');
    // Tuesday 20 October, 2pm Pacific
    expect(starts("I'm on vacation next week, but how about the week after? Tuesday at 2pm?")).toEqual([
      '2026-10-20T21:00:00.000Z',
    ]);
    // a vacation responder is out of office whatever else it says
    expect(
      sig(
        'Thank you for your email. I am out of the office until Monday, October 19. How about we reconnect then?',
      ).signal,
    ).toBe('out_of_office');
  });

  it('EU-17: week scopes ("next week is wide open", "Tuesday next week") place a bare weekday', () => {
    expect(starts("I'm fully booked this week, but next week is wide open. Tues 10am or Wed 4pm?")).toEqual([
      '2026-10-13T17:00:00.000Z',
      '2026-10-14T23:00:00.000Z',
    ]);
    expect(starts('Could you do Tuesday next week at 11?')).toEqual(['2026-10-13T18:00:00.000Z']);
    // a week named as busy does not move the day into it
    expect(starts("I'm traveling next week. Would Thursday at 2pm work?")).toEqual([
      '2026-10-08T21:00:00.000Z',
    ]);
    expect(starts("Can't do it this week, but the week after works. Wednesday at 3pm?")).toEqual([
      '2026-10-14T22:00:00.000Z',
    ]);
  });

  it('EU-22: "next <weekday>" is that day in the following week; mobile footers and multi-word closers split', () => {
    expect(starts('How about next Thursday at 3pm?')).toEqual(['2026-10-15T22:00:00.000Z']);
    expect(starts('How about this Thursday at 3pm?')).toEqual(['2026-10-08T22:00:00.000Z']);
    expect(splitSignature('Sure, Thursday works.\n\nSent from my iPhone')).toMatchObject({
      body: 'Sure, Thursday works.',
      signature: 'Sent from my iPhone',
    });
    expect(splitSignature('Happy to chat.\n\nKind regards,\nPriya')).toMatchObject({
      body: 'Happy to chat.',
      signature: 'Kind regards,\nPriya',
    });
  });

  it('EU-18: soft declines are declines, with the follow-up date when they give one', () => {
    const later = sig(
      "Hi Alex, I'm pretty slammed this quarter but maybe in the new year? Feel free to ping me again in January.",
    );
    expect(later.signal).toBe('reply_decline');
    expect(later.extraction.sentiment).toBe('cool');
    expect(later.extraction.followUpAfter).toBe('2027-01-01');
    for (const b of [
      "Thanks for reaching out. I don't really have bandwidth for calls right now. Best of luck with the search!",
      'I no longer work at Google, so probably not much help on that front. Sorry!',
      "I'm stretched too thin to take on new calls this fall, sorry about that.",
    ])
      expect(sig(b).signal).toBe('reply_decline');
    // a warm yes with a "good luck" in it stays positive
    expect(sig('Happy to chat! Best of luck with recruiting.').signal).toBe('reply_positive');
    expect(followUpDate('try me again in a few weeks', ref, PT)).toBe('2026-10-26');
    expect(followUpDate('circle back after the holidays', ref, PT)).toBe('2027-01-01');
    expect(followUpDate('maybe in the spring', ref, PT)).toBe('2027-03-01');
    expect(followUpDate('ping me in November', ref, PT)).toBe('2026-11-01');
  });

  it('EU-19: short confirmations are confirmations; a "booked" day with a new time is a proposal', () => {
    for (const b of [
      'Perfect, talk Thursday!',
      'Accepted the invite, looking forward to it!',
      "Great, that works. Here's the Zoom link: https://zoom.us/j/8921234567\n\nTalk soon,\nPriya",
      'Thursday at 2pm works for me. Talk then.',
      "You're all set, see you Thursday.",
    ])
      expect(sig(b).signal).toBe('scheduling_confirmation');
    expect(sig("I'm fully booked this week, but next week is wide open. Tues 10am or Wed 4pm?").signal).toBe(
      'scheduling_proposal',
    );
    expect(sig('Monday is booked solid, but does Tues 10am work?').signal).toBe('scheduling_proposal');
    expect(sig('I can do Thursday at 2pm, let me know if that works.').signal).toBe('scheduling_proposal');
  });

  it('EU-20: signature title and company for the common layouts', () => {
    const sigOf = (block: string, name?: string) =>
      splitSignature(`Happy to chat next week.\n\nBest,\n${block}`, { name });
    expect(sigOf('Senior Product Manager, Growth\nFigma\n415-555-0100')).toMatchObject({
      title: 'Senior Product Manager, Growth',
      company: 'Figma',
    });
    expect(sigOf('Priya Patel | Product Manager | Figma', 'Priya Patel')).toMatchObject({
      title: 'Product Manager',
      company: 'Figma',
    });
    expect(sigOf('Priya Patel, Product Manager at Figma', 'Priya Patel')).toMatchObject({
      title: 'Product Manager',
      company: 'Figma',
    });
    expect(
      sigOf('Dr. Priya Patel\nAssociate Professor of Computer Science\nCornell University'),
    ).toMatchObject({
      title: 'Associate Professor of Computer Science',
      company: 'Cornell University',
    });
    expect(
      sigOf('Vice President, Investment Banking\nGoldman Sachs & Co. LLC | 200 West Street, New York'),
    ).toMatchObject({ title: 'Vice President, Investment Banking', company: 'Goldman Sachs & Co. LLC' });
    expect(sigOf('Dana Kim\nAnalyst, Goldman Sachs\n(212) 555-0100', 'Dana Kim')).toMatchObject({
      title: 'Analyst',
      company: 'Goldman Sachs',
    });
    // "International" is not "intern"
    expect(sigOf('Maria Lopez\nGoldman Sachs International').title).toBeUndefined();
  });

  it('EU-21 / NRC-12: shared recruiting inboxes and bulk senders are machines; founders on hello@ are people', () => {
    for (const e of [
      'no_reply@example.com',
      'no.reply@example.com',
      'dse_NA4@docusign.net',
      'mailer@beehiiv.com',
      'campusrecruiting@jpmorgan.com',
      'university-recruiting@goldman.com',
      'campus.recruiting@gs.com',
      'earlycareers@jpmorgan.com',
      'campusrecruiting@morganstanley.com',
      'do_not_reply@workday.com',
      'team@tinystartup.io',
    ])
      expect(isAutomatedSender(e), e).toBe(true);
    expect(isAutomatedSender('team@tinystartup.io', {}, [], 'Maya Chen')).toBe(false);
    expect(isAutomatedSender('hello@tinystartup.io', {}, [], 'Maya Chen')).toBe(false);
    expect(isAutomatedSender('hello@tinystartup.io', {}, [], 'Tiny Startup Team')).toBe(true);
    expect(isAutomatedSender('jane.recruiter@stripe.com')).toBe(false);
    expect(isAutomatedSender('priya.recruiting@figma.com')).toBe(false);
    expect(isRoleName('Goldman Sachs University Recruiting')).toBe(true);
    expect(isRoleName('Stripe Careers')).toBe(true);
    expect(isRoleName('Priya Patel')).toBe(false);
  });

  it('EG-10: a stated zone wins over the student zone', () => {
    const r = sig("Sure! Would Thursday at 2pm work? I'm on Eastern time.");
    expect(r.extraction.proposedTimes[0]).toMatchObject({
      startIso: '2026-10-08T18:00:00.000Z',
      timeZone: 'America/New_York',
    });
  });

  it('EG-18: thanks plus a question, a redirect, and "no calls but email" are read for what they ask', () => {
    expect(
      sig(
        "thanks for the note. Can you tell me a bit more about what you're hoping to get out of the conversation?",
      ).signal,
    ).toBe('question');
    expect(
      sig("Not the right person for this, but my colleague Sana runs the intern program, I've cc'd her.")
        .signal,
    ).toBe('intro_offer');
    const email = sig(
      "I don't do coffee chats during recruiting season, but happy to answer a couple of questions over email.",
    );
    expect(email.signal).toBe('question');
    expect(email.extraction.prefersEmail).toBe(true);
  });

  it('EG-18: a "questions over email" reply never gets a propose-times card', () => {
    const body =
      "I don't do coffee chats during recruiting season, but happy to answer a couple of questions over email.";
    const h = sig(body);
    const person = {
      id: 'p1',
      userId: 'u1',
      displayName: 'Priya Patel',
      firstName: 'Priya',
      lastName: 'Patel',
      emails: ['priya@figma.com'],
      isHuman: true,
    };
    const chat = {
      id: 'c1',
      userId: 'u1',
      personId: 'p1',
      stage: 'replied',
      stageEnteredAt: '2026-10-04T16:00:00Z',
      source: 'detected',
      goalTags: [],
      bumpCount: 0,
      priority: 2,
      lastOutboundAt: '2026-10-01T16:00:00Z',
      createdAt: '2026-10-01T16:00:00Z',
      updatedAt: '2026-10-04T16:00:00Z',
    };
    const lastIn = {
      id: 'm1',
      sentAt: '2026-10-04T16:00:00Z',
      signal: h.signal,
      signalConfidence: h.confidence,
      extraction: h.extraction,
    };
    const run = (extraction: typeof h.extraction) =>
      generateCandidates({
        userId: 'u1',
        now: ref,
        settings: buildDemoDataset({ now: ref }).settings,
        people: new Map([['p1', person]]),
        chats: [chat],
        lastInboundByChat: new Map([['c1', { ...lastIn, extraction }]]),
        events: [],
        actionItems: [],
        factsByPerson: new Map(),
        targetCompanies: [],
        recommendations: [],
        dismissCounts: new Map(),
        outreachSentThisWeek: 0,
        freeSlotsIso: ['2026-10-08T21:00:00Z'],
        recentlyContacted: new Set(),
      } as never).filter((c) => c.kind === 'schedule_propose');
    expect(run(h.extraction)).toHaveLength(0);
    expect(run({ ...h.extraction, prefersEmail: false })).toHaveLength(1);
  });

  it('PS-9: a vacation responder without auto-reply headers is recognised from its text', () => {
    const body =
      'Thanks for your email. I am traveling this week with limited access to email and will get back to you when I return.';
    expect(isAutoReplyBody(body)).toBe(true);
    const r = sig(body);
    expect(r.signal).toBe('out_of_office');
    expect(r.extraction.returnDate).toBe('2026-10-12');
    expect(isAutoReplyBody("I'm on vacation next week, but how about the week after? Tuesday at 2pm?")).toBe(
      false,
    );
    expect(isAutoReplyBody('Thanks for your email! Happy to chat, does Thursday work?')).toBe(false);
  });

  it('IS-2 / NRC-02: quoted commas and RFC 2047 encoded names', () => {
    expect(parseAddressList('"Patel, Priya" <priya@figma.com>, Dan Kim <dan.kim@stripe.com>')).toEqual([
      '"Patel, Priya" <priya@figma.com>',
      'Dan Kim <dan.kim@stripe.com>',
    ]);
    expect(parseAddress('=?UTF-8?Q?Jos=C3=A9_Garc=C3=ADa?= <jose@x.com>')).toEqual({
      email: 'jose@x.com',
      name: 'José García',
    });
    expect(parseAddress('=?utf-8?B?Sm9zw6k=?= <jose@x.com>').name).toBe('José');
    expect(decodeMimeWords('=?UTF-8?Q?Coffee_chat?= =?UTF-8?Q?_next_week?=')).toBe('Coffee chat next week');
    expect(decodeMimeWords('Plain subject')).toBe('Plain subject');
  });

  it('IS-12: HTML mail drops script and head text and decodes named and numeric entities', () => {
    // the sender's own punctuation is kept as written: the copy rules apply to what Orbit writes, not quoted mail
    expect(
      htmlToText(
        '<head><style>p{}</style><script>alert(1)</script></head><p>Hi Jos&eacute; &#8212; let&#8217;s chat</p>',
      ),
    ).toBe('Hi José — let’s chat');
    expect(htmlToText('<p>Mon&mdash;Wed, 9&ndash;5</p>')).toBe('Mon—Wed, 9–5');
    expect(htmlToText('<p>Hi Jos&eacute; — let’s chat</p>')).toBe(
      htmlToText('<p>Hi Jos&eacute; &mdash; let’s chat</p>'),
    );
    expect(decodeEntities('Fran&ccedil;ois M&uuml;ller &amp; &Aring;sa &euro;5 &szlig;')).toBe(
      'François Müller & Åsa €5 ß',
    );
    expect(decodeEntities('&unknownentity; stays')).toBe('&unknownentity; stays');
  });
});

describe('email understanding regressions, round 3', () => {
  const ref = new Date('2026-10-05T16:00:00Z'); // Monday 9:00 AM Pacific
  const PT = 'America/Los_Angeles';
  const sig = (body: string) => heuristicSignal(body, 'inbound', ref, { timeZone: PT });

  it('a warm "best of luck" close is not a decline', () => {
    for (const body of [
      'Congrats Alex, that is awesome news! Best of luck this summer.',
      'Thanks for the thank-you note! Best of luck with recruiting.',
      'So glad it worked out. Keep me posted, and best of luck with the offer.',
    ])
      expect(sig(body).signal, body).not.toBe('reply_decline');
    expect(sig('Great to meet you today. Best of luck with your applications!').signal).toBe('thank_you');
    // a bare close after a no is still a decline
    expect(sig("Thanks for reaching out. We aren't hiring interns this cycle. Best of luck!").signal).toBe(
      'reply_decline',
    );
  });

  it('counts, firms and street numbers next to a weekday are not meeting times', () => {
    for (const body of [
      'Our team grew from 5 to 20 people on Monday, so it has been busy.',
      'I work at 5 Capital on Monday',
      'Monday at 5 Capital Street',
    ]) {
      const r = sig(body);
      expect(r.extraction.proposedTimes, body).toEqual([]);
      expect(r.signal, body).toBe('reply_neutral');
    }
    // a real bare time next to a zone or a weekday still reads
    expect(extractProposedTimes('Could we meet Tuesday at 2 Eastern?', ref, PT)[0]?.startIso).toBe(
      '2026-10-06T18:00:00.000Z',
    );
    expect(
      extractProposedTimes('Tuesday at 2 works. Our office is at 10 Hudson Yards.', ref, PT),
    ).toHaveLength(1);
  });

  it('a time the sender says is taken is not offered', () => {
    const r = sig("I'm in class Monday at 10 but free Tuesday at 2.");
    expect(r.signal).toBe('scheduling_proposal');
    expect(r.extraction.proposedTimes.map((t) => t.startIso)).toEqual(['2026-10-06T21:00:00.000Z']);
    const times = (b: string) => extractProposedTimes(b, ref, PT).map((t) => t.raw);
    expect(times("Tuesday at 2pm doesn't work for me anymore, could we do Wednesday at 3pm?")).toEqual([
      'Wednesday at 3pm',
    ]);
    expect(times('Wednesday at 3pm is no good, how about Thursday at 3pm?')).toEqual(['Thursday at 3pm']);
    // conditional and idiomatic negations do not take a time away
    expect(times('Would Thursday at 2pm work? If not, I am also free Friday morning at 10.')).toHaveLength(2);
    expect(times('No problem at all. Does Thursday at 2pm work?')).toEqual(['Thursday at 2pm']);
    expect(times('Happy to chat. Tuesday at 2pm works if that is not too early for you.')).toEqual([
      'Tuesday at 2pm',
    ]);
  });

  it('EG-18 variants: a no to a call with a yes to email asks for email, not times', () => {
    for (const body of [
      "I'm going to pass on a call, but feel free to email questions.",
      "I'd rather not do a call, but happy to answer questions by email.",
    ]) {
      const r = sig(body);
      expect(r.signal, body).toBe('question');
      expect(r.extraction.prefersEmail, body).toBe(true);
    }
  });

  it('a redirect or an intro hands off: no propose-times card for the introducer, an outreach card for the target', () => {
    const redirect = sig(
      "Not the right person for this, but my colleague Sana runs our analyst program and would be a better contact. I've cc'd her here.",
    );
    expect(redirect.signal).toBe('intro_offer');
    expect(redirect.extraction.handoff).toBe(true);
    const intro = sig("Of course! Looping in Sam (cc'd) who leads growth. Sam, meet Alex.");
    expect(intro.signal).toBe('intro_offer');
    expect(intro.extraction.handoff).toBe(true);
    const person = (id: string, first: string, email: string) => ({
      id,
      userId: 'u1',
      displayName: `${first} Ortiz`,
      firstName: first,
      lastName: 'Ortiz',
      emails: [email],
      primaryEmail: email,
      isHuman: true,
    });
    const chat = (id: string, personId: string, stage: string, extra: Record<string, unknown> = {}) => ({
      id,
      userId: 'u1',
      personId,
      stage,
      stageEnteredAt: '2026-10-02T15:00:00Z',
      source: 'detected',
      goalTags: [],
      bumpCount: 0,
      priority: 2,
      createdAt: '2026-10-01T15:00:00Z',
      updatedAt: '2026-10-02T15:00:00Z',
      ...extra,
    });
    const run = (extraction: typeof intro.extraction) =>
      generateCandidates({
        userId: 'u1',
        now: ref,
        settings: buildDemoDataset({ now: ref }).settings,
        people: new Map([
          ['pd', person('pd', 'Dana', 'dana@figma.com')],
          ['ps', person('ps', 'Sam', 'sam@figma.com')],
        ]),
        chats: [
          chat('cd', 'pd', 'replied', { lastOutboundAt: '2026-10-01T15:00:00Z' }),
          chat('cs', 'ps', 'identified', { referrerPersonId: 'pd', referrerName: 'Dana' }),
        ],
        lastInboundByChat: new Map([
          [
            'cd',
            {
              id: 'm1',
              sentAt: '2026-10-02T15:00:00Z',
              signal: 'intro_offer',
              signalConfidence: 0.8,
              extraction,
            },
          ],
        ]),
        events: [],
        actionItems: [],
        factsByPerson: new Map(),
        targetCompanies: [],
        recommendations: [],
        dismissCounts: new Map(),
        outreachSentThisWeek: 0,
        freeSlotsIso: ['2026-10-08T21:00:00Z'],
        recentlyContacted: new Set(),
      } as never);
    const cands = run(intro.extraction);
    expect(cands.filter((c) => c.kind === 'schedule_propose')).toHaveLength(0);
    const toSam = cands.find((c) => c.kind === 'new_outreach' && c.personId === 'ps');
    expect(toSam?.chatId).toBe('cs');
    expect(toSam?.reasonText).toBe('Dana introduced you to Sam; write to Sam while the intro is fresh');
    // "happy to intro you later" with nobody on the thread still gets times proposed to the person who replied
    expect(
      run({ ...intro.extraction, handoff: false }).filter((c) => c.kind === 'schedule_propose'),
    ).toHaveLength(1);
  });
});

describe('email understanding leftovers (L1 to L7)', () => {
  const ref = new Date('2026-10-01T13:00:00Z'); // Thursday 9:00 AM Eastern
  const ET = 'America/New_York';
  const sig = (body: string, awaitingAnswer?: boolean) =>
    heuristicSignal(body, 'inbound', ref, { timeZone: ET, awaitingAnswer });
  /** proposals as "Tue 14:00" in New York */
  const slots = (body: string) =>
    sig(body).extraction.proposedTimes.map((t) =>
      new Date(t.startIso).toLocaleString('en-US', {
        timeZone: ET,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }),
    );

  it('L1: a negative question or a busy day elsewhere does not take a free time away', () => {
    for (const body of [
      "Why don't we do Tuesday at 2pm?",
      "Can't we just do Tuesday at 2pm?",
      "Wouldn't it be easier to do Tuesday at 2pm?",
      "I can't do Monday so Tuesday at 2pm works.",
      "I won't be around Monday. Tuesday at 2pm?",
    ]) {
      expect(slots(body), body).toEqual(['Tue 14:00']);
      expect(sig(body).signal, body).toBe('scheduling_proposal');
    }
    expect(slots("I'm booked Wednesday. Tuesday at 2pm or 4pm works.")).toEqual(['Tue 14:00', 'Tue 16:00']);
    // a negation that does say the time is taken still does
    expect(slots("Can't do Monday at 2pm, sorry.")).toEqual([]);
    expect(slots("Tuesday at 2pm doesn't work, how about Wednesday at 3pm?")).toEqual(['Wed 15:00']);
    // a bare negation before the day is a question only when the clause asks one
    expect(slots("Isn't Tuesday at 2 better?")).toEqual(['Tue 14:00']);
    for (const body of [
      "Can't Monday at 2, sorry. Could we do Tuesday at 3?",
      "Can't Monday at 2pm but Tuesday at 3pm works.",
      "Hi Alex,\n\nCan't Monday at 2. Tuesday at 3pm?",
      "Couldn't Monday at 2pm, but Tuesday at 3pm.",
    ])
      expect(slots(body), body).toEqual(['Tue 15:00']);
  });

  it('L1: a day ending one sentence still pairs with a bare time in the next', () => {
    expect(slots("Let's do Wednesday. 2pm work?")).toEqual(['Wed 14:00']);
    expect(slots('Free Wednesday. Around 2pm?')).toEqual(['Wed 14:00']);
    expect(slots('Thursday. 3pm ET.')).toEqual(['Thu 15:00']);
    expect(sig('Thursday. 3pm ET.').signal).toBe('scheduling_proposal');
    // but not with a time the next sentence gives its own day
    expect(slots("I'm booked Wednesday. Tuesday at 2pm.")).toEqual(['Tue 14:00']);
  });

  it('L2: a name, a stray capital or a city zone after the time keeps the time', () => {
    for (const [body, want] of [
      ['Can you do Thursday at 3 Alex?', 'Thu 15:00'],
      ['Free Monday at 4 Alex, does that work?', 'Mon 16:00'],
      ['Would Monday at 4 Sound good?', 'Mon 16:00'],
      ["Let's do Thursday at 4 Your time.", 'Thu 16:00'],
      ['Hi Alex,\n\nCould we do Thursday at 3\nDana', 'Thu 15:00'],
      ['Thursday at 3 Boston time?', 'Thu 15:00'],
      ['How about Thursday at 3 New York time?', 'Thu 15:00'],
      // 3pm in London is 10am in New York
      ['Does Thursday at 3 London time work?', 'Thu 10:00'],
    ] as const) {
      expect(slots(body), body).toEqual([want]);
      expect(sig(body).signal, body).toBe('scheduling_proposal');
    }
    expect(sig('Does Thursday at 3 London time work?').extraction.proposedTimes[0]?.timeZone).toBe(
      'Europe/London',
    );
    // firms and streets are still not times
    expect(slots('I work at 5 Capital on Monday')).toEqual([]);
    expect(slots('Monday at 5 Capital Street')).toEqual([]);
  });

  it('L7: a day the sender is out is never proposed, across a sentence or a comma', () => {
    expect(slots("Hi Alex,\n\nI'm out Monday. Tuesday at 2pm?")).toEqual(['Tue 14:00']);
    expect(slots("I'm out Monday, Tuesday at 2 works.")).toEqual(['Tue 14:00']);
    expect(slots('Monday or Tuesday at 2 works.')).toEqual(['Mon 14:00', 'Tue 14:00']);
  });

  it('L3: a yes to a chat is not a hand-off, and an assistant added to find a time is a yes', () => {
    const yesAndIntro = sig(
      'Happy to chat next week. My colleague Ana would be great too, I can connect you after.',
    );
    expect(yesAndIntro.signal).toBe('intro_offer');
    expect(yesAndIntro.extraction.handoff).toBeUndefined();
    // as sure as any other yes, so the chat moves to replied without asking the student
    expect(yesAndIntro.confidence).toBeGreaterThanOrEqual(PROPOSE_THRESHOLD);
    for (const body of [
      "Happy to chat! I'm cc'ing my EA Jordan to set up time.",
      "Looping in my assistant (cc'd) to find a time",
      'Copying my coordinator who handles my calendar',
    ]) {
      const r = sig(body);
      expect(r.signal, body).toBe('reply_positive');
      expect(r.extraction.handoff, body).toBeUndefined();
      expect(r.extraction.offers, body).toEqual([]);
    }
    // a redirect away from the sender, or an intro with no yes of their own, still hands off
    expect(
      sig("Happy to help, but I'm not the right person. My colleague Sana would be a better contact.")
        .extraction.handoff,
    ).toBe(true);
    expect(sig("Looping in Sam (cc'd) to find a time for you two to chat.").extraction.handoff).toBe(true);
    // a named colleague added to find a time, with no assistant role, is an intro to them
    for (const body of [
      "Looping in Sam (cc'd) to find a time to chat with you.",
      "Looping in Sam (cc'd) to set up a time with Alex.",
      "Cc'ing Sam to schedule a time, he runs the internship program.",
    ]) {
      const r = sig(body);
      expect(r.signal, body).toBe('intro_offer');
      expect(r.extraction.handoff, body).toBe(true);
    }
  });

  it('L5: a bare "best of luck" is a no only on an ask waiting for an answer, or next to a refusal', () => {
    for (const body of [
      'Wow, well done. Best of luck this summer!',
      'Nice work on the offer. Best of luck!',
      'Appreciate you sending this. Best of luck!',
      'Thanks for sharing, really cool to see. Best of luck!',
      'Way to go! Best of luck with the rest of the summer.',
      'Glad it was helpful. Best of luck!',
      'Sounds like a great opportunity. Best of luck!',
      'No worries at all. Best of luck!',
    ])
      expect(sig(body, false).signal, body).not.toBe('reply_decline');
    expect(sig('Thanks for reaching out. Best of luck with your search.', true).signal).toBe('reply_decline');
    expect(sig('Thanks for reaching out. Best of luck with your search.', false).signal).not.toBe(
      'reply_decline',
    );
    expect(sig("Sorry, we aren't hiring interns this cycle. Best of luck!", false).signal).toBe(
      'reply_decline',
    );
  });

  it('L6: passing on a call while inviting questions asks for email, never a referral', () => {
    const r = sig("I'll pass on a call for now but feel free to send over questions.");
    expect(r.signal).toBe('question');
    expect(r.extraction.prefersEmail).toBe(true);
    expect(r.extraction.offers).toEqual([]);
    // passing something along is still a referral
    expect(sig("I'll pass your resume along to the hiring manager.").signal).toBe('referral_offer');
    expect(sig('Happy to pass it on to our recruiter.').signal).toBe('referral_offer');
    expect(sig('I can pass this along to my manager.').signal).toBe('referral_offer');
    expect(sig("I'll pass that on to the team.").signal).toBe('referral_offer');
  });
});

describe('email understanding leftovers, round 2', () => {
  const ref = new Date('2026-10-01T13:00:00Z'); // Thursday 9:00 AM Eastern
  const ET = 'America/New_York';
  const sig = (body: string) => heuristicSignal(body, 'inbound', ref, { timeZone: ET });
  const slots = (body: string) =>
    sig(body).extraction.proposedTimes.map((t) =>
      new Date(t.startIso).toLocaleString('en-US', {
        timeZone: ET,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }),
    );
  /** schedule_propose cards for a replied chat whose last inbound is `body` */
  const proposeCards = (body: string) => {
    const h = sig(body);
    return generateCandidates({
      userId: 'u1',
      now: ref,
      settings: buildDemoDataset({ now: ref }).settings,
      people: new Map([
        [
          'p1',
          {
            id: 'p1',
            userId: 'u1',
            displayName: 'Priya Patel',
            firstName: 'Priya',
            lastName: 'Patel',
            emails: ['priya@figma.com'],
            isHuman: true,
          },
        ],
      ]),
      chats: [
        {
          id: 'c1',
          userId: 'u1',
          personId: 'p1',
          stage: 'replied',
          stageEnteredAt: '2026-09-30T16:00:00Z',
          source: 'detected',
          goalTags: [],
          bumpCount: 0,
          priority: 2,
          lastOutboundAt: '2026-09-28T16:00:00Z',
          createdAt: '2026-09-28T16:00:00Z',
          updatedAt: '2026-09-30T16:00:00Z',
        },
      ],
      lastInboundByChat: new Map([
        [
          'c1',
          {
            id: 'm1',
            sentAt: '2026-09-30T16:00:00Z',
            signal: h.signal,
            signalConfidence: h.confidence,
            extraction: h.extraction,
          },
        ],
      ]),
      events: [],
      actionItems: [],
      factsByPerson: new Map(),
      targetCompanies: [],
      recommendations: [],
      dismissCounts: new Map(),
      outreachSentThisWeek: 0,
      freeSlotsIso: ['2026-10-06T18:00:00Z'],
      recentlyContacted: new Set(),
    } as never).filter((c) => c.kind === 'schedule_propose');
  };

  it('"I\'ll pass this time" is a hard no: the chat is declined and nobody is told to propose times', () => {
    for (const body of [
      "I'll pass this time, sorry.",
      "I'll pass this time.",
      "I'm going to pass this round.",
      "I'm going to pass this time around, but thanks for thinking of me.",
    ]) {
      const r = sig(body);
      expect(r.signal, body).toBe('reply_decline');
      expect(r.extraction.decline, body).toBe('hard');
      expect(
        decideTransition('outreach_sent', {
          type: 'inbound_signal',
          signal: r.signal,
          confidence: r.confidence,
        })?.to,
        body,
      ).toBe('declined');
      expect(proposeCards(body), body).toHaveLength(0);
    }
    // passing something along is still a referral, not a no
    for (const body of [
      "I'll pass this along to the team.",
      "I'll pass that on to my manager.",
      "I'll pass on your resume.",
    ])
      expect(sig(body).signal, body).toBe('referral_offer');
  });

  it('an office the sender works out of is where they are, not a day they are away', () => {
    for (const [body, signal] of [
      [
        "I'm working out of our Boston office Tuesday and free at 2pm, want to grab coffee?",
        'scheduling_proposal',
      ],
      ["I'm based out of SF and Tuesday at 2pm PT works.", 'scheduling_proposal'],
      ["I'm working out of the NYC office Tuesday at 2pm, happy to meet there.", 'scheduling_proposal'],
    ] as const) {
      expect(sig(body).signal, body).toBe(signal);
      expect(sig(body).extraction.proposedTimes, body).toHaveLength(1);
    }
    expect(slots("I'm working out of the NYC office Tuesday at 2pm, happy to meet there.")).toEqual([
      'Tue 14:00',
    ]);
    // 2pm Pacific is 5pm Eastern
    expect(slots("I'm based out of SF and Tuesday at 2pm PT works.")).toEqual(['Tue 17:00']);
    // being out still takes the day away
    expect(slots("I'm also out Monday, Tuesday at 2 works.")).toEqual(['Tue 14:00']);
    expect(slots("I'm out Monday at 2, but Tuesday at 2 works.")).toEqual(['Tue 14:00']);
    expect(slots('I teach a class Monday at 6 but could do Tuesday at 6pm.')).toEqual(['Tue 18:00']);
    expect(slots('Wednesday is booked solid. Thursday at 10 or 11 either works.')).toEqual([
      'Thu 10:00',
      'Thu 11:00',
    ]);
  });

  it('a yes plus "you should talk to Ana" is a yes with an extra intro: times go to the sender', () => {
    for (const body of [
      'Happy to chat next week! You should talk to Ana on my team too, she did the same rotation.',
      'Happy to chat. You should also talk to Ana.',
      'Happy to chat! You should talk to Ana too',
    ]) {
      const r = sig(body);
      expect(r.signal, body).toBe('intro_offer');
      expect(r.extraction.handoff, body).toBeUndefined();
      expect(r.confidence, body).toBeGreaterThanOrEqual(PROPOSE_THRESHOLD);
      expect(proposeCards(body), body).toHaveLength(1);
    }
    // sending the student to Ana instead of a chat of their own still hands off
    const away = 'Happy to help, but honestly you should talk to Ana instead, she is the one hiring.';
    expect(sig(away).extraction.handoff).toBe(true);
    expect(proposeCards(away)).toHaveLength(0);
  });
});

describe('note extraction', () => {
  it('finds offers, action items, hooks, advice', () => {
    const r = heuristicNoteExtraction(
      'Priya recommended focusing on one project story. They are hiring interns in January. Priya offered to refer me when the posting goes up. I will send my resume by Friday. She ran a marathon in April.',
      'Priya',
    );
    expect(r.offers.length).toBe(1);
    expect(r.actionItems[0]?.text).toContain('resume');
    expect(r.actionItems[0]?.dueHint).toMatch(/friday/i);
    expect(r.facts.some((f) => f.type === 'advice')).toBe(true);
    expect(r.facts.some((f) => f.type === 'hook')).toBe(true);
    expect(r.facts.some((f) => f.type === 'personal')).toBe(true);
  });
});

describe('warm-up', () => {
  it('plans three actions and becomes ready after the window with at least one done', () => {
    const start = new Date('2026-10-01T10:00:00Z');
    const plan = buildWarmUpPlan('priya-patel', start, 4);
    expect(plan.actions.length).toBe(3);
    expect(plan.actions[1]!.url).toContain('recent-activity');
    expect(warmUpProgress(plan, new Date('2026-10-02T10:00:00Z')).ready).toBe(false);
    plan.actions[0]!.doneAt = '2026-10-01T11:00:00Z';
    // four working days after Thursday Oct 1 is Wednesday Oct 7 (the weekend does not count)
    expect(warmUpProgress(plan, new Date('2026-10-08T10:00:00Z')).ready).toBe(true);
    expect(warmUpProgress(plan, new Date('2026-10-02T10:00:00Z')).nextAction?.id).toBe('w2');
  });

  it('never puts a step on a weekend (EG-20)', () => {
    const plan = buildWarmUpPlan('x', new Date(2026, 9, 2, 10), 4); // Friday Oct 2, local time
    const days = [...plan.actions.slice(1).map((a) => a.dueAt), plan.readyAt].map((d) =>
      new Date(d).getDay(),
    );
    expect(days.every((d) => d !== 0 && d !== 6)).toBe(true);
    expect(new Date(plan.actions[1]!.dueAt).getDate()).toBe(6); // Tuesday, not Sunday Oct 4
    expect(new Date(plan.readyAt).getDate()).toBe(8); // Thursday
  });
});

describe('blind-test misses: the causes, not the strings', () => {
  const ref = new Date('2026-10-01T13:00:00Z'); // Thursday 9:00 AM Eastern
  const ET = 'America/New_York';
  const sig = (body: string) => heuristicSignal(body, 'inbound', ref, { timeZone: ET });
  const slots = (body: string) =>
    sig(body).extraction.proposedTimes.map(
      (t) =>
        `${new Date(t.startIso).toLocaleString('en-US', {
          timeZone: t.timeZone ?? ET,
          weekday: 'short',
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        })}${t.timeZone ? ` ${t.timeZone}` : ''}`,
    );

  it('a bare time in the sentence after a day takes that day', () => {
    expect(slots('Friday is good. 11am?')).toEqual(['Fri, 10/2, 11:00']);
    expect(sig('Friday is good. 11am?').signal).toBe('scheduling_proposal');
    // not a day the sender says is taken
    expect(slots("I'm out Friday. 11am?")).toEqual([]);
  });

  it('"later that day" and "that afternoon" reuse the day named before, and a stated zone holds for the sentence', () => {
    expect(slots('Tue 10/6 at 9am CT works, or that afternoon at 3.')).toEqual([
      'Tue, 10/6, 09:00 America/Chicago',
      'Tue, 10/6, 15:00 America/Chicago',
    ]);
    expect(slots('Wednesday at 10am, or later the same day around 4pm.')).toEqual([
      'Wed, 10/7, 10:00',
      'Wed, 10/7, 16:00',
    ]);
  });

  it('an invitation to come back sets the follow-up date and softens a no', () => {
    expect(followUpDate('Heads down until our launch in March. Reach back out in April?', ref, ET)).toBe(
      '2027-04-01',
    );
    expect(followUpDate('try me in Q2', ref, ET)).toBe('2027-04-01');
    expect(followUpDate('maybe after Q1', ref, ET)).toBe('2027-04-01');
    const r = sig("I'll have to say no for the moment, but ask me again next spring.");
    expect(r.signal).toBe('reply_decline');
    expect(r.extraction.decline).toBe('soft');
    expect(r.extraction.followUpAfter).toBe('2027-03-01');
  });

  it('a no to a call with an article still pairs with a yes to written questions', () => {
    const r = sig("I can't take a call this month, but happy to answer questions in this thread.");
    expect(r.signal).toBe('question');
    expect(r.extraction.prefersEmail).toBe(true);
  });

  it('an assistant added to find a time is a yes, even with "looking forward to it"', () => {
    expect(sig("cc'ing my EA Sam to find us a time. Looking forward to it.").signal).toBe('reply_positive');
    // a real confirmation still is one
    expect(sig('Accepted the invite, looking forward to it.').signal).toBe('scheduling_confirmation');
  });
});
