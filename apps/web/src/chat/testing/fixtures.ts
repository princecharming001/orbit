import type {
  CoffeeChat,
  MeetingNote,
  Organization,
  OutboundMessage,
  Person,
  PersonFact,
  ReachPath,
  Suggestion,
} from '@orbit/core';

/** Made-up people for the fake engine when the database holds none (unit tests, an empty profile). */
const AT = '2026-10-01T10:00:00.000Z';

export function fixturePerson(i: number, over: Partial<Person> = {}): Person {
  const base = [
    {
      displayName: 'Priya Patel',
      firstName: 'Priya',
      lastName: 'Patel',
      title: 'Engineering Manager',
      org: 'Ramp',
    },
    { displayName: 'Omar Hassan', firstName: 'Omar', lastName: 'Hassan', title: 'Engineer', org: 'Stripe' },
    { displayName: 'Mei Chen', firstName: 'Mei', lastName: 'Chen', title: 'Product Manager', org: 'Figma' },
    { displayName: 'Jordan Lee', firstName: 'Jordan', lastName: 'Lee', title: 'Designer', org: 'Linear' },
  ][i % 4]!;
  return {
    id: `fx_p${i}`,
    userId: 'fx_user',
    displayName: base.displayName,
    firstName: base.firstName,
    lastName: base.lastName,
    nameNormalized: base.displayName.toLowerCase(),
    primaryEmail: `${base.firstName.toLowerCase()}@${base.org.toLowerCase()}.com`,
    emails: [`${base.firstName.toLowerCase()}@${base.org.toLowerCase()}.com`],
    currentTitle: base.title,
    currentOrganizationRaw: base.org,
    relationshipType: 'unknown' as Person['relationshipType'],
    strength: [0.72, 0.41, 0.33, 0.18][i % 4]!,
    interactionCount: 3,
    sources: ['manual'] as Person['sources'],
    isHuman: true,
    tags: [],
    lastInteractionAt: AT,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  } as Person;
}

export function fixtureChat(
  person: Person,
  stage: CoffeeChat['stage'],
  over: Partial<CoffeeChat> = {},
): CoffeeChat {
  return {
    id: `fx_c_${person.id}`,
    userId: person.userId,
    personId: person.id,
    stage,
    stageEnteredAt: AT,
    source: 'manual',
    goalTags: [],
    bumpCount: 0,
    priority: 2,
    ...over,
  } as CoffeeChat;
}

export function fixtureDraft(person: Person, over: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    id: `fx_out_${person.id}`,
    userId: person.userId,
    personId: person.id,
    channel: 'gmail',
    kind: 'thank_you',
    toEmail: person.primaryEmail,
    subject: 'Thank you for your time',
    bodyDraft: `Hi ${person.firstName},\n\nThank you for taking the time to talk yesterday. Your point about leading with one project story stuck with me, and I am rewriting my answers around it this week.\n\nBest,\nAlex`,
    status: 'draft',
    generatedBy: 'template',
    needsInput: [],
    createdAt: AT,
    updatedAt: AT,
    ...over,
  } as OutboundMessage;
}

export function fixtureSuggestion(person: Person, over: Partial<Suggestion> = {}): Suggestion {
  return {
    id: `fx_s_${person.id}`,
    userId: person.userId,
    kind: 'thank_you',
    personId: person.id,
    priorityScore: 0.9,
    reasonText: `You spoke with ${person.firstName} yesterday. A short thank-you today keeps the door open.`,
    signals: {},
    payload: {},
    status: 'pending',
    dedupeKey: `fx:${person.id}`,
    carriedOver: 0,
    expiresAt: '2026-12-31T00:00:00.000Z',
    createdAt: AT,
    ...over,
  } as Suggestion;
}

export function fixtureNote(person: Person): MeetingNote {
  return {
    id: `fx_n_${person.id}`,
    userId: person.userId,
    source: 'manual',
    occurredAt: AT,
    rawText: `${person.firstName} said new analysts should ship something in week one. Offered to look over my resume.`,
    attendees: [{ name: person.displayName }],
    personIds: [person.id],
    matchStatus: 'confirmed',
    createdAt: AT,
  } as MeetingNote;
}

export function fixtureFacts(person: Person): PersonFact[] {
  return [
    { type: 'advice', text: 'you said new analysts should ship something in week one' },
    { type: 'offer', text: 'you offered to look over my resume' },
    { type: 'background', text: 'you moved from consulting to product two years ago' },
  ].map(
    (f, i) =>
      ({
        id: `fx_f_${person.id}_${i}`,
        userId: person.userId,
        personId: person.id,
        type: f.type,
        text: f.text,
        sourceTable: 'notes',
        sourceId: `fx_n_${person.id}`,
        confidence: 0.9,
        createdAt: AT,
      }) as PersonFact,
  );
}

export function fixtureOrganization(): Organization {
  return {
    id: 'fx_org_ramp',
    name: 'Ramp',
    nameNormalized: 'ramp',
    domains: ['ramp.com'],
    industry: 'Fintech',
  };
}

export function fixtureRoutes(target: Person, via: Person): ReachPath[] {
  return [
    {
      hops: [
        {
          fromId: 'user',
          toId: via.id,
          weight: 0.8,
          type: 'strength',
          text: `You know ${via.firstName} well`,
        },
        {
          fromId: via.id,
          toId: target.id,
          weight: 0.6,
          type: 'colleague',
          text: `${via.firstName} worked with ${target.firstName} at ${target.currentOrganizationRaw}`,
        },
      ],
      score: 0.48,
      band: 'strong',
    },
    {
      hops: [
        {
          fromId: 'user',
          toId: target.id,
          weight: 0.15,
          type: 'strength',
          text: 'You are connected on LinkedIn',
        },
      ],
      score: 0.15,
      band: 'long_shot',
    },
  ] as ReachPath[];
}
