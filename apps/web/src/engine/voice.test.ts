/**
 * The voice in the browser (plan 29 §B2.4): an edited send kept as a typed row, every tenth send learning the card,
 * local mode's notes read from the edits without a model and never relearned once forgotten, and the check before
 * this browser sends anything on its own.
 */
import type { OutboundMessage, User } from '@orbit/core';
import { newId } from '@orbit/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/schema';
import { loadDemo } from './demo';
import { approveAndSend, confirmHandoff } from './send';
import { checkBeforeAutoSend, decideNote, distillLocal, noteSendForVoice, readVoice } from './voice';

const ORBIT_WROTE =
  "Hi Dana,\n\nI'm a junior at Cornell and would love to hear how you got to Stripe. Would you be open to a quick call next week? Thanks either way.\n\nBest,\nAlex";
const SENT =
  "Hi Dana,\n\nI'm a junior at Cornell and would love to hear how you got to Stripe. Would you be open to a call next week?\n\nThanks,\nAlex";

let user: User;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-10-06T14:00:00'));
  user = await loadDemo({ reset: true });
  vi.useRealTimers();
}, 60_000);

async function aDraft(body = ORBIT_WROTE): Promise<OutboundMessage> {
  const p = (await db.people
    .where('userId')
    .equals(user.id)
    .filter((x) => !!x.primaryEmail && x.isHuman)
    .first())!;
  const d: OutboundMessage = {
    id: newId('out'),
    userId: user.id,
    personId: p.id,
    channel: 'gmail',
    kind: 'bump',
    toEmail: p.primaryEmail,
    subject: 'Quick question',
    bodyDraft: body,
    status: 'draft',
    generatedBy: 'template',
    createdAt: new Date().toISOString(),
  };
  await db.outbound.add(d);
  return d;
}

describe('an edited send, typed', () => {
  it('writes one draftEdits row with what Orbit wrote and what went, and none for an unedited send', async () => {
    const d = await aDraft();
    expect((await approveAndSend(user, d.id, SENT, d.subject)).ok).toBe(true);
    expect((await confirmHandoff(user, d.id)).ok).toBe(true);
    const edits = await db.draftEdits.where('userId').equals(user.id).toArray();
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ draftId: d.id, kind: 'bump', before: ORBIT_WROTE.trim(), after: SENT });
    expect(edits[0]!.distance).toBeGreaterThan(3);
    const same = await aDraft();
    await approveAndSend(user, same.id, same.bodyDraft, same.subject);
    await confirmHandoff(user, same.id);
    expect(await db.draftEdits.where('userId').equals(user.id).count()).toBe(1);
  });

  it('learns the card again on every tenth send', async () => {
    await db.kv.put({ key: `voice.sends:${user.id}`, value: 8 });
    expect(await noteSendForVoice(user)).toBe(false);
    expect((await db.kv.get(`voice.sends:${user.id}`))?.value).toBe(9);
    await noteSendForVoice(user);
    expect((await db.kv.get(`voice.sends:${user.id}`))?.value).toBe(0);
  });
});

describe('notes in local mode', () => {
  async function edits(n: number) {
    for (let i = 0; i < n; i++)
      await db.draftEdits.add({
        id: newId('edit'),
        userId: user.id,
        kind: 'first_touch',
        before: `${ORBIT_WROTE} ${i}`,
        after: `${SENT} ${i}`,
        distance: 6,
        createdAt: new Date(Date.now() - i * 3_600_000).toISOString(),
      });
  }

  it('reads the edits as plain observations without a key, and a forgotten note never comes back', async () => {
    await edits(3);
    const first = await distillLocal(user);
    expect(first.by).toBe('observations');
    const view = await readVoice(user);
    expect(view.mode).toBe('local');
    expect(view.edits).toBe(3);
    const note = view.notes.find((n) => n.text.startsWith("You cut 'Thanks either way'"))!;
    expect(note).toBeDefined();
    expect(view.cardProse.join(' ')).not.toMatch(/[!–—]/);
    expect((await decideNote(user.id, note.id, 'forget')).ok).toBe(true);
    await edits(2);
    await distillLocal(user);
    const after = await readVoice(user);
    expect(after.notes.some((n) => /Thanks either way/.test(n.text))).toBe(false);
    const stored = (await db.settings.get(user.id))!.voiceNotes!;
    expect(stored.find((n) => n.id === note.id)!.forgottenAt).toBeTruthy();
  });
});

describe('the check before this browser sends on its own', () => {
  it('holds a draft with a phrase the student never says, with an audit row', async () => {
    const style = await db.styles.get(user.id);
    if (style) await db.styles.put({ ...style, card: { ...style.card, avoid: ['circle back'] } });
    else
      await db.styles.put({
        userId: user.id,
        updatedAt: new Date().toISOString(),
        card: { ...(await import('@orbit/core')).defaultStyleCard('warm', 'Alex'), avoid: ['circle back'] },
      });
    const d = await aDraft(
      'Hi Dana,\n\nJust wanted to circle back on my note from last week.\n\nBest,\nAlex',
    );
    const r = await checkBeforeAutoSend(user, d);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.code)).toContain('avoid');
    const hold = (await db.audit.where('userId').equals(user.id).toArray()).find(
      (a) => a.action === 'draft.hold',
    );
    expect(hold?.metadata).toMatchObject({ reason: 'voice', text: "didn't sound like you" });
  });
});
