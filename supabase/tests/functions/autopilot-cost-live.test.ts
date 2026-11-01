/**
 * A live check of what an autopilot day costs (plan 29 §C3: under $0.10 a student-day), run by hand and never in CI:
 * the real plan step, the real compose and voice gate against the real Claude API, on a full morning (three first
 * messages, the cap) and one reply to a yes, priced from the usage ledger the way the budget counts it.
 *
 *   ORBIT_COST_LIVE=1 ANTHROPIC_API_KEY=… pnpm --filter @orbit/supabase-tests exec vitest run functions/autopilot-cost-live.test.ts
 *
 * Skipped unless ORBIT_COST_LIVE is set. The key is read from the environment only and never written anywhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAutopilotPlan } from '../../functions/_shared/autopilot/plan.ts';
import { composeDraft } from '../../functions/_shared/compose/compose.ts';
import { vec } from '../../functions/_shared/rows.ts';
import { sendDraft } from '../../functions/_shared/sending/send.ts';
import { makeServices } from '../../functions/_shared/services.ts';
import {
  addPerson,
  addThread,
  agentConfig,
  fakeEmbed,
  fakeNet,
  jsonRes,
  type NetCall,
  signedInUser,
} from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

const LIVE = !!process.env.ORBIT_COST_LIVE && !!process.env.ANTHROPIC_API_KEY;
const NOW = new Date('2026-10-13T16:00:00Z');
const MORNING = new Date('2026-10-14T12:00:00.000Z');
const TARGETS = ['Ramp', 'Figma', 'Linear', 'Notion', 'Stripe'];
// the classifier's mean cost per inbound email on the live account, and a heavy day's inbound mail
const CLASSIFY_USD = 0.00007;
const INBOUND_PER_DAY = 60;

/** Anthropic answered by the real API with the request as the server built it; Gmail answered by a fake. */
function liveNet() {
  let n = 0;
  return fakeNet(
    (c: NetCall) =>
      c.url.startsWith('https://api.anthropic.com/')
        ? fetch(c.url, { method: c.method, headers: c.headers, body: JSON.stringify(c.body) })
        : undefined,
    (c: NetCall) => {
      if (c.url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
        n++;
        return jsonRes(200, { id: `gm-${n}`, threadId: `gt-${n}` });
      }
      if (c.url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/threads/'))
        return jsonRes(200, { messages: [] });
      return undefined;
    },
  );
}

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

describe.skipIf(!LIVE)('an autopilot day against the real API (plan 29 §C3)', () => {
  it('costs under $0.10 a student-day', async () => {
    const env = { anthropicKey: process.env.ANTHROPIC_API_KEY! };
    const net = liveNet();
    const s = makeServices(agentConfig(net, env), { db: t.db, now: () => NOW });
    const { userId } = await signedInUser(t, {
      settings: { autopilot_mode: 'autopilot', weekly_target: 12 },
    });
    await t.db.sql`update orbit.users set autonomy_level = 2 where id = ${userId}::uuid`;
    await t.db.sql`
      insert into orbit.goals (user_id, kind, title, targets)
      values (${userId}::uuid, 'recruiting', 'PM internships', ${{ organizations: TARGETS, roles: ['PM intern'], geographies: [], people: [] }}::jsonb)`;

    // the student's own sent mail, for the voice gate's exemplars
    const old = await addPerson(t, userId, { name: 'Old Friend', email: 'old@example.com' });
    const mine = [
      'Hi Lena,\n\nThanks again for the time on Thursday. The part about how your team picks intern projects stuck with me, and I tried the exercise you mentioned over the weekend.\n\nBest,\nSam',
      'Hi Omar,\n\nI saw the post about the new design tooling work and wanted to say it was great to read. I would love to hear how the team decided where to start when you have a few minutes.\n\nBest,\nSam',
    ];
    const th = await addThread(
      t,
      userId,
      old,
      mine.map((body, i) => ({
        direction: 'out' as const,
        at: new Date(NOW.getTime() - (40 + i) * 86_400_000).toISOString(),
        body,
      })),
    );
    for (const [i, id] of th.messageIds.entries())
      await t.db
        .sql`update orbit.messages set embedding = ${vec(await fakeEmbed(mine[i]!))}::vector where id = ${id}::uuid`;

    // twenty first messages sent unchanged: the rung is earned, so each of the morning's goes through the voice gate
    const { messageHash } = await import('@orbit/core/safety/rules');
    const past = await addPerson(t, userId, { name: 'Rung Past', email: 'past@example.com' });
    for (let i = 0; i < 20; i++) {
      const body = `Hi number ${i}`;
      const hash = messageHash({ channel: 'gmail', subject: null, body });
      const [x] = await t.db.sql<{ id: string }>`
        insert into orbit.drafts (user_id, person_id, channel, kind, body, status, sent_at)
        values (${userId}::uuid, ${past}::uuid, 'gmail', 'first_touch', ${body}, 'sent', ${new Date(NOW.getTime() - 30 * 86_400_000)}::timestamptz)
        returning id`;
      await t.db.sql`
        insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
        values (${userId}::uuid, 'agent', 'draft.compose', 'drafts', ${x!.id}, ${{ hash }}::jsonb),
               (${userId}::uuid, 'user', 'draft.approve', 'drafts', ${x!.id}, ${{ hash }}::jsonb)`;
    }

    // three alumni at three firms, each with something researched to open with: a full morning
    const people = [
      [
        'Ann Ames',
        'Ramp',
        'moved to Ramp from a seed fintech last spring and now runs the card controls team',
      ],
      ['Bo Banks', 'Figma', 'wrote about how Figma plans multiplayer features with designers in the room'],
      ['Cleo Cruz', 'Linear', 'joined Linear as its second PM and talked about shipping weekly on a podcast'],
    ] as const;
    for (const [name, org, fact] of people) {
      const id = await addPerson(t, userId, {
        name,
        org,
        title: 'Product Manager',
        email: `${name.split(' ')[0]!.toLowerCase()}@${org.toLowerCase()}.com`,
        score: 70,
      });
      await t.db.sql`update orbit.people set is_alumni = true where id = ${id}::uuid`;
      await t.db.sql`
        insert into orbit.facts (user_id, person_id, type, text)
        values (${userId}::uuid, ${id}::uuid, 'career', ${`${name.split(' ')[0]} ${fact}`})`;
    }
    const plan = await runAutopilotPlan(s, userId);
    expect(plan.queued).toBe(3);

    // a yes that came in: the reply with three times
    const maya = await addPerson(t, userId, {
      name: 'Maya Chen',
      org: 'Stripe',
      title: 'Product Manager',
      email: 'maya@stripe.com',
      score: 75,
    });
    const yes = await addThread(t, userId, maya, [
      {
        direction: 'out',
        at: new Date(NOW.getTime() - 3 * 86_400_000).toISOString(),
        body: 'Hi Maya,\n\nI am a junior looking at PM internships and loved your talk on payments infra. Would you have 15 minutes for a call?\n\nThanks,\nSam',
      },
      {
        direction: 'in',
        at: new Date(NOW.getTime() - 3_600_000).toISOString(),
        body: 'Hi Sam, happy to chat. Send me a few times that work next week.\n\nMaya',
        replyClass: 'interested',
      },
    ]);
    await composeDraft(s, {
      userId,
      personId: maya,
      kind: 'reply',
      channel: 'gmail',
      replyToMessageId: yes.messageIds[1]!,
    });

    // the morning: each first message passes the voice gate before it goes
    const morning = makeServices(agentConfig(net, env), { db: t.db, now: () => MORNING });
    const drafts = await t.db.sql<{ id: string }>`
      select id from orbit.drafts where user_id = ${userId}::uuid and auto_rung = 'first_touch'`;
    const sent = [];
    for (const d of drafts) sent.push((await sendDraft(morning, d.id)).status);

    const rows = await t.db.sql<{ operation: string; n: number; usd: string }>`
      select operation, count(*)::int as n, sum(cost_usd)::text as usd
        from orbit.usage_ledger where user_id = ${userId}::uuid group by operation order by operation`;
    const models = rows.reduce((a, r) => a + Number(r.usd), 0);
    const classify = CLASSIFY_USD * INBOUND_PER_DAY;
    const day = models + classify;
    console.log(
      [
        ...rows.map((r) => `${r.operation}\t${r.n} calls\t$${Number(r.usd).toFixed(4)}`),
        `classify (estimated)\t${INBOUND_PER_DAY} emails\t$${classify.toFixed(4)}`,
        `sends\t${sent.join(', ')}`,
        `day\t$${day.toFixed(4)}`,
      ].join('\n'),
    );
    expect(day).toBeLessThan(0.1);
  }, 300_000);
});
