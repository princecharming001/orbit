/**
 * The skeptical student's checklist (plan 17 §F): a real-looking account, not the demo, seeded through the same
 * import paths a student's data takes (Gmail threads with a group email and a newsletter, a calendar with a class, a
 * one-on-one and a small meeting, LinkedIn connections with tricky headlines, notes that only mention people, texts),
 * and every claim the Person page, People, Drafts and the morning brief make about someone checked against what
 * Orbit actually holds.
 */
import type { Person, Touchpoint, User } from '@orbit/core';
import { buildDemoDataset, DEMO_ORGS, isRecruiter, newId } from '@orbit/core';
import initSqlJs from 'sql.js';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadSchoolIndex, sameSchool } from '../data/schoolMatch';
import { db, wipeDatabase } from '../db/schema';
import { setSqlJsForTests } from '../integrations/imessageDb';
import { createLocalUser } from './account';
import { recomputeAlumni, schoolTie } from './alumni';
import { draftMessage, recommendationsRefresh } from './brief';
import { importMeetings } from './fathom';
import { importTexts } from './imessage';
import { ingestEmails, ingestEvents, type RawEmail, type RawEvent } from './ingest';
import { importLiveConnections } from './linkedin';
import { morningDeck } from './morning';
import { ingestNote, noteIsPlanOnly, noteSaysMet } from './notes';
import { addPersonByHand } from './people';
import { personSummary } from './prep';
import { REPAIR_VERSION, repairClaims } from './repair';
import { currentResumeFacets } from './resume';

// Wednesday 21 October 2026, 10:00 in California
const NOW = new Date('2026-10-21T17:00:00Z');
const DAY = 86_400_000;
const ago = (days: number, hourUtc = 17) =>
  new Date(Date.UTC(2026, 9, 21 - days, hourUtc, 0, 0)).toISOString();

const appleNs = (iso: string) => (Date.parse(iso) - Date.UTC(2001, 0, 1)) * 1e6;
async function textsDb(): Promise<Uint8Array> {
  const SQL = await initSqlJs();
  const d = new SQL.Database();
  d.run(`
    create table handle (ROWID integer primary key, id text);
    create table chat (ROWID integer primary key, chat_identifier text);
    create table chat_handle_join (chat_id integer, handle_id integer);
    create table chat_message_join (chat_id integer, message_id integer);
    create table message (ROWID integer primary key, date integer, is_from_me integer, text text, attributedBody blob,
      associated_message_type integer default 0, item_type integer default 0, handle_id integer);
    insert into handle values (1, '+1 (555) 222-3333');
    insert into chat values (1, 'ana');
    insert into chat_handle_join values (1, 1);
  `);
  const msg = (id: number, iso: string, fromMe: 0 | 1, text: string) => {
    d.run('insert into message (ROWID, date, is_from_me, text) values (?, ?, ?, ?)', [
      id,
      appleNs(iso),
      fromMe,
      text,
    ]);
    d.run('insert into chat_message_join values (1, ?)', [id]);
  };
  msg(1, ago(12), 1, 'Hey Ana, are you around this week?');
  msg(2, ago(12, 18), 0, 'Yes! Lunch Thursday?');
  msg(3, ago(5), 0, 'Great seeing you');
  return d.export();
}
const VCF = `BEGIN:VCARD
VERSION:3.0
N:Ruiz;Ana;;;
FN:Ana Ruiz
TEL;type=CELL:(555) 222-3333
END:VCARD`;

let seq = 0;
const mail = (p: Partial<RawEmail> & { from: string; bodyText: string; sentAt: string }): RawEmail => ({
  externalMessageId: `m${++seq}`,
  externalThreadId: `t${seq}`,
  to: [],
  cc: [],
  subject: 'Hello',
  headers: {},
  ...p,
});
const ME = 'Jordan Lee <jordan.lee@berkeley.edu>';

let user: User;
const byName = async (name: string) =>
  (await db.people.where('userId').equals(user.id).toArray()).find((p) => p.displayName === name);
const must = async (name: string) => {
  const p = await byName(name);
  if (!p) throw new Error(`${name} is not in Orbit`);
  return p;
};
const touchesOf = (id: string) => db.touchpoints.where('personId').equals(id).toArray();
const summaryOf = async (p: Person) =>
  personSummary({
    user,
    person: (await db.people.get(p.id))!,
    facts: await db.facts.where('personId').equals(p.id).toArray(),
    touchpoints: await touchesOf(p.id),
    now: NOW,
  }).summary;

async function seedAccount() {
  user = await createLocalUser({
    fullName: 'Jordan Lee',
    firstName: 'Jordan',
    lastName: 'Lee',
    email: 'jordan.lee@berkeley.edu',
    // written the way students write it, not the list's "University of California, Berkeley"
    school: 'UC Berkeley',
    graduationYear: 2027,
    majors: ['Computer Science'],
    timezone: 'America/Los_Angeles',
    onboardingStep: 11,
    onboardingCompletedAt: ago(30),
  });
  const ds = buildDemoDataset({ now: NOW });
  await db.goals.put({ ...ds.goals, userId: user.id });

  // Gmail: a real exchange, a group email with someone on CC, a newsletter, a professor, an alumni address
  await ingestEmails(
    user,
    [
      mail({
        from: ME,
        to: ['Maya Chen <maya.chen@stripe.com>'],
        subject: 'Berkeley junior, quick question',
        bodyText: "Hi Maya,\n\nI'm a junior at Berkeley. Would you be open to a short call?\n\nBest,\nJordan",
        sentAt: ago(20),
        externalThreadId: 'maya',
      }),
      mail({
        from: 'Maya Chen <maya.chen@stripe.com>',
        to: [ME],
        subject: 'Re: Berkeley junior, quick question',
        bodyText: 'Happy to! Does next week work?\n\nMaya',
        sentAt: ago(19),
        externalThreadId: 'maya',
      }),
      mail({
        from: ME,
        to: ['Maya Chen <maya.chen@stripe.com>'],
        subject: 'Re: Berkeley junior, quick question',
        bodyText: 'Great, thank you! I sent an invite.\n\nJordan',
        sentAt: ago(19, 19),
        externalThreadId: 'maya',
      }),
      mail({
        from: 'Ethan Park <ethan@acmeventures.com>',
        to: [ME, 'a@berkeley.edu', 'b@berkeley.edu', 'c@berkeley.edu'],
        cc: ['Lena Novak <lena@ramp.com>'],
        subject: 'Fintech club speaker night',
        bodyText: 'Hi all,\n\nThanks for coming last night. Slides attached.\n\nEthan',
        sentAt: ago(15),
        externalThreadId: 'club',
      }),
      mail({
        from: 'Morning Brew <crew@morningbrew.com>',
        to: [ME],
        subject: 'Your daily brew',
        bodyText: 'Markets were up today. Unsubscribe here.',
        sentAt: ago(2),
        headers: { 'list-unsubscribe': '<mailto:unsub@morningbrew.com>' },
        externalThreadId: 'brew',
      }),
      mail({
        from: 'Dana Wu <dwu@berkeley.edu>',
        to: [ME],
        subject: 'Office hours',
        bodyText: 'Hi Jordan, happy to talk about research next week.\n\nProf. Wu',
        sentAt: ago(10),
        externalThreadId: 'prof',
      }),
      mail({
        from: 'Sam Ortiz <sam.ortiz@alumni.berkeley.edu>',
        to: [ME],
        subject: 'Re: Berkeley alumni mentoring',
        bodyText: 'Hi Jordan, glad to mentor you this semester.\n\nSam',
        sentAt: ago(9),
        externalThreadId: 'sam',
      }),
    ],
    { useLlm: false, now: NOW },
  );

  // LinkedIn, live: a headline where the position should be
  await importLiveConnections(user, [
    {
      firstName: 'Daniel',
      lastName: 'Okafor',
      position: 'Former Analyst at Goldman Sachs | MBA Candidate at Wharton',
    },
    { firstName: 'Aisha', lastName: 'Khan', position: 'Intern at Google, CS @ Berkeley' },
    { firstName: 'Tom', lastName: 'Reed', position: 'Campus Ambassador at Red Bull' },
    { firstName: 'Nina', lastName: 'Patel', position: 'Strategic Sourcing Analyst at Apple' },
    { firstName: 'Grace', lastName: 'Liu', position: 'Technical Recruiter at Stripe' },
    { firstName: 'Sarah', lastName: 'Chen', position: 'Software Engineer at Notion' },
    { firstName: 'Priya', lastName: 'Shah', company: 'Figma', position: 'Product Manager' },
  ]);

  // Calendar: a lecture, a small meeting where the pipeline person is not listed first, a one-on-one later today,
  // a project meeting with a classmate, and a lunch with two people
  const ev = (
    p: Partial<RawEvent> & { externalEventId: string; startAt: string; endAt: string },
  ): RawEvent => ({
    status: 'confirmed',
    attendees: [],
    ...p,
  });
  const meAt = { email: 'jordan.lee@berkeley.edu', self: true, responseStatus: 'accepted' };
  await ingestEvents(
    user,
    [
      ev({
        externalEventId: 'lecture',
        title: 'CS 170 Lecture',
        startAt: ago(1, 18),
        endAt: ago(1, 19),
        attendees: [meAt, ...Array.from({ length: 40 }, (_, i) => ({ email: `s${i}@berkeley.edu` }))],
      }),
      ev({
        externalEventId: 'stripe',
        title: 'Stripe chat',
        startAt: ago(3, 20),
        endAt: ago(3, 21),
        attendees: [
          meAt,
          { email: 'ravi@stripe.com', displayName: 'Ravi Kumar' },
          { email: 'maya.chen@stripe.com', displayName: 'Maya Chen' },
        ],
      }),
      ev({
        externalEventId: 'chris',
        title: 'Catch up',
        startAt: new Date(NOW.getTime() + 5 * 3_600_000).toISOString(),
        endAt: new Date(NOW.getTime() + 5.5 * 3_600_000).toISOString(),
        attendees: [meAt, { email: 'chris.ng@gmail.com', displayName: 'Chris Ng' }],
      }),
      ev({
        externalEventId: 'project',
        title: 'CS 170 project',
        startAt: new Date(NOW.getTime() + 2 * 3_600_000).toISOString(),
        endAt: new Date(NOW.getTime() + 2.5 * 3_600_000).toISOString(),
        attendees: [meAt, { email: 'olivia.brown@berkeley.edu', displayName: 'Olivia Brown' }],
      }),
      ev({
        externalEventId: 'lunch',
        title: 'Lunch',
        startAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(),
        endAt: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
        attendees: [
          meAt,
          { email: 'kim@meta.com', displayName: 'Kim Park' },
          { email: 'lee@meta.com', displayName: 'Lee Morgan' },
        ],
      }),
    ],
    NOW,
  );

  // a classmate the student added with their school, and someone whose LinkedIn education says they graduated
  await addPersonByHand(
    user.id,
    {
      name: 'Olivia Brown',
      email: 'olivia.brown@berkeley.edu',
      school: 'University of California, Berkeley',
    },
    user.school,
  );
  const marcus = await addPersonByHand(user.id, {
    name: 'Marcus Bell',
    email: 'marcus@databricks.com',
    company: 'Databricks',
    title: 'Data Scientist',
  });
  await db.affiliations.add({
    id: newId('aff'),
    userId: user.id,
    personId: marcus!.person.id,
    kind: 'education',
    nameRaw: 'University of California-Berkeley',
    endDate: '2019-05',
    isCurrent: false,
    source: 'enrichment',
  });

  // texts with a friend from the student's Contacts
  await importTexts(user, { messagesDb: await textsDb(), contactsVcf: VCF }, { now: NOW });

  // notes: one that only mentions someone, one written after a lunch with two people that names neither
  await ingestNote(
    user,
    { source: 'manual', text: 'Need to email Sarah Chen about a referral', occurredAt: ago(1) },
    NOW,
  );
  await ingestNote(
    user,
    {
      source: 'manual',
      text: 'Great conversation about recruiting timelines.',
      occurredAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    },
    NOW,
  );
  await recomputeAlumni(user, NOW);
}

describe('a real account: every claim is backed by evidence', () => {
  beforeAll(() => setSqlJsForTests(initSqlJs()));
  beforeEach(async () => {
    await wipeDatabase();
    await seedAccount();
  }, 60_000);

  it('alum means evidence they studied at the school, not the same school string', async () => {
    const alumni = (await db.people.where('userId').equals(user.id).toArray())
      .filter((p) => p.isAlumni)
      .map((p) => p.displayName)
      .sort();
    // an alumni address and an ended education record at "University of California-Berkeley"
    expect(alumni).toEqual(['Marcus Bell', 'Sam Ortiz']);
    // a classmate with the school written out, and a professor at a school address, are at the school, not alumni
    const olivia = await must('Olivia Brown');
    expect(olivia.isAlumni).toBe(false);
    expect(await summaryOf(olivia)).toMatch(/Olivia is at UC Berkeley too\./);
    expect(await summaryOf(olivia)).not.toMatch(/went to/);
    expect((await must('Dana Wu')).isAlumni).toBe(false);
    expect(await summaryOf(await must('Marcus Bell'))).toMatch(/Like you, Marcus went to UC Berkeley\./);
    // the school names students use are one school
    expect(sameSchool('UC Berkeley', 'University of California, Berkeley')).toBe(true);
    expect(sameSchool('Cal', 'University of California-Berkeley')).toBe(true);
    expect(sameSchool('University of Michigan', 'University of Michigan - Ann Arbor')).toBe(true);
    expect(sameSchool('Boston College', 'Boston University')).toBe(false);
    expect(sameSchool('UC Berkeley', 'UCLA')).toBe(false);
  });

  it('a note that only mentions someone records no meeting, opens no chat and asks for no thank-you', async () => {
    const sarah = await must('Sarah Chen');
    const note = (await db.notes.toArray()).find((n) => n.rawText.startsWith('Need to email'))!;
    expect(note).toMatchObject({
      noteKind: 'mention',
      personIds: [sarah.id],
      title: 'Note about Sarah Chen',
    });
    expect((await touchesOf(sarah.id)).filter((t) => t.refTable === 'notes')).toEqual([]);
    expect(await db.chats.where('personId').equals(sarah.id).count()).toBe(0);
    expect(
      await db.suggestions
        .where('personId')
        .equals(sarah.id)
        .filter((s) => s.kind === 'thank_you')
        .count(),
    ).toBe(0);
    expect((await db.notifications.toArray()).some((n) => /Sarah/.test(n.title))).toBe(false);
    expect(await summaryOf(sarah)).not.toMatch(/met|logged a conversation/);
  });

  it('a note near a meeting of several people it does not name is not filed with them', async () => {
    const kim = await must('Kim Park');
    const lee = await must('Lee Morgan');
    const note = (await db.notes.toArray()).find((n) => n.rawText.startsWith('Great conversation'))!;
    expect(note.personIds).toEqual([]);
    expect(note.matchStatus).toBe('unmatched');
    for (const p of [kim, lee])
      expect((await touchesOf(p.id)).some((t) => t.refTable === 'notes')).toBe(false);
  });

  it('the calendar gives the meeting to the attendee in the pipeline, and a class or a project is no chat', async () => {
    const maya = await must('Maya Chen');
    const ravi = await must('Ravi Kumar');
    const meetings = async (id: string) =>
      (await touchesOf(id)).filter((t) => t.kind === 'meeting').map((t) => t.weight);
    // the chat is Maya's; Ravi was in the meeting too (a lighter touch), and gets no chat of his own
    expect(await meetings(maya.id)).toEqual([1]);
    expect(await meetings(ravi.id)).toEqual([0.5]);
    expect(await db.chats.where('personId').equals(ravi.id).count()).toBe(0);
    expect(await summaryOf(ravi)).toMatch(/You last met on Sunday\./);
    // the people at today's lunch were met, and the lecture's forty students are nobody
    expect(await meetings((await must('Kim Park')).id)).toEqual([0.5]);
    expect(
      (await db.people.toArray()).some((p) => p.emails.some((e) => /^s\d+@berkeley\.edu$/.test(e))),
    ).toBe(false);
    const events = await db.events.toArray();
    const flag = (id: string) => events.find((e) => e.externalEventId === id)?.isCoffeeChat;
    expect(flag('lecture')).toBe(false);
    expect(flag('project')).toBe(false);
    expect(flag('chris')).toBe(true);
    expect(flag('stripe')).toBe(true);
  });

  it('LinkedIn headlines are not job titles: a former role is not current, and only recruiters are recruiters', async () => {
    const daniel = await must('Daniel Okafor');
    expect(daniel).toMatchObject({
      currentTitle: undefined,
      currentOrganizationRaw: undefined,
      headline: 'Former Analyst at Goldman Sachs | MBA Candidate at Wharton',
    });
    expect(await summaryOf(daniel)).not.toMatch(/works at|is an? Former/);
    expect(await must('Aisha Khan')).toMatchObject({
      currentTitle: 'Intern',
      currentOrganizationRaw: 'Google',
    });
    expect((await must('Tom Reed')).relationshipType).not.toBe('recruiter');
    expect((await must('Nina Patel')).relationshipType).not.toBe('recruiter');
    expect((await must('Grace Liu')).relationshipType).toBe('recruiter');
    expect(await must('Priya Shah')).toMatchObject({
      currentTitle: 'Product Manager',
      currentOrganizationRaw: 'Figma',
    });
    for (const p of await db.people.where('userId').equals(user.id).toArray())
      if (p.relationshipType === 'recruiter') expect(isRecruiter(p.currentTitle), p.displayName).toBe(true);
  });

  it('"in touch" counts real interactions; a CC, a group email and a newsletter are not touches', async () => {
    // Maya: the outreach, her reply and the answer the same day, then the meeting: three times in touch
    expect(await summaryOf(await must('Maya Chen'))).toMatch(/You last met .*You've been in touch 3 times/);
    // Lena was only on CC
    expect(await summaryOf(await must('Lena Novak'))).toMatch(/You haven't been in touch yet\./);
    // Ana: two days of texting
    expect(await summaryOf(await must('Ana Ruiz'))).toMatch(/You've been in touch twice/);
    expect(await byName('Morning Brew')).toSatisfy((p: Person | undefined) => !p?.isHuman);
    // every "in touch N times" matches the distinct days with a real touch in the last three months
    for (const p of await db.people.where('userId').equals(user.id).toArray()) {
      const said = (await summaryOf(p)).match(/in touch (twice|(\d+) times)/);
      if (!said) continue;
      const tps: Touchpoint[] = await touchesOf(p.id);
      const days = new Set(
        tps
          .filter(
            (t) =>
              !['email_cc', 'linkedin_connected', 'linkedin_engaged'].includes(t.kind) &&
              NOW.getTime() - Date.parse(t.occurredAt) < 90 * DAY,
          )
          .map((t) => new Date(t.occurredAt).toLocaleDateString('en-CA', { timeZone: user.timezone })),
      );
      expect(said[1] === 'twice' ? 2 : Number(said[2]), p.displayName).toBe(days.size);
    }
  });

  it('drafts cite past contact only after a real two-way exchange', async () => {
    for (const name of ['Lena Novak', 'Ethan Park']) {
      const p = await must(name);
      const d = await draftMessage(user, p.id, 'outreach', 'gmail', null);
      expect(d.bodyDraft, name).not.toMatch(
        /traded emails|Thanks again for your|emailed before|pick that conversation/i,
      );
    }
  });

  it('the morning brief: chats today are coffee chats, prep names the right person, reasons still hold', async () => {
    await recommendationsRefresh(user, NOW);
    const deck = await morningDeck(user, NOW);
    expect(deck.stats.chatsToday).toBe(1);
    expect(deck.moves.find((m) => m.id.startsWith('ev:'))?.text).toBe('Prep for Chris');
    const people = new Map((await db.people.toArray()).map((p) => [p.id, p]));
    for (const m of deck.moves)
      if (m.personId && /alum/i.test(m.sub ?? '')) expect(people.get(m.personId)?.isAlumni).toBe(true);
    for (const r of await db.recommendations.toArray())
      for (const reason of r.reasons)
        if (reason.code === 'alumni') expect(people.get(r.personId)?.isAlumni, reason.text).toBe(true);
  });

  it('a large recorded meeting is a light touch for people with a chat, and makes nobody new', async () => {
    const maya = await must('Maya Chen');
    const before = await db.people.count();
    const chatBefore = (await db.chats.where('personId').equals(maya.id).first())!;
    await importMeetings(
      user,
      [
        {
          id: 'town-hall',
          title: 'Fintech club town hall',
          startAt: ago(0, 16),
          invitees: [
            { name: 'Jordan Lee', email: 'jordan.lee@berkeley.edu' },
            { name: 'Maya Chen', email: 'maya.chen@stripe.com' },
            ...Array.from({ length: 8 }, (_, i) => ({
              name: `Member ${i}`,
              email: `member${i}@berkeley.edu`,
            })),
          ],
          summary:
            '## Notes\n- Maya Chen walked everyone through Stripe internships.\n- Offered to review resumes.',
          actionItems: [],
        },
      ],
      NOW,
    );
    expect(await db.people.count()).toBe(before);
    const fromIt = (await touchesOf(maya.id)).filter((t) => t.refTable === 'notes');
    expect(fromIt.map((t) => t.kind)).toEqual(['note']);
    expect(fromIt[0]!.weight).toBeLessThan(0.3);
    // her chat is where the calendar left it: the town hall is not a conversation with her
    const chat = (await db.chats.where('personId').equals(maya.id).first())!;
    expect({ stage: chat.stage, completedAt: chat.completedAt }).toEqual({
      stage: chatBefore.stage,
      completedAt: chatBefore.completedAt,
    });
    expect(await db.stageEvents.filter((e) => e.evidenceRefTable === 'notes').count()).toBe(0);
    expect(
      (await db.notifications.toArray()).some((n) => /town hall|Notes from your chat/.test(n.title)),
    ).toBe(false);
  });

  it('resume lines are only ever the student’s own', async () => {
    await db.resumeFacets.add({
      id: 'demo-facet',
      resumeId: 'demo-resume',
      kind: 'experience',
      title: 'Software Engineering Intern',
      organizationName: 'Stripe',
      text: 'Built payment flows',
    } as never);
    expect(await currentResumeFacets(user.id)).toEqual([]);
  });
});

describe('meeting language', () => {
  it('tells a conversation from a plan or a mention', () => {
    for (const t of [
      'Coffee with Maya Wu. Will follow up in May.',
      'Quick call with Maya today. She offered to refer me.',
      'just talked to maya from figma, she said the new grad process opens in august which i need to do by tomorrow',
      'Lena said the team takes interns every summer.',
      'Met Sarah at the career fair on Tuesday.',
      'Coffee chat. Great advice on interviews.',
    ])
      expect(noteSaysMet(t), t).toBe(true);
    for (const t of [
      'Need to email Sarah Chen about a referral',
      'Coffee chat with Sarah next Tuesday',
      'Set up a call with Tom about the internship',
      'Remind me to ask Priya what she said about the role',
      'Sarah Chen works at Notion on the payments team',
    ])
      expect(noteSaysMet(t), t).toBe(false);
    expect(noteIsPlanOnly('Need to email her about a referral')).toBe(true);
    expect(noteIsPlanOnly('Her sister works at Google')).toBe(false);
  });
});

describe('repairing what older versions saved', () => {
  beforeAll(() => setSqlJsForTests(initSqlJs()));
  beforeEach(async () => {
    await wipeDatabase();
  });

  it('takes off an alum label without evidence, and what was said because of it', async () => {
    user = await createLocalUser({
      fullName: 'Jordan Lee',
      firstName: 'Jordan',
      email: 'jordan.lee@berkeley.edu',
      school: 'UC Berkeley',
      onboardingCompletedAt: ago(30),
    });
    const ds = buildDemoDataset({ now: NOW });
    await db.goals.put({ ...ds.goals, userId: user.id });
    const p = await addPersonByHand(user.id, {
      name: 'Dana Wu',
      email: 'dwu@berkeley.edu',
      company: 'UC Berkeley',
      title: 'Professor',
    });
    const id = p!.person.id;
    // what an older version saved: the label from the school domain, and a summary, reason, card and draft saying it
    await db.people.update(id, {
      isAlumni: true,
      school: 'University of California, Berkeley',
      summary: 'Dana works at UC Berkeley as a Professor. Like you, Dana went to UC Berkeley.',
      summaryUpdatedAt: ago(5),
    });
    await db.recommendations.add({
      id: 'rec1',
      userId: user.id,
      personId: id,
      score: 0.5,
      fitScore: 0.5,
      reachScore: 0.6,
      responsePrior: 0.5,
      reasons: [
        { code: 'alumni', text: 'UC Berkeley alum' },
        { code: 'target_company', text: 'UC Berkeley is on your target list' },
      ],
      status: 'new',
      batchDate: ago(1).slice(0, 10),
    });
    await db.suggestions.add({
      id: 's1',
      userId: user.id,
      personId: id,
      kind: 'new_outreach',
      status: 'pending',
      dedupeKey: 'k1',
      priorityScore: 1,
      payload: {},
      reasonText: 'UC Berkeley alum at a target company',
      createdAt: ago(1),
    } as never);
    await db.people.update(id, { isAlumni: true });
    const d = await draftMessage(user, id, 'outreach', 'gmail', null);
    await db.people.update(id, { isAlumni: true });
    await db.outbound.update(d.id, { bodyDraft: `${d.bodyDraft}\n\nP.S. I saw you're a fellow alum.` });

    const stats = await repairClaims(user, NOW);
    expect(stats?.alumniLost).toBe(1);
    const after = (await db.people.get(id))!;
    expect(after.isAlumni).toBe(false);
    // the school stays: they are at the student's school
    expect(after.school).toBe('University of California, Berkeley');
    expect(after.summary).toBeUndefined();
    expect((await db.recommendations.get('rec1'))!.reasons.map((r) => r.code)).toEqual(['target_company']);
    expect((await db.suggestions.get('s1'))!.status).toBe('expired');
    expect((await db.outbound.get(d.id))!.bodyDraft).not.toMatch(/fellow|alum/i);
    // once per version, then only the alum check on each visit
    expect(await db.kv.get(`repair:${REPAIR_VERSION}:${user.id}`)).toBeDefined();
    expect((await repairClaims(user, NOW))?.notesRefiled).toBe(0);
  });

  it('a meeting older versions made from a name in a note becomes a note about them', async () => {
    user = await createLocalUser({ fullName: 'Jordan Lee', firstName: 'Jordan', email: 'j@berkeley.edu' });
    const sarah = await addPersonByHand(user.id, { name: 'Sarah Chen', email: 'sarah@notion.so' });
    const sid = sarah!.person.id;
    const noteId = 'n-legacy';
    const at = ago(3);
    await db.notes.add({
      id: noteId,
      userId: user.id,
      source: 'manual',
      title: 'Chat with Sarah Chen',
      occurredAt: at,
      rawText: 'Need to email Sarah Chen about a referral',
      attendees: [],
      personIds: [sid],
      chatId: 'c-met',
      matchStatus: 'auto',
      matchConfidence: 0.8,
      extraction: {
        summary: 'Email Sarah about a referral',
        facts: [],
        actionItems: [{ owner: 'user', text: 'Email Sarah about a referral' }],
        offers: [],
        hooks: [],
        warmth: 'neutral',
        suggestedNextStep: 'Send a thank-you',
      },
      processedAt: at,
      createdAt: at,
    });
    await db.chats.add({
      id: 'c-met',
      userId: user.id,
      personId: sid,
      stage: 'completed',
      stageEnteredAt: at,
      completedAt: at,
      source: 'detected',
      goalTags: [],
      bumpCount: 0,
      priority: 2,
      createdAt: at,
      updatedAt: at,
    });
    await db.stageEvents.add({
      id: 'se1',
      userId: user.id,
      chatId: 'c-met',
      toStage: 'completed',
      status: 'applied',
      actor: 'system',
      reason: 'note:met',
      evidenceRefTable: 'notes',
      evidenceRefId: noteId,
      confidence: 0.8,
      createdAt: at,
      decidedAt: at,
    } as never);
    for (const [kind, refId, weight] of [
      ['note', noteId, 0.3],
      ['meeting', `${noteId}:meeting`, 1],
    ] as const)
      await db.touchpoints.add({
        id: newId('tp'),
        userId: user.id,
        personId: sid,
        kind,
        occurredAt: at,
        refTable: 'notes',
        refId,
        weight,
      });
    await repairClaims(user, NOW);
    expect(await db.notes.get(noteId)).toMatchObject({ noteKind: 'mention', title: 'Note about Sarah Chen' });
    expect(await db.chats.get('c-met')).toBeUndefined();
    expect((await touchesOf(sid)).filter((t) => t.refTable === 'notes')).toEqual([]);
    // what it said about her stays: the promise to write to her
    expect((await db.actionItems.where('personId').equals(sid).toArray()).map((a) => a.text)).toEqual([
      'Email Sarah about a referral',
    ]);
  });

  it('clears the demo’s leftovers that have no userId', async () => {
    user = await createLocalUser({ fullName: 'Jordan Lee', email: 'j@berkeley.edu' });
    const [stripe, notion] = [DEMO_ORGS[0]!, DEMO_ORGS.find((o) => o.slug !== DEMO_ORGS[0]!.slug)!];
    await db.organizations.bulkPut(
      [stripe, notion].map((o) => ({
        id: `org_${o.slug}`,
        name: o.name,
        nameNormalized: o.name.toLowerCase(),
        domains: [o.domain],
        industry: o.industry,
        sizeBucket: o.size,
        linkedinSlug: o.slug,
      })),
    );
    await db.resumeFacets.add({
      id: 'f-demo',
      resumeId: 'r-demo',
      kind: 'summary',
      text: 'Alex is a junior',
    } as never);
    const p = await addPersonByHand(user.id, { name: 'Maya Chen', email: 'maya@x.com' });
    await db.people.update(p!.person.id, { currentOrganizationId: `org_${stripe.slug}` });
    await repairClaims(user, NOW);
    expect(await db.resumeFacets.get('f-demo')).toBeUndefined();
    expect(await db.organizations.get(`org_${notion.slug}`)).toBeUndefined();
    const kept = (await db.organizations.get(`org_${stripe.slug}`))!;
    expect(kept).toMatchObject({ name: stripe.name, domains: [] });
    expect([kept.industry, kept.sizeBucket, kept.linkedinSlug]).toEqual([undefined, undefined, undefined]);
  });

  it('a classmate added with the school is at the school, and the school string alone never makes an alum', async () => {
    await loadSchoolIndex();
    const u = { school: 'UC Berkeley', schoolDomain: undefined };
    const base = {
      relationshipType: 'unknown' as const,
      emails: [],
      primaryEmail: undefined,
      currentTitle: 'Student',
    };
    expect(schoolTie({ ...base, school: 'University of California, Berkeley' }, [], u)).toBe('same_school');
    expect(schoolTie({ ...base, relationshipType: 'alumni', school: undefined }, [], u)).toBe('alum');
    expect(schoolTie({ ...base, emails: ['x@berkeley.edu'], school: undefined }, [], u)).toBeUndefined();
    expect(schoolTie({ ...base, emails: ['x@alumni.berkeley.edu'], school: undefined }, [], u)).toBe('alum');
    expect(
      schoolTie({ ...base, school: undefined }, [{ nameRaw: 'Cal', isCurrent: true, endDate: undefined }], u),
    ).toBe('same_school');
  });
});
