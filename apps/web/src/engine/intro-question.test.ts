import type { Person, User } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { generateBrief, revalidatePending } from './brief';
import { loadDemo } from './demo';
import { recomputeEdges } from './graph';
import { ingestEmails, type RawEmail } from './ingest';
import { answerIntroductionQuestion } from './introductions';

/**
 * The fallback for an introduction the cues missed: "Did Lena introduce you to Sam?" on a group email from someone
 * the student knows, with a new person on it. Yes records the introduction exactly as an automatic one; no is
 * remembered for the thread.
 */

const D = 86_400_000;
const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
let user: User;
let seq = 0;

beforeAll(async () => {
  user = await loadDemo({ reset: true, now });
}, 60_000);

const questions = () =>
  db.suggestions
    .where('userId')
    .equals(user.id)
    .filter((s) => s.kind === 'confirm_intro')
    .toArray();

/** Someone from the demo the student has written to and met: a known sender. */
async function knownPerson(skip: string[] = []): Promise<Person> {
  const chats = await db.chats
    .where('userId')
    .equals(user.id)
    .filter((c) => c.stage === 'nurturing' && !c.referrerPersonId)
    .toArray();
  for (const c of chats) {
    const p = await db.people.get(c.personId);
    if (p?.primaryEmail && !skip.includes(p.id)) return p;
  }
  throw new Error('no known person in the demo');
}

function groupMail(
  from: { name: string; email: string },
  cc: { name: string; email: string }[],
  subject: string,
  body: string,
  sentAt: string,
  thread = `iq_${++seq}`,
): RawEmail {
  const id = `${thread}_${++seq}`;
  return {
    externalMessageId: id,
    externalThreadId: thread,
    from: `${from.name} <${from.email}>`,
    to: [user.email],
    cc: cc.map((c) => `${c.name} <${c.email}>`),
    subject,
    sentAt,
    bodyText: body,
    headers: { 'message-id': `<${id}@test>` },
  };
}

const asRaw = (p: Person) => ({ name: p.displayName, email: p.primaryEmail! });

describe('"Did Lena introduce you to Sam?"', () => {
  it('the demo asks about its soft introduction instead of dropping it', async () => {
    const qs = (await questions()).filter((s) => s.status === 'pending');
    expect(qs).toHaveLength(1);
    const q = qs[0]!;
    const thread = (await db.threads.get(q.payload.threadId as string))!;
    expect(thread.introduction).toBeUndefined();
    expect(thread.possibleIntroduction).toMatchObject({ status: 'open' });
    const introducer = (await db.people.get(thread.possibleIntroduction!.introducerId))!;
    const person = (await db.people.get(q.personId!))!;
    expect(q.reasonText).toBe(`Did ${introducer.firstName} introduce you to ${person.firstName}?`);
    // nothing was recorded on a guess
    expect(await db.chats.where('personId').equals(person.id).count()).toBe(0);
  });

  it('yes records it exactly as a detected introduction: card with referrer, touchpoint, edge, reply card', async () => {
    const q = (await questions()).find((s) => s.status === 'pending')!;
    const threadId = q.payload.threadId as string;
    const pid = q.personId!;
    const opened = await answerIntroductionQuestion(user, threadId, true, now);
    expect(opened).toBe(1);
    const thread = (await db.threads.get(threadId))!;
    const asked = thread.possibleIntroduction!;
    expect(asked.status).toBe('confirmed');
    expect(thread.introduction).toEqual({
      introducerId: asked.introducerId,
      introducedIds: [pid],
      messageId: asked.messageId,
      at: asked.at,
    });
    expect(thread.isNetworking).toBe(true);
    const chat = (await db.chats.where('personId').equals(pid).first())!;
    expect(chat).toMatchObject({
      stage: 'identified',
      referrerPersonId: asked.introducerId,
      introducedAt: asked.at,
      threadId,
    });
    const touch = await db.touchpoints
      .where('personId')
      .equals(pid)
      .filter((t) => t.kind === 'intro_observed')
      .first();
    expect(touch?.refId).toBe(asked.messageId);
    await recomputeEdges(user.id);
    const edge = await db.edges
      .where('userId')
      .equals(user.id)
      .filter((e) => e.type === 'introduced_by' && [e.personAId, e.personBId].includes(pid))
      .first();
    expect(edge).toBeDefined();
    expect((await db.suggestions.get(q.id))?.status).toBe('done');
    const reply = await db.suggestions.where('dedupeKey').equals(`introreply:${chat.id}`).first();
    expect(reply?.status).toBe('pending');
    // the brief does not ask again
    await generateBrief(user, 'daily', now);
    expect((await questions()).filter((s) => s.status === 'pending')).toHaveLength(0);
    const fb = await db.feedback.where('userId').equals(user.id).toArray();
    expect(fb.some((f) => f.kind === 'intro_confirm' && f.refId === threadId)).toBe(true);
  }, 60_000);

  it('no is remembered for the thread: a later message in it and the next brief never ask again', async () => {
    const lena = await knownPerson();
    const sam = { name: 'Samir Haddad', email: 'samir.haddad@contoso.com' };
    const thread = `iq_no_${++seq}`;
    await ingestEmails(
      user,
      [
        groupMail(
          asRaw(lena),
          [sam],
          'Samir at Contoso',
          `Hi ${user.firstName},\n\nSamir spent the last few years as an analytics lead at Contoso and mentors students on the side. Worth a conversation before your applications go in.\n\n${lena.firstName}`,
          ago(2 * D),
          thread,
        ),
      ],
      { useLlm: false, now },
    );
    const samir = (await db.people
      .where('userId')
      .equals(user.id)
      .filter((p) => p.primaryEmail === sam.email)
      .first())!;
    const q = (await questions()).find((s) => s.personId === samir.id)!;
    expect(q.status).toBe('pending');
    expect(q.reasonText).toBe(`Did ${lena.firstName} introduce you to Samir?`);
    await answerIntroductionQuestion(user, q.payload.threadId as string, false, now);
    expect((await db.suggestions.get(q.id))?.status).toBe('dismissed');
    expect((await db.threads.get(q.payload.threadId as string))?.possibleIntroduction?.status).toBe(
      'dismissed',
    );
    expect(await db.chats.where('personId').equals(samir.id).count()).toBe(0);
    // another soft message in the same thread
    await ingestEmails(
      user,
      [
        groupMail(
          asRaw(lena),
          [sam],
          'Samir at Contoso',
          'Samir also ran the analytics internship program for two summers. Worth a conversation.',
          ago(D),
          thread,
        ),
      ],
      { useLlm: false, now },
    );
    await generateBrief(user, 'daily', new Date(now.getTime() + 1000));
    const after = (await questions()).filter((s) => s.personId === samir.id);
    expect(after.map((s) => s.status)).toEqual(['dismissed']);
  }, 60_000);

  it('retires the question once a later message records the introduction', async () => {
    const lena = await knownPerson();
    const ana = { name: 'Anika Rowe', email: 'anika.rowe@stripe.com' };
    const thread = `iq_retire_${++seq}`;
    await ingestEmails(
      user,
      [
        groupMail(
          asRaw(lena),
          [ana],
          'Anika at Stripe',
          `Hi ${user.firstName}, Anika ran the fraud models team at Stripe for three years. She is generous with students and knows the interview loop well.\n\n${lena.firstName}`,
          ago(3 * D),
          thread,
        ),
      ],
      { useLlm: false, now },
    );
    const anika = (await db.people
      .where('userId')
      .equals(user.id)
      .filter((p) => p.primaryEmail === ana.email)
      .first())!;
    const q = (await questions()).find((s) => s.personId === anika.id)!;
    expect(q.status).toBe('pending');
    // Anika answers by reply-all, thanking the introducer: the introduction is recorded from it
    await ingestEmails(
      user,
      [
        {
          ...groupMail(
            ana,
            [{ name: lena.displayName, email: lena.primaryEmail! }],
            'Re: Anika at Stripe',
            `Thanks for the intro, ${lena.firstName}! ${user.firstName}, happy to chat. Would Thursday at 2pm work?\n\nAnika`,
            ago(D),
            thread,
          ),
        },
      ],
      { useLlm: false, now },
    );
    const t = (await db.threads.where('externalThreadId').equals(thread).first())!;
    expect(t.introduction?.introducerId).toBe(lena.id);
    expect(t.possibleIntroduction?.status).toBe('retired');
    expect((await db.suggestions.get(q.id))?.status).toBe('expired');
    await revalidatePending(user.id, now);
    expect((await db.suggestions.get(q.id))?.status).toBe('expired');
  }, 60_000);

  it("the student's own reply-all to the person settles the question as a yes", async () => {
    const lena = await knownPerson();
    const raw = { name: 'Bram Okafor', email: 'bram.okafor@ramp.com' };
    const thread = `iq_answered_${++seq}`;
    await ingestEmails(
      user,
      [
        groupMail(
          asRaw(lena),
          [raw],
          'Bram at Ramp',
          `Hi ${user.firstName}, Bram led the pricing team at Ramp until this spring. Worth a conversation before your interviews.\n\n${lena.firstName}`,
          ago(3 * D),
          thread,
        ),
      ],
      { useLlm: false, now },
    );
    const bram = (await db.people
      .where('userId')
      .equals(user.id)
      .filter((p) => p.primaryEmail === raw.email)
      .first())!;
    const q = (await questions()).find((s) => s.personId === bram.id)!;
    expect(q.status).toBe('pending');
    const id = `${thread}_${++seq}`;
    await ingestEmails(
      user,
      [
        {
          externalMessageId: id,
          externalThreadId: thread,
          from: user.email,
          to: [raw.email],
          cc: [],
          subject: 'Re: Bram at Ramp',
          sentAt: ago(2 * D),
          bodyText: `Thanks ${lena.firstName} (moving you to bcc).\n\nBram, great to meet you. Would you have 20 minutes next week?\n\n${user.firstName}`,
          headers: { 'message-id': `<${id}@test>` },
        },
      ],
      { useLlm: false, now },
    );
    const t = (await db.threads.where('externalThreadId').equals(thread).first())!;
    expect(t.introduction).toMatchObject({ introducerId: lena.id, introducedIds: [bram.id] });
    expect(t.possibleIntroduction?.status).toBe('confirmed');
    expect((await db.suggestions.get(q.id))?.status).toBe('done');
    const chat = (await db.chats.where('personId').equals(bram.id).first())!;
    expect(chat.referrerPersonId).toBe(lena.id);
    expect(chat.stage).toBe('outreach_sent');
  }, 60_000);

  it('never asks when the sender is a stranger, or about an ordinary group email', async () => {
    const before = (await questions()).length;
    await ingestEmails(
      user,
      [
        groupMail(
          { name: 'Quinn Harper', email: 'quinn.harper@unknown-fund.com' },
          [{ name: 'Rafael Ortega', email: 'rafael.ortega@contoso.com' }],
          'Rafael at Contoso',
          `Hi ${user.firstName}, Rafael spent the last few years as a data scientist at Contoso and mentors students. Worth a conversation.\n\nQuinn`,
          ago(2 * D),
        ),
      ],
      { useLlm: false, now },
    );
    const known = await knownPerson();
    await ingestEmails(
      user,
      [
        groupMail(
          asRaw(known),
          [{ name: 'Dana Whitfield', email: 'dana.whitfield@ramp.com' }],
          'Club budget',
          'Dana signed off on the club budget. You can order the shirts.',
          ago(2 * D),
        ),
      ],
      { useLlm: false, now },
    );
    expect((await questions()).length).toBe(before);
  }, 60_000);
});
