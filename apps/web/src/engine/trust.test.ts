import type { CoffeeChat, OutboundMessage, Person, Suggestion, User } from '@orbit/core';
import { nextSendWindow } from '@orbit/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import { createLocalUser } from './account';
import { UNDO_WINDOW_MS } from './send';
import { zoneFromLocation } from './timezone';
import {
  AUTO_UNDO_MS,
  answerTrustOffer,
  approvalStreaks,
  maybeAutoSend,
  OFFER_AT,
  raiseTrustCards,
} from './trust';

// Tuesday Oct 20 2026, 6:30 am in New York
const NOW = new Date('2026-10-20T10:30:00Z');
let user: User;

const person = (id: string, extra: Partial<Person> = {}): Person =>
  ({
    id,
    userId: user.id,
    displayName: `${id} Lee`,
    firstName: id,
    lastName: 'Lee',
    nameNormalized: `${id} lee`,
    primaryEmail: `${id.toLowerCase()}@x.com`,
    emails: [`${id.toLowerCase()}@x.com`],
    relationshipType: 'unknown',
    strength: 0.5,
    tieScore: 50,
    interactionCount: 3,
    sources: ['gmail'],
    isHuman: true,
    tags: [],
    createdAt: '',
    updatedAt: '',
    location: 'San Francisco Bay Area',
    ...extra,
  }) as Person;

async function approvals(kind: OutboundMessage['kind'], n: number, edited = false, start = 0) {
  for (let i = start; i < start + n; i++) {
    const at = new Date(NOW.getTime() - (100 - i) * 3_600_000).toISOString();
    await db.outbound.put({
      id: `o_${kind}_${i}`,
      userId: user.id,
      personId: 'Dana',
      channel: 'gmail',
      kind,
      bodyDraft: 'x',
      status: 'sent',
      generatedBy: 'template',
      createdAt: at,
    });
    await db.feedback.put({
      id: `f_${kind}_${i}`,
      userId: user.id,
      kind: edited ? 'edit' : 'approve',
      outboundMessageId: `o_${kind}_${i}`,
      createdAt: at,
    });
  }
}

beforeEach(async () => {
  await wipeDatabase();
  user = await createLocalUser({
    fullName: 'Ravi Jain',
    email: 'ravi@umich.edu',
    timezone: 'America/New_York',
  });
  await db.people.put(person('Dana'));
  setConnectorsMockForTests(true);
});

describe('the ladder (plan 23 §4.9)', () => {
  it('counts streaks by kind from feedback rows; an edit resets', async () => {
    await approvals('bump', 6);
    await approvals('bump', 1, true, 6);
    await approvals('bump', 4, false, 7);
    await approvals('thank_you', 3, false, 20);
    const s = await approvalStreaks(user.id, NOW);
    expect(s.bump).toMatchObject({ unedited: 4, edited: 1 });
    expect(s.thank_you.unedited).toBe(3);
    expect(s.schedule.unedited).toBe(0);
  });

  it('offers at exactly ten, bumps first; yes writes autoKinds; no is not asked again', async () => {
    await approvals('bump', OFFER_AT - 1);
    await approvals('thank_you', OFFER_AT, false, 30);
    await raiseTrustCards(user, NOW);
    // thank-yous earned it, bumps not yet: the thank-you offer comes
    let cards = await db.suggestions.where('kind').equals('trust_offer').toArray();
    expect(cards.map((c) => c.payload.messageKind)).toEqual(['thank_you']);
    await approvals('bump', 1, false, OFFER_AT - 1);
    await raiseTrustCards(user, NOW);
    // one offer at a time
    cards = await db.suggestions.where('kind').equals('trust_offer').toArray();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.reasonText).toBe(
      "You've approved 10 thank-yous without changing a word. Want Orbit to send thank-yous on its own? You'll see each one after it goes, and can undo for a minute.",
    );
    await answerTrustOffer(user, cards[0]!, false, NOW);
    await raiseTrustCards(user, NOW);
    const bump = (await db.suggestions.where('kind').equals('trust_offer').toArray()).find(
      (c) => c.status === 'pending',
    )!;
    expect(bump.payload.messageKind).toBe('bump');
    await answerTrustOffer(user, bump, true, NOW);
    expect((await db.settings.get(user.id))?.autoKinds).toEqual(['bump']);
    // the thank-you offer, answered no, is not made again
    await raiseTrustCards(user, NOW);
    expect(
      await db.suggestions
        .where('kind')
        .equals('trust_offer')
        .filter((c) => c.status === 'pending')
        .count(),
    ).toBe(0);
  });

  it('two edits to a handed-over kind in a month ask whether to keep it; Ask me again takes it back', async () => {
    await db.settings.update(user.id, { autoKinds: ['bump'] });
    await approvals('bump', 2, true);
    await raiseTrustCards(user, NOW);
    const card = (await db.suggestions.where('dedupeKey').equals('trust:recheck:bump').first())!;
    expect(card.reasonText).toBe(
      'You changed 2 bumps Orbit wrote this month. Keep sending bumps on your own?',
    );
    await answerTrustOffer(user, card, false, NOW);
    expect((await db.settings.get(user.id))?.autoKinds).toEqual([]);
    expect((await approvalStreaks(user.id, NOW)).bump.unedited).toBe(0);
  });
});

describe('sending on its own', () => {
  async function card(
    kind: Suggestion['kind'],
    msgKind: OutboundMessage['kind'],
    extra: Partial<OutboundMessage> = {},
  ) {
    await db.chats.put({
      id: 'c_dana',
      userId: user.id,
      personId: 'Dana',
      stage: 'outreach_sent',
      stageEnteredAt: '2026-10-10T00:00:00Z',
      source: 'manual',
      goalTags: [],
      bumpCount: 0,
      priority: 2,
      lastOutboundAt: '2026-10-12T15:00:00Z',
      createdAt: '2026-10-10T00:00:00Z',
      updatedAt: '2026-10-10T00:00:00Z',
    } as CoffeeChat);
    const msg: OutboundMessage = {
      id: 'o_card',
      userId: user.id,
      personId: 'Dana',
      chatId: 'c_dana',
      channel: 'gmail',
      kind: msgKind,
      toEmail: 'dana@x.com',
      subject: 'Following up',
      bodyDraft:
        'Hi Dana,\n\nJust bringing this back to the top of your inbox. Would 15 minutes next week work?\n\nThanks,\nRavi',
      status: 'draft',
      generatedBy: 'template',
      createdAt: NOW.toISOString(),
      ...extra,
    };
    await db.outbound.put(msg);
    const s: Suggestion = {
      id: 's_card',
      userId: user.id,
      kind,
      personId: 'Dana',
      chatId: 'c_dana',
      outboundMessageId: msg.id,
      priorityScore: 0.6,
      reasonText: 'x',
      signals: {},
      payload: {},
      status: 'pending',
      dedupeKey: 'k',
      carriedOver: 0,
      expiresAt: '2026-11-01T00:00:00Z',
      createdAt: NOW.toISOString(),
    };
    await db.suggestions.put(s);
    return s;
  }

  it('a handed-over kind queues in the recipient morning, with at least a minute to undo; taps keep 10 s', async () => {
    await db.settings.update(user.id, { autoKinds: ['bump'] });
    const s = await card('follow_up_bump', 'bump');
    const r = await maybeAutoSend(user, s, NOW);
    expect(r.sent).toBe(true);
    const m = (await db.outbound.get('o_card'))!;
    expect(m).toMatchObject({ status: 'queued', autopilot: true, autoSent: true });
    // 6:30 am in New York is 3:30 am in San Francisco: it waits for 8:00 there
    const sendAt = Date.parse(m.sendAt!);
    expect(sendAt).toBeGreaterThanOrEqual(Date.parse('2026-10-20T15:00:00Z'));
    expect(sendAt - NOW.getTime()).toBeGreaterThanOrEqual(AUTO_UNDO_MS);
    expect(AUTO_UNDO_MS).toBe(60_000);
    expect(UNDO_WINDOW_MS).toBe(10_000);
    expect((await db.people.get('Dana'))!.timezone).toBe('America/Los_Angeles');
  });

  it('never on LinkedIn, never a kind not handed over, never after a reply, never to a stranger', async () => {
    await db.settings.update(user.id, { autoKinds: ['bump'] });
    expect(
      (await maybeAutoSend(user, await card('follow_up_bump', 'bump', { channel: 'linkedin' }), NOW)).sent,
    ).toBe(false);
    expect((await maybeAutoSend(user, await card('thank_you', 'thank_you'), NOW)).sent).toBe(false);
    const s = await card('follow_up_bump', 'bump');
    await db.chats.update('c_dana', { lastInboundAt: new Date(NOW.getTime() + 60_000).toISOString() });
    expect(await maybeAutoSend(user, s, new Date(NOW.getTime() + 120_000))).toEqual({
      sent: false,
      why: 'they replied',
    });
    await db.chats.update('c_dana', { lastInboundAt: undefined });
    await db.people.update('Dana', { tieScore: 12 });
    expect(await maybeAutoSend(user, s, NOW)).toEqual({ sent: false, why: 'score 12' });
  });

  it('holds the daily cap of five', async () => {
    await db.settings.update(user.id, { autoKinds: ['bump'] });
    const s = await card('follow_up_bump', 'bump');
    const window = nextSendWindow(NOW, 'America/Los_Angeles', 'gmail', () => 0).notBefore;
    for (let i = 0; i < 5; i++)
      await db.outbound.put({
        id: `o_auto_${i}`,
        userId: user.id,
        personId: 'Dana',
        channel: 'gmail',
        kind: 'bump',
        bodyDraft: 'x',
        status: 'queued',
        autoSent: true,
        sendAt: window,
        generatedBy: 'template',
        createdAt: NOW.toISOString(),
      });
    expect(await maybeAutoSend(user, s, NOW)).toEqual({ sent: false, why: 'daily cap' });
  });
});

describe('the send window and the recipient zone', () => {
  it('skips a holiday: the Wednesday before Thanksgiving, evening, goes to the next Tuesday', () => {
    expect(
      nextSendWindow(new Date('2026-11-25T20:00:00Z'), 'America/New_York', 'gmail', () => 0).notBefore,
    ).toBe('2026-12-01T13:00:00.000Z');
  });

  it('reads a zone from where someone is', () => {
    expect(zoneFromLocation('San Francisco Bay Area')).toBe('America/Los_Angeles');
    expect(zoneFromLocation('Greater Boston')).toBe('America/New_York');
    expect(zoneFromLocation('Ann Arbor, Michigan, United States')).toBe('America/Detroit');
    expect(zoneFromLocation('Austin, TX')).toBe('America/Chicago');
    expect(zoneFromLocation('London, England, United Kingdom')).toBe('Europe/London');
    expect(zoneFromLocation('Somewhere, Ohio')).toBe('America/New_York');
    expect(zoneFromLocation('Remote')).toBeUndefined();
  });
});
