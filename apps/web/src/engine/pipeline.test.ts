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

describe('thank-you drafts follow the facts (DQ-03)', () => {
  it('re-drafts an untouched thank-you when a fact arrives by any route, once', async () => {
    const who = { name: 'Rhea Lund', email: 'rhea.lund@plaid.com' };
    await ingestEmails(
      user,
      [
        mail(who, 'out', ago(12 * D), OUTREACH('Rhea'), 'rhea_lund'),
        mail(who, 'in', ago(11 * D), YES('Rhea'), 'rhea_lund'),
      ],
      { useLlm: false, now },
    );
    await ingestEvents(user, [meeting(who, 'rhea_lund', ago(4 * H))], now);
    const p = await personByEmail(who.email);
    const card = (await cardsOf(p.id)).find((s) => s.kind === 'thank_you' && s.status === 'pending')!;
    const before = (await db.outbound.get(card.outboundMessageId!))!;
    expect(before.bodyDraft).not.toMatch(/ledger|sandbox/i);
    // the student types what they remember on the person page, after the draft was written
    const later = new Date(Date.parse(before.createdAt) + 60_000).toISOString();
    await db.facts.add({
      id: 'f_dq03',
      userId: user.id,
      personId: p.id,
      type: 'advice',
      text: 'Rhea recommended building one small project on the Plaid sandbox before applying.',
      sourceTable: 'manual',
      sourceId: 'manual',
      confidence: 1,
      occurredAt: later,
      createdAt: later,
    });
    await revalidatePending(user.id, now);
    const after = (await db.outbound.get(card.outboundMessageId!))!;
    expect(after.status).toBe('draft');
    expect(after.bodyDraft).toMatch(/sandbox/i);
    expect(after.claims?.some((c) => c.factId === 'f_dq03')).toBe(true);
    expect((await db.suggestions.get(card.id))!.payload.factsAsOf).toBe(later);
    // nothing new: no second re-draft, and an edited draft is never rewritten
    await db.outbound.update(after.id, { bodyFinal: 'My own words.' });
    await db.facts.update('f_dq03', { createdAt: new Date(Date.parse(later) + 1).toISOString() });
    await revalidatePending(user.id, now);
    expect((await db.outbound.get(after.id))!.bodyFinal).toBe('My own words.');
  });
});

describe('out of office is not a reply (EG-12)', () => {
  it('holds the bump until two business days after the return date, then brings it back', async () => {
    const who = { name: 'Odile Marsh', email: 'odile.marsh@brex.com' };
    const back = new Date(now.getTime() + 10 * D);
    const backText = back.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      timeZone: user.timezone,
    });
    await ingestEmails(
      user,
      [
        mail(who, 'out', ago(9 * D), OUTREACH('Odile'), 'odile'),
        mail(
          who,
          'in',
          ago(9 * D - 5 * 60_000),
          `Thank you for your email. I am out of the office until ${backText} with limited access to email.`,
          'odile',
        ),
      ],
      { useLlm: false, now },
    );
    const p = await personByEmail(who.email);
    const chat = await chatOf(p.id);
    expect(chat.stage).toBe('outreach_sent');
    expect(chat.lastInboundAt).toBeUndefined();
    expect(chat.bumpNotBefore).toBeDefined();
    expect(new Date(chat.bumpNotBefore!).getTime()).toBeGreaterThan(back.getTime());
    expect(
      (await cardsOf(p.id)).some((s) => s.kind === 'confirm_stage' || s.kind === 'schedule_propose'),
    ).toBe(false);
    await generateBrief(user, 'daily', now);
    expect((await cardsOf(p.id)).some((s) => s.kind === 'follow_up_bump' && s.status === 'pending')).toBe(
      false,
    );
    await generateBrief(user, 'daily', new Date(new Date(chat.bumpNotBefore!).getTime() + H));
    const bump = (await cardsOf(p.id)).find((s) => s.kind === 'follow_up_bump' && s.status === 'pending');
    expect(bump?.reasonText).toMatch(/out of office/);
    // and the thread is not closed as no response while they were away
    expect((await chatOf(p.id)).stage).toBe('outreach_sent');
  });
});

describe('warm-up actions (SND-19)', () => {
  it('marking the same action done twice adds one touchpoint', async () => {
    const { startWarmUpOrOutreach, markWarmUpAction } = await import('./brief');
    const p = (await db.people
      .where('userId')
      .equals(user.id)
      .filter((x) => !x.primaryEmail && !!x.linkedinSlug && x.strength < 0.2)
      .toArray()
      .then(async (all) => {
        for (const x of all) {
          const c = await db.chats.where('personId').equals(x.id).first();
          if (!c) return x;
        }
        return undefined;
      }))!;
    expect(p).toBeDefined();
    const { chat } = await startWarmUpOrOutreach(user, p.id, 'linkedin');
    expect(chat.stage).toBe('warming');
    await markWarmUpAction(user.id, chat.id, 'w1', true);
    await markWarmUpAction(user.id, chat.id, 'w1', true);
    const tps = await db.touchpoints
      .where('personId')
      .equals(p.id)
      .filter((t) => t.kind === 'linkedin_engaged')
      .count();
    expect(tps).toBe(1);
  });
});

describe('the demo, after the fixes (DR-01, DR-03, EG-08, EG-19)', () => {
  it('the mentor met weeks ago is nurturing, gets no thank-you, and gets a follow-up on the intro she offered', async () => {
    const fresh = await loadDemo({ reset: true });
    user = fresh;
    const sofia = (await db.people
      .where('userId')
      .equals(user.id)
      .filter((p) => p.displayName === 'Sofia Bennett')
      .first())!;
    const chat = await chatOf(sofia.id);
    expect(chat.stage).toBe('nurturing');
    const cards = await cardsOf(sofia.id);
    expect(cards.some((s) => s.kind === 'thank_you')).toBe(false);
    // the demo's mentor already made the intro she offered (Theo's chat is credited to her): nothing is owed
    expect(cards.some((s) => s.kind === 'intro_request' && s.status === 'pending')).toBe(false);
    const theo = (await db.people
      .where('userId')
      .equals(user.id)
      .filter((p) => p.firstName === 'Theo')
      .first())!;
    const theoChat = await chatOf(theo.id);
    expect(theoChat.referrerPersonId).toBe(sofia.id);
    // had she not made it yet, the offer would get a follow-up with a blurb she can forward
    await db.chats.delete(theoChat.id);
    await generateBrief(user, 'daily', new Date(Date.now() + 1000));
    const intro = (await cardsOf(sofia.id)).find((s) => s.kind === 'intro_request' && s.status === 'pending');
    expect(intro?.reasonText).toMatch(/offered to introduce you to Theo/);
    const draft = intro?.outboundMessageId ? await db.outbound.get(intro.outboundMessageId) : undefined;
    expect(draft?.bodyDraft).toMatch(/you kindly offered to introduce me to Theo/);
    await db.chats.put(theoChat);
    // no pending card proposes or confirms times for a chat that is already on the calendar or done
    const pending = await db.suggestions
      .where('userId')
      .equals(user.id)
      .filter(
        (s) => s.status === 'pending' && (s.kind === 'schedule_propose' || s.kind === 'schedule_confirm'),
      )
      .toArray();
    for (const s of pending) {
      const c = await db.chats.get(s.chatId!);
      expect(['replied', 'scheduling']).toContain(c?.stage);
    }
    // a scheduled chat entered its stage when the time was agreed, not when the demo loaded
    const scheduled = await db.chats
      .where('userId')
      .equals(user.id)
      .filter((c) => c.stage === 'scheduled')
      .toArray();
    for (const c of scheduled) expect(new Date(c.stageEnteredAt).getTime()).toBeLessThan(Date.now() - H);
  }, 60_000);

  it('person summaries call only the last 90 days recent and never print a raw date', async () => {
    const { refreshPersonSummary } = await import('./brief');
    const people = await db.people.where('userId').equals(user.id).limit(40).toArray();
    for (const p of people) {
      await refreshPersonSummary(user, p.id);
      const s = (await db.people.get(p.id))!.summary ?? '';
      expect(s).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(s).not.toMatch(/recent interaction/);
    }
  }, 60_000);
});

describe('status news (EG-09)', () => {
  it('an application status change drafts an update to the person who helped there', async () => {
    const sofia = (await db.people
      .where('userId')
      .equals(user.id)
      .filter((p) => p.displayName === 'Sofia Bennett')
      .first())!;
    const org = sofia.currentOrganizationRaw!;
    const existing = await db.targetCompanies
      .where('userId')
      .equals(user.id)
      .filter((t) => t.nameRaw.toLowerCase() === org.toLowerCase())
      .first();
    const id = existing?.id ?? 'tc_status_test';
    await db.targetCompanies.put({
      ...(existing ?? { id, userId: user.id, nameRaw: org, priority: 1 as const }),
      status: 'interviewing',
      statusChangedAt: new Date(now.getTime() - D).toISOString(),
    });
    await generateBrief(user, 'daily', now);
    const card = (await cardsOf(sofia.id)).find(
      (s) => s.dedupeKey === `status:${id}:interviewing:${sofia.id}`,
    );
    expect(card?.status).toBe('pending');
    const { ensureDrafts } = await import('./brief');
    await ensureDrafts(user, [card!.id]);
    const row = (await db.suggestions.get(card!.id))!;
    const draft = (await db.outbound.get(row.outboundMessageId!))!;
    expect(draft.bodyDraft).toMatch(new RegExp(`interviewing with ${org}`));
    expect(draft.needsInput ?? []).toEqual([]);
  }, 60_000);
});

describe('email introductions and suggested names (EG-08)', () => {
  it('the demo intro threads open a card for each person introduced, with the introducer as referrer', async () => {
    const fresh = await loadDemo({ reset: true });
    user = fresh;
    const intros = await db.threads
      .where('userId')
      .equals(user.id)
      .filter((t) => !!t.introduction)
      .toArray();
    expect(intros.length).toBeGreaterThan(0);
    for (const t of intros) {
      const intro = t.introduction!;
      for (const pid of intro.introducedIds) {
        const chat = await chatOf(pid);
        expect(chat.referrerPersonId).toBe(intro.introducerId);
        expect(chat.introducedAt).toBe(intro.at);
      }
    }
    const edges = await db.edges
      .where('userId')
      .equals(user.id)
      .filter((e) => e.type === 'introduced_by')
      .toArray();
    expect(edges.length).toBe(intros.length);
    expect(edges[0]!.evidence.text).toMatch(/^\S+ introduced you to \S+$/);
  }, 60_000);

  it('a fresh intro email gets a reply card whose draft picks up the introduction', async () => {
    const seq0 = seq++;
    const raw: RawEmail = {
      externalMessageId: `pt_intro_${seq0}`,
      externalThreadId: `pt_intro_${seq0}`,
      from: 'Lena Ortiz <lena.ortiz@northwind.com>',
      to: [user.email],
      cc: ['Sam Patel <sam.patel@contoso.com>'],
      subject: 'Intro: Alex <> Sam',
      sentAt: ago(D),
      bodyText: `${user.firstName}, meet Sam. Sam leads the payments team at Contoso and was a Cornell student too. I'll let you two take it from here.\n\nLena`,
      headers: { 'message-id': `<pt_intro_${seq0}@test>` },
    };
    await ingestEmails(user, [raw], { useLlm: false, now });
    const sam = await personByEmail('sam.patel@contoso.com');
    const lena = await personByEmail('lena.ortiz@northwind.com');
    const chat = await chatOf(sam.id);
    expect(chat.stage).toBe('identified');
    expect(chat.referrerPersonId).toBe(lena.id);
    const card = (await cardsOf(sam.id)).find((s) => s.dedupeKey === `introreply:${chat.id}`)!;
    expect(card.status).toBe('pending');
    expect(card.reasonText).toBe('Lena introduced you to Sam yesterday; reply while the intro is fresh');
    const { ensureDrafts } = await import('./brief');
    await ensureDrafts(user, [card.id]);
    const row = (await db.suggestions.get(card.id))!;
    const draft = (await db.outbound.get(row.outboundMessageId!))!;
    expect(draft.subject).toBe("Following up on Lena's introduction");
    expect(draft.bodyDraft).toMatch(/Lena was kind enough to introduce us|follow up on Lena's introduction/);
  }, 60_000);

  it('a reply in the intro thread, in a later sync, moves the chat and reads their answer (L9)', async () => {
    const t = `pt_intro_l9_${seq++}`;
    const ines = 'Ines Park <ines.park@fabrikam.com>';
    const tobias = 'Tobias Lindqvist <tobias.lindqvist@tailspin.com>';
    const base = { externalThreadId: t, subject: 'Intro: Alex <> Tobias' };
    await ingestEmails(
      user,
      [
        {
          ...base,
          externalMessageId: `${t}_1`,
          from: ines,
          to: [user.email],
          cc: [tobias],
          sentAt: ago(2 * D),
          bodyText: `${user.firstName}, meet Tobias. Tobias, Alex is the student I mentioned. I'll let you two take it from here.\n\nInes`,
          headers: { 'message-id': `<${t}_1@test>` },
        },
      ],
      { useLlm: false, now },
    );
    const o = await personByEmail('tobias.lindqvist@tailspin.com');
    const before = await chatOf(o.id);
    expect(before.stage).toBe('identified');
    // the student answers the intro by reply-all, moving Ines to bcc
    await ingestEmails(
      user,
      [
        {
          ...base,
          subject: 'Re: Intro: Alex <> Tobias',
          externalMessageId: `${t}_2`,
          from: user.email,
          to: [tobias],
          cc: [],
          sentAt: ago(D),
          bodyText:
            'Thanks Ines (moving you to bcc).\n\nTobias, great to meet you. Would you have 20 minutes next week to talk about your path into data science?\n\nAlex',
          headers: { 'message-id': `<${t}_2@test>`, 'in-reply-to': `<${t}_1@test>` },
        },
      ],
      { useLlm: false, now },
    );
    const answered = await chatOf(o.id);
    expect(answered.stage).toBe('outreach_sent');
    expect(answered.lastOutboundAt).toBe(ago(D));
    await revalidatePending(user.id, now);
    const reply = (await cardsOf(o.id)).find((s) => s.dedupeKey === `introreply:${answered.id}`);
    expect(reply?.status ?? 'expired').not.toBe('pending');
    // Tobias answers in the same thread with a time: the confirm card appears
    const day = new Date(now.getTime() + 6 * D);
    const when = new Intl.DateTimeFormat('en-US', {
      timeZone: user.timezone,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(day);
    await ingestEmails(
      user,
      [
        {
          ...base,
          subject: 'Re: Intro: Alex <> Tobias',
          externalMessageId: `${t}_3`,
          from: tobias,
          to: [user.email],
          cc: [],
          sentAt: ago(2 * H),
          bodyText: `Hi Alex, happy to. Would ${when} at 2pm work?\n\nTobias`,
          headers: { 'message-id': `<${t}_3@test>`, 'in-reply-to': `<${t}_2@test>` },
        },
      ],
      { useLlm: false, now },
    );
    await revalidatePending(user.id, now);
    const after = await chatOf(o.id);
    expect(after.lastInboundAt).toBe(ago(2 * H));
    expect(after.stage).toBe('scheduling');
    const cards = await cardsOf(o.id);
    expect(cards.some((s) => s.kind === 'schedule_confirm' && s.status === 'pending')).toBe(true);
    expect(cards.some((s) => s.dedupeKey.startsWith('introreply:') && s.status === 'pending')).toBe(false);
  }, 60_000);

  it('a group email that only says "meet with you" opens no introduction card (L10)', async () => {
    const t = `pt_meet_l10_${seq++}`;
    await ingestEmails(
      user,
      [
        {
          externalMessageId: `${t}_1`,
          externalThreadId: t,
          from: 'Dagny Rowe <dagny.rowe@woodgrove.com>',
          to: [user.email],
          cc: ['Osric Vale <osric.vale@woodgrove.com>'],
          subject: 'Coffee next week',
          sentAt: ago(D),
          bodyText:
            'Hi Alex, Osric and I would love to meet with you next week to talk about the analyst program. Does Tuesday work?\n\nDagny',
          headers: { 'message-id': `<${t}_1@test>` },
        },
      ],
      { useLlm: false, now },
    );
    const thread = (await db.threads.where('externalThreadId').equals(t).first())!;
    expect(thread.introduction).toBeUndefined();
    const osric = await personByEmail('osric.vale@woodgrove.com');
    const chats = await db.chats.where('personId').equals(osric.id).toArray();
    expect(chats.some((c) => c.referrerPersonId)).toBe(false);
    expect((await cardsOf(osric.id)).some((s) => s.dedupeKey.startsWith('introreply:'))).toBe(false);
  }, 60_000);

  it('a name captured on the prep tab becomes a saved recommendation with the suggester as referrer', async () => {
    const { addSuggestedContacts, parseSuggestedNames } = await import('./introductions');
    expect(parseSuggestedNames('Priya Shah at Stripe, Tom Lee and maybe someone in sales')).toEqual([
      { name: 'Priya Shah', org: 'Stripe' },
      { name: 'Tom Lee' },
    ]);
    const sofia = (await db.people
      .where('userId')
      .equals(user.id)
      .filter((p) => p.displayName === 'Sofia Bennett')
      .first())!;
    const [priya] = await addSuggestedContacts(user.id, sofia.id, 'Priya Shah at Stripe', now);
    expect(priya?.displayName).toBe('Priya Shah');
    const rec = await db.recommendations.where('personId').equals(priya!.id).first();
    expect(rec?.status).toBe('saved');
    expect(rec?.reasons[0]?.text).toBe('Suggested by Sofia');
    const { findReferrerFor } = await import('./brief');
    expect((await findReferrerFor(user.id, priya!))?.id).toBe(sofia.id);
  }, 60_000);

  it('prep-tab names keep companies whole, never invent people, and report what they could not read (L12)', async () => {
    const { addSuggestedContacts, parseSuggestedNames, readSuggestedNames } = await import('./introductions');
    expect(parseSuggestedNames('Priya Shah at Procter and Gamble')).toEqual([
      { name: 'Priya Shah', org: 'Procter and Gamble' },
    ]);
    expect(parseSuggestedNames('priya shah')).toEqual([{ name: 'Priya Shah' }]);
    expect(parseSuggestedNames('Priya Shah (Stripe)')).toEqual([{ name: 'Priya Shah', org: 'Stripe' }]);
    expect(parseSuggestedNames('Ana de la Cruz')).toEqual([{ name: 'Ana de la Cruz' }]);
    expect(parseSuggestedNames('Priya Shah at Stripe and Tom Lee at Ramp')).toEqual([
      { name: 'Priya Shah', org: 'Stripe' },
      { name: 'Tom Lee', org: 'Ramp' },
    ]);
    expect(readSuggestedNames('Definitely Tom')).toEqual({ names: [], skipped: ['Definitely Tom'] });
    expect(readSuggestedNames('Tom at Stripe').names).toEqual([{ name: 'Tom', org: 'Stripe' }]);
    const sofia = (await db.people
      .where('userId')
      .equals(user.id)
      .filter((p) => p.displayName === 'Sofia Bennett')
      .first())!;
    const saved = await addSuggestedContacts(user.id, sofia.id, 'Priya Shah at Procter and Gamble', now);
    expect(saved.map((p) => p.displayName)).toEqual(['Priya Shah']);
    const gamble = await db.people
      .where('userId')
      .equals(user.id)
      .filter((p) => p.displayName === 'Gamble' || p.displayName === 'Definitely Tom')
      .count();
    expect(gamble).toBe(0);
    expect(await addSuggestedContacts(user.id, sofia.id, 'Definitely Tom', now)).toEqual([]);
  }, 60_000);

  it('a missed proposed time is owned up to in the new-times draft', async () => {
    const who = { name: 'Rhea Malik', email: 'rhea.malik@globex.com' };
    await ingestEmails(
      user,
      [
        mail(who, 'out', ago(12 * D), OUTREACH('Rhea'), 'rhea'),
        mail(who, 'in', ago(10 * D), 'Hi Alex, sure. Would Thursday at 2pm work?\n\nRhea', 'rhea'),
      ],
      { useLlm: false, now },
    );
    const p = await personByEmail(who.email);
    const card = (await cardsOf(p.id)).find((s) => s.kind === 'schedule_propose' && s.status === 'pending')!;
    expect(card.reasonText).toMatch(/but that time has passed; propose new times/);
    const { ensureDrafts } = await import('./brief');
    await ensureDrafts(user, [card.id]);
    const row = (await db.suggestions.get(card.id))!;
    const draft = (await db.outbound.get(row.outboundMessageId!))!;
    expect(draft.bodyDraft).toMatch(
      /I'm sorry I didn't get back to you in time for Thursday, \w{3} \d{1,2} at 2pm\./,
    );
  }, 60_000);
});
