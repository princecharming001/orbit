/**
 * First messages on autopilot (plan 29 §B2.2, §B4, §B6, §C1 phase 5): the first-message rung as the server counts it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { autopilotStatus, firstTouchRungOf } from '../../functions/_shared/autopilot/autopilot.ts';
import { composeDraft } from '../../functions/_shared/compose/compose.ts';
import { makeServices } from '../../functions/_shared/services.ts';
import {
  addPerson,
  agentConfig,
  api,
  fakeNet,
  jsonRes,
  type NetCall,
  signedInUser,
} from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

// Tuesday 13 October 2026, 16:00 UTC: noon in New York
const NOW = new Date('2026-10-13T16:00:00Z');
const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

function gmail() {
  let n = 0;
  return (c: NetCall) => {
    if (c.url === GMAIL_SEND) {
      n++;
      return jsonRes(200, { id: `gm-${n}`, threadId: `gt-${n}` });
    }
    if (c.url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/threads/'))
      return jsonRes(200, { messages: [] });
    return undefined;
  };
}

/** The voice phase's table, when its migration is in: an edited approval has a row there. */
async function recordEdit(userId: string, draftId: string, before: string, after: string) {
  const [x] = await t.db.sql<{ has: boolean }>`select to_regclass('orbit.draft_edits') is not null as has`;
  if (!x?.has) return;
  await t.db.sql`
    insert into orbit.draft_edits (user_id, draft_id, kind, before, after, distance)
    values (${userId}::uuid, ${draftId}::uuid, 'first_touch', ${before}, ${after}, 3)`;
}

describe('the first-message rung on the server (plan 29 §B2.2)', () => {
  it('counts first messages the student approved and sent with the words Orbit wrote, never an edited one', async () => {
    const net = fakeNet(gmail());
    const s = makeServices(agentConfig(net, {}), { db: t.db, now: () => NOW });
    const call = api(t, net, { env: {}, now: () => NOW });
    const { userId, token } = await signedInUser(t);
    expect(await firstTouchRungOf(t.db, userId)).toEqual({ unchanged: 0, needed: 20, earned: false });
    const names = ['Ada One', 'Ben Two', 'Cy Three'];
    const ids: string[] = [];
    for (const name of names) {
      const p = await addPerson(t, userId, {
        name,
        email: `${name.split(' ')[0]!.toLowerCase()}@example.com`,
        title: 'Engineer',
        org: 'Ramp',
      });
      const { draft } = await composeDraft(s, { userId, personId: p, kind: 'first_touch', channel: 'gmail' });
      ids.push(draft.id);
    }
    // the second one the student rewrites before approving it
    const edited = `${(await t.db.sql<{ body: string }>`select body from orbit.drafts where id = ${ids[1]}::uuid`)[0]!.body}\n\nP.S. One more line.`;
    await t.db.sql`update orbit.drafts set body = ${edited} where id = ${ids[1]}::uuid`;
    await recordEdit(userId, ids[1]!, 'before', edited);
    for (const id of ids) {
      const r = await call<{ draft: { status: string } }>('/drafts/approve', token, { draftId: id });
      expect(r.status).toBe(200);
    }
    const sent = await t.db.sql<{ status: string }>`
      select status from orbit.drafts where id = any(${ids}::uuid[])`;
    expect(sent.map((x) => x.status)).toEqual(['sent', 'sent', 'sent']);
    expect(await firstTouchRungOf(t.db, userId)).toEqual({ unchanged: 2, needed: 20, earned: false });
    const status = await autopilotStatus(t.db, userId, NOW);
    expect(status.rungs.find((r) => r.kind === 'first_touch')).toEqual({
      kind: 'first_touch',
      needed: 20,
      unchanged: 2,
      unlocked: false,
    });
  });

  it('is earned at twenty, and an autopilot first message in the batch then shows as queued, not waiting for a tap', async () => {
    const { userId } = await signedInUser(t);
    const p = await addPerson(t, userId, { name: 'Dee Four', email: 'dee@example.com', org: 'Ramp' });
    const [d] = await t.db.sql<{ id: string }>`
      insert into orbit.drafts (user_id, person_id, channel, kind, body, status, send_at, review_until, auto_rung,
                                autonomy_level)
      values (${userId}::uuid, ${p}::uuid, 'gmail', 'first_touch', 'Hi Dee', 'approved',
              ${new Date(NOW.getTime() + 20 * 3_600_000)}::timestamptz, ${new Date(NOW.getTime() + 20 * 3_600_000)}::timestamptz,
              'first_touch', 2)
      returning id`;
    const before = await autopilotStatus(t.db, userId, NOW);
    expect(before.queued).toEqual([expect.objectContaining({ draftId: d!.id, status: 'needs_tap' })]);
    // twenty first messages that went out unchanged on the student's own approval
    for (let i = 0; i < 20; i++) {
      const body = `Hi number ${i}`;
      const hash = (await import('@orbit/core/safety/rules')).messageHash({
        channel: 'gmail',
        subject: null,
        body,
      });
      const [x] = await t.db.sql<{ id: string }>`
        insert into orbit.drafts (user_id, person_id, channel, kind, body, status, sent_at)
        values (${userId}::uuid, ${p}::uuid, 'gmail', ${i % 2 ? 'outreach' : 'warm_first_touch'}, ${body}, 'sent', ${NOW}::timestamptz)
        returning id`;
      await t.db.sql`
        insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
        values (${userId}::uuid, 'agent', 'draft.compose', 'drafts', ${x!.id}, ${{ hash }}::jsonb),
               (${userId}::uuid, 'user', 'draft.approve', 'drafts', ${x!.id}, ${{ hash }}::jsonb)`;
    }
    expect(await firstTouchRungOf(t.db, userId)).toEqual({ unchanged: 20, needed: 20, earned: true });
    const after = await autopilotStatus(t.db, userId, NOW);
    expect(after.queued).toEqual([expect.objectContaining({ draftId: d!.id, status: 'queued' })]);
    expect(after.rungs.find((r) => r.kind === 'first_touch')?.unlocked).toBe(true);
    expect(after.reviewUntil).toBe(new Date(NOW.getTime() + 12 * 3_600_000).toISOString());
  });
});
