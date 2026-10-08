import type { User } from '@orbit/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../db/schema';
import { generateBrief, markWarmUpAction, startWarmUpOrOutreach } from './brief';
import { loadDemo } from './demo';
import { reachCompany, reachPerson } from './graph';
import { importConnectionsCsv } from './linkedin';
import { ingestNote } from './notes';
import { approveAndSend, checkSendAllowed, confirmHandoff } from './send';

let user: User;
beforeAll(async () => {
  // the demo is laid out on business days; pin a Tuesday so every card it promises exists whatever day CI runs
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-10-06T14:00:00'));
  user = await loadDemo({ reset: true });
}, 60_000);
afterAll(() => {
  vi.useRealTimers();
});

describe('demo pipeline', () => {
  it('derives stages from the mailbox and calendar', async () => {
    const chats = await db.chats.where('userId').equals(user.id).toArray();
    const stages = new Set(chats.map((c) => c.stage));
    expect(stages.has('outreach_sent')).toBe(true);
    expect(stages.has('replied')).toBe(true);
    expect(stages.has('scheduling')).toBe(true);
    expect(stages.has('scheduled')).toBe(true);
    expect(stages.has('completed') || stages.has('followed_up')).toBe(true);
    expect(stages.has('warming')).toBe(true);
    // decline is low-confidence: proposed, not applied silently
    const proposed = await db.stageEvents
      .where('userId')
      .equals(user.id)
      .filter((e) => e.status === 'proposed')
      .toArray();
    expect(proposed.some((e) => e.toStage === 'declined')).toBe(true);
  });
  it('wrote a welcome brief with drafts and confirmation cards', async () => {
    const briefs = await db.briefs.where('userId').equals(user.id).toArray();
    expect(briefs.length).toBeGreaterThan(0);
    const sugg = await db.suggestions
      .where('userId')
      .equals(user.id)
      .filter((s) => s.status === 'pending')
      .toArray();
    const kinds = new Set(sugg.map((s) => s.kind));
    expect(kinds.has('thank_you')).toBe(true);
    expect(kinds.has('schedule_confirm')).toBe(true);
    expect(kinds.has('prep_brief')).toBe(true);
    expect(kinds.has('warm_up_engage')).toBe(true);
    expect(kinds.has('confirm_stage')).toBe(true);
    const withDraft = sugg.filter((s) => s.outboundMessageId);
    expect(withDraft.length).toBeGreaterThan(0);
    for (const s of withDraft) {
      const d = await db.outbound.get(s.outboundMessageId!);
      expect(d?.status).toBe('draft');
      expect(d?.bodyDraft.length).toBeGreaterThan(20);
    }
  });
  it('extracted facts and action items from the Granola note', async () => {
    const facts = await db.facts.where('userId').equals(user.id).toArray();
    expect(facts.some((f) => f.type === 'offer')).toBe(true);
    expect(facts.some((f) => f.type === 'advice')).toBe(true);
    const items = await db.actionItems.where('userId').equals(user.id).toArray();
    expect(items.some((i) => /resume/i.test(i.text))).toBe(true);
  });
  it('approves and sends a thank-you, binding the text and advancing the stage', async () => {
    const s = (await db.suggestions
      .where('userId')
      .equals(user.id)
      .filter((x) => x.kind === 'thank_you' && x.status === 'pending')
      .first())!;
    const d = (await db.outbound.get(s.outboundMessageId!))!;
    const body = `${d.bodyDraft}\n\nPS: edited`;
    const r = await approveAndSend(user, d.id, body);
    expect(r.ok).toBe(true);
    // no Gmail connected: the mail app opens; it only counts as sent once the student confirms
    expect((await db.outbound.get(d.id))!.status).toBe('handed_off');
    expect((await confirmHandoff(user, d.id)).ok).toBe(true);
    const sent = (await db.outbound.get(d.id))!;
    expect(sent.status).toBe('sent');
    expect(sent.bodyFinal).toBe(body);
    expect(sent.bodyFinalHash).toBeTruthy();
    const chat = (await db.chats.get(s.chatId!))!;
    expect(chat.stage).toBe('followed_up');
    const fb = await db.feedback
      .where('userId')
      .equals(user.id)
      .filter((f) => f.kind === 'edit')
      .toArray();
    expect(fb.length).toBeGreaterThan(0);
    const audit = await db.audit.where('userId').equals(user.id).toArray();
    expect(audit.some((a) => a.action === 'message.sent')).toBe(true);
  });
  it('enforces the per-person cooldown on unanswered asks, not on the thank-you just sent', async () => {
    const sent = (await db.outbound
      .where('userId')
      .equals(user.id)
      .filter((o) => o.status === 'sent')
      .first())!;
    // the chat is followed_up (they answered), so even a bump is not held back by the cooldown
    expect((await checkSendAllowed(user.id, sent.personId, 'gmail', 'thank_you')).allowed).toBe(true);
    const chat = (await db.chats.get(sent.chatId!))!;
    await db.chats.update(chat.id, { stage: 'outreach_sent', stageEnteredAt: '2020-01-01T00:00:00.000Z' });
    const r = await checkSendAllowed(user.id, sent.personId, 'gmail', 'bump');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/just now and they have not replied yet/);
    await db.chats.update(chat.id, { stage: chat.stage, stageEnteredAt: chat.stageEnteredAt });
  });
  it('warm-up: marking actions done leads to an outreach suggestion', async () => {
    const chat = (await db.chats
      .where('userId')
      .equals(user.id)
      .filter((c) => c.stage === 'warming')
      .first())!;
    const notYetDone = chat.warmUp!.actions.filter((a) => !a.doneAt).length;
    for (const a of chat.warmUp!.actions) await markWarmUpAction(user.id, chat.id, a.id, true);
    const fresh = (await db.chats.get(chat.id))!;
    expect(fresh.warmUp!.actions.every((a) => a.doneAt)).toBe(true);
    await generateBrief(user, 'daily');
    const s = await db.suggestions
      .where('userId')
      .equals(user.id)
      .filter((x) => x.personId === chat.personId && x.kind === 'new_outreach' && x.status === 'pending')
      .first();
    expect(s).toBeDefined();
    const tps = await db.touchpoints
      .where('personId')
      .equals(chat.personId)
      .filter((t) => t.kind === 'linkedin_engaged')
      .count();
    // one touchpoint per action marked done here; the seeded action that was already done adds nothing (SND-19)
    expect(tps).toBe(notYetDone);
  });
  it('starts a warm-up for a cold LinkedIn-only person and outreach for a known one', async () => {
    const chatted = new Set(
      (await db.chats.where('userId').equals(user.id).toArray()).map((c) => c.personId),
    );
    const cold = (await db.people
      .where('userId')
      .equals(user.id)
      .filter((p) => !p.primaryEmail && p.strength < 0.2 && !!p.linkedinSlug && !chatted.has(p.id))
      .first())!;
    const r1 = await startWarmUpOrOutreach(user, cold.id, 'linkedin');
    expect(r1.chat?.stage).toBe('warming');
    expect(r1.draft).toBeUndefined();
    const warm = (await db.people
      .where('userId')
      .equals(user.id)
      .filter((p) => !!p.primaryEmail && p.strength < 0.2 && !chatted.has(p.id))
      .first())!;
    const r2 = await startWarmUpOrOutreach(user, warm.id, 'gmail');
    // a first draft alone does not put anyone on the Pipeline: the chat opens when the message goes out
    expect(r2.chat).toBeUndefined();
    expect(r2.draft?.kind).toBe('outreach');
    expect(r2.draft?.chatId).toBeUndefined();
    expect(await db.chats.where('personId').equals(warm.id).count()).toBe(0);
  });
  it('notes: a note from before the booked chat keeps it booked; the note from the chat moves scheduled → completed', async () => {
    const chat = (await db.chats
      .where('userId')
      .equals(user.id)
      .filter((c) => c.stage === 'scheduled')
      .first())!;
    const p = (await db.people.get(chat.personId))!;
    // a note dated before the booked chat (prep, an earlier talk) is filed with them but leaves the chat booked
    const early = await ingestNote(user, {
      text: `Questions to ask ${p.displayName}: how the team is staffed.`,
      source: 'manual',
      personIds: [p.id],
    });
    expect(early.personIds).toEqual([p.id]);
    expect((await db.chats.get(chat.id))!.stage).toBe('scheduled');
    // the note from the chat itself, written after it, closes it
    const ev = (
      await db.events
        .where('userId')
        .equals(user.id)
        .filter((e) => e.attendeePersonIds.includes(p.id) && e.status !== 'cancelled')
        .toArray()
    ).sort((a, b) => b.startAt.localeCompare(a.startAt))[0]!;
    const was = new Date();
    vi.setSystemTime(new Date(new Date(ev.endAt).getTime() + 30 * 60_000));
    const n = await ingestNote(user, {
      text: `Great chat with ${p.displayName}. They recommended practicing system design. ${p.firstName} offered to intro me to their manager. I will send a thank-you by tomorrow.`,
      source: 'wispr_capture',
      personIds: [p.id],
    });
    vi.setSystemTime(was);
    expect(n.personIds).toEqual([p.id]);
    const fresh = (await db.chats.get(chat.id))!;
    expect(fresh.stage).toBe('completed');
    const facts = await db.facts.where('personId').equals(p.id).toArray();
    expect(facts.some((f) => f.type === 'offer')).toBe(true);
  });
  it('reach: finds paths and company routes', { timeout: 30_000 }, async () => {
    const edges = await db.edges.where('userId').equals(user.id).count();
    expect(edges).toBeGreaterThan(10);
    const people = await db.people.where('userId').equals(user.id).toArray();
    const weak = people.filter((p) => p.strength < 0.05).sort((a, b) => a.strength - b.strength);
    let found = false;
    for (const t of weak.slice(0, 40)) {
      const paths = await reachPerson(user.id, t.id);
      if (paths.length && paths[0]!.hops.length > 1) {
        found = true;
        expect(paths[0]!.hops.every((h) => h.text.length > 0)).toBe(true);
        break;
      }
    }
    expect(found).toBe(true);
    const c = await reachCompany(user.id, 'Stripe');
    expect(c.org?.name).toBe('Stripe');
    expect(c.direct.length).toBeGreaterThan(0);
  });
  it('linkedin csv import is idempotent and resolves to existing people', { timeout: 30_000 }, async () => {
    const existing = (await db.people
      .where('userId')
      .equals(user.id)
      .filter((p) => !!p.linkedinUrl)
      .first())!;
    const before = await db.people.where('userId').equals(user.id).count();
    const csv = `Notes:\n"x"\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\n${existing.firstName},${existing.lastName},${existing.linkedinUrl},,${existing.currentOrganizationRaw},${existing.currentTitle},01 Jan 2024\nNew,Person,https://www.linkedin.com/in/new-person-xyz,,Acme Corp,Analyst,02 Feb 2024\n`;
    const r = await importConnectionsCsv(user, csv);
    expect(r.imported).toBe(1);
    expect(r.updated).toBe(1);
    const after = await db.people.where('userId').equals(user.id).count();
    expect(after).toBe(before + 1);
    const r2 = await importConnectionsCsv(user, csv);
    expect(r2.imported).toBe(0);
  });
});
