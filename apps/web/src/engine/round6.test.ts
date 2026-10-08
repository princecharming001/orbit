import type { User } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { generateBrief } from './brief';
import { loadDemo } from './demo';

const NOW = new Date('2026-10-06T10:00:00');
const DAY = 86_400_000;
let user: User;
beforeAll(async () => {
  user = await loadDemo({ reset: true, now: NOW });
}, 60_000);

const lenaThanks = async () => {
  const lena = (await db.people.toArray()).find((p) => p.displayName === 'Lena Novak')!;
  const s = (await db.suggestions.where('personId').equals(lena.id).toArray()).find(
    (x) => x.kind === 'thank_you' && x.status === 'pending',
  )!;
  return (await db.outbound.get(s.outboundMessageId!))!;
};

describe('usability round 6 (engine)', () => {
  it('a thank-you that said "yesterday" says the day once a day has passed, and keeps the student\'s edits', async () => {
    const d = await lenaThanks();
    expect(d.bodyDraft).toMatch(/making time yesterday/);
    // edited by the student: only the day word changes
    await db.outbound.update(d.id, { bodyFinal: `${d.bodyDraft}\n\nP.S. MYEDIT` });
    await generateBrief(user, 'daily', new Date(NOW.getTime() + DAY));
    const edited = await lenaThanks();
    expect(edited.bodyFinal).toMatch(/making time on Monday/);
    expect(edited.bodyFinal).toMatch(/MYEDIT/);
    // untouched: rewritten with the day's words
    await db.outbound.update(d.id, { bodyFinal: undefined });
    await generateBrief(user, 'daily', new Date(NOW.getTime() + 2 * DAY));
    const fresh = await lenaThanks();
    expect(fresh.bodyDraft).toMatch(/making time on Monday/);
    expect(fresh.bodyDraft).not.toMatch(/yesterday/);
  });
});

describe('usability round 6: a chat moved on by hand counts for the relationship', () => {
  it('someone who replied, met and was thanked is no longer a cold contact, and undo takes it back', async () => {
    const { addPersonByHand } = await import('./people');
    const { startWarmUpOrOutreach } = await import('./brief');
    const { approveAndSend, confirmHandoff } = await import('./send');
    const { applyStage } = await import('./stages');
    const { describeUserTie, strengthTier } = await import('@orbit/core');
    const r = (await addPersonByHand(user.id, {
      name: 'Aisha Okoro',
      company: 'Goldman Sachs',
      linkedinUrl: 'https://www.linkedin.com/in/aisha-okoro-gs',
    }))!;
    const s = await startWarmUpOrOutreach(user, r.person.id, 'linkedin', 'manual', { skipWarmUp: true });
    const body = s.draft!.bodyDraft.replace(/\[[^\]]+\]/g, 'We met at the Ross finance night.');
    expect((await approveAndSend(user, s.draft!.id, body)).ok).toBe(true);
    expect((await confirmHandoff(user, s.draft!.id)).ok).toBe(true);
    const chat = () =>
      db.chats
        .where('personId')
        .equals(r.person.id)
        .first()
        .then((c) => c!);
    const later = new Date(NOW.getTime() + 2 * 3_600_000);
    expect(await applyStage(await chat(), 'replied', 'user', 'user:move', { now: later })).toBe('applied');
    expect(describeUserTie((await db.people.get(r.person.id))!, later)).not.toMatch(/haven't heard back/);
    await applyStage(await chat(), 'scheduled', 'user', 'user:move', { now: later });
    await applyStage(await chat(), 'completed', 'user', 'user:move', { now: later });
    await applyStage(await chat(), 'followed_up', 'user', 'user:move', { now: later });
    const met = (await db.people.get(r.person.id))!;
    expect(strengthTier(met.strength)).not.toBe('weak');
    // moved back to "first message sent": what the move said happened is taken back
    await applyStage(await chat(), 'outreach_sent', 'user', 'user:undo', { now: later });
    const back = (await db.people.get(r.person.id))!;
    expect(strengthTier(back.strength)).toBe('weak');
  });
});

describe('usability round 6: "I sent it" can be taken back', () => {
  it('puts the message, the chat and the cards back as they were', async () => {
    const { addPersonByHand } = await import('./people');
    const { draftMessage } = await import('./brief');
    const { approveAndSend, confirmHandoff, restorePerson, snapshotPerson } = await import('./send');
    const r = (await addPersonByHand(user.id, {
      name: 'Dana Whit',
      company: 'Lazard',
      email: 'dana@lazard.com',
    }))!;
    const d = await draftMessage(user, r.person.id, 'outreach', 'gmail', null);
    const body = d.bodyDraft.replace(/\[[^\]]+\]/g, 'We met at the Ross finance night.');
    expect((await approveAndSend(user, d.id, body, d.subject)).ok).toBe(true);
    const before = await snapshotPerson(user.id, r.person.id);
    expect((await confirmHandoff(user, d.id)).ok).toBe(true);
    expect((await db.outbound.get(d.id))!.status).toBe('sent');
    expect(await db.chats.where('personId').equals(r.person.id).count()).toBe(1);
    await restorePerson(user.id, before);
    expect((await db.outbound.get(d.id))!.status).toBe('handed_off');
    expect(await db.chats.where('personId').equals(r.person.id).count()).toBe(0);
    expect(
      await db.touchpoints
        .where('personId')
        .equals(r.person.id)
        .filter((t) => t.kind === 'email_out')
        .count(),
    ).toBe(0);
  });
});
