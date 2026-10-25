import type { Affiliation } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import type { PrepPlan } from './prep';
import { buildPrepDeck, type PrepDeckInput } from './prepDeck';
import type { DossierView } from './research';

const NOW = new Date('2026-10-25T15:00:00Z');
const plan: PrepPlan = {
  audience: 'mid',
  fn: 'swe',
  goal: 'Understand what the work at Stripe is really like.',
  ask: 'A pointer to one more person to talk to.',
  intro: "I'm Ravi, a junior at Michigan studying Computer Science.",
  logistics: { when: 'Tuesday, Oct 27, 3:00 PM', link: 'https://meet.google.com/abc' },
  logisticsTips: ['Join two minutes early.'],
  research: [{ label: 'Their LinkedIn', url: 'https://www.linkedin.com/in/dana' }],
  questions: ['What drew you to Stripe?', 'What does a good intern do in week one?'],
  closing: "Is there anyone else you'd suggest I talk to?",
  followUps: ['Send a thank-you within a day.'],
};
const aff = (over: Partial<Affiliation>): Affiliation =>
  ({
    id: Math.random().toString(36),
    userId: 'u1',
    personId: 'p1',
    kind: 'employment',
    nameRaw: 'Stripe',
    source: 'linkedin_profile',
    isCurrent: false,
    ...over,
  }) as Affiliation;

const base = (over: Partial<PrepDeckInput> = {}): PrepDeckInput => ({
  person: {
    firstName: 'Dana',
    displayName: 'Dana Lee',
    headline: 'Software Engineer at Stripe',
    location: 'San Francisco',
    isAlumni: true,
  },
  user: { school: 'University of Michigan' },
  plan,
  now: NOW,
  affiliations: [],
  timeline: [],
  openItems: [],
  facts: [],
  when: (iso) => iso.slice(0, 10),
  ...over,
});

const kinds = (d: ReturnType<typeof buildPrepDeck>) => d.cards.map((c) => c.kind);
const allText = (d: ReturnType<typeof buildPrepDeck>) =>
  d.cards
    .flatMap((c) => [
      c.title,
      c.lead ?? '',
      ...c.lines.map((l) => `${l.label ?? ''} ${l.text} ${l.detail ?? ''}`),
    ])
    .concat(d.cards.flatMap((c) => c.more?.lines.map((l) => l.text) ?? []))
    .join('\n');

describe('the Prep deck', () => {
  it('always has the cover, who they are, lately, the intro, questions and after the call, in the order of a call', () => {
    const d = buildPrepDeck(base());
    expect(kinds(d)).toEqual([
      'call',
      'who',
      'lately',
      'shared',
      'intro',
      'openers',
      'questions',
      'careful',
      'after',
    ]);
    expect(d.start).toBe(0);
    expect(d.cards[0]!.lead).toBe('Tuesday, Oct 27, 3:00 PM');
    expect(d.cards[0]!.lines.map((l) => l.label)).toEqual(['Your goal', 'Your one ask']);
  });

  it('leaves out a card with nothing to say, and says what to do when there is no research', () => {
    const d = buildPrepDeck(base({ plan: { ...plan, research: [], logisticsTips: [] } }));
    expect(kinds(d)).not.toContain('openers');
    expect(kinds(d)).not.toContain('careful');
    expect(kinds(d)).not.toContain('left_off');
    expect(d.cards.find((c) => c.kind === 'lately')!.lead).toMatch(/Deep research on their About tab/);
  });

  it('who they are: the last three roles, current first, with their dates, and the school marked as yours', () => {
    const d = buildPrepDeck(
      base({
        affiliations: [
          aff({ title: 'Intern', nameRaw: 'Lazard', startDate: '2022-06', endDate: '2022-08' }),
          aff({ title: 'Software Engineer', nameRaw: 'Stripe', startDate: '2024-07', isCurrent: true }),
          aff({ title: 'Analyst', nameRaw: 'Evercore', startDate: '2023-01', endDate: '2024-06' }),
          aff({ title: 'Tutor', nameRaw: 'Kumon', startDate: '2019-01', endDate: '2020-01' }),
          aff({
            kind: 'education',
            nameRaw: 'University of Michigan',
            degree: 'BS',
            field: 'Computer Science',
          }),
        ],
      }),
    );
    const who = d.cards.find((c) => c.kind === 'who')!;
    expect(who.lines.map((l) => l.text)).toEqual([
      'Software Engineer, Stripe',
      'Analyst, Evercore',
      'Intern, Lazard',
    ]);
    expect(who.lines[0]).toMatchObject({ label: 'Now', detail: 'Jul 2024 to Present' });
    expect(who.lines[1]!.detail).toBe('Jan 2023 to Jun 2024');
    expect(who.more?.lines[0]).toMatchObject({
      text: 'University of Michigan · BS, Computer Science',
      label: 'You went here too',
    });
  });

  it('lately, shared and openers come from the brief with their sources; a partly supported opener never shows', () => {
    const brief = {
      who: 'A payments engineer who writes about reliability.',
      recently: [{ text: 'Spoke at a payments meetup.', sources: [2], date: 'Sep 2026' }],
      inCommon: [{ text: 'Both did FIRST Robotics.', sources: [3] }],
      openers: [
        { text: 'Your meetup talk on retries', sources: [2], support: 'full' },
        { text: 'Your move to the risk team', sources: [4], support: 'partial' },
      ],
      careful: [],
      carefulClaims: [{ text: 'Stripe had layoffs this spring.', sources: [5] }],
      sources: [{ n: 2, url: 'https://example.com/talk' }],
    } as unknown as DossierView;
    const d = buildPrepDeck(base({ brief }));
    expect(d.cards.find((c) => c.kind === 'lately')!.lines[0]).toMatchObject({
      sources: [2],
      label: 'Sep 2026',
    });
    expect(d.cards.find((c) => c.kind === 'shared')!.lines.map((l) => l.text)).toEqual([
      'Both did FIRST Robotics.',
      'You both went to University of Michigan.',
    ]);
    const openers = d.cards.find((c) => c.kind === 'openers')!.lines.map((l) => l.text);
    expect(openers).toContain('“Your meetup talk on retries”');
    expect(openers.join(' ')).not.toMatch(/risk team/);
    expect(d.cards.find((c) => c.kind === 'careful')!.lines[0]).toMatchObject({ sources: [5] });
    expect(d.sources).toHaveLength(1);
  });

  it('lately also says a job change and links their latest posts, newest first, without reading anything new', () => {
    const d = buildPrepDeck(
      base({
        jobChange: {
          from: { company: 'Plaid' },
          to: { company: 'Stripe', title: 'Software Engineer' },
          observedAt: '2026-09-01',
          startedAt: '2026-08',
        },
        posts: [{ id: '7001', at: '2026-09-01' }, { id: '7003', at: '2026-10-20' }, { id: '7002' }],
      }),
    );
    const lately = d.cards.find((c) => c.kind === 'lately')!;
    expect(lately.lines[0]).toMatchObject({
      label: 'Aug 2026',
      text: 'Moved to Stripe as Software Engineer, from Plaid.',
    });
    expect(lately.more?.lines.map((l) => l.text)).toEqual(['Posted 2026-10-20', 'Posted 2026-09-01']);
    expect(lately.more?.lines[0]?.href).toBe('https://www.linkedin.com/feed/update/urn:li:activity:7003/');
  });

  it('what you share names past employers in common and the mutuals who know them best', () => {
    const d = buildPrepDeck(
      base({
        person: { firstName: 'Dana', displayName: 'Dana Lee' },
        affiliations: [aff({ nameRaw: 'Evercore', startDate: '2023-01' })],
        mine: { orgs: ['evercore'] },
        mutuals: [
          { personId: 'k', name: 'Kenji Ito', phrase: 'worked with Dana (2022 to 2025)' },
          { personId: 'm', name: 'Mia Chen', phrase: 'comments on her posts' },
          { personId: 'n', name: 'Noah Kim', phrase: 'connected' },
          { personId: 'o', name: 'Omar Haddad', phrase: 'connected' },
        ],
      }),
    );
    const shared = d.cards.find((c) => c.kind === 'shared')!;
    expect(shared.lines[0]!.text).toBe('You both worked at Evercore.');
    expect(shared.lines.filter((l) => l.label === 'Mutual')).toHaveLength(3);
    expect(shared.lines[1]).toMatchObject({
      personId: 'k',
      text: 'Kenji Ito worked with Dana (2022 to 2025)',
    });
  });

  it('where you left off: the last three things once each, what you owe them and what they told you', () => {
    const d = buildPrepDeck(
      base({
        timeline: [
          { at: '2026-10-20', text: 'Email: Coffee next week?' },
          { at: '2026-10-19', text: 'Email: Coffee next week?' },
          { at: '2026-10-10', text: 'Met at the career fair' },
          { at: '2026-10-01', text: 'Connected on LinkedIn' },
          { at: '2026-09-01', text: 'Older thing' },
        ],
        openItems: [{ text: 'Send her your resume' }],
        facts: [
          { type: 'advice', text: 'Apply early, the payments team fills by November.' },
          { type: 'role_detail', text: 'Works on payouts' },
        ],
      }),
    );
    const left = d.cards.find((c) => c.kind === 'left_off')!;
    expect(left.lines.map((l) => l.text)).toEqual([
      'Email: Coffee next week?',
      'Met at the career fair',
      'Connected on LinkedIn',
      'Send her your resume',
      'Apply early, the payments team fills by November.',
    ]);
    expect(left.lines[3]!.label).toBe('You owe them');
  });

  it('opens on After the call once the chat happened or its time has passed', () => {
    expect(buildPrepDeck(base({ chat: { stage: 'completed', completedAt: '2026-10-24' } })).start).toBe(8);
    expect(
      buildPrepDeck(base({ event: { startAt: '2026-10-25T13:00:00Z', endAt: '2026-10-25T13:30:00Z' } }))
        .start,
    ).toBe(8);
    expect(
      buildPrepDeck(base({ event: { startAt: '2026-10-26T13:00:00Z', endAt: '2026-10-26T13:30:00Z' } }))
        .start,
    ).toBe(0);
  });

  it('a person marked do not contact says so; no line anywhere has an em or en dash', () => {
    const d = buildPrepDeck(
      base({
        person: { firstName: 'Dana', displayName: 'Dana Lee', doNotContact: true },
        affiliations: [aff({ title: 'Engineer', startDate: '2021-03', endDate: '2023-04' })],
      }),
    );
    expect(d.cards.find((c) => c.kind === 'careful')!.lines[0]!.text).toBe(
      'You marked Dana as do not contact.',
    );
    expect(allText(d)).not.toMatch(/[–—]/);
  });
});
