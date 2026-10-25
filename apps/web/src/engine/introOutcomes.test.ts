/**
 * Plan 21 §8: an intro ask keeps its route as weighed, its outcome is read from what Orbit sees, and the draft to the
 * introducer never repeats anything Orbit read about the pair.
 */
import type { EmailMessage, EmailThread, Person, ReachPath, User } from '@orbit/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { requestIntro } from './drafts';
import { introOutcomes } from './introOutcomes';

const NOW = new Date('2026-10-20T15:00:00Z');
const user: User = {
  id: 'u1',
  email: 'ravi@umich.edu',
  fullName: 'Ravi Jain',
  firstName: 'Ravi',
  lastName: 'Jain',
  school: 'University of Michigan',
  majors: [],
  timezone: 'America/Detroit',
  onboardingStep: 11,
  createdAt: '2026-01-01T00:00:00.000Z',
};
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
const JAI = person('p_jai', 'Jai Patel');
const ARLAN = person('p_arlan', 'Arlan Rakhmetzhanov', {
  currentOrganizationRaw: 'Nozomio',
  currentTitle: 'CEO',
});
const hops: ReachPath['hops'] = [
  { fromId: 'user', toId: JAI.id, weight: 0.4, type: 'strength', text: '' },
  {
    fromId: JAI.id,
    toId: ARLAN.id,
    weight: 0.607,
    type: 'linkedin_mutual',
    text: 'Jai is connected to Arlan on LinkedIn, and trades comments with Arlan on LinkedIn',
    band: 'know',
  },
];

const send = async (suggestionId: string, sentAt: string) => {
  const s = (await db.suggestions.get(suggestionId))!;
  await db.outbound.update(s.outboundMessageId!, { status: 'sent', sentAt });
};
const reply = (text: string, sentAt: string): EmailMessage =>
  ({
    id: `m_${sentAt}`,
    userId: user.id,
    threadId: 't1',
    externalMessageId: `x_${sentAt}`,
    direction: 'inbound',
    fromEmail: JAI.primaryEmail!,
    fromPersonId: JAI.id,
    toEmails: [user.email],
    ccEmails: [],
    subject: 'Re: intro',
    bodyText: text,
    sentAt,
    isAutomated: false,
  }) as unknown as EmailMessage;

beforeEach(async () => {
  await wipeDatabase();
  await db.users.put(user);
  await db.people.bulkPut([JAI, ARLAN]);
});

describe('intro outcomes (plan 21 §8)', () => {
  it('keeps the route as weighed, and the draft repeats nothing read about the pair', async () => {
    const r = (await requestIntro(user, JAI.id, ARLAN.id, { path: { score: 0.243, hops }, now: NOW }))!;
    expect((r.suggestion.payload as { path: unknown }).path).toEqual({
      score: 0.243,
      at: NOW.toISOString(),
      hops: [
        { fromId: 'user', toId: JAI.id, p: 0.4, kind: 'strength' },
        { fromId: JAI.id, toId: ARLAN.id, p: 0.607, kind: 'linkedin_mutual', band: 'know' },
      ],
    });
    const body = `${r.draft?.subject ?? ''} ${r.draft?.bodyDraft ?? ''}`.toLowerCase();
    expect(body).not.toMatch(/comment|react|repost|post|linkedin activity/);
  });

  it('reads an introduction, a reply, or three weeks of silence; nothing before it was sent', async () => {
    const r = (await requestIntro(user, JAI.id, ARLAN.id, { path: { score: 0.24, hops }, now: NOW }))!;
    expect(await introOutcomes(user.id, NOW)).toEqual([]);
    await send(r.suggestion.id, '2026-09-25T10:00:00Z');
    expect(await introOutcomes(user.id, new Date('2026-10-10T00:00:00Z'))).toEqual([]);
    expect((await introOutcomes(user.id, NOW)).map((x) => x.outcome)).toEqual(['no_response']);

    await db.messages.add(reply('Happy to, I’ll connect you two this week.', '2026-10-03T10:00:00Z'));
    expect((await introOutcomes(user.id, NOW)).map((x) => x.outcome)).toEqual(['agreed']);

    await db.threads.add({
      id: 't_intro',
      userId: user.id,
      externalThreadId: 'ti',
      messageCount: 1,
      participantEmails: [],
      participantPersonIds: [JAI.id, ARLAN.id],
      isNetworking: true,
      lastMessageAt: '2026-10-05T10:00:00Z',
      introduction: {
        introducerId: JAI.id,
        introducedIds: [ARLAN.id],
        messageId: 'mi',
        at: '2026-10-05T10:00:00Z',
      },
    } as EmailThread);
    const [ex] = await introOutcomes(user.id, NOW);
    expect(ex).toMatchObject({ outcome: 'intro_made', connectorId: JAI.id, targetId: ARLAN.id });
    expect(ex!.snapshot.hops).toHaveLength(2);
  });
});
