import { describe, expect, it } from 'vitest';
import { contextText, type DraftContext, generateDraft } from '../drafts/templates';
import { placeholderIn, validateDraft } from '../drafts/validate';
import { defaultStyleCard } from '../style/card';
import type { MessageKind } from '../types';

// Every draft Orbit writes is ready to send as it is: never a bracket, a blank or a line the student must fill in,
// however little Orbit knows about the person. Only reminders that are not text (attach the resume, comment on a
// post) may come back as needs.

const NOW = new Date('2026-10-06T14:00:00Z');

// the kinds the template writer drafts (first_touch, warm_first_touch and reengage are the server composer's)
const KINDS: MessageKind[] = [
  'outreach',
  'bump',
  'schedule',
  'thank_you',
  'nurture',
  'congratulate',
  'referral_ask',
  'intro_request',
  'reply',
  'report_back',
];

const thin = (kind: MessageKind, channel: 'gmail' | 'linkedin', over: Partial<DraftContext> = {}) =>
  ({
    user: {
      firstName: 'Anish',
      lastName: 'Polakala',
      fullName: 'Anish Polakala',
      school: 'UC Berkeley',
      gradYear: 2027,
      degree: 'BA',
      majors: ['Data Science'],
      cycleLabel: 'Summer 2027 internship',
      targetFunctions: ['pm'],
      timezone: 'America/Los_Angeles',
    },
    styleCard: defaultStyleCard('warm', 'Anish'),
    // someone Orbit knows nothing about: no title, company, headline or facts
    person: { firstName: 'Isabella', fullName: 'Isabella', relationshipType: 'unknown', strength: 0.1 },
    facts: [],
    kind,
    channel,
    now: NOW,
    seed: `${kind}-${channel}`,
    ...over,
  }) as DraftContext;

const SITUATIONS: [string, Partial<DraftContext>][] = [
  ['nothing known', {}],
  ['after a call with nothing noted', { chat: { completedAt: '2026-10-01T17:00:00Z', stage: 'completed' } }],
  [
    'they asked a question',
    {
      thread: {
        asksOfUser: ['What area of PM are you most interested in?'],
        lastInboundAt: '2026-10-05T17:00:00Z',
      },
    },
  ],
  [
    'they asked for the posting',
    { thread: { lastInboundBody: 'Send me the posting link and I can refer you.' } },
  ],
  ['a commented warm-up', { chat: { commentedOnPost: true } as never }],
  [
    'an unnamed mutual',
    { connection: { kind: 'user_supplied', text: 'You spoke with my roommate at a dinner' } as never },
  ],
  [
    'a known company only',
    {
      person: {
        firstName: 'Isabella',
        fullName: 'Isabella Chen',
        org: 'Stripe',
        relationshipType: 'unknown',
        strength: 0.1,
      },
    },
  ],
];

describe('every draft is whole', () => {
  for (const kind of KINDS)
    for (const channel of ['gmail', 'linkedin'] as const)
      for (const [label, over] of SITUATIONS)
        it(`${kind} by ${channel}, ${label}`, () => {
          const ctx = thin(kind, channel, over);
          const d = generateDraft(ctx);
          // the same checks the editor and the server run before sending: nothing holds it
          const holds = validateDraft(d, {
            kind: d.kind,
            facts: ctx.facts,
            allowedUrls: [],
            recipientFirstName: ctx.person.firstName,
            recipientFullName: ctx.person.fullName,
            channel: ctx.channel,
            context: contextText(ctx),
          }).filter((i) => i.blocking);
          expect(holds, JSON.stringify(holds)).toEqual([]);
          for (const text of [d.subject ?? '', d.body, d.bodyShort ?? ''])
            expect(placeholderIn(text)).toBeUndefined();
          expect(d.needsInput.filter((n) => n !== 'resume' && n !== 'post')).toEqual([]);
          // sentences are separated ("cycle.Would" is a join that lost its space)
          expect(d.body).not.toMatch(/[a-z][.?!][A-Z]/);
        });
});

describe('a blank is caught even with its brackets gone', () => {
  it.each([
    ['[Why them: one line only true of Isabella]', true],
    [
      'Why them: one line only true of Isabella, like how you found them, what you share, or something of theirs you read] I am a junior.',
      true,
    ],
    ['Thanks for your note. [ASK USER: your answer]', true],
    ["I came across your profile and thought I'd introduce myself.", false],
    ["I'd love to learn how you got to where you are.", false],
    ['Here is the link: https://example.com/a[1]', false],
  ])('%s', (text, caught) => {
    expect(!!placeholderIn(text)).toBe(caught);
  });
});
