import type { User } from '@orbit/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { draftMessage, evaluateImmediateSuggestions } from './brief';
import { ingestNote, namedPeopleLabel, parseDueHint, previewNoteMatch, rematchNote } from './notes';
import { upsertPerson } from './people';

const user: User = {
  id: 'u1',
  email: 'ravi.jain@umich.edu',
  fullName: 'Ravi Jain',
  firstName: 'Ravi',
  lastName: 'Jain',
  school: 'University of Michigan',
  majors: ['Computer Science'],
  timezone: 'America/New_York',
  onboardingStep: 11,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const NOW = new Date('2026-10-02T18:00:00.000Z'); // Friday afternoon in New York

const person = async (name: string, email: string, org: string) =>
  (await upsertPerson({ userId: user.id, displayName: name, email, companyRaw: org, source: 'gmail' }))
    .person;

beforeEach(async () => {
  await wipeDatabase();
  await db.users.put(user);
});

describe('notes ingestion', () => {
  it("NRC-03/NRC-18: a pasted transcript keeps the student's promises as action items and drops labels", async () => {
    const priya = await person('Priya Patel', 'priya@stripe.com', 'Stripe');
    const n = await ingestNote(
      user,
      {
        source: 'manual',
        personIds: [priya.id],
        occurredAt: NOW.toISOString(),
        text: `Coffee chat with Priya Patel
Attendees: Priya Patel, Ravi Jain
Priya Patel: That's great, we're actually hiring in January.
Ravi Jain: I'll send over my resume tonight and I'll follow up with Priya like you suggested.
Priya Patel: No guarantee of course, the process is pretty competitive, but I'll put in a good word.`,
      },
      NOW,
    );
    const facts = await db.facts.where('personId').equals(priya.id).toArray();
    expect(facts.map((f) => [f.type, f.text])).toEqual(
      expect.arrayContaining([
        ['hook', "They're hiring in January"],
        ['offer', 'They offered to put in a good word'],
      ]),
    );
    for (const f of facts) {
      expect(f.text).not.toMatch(/Ravi|Priya Patel:|Attendees/);
      expect(f.evidence).toBeTruthy();
    }
    const items = await db.actionItems.where('personId').equals(priya.id).toArray();
    expect(items.map((i) => i.text)).toContain('Send over my resume tonight');
    const saved = (await db.notes.get(n.id))!;
    expect(saved.summary).not.toMatch(/Attendees|Coffee chat with|Ravi Jain/);
    expect(saved.extraction!.offers.some((o) => /resume/.test(o))).toBe(false);
  });

  it('NRC-04: a dictated note yields facts and a dated action item', async () => {
    const maya = await person('Maya Wu', 'maya@figma.com', 'Figma');
    await ingestNote(
      user,
      {
        source: 'wispr_capture',
        personIds: [maya.id],
        occurredAt: NOW.toISOString(),
        text: `ok so just talked to maya from figma um she was pretty nice honestly said the new grad process opens in like august and she said she'd forward my resume to her recruiter if i send it over which i need to do by like tomorrow also she's from houston originally`,
      },
      NOW,
    );
    const facts = await db.facts.where('personId').equals(maya.id).toArray();
    expect(facts.length).toBeGreaterThanOrEqual(3);
    expect(facts.find((f) => f.type === 'offer')?.text).toBe(
      'She offered to forward my resume to her recruiter if I send it over',
    );
    // L20: places and the employer are capitalised, on the Person page and in the note summary
    expect(facts.map((f) => f.text)).toContain("She's from Houston originally");
    expect((await db.notes.toArray())[0]!.summary).toMatch(/\bMaya from Figma\b/);
    const [item] = await db.actionItems.where('personId').equals(maya.id).toArray();
    expect(item!.text).toBe('Send my resume to Maya by tomorrow');
    expect(item!.dueAt).toBe('2026-10-03T21:00:00.000Z'); // Saturday 5 pm in New York
  });

  it('NRC-13: facts from a two-person note go to the person they are about', async () => {
    const elena = await person('Elena Rodriguez', 'erodriguez@bain.com', 'Bain & Company');
    const tom = await person('Tom Wu', 'tom.wu@bain.com', 'Bain & Company');
    await ingestNote(
      user,
      {
        source: 'manual',
        occurredAt: NOW.toISOString(),
        text: `Summary
Met with Elena Rodriguez and Tom Wu from Bain.
Elena works on healthcare cases and recommended I apply by the early deadline in October.
Tom said he'd intro me to the recruiting coordinator.
Tom moved to Boston last year. Elena grew up in Miami.

Attendees: Elena Rodriguez, Tom Wu`,
      },
      NOW,
    );
    const onElena = (await db.facts.where('personId').equals(elena.id).toArray()).map((f) => f.text);
    const onTom = (await db.facts.where('personId').equals(tom.id).toArray()).map((f) => f.text);
    expect(onTom).toEqual(
      expect.arrayContaining([
        'Tom offered to intro me to the recruiting coordinator',
        'Tom moved to Boston last year',
      ]),
    );
    expect(onElena).toEqual(
      expect.arrayContaining(['Elena works on healthcare cases', 'Elena grew up in Miami']),
    );
    expect(onElena.join(' ')).not.toMatch(/Boston|intro/);
    // NRC-14: the advice has a real October date, not "a week from now"
    const [apply] = await db.actionItems.where('personId').equals(elena.id).toArray();
    expect(apply!.text).toBe('Apply by the early deadline in October');
    expect(apply!.dueAt).toBe('2026-10-31T21:00:00.000Z');
    const note = (await db.notes.toArray())[0]!;
    expect(note.extraction!.suggestedNextStep).toBe(
      "Follow up on Tom's offer to intro you to the recruiting coordinator.",
    );
  });

  it('NRC-14: "she recommended I apply" is advice and creates no action item', async () => {
    const maya = await person('Maya Wu', 'maya@figma.com', 'Figma');
    await ingestNote(
      user,
      {
        source: 'manual',
        personIds: [maya.id],
        occurredAt: NOW.toISOString(),
        text: 'She recommended I apply to the APM program.',
      },
      NOW,
    );
    expect(await db.actionItems.count()).toBe(0);
    const [f] = await db.facts.where('personId').equals(maya.id).toArray();
    expect(f).toMatchObject({ type: 'advice', text: 'She recommended I apply to the APM program' });
  });
});

describe('note facts in drafts and on the person', () => {
  it('a typed note reads correctly in the referral ask, the thank-you and the summary', async () => {
    const priya = await person('Priya Patel', 'priya@figma.com', 'Figma');
    await ingestNote(
      user,
      {
        source: 'manual',
        personIds: [priya.id],
        occurredAt: NOW.toISOString(),
        text: 'Met Priya for coffee. She offered to refer me to the APM program. She recommended I apply early.',
      },
      NOW,
    );
    const facts = await db.facts.where('personId').equals(priya.id).toArray();
    expect(facts.map((f) => f.text).sort()).toEqual([
      'She offered to refer me to the APM program',
      'She recommended I apply early',
    ]);
    // the facts are spliced in the second person and as grammatical clauses, never pasted after a frame
    // ("was recommended I apply", "your advice about recommended", "you mentioned offered to")
    const spliceErrors =
      /\b(to|on|about|was|mentioned|that) (you |she )?(offered|recommended|suggested)\b|\b(she|he) (offered|recommended)\b|\bI should\b/i;
    const ask = (await draftMessage(user, priya.id, 'referral_ask', 'gmail')).bodyDraft;
    expect(ask).toMatch(/\byou (kindly )?offered to refer me to the APM program\b/);
    expect(ask).not.toMatch(spliceErrors);
    const thanks = (await draftMessage(user, priya.id, 'thank_you', 'gmail')).bodyDraft;
    expect(thanks).toMatch(/\b(your advice (that I|to)|you (recommended|suggested) I) apply early\b/);
    expect(thanks).toMatch(/\boffering to refer me to the APM program\b/);
    expect(thanks).not.toMatch(spliceErrors);
    // a check-in only quotes a fact it can phrase, and takes up the open offer (drafts panel round 2)
    const nurture = (await draftMessage(user, priya.id, 'nurture', 'gmail')).bodyDraft;
    expect(nurture).not.toMatch(spliceErrors);
    expect(nurture).not.toMatch(/\brecommended I apply\b/);
    expect(nurture).toMatch(/When we spoke, you offered to refer me to the APM program\./);
    const p = (await db.people.get(priya.id))!;
    expect(p.summary).toMatch(
      // the summary speaks to the student: their note said "me", the profile says "you"
      /She recommended you apply early\. She offered to refer you to the APM program\.$/,
    );
    expect(p.talkingPoints).toContain('Follow up: She offered to refer you to the APM program.');
  });
});

describe('matching a note to a person (NRC-19, UI-12)', () => {
  const card = (noteId: string) => db.suggestions.where('dedupeKey').equals(`note:${noteId}`).first();
  const MAYA_NOTE =
    'Quick call with Maya today. She recommended I apply to the design engineering role and offered to refer me.';

  it('a first name only one person has is a likely match, asked about with a card before anything is written', async () => {
    const maya = await person('Maya Wu', 'maya@figma.com', 'Figma');
    await person('Tom Wu', 'tom.wu@bain.com', 'Bain & Company');
    const n = await ingestNote(
      user,
      { source: 'manual', occurredAt: NOW.toISOString(), text: MAYA_NOTE },
      NOW,
    );
    expect(n).toMatchObject({ personIds: [maya.id], matchStatus: 'unmatched', matchConfidence: 0.7 });
    expect(n.title).toBe('Note from Fri, Oct 2');
    // an unconfirmed guess writes no facts, meetings or action items
    expect(await db.facts.where('personId').equals(maya.id).count()).toBe(0);
    expect(await db.touchpoints.where('personId').equals(maya.id).count()).toBe(0);
    expect((await db.notes.get(n.id))!.extraction!.facts.length).toBeGreaterThan(0);
    const c = (await card(n.id))!;
    expect(c).toMatchObject({ kind: 'confirm_note_match', status: 'pending' });
    expect(c.reasonText).toBe('Was your note from Fri, Oct 2 with Maya Wu?');
    expect(c.payload.candidatePersonIds).toEqual([maya.id]);
  });

  it('a first name several people share is not guessed; the card names them', async () => {
    await person('Maya Wu', 'maya@figma.com', 'Figma');
    await person('Maya Chen', 'mchen@stripe.com', 'Stripe');
    const n = await ingestNote(
      user,
      { source: 'manual', occurredAt: NOW.toISOString(), text: MAYA_NOTE },
      NOW,
    );
    expect(n.personIds).toEqual([]);
    const c = (await card(n.id))!;
    expect(c.reasonText).toMatch(
      /^Who was your note from Fri, Oct 2 with\? It could be Maya (Wu|Chen) or Maya (Wu|Chen)\.$/,
    );
    expect(c.payload.candidatePersonIds).toHaveLength(2);
  });

  it('a full name still matches with confidence, and everyday words are not names', async () => {
    const maya = await person('Maya Wu', 'maya@figma.com', 'Figma');
    await person('May Chen', 'may@stripe.com', 'Stripe');
    await person('Will Ortiz', 'will@ramp.com', 'Ramp');
    const n = await ingestNote(
      user,
      {
        source: 'manual',
        occurredAt: NOW.toISOString(),
        text: 'Coffee with Maya Wu. Will follow up in May. Maya said the team is hiring.',
      },
      NOW,
    );
    expect(n).toMatchObject({ personIds: [maya.id], matchStatus: 'auto', title: 'Chat with Maya Wu' });
    expect(await card(n.id)).toBeUndefined();
  });

  it('the brief refreshes the match card without losing its wording or the people it names', async () => {
    await db.users.update(user.id, { onboardingCompletedAt: '2026-09-01T00:00:00.000Z' });
    await person('Maya Wu', 'maya@figma.com', 'Figma');
    await person('Maya Chen', 'mchen@stripe.com', 'Stripe');
    const n = await ingestNote(
      user,
      { source: 'manual', occurredAt: NOW.toISOString(), text: MAYA_NOTE },
      NOW,
    );
    const before = (await card(n.id))!;
    await evaluateImmediateSuggestions(user.id, {}, NOW);
    const after = (await card(n.id))!;
    expect(after.reasonText).toBe(before.reasonText);
    expect(after.reasonText).not.toMatch(/"/);
    expect(after.payload.candidatePersonIds).toEqual(before.payload.candidatePersonIds);
  });

  it('a note with no match has its card on Today right away, with a dated title', async () => {
    const n = await ingestNote(
      user,
      { source: 'manual', occurredAt: NOW.toISOString(), text: 'Talked to a recruiter at the career fair.' },
      NOW,
    );
    expect(n).toMatchObject({ personIds: [], matchStatus: 'unmatched', title: 'Note from Fri, Oct 2' });
    expect((await card(n.id))!).toMatchObject({
      status: 'pending',
      reasonText: 'Who was your note from Fri, Oct 2 with?',
    });
  });

  it('choosing another person writes the note for them; confirming again writes nothing twice', async () => {
    const maya = await person('Maya Wu', 'maya@figma.com', 'Figma');
    const tom = await person('Tom Wu', 'tom.wu@bain.com', 'Bain & Company');
    const n = await ingestNote(
      user,
      {
        source: 'manual',
        occurredAt: NOW.toISOString(),
        text: `${MAYA_NOTE} I'll send my portfolio by Monday.`,
      },
      NOW,
    );
    expect(await db.actionItems.where('personId').equals(maya.id).count()).toBe(0);
    await rematchNote(user, n.id, tom.id, NOW);
    expect(await db.facts.where('personId').equals(maya.id).count()).toBe(0);
    expect(await db.actionItems.where('personId').equals(maya.id).count()).toBe(0);
    expect(
      await db.touchpoints
        .where('personId')
        .equals(maya.id)
        .filter((t) => t.refTable === 'notes')
        .count(),
    ).toBe(0);
    expect(await db.facts.where('personId').equals(tom.id).count()).toBeGreaterThan(0);
    expect(await db.actionItems.where('personId').equals(tom.id).count()).toBe(1);
    expect((await db.notes.get(n.id))!).toMatchObject({
      personIds: [tom.id],
      matchStatus: 'confirmed',
      title: 'Chat with Tom Wu',
    });
    expect((await card(n.id))!.status).toBe('done');
    await rematchNote(user, n.id, tom.id, NOW);
    expect(await db.actionItems.where('personId').equals(tom.id).count()).toBe(1);
  });
});

describe('an unconfirmed guess and a corrected match leave no stale pipeline state', () => {
  const chatFor = async (personId: string, stage: 'scheduled' | 'completed') => {
    const at = '2026-09-20T12:00:00.000Z';
    await db.chats.add({
      id: `c-${personId}`,
      userId: user.id,
      personId,
      stage,
      stageEnteredAt: at,
      source: 'manual',
      goalTags: [],
      bumpCount: 0,
      priority: 2,
      createdAt: at,
      updatedAt: at,
    });
    return `c-${personId}`;
  };
  const NOTE = 'Quick call with Maya today. She offered to refer me to the design engineering role.';

  it('a first-name guess does not complete the chat or send a notification; choosing someone else leaves the guess untouched', async () => {
    await db.users.update(user.id, { onboardingCompletedAt: '2026-09-01T00:00:00.000Z' });
    const u = (await db.users.get(user.id))!;
    const maya = await person('Maya Wu', 'maya@figma.com', 'Figma');
    const mia = await person('Mia Lopez', 'mia@ramp.com', 'Ramp');
    const c1 = await chatFor(maya.id, 'scheduled');
    const n = await ingestNote(u, { source: 'manual', occurredAt: NOW.toISOString(), text: NOTE }, NOW);
    expect(n).toMatchObject({ personIds: [maya.id], matchStatus: 'unmatched', chatId: undefined });
    expect((await db.chats.get(c1))!.stage).toBe('scheduled');
    expect((await db.chats.get(c1))!.completedAt).toBeUndefined();
    expect(await db.notifications.count()).toBe(0);
    expect(await db.stageEvents.count()).toBe(0);
    await rematchNote(u, n.id, mia.id, NOW);
    expect((await db.chats.get(c1))!.stage).toBe('scheduled');
    expect((await db.chats.get(c1))!.completedAt).toBeUndefined();
    expect(await db.facts.where('personId').equals(maya.id).count()).toBe(0);
    expect(await db.facts.where('personId').equals(mia.id).count()).toBeGreaterThan(0);
    const notes = await db.notifications.toArray();
    expect(notes.map((x) => x.link)).toEqual([`/people/${mia.id}`]);
  });

  it('confirming the guess writes the note for that person', async () => {
    const maya = await person('Maya Wu', 'maya@figma.com', 'Figma');
    const c1 = await chatFor(maya.id, 'scheduled');
    const n = await ingestNote(user, { source: 'manual', occurredAt: NOW.toISOString(), text: NOTE }, NOW);
    await rematchNote(user, n.id, maya.id, NOW);
    expect((await db.notes.get(n.id))!).toMatchObject({ matchStatus: 'confirmed', chatId: c1 });
    expect(await db.facts.where('personId').equals(maya.id).count()).toBeGreaterThan(0);
    expect((await db.chats.get(c1))!.stage).toBe('completed');
  });

  it('correcting an automatic match puts the first chat back where it was', async () => {
    const maya = await person('Maya Wu', 'maya@figma.com', 'Figma');
    const mia = await person('Mia Lopez', 'mia@ramp.com', 'Ramp');
    const c1 = await chatFor(maya.id, 'scheduled');
    const n = await ingestNote(
      user,
      { source: 'manual', occurredAt: NOW.toISOString(), text: `Coffee with Maya Wu. ${NOTE}` },
      NOW,
    );
    expect(n.matchStatus).toBe('auto');
    expect((await db.chats.get(c1))!.stage).toBe('completed');
    expect(await db.notifications.count()).toBe(1);
    await rematchNote(user, n.id, mia.id, NOW);
    const chat = (await db.chats.get(c1))!;
    expect(chat.stage).toBe('scheduled');
    expect(chat.completedAt).toBeUndefined();
    expect((await db.notifications.toArray()).every((x) => x.link !== `/people/${maya.id}`)).toBe(true);
    expect(
      (await db.stageEvents.where('chatId').equals(c1).toArray()).every((e) => e.status === 'rejected'),
    ).toBe(true);
  });

  it('L18: a thank-you drafted from the note stops quoting a fact that moved to someone else', async () => {
    await db.users.update(user.id, { onboardingCompletedAt: '2026-09-01T00:00:00.000Z' });
    const u = (await db.users.get(user.id))!;
    const maya = await person('Maya Wu', 'maya@figma.com', 'Figma');
    const mia = await person('Mia Lopez', 'mia@ramp.com', 'Ramp');
    const at = '2026-10-02T15:00:00.000Z';
    // the calendar already completed the chat, so correcting the note does not revert it
    await db.chats.add({
      id: 'c-done',
      userId: user.id,
      personId: maya.id,
      stage: 'completed',
      stageEnteredAt: at,
      completedAt: at,
      source: 'manual',
      goalTags: [],
      bumpCount: 0,
      priority: 2,
      createdAt: '2026-09-20T12:00:00.000Z',
      updatedAt: at,
    });
    const text = `Coffee with Maya Wu. ${NOTE}`;
    const thanks = async () => (await db.suggestions.where('dedupeKey').equals('thank:c-done').first())!;
    const draftOf = async () => (await db.outbound.get((await thanks()).outboundMessageId!))!;

    const n = await ingestNote(u, { source: 'manual', occurredAt: at, text }, NOW);
    expect(n.matchStatus).toBe('auto');
    await evaluateImmediateSuggestions(user.id, {}, NOW);
    expect((await draftOf()).bodyDraft).toMatch(/refer me to the design engineering role/);
    await rematchNote(u, n.id, mia.id, NOW);
    const redrafted = await draftOf();
    expect((await thanks()).status).toBe('pending');
    expect(redrafted.status).toBe('draft');
    expect(redrafted.bodyDraft).not.toMatch(/refer/);
    expect(redrafted.claims ?? []).toEqual([]);

    // a draft the student already edited cannot be rewritten: it is cancelled and the card retired
    await rematchNote(u, n.id, maya.id, NOW);
    await evaluateImmediateSuggestions(user.id, {}, NOW);
    const again = await draftOf();
    expect(again.bodyDraft).toMatch(/refer me to the design engineering role/);
    await db.outbound.update(again.id, { bodyFinal: `${again.bodyDraft}\nSee you soon.` });
    await rematchNote(u, n.id, mia.id, NOW);
    expect((await db.outbound.get(again.id))!.status).toBe('cancelled');
    expect(await thanks()).toMatchObject({ status: 'expired', expiredReason: 'note_moved' });
  });

  it('a full name two people share is not attached; the card tells them apart by company', async () => {
    const bain = await person('Tom Wu', 'tom.wu@bain.com', 'Bain & Company');
    const google = await person('Tom Wu', 'tomwu@google.com', 'Google');
    expect(bain.id).not.toBe(google.id);
    const n = await ingestNote(
      user,
      {
        source: 'manual',
        occurredAt: NOW.toISOString(),
        text: 'Summary\nTom Wu walked me through the case interview.\n\nAttendees: Tom Wu',
      },
      NOW,
    );
    expect(n).toMatchObject({ personIds: [], matchStatus: 'unmatched' });
    expect(await db.touchpoints.count()).toBe(0);
    const c = (await db.suggestions.where('dedupeKey').equals(`note:${n.id}`).first())!;
    expect(c.reasonText).toMatch(
      /^Who was your note from Fri, Oct 2 with\? It could be Tom Wu at (Bain & Company|Google) or Tom Wu at (Bain & Company|Google)\.$/,
    );
    expect([...(c.payload.candidatePersonIds as string[])].sort()).toEqual([bain.id, google.id].sort());
  });
});

describe('a note about someone the student never messaged', () => {
  it('opens the chat at completed, so a thank-you comes next and no cold first message', async () => {
    await db.users.put({ ...user, onboardingCompletedAt: '2026-09-01T00:00:00.000Z' });
    const daniel = await person('Daniel Okafor', 'daniel@goldman.com', 'Goldman Sachs');
    await ingestNote(
      user,
      {
        source: 'manual',
        personIds: [daniel.id],
        occurredAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(),
        text: 'Coffee chat with Daniel Okafor at the career fair. He suggested I practice paper LBOs. He offered to refer me in January.',
      },
      NOW,
    );
    const chats = await db.chats.where('personId').equals(daniel.id).toArray();
    expect(chats.map((c) => c.stage)).toEqual(['completed']);
    await evaluateImmediateSuggestions(user.id, { personId: daniel.id, chatId: chats[0]!.id }, NOW);
    const kinds = (await db.suggestions.where('personId').equals(daniel.id).toArray())
      .filter((x) => x.status === 'pending')
      .map((x) => x.kind);
    expect(kinds).toContain('thank_you');
    expect(kinds).not.toContain('new_outreach');
  });

  it('a chat the note opened goes away when the note is moved to someone else', async () => {
    const daniel = await person('Daniel Okafor', 'daniel@goldman.com', 'Goldman Sachs');
    const maya = await person('Maya Chen', 'maya@stripe.com', 'Stripe');
    const n = await ingestNote(
      user,
      {
        source: 'manual',
        personIds: [daniel.id],
        occurredAt: NOW.toISOString(),
        text: 'Coffee chat. Great advice on interviews.',
      },
      NOW,
    );
    await rematchNote(user, n.id, maya.id, NOW);
    expect(await db.chats.where('personId').equals(daniel.id).count()).toBe(0);
    expect((await db.chats.where('personId').equals(maya.id).toArray()).map((c) => c.stage)).toEqual([
      'completed',
    ]);
  });
});

describe('parseDueHint', () => {
  const tz = 'America/New_York';
  const from = NOW; // Fri 2 Oct 2026, 2 pm in New York
  const at = (h: string) => parseDueHint(h, from, tz).toISOString();
  it("reads explicit dates in the student's time zone", () => {
    expect(at('by Friday')).toBe('2026-10-09T21:00:00.000Z');
    expect(at('tomorrow')).toBe('2026-10-03T21:00:00.000Z');
    expect(at('tonight')).toBe('2026-10-03T01:00:00.000Z');
    expect(at('in two weeks')).toBe('2026-10-16T21:00:00.000Z');
    expect(at('by Oct 15')).toBe('2026-10-15T21:00:00.000Z');
    expect(at('by the early deadline in October')).toBe('2026-10-31T21:00:00.000Z');
    expect(at('in January')).toBe('2027-01-31T22:00:00.000Z');
    expect(at('end of the month')).toBe('2026-10-31T21:00:00.000Z');
    expect(at('this week')).toBe('2026-10-02T21:00:00.000Z');
  });
});

describe('usability round 2: who a note is filed with', () => {
  const meetingWith = async (personId: string, endAt: Date) => {
    await db.events.put({
      id: 'ev_recent',
      userId: user.id,
      externalEventId: 'g1',
      title: 'Coffee chat',
      startAt: new Date(endAt.getTime() - 30 * 60_000).toISOString(),
      endAt: endAt.toISOString(),
      status: 'confirmed',
      attendees: [],
      attendeePersonIds: [personId],
      isCoffeeChat: true,
    });
  };
  const summary = `Meeting summary - Hannah Brooks (Figma) / Ravi Jain
Action items:
- Ravi to send portfolio link by Monday
Key points:
- Hannah recommended taking HCI course
- Figma APM applications open in January
- Hannah offered to review Ravi's resume`;

  it('a notetaker summary naming someone else is not filed with the chat that just ended', async () => {
    const lena = await person('Lena Novak', 'lena@ramp.com', 'Ramp');
    const hannah = await person('Hannah Brooks', 'hannah@figma.com', 'Figma');
    await meetingWith(lena.id, new Date(NOW.getTime() - 3_600_000));
    const n = await ingestNote(user, { source: 'manual', text: summary, occurredAt: NOW.toISOString() }, NOW);
    expect(n.personIds).toEqual([hannah.id]);
    expect(await db.facts.where('personId').equals(lena.id).count()).toBe(0);
    // the key points are what Hannah said, not promises; the one promise is the student's own line
    const items = await db.actionItems.where('userId').equals(user.id).toArray();
    expect(items.map((i) => i.text)).toEqual(['Send portfolio link by Monday']);
    const facts = (await db.facts.where('personId').equals(hannah.id).toArray()).map((f) => f.text);
    expect(facts).toContain('Hannah offered to review my resume');
  });

  it('the picker preview says who Orbit will file the note with, and why', async () => {
    const lena = await person('Lena Novak', 'lena@ramp.com', 'Ramp');
    const hannah = await person('Hannah Brooks', 'hannah@figma.com', 'Figma');
    const people = await db.people.toArray();
    const named = previewNoteMatch(summary, people, user, lena);
    expect(named).toMatchObject({ kind: 'person', why: 'named' });
    expect(named.kind === 'person' && named.person.id).toBe(hannah.id);
    // nothing named: the calendar's chat, said as such
    const cal = previewNoteMatch('Great chat about recruiting timelines.', people, user, lena);
    expect(cal).toMatchObject({ kind: 'person', why: 'calendar' });
    expect(previewNoteMatch('Great chat about recruiting timelines.', people, user)).toEqual({
      kind: 'none',
    });
  });
});

describe('usability round 2: the same promise in two notes', () => {
  it('is kept once', async () => {
    const lena = await person('Lena Novak', 'lena@ramp.com', 'Ramp');
    await ingestNote(
      user,
      { source: 'manual', personIds: [lena.id], text: 'I promised to send her my resume by Friday.' },
      NOW,
    );
    await ingestNote(
      user,
      {
        source: 'manual',
        personIds: [lena.id],
        text: 'I promised to send her my resume by Friday and to share my side project link.',
      },
      NOW,
    );
    const items = await db.actionItems.where('personId').equals(lena.id).toArray();
    expect(items).toHaveLength(1);
  });
});

describe('usability round 6: who a note was with', () => {
  it('a first name that matches a chat from the last few days files the note with that person', async () => {
    const lena = await person('Lena Novak', 'lena@ramp.com', 'Ramp');
    await person('Lena Park', 'lena.park@bain.com', 'Bain');
    const people = await db.people.toArray();
    const text = 'Lena said the team takes interns every summer.';
    expect(previewNoteMatch(text, people, user)).toMatchObject({ kind: 'several' });
    const recent = previewNoteMatch(text, people, user, undefined, [lena]);
    expect(recent).toMatchObject({ kind: 'person', why: 'recent' });
    expect(recent.kind === 'person' && recent.person.id).toBe(lena.id);
  });

  it('names each first name once', async () => {
    const ethan = await person('Ethan Brooks', 'ethan@x.com', 'X');
    const priyas = await Promise.all(
      ['Shah', 'Patel', 'Rao'].map((l, i) => person(`Priya ${l}`, `p${i}@y.com`, 'Y')),
    );
    expect(namedPeopleLabel([ethan, ...priyas])).toBe('Ethan and 3 people named Priya');
    expect(namedPeopleLabel([ethan, priyas[0]!])).toBe('Ethan and Priya');
  });
});
