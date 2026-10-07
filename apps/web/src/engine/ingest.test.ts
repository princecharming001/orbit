import type { User } from '@orbit/core';
import { buildDemoDataset, parseAddressList } from '@orbit/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { ingestEmails, type RawEmail } from './ingest';

// Monday 5 October 2026, 9:00 AM Pacific
const NOW = new Date('2026-10-05T16:00:00Z');
let user: User;
let seq = 0;

function raw(p: Partial<RawEmail> & { from: string; bodyText: string; sentAt: string }): RawEmail {
  seq++;
  return {
    externalMessageId: `m${seq}`,
    externalThreadId: 't1',
    to: [],
    cc: [],
    subject: 'Cornell junior, quick question',
    headers: {},
    ...p,
  };
}
const ALEX = 'Alex Rivera <alex@cornell.edu>';
const OUTREACH =
  "Hi there,\n\nI'm a junior at Cornell studying CS. Would you be open to a brief chat in the next few weeks? I'd really value your perspective.\n\nBest,\nAlex";

async function chatFor(email: string) {
  const person = await db.people.filter((p) => p.emails.includes(email)).first();
  const chat = person ? await db.chats.where('personId').equals(person.id).first() : undefined;
  return { person, chat };
}

beforeEach(async () => {
  await wipeDatabase();
  const ds = buildDemoDataset({ now: NOW });
  user = {
    ...ds.user,
    email: 'alex@cornell.edu',
    fullName: 'Alex Rivera',
    firstName: 'Alex',
    lastName: 'Rivera',
    school: 'Cornell University',
    schoolDomain: 'cornell.edu',
    timezone: 'America/Los_Angeles',
  };
  await db.users.put(user);
  await db.settings.put({ ...ds.settings, userId: user.id });
  await db.goals.put({ ...ds.goals, userId: user.id });
});

describe('ingest: email understanding', () => {
  it('treats a person at a big bulk-mail employer as human and reads an explicit timezone', async () => {
    await ingestEmails(
      user,
      [
        raw({
          from: ALEX,
          to: ['Sarah Chen <sarah.chen@capitalone.com>'],
          bodyText: OUTREACH,
          sentAt: '2026-10-01T15:00:00Z',
        }),
        raw({
          from: 'Sarah Chen <sarah.chen@capitalone.com>',
          to: [ALEX],
          bodyText: 'Happy to chat! Does Thursday at 2pm ET work for you?\n\nSarah',
          sentAt: '2026-10-02T15:00:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    const { person, chat } = await chatFor('sarah.chen@capitalone.com');
    expect(person?.isHuman).toBe(true);
    expect(chat?.stage).toBe('scheduling');
    const reply = await db.messages.where('externalMessageId').equals(`m${seq}`).first();
    expect(reply?.isAutomated).toBe(false);
    expect(reply?.signal).toBe('scheduling_proposal');
    // 2pm Eastern on Thursday 8 October is 18:00 UTC (11 AM for a Pacific student), not 2pm Pacific
    expect(reply?.extraction?.proposedTimes[0]?.startIso).toBe('2026-10-08T18:00:00.000Z');
    expect(reply?.extraction?.proposedTimes[0]?.timeZone).toBe('America/New_York');
  });

  it('treats mail from a send-as alias as the student’s own', async () => {
    await ingestEmails(
      user,
      [
        raw({
          from: 'Alex Rivera <ar123@cornell.edu>',
          to: ['Tom Baker <tom@figma.com>'],
          bodyText: OUTREACH,
          sentAt: '2026-10-01T15:00:00Z',
          labels: ['SENT'],
        }),
        raw({
          from: 'Tom Baker <tom@figma.com>',
          to: ['Alex Rivera <ar123@cornell.edu>'],
          bodyText: 'Sure, happy to chat. Does Friday at 11am work?',
          sentAt: '2026-10-02T15:00:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    const msgs = await db.messages.orderBy('sentAt').toArray();
    expect(msgs.map((m) => m.direction)).toEqual(['outbound', 'inbound']);
    expect(await db.people.filter((p) => p.emails.includes('ar123@cornell.edu')).count()).toBe(0);
    const { chat } = await chatFor('tom@figma.com');
    expect(chat?.stage).toBe('scheduling');
  });

  it('recognises a school-domain alias by the student’s own name without a SENT label', async () => {
    await ingestEmails(
      user,
      [
        raw({
          from: '"Rivera, Alex" <ar123@cornell.edu>',
          to: ['"Baker, Tom" <tom@figma.com>'],
          bodyText: OUTREACH,
          sentAt: '2026-10-01T15:00:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    const m = await db.messages.toCollection().first();
    expect(m?.direction).toBe('outbound');
    expect(m?.toEmails).toEqual(['tom@figma.com']);
  });

  it('records an out-of-office auto-reply with its return date and holds the bump', async () => {
    await ingestEmails(
      user,
      [
        raw({ from: ALEX, to: ['nina@google.com'], bodyText: OUTREACH, sentAt: '2026-09-21T15:00:00Z' }),
        raw({
          from: 'Nina Patel <nina@google.com>',
          to: [ALEX],
          subject: 'Automatic reply: Cornell junior, quick question',
          headers: { 'auto-submitted': 'auto-replied' },
          bodyText:
            'Thank you for your email. I am out of the office until Monday, October 19 with limited access to email.',
          sentAt: '2026-09-21T15:01:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    const { chat } = await chatFor('nina@google.com');
    expect(chat?.stage).toBe('outreach_sent');
    expect(chat?.outOfOfficeUntil).toBe('2026-10-19');
    const ooo = await db.messages.where('externalMessageId').equals(`m${seq}`).first();
    expect(ooo?.isAutomated).toBe(true);
    expect(ooo?.signal).toBe('out_of_office');
    expect(ooo?.extraction?.returnDate).toBe('2026-10-19');
    const bumps = await db.suggestions.filter((s) => s.kind === 'follow_up_bump').count();
    expect(bumps).toBe(0);
  });

  it('reads an intro with the new person on CC and opens a chat for them credited to the introducer', async () => {
    await ingestEmails(
      user,
      [
        raw({
          from: ALEX,
          to: ['Dana Ortiz <dana@figma.com>'],
          bodyText: OUTREACH,
          sentAt: '2026-10-01T15:00:00Z',
        }),
        raw({
          from: 'Dana Ortiz <dana@figma.com>',
          to: [ALEX],
          cc: ['Sam Cho <sam@figma.com>'],
          bodyText:
            "Of course! Looping in Sam (cc'd) who leads growth. Sam, Alex is a Cornell junior who would love 15 minutes.",
          sentAt: '2026-10-02T15:00:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    const thread = await db.threads.toCollection().first();
    expect(thread?.isNetworking).toBe(true);
    const dana = await chatFor('dana@figma.com');
    expect(dana.chat?.stage).toBe('replied');
    const sam = await chatFor('sam@figma.com');
    expect(sam.chat?.stage).toBe('identified');
    expect(sam.chat?.referrerPersonId).toBe(dana.person?.id);
    const intro = await db.messages.where('externalMessageId').equals(`m${seq}`).first();
    expect(intro?.signal).toBe('intro_offer');
  });

  it('skips a Google Calendar invitation from a human organizer', async () => {
    await ingestEmails(
      user,
      [
        raw({ from: ALEX, to: ['rae@figma.com'], bodyText: OUTREACH, sentAt: '2026-10-01T15:00:00Z' }),
        raw({
          from: 'Rae Kim <rae@figma.com>',
          to: [ALEX],
          subject: 'Invitation: Coffee chat @ Thu Oct 8, 2pm - 2:30pm (PDT)',
          headers: { sender: 'Google Calendar <calendar-notification@google.com>' },
          bodyText:
            'You have been invited to the following event.\n\nJoin with Google Meet\nInvitation from Google Calendar',
          sentAt: '2026-10-02T15:00:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    const invite = await db.messages.where('externalMessageId').equals(`m${seq}`).first();
    expect(invite?.isAutomated).toBe(true);
    expect(invite?.signal).toBeUndefined();
    expect(await db.suggestions.filter((s) => s.kind === 'schedule_propose').count()).toBe(0);
  });

  it('retires the "confirm it" card once a calendar invitation for that time arrives', async () => {
    const reply = raw({
      from: 'Rae Kim <rae@figma.com>',
      to: [ALEX],
      bodyText: 'Happy to chat. How about Thursday at 2pm?\n\nRae',
      sentAt: '2026-10-05T15:00:00Z',
    });
    await ingestEmails(
      user,
      [raw({ from: ALEX, to: ['rae@figma.com'], bodyText: OUTREACH, sentAt: '2026-10-01T15:00:00Z' }), reply],
      { useLlm: false, now: NOW },
    );
    const confirm = () => db.suggestions.filter((s) => s.kind === 'schedule_confirm').toArray();
    expect((await confirm()).map((s) => s.status)).toEqual(['pending']);
    await ingestEmails(
      user,
      [
        raw({
          from: 'Rae Kim <rae@figma.com>',
          to: [ALEX],
          subject: 'Invitation: Coffee chat @ Thu Oct 8, 2pm - 2:30pm (PDT)',
          headers: { sender: 'Google Calendar <calendar-notification@google.com>' },
          bodyText:
            'You have been invited to the following event.\n\nJoin with Google Meet\nInvitation from Google Calendar',
          sentAt: '2026-10-05T15:30:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    expect((await confirm()).map((s) => s.status)).toEqual(['expired']);
    expect(
      await db.suggestions.filter((s) => s.status === 'pending' && s.kind.startsWith('schedule')).count(),
    ).toBe(0);
  });

  it('a warm "best of luck" reply on a nurturing chat proposes no decline', async () => {
    await ingestEmails(
      user,
      [raw({ from: ALEX, to: ['priya@figma.com'], bodyText: OUTREACH, sentAt: '2026-09-01T15:00:00Z' })],
      { useLlm: false, now: NOW },
    );
    const { chat } = await chatFor('priya@figma.com');
    await db.chats.update(chat!.id, { stage: 'nurturing' });
    await ingestEmails(
      user,
      [
        raw({
          from: ALEX,
          to: ['priya@figma.com'],
          bodyText:
            'Hi Priya,\n\nQuick update: I accepted the Figma internship offer for this summer.\n\nBest,\nAlex',
          sentAt: '2026-10-03T15:00:00Z',
        }),
        raw({
          from: 'Priya Sharma <priya@figma.com>',
          to: [ALEX],
          bodyText: 'Congrats Alex, that is awesome news! Best of luck this summer.\n\nPriya',
          sentAt: '2026-10-04T15:00:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    expect((await db.chats.get(chat!.id))?.stage).toBe('nurturing');
    expect(await db.stageEvents.filter((e) => e.toStage === 'declined').count()).toBe(0);
  });

  it('an intro hands off: no propose-times card for the introducer, an outreach card for the person introduced', async () => {
    await ingestEmails(
      user,
      [
        raw({
          from: ALEX,
          to: ['Dana Ortiz <dana@figma.com>'],
          bodyText: OUTREACH,
          sentAt: '2026-10-01T15:00:00Z',
        }),
        raw({
          from: 'Dana Ortiz <dana@figma.com>',
          to: [ALEX],
          cc: ['Sam Cho <sam@figma.com>'],
          bodyText: "Of course! Looping in Sam (cc'd) who leads growth. Sam, Alex is a Cornell junior.",
          sentAt: '2026-10-04T15:00:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    const dana = await chatFor('dana@figma.com');
    const sam = await chatFor('sam@figma.com');
    const pending = await db.suggestions.filter((s) => s.status === 'pending').toArray();
    expect(
      pending.filter((s) => s.kind === 'schedule_propose' && s.personId === dana.person?.id),
    ).toHaveLength(0);
    const toSam = pending.find((s) => s.kind === 'new_outreach' && s.personId === sam.person?.id);
    expect(toSam?.chatId).toBe(sam.chat?.id);
    expect(toSam?.reasonText).toContain('Dana introduced you to Sam');
  });

  it('L4: the intro card is retired once the student writes to the person introduced', async () => {
    await ingestEmails(
      user,
      [
        raw({
          from: ALEX,
          to: ['Dana Ortiz <dana@figma.com>'],
          bodyText: OUTREACH,
          sentAt: '2026-10-01T15:00:00Z',
        }),
        raw({
          from: 'Dana Ortiz <dana@figma.com>',
          to: [ALEX],
          cc: ['Sam Cho <sam@figma.com>'],
          bodyText: "Of course! Looping in Sam (cc'd) who leads growth. Sam, Alex is a Cornell junior.",
          sentAt: '2026-10-04T15:00:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    const sam = await chatFor('sam@figma.com');
    const card = () =>
      db.suggestions.filter((s) => s.kind === 'new_outreach' && s.personId === sam.person?.id).first();
    expect((await card())?.status).toBe('pending');
    await ingestEmails(
      user,
      [
        raw({
          externalThreadId: 't2',
          from: ALEX,
          to: ['Sam Cho <sam@figma.com>'],
          subject: 'Dana suggested I write',
          // a first note that already offers times leaves the chat where it was, but it is still written
          bodyText:
            "Hi Sam,\n\nDana suggested I write. I'm a junior at Cornell studying CS. Would Thursday at 2pm or Friday at 10am work for a quick chat?\n\nBest,\nAlex",
          sentAt: '2026-10-05T15:00:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    expect((await db.chats.get(sam.chat!.id))?.lastOutboundAt).toBe('2026-10-05T15:00:00Z');
    expect((await card())?.status).toBe('expired');
  });

  it("L3: a yes with the sender's assistant cc'd to find a time proposes times and writes to nobody else", async () => {
    await ingestEmails(
      user,
      [
        raw({
          from: ALEX,
          to: ['Dana Ortiz <dana@figma.com>'],
          bodyText: OUTREACH,
          sentAt: '2026-10-01T15:00:00Z',
        }),
        raw({
          from: 'Dana Ortiz <dana@figma.com>',
          to: [ALEX],
          cc: ['Jordan Lee <jordan@figma.com>'],
          bodyText: "Happy to chat! I'm cc'ing my EA Jordan to set up time.\n\nDana",
          sentAt: '2026-10-04T15:00:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    const dana = await chatFor('dana@figma.com');
    const jordan = await chatFor('jordan@figma.com');
    const pending = await db.suggestions.filter((s) => s.status === 'pending').toArray();
    expect(
      pending.filter((s) => s.kind === 'schedule_propose' && s.personId === dana.person?.id),
    ).toHaveLength(1);
    expect(jordan.chat).toBeUndefined();
    expect(pending.filter((s) => s.kind === 'new_outreach')).toHaveLength(0);
  });

  it('L3: a yes to a chat that also mentions a colleague moves the chat to replied and proposes times', async () => {
    await ingestEmails(
      user,
      [
        raw({
          from: ALEX,
          to: ['Dana Ortiz <dana@figma.com>'],
          bodyText: OUTREACH,
          sentAt: '2026-10-01T15:00:00Z',
        }),
        raw({
          from: 'Dana Ortiz <dana@figma.com>',
          to: [ALEX],
          bodyText:
            'Happy to chat next week. My colleague Ana would be great too, I can connect you after.\n\nDana',
          sentAt: '2026-10-04T15:00:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    const dana = await chatFor('dana@figma.com');
    expect(dana.chat?.stage).toBe('replied');
    const pending = await db.suggestions
      .filter((s) => s.status === 'pending' && s.personId === dana.person?.id)
      .toArray();
    expect(pending.filter((s) => s.kind === 'schedule_propose')).toHaveLength(1);
    expect(pending.filter((s) => s.kind === 'confirm_stage')).toHaveLength(0);
  });

  it('L5: a bare "best of luck" is a decline on a chat waiting on an answer, a friendly close otherwise', async () => {
    await ingestEmails(
      user,
      [
        raw({ from: ALEX, to: ['priya@figma.com'], bodyText: OUTREACH, sentAt: '2026-10-01T15:00:00Z' }),
        raw({
          from: 'Priya Sharma <priya@figma.com>',
          to: [ALEX],
          bodyText: 'Thanks for reaching out. Best of luck with your search.\n\nPriya',
          sentAt: '2026-10-02T15:00:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    expect(await db.stageEvents.filter((e) => e.toStage === 'declined').count()).toBe(1);
    await ingestEmails(
      user,
      [
        raw({
          externalThreadId: 't3',
          from: ALEX,
          to: ['omar@figma.com'],
          bodyText: OUTREACH,
          sentAt: '2026-09-01T15:00:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    const { chat } = await chatFor('omar@figma.com');
    await db.chats.update(chat!.id, { stage: 'nurturing' });
    await ingestEmails(
      user,
      [
        raw({
          externalThreadId: 't3',
          from: ALEX,
          to: ['omar@figma.com'],
          bodyText: 'Hi Omar,\n\nQuick update: I got the Figma internship offer.\n\nBest,\nAlex',
          sentAt: '2026-10-03T15:00:00Z',
        }),
        raw({
          externalThreadId: 't3',
          from: 'Omar Haddad <omar@figma.com>',
          to: [ALEX],
          bodyText: 'Nice work on the offer. Best of luck!\n\nOmar',
          sentAt: '2026-10-04T15:00:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    expect((await db.chats.get(chat!.id))?.stage).toBe('nurturing');
    expect(
      await db.stageEvents.filter((e) => e.toStage === 'declined' && e.chatId === chat!.id).count(),
    ).toBe(0);
  });

  it('moves a completed chat to followed_up on a natural thank-you note', async () => {
    await ingestEmails(
      user,
      [raw({ from: ALEX, to: ['priya@figma.com'], bodyText: OUTREACH, sentAt: '2026-09-20T15:00:00Z' })],
      { useLlm: false, now: NOW },
    );
    const { chat } = await chatFor('priya@figma.com');
    await db.chats.update(chat!.id, { stage: 'completed', completedAt: '2026-10-02T18:00:00Z' });
    await ingestEmails(
      user,
      [
        raw({
          from: ALEX,
          to: ['priya@figma.com'],
          bodyText:
            'Hi Priya,\n\nThank you again for the great conversation yesterday. Your point about owning one project end-to-end really stuck with me.\n\nBest,\nAlex',
          sentAt: '2026-10-03T15:00:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    expect((await db.chats.get(chat!.id))?.stage).toBe('followed_up');
  });

  it('keeps the Calendly link in the stored body and drops the wrapped Gmail quote header', async () => {
    await ingestEmails(
      user,
      [
        raw({ from: ALEX, to: ['priya@figma.com'], bodyText: OUTREACH, sentAt: '2026-10-01T15:00:00Z' }),
        raw({
          from: 'Priya Sharma <priya@figma.com>',
          to: [ALEX],
          bodyText:
            'Hi Alex,\n\nHappy to chat. Grab any slot here: https://calendly.com/priya/20min\n\nBest,\nPriya\n\nOn Thu, Oct 1, 2026 at 8:00 AM Alexander Rivera <\nalex@cornell.edu> wrote:\n\n> Hi there,\n> Would you be open to a brief chat?',
          sentAt: '2026-10-02T15:00:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    const reply = await db.messages.where('externalMessageId').equals(`m${seq}`).first();
    expect(reply?.bodyText).toContain('https://calendly.com/priya/20min');
    expect(reply?.bodyText).not.toMatch(/wrote:|alex@cornell\.edu/);
    expect(reply?.signal).toBe('scheduling_proposal');
  });
});

describe('ingest: senders, responders and address lists', () => {
  it('PS-9: a vacation responder without auto-reply headers is not a reply and holds the bump', async () => {
    await ingestEmails(
      user,
      [
        raw({
          from: ALEX,
          to: ['Felix Wagner <felix.wagner@deloitte.com>'],
          bodyText: OUTREACH,
          sentAt: '2026-10-05T15:00:00Z',
        }),
        raw({
          from: 'Felix Wagner <felix.wagner@deloitte.com>',
          to: [ALEX],
          subject: 'Re: Cornell junior, quick question',
          bodyText:
            'Thanks for your email. I am traveling this week with limited access to email and will get back to you when I return.',
          sentAt: '2026-10-05T15:02:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    const { chat } = await chatFor('felix.wagner@deloitte.com');
    expect(chat?.stage).toBe('outreach_sent');
    expect(chat?.lastInboundAt).toBeUndefined();
    expect(chat?.outOfOfficeUntil).toBe('2026-10-12');
    const ooo = await db.messages.where('externalMessageId').equals(`m${seq}`).first();
    expect(ooo?.isAutomated).toBe(true);
    expect(ooo?.signal).toBe('out_of_office');
    const proposals = await db.stageEvents
      .filter((e) => e.chatId === chat?.id && e.toStage === 'replied')
      .count();
    expect(proposals).toBe(0);
  });

  it('PS-9: a hand-typed "on vacation until" note does not count as a reply', async () => {
    await ingestEmails(
      user,
      [
        raw({
          from: ALEX,
          to: ['Omar Haddad <omar@stripe.com>'],
          bodyText: OUTREACH,
          sentAt: '2026-10-02T15:00:00Z',
        }),
        raw({
          from: 'Omar Haddad <omar@stripe.com>',
          to: [ALEX],
          subject: 'Re: Cornell junior, quick question',
          bodyText: "I'm on vacation until October 14, I'll get back to you when I return.",
          sentAt: '2026-10-03T15:00:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    const { chat } = await chatFor('omar@stripe.com');
    expect(chat?.stage).toBe('outreach_sent');
    expect(chat?.lastInboundAt).toBeUndefined();
    expect(chat?.outOfOfficeUntil).toBe('2026-10-14');
    const m = await db.messages.where('externalMessageId').equals(`m${seq}`).first();
    expect(m?.signal).toBe('out_of_office');
  });

  it('NRC-02 / IS-2: a quoted "Last, First" name is one person, and a fragment without an address is none', async () => {
    const stats = await ingestEmails(
      user,
      [
        raw({
          from: ALEX,
          to: parseAddressList('"Patel, Priya" <priya@figma.com>, Dan Kim <dan.kim@stripe.com>'),
          bodyText: OUTREACH,
          sentAt: '2026-10-01T15:00:00Z',
        }),
        raw({
          externalThreadId: 't2',
          from: ALEX,
          // what a naive comma split used to hand over
          to: ['"Patel', 'Lee" <ann.lee@figma.com>'],
          bodyText: OUTREACH,
          sentAt: '2026-10-01T16:00:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    const people = await db.people.toArray();
    expect(people.every((p) => p.emails.every((e) => e.includes('@')))).toBe(true);
    expect(people.map((p) => p.primaryEmail).sort()).toEqual([
      'ann.lee@figma.com',
      'dan.kim@stripe.com',
      'priya@figma.com',
    ]);
    expect(stats.people).toBe(3);
    const priya = people.find((p) => p.primaryEmail === 'priya@figma.com');
    expect(priya?.firstName).toBe('Priya');
    expect(priya?.lastName).toBe('Patel');
  });

  it('NRC-12: campus recruiting inboxes are not people; a founder writing from hello@ is', async () => {
    await ingestEmails(
      user,
      [
        raw({
          from: ALEX,
          to: ['Goldman Sachs University Recruiting <university-recruiting@goldman.com>'],
          bodyText:
            'Hello, I wanted to ask whether the summer analyst application is reviewed on a rolling basis.',
          sentAt: '2026-10-01T15:00:00Z',
        }),
        raw({
          externalThreadId: 't2',
          from: 'JPMorgan Campus Recruiting <campusrecruiting@jpmorgan.com>',
          to: [ALEX],
          bodyText: 'Thank you for applying. Your application is under review.',
          sentAt: '2026-10-02T15:00:00Z',
        }),
        raw({
          externalThreadId: 't3',
          from: 'Maya Chen <hello@tinystartup.io>',
          to: [ALEX],
          subject: 'Re: Cornell junior, quick question',
          bodyText: 'Hey Alex, happy to chat about dev tools. Does Thursday at 2pm work?\n\nMaya',
          sentAt: '2026-10-02T16:00:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    const gs = await db.people.filter((p) => p.emails.includes('university-recruiting@goldman.com')).first();
    expect(gs?.isHuman).toBe(false);
    expect(await db.people.filter((p) => p.emails.includes('campusrecruiting@jpmorgan.com')).count()).toBe(0);
    const jpm = await db.messages.filter((m) => m.fromEmail === 'campusrecruiting@jpmorgan.com').first();
    expect(jpm?.isAutomated).toBe(true);
    const { person: maya } = await chatFor('hello@tinystartup.io');
    expect(maya?.isHuman).toBe(true);
    expect(maya?.firstName).toBe('Maya');
  });

  it('EU-20: reads the title and employer from a "Name | Title | Company" signature', async () => {
    await ingestEmails(
      user,
      [
        raw({
          from: ALEX,
          to: ['Priya Patel <priya@figma.com>'],
          bodyText: OUTREACH,
          sentAt: '2026-10-01T15:00:00Z',
        }),
        raw({
          from: 'Priya Patel <priya@figma.com>',
          to: [ALEX],
          bodyText: 'Happy to chat next week.\n\nBest,\nPriya Patel | Product Manager | Figma\n415-555-0100',
          sentAt: '2026-10-02T15:00:00Z',
        }),
      ],
      { useLlm: false, now: NOW },
    );
    const { person } = await chatFor('priya@figma.com');
    expect(person?.currentTitle).toBe('Product Manager');
    expect(person?.currentOrganizationRaw ?? '').toMatch(/Figma/);
  });
});
