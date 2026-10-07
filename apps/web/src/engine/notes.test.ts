import type { User } from '@orbit/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { evaluateImmediateSuggestions } from './brief';
import { ingestNote, parseDueHint, rematchNote } from './notes';
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
        ['hook', "you're hiring in January"],
        ['offer', "you'll put in a good word"],
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
      "you'd forward my resume to your recruiter if I send it over",
    );
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
        "you'd intro me to the recruiting coordinator",
        'you moved to Boston last year',
      ]),
    );
    expect(onElena).toEqual(expect.arrayContaining(['you work on healthcare cases', 'you grew up in Miami']));
    expect(onElena.join(' ')).not.toMatch(/Boston|intro/);
    // NRC-14: the advice has a real October date, not "a week from now"
    const [apply] = await db.actionItems.where('personId').equals(elena.id).toArray();
    expect(apply!.text).toBe('Apply by the early deadline in October');
    expect(apply!.dueAt).toBe('2026-10-31T21:00:00.000Z');
    const note = (await db.notes.toArray())[0]!;
    expect(note.extraction!.suggestedNextStep).toMatch(/^Follow up on Tom's offer/);
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
    expect(f).toMatchObject({ type: 'advice', text: 'I should apply to the APM program' });
  });
});

describe('matching a note to a person (NRC-19, UI-12)', () => {
  const card = (noteId: string) => db.suggestions.where('dedupeKey').equals(`note:${noteId}`).first();
  const MAYA_NOTE =
    'Quick call with Maya today. She recommended I apply to the design engineering role and offered to refer me.';

  it('a first name only one person has is a likely match, attached and confirmed with a card', async () => {
    const maya = await person('Maya Wu', 'maya@figma.com', 'Figma');
    await person('Tom Wu', 'tom.wu@bain.com', 'Bain & Company');
    const n = await ingestNote(
      user,
      { source: 'manual', occurredAt: NOW.toISOString(), text: MAYA_NOTE },
      NOW,
    );
    expect(n).toMatchObject({ personIds: [maya.id], matchStatus: 'unmatched', matchConfidence: 0.7 });
    expect(n.title).toBe('Note from Fri, Oct 2');
    const offers = await db.facts
      .where('personId')
      .equals(maya.id)
      .filter((f) => f.type === 'offer')
      .toArray();
    expect(offers).toHaveLength(1);
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

  it('choosing another person moves what the guess wrote; confirming the guess writes nothing twice', async () => {
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
    expect(await db.actionItems.where('personId').equals(maya.id).count()).toBe(1);
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
