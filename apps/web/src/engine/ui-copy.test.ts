import type { Person, User } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { briefSummaryText, needsWarmUp, refreshPersonSummary, startWarmUpOrOutreach } from './brief';
import { DEMO_USER_ID, demoResetPrompt } from './demo';
import { buildPrep, CLOSING_QUESTION, personSummary, sayWhen, withArticle } from './prep';
import { timeAgo } from './send';
import { addTargetCompany, isDuplicateTarget } from './targets';

const NOW = new Date('2026-10-06T15:00:00Z');
const TZ = 'America/New_York';
const BANNED = /[–—!]|\b(swe|pm|ib)\b|_|reach out|pick your brain|leverage|passionate/;

const user: User = {
  id: 'u1',
  email: 'sam@umich.edu',
  fullName: 'Sam Okafor',
  firstName: 'Sam',
  lastName: 'Okafor',
  school: 'University of Michigan',
  graduationYear: 2028,
  majors: ['Computer Science'],
  timezone: TZ,
  onboardingStep: 11,
  onboardingCompletedAt: '2026-09-01T00:00:00Z',
  createdAt: '2026-09-01T00:00:00Z',
} as User;

const person = (over: Partial<Person> = {}): Person =>
  ({
    id: 'p1',
    userId: 'u1',
    displayName: 'Jose Ramirez',
    firstName: 'Jose',
    lastName: 'Ramirez',
    nameNormalized: 'jose ramirez',
    emails: [],
    relationshipType: 'unknown',
    strength: 0.05,
    interactionCount: 1,
    sources: ['linkedin_csv'],
    isHuman: true,
    tags: [],
    createdAt: '2023-01-01T00:00:00Z',
    updatedAt: '2023-01-01T00:00:00Z',
    currentTitle: 'Consultant, Private Equity Practice',
    currentOrganizationRaw: 'Bain & Company',
    ...over,
  }) as Person;

describe('person summary (UI-17)', () => {
  it('reads like a person wrote it: articles, no ISO dates, no "recent" for old contact', async () => {
    await db.people.put(person());
    await db.touchpoints.put({
      id: 'tp1',
      userId: 'u1',
      personId: 'p1',
      kind: 'email_out',
      occurredAt: '2023-02-15T17:00:00Z',
      refTable: 'x',
      refId: 'y',
      weight: 0.6,
    });
    await refreshPersonSummary(user, 'p1');
    const p = (await db.people.get('p1'))!;
    expect(p.summary).toBe(
      'Jose works at Bain & Company as a Consultant (Private Equity Practice). You last wrote to Jose in Feb 2023.',
    );
    expect(p.summary).not.toMatch(/\d{4}-\d{2}-\d{2}|recent/);
    // No filler talking point when nothing specific is known.
    expect(p.talkingPoints).toEqual([]);
  });
  it('mentions the shared school, counts only recent touches and quotes facts as whole sentences', () => {
    const r = personSummary({
      user,
      person: person({
        firstName: 'Sofia',
        displayName: 'Sofia Bennett',
        currentTitle: 'Associate Product Manager',
        currentOrganizationRaw: 'Jane Street',
        isAlumni: true,
      }),
      facts: [
        { type: 'advice', text: 'they recommended practicing product sense questions' },
        { type: 'hook', text: 'She is training for the Chicago marathon.' },
      ],
      touchpoints: [
        { kind: 'meeting', occurredAt: '2026-08-13T18:00:00Z' },
        { kind: 'email_in', occurredAt: '2026-08-10T18:00:00Z' },
        { kind: 'email_out', occurredAt: '2026-08-09T18:00:00Z' },
        { kind: 'email_out', occurredAt: '2025-01-09T18:00:00Z' },
      ],
      now: NOW,
    });
    expect(r.summary).toBe(
      "Sofia works at Jane Street as an Associate Product Manager. Like you, Sofia went to University of Michigan. You last met on Aug 13. You've been in touch 3 times in the last three months. From your notes: They recommended practicing product sense questions.",
    );
    expect(r.talkingPoints[0]).toBe('Ask how this is going: She is training for the Chicago marathon.');
    for (const t of [r.summary, ...r.talkingPoints]) expect(t).not.toMatch(BANNED);
  });
  it('describes the meeting, not the note logged about it at the same time', () => {
    const r = personSummary({
      user,
      person: person(),
      facts: [],
      touchpoints: [
        { kind: 'note', occurredAt: '2026-10-05T19:00:00Z' },
        { kind: 'meeting', occurredAt: '2026-10-05T19:00:00Z' },
      ],
      now: NOW,
    });
    expect(r.summary).toContain('You last met yesterday.');
  });
  it('says when in the user timezone', () => {
    expect(sayWhen('2026-10-06T03:00:00Z', NOW, TZ)).toBe('yesterday'); // 11pm on Oct 5 in New York
    expect(sayWhen('2026-10-02T15:00:00Z', NOW, TZ)).toBe('on Friday');
    expect(withArticle('Engineering Manager')).toBe('an Engineering Manager');
    expect(withArticle('Head of Design')).toBe('Head of Design');
    expect(withArticle('University Recruiter')).toBe('a University Recruiter');
  });
});

describe('prep (EG-13)', () => {
  const base = {
    user,
    goals: { cycleLabel: 'Summer 2027 internship', targetFunctions: ['swe'] },
    facts: [],
    chats: [],
    resumeFacets: [
      {
        kind: 'experience' as const,
        title: 'Software Engineering Intern',
        organizationName: 'Ford',
        startDate: '2026-05',
        endDate: '2026-08',
        text: '',
      },
    ],
    now: NOW,
  };
  it('tailors questions to the function, ends with the pointer question and builds the intro from the resume', () => {
    const swe = buildPrep({
      ...base,
      person: person({
        firstName: 'Grace',
        currentTitle: 'Software Engineer',
        currentOrganizationRaw: 'Notion',
        linkedinSlug: 'grace',
      }),
      event: {
        startAt: '2026-10-07T18:00:00Z',
        endAt: '2026-10-07T18:30:00Z',
        conferenceUrl: 'https://meet.google.com/abc',
      },
    });
    expect(swe.questions).toHaveLength(5);
    expect(swe.questions.join(' ')).toMatch(/intern projects|stack/);
    expect(swe.closing).toBe(CLOSING_QUESTION);
    expect(swe.intro).toBe(
      "I'm Sam, a junior at University of Michigan studying Computer Science. Most recently I was a Software Engineering Intern at Ford. I'm recruiting for software engineering roles (Summer 2027 internship), and I'd love to hear how you got where you are.",
    );
    expect(swe.logistics?.when).toMatch(/^Wednesday, Oct 7, 2:00 PM EDT, 30 minutes$/);
    expect(swe.logistics?.link).toBe('https://meet.google.com/abc');
    expect(swe.research[0]!.url).toContain('linkedin.com/in/grace/recent-activity');
    expect(swe.goal).toContain('Summer 2027 internship search');

    const pmChat = buildPrep({
      ...base,
      person: person({ currentTitle: 'Associate Product Manager', currentOrganizationRaw: 'Notion' }),
    });
    expect(pmChat.goal).toBe(
      'Learn how Notion works from someone in product management, and who on the software engineering side you should meet next.',
    );
    expect(pmChat.questions.join(' ')).toMatch(/PM intern/);

    const banker = buildPrep({
      ...base,
      person: person({ currentTitle: 'Analyst, M&A', currentOrganizationRaw: 'Evercore' }),
    });
    expect(banker.fn).toBe('ib');
    expect(banker.questions.join(' ')).toMatch(/staffing|deal exposure/);
    expect(banker.questions).not.toEqual(swe.questions);

    const recruiter = buildPrep({
      ...base,
      person: person({ currentTitle: 'University Recruiter', currentOrganizationRaw: 'Stripe' }),
    });
    expect(recruiter.audience).toBe('recruiter');
    expect(recruiter.questions.join(' ')).toMatch(/timeline/);
    expect(recruiter.questions.join(' ')).not.toMatch(/intern projects|first 90 days/);
    for (const plan of [swe, banker, recruiter])
      for (const t of [plan.goal, plan.ask, plan.intro ?? '', ...plan.questions, ...plan.logisticsTips])
        expect(t).not.toMatch(BANNED);
  });
  it('asks the student for missing facts instead of inventing an intro line', () => {
    const p = buildPrep({ ...base, resumeFacets: [], person: person() });
    expect(p.introMissing).toMatch(/Add your resume/);
    expect(p.intro).not.toMatch(/Most recently/);
  });
  it('asks for the target function and cycle instead of saying placeholder text out loud', () => {
    const p = buildPrep({
      ...base,
      user: { ...user, graduationYear: undefined, degree: 'MBA', majors: [] },
      goals: { cycleLabel: '', targetFunctions: [] },
      person: person({ currentTitle: 'Product Designer', currentOrganizationRaw: 'Figma' }),
    });
    expect(p.intro).not.toMatch(/target field|\(\)|\binternship\b/);
    expect(p.intro).toMatch(/^I'm Sam, an MBA student at University of Michigan\./);
    expect(p.introMissing).toMatch(/roles you're recruiting for/);
    expect(p.goal).toBe(
      'Understand what the work at Figma is really like and whether a role there fits your search.',
    );
    for (const t of [p.goal, p.intro ?? '', p.introMissing ?? '']) expect(t).not.toMatch(BANNED);
    expect(withArticle('MBA student')).toBe('an MBA student');
    expect(withArticle('PhD student')).toBe('a PhD student');
  });
  it('only mentions their advice when there is advice on record', () => {
    const args = {
      ...base,
      chats: [{ stage: 'nurturing' as const, completedAt: '2026-09-01T00:00:00Z' }],
      person: person({ firstName: 'Ana', currentTitle: 'Product Designer', currentOrganizationRaw: 'Figma' }),
    };
    expect(buildPrep(args).goal).toBe(
      'Catch Ana up on your Summer 2027 internship search since you last spoke, and get their read on your next step.',
    );
    expect(
      buildPrep({ ...args, facts: [{ type: 'advice', text: 'Ship one project end to end.' }] }).goal,
    ).toBe('Tell Ana what you did with their advice, and get their read on your next step.');
  });
  it('does not give consulting case questions to an Engagement Manager at a fintech', () => {
    const p = buildPrep({
      ...base,
      person: person({
        firstName: 'Marcus',
        currentTitle: 'Engagement Manager',
        currentOrganizationRaw: 'Ramp',
      }),
    });
    expect(p.fn).toBe('general');
    expect(p.questions.join(' ')).not.toMatch(/case|summer associates|staffed/i);
    expect(p.goal).not.toMatch(/consulting/);
    const mck = buildPrep({
      ...base,
      person: person({ currentTitle: 'Engagement Manager', currentOrganizationRaw: 'McKinsey & Company' }),
    });
    expect(mck.fn).toBe('consulting');
  });
  it('never splices raw hook sentences into a question', () => {
    const p = buildPrep({
      ...base,
      facts: [{ type: 'hook', text: 'They are moving to the London office in January.' }],
      person: person(),
    });
    expect(p.questions.join(' ')).not.toMatch(/You mentioned/);
    expect(p.followUps).toEqual(['They are moving to the London office in January.']);
  });
});

describe('brief summary (UI-11)', () => {
  it('never tells a user with an empty network that it is in good shape', () => {
    const empty = briefSummaryText(new Map(), 0, 0);
    expect(empty).toMatch(/nobody to work with yet/);
    expect(empty).toMatch(/Connect Google|LinkedIn/);
    expect(briefSummaryText(new Map(), 0, 12)).not.toMatch(/good shape/);
    expect(briefSummaryText(new Map([['confirm_merge', 2]]), 1, 12)).toBe(
      '2 possible duplicates; 1 chat coming up this week.',
    );
    for (const t of [empty, briefSummaryText(new Map(), 2, 5)]) expect(t).not.toMatch(BANNED);
  });
});

describe('demo reset confirmation (UI-01)', () => {
  it('asks before wiping a real user and names what is lost', () => {
    expect(demoResetPrompt(undefined)).toBeUndefined();
    expect(demoResetPrompt({ id: DEMO_USER_ID, fullName: 'Alex Rivera' })).toBeUndefined();
    expect(
      demoResetPrompt({ id: 'u1', fullName: 'Real Person', onboardingCompletedAt: '2026-01-01' }),
    ).toMatch(/Real Person's people, chats, notes and drafts/);
    expect(demoResetPrompt({ id: 'u2', fullName: '' })).toMatch(/discards the setup you started/);
  });
});

describe('validation (UI-19)', () => {
  it('does not add the same target company twice', async () => {
    expect(await addTargetCompany('u9', 'Figma')).toBe('added');
    expect(await addTargetCompany('u9', 'figma')).toBe('duplicate');
    expect(await addTargetCompany('u9', '  Figma, Inc. ')).toBe('duplicate');
    expect(await addTargetCompany('u9', '   ')).toBe('empty');
    expect(await db.targetCompanies.where('userId').equals('u9').count()).toBe(1);
    expect(isDuplicateTarget('Stripe', [{ nameRaw: 'Figma' }])).toBe(false);
  });
  it('never says "0 hours ago" in the cooldown message', () => {
    expect(timeAgo(20_000)).toBe('just now');
    expect(timeAgo(20 * 60_000)).toBe('20 minutes ago');
    expect(timeAgo(3_600_000)).toBe('1 hour ago');
    expect(timeAgo(72 * 3_600_000)).toBe('3 days ago');
  });
});

describe('write to a LinkedIn-only contact (UI-13)', () => {
  it('needs a warm-up by default but can message directly when the student chooses to', async () => {
    const li = person({ id: 'p-li', linkedinSlug: 'jose-r', strength: 0.02 });
    expect(needsWarmUp(li, 'linkedin', true)).toBe(true);
    expect(needsWarmUp(li, 'gmail', true)).toBe(false);
    await db.users.put(user);
    await db.people.put(li);
    const r = await startWarmUpOrOutreach(user, 'p-li', 'linkedin', 'manual', { skipWarmUp: true });
    expect(r.chat.stage).toBe('identified');
    expect(r.chat.warmUp).toBeUndefined();
    expect(r.draft?.channel).toBe('linkedin');
  });
});
