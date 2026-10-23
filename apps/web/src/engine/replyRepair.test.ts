import type { CoffeeChat, Person, StageEvent, User } from '@orbit/core';
import { newId } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import { setOrbitApiBaseForTests } from '../integrations/orbitApi';
import { createLocalUser } from './account';
import { repairFalseReplies } from './replyRepair';

const NOW = new Date('2026-10-22T12:00:00.000Z');
let user: User;

async function person(id: string, name: string) {
  const [first, last] = name.split(' ');
  await db.people.put({
    id,
    userId: user.id,
    displayName: name,
    firstName: first!,
    lastName: last!,
    nameNormalized: name.toLowerCase(),
    emails: [`${first!.toLowerCase()}@x.com`],
    linkedinMemberId: `ACo${first}`,
    sources: ['linkedin_live'],
    isHuman: true,
    strength: 0.5,
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as Person);
}

async function chat(id: string, personId: string, patch: Partial<CoffeeChat>) {
  await db.chats.put({
    id,
    userId: user.id,
    personId,
    stage: 'replied',
    stageEnteredAt: '2026-10-15T00:00:00.000Z',
    source: 'manual',
    goalTags: [],
    outreachChannel: 'linkedin',
    bumpCount: 0,
    priority: 2,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
    ...patch,
  });
}

async function move(
  chatId: string,
  e: Partial<StageEvent> & Pick<StageEvent, 'fromStage' | 'toStage' | 'createdAt'>,
) {
  await db.stageEvents.add({
    id: newId('se'),
    userId: user.id,
    chatId,
    status: 'applied',
    actor: 'system',
    reason: 'inbound_signal:reply_neutral',
    confidence: 0.85,
    ...e,
  });
}

async function invented(chatId: string, personId: string, what: 'replied' | 'met', at: string) {
  await db.touchpoints.add({
    id: newId('tp'),
    userId: user.id,
    personId,
    kind: what === 'met' ? 'meeting' : 'linkedin_in',
    occurredAt: at,
    refTable: 'stage_evidence',
    refId: `${chatId}:${what}`,
    summary: what === 'met' ? 'Coffee chat' : 'They replied',
    weight: what === 'met' ? 1 : 0.6,
  });
}

describe('repairing false "they replied"', () => {
  beforeEach(async () => {
    await wipeDatabase();
    setOrbitApiBaseForTests(null);
    setConnectorsMockForTests(false);
    user = await createLocalUser({ fullName: 'Alex Rivera', firstName: 'Alex' });
    for (const [id, name] of [
      ['p_li', 'Maya Chen'],
      ['p_mail', 'Ana Ruiz'],
      ['p_real', 'Sam Lee'],
      ['p_ok', 'Jo Park'],
      ['p_met', 'Lena Ford'],
    ] as const)
      await person(id, name);
  });
  afterEach(() => {
    setOrbitApiBaseForTests(undefined);
    setConnectorsMockForTests(undefined);
  });

  it('undoes moves the inbox readers made from messages that were no reply, and keeps everything real', async () => {
    // LinkedIn: a "To contact" chat opened on Oct 20, moved by an old exchange from September
    await chat('c_li', 'p_li', {
      createdAt: '2026-10-20T00:00:00.000Z',
      firstOutreachAt: '2026-09-20T10:00:00.000Z',
      lastOutboundAt: '2026-09-20T10:00:00.000Z',
      lastInboundAt: '2026-09-21T10:00:00.000Z',
    });
    await move('c_li', {
      fromStage: 'identified',
      toStage: 'outreach_sent',
      reason: 'outbound:outreach',
      evidenceRefTable: 'linkedin_messages',
      evidenceRefId: 'li1',
      createdAt: '2026-10-20T01:00:00.000Z',
    });
    await move('c_li', {
      fromStage: 'outreach_sent',
      toStage: 'replied',
      evidenceRefTable: 'linkedin_messages',
      evidenceRefId: 'li2',
      createdAt: '2026-10-20T01:00:01.000Z',
    });
    await invented('c_li', 'p_li', 'replied', '2026-09-21T10:00:00.000Z');

    // Gmail: she emailed on Oct 5, before the student's outreach on Oct 10
    await chat('c_mail', 'p_mail', {
      stage: 'scheduling',
      outreachChannel: 'gmail',
      createdAt: '2026-10-09T00:00:00.000Z',
      firstOutreachAt: '2026-10-10T10:00:00.000Z',
      lastOutboundAt: '2026-10-10T10:00:00.000Z',
      lastInboundAt: '2026-10-05T10:00:00.000Z',
    });
    await db.messages.put({
      id: 'msg_early',
      userId: user.id,
      threadId: 't1',
      direction: 'inbound',
      fromPersonId: 'p_mail',
      fromEmail: 'ana@x.com',
      toEmails: [],
      ccEmails: [],
      sentAt: '2026-10-05T10:00:00.000Z',
      bodyText: 'Hi! Want to chat about our club?',
      isAutomated: false,
    } as never);
    await move('c_mail', {
      fromStage: 'outreach_sent',
      toStage: 'replied',
      evidenceRefTable: 'messages',
      evidenceRefId: 'msg_early',
      createdAt: '2026-10-11T00:00:00.000Z',
    });
    await move('c_mail', {
      fromStage: 'replied',
      toStage: 'scheduling',
      reason: 'inbound_signal:scheduling_proposal',
      evidenceRefTable: 'messages',
      evidenceRefId: 'msg_early',
      createdAt: '2026-10-11T00:00:01.000Z',
    });
    await invented('c_mail', 'p_mail', 'replied', '2026-10-05T10:00:00.000Z');
    await db.suggestions.add({
      id: 'sg_sched',
      userId: user.id,
      kind: 'schedule_propose',
      status: 'pending',
      chatId: 'c_mail',
      personId: 'p_mail',
      payload: {},
      dedupeKey: 'x',
      createdAt: '2026-10-11T00:00:00.000Z',
    } as never);

    // a real reply after the outreach: stays
    await chat('c_real', 'p_real', {
      outreachChannel: 'gmail',
      firstOutreachAt: '2026-10-10T10:00:00.000Z',
      lastInboundAt: '2026-10-12T10:00:00.000Z',
    });
    await db.messages.put({
      id: 'msg_reply',
      userId: user.id,
      threadId: 't2',
      direction: 'inbound',
      fromPersonId: 'p_real',
      fromEmail: 'sam@x.com',
      toEmails: [],
      ccEmails: [],
      sentAt: '2026-10-12T10:00:00.000Z',
      bodyText: 'Happy to chat!',
      isAutomated: false,
    } as never);
    await move('c_real', {
      fromStage: 'outreach_sent',
      toStage: 'replied',
      evidenceRefTable: 'messages',
      evidenceRefId: 'msg_reply',
      createdAt: '2026-10-12T11:00:00.000Z',
    });

    // the student confirmed a proposed reply: theirs to say, kept with its touch
    await chat('c_ok', 'p_ok', { createdAt: '2026-10-20T00:00:00.000Z' });
    await move('c_ok', {
      fromStage: 'identified',
      toStage: 'replied',
      actor: 'user',
      reason: 'confirmed:inbound_signal:reply_neutral',
      createdAt: '2026-10-20T02:00:00.000Z',
    });
    await invented('c_ok', 'p_ok', 'replied', '2026-10-20T02:00:00.000Z');

    // "Coffee chat": one from a booked meeting that happened stays; one Orbit guessed (cancelled event) goes
    await db.events.put({
      id: 'ev_cancelled',
      userId: user.id,
      externalEventId: 'manual:1',
      title: 'Coffee',
      startAt: '2026-10-01T15:00:00.000Z',
      endAt: '2026-10-01T15:30:00.000Z',
      attendees: [],
      attendeePersonIds: ['p_met'],
      status: 'cancelled',
    } as never);
    await chat('c_met', 'p_met', {
      stage: 'completed',
      completedAt: '2026-10-01T15:30:00.000Z',
      scheduledEventId: 'ev_cancelled',
    });
    await invented('c_met', 'p_met', 'met', '2026-10-01T15:00:00.000Z');

    const stats = await repairFalseReplies(user, NOW);
    expect(stats).toEqual({ chats: 2, touches: 3, people: 3 });

    const li = (await db.chats.get('c_li'))!;
    expect(li.stage).toBe('identified');
    expect(li.firstOutreachAt ?? li.lastOutboundAt ?? li.lastInboundAt).toBeUndefined();
    const liEvents = await db.stageEvents.where('chatId').equals('c_li').toArray();
    expect(
      liEvents.every((e) => e.status === 'rejected' && e.reason.endsWith('|repair:no_reply_after_outreach')),
    ).toBe(true);

    const mail = (await db.chats.get('c_mail'))!;
    expect(mail.stage).toBe('outreach_sent');
    expect(mail.firstOutreachAt).toBe('2026-10-10T10:00:00.000Z');
    expect(mail.lastInboundAt).toBeUndefined();
    expect((await db.suggestions.get('sg_sched'))!.status).toBe('expired');

    expect((await db.chats.get('c_real'))!.stage).toBe('replied');
    expect((await db.chats.get('c_ok'))!.stage).toBe('replied');
    expect((await db.chats.get('c_met'))!.stage).toBe('completed');
    const left = (await db.touchpoints.toArray()).filter((t) => t.refTable === 'stage_evidence');
    expect(left.map((t) => t.refId)).toEqual(['c_ok:replied']);
    // closeness without the invented touches
    expect((await db.people.get('p_li'))!.strength).toBe(0);

    // once
    expect(await repairFalseReplies(user, NOW)).toBeUndefined();
  });

  it('never runs for the sample student', async () => {
    setConnectorsMockForTests(true);
    expect(await repairFalseReplies(user, NOW)).toBeUndefined();
  });
});
