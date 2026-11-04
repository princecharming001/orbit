/**
 * First messages on autopilot (plan 29 §B2.2, §B4, §B6, §C1 phase 5): the first-message rung as the server counts it,
 * the plan step that queues the morning's first messages behind the evening review, and the batch card.
 */
import { ASK_RULES } from '@orbit/core/knowledge/index';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { autopilotStatus, firstTouchRungOf } from '../../functions/_shared/autopilot/autopilot.ts';
import { raiseBatchCard, runAutopilotPlan } from '../../functions/_shared/autopilot/plan.ts';
import { runCadence } from '../../functions/_shared/cadence/cadence.ts';
import { composeDraft } from '../../functions/_shared/compose/compose.ts';
import { refreshFriendShares } from '../../functions/_shared/friends/shares.ts';
import { goalPaused, setGoalPause } from '../../functions/_shared/replies/breaker.ts';
import { maybeAutoReply } from '../../functions/_shared/replies/replies.ts';
import { vec } from '../../functions/_shared/rows.ts';
import { sendDraft } from '../../functions/_shared/sending/send.ts';
import { makeServices } from '../../functions/_shared/services.ts';
import {
  ALL_KEYS,
  addPerson,
  addThread,
  agentConfig,
  anthropic,
  api,
  fakeEmbed,
  fakeNet,
  jsonRes,
  type NetCall,
  type PersonSeed,
  signedInUser,
  systemText,
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

// Wednesday 14 October, 8:00 in New York (no jitter in the tests): the morning the plan writes for
const MORNING = '2026-10-14T12:00:00.000Z';
const TARGETS = ['Ramp', 'Figma', 'Linear', 'Notion', 'Stripe'];

/** A student on autopilot with one recruiting goal at five companies and room in the week. */
async function onAutopilot(over: { weekly?: number; mode?: string } = {}) {
  const { userId, token } = await signedInUser(t, {
    settings: { autopilot_mode: over.mode ?? 'autopilot', weekly_target: over.weekly ?? 12 },
  });
  await t.db
    .sql`update orbit.users set autonomy_level = ${over.mode === 'assist' ? 1 : 2} where id = ${userId}::uuid`;
  const [g] = await t.db.sql<{ id: string }>`
    insert into orbit.goals (user_id, kind, title, targets)
    values (${userId}::uuid, 'recruiting', 'PM internships', ${{ organizations: TARGETS, roles: ['PM intern'], geographies: [], people: [] }}::jsonb)
    returning id`;
  return { userId, token, goalId: g!.id };
}

/** A person with an address and something researched to open with, unless told otherwise. */
async function contact(
  userId: string,
  p: PersonSeed & { alum?: boolean; headline?: string; hook?: boolean; hidden?: boolean; private?: boolean },
) {
  const id = await addPerson(t, userId, {
    email: `${p.name.split(' ')[0]!.toLowerCase()}@${(p.org ?? 'x').toLowerCase()}.com`,
    title: 'Product Manager',
    ...p,
  });
  await t.db.sql`
    update orbit.people set is_alumni = ${p.alum ?? false}, headline = ${p.headline ?? null},
           hidden_at = ${p.hidden ? NOW : null}::timestamptz, private = ${p.private ?? false}
     where id = ${id}::uuid`;
  if (p.hook !== false)
    await t.db.sql`
      insert into orbit.facts (user_id, person_id, type, text)
      values (${userId}::uuid, ${id}::uuid, 'career', ${`${p.name.split(' ')[0]} moved to ${p.org} from a seed startup last spring`})`;
  return id;
}

/** Twenty first messages that went out unchanged on the student's own approval: the rung, earned. */
async function earnRung(userId: string) {
  const p = await addPerson(t, userId, { name: 'Rung Past', email: 'past@example.com' });
  const { messageHash } = await import('@orbit/core/safety/rules');
  for (let i = 0; i < 20; i++) {
    const body = `Hi number ${i}`;
    const hash = messageHash({ channel: 'gmail', subject: null, body });
    const [x] = await t.db.sql<{ id: string }>`
      insert into orbit.drafts (user_id, person_id, channel, kind, body, status, sent_at)
      values (${userId}::uuid, ${p}::uuid, 'gmail', 'first_touch', ${body}, 'sent', ${new Date(NOW.getTime() - 30 * 86_400_000)}::timestamptz)
      returning id`;
    await t.db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${userId}::uuid, 'agent', 'draft.compose', 'drafts', ${x!.id}, ${{ hash }}::jsonb),
             (${userId}::uuid, 'user', 'draft.approve', 'drafts', ${x!.id}, ${{ hash }}::jsonb)`;
  }
}

/** Two emails the student wrote, embedded the way the Gmail ingest embeds sent mail: the voice gate's exemplars. */
async function soundsLikeThem(userId: string) {
  const friend = await addPerson(t, userId, { name: 'Old Friend', email: 'old@example.com' });
  const bodies = [
    'Hi Lena,\n\nThanks again for the time on Thursday. The part about how your team picks intern projects stuck with me, and I tried the exercise you mentioned over the weekend.\n\nBest,\nSam',
    'Hi Omar,\n\nI saw the post about the new design tooling work and wanted to say it was great to read. I would love to hear how the team decided where to start when you have a few minutes.\n\nBest,\nSam',
  ];
  const th = await addThread(
    t,
    userId,
    friend,
    bodies.map((body, i) => ({
      direction: 'out' as const,
      at: new Date(NOW.getTime() - (40 + i) * 86_400_000).toISOString(),
      body,
    })),
  );
  for (const [i, id] of th.messageIds.entries())
    await t.db
      .sql`update orbit.messages set embedding = ${vec(await fakeEmbed(bodies[i]!))}::vector where id = ${id}::uuid`;
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

describe('the plan step (plan 29 §B4, §B6)', () => {
  it('queues within the caps and only to allowed candidates, each with the rule that left the others out', async () => {
    const net = fakeNet(gmail());
    const s = makeServices(agentConfig(net, {}), { db: t.db, now: () => NOW });
    const { userId } = await onAutopilot();
    const ids: Record<string, string> = {};
    const add = async (key: string, p: Parameters<typeof contact>[1]) => {
      ids[key] = await contact(userId, p);
    };
    await add('ada', { name: 'Ada Alum', org: 'Ramp', alum: true, score: 10 });
    await add('oz', { name: 'Oz Second', org: 'Ramp', score: 65 });
    await add('cal', { name: 'Cal Close', org: 'Figma', score: 70 });
    await add('ben', { name: 'Ben Close', org: 'Figma', score: 60 });
    await add('nia', { name: 'Nia Warm', org: 'Linear', score: 55 });
    await add('pat', { name: 'Pat Late', org: 'Stripe', score: 45 });
    await add('dee', { name: 'Dee Hire', org: 'Linear', score: 80, title: 'University Recruiter' });
    await add('eve', { name: 'Eve Prof', org: 'Notion', score: 80, title: 'Professor of Computer Science' });
    await add('fay', {
      name: 'Fay Teen',
      org: 'Notion',
      score: 80,
      title: '',
      headline: 'High school senior',
    });
    await add('gus', { name: 'Gus Far', org: 'Linear', score: 20 });
    await add('hal', { name: 'Hal Plain', org: 'Linear', score: 50, hook: false });
    await add('ivy', { name: 'Ivy Elsewhere', org: 'Acme', score: 90 });
    await add('jo', { name: 'Jo Hidden', org: 'Linear', score: 90, hidden: true });
    await add('lou', { name: 'Lou Private', org: 'Linear', score: 90, private: true });
    await add('max', { name: 'Max Stop', org: 'Notion', score: 90, doNotContact: true });
    await add('kim', { name: 'Kim Written', org: 'Notion', score: 75 });
    await addThread(t, userId, ids.kim!, [
      { direction: 'out', at: new Date(NOW.getTime() - 9 * 86_400_000).toISOString(), body: 'Hi Kim' },
    ]);

    const summary = await runCadence(s, userId);
    expect(summary.plan).toMatchObject({ goals: 1, queued: 3, asks: 0, held: 0 });
    const drafts = await t.db.sql<{
      person_id: string;
      kind: string;
      status: string;
      auto_rung: string;
      send_at: Date;
      review_until: Date;
      autonomy_level: number;
    }>`
      select person_id, kind, status, auto_rung, send_at, review_until, autonomy_level from orbit.drafts
       where user_id = ${userId}::uuid and auto_rung = 'first_touch' order by send_at, person_id`;
    // alumni first, then the closest at each firm, never two at one firm, three in all: the daily cap
    expect(new Set(drafts.map((d) => d.person_id))).toEqual(new Set([ids.ada, ids.cal, ids.nia]));
    for (const d of drafts) {
      expect(d).toMatchObject({ status: 'approved', auto_rung: 'first_touch', autonomy_level: 2 });
      expect(new Date(d.send_at).toISOString()).toBe(MORNING);
      // the review lasts until it goes
      expect(new Date(d.review_until).toISOString()).toBe(MORNING);
    }
    expect(drafts.find((d) => d.person_id === ids.ada)?.kind).toBe('first_touch');
    expect(drafts.find((d) => d.person_id === ids.cal)?.kind).toBe('warm_first_touch');
    // Orbit approved each with the words bound, for the morning
    const approvals = await t.db.sql<{ details: Record<string, unknown> }>`
      select details from orbit.audit_log where user_id = ${userId}::uuid and action = 'draft.auto_approve'`;
    expect(approvals).toHaveLength(3);
    for (const a of approvals)
      expect(a.details).toMatchObject({
        standing: 'autopilot_plan',
        rung: 'first_touch',
        review_until: MORNING,
      });
    // nothing to anyone the rules leave out
    const all = await t.db.sql<{ person_id: string }>`
      select person_id from orbit.drafts
       where user_id = ${userId}::uuid and kind in ('first_touch', 'warm_first_touch', 'outreach')`;
    for (const k of ['oz', 'ben', 'pat', 'dee', 'eve', 'fay', 'gus', 'hal', 'ivy', 'jo', 'lou', 'max', 'kim'])
      expect(all.map((d) => d.person_id)).not.toContain(ids[k]);
    // the status: tomorrow's batch waits for a tap (the rung is not earned), and every skip has its rule
    const status = await autopilotStatus(t.db, userId, NOW);
    expect(status.queued.map((q) => q.status)).toEqual(['needs_tap', 'needs_tap', 'needs_tap']);
    const rule = (name: string) => status.skipped?.find((x) => x.personName === name)?.rule;
    expect(rule('Oz Second')).toBe('same_firm_today');
    expect(rule('Ben Close')).toBe('same_firm_today');
    expect(rule('Pat Late')).toBe('daily_cap');
    expect(rule('Dee Hire')).toBe('recruiter');
    expect(rule('Eve Prof')).toBe('faculty');
    expect(rule('Fay Teen')).toBe('minor');
    expect(rule('Gus Far')).toBe('not_close');
    expect(rule('Hal Plain')).toBe('no_hook');
    expect(rule('Jo Hidden')).toBe('hidden');
    expect(rule('Lou Private')).toBe('private');
    expect(rule('Max Stop')).toBe('do_not_contact');
    expect(rule('Kim Written')).toBe('already_written');
    // someone at a company that is not on the goal is never weighed at all
    expect(rule('Ivy Elsewhere')).toBeUndefined();
    expect(status.skipped?.find((x) => x.personName === 'Dee Hire')?.reason).toBe(
      'Dee is a recruiter at Linear. Autopilot never writes a first message to a recruiter; that one is yours to send.',
    );
    for (const x of status.skipped ?? []) expect(x.reason).not.toMatch(/[–—!]/);

    // the next hour plans nothing more for that morning: the day is full and the people are taken
    const again = await runAutopilotPlan(s, userId);
    expect(again.queued).toBe(0);
    const [n] = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.drafts where user_id = ${userId}::uuid and auto_rung = 'first_touch'`;
    expect(n!.n).toBe(3);
  });

  it('stays within twelve a week across the mornings and the week target paces each day', async () => {
    const net = fakeNet(gmail());
    const s = makeServices(agentConfig(net, {}), { db: t.db, now: () => NOW });
    const { userId } = await onAutopilot({ weekly: 2 });
    const names = ['Ann Ames', 'Bo Banks', 'Cleo Cruz', 'Dev Dunn', 'Eli Erin'];
    for (const [i, org] of TARGETS.entries()) await contact(userId, { name: names[i]!, org, score: 60 });
    // the week wants two first messages and Wednesday and Thursday are left: one goes Wednesday
    const r = await runAutopilotPlan(s, userId);
    expect(r.queued).toBe(1);
    const status = await autopilotStatus(t.db, userId, NOW);
    expect(status.skipped?.filter((x) => x.rule === 'paced').length).toBe(4);
    expect(status.skipped?.find((x) => x.rule === 'paced')?.reason).toContain('share of your weekly target');
  });

  it('a friend route drafts the ask to the friend and nothing to the contact', async () => {
    const net = fakeNet(gmail());
    const s = makeServices(agentConfig(net, {}), { db: t.db, now: () => NOW });
    // the invite and the accept run on the real clock, the way the friends suite runs them
    const call = api(t, net, { env: {} });
    const maya = await onAutopilot();
    const ana = await signedInUser(t, { firstName: 'Ana' });
    const dan = await addPerson(t, ana.userId, {
      name: 'Dan Lee',
      title: 'Staff Engineer',
      org: 'Stripe',
      linkedinUrl: 'https://www.linkedin.com/in/dan-lee-stripe',
      email: 'dan@stripe.com',
      score: 85,
    });
    await t.db
      .sql`insert into orbit.tie_labels (user_id, person_id, closeness) values (${ana.userId}::uuid, ${dan}::uuid, 5)`;
    const inv = await call<{ code: string }>('/friends/invite', maya.token, { email: ana.email });
    const acc = await call('/friends/accept', ana.token, { code: inv.body.code, mode: 'all' });
    expect(acc.status).toBe(200);
    await refreshFriendShares(t.db, ana.userId, NOW);

    const r = await runAutopilotPlan(s, maya.userId);
    expect(r).toMatchObject({ asks: 1, queued: 0 });
    // nothing is drafted to Dan or anyone: Maya has no address and no standing with him
    const drafts = await t.db.sql`select id from orbit.drafts where user_id = ${maya.userId}::uuid`;
    expect(drafts).toEqual([]);
    const [card] = await t.db.sql<{ kind: string; payload: Record<string, unknown>; reason_text: string }>`
      select kind, payload, reason_text from orbit.suggestions where user_id = ${maya.userId}::uuid and kind = 'friend_ask_ready'`;
    expect(card!.payload).toMatchObject({
      friendUserId: ana.userId,
      targetPersonId: dan,
      targetName: 'Dan Lee',
      company: 'Stripe',
    });
    expect(String(card!.payload.note)).toContain("I'd love 15 minutes");
    expect(card!.reason_text).toBe(
      'Ana knows Dan Lee at Stripe. Ask Ana for the intro? Your note is ready for Ana to forward, and nothing goes to Dan from you.',
    );
    expect(JSON.stringify(card)).not.toContain('dan@stripe.com');
    // the status lists it; asking Ana through /friends/asks closes the card, and the plan never drafts it again
    const status = await autopilotStatus(t.db, maya.userId, NOW);
    expect(status.friendAsks).toEqual([
      expect.objectContaining({ friendName: 'Ana Rivera', targetName: 'Dan Lee', targetPersonId: dan }),
    ]);
    const asked = await call('/friends/asks', maya.token, {
      friendUserId: ana.userId,
      targetPersonId: dan,
      note: String(card!.payload.note),
    });
    expect(asked.status).toBe(200);
    expect((await autopilotStatus(t.db, maya.userId, NOW)).friendAsks).toEqual([]);
    expect((await runAutopilotPlan(s, maya.userId)).asks).toBe(0);
  });

  it('a pause on the account or the breaker on the goal plans nothing, and neither does assist', async () => {
    const net = fakeNet(gmail());
    const s = makeServices(agentConfig(net, {}), { db: t.db, now: () => NOW });
    const paused = await onAutopilot();
    await contact(paused.userId, { name: 'Pia Paused', org: 'Ramp', score: 70 });
    await t.db.sql`
      update orbit.users set settings = settings || ${{ autopilot_paused_until: new Date(NOW.getTime() + 86_400_000).toISOString() }}::jsonb
       where id = ${paused.userId}::uuid`;
    expect(await runAutopilotPlan(s, paused.userId)).toMatchObject({ reason: 'paused', queued: 0 });

    const broken = await onAutopilot();
    await contact(broken.userId, { name: 'Bo Broken', org: 'Ramp', score: 70 });
    await setGoalPause(t.db, broken.userId, broken.goalId, {
      reason: 'unsubscribe',
      text: 'Chloe Dubois asked to stop. Paused Ramp first messages.',
      until: null,
      at: NOW.toISOString(),
    });
    expect(await runAutopilotPlan(s, broken.userId)).toMatchObject({
      reason: 'no_autopilot_goal',
      queued: 0,
    });

    const assist = await onAutopilot({ mode: 'assist' });
    await contact(assist.userId, { name: 'Ash Assist', org: 'Ramp', score: 70 });
    expect(await runAutopilotPlan(s, assist.userId)).toMatchObject({
      reason: 'no_autopilot_goal',
      queued: 0,
    });
    // one goal switched to autopilot on an assist account runs on its own
    await t.db.sql`update orbit.goals set autonomy_level = 2 where id = ${assist.goalId}::uuid`;
    expect((await runAutopilotPlan(s, assist.userId)).queued).toBe(1);
    for (const u of [paused, broken])
      expect(await t.db.sql`select id from orbit.drafts where user_id = ${u.userId}::uuid`).toEqual([]);
  });

  it('raises the batch card once at 18:00 their time when the batch is not empty', async () => {
    const net = fakeNet(gmail());
    const s = makeServices(agentConfig(net, {}), { db: t.db, now: () => NOW });
    const { userId } = await onAutopilot();
    await contact(userId, { name: 'Bea Batch', org: 'Ramp', score: 70 });
    await contact(userId, { name: 'Cy Batch', org: 'Figma', score: 70 });
    expect((await runAutopilotPlan(s, userId)).batchCard).toBe(false);
    // 17:59 in New York: not yet; 18:05: the card, once
    expect(await raiseBatchCard(t.db, userId, 'America/New_York', new Date('2026-10-13T21:59:00Z'))).toBe(
      false,
    );
    const evening = new Date('2026-10-13T22:05:00Z');
    expect(await raiseBatchCard(t.db, userId, 'America/New_York', evening)).toBe(true);
    expect(await raiseBatchCard(t.db, userId, 'America/New_York', new Date('2026-10-13T23:30:00Z'))).toBe(
      false,
    );
    const status = await autopilotStatus(t.db, userId, evening);
    expect(status.batch).toMatchObject({
      firstTouches: 2,
      text: "Tomorrow's batch is ready: 2 first messages wait for your tap tonight. Until 20 go out as Orbit wrote them, only the ones you tap are sent.",
    });
    const [note] = await t.db.sql<{ title: string }>`
      select title from orbit.notifications where user_id = ${userId}::uuid`;
    expect(note!.title).toBe(status.batch!.text);
  });

  it('a first message the model writes carries the niche playbook as rules 13 on', async () => {
    const claude = anthropic(() => ({
      subject: 'x',
      body: 'too short',
      ask: { kind: 'call', text: 'x' },
      hooks: [],
    }));
    const net = fakeNet(claude.answer, gmail());
    const s = makeServices(agentConfig(net, ALL_KEYS), { db: t.db, now: () => NOW });
    const { userId, goalId } = await onAutopilot();
    const p = await contact(userId, {
      name: 'Rhea Rules',
      org: 'Figma',
      title: 'Product Manager',
      score: 70,
    });
    await composeDraft(s, { userId, personId: p, kind: 'first_touch', channel: 'gmail', goalId });
    const sys = systemText(claude.requests[0]!);
    expect(sys).toContain('13. This is a recruiting chat with an engineer, PM or designer.');
    expect(sys).toContain(`14. ${ASK_RULES.tech}`);
    expect(sys.match(/\n13\. /g)).toHaveLength(1);
  });
});

describe('sending the batch (plan 29 §B2.2, §B4, §B6)', () => {
  const AT = new Date(MORNING);
  const at = (d: Date) => () => d;

  /**
   * One planned first message for the morning, from the plan step itself. The send job's voice gate reads the
   * student's sent mail and asks the judge: two of their own emails and a judge that says the same person wrote it.
   */
  async function planned(over: { earn?: boolean } = {}) {
    const judge = anthropic(() => ({ score: 3, reason: 'The same short, warm voice.' }));
    const net = fakeNet(judge.answer, gmail());
    const s = makeServices(agentConfig(net, {}), { db: t.db, now: () => NOW });
    const u = await onAutopilot();
    if (over.earn) await earnRung(u.userId);
    await soundsLikeThem(u.userId);
    const personId = await contact(u.userId, { name: 'Gia Grant', org: 'Ramp', score: 70 });
    expect((await runAutopilotPlan(s, u.userId)).queued).toBe(1);
    const [d] = await t.db.sql<{ id: string; send_at: Date }>`
      select id, send_at from orbit.drafts where user_id = ${u.userId}::uuid and auto_rung = 'first_touch'`;
    const morning = makeServices(agentConfig(net, { anthropicKey: ALL_KEYS.anthropicKey }), {
      db: t.db,
      now: at(AT),
    });
    const sends = () => net.calls.filter((c) => c.url === GMAIL_SEND).length;
    return { ...u, net, s, morning, personId, draftId: d!.id, sends };
  }
  const statusOf = async (id: string) =>
    (
      await t.db.sql<{ status: string; error: string | null; cancel_reason: string | null }>`
      select status, error, cancel_reason from orbit.drafts where id = ${id}::uuid`
    )[0]!;

  it('nothing goes before the review window ends, whoever approved it', async () => {
    const r = await planned({ earn: true });
    const early = makeServices(agentConfig(r.net, {}), {
      db: t.db,
      now: at(new Date(AT.getTime() - 3_600_000)),
    });
    await t.db
      .sql`update orbit.drafts set send_at = ${new Date(AT.getTime() - 3_600_000)}::timestamptz where id = ${r.draftId}::uuid`;
    expect(await sendDraft(early, r.draftId)).toEqual({ status: 'held', reason: 'review_window' });
    expect(r.sends()).toBe(0);
  });

  it('before the rung a first message waits for a tap: silence keeps it back, a tap sends it at its time', async () => {
    const r = await planned();
    expect(await sendDraft(r.morning, r.draftId)).toEqual({ status: 'held', reason: 'needs_tap' });
    expect(await statusOf(r.draftId)).toMatchObject({ status: 'draft', error: 'needs_tap' });
    expect(r.sends()).toBe(0);
    const held = await autopilotStatus(t.db, r.userId, AT);
    expect(held.held.find((h) => h.draftId === r.draftId)?.reason).toContain('It waited for your tap');

    // the next evening the student taps it in the batch: it goes as their own send, and counts toward the rung
    const second = await planned();
    const call = api(t, second.net, { env: {}, now: () => NOW });
    const tap = await call('/drafts/approve', second.token, { draftId: second.draftId, sendAt: MORNING });
    expect(tap.status).toBe(200);
    expect((await autopilotStatus(t.db, second.userId, NOW)).queued[0]?.status).toBe('queued');
    expect(await sendDraft(second.morning, second.draftId)).toMatchObject({ status: 'sent' });
    const [a] = await t.db.sql<{ action: string }>`
      select action from orbit.audit_log where target_id = ${second.draftId} and action in ('draft.sent', 'draft.auto_sent')`;
    expect(a!.action).toBe('draft.sent');
    expect((await firstTouchRungOf(t.db, second.userId)).unchanged).toBe(1);
  });

  it('after the rung it sends at its time on silence, recorded as draft.auto_sent with its rung', async () => {
    const r = await planned({ earn: true });
    expect(await sendDraft(r.morning, r.draftId)).toMatchObject({ status: 'sent' });
    expect(r.sends()).toBe(1);
    const [a] = await t.db.sql<{ actor: string; details: Record<string, unknown> }>`
      select actor, details from orbit.audit_log where target_id = ${r.draftId} and action = 'draft.auto_sent'`;
    expect(a).toMatchObject({
      actor: 'agent',
      details: { rung: 'first_touch', kind: 'warm_first_touch', level: 2 },
    });
    const status = await autopilotStatus(t.db, r.userId, AT);
    expect(status.sentToday).toEqual([
      expect.objectContaining({ draftId: r.draftId, autoRung: 'first_touch', status: 'sent' }),
    ]);
    // the weekly review's line reads the week from the same status
    expect(status.week).toMatchObject({ sent: 1, replies: 0, calls: 0, pushbacks: 0 });
  });

  it('a hold wins: the held message is never claimed', async () => {
    const r = await planned({ earn: true });
    const call = api(t, r.net, { env: {}, now: () => NOW });
    expect((await call('/autopilot/hold', r.token, { draftId: r.draftId })).status).toBe(200);
    expect(await sendDraft(r.morning, r.draftId)).toEqual({ status: 'skipped', reason: 'not_claimed' });
    expect(r.sends()).toBe(0);
  });

  it('every condition is looked at again at send time: a reply since, do not contact, private, a firm written to today', async () => {
    const replied = await planned({ earn: true });
    // drafted at the plan's hour (the test database's own clock is not the fake one)
    await t.db
      .sql`update orbit.drafts set created_at = ${NOW}::timestamptz where id = ${replied.draftId}::uuid`;
    await addThread(t, replied.userId, replied.personId, [
      {
        direction: 'in',
        at: new Date(AT.getTime() - 3_600_000).toISOString(),
        body: 'Hi, saw your name come up.',
      },
    ]);
    expect(await sendDraft(replied.morning, replied.draftId)).toEqual({
      status: 'cancelled',
      reason: 'replied',
    });

    const dnc = await planned({ earn: true });
    await t.db.sql`update orbit.people set do_not_contact = true where id = ${dnc.personId}::uuid`;
    expect(await sendDraft(dnc.morning, dnc.draftId)).toMatchObject({
      status: 'cancelled',
      reason: 'do_not_contact',
    });

    const priv = await planned({ earn: true });
    await t.db.sql`update orbit.people set private = true where id = ${priv.personId}::uuid`;
    expect(await sendDraft(priv.morning, priv.draftId)).toEqual({
      status: 'held',
      reason: 'first_touch:private',
    });
    expect((await autopilotStatus(t.db, priv.userId, AT)).held[0]?.reason).toBe(
      'You marked Gia private, so autopilot leaves them to you.',
    );

    const firm = await planned({ earn: true });
    const other = await contact(firm.userId, { name: 'Rae Ramp', org: 'Ramp', score: 70 });
    await t.db.sql`
      insert into orbit.drafts (user_id, person_id, channel, kind, body, status, sent_at, auto_rung)
      values (${firm.userId}::uuid, ${other}::uuid, 'gmail', 'first_touch', 'Hi Rae', 'sent', ${new Date(AT.getTime() - 600_000)}::timestamptz, 'first_touch')`;
    const r = await sendDraft(firm.morning, firm.draftId);
    expect(r).toEqual({ status: 'held', reason: 'same_firm_today' });
    const [later] = await t.db.sql<{ status: string; send_at: Date }>`
      select status, send_at from orbit.drafts where id = ${firm.draftId}::uuid`;
    expect(later!.status).toBe('approved');
    expect(new Date(later!.send_at).toISOString()).toBe('2026-10-15T12:00:00.000Z');
    for (const x of [replied, dnc, priv, firm]) expect(x.sends()).toBe(0);
  });

  it('the pause and the breaker stop it, and a pushback on one Orbit sent trips the breaker for the goal', async () => {
    const paused = await planned({ earn: true });
    await t.db.sql`
      update orbit.users set settings = settings || ${{ autopilot_paused_until: new Date(AT.getTime() + 86_400_000).toISOString() }}::jsonb
       where id = ${paused.userId}::uuid`;
    expect(await sendDraft(paused.morning, paused.draftId)).toEqual({
      status: 'held',
      reason: 'autopilot_paused',
    });

    const broken = await planned({ earn: true });
    await setGoalPause(t.db, broken.userId, broken.goalId, {
      reason: 'unsubscribe',
      text: 'Chloe Dubois asked to stop. Paused Ramp first messages.',
      until: null,
      at: NOW.toISOString(),
    });
    expect(await sendDraft(broken.morning, broken.draftId)).toEqual({
      status: 'held',
      reason: 'goal_paused',
    });
    for (const x of [paused, broken]) expect(x.sends()).toBe(0);

    // Gia answers the first message Orbit sent with a no: that goal's first messages pause at once
    const sent = await planned({ earn: true });
    expect(await sendDraft(sent.morning, sent.draftId)).toMatchObject({ status: 'sent' });
    const reply = await addThread(t, sent.userId, sent.personId, [
      {
        direction: 'in',
        at: new Date(AT.getTime() + 3_600_000).toISOString(),
        body: 'Not interested, thanks.',
        replyClass: 'decline',
      },
    ]);
    await maybeAutoReply(t.db, sent.userId, reply.messageIds[0]!, {
      now: at(new Date(AT.getTime() + 2 * 3_600_000)),
    });
    const [u] = await t.db.sql<{
      settings: Record<string, unknown>;
    }>`select settings from orbit.users where id = ${sent.userId}::uuid`;
    expect(goalPaused(u!.settings, sent.goalId, AT)).toBe(true);
    const [card] = await t.db.sql<{ reason_text: string }>`
      select reason_text from orbit.suggestions where user_id = ${sent.userId}::uuid and kind = 'breaker'`;
    expect(card!.reason_text).toBe(
      'Gia Grant pushed back on a first message Orbit sent. Paused Ramp first messages. Read it?',
    );
    expect(
      (await autopilotStatus(t.db, sent.userId, new Date(AT.getTime() + 3 * 3_600_000))).week,
    ).toMatchObject({
      sent: 1,
      pushbacks: 1,
      paused: ['Ramp'],
      who: [{ personName: 'Gia Grant', reason: 'pushback' }],
    });
  });
});
