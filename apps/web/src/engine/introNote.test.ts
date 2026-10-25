/**
 * Plan 23 §4.3: an intro ask is two texts, the ask in the student's voice and a note about them the introducer can
 * forward unchanged.
 */
import type { Person, User } from '@orbit/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { requestIntro } from './drafts';
import {
  askLine,
  buildIntroNote,
  checkIntroNote,
  INTRO_NOTE_MAX_WORDS,
  introNoteBase,
  noteForAsk,
  saveIntroNote,
} from './introNote';
import { approveAndSend, NOTE_RULE, pendingNoteFor, withNote, withoutNote } from './send';

// LinkedIn as a live connection that Orbit can send through, for the LinkedIn ask
const live = vi.hoisted(() => ({ on: false }));
vi.mock('./linkedinLive', async (orig) => ({
  ...(await orig<typeof import('./linkedinLive')>()),
  linkedInSendActive: async () => live.on,
}));

const NOW = new Date('2026-10-20T15:00:00Z');
const user: User = {
  id: 'u1',
  email: 'ravi@umich.edu',
  fullName: 'Ravi Jain',
  firstName: 'Ravi',
  lastName: 'Jain',
  school: 'University of Michigan',
  graduationYear: 2028,
  majors: ['Computer Science'],
  timezone: 'America/Detroit',
  onboardingStep: 11,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const facets = [
  {
    kind: 'project' as const,
    text: 'Built a campus marketplace used by 800 students; Stripe Checkout integration.',
  },
];
const goals = { targetFunctions: ['swe'], cycleLabel: 'Summer 2027 internships' };
const words = (s: string) => s.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g)?.length ?? 0;

const person = (id: string, name: string, extra: Partial<Person> = {}): Person => {
  const [firstName, ...rest] = name.split(' ');
  return {
    id,
    userId: user.id,
    displayName: name,
    firstName: firstName!,
    lastName: rest.join(' '),
    nameNormalized: name.toLowerCase(),
    emails: [`${id}@x.com`],
    primaryEmail: `${id}@x.com`,
    relationshipType: 'unknown',
    strength: 0.5,
    interactionCount: 0,
    sources: ['gmail'],
    isHuman: true,
    tags: [],
    createdAt: user.createdAt,
    updatedAt: user.createdAt,
    ...extra,
  };
};
const KENJI = person('p_kenji', 'Kenji Watanabe', {
  currentOrganizationRaw: 'Lazard',
  currentTitle: 'Analyst',
});
const PRIYA = person('p_priya', 'Priya Raman', {
  currentOrganizationRaw: 'Stripe',
  currentTitle: 'University Recruiter',
});

describe('the note', () => {
  const base = buildIntroNote(user, facets, goals, NOW);

  it('is about the student in the third person, names the goal and one credential, under 90 words', () => {
    expect(base).toMatch(/^Ravi Jain is a \w+ at Michigan studying computer science, recruiting for/);
    expect(base).toContain('internships');
    expect(base).toContain('Ravi built a campus marketplace used by 800 students');
    const note = noteForAsk(base, user, { firstName: 'Priya', title: 'University Recruiter', org: 'Stripe' });
    expect(words(note)).toBeLessThanOrEqual(INTRO_NOTE_MAX_WORDS);
    expect(checkIntroNote(note, user)).toEqual([]);
    expect(note).not.toMatch(/\b(I|I'm|my|me)\b/);
    expect(note).not.toMatch(/[–—]/);
  });

  it('changes only its last line between targets, and names the role when there is a posting', () => {
    const a = noteForAsk(base, user, { firstName: 'Priya', title: 'University Recruiter', org: 'Stripe' });
    const b = noteForAsk(base, user, { firstName: 'Marcus', title: 'Engineering Manager', org: 'Stripe' });
    expect(a.startsWith(base)).toBe(true);
    expect(b.startsWith(base)).toBe(true);
    expect(a).not.toBe(b);
    expect(
      askLine(
        user,
        { firstName: 'Priya', org: 'Stripe' },
        { role: 'Software Engineer Intern', team: 'Payments' },
      ),
    ).toBe(
      'Ravi is applying for the Software Engineer Intern role at Stripe and would love 15 minutes with Priya to hear how the Payments team works.',
    );
  });

  it('catches first person slips, dashes, length and anything from the never-write list', () => {
    expect(checkIntroNote('I am a junior at Michigan.', user)[0]).toMatch(/third person/);
    expect(checkIntroNote('Ravi is a junior — at Michigan.', user)[0]).toMatch(/dash/);
    expect(checkIntroNote(`Ravi ${'word '.repeat(95)}`, user)[0]).toMatch(/90 or fewer/);
    expect(checkIntroNote('Ravi is a junior. Ravi lives at 1200 Market Street.', user)[0]).toMatch(
      /where you live/,
    );
    expect(checkIntroNote('Ravi is married with two kids.', user)[0]).toMatch(/family/);
  });
});

describe('the ask and its note', () => {
  beforeEach(async () => {
    await wipeDatabase();
    await db.users.put(user);
    await db.settings.put({
      userId: user.id,
      briefTimeLocal: '07:00',
      briefChannels: ['in_app'],
      quietDays: [],
      weeklyOutreachTarget: 4,
      dailySendCapGmail: 15,
      dailySendCapLinkedin: 10,
      perPersonCooldownHours: 72,
      maxBumps: 2,
      tonePreset: 'warm',
      warmUpEnabled: true,
      warmUpDays: 4,
    });
    await db.people.bulkPut([KENJI, PRIYA]);
  });

  it('the ask has four lines or fewer and no quoted note inside it; the note sits beside it', async () => {
    const r = (await requestIntro(user, KENJI.id, PRIYA.id, { path: { score: 0.5 }, now: NOW }))!;
    const ask = (await db.outbound.get(r.draft!.id))!;
    const lines = ask.bodyDraft.split(/\n\n+/).slice(1, -1);
    expect(lines.length).toBeLessThanOrEqual(2);
    const sentences = lines
      .join(' ')
      .split(/(?<=[.?!])\s+/)
      .filter(Boolean);
    expect(sentences.length).toBeLessThanOrEqual(4);
    expect(ask.bodyDraft).not.toContain('"');
    expect(ask.bodyDraft).toMatch(/if you think Priya would be open to it/i);
    expect(ask.forwardNote).toMatch(/^Ravi Jain is /);
    expect(ask.forwardNote).toMatch(/15 minutes with Priya/);
  });

  it('every ask reuses the note the student saved, rebuilt from it', async () => {
    await saveIntroNote(user.id, 'Ravi Jain is a junior at Michigan who builds payments tools.', NOW);
    expect((await introNoteBase(user)).text).toBe(
      'Ravi Jain is a junior at Michigan who builds payments tools.',
    );
    const r = (await requestIntro(user, KENJI.id, PRIYA.id, { path: { score: 0.5 }, now: NOW }))!;
    expect((await db.outbound.get(r.draft!.id))!.forwardNote).toMatch(
      /^Ravi Jain is a junior at Michigan who builds payments tools\. Ravi would love 15 minutes with Priya/,
    );
  });

  it('by email it goes as one message: the ask, a rule, the note; the editor gets the ask back alone', async () => {
    const r = (await requestIntro(user, KENJI.id, PRIYA.id, { path: { score: 0.5 }, now: NOW }))!;
    const ask = (await db.outbound.get(r.draft!.id))!;
    const out = await approveAndSend(user, ask.id, ask.bodyDraft, ask.subject, NOW, { via: 'copy' });
    expect(out.ok).toBe(true);
    const sent = (await db.outbound.get(ask.id))!;
    expect(sent.bodyFinal).toBe(withNote(ask.bodyDraft, ask.forwardNote));
    expect(sent.bodyFinal).toContain(NOTE_RULE);
    expect(withoutNote(sent.bodyFinal!, ask.forwardNote)).toBe(ask.bodyDraft.trimEnd());
  });

  it('a note that slipped into the first person is not sent', async () => {
    const r = (await requestIntro(user, KENJI.id, PRIYA.id, { path: { score: 0.5 }, now: NOW }))!;
    await db.outbound.update(r.draft!.id, { forwardNote: 'I am Ravi, a junior at Michigan.' });
    const ask = (await db.outbound.get(r.draft!.id))!;
    const out = await approveAndSend(user, ask.id, ask.bodyDraft, ask.subject, NOW, { via: 'copy' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/note to forward/i);
  });

  it('on LinkedIn the ask goes alone and the note waits as a second message for its tap', async () => {
    live.on = true;
    try {
      await db.people.put({ ...KENJI, primaryEmail: undefined, emails: [], linkedinSlug: 'kenji-w' });
      const r = (await requestIntro(user, KENJI.id, PRIYA.id, { path: { score: 0.5 }, now: NOW }))!;
      const ask = (await db.outbound.get(r.draft!.id))!;
      expect(ask.channel).toBe('linkedin');
      const out = await approveAndSend(user, ask.id, ask.bodyDraft, undefined, NOW);
      expect(out).toMatchObject({ ok: true, status: 'queued' });
      expect((await db.outbound.get(ask.id))!.bodyFinal).toBe(ask.bodyDraft);
      const note = await pendingNoteFor(ask);
      expect(note).toMatchObject({ kind: 'forwardable_blurb', status: 'draft', channel: 'linkedin' });
      expect(note!.bodyDraft).toBe(ask.forwardNote);
    } finally {
      live.on = false;
    }
  });
});
