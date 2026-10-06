import { describe, expect, it } from 'vitest';
import { extractProposedTimes, heuristicSignal, heuristicTriage } from '../email/triage';
import { heuristicNoteExtraction } from '../notes/extract';
import { canTransition, decideTransition } from '../pipeline/transitions';
import {
  htmlToText,
  isAutomatedSender,
  isCalendarNotice,
  parseAddress,
  parseAddressList,
  splitSignature,
  stripQuotedReply,
} from '../text/email';
import { buildWarmUpPlan, warmUpProgress } from '../warmup/rules';

describe('transitions', () => {
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
    expect(warmUpProgress(plan, new Date('2026-10-06T10:00:00Z')).ready).toBe(true);
    expect(warmUpProgress(plan, new Date('2026-10-02T10:00:00Z')).nextAction?.id).toBe('w2');
  });
});
