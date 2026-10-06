import type { CoffeeChat, Person, Suggestion, User } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { evaluateImmediateSuggestions, generateBrief, revalidatePending, upsertSuggestions } from './brief';
import { loadDemo } from './demo';
import { ingestEmails, ingestEvents, type RawEmail, type RawEvent } from './ingest';
import { ingestNote } from './notes';
import { dismissSuggestion } from './send';
import { applyStage, decideProposedStage, runTimedStageRules } from './stages';

const H = 3_600_000;
const D = 86_400_000;
const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
let user: User;
let seq = 0;

beforeAll(async () => {
  user = await loadDemo({ reset: true });
}, 60_000);

function mail(
  who: { name: string; email: string },
  dir: 'out' | 'in',
  sentAt: string,
  body: string,
  thread: string,
  subject = 'Coffee chat?',
): RawEmail {
  seq++;
  const me = user.email;
  return {
    externalMessageId: `pt_${thread}_${seq}`,
    externalThreadId: `pt_${thread}`,
    from: dir === 'out' ? me : `${who.name} <${who.email}>`,
    to: [dir === 'out' ? who.email : me],
    cc: [],
    subject: seq > 1 ? `Re: ${subject}` : subject,
    sentAt,
    bodyText: body,
    headers: { 'message-id': `<pt_${thread}_${seq}@test>` },
  };
}

function meeting(who: { name: string; email: string }, id: string, startAt: string): RawEvent {
  return {
    externalEventId: `pt_ev_${id}`,
    title: `Coffee chat: ${who.name}`,
    startAt,
    endAt: new Date(new Date(startAt).getTime() + 30 * 60_000).toISOString(),
    status: 'confirmed',
    attendees: [
      { email: user.email, self: true },
      { email: who.email, displayName: who.name, responseStatus: 'accepted' },
    ],
  };
}

const OUTREACH = (first: string) =>
  `Hi ${first},\n\nI'm a junior at Cornell studying CS and I came across your profile while looking for alumni in payments. Would you be open to a 20-minute call sometime in the next couple of weeks?\n\nBest,\nAlex`;
const YES = (first: string) =>
  `Hi Alex, happy to chat! Always glad to help a Cornell student. Let me know what works for you.\n\n${first}`;

async function personByEmail(email: string): Promise<Person> {
  return (await db.people
    .where('userId')
    .equals(user.id)
    .filter((p) => p.primaryEmail === email)
    .first())!;
}
async function chatOf(personId: string): Promise<CoffeeChat> {
  return (await db.chats.where('personId').equals(personId).first())!;
}
async function cardsOf(personId: string): Promise<Suggestion[]> {
  return db.suggestions.where('personId').equals(personId).toArray();
}

describe('stage dates come from the evidence (PS-1, PS-16, EG-01)', () => {
  it('a weeks-old, already-thanked chat gets no thank-you and keeps its real dates', async () => {
    const who = { name: 'Nora Quinn', email: 'nora.quinn@acmehealth.com' };
    const met = ago(51 * D);
    await ingestEmails(
      user,
      [
        mail(who, 'out', ago(60 * D), OUTREACH('Nora'), 'nora'),
        mail(who, 'in', ago(58 * D), YES('Nora'), 'nora'),
        mail(
          who,
          'out',
          ago(50 * D),
          'Hi Nora, thank you so much for taking the time to chat yesterday. Your advice on picking a team was really helpful.\n\nBest,\nAlex',
          'nora',
        ),
      ],
      { useLlm: false, now },
    );
    await ingestEvents(user, [meeting(who, 'nora', met)], now);
    const p = await personByEmail(who.email);
    const chat = await chatOf(p.id);
    expect(chat.completedAt).toBe(new Date(new Date(met).getTime() + 30 * 60_000).toISOString());
    expect(chat.stage).toBe('followed_up');
    expect(chat.followedUpAt).toBe(ago(50 * D));
    await generateBrief(user, 'daily', now);
    const cards = await cardsOf(p.id);
    expect(cards.filter((s) => s.kind === 'thank_you' && s.status === 'pending')).toEqual([]);
  });

  it('stageEnteredAt is the time of the message that moved the chat, and a bump sent from Gmail counts', async () => {
    const who = { name: 'Omar Field', email: 'omar.field@ledgerly.com' };
    await ingestEmails(
      user,
      [
        mail(who, 'out', ago(12 * D), OUTREACH('Omar'), 'omar'),
        mail(
          who,
          'out',
          ago(5 * D),
          'Hi Omar, just floating this back up in case it got buried.\n\nAlex',
          'omar',
        ),
      ],
      { useLlm: false, now },
    );
    const chat = await chatOf((await personByEmail(who.email)).id);
    expect(chat.stage).toBe('outreach_sent');
    expect(chat.stageEnteredAt).toBe(ago(12 * D));
    expect(chat.bumpCount).toBe(1);
    expect(chat.lastOutboundAt).toBe(ago(5 * D));
  });

  it('a note about a chat three weeks ago completes it then, with no thank-you card', async () => {
    const who = { name: 'Priya Natarajan', email: 'priya.natarajan@stripe.com' };
    await ingestEmails(
      user,
      [
        mail(who, 'out', ago(30 * D), OUTREACH('Priya'), 'priya'),
        mail(who, 'in', ago(28 * D), YES('Priya'), 'priya'),
      ],
      { useLlm: false, now },
    );
    const p = await personByEmail(who.email);
    await ingestNote(
      user,
      {
        text: 'Chat with Priya. She said to focus on one project.',
        source: 'manual',
        personIds: [p.id],
        occurredAt: ago(21 * D),
      },
      now,
    );
    const chat = await chatOf(p.id);
    expect(chat.completedAt).toBe(ago(21 * D));
    expect((await cardsOf(p.id)).filter((s) => s.kind === 'thank_you' && s.status === 'pending')).toEqual([]);
  });
});

describe('cards are retired when their trigger goes away (PS-3, PS-4, PS-6)', () => {
  it('a thank-you sent from Gmail after the chat retires the thank-you card, whatever its wording', async () => {
    const who = { name: 'Rhea Kapoor', email: 'rhea.kapoor@figma.com' };
    await ingestEmails(
      user,
      [
        mail(who, 'out', ago(10 * D), OUTREACH('Rhea'), 'rhea'),
        mail(who, 'in', ago(9 * D), YES('Rhea'), 'rhea'),
      ],
      { useLlm: false, now },
    );
    await ingestEvents(user, [meeting(who, 'rhea', ago(6 * H))], now);
    const p = await personByEmail(who.email);
    const card = (await cardsOf(p.id)).find((s) => s.kind === 'thank_you' && s.status === 'pending');
    expect(card).toBeDefined();
    await ingestEmails(
      user,
      [
        mail(
          who,
          'out',
          ago(2 * H),
          'Really enjoyed our conversation this morning. Thank you for the advice on system design.',
          'rhea',
        ),
      ],
      { useLlm: false, now },
    );
    expect((await chatOf(p.id)).stage).toBe('followed_up');
    const after = (await db.suggestions.get(card!.id))!;
    expect(after.status).toBe('expired');
    expect(after.expiredReason).toBe('stage:followed_up');
    if (after.outboundMessageId)
      expect((await db.outbound.get(after.outboundMessageId))?.status).toBe('cancelled');
  });

  it('moving a chat to declined retires its scheduling card and draft', async () => {
    const who = { name: 'Theo Grant', email: 'theo.grant@brex.com' };
    await ingestEmails(
      user,
      [
        mail(who, 'out', ago(4 * D), OUTREACH('Theo'), 'theo'),
        mail(who, 'in', ago(1 * D), YES('Theo'), 'theo'),
      ],
      { useLlm: false, now },
    );
    const p = await personByEmail(who.email);
    const chat = await chatOf(p.id);
    expect(chat.stage).toBe('replied');
    const card = (await cardsOf(p.id)).find((s) => s.kind === 'schedule_propose' && s.status === 'pending')!;
    expect(card?.outboundMessageId).toBeTruthy();
    await applyStage(chat, 'declined', 'user', 'user:drag');
    const after = (await db.suggestions.get(card.id))!;
    expect(after.status).toBe('expired');
    expect(after.expiredReason).toBe('stage:declined');
    expect((await db.outbound.get(card.outboundMessageId!))?.status).toBe('cancelled');
  });

  it('a proposed decline is withdrawn once the person actually replies', async () => {
    const who = { name: 'Maya Lund', email: 'maya.lund@notion.so' };
    await ingestEmails(user, [mail(who, 'out', ago(6 * D), OUTREACH('Maya'), 'mayal')], {
      useLlm: false,
      now,
    });
    const p = await personByEmail(who.email);
    const chat = await chatOf(p.id);
    expect(
      await applyStage(chat, 'declined', 'system', 'inbound_signal:reply_decline', { confidence: 0.7 }),
    ).toBe('proposed');
    await evaluateImmediateSuggestions(user.id, { chatId: chat.id, personId: p.id }, now);
    const confirm = (await cardsOf(p.id)).find((s) => s.kind === 'confirm_stage' && s.status === 'pending')!;
    expect(confirm).toBeDefined();
    await applyStage(chat, 'replied', 'system', 'inbound_signal:reply_positive', { confidence: 0.9 });
    const ev = (await db.stageEvents.get(confirm.payload.stageEventId as string))!;
    expect(ev.status).toBe('rejected');
    expect((await db.suggestions.get(confirm.id))?.status).toBe('expired');
    // and accepting a proposal that the chat has moved past never overwrites the newer stage
    await applyStage(chat, 'declined', 'system', 'inbound_signal:reply_decline', { confidence: 0.7 });
    const second = (await db.stageEvents
      .where('chatId')
      .equals(chat.id)
      .filter((e) => e.status === 'proposed')
      .first())!;
    await db.chats.update(chat.id, { stage: 'scheduled' });
    expect(await decideProposedStage(second.id, true)).toBe('moved_on');
    expect((await chatOf(p.id)).stage).toBe('scheduled');
  });

  it('a confirm card whose time has passed is retired before Today shows it', async () => {
    const c = (await db.chats
      .where('userId')
      .equals(user.id)
      .filter((x) => x.stage === 'scheduling')
      .first())!;
    const row: Suggestion = {
      id: 's_pt_confirm',
      userId: user.id,
      kind: 'schedule_confirm',
      personId: c.personId,
      chatId: c.id,
      priorityScore: 0.9,
      reasonText: 'x',
      signals: {},
      payload: { time: { startIso: ago(H), raw: 'today at noon' } },
      status: 'pending',
      dedupeKey: 'confirm:pt:stale',
      carriedOver: 0,
      expiresAt: ago(-D),
      createdAt: ago(2 * D),
    };
    await db.suggestions.put(row);
    await revalidatePending(user.id, now);
    const after = (await db.suggestions.get(row.id))!;
    expect(after.status).toBe('expired');
    expect(after.expiredReason).toBe('time_passed');
  });
});

describe('system expiry is not a user decision (PS-5, PS-7)', () => {
  it('a bump retired while the person was hidden comes back when they are shown again', async () => {
    const who = { name: 'Una Brooks', email: 'una.brooks@plaid.com' };
    await ingestEmails(user, [mail(who, 'out', ago(12 * D), OUTREACH('Una'), 'una')], { useLlm: false, now });
    const p = await personByEmail(who.email);
    await generateBrief(user, 'daily', now);
    const bump = (await cardsOf(p.id)).find((s) => s.kind === 'follow_up_bump')!;
    expect(bump.status).toBe('pending');
    await db.people.update(p.id, { hiddenAt: now.toISOString() });
    await generateBrief(user, 'daily', new Date(now.getTime() + D));
    expect((await db.suggestions.get(bump.id))?.status).toBe('expired');
    await db.people.update(p.id, { hiddenAt: undefined });
    await generateBrief(user, 'daily', new Date(now.getTime() + 2 * D));
    const back = (await db.suggestions.get(bump.id))!;
    expect(back.status).toBe('pending');
    expect(back.expiredReason).toBeUndefined();
  });

  it('"already did this" counts the bump, and a silent thread closes after three weeks', async () => {
    const who = { name: 'Vik Rao', email: 'vik.rao@ramp.com' };
    await ingestEmails(user, [mail(who, 'out', ago(9 * D), OUTREACH('Vik'), 'vik')], { useLlm: false, now });
    const p = await personByEmail(who.email);
    await generateBrief(user, 'daily', now);
    const bump = (await cardsOf(p.id)).find((s) => s.kind === 'follow_up_bump' && s.status === 'pending')!;
    expect(bump).toBeDefined();
    await dismissSuggestion(user.id, bump, 'already_did');
    let chat = await chatOf(p.id);
    expect(chat.bumpCount).toBe(1);
    await runTimedStageRules(user.id, 2, new Date(now.getTime() + 22 * D));
    chat = await chatOf(p.id);
    expect(chat.stage).toBe('no_response');
  });
});

describe('carry-over (PS-10, PS-11)', () => {
  it('an untouched scheduling draft follows the new time windows', async () => {
    const who = { name: 'Wes Holt', email: 'wes.holt@airtable.com' };
    await ingestEmails(
      user,
      [mail(who, 'out', ago(4 * D), OUTREACH('Wes'), 'wes'), mail(who, 'in', ago(1 * D), YES('Wes'), 'wes')],
      { useLlm: false, now },
    );
    const p = await personByEmail(who.email);
    const card = (await cardsOf(p.id)).find((s) => s.kind === 'schedule_propose' && s.status === 'pending')!;
    const before = (await db.outbound.get(card.outboundMessageId!))!.bodyDraft;
    const later = new Date(now.getTime() + 4 * D);
    const fresh = { ...card, priorityScore: 0.8, urgency: 0.9, goalRelevance: 0.6, confidence: 1 };
    await upsertSuggestions(
      user.id,
      [{ ...fresh, payload: { ...card.payload, windows: [new Date(later.getTime() + D).toISOString()] } }],
      later,
    );
    const after = (await db.outbound.get(card.outboundMessageId!))!;
    expect(after.status).toBe('draft');
    expect(after.bodyDraft).not.toBe(before);
  });

  it('still-true cards that miss the cut are kept for later instead of lost', async () => {
    const brief = await generateBrief(user, 'daily', now);
    const pending = await db.suggestions
      .where('userId')
      .equals(user.id)
      .filter((s) => s.status === 'pending')
      .toArray();
    const deferred = pending.filter((s) => s.deferred);
    if ((brief.stats.candidates ?? 0) > (brief.stats.shown ?? 0)) expect(deferred.length).toBeGreaterThan(0);
    for (const s of deferred) expect(brief.suggestionIds).not.toContain(s.id);
  });
});

describe('notes after the calendar (EG-02 hook)', () => {
  it('re-drafts a pending thank-you once the notes from the chat arrive', async () => {
    const who = { name: 'Sam Ortiz', email: 'sam.ortiz@datadoghq.com' };
    await ingestEmails(
      user,
      [mail(who, 'out', ago(10 * D), OUTREACH('Sam'), 'sam'), mail(who, 'in', ago(9 * D), YES('Sam'), 'sam')],
      { useLlm: false, now },
    );
    await ingestEvents(user, [meeting(who, 'sam', ago(5 * H))], now);
    const p = await personByEmail(who.email);
    const card = (await cardsOf(p.id)).find((s) => s.kind === 'thank_you' && s.status === 'pending')!;
    const before = (await db.outbound.get(card.outboundMessageId!))!;
    await ingestNote(
      user,
      {
        text: 'Coffee chat with Sam.\nAdvice: Sam recommended shipping one small project end to end before applying.\nSam offered to refer me to the platform team.\nSam is training for the Chicago marathon in October.',
        source: 'manual',
        personIds: [p.id],
        occurredAt: ago(5 * H),
      },
      now,
    );
    const facts = await db.facts.where('personId').equals(p.id).toArray();
    const after = (await db.outbound.get(card.outboundMessageId!))!;
    expect(after.status).toBe('draft');
    expect(facts.length).toBeGreaterThan(0);
    expect(after.bodyDraft).not.toBe(before.bodyDraft);
  });
});
