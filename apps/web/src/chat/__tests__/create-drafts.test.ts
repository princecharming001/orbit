/** create_drafts: one draft per person at once, with the people it skipped named, and nothing sent. */
import type { User } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db/schema';
import { loadDemo } from '../../engine/demo';
import { clearPrefs } from '../../integrations/prefs';
import { execute } from '../registry';
import { readDrafts, readSkipped } from '../ui/cards/shapes';
import { makeCtx, NOW } from './helpers';

let user: User;
beforeAll(async () => {
  await clearPrefs();
  user = await loadDemo({ reset: true, now: NOW });
}, 90_000);

describe('create_drafts', () => {
  it('drafts for each person, reopens rather than duplicates, and sends nothing', async () => {
    const people = await db.people.where('userId').equals(user.id).toArray();
    const chats = await db.chats.where('userId').equals(user.id).toArray();
    const fresh = people
      .filter((p) => p.isHuman && !p.hiddenAt && p.primaryEmail && !chats.some((c) => c.personId === p.id))
      .slice(0, 3);
    expect(fresh.length).toBe(3);
    const before = await db.outbound.where('userId').equals(user.id).count();
    const env = await execute('create_drafts', { personIds: fresh.map((p) => p.id) }, makeCtx(user));
    expect(env.kind, env.summary).toBe('drafts');
    const rows = readDrafts(env.data);
    expect(rows.length + readSkipped(env.data).length).toBe(3);
    expect(rows.length).toBeGreaterThan(0);
    expect(env.summary).toMatch(/^Drafted /);
    expect(env.summary).toMatch(/Nothing is sent until approved\.$/);
    // the preview is the message, not its greeting
    for (const r of rows) expect(r.text).not.toMatch(/^(Hi|Hey|Hello|Dear)\b[^.!?]{0,40},?$/);
    const after = await db.outbound.where('userId').equals(user.id).toArray();
    expect(after.length).toBe(before + rows.length);
    // nothing went out: every new one is a draft
    const ids = new Set(rows.map((r) => r.id));
    expect(after.filter((o) => ids.has(o.id)).every((o) => o.status === 'draft')).toBe(true);
    // asking again reopens the same drafts
    const again = await execute('create_drafts', { personIds: fresh.map((p) => p.id) }, makeCtx(user));
    expect(readDrafts(again.data).map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(await db.outbound.where('userId').equals(user.id).count()).toBe(after.length);
  });

  it('names a hidden person instead of writing to them', async () => {
    const people = await db.people.where('userId').equals(user.id).toArray();
    const p = people.find((x) => x.isHuman && !x.hiddenAt)!;
    await db.people.update(p.id, { hiddenAt: NOW.toISOString() });
    const env = await execute('create_drafts', { personIds: [p.id] }, makeCtx(user));
    expect(readSkipped(env.data)).toEqual([{ name: p.displayName, why: 'hidden' }]);
    expect(env.summary).toMatch(/^No drafts written\. Skipped /);
    await db.people.update(p.id, { hiddenAt: undefined });
  });
});
