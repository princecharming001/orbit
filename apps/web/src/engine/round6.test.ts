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
