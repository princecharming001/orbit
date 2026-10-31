import { describe, expect, it } from 'vitest';
import { loadDemo } from '../../../engine/demo';
import { createFakeOrbitApi, fakeAccountUser, withFriend, withReplies } from '../../../test/fakeOrbitApi';
import { registry } from '../../registry';
import { NOW } from '../helpers';
import { seed, shapeCheck, type Transcript, teardownSim } from './harness';
import { CAMPAIGN_GROUPS, GROUPS, PLAN29_GROUPS, PLAN29_TOOLS, SCENARIOS } from './scenarios';

/** The simulated students need a Claude key to run; this checks, without one, that every scenario can. */
describe('sim scenarios', () => {
  it('cover the plan 28 campaign: knowledge, web, shape, honesty and the new students, each with its reference', () => {
    for (const g of [
      'knowledge',
      'data',
      'drafting',
      'goals',
      'web',
      'shape',
      'honesty',
      'persona-soph-ib',
      'persona-founder-seed',
      'persona-hiring',
      'persona-advice',
      'persona-switcher',
      'persona-intl',
      'persona-empty',
      'persona-quiet',
    ])
      expect(CAMPAIGN_GROUPS).toContain(g);
    // every knowledge question carries the standard the judge scores it against
    for (const s of SCENARIOS.filter((x) => x.group === 'knowledge'))
      expect(s.reference?.length ?? 0, s.id).toBeGreaterThan(80);
    // a scenario cannot both need and forbid the web
    for (const s of SCENARIOS) expect(s.expectWeb && s.noWeb, s.id).toBeFalsy();
  });

  it('build every student profile: the sophomore, the founder, the hiring founder, the freshman, the switcher, the international student', async () => {
    try {
      for (const id of [
        'know-ib-start',
        'draft-founder-first',
        'hiring-who-first',
        'advice-where-start',
        'switch-story',
        'intl-first-banker',
      ]) {
        const s = SCENARIOS.find((x) => x.id === id)!;
        const { user } = await seed(s.account);
        expect(user.firstName, id).not.toBe('Jordan');
        const goals = await (await import('../../../db/schema')).db.userGoals
          .where('userId')
          .equals(user.id)
          .toArray();
        expect(goals.length, `${id} has a goal`).toBeGreaterThan(0);
        const people = await (await import('../../../db/schema')).db.people
          .where('userId')
          .equals(user.id)
          .toArray();
        expect(people.length, `${id} has people`).toBeGreaterThan(3);
      }
    } finally {
      teardownSim();
    }
  }, 120_000);

  it('shapeCheck reads the rules the prompt states off a transcript', () => {
    const turn = (over: Partial<Transcript['turns'][number]>): Transcript['turns'][number] => ({
      student: 'who should i message',
      tools: [],
      text: 'Lena, then Daniel.',
      web: [],
      preamble: '',
      betweenTools: 0,
      pills: 0,
      ...over,
    });
    const clean = shapeCheck({ persona: '', goal: '', screen: '', turns: [turn({})] });
    expect(clean.ok).toBe(true);
    const bad = shapeCheck(
      {
        persona: '',
        goal: '',
        screen: '',
        turns: [
          turn({
            text: 'Let me look at a few things first, this will take a moment while I check your pipeline and your drafts.\n\nOne more thing.\n\nHere you go — three names!',
            preamble:
              'Let me look at a few things first, this will take a moment while I check your pipeline and your drafts.',
            betweenTools: 1,
            pills: 5,
            web: [
              { query: 'a', sources: 2 },
              { query: 'b', sources: 2 },
              { query: 'c', sources: 2 },
              { query: 'd', sources: 2 },
            ],
          }),
        ],
      },
      { noWeb: true },
    );
    expect(bad.ok).toBe(false);
    expect(bad.problems.join('\n')).toMatch(/written before the tools/);
    expect(bad.problems.join('\n')).toMatch(/between rounds/);
    expect(bad.problems.join('\n')).toMatch(/4 web searches/);
    expect(bad.problems.join('\n')).toMatch(/dash or an exclamation/);
    expect(bad.problems.join('\n')).toMatch(/5 next-step pills/);
    expect(bad.problems.join('\n')).toMatch(/playbook answers/);
    expect(bad.stats.webSearches).toBe(4);
    // a wide goal lifts the per-turn caps, not the rest
    const wide = shapeCheck(
      {
        persona: '',
        goal: '',
        screen: '',
        turns: [turn({ web: [{ sources: 1 }, { sources: 1 }, { sources: 1 }, { sources: 1 }] })],
      },
      { wide: true },
    );
    expect(wide.ok).toBe(true);
    expect(
      shapeCheck({ persona: '', goal: '', screen: '', turns: [turn({})] }, { expectWeb: true }).problems[0],
    ).toMatch(/no web search/);
  });

  it('have unique ids, the plan 16 persona groups with four scenarios each, and the new singles', () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of ['persona-intern', 'persona-founder', 'persona-sales', 'persona-phd']) {
      expect(GROUPS).toContain(g);
      expect(SCENARIOS.filter((s) => s.group === g)).toHaveLength(4);
    }
    for (const id of [
      'goal-infer',
      'memory-pref',
      'research-person',
      'find-investors',
      'reply-schedule',
      'autonomy-refuse-linkedin',
    ])
      expect(ids).toContain(id);
  });

  it('only expect tools the registry has, or the plan 29 tools on a pending scenario', () => {
    const plan29 = new Set<string>(PLAN29_TOOLS);
    for (const s of SCENARIOS)
      for (const anyOf of s.expectTools ?? [])
        for (const t of anyOf)
          expect(registry.has(t) || (s.pending === 'plan29' && plan29.has(t)), `${s.id}: ${t}`).toBe(true);
    // once a plan 29 tool lands, its scenarios come off pending: a pending scenario names at least one tool still missing,
    // or no tool at all
    for (const s of SCENARIOS.filter((x) => x.pending))
      expect(
        !s.expectTools?.length || s.expectTools.some((anyOf) => anyOf.some((t) => !registry.has(t))),
        `${s.id} waits on nothing: drop pending`,
      ).toBe(true);
  });

  it('cover plan 29: twelve friends and fifteen autopilot scenarios, each pending, with a reference and no web', () => {
    expect(PLAN29_GROUPS).toEqual(['friends', 'autopilot']);
    const friends = SCENARIOS.filter((s) => s.group === 'friends');
    const autopilot = SCENARIOS.filter((s) => s.group === 'autopilot');
    expect(friends).toHaveLength(12);
    expect(autopilot).toHaveLength(15);
    for (const s of [...friends, ...autopilot]) {
      expect(s.pending, s.id).toBe('plan29');
      expect(s.reference?.length ?? 0, s.id).toBeGreaterThan(80);
      expect(s.noWeb, s.id).toBe(true);
      expect(s.reference, s.id).not.toMatch(/[—–!]/);
    }
    // the A7 and B7 flows the plan names each have a row
    for (const id of [
      'friends-who-at-stripe',
      'friends-ask-ana-dan',
      'friends-what-ana-sees',
      'friends-invite-email',
      'friends-stop-sharing-ana',
      'friends-ask-arrives-forward',
      'ap-turn-on',
      'ap-what-sent-today',
      'ap-hold-tomorrow',
      'ap-answer-dan',
      'ap-pause-everything',
      'ap-why-not-priya',
      'ap-what-learned-voice',
      'ap-forget-note',
    ])
      expect(SCENARIOS.map((s) => s.id)).toContain(id);
  });

  it('seed the fake orbit-api for every account scenario against the demo', async () => {
    const user = await loadDemo({ reset: true, now: NOW });
    for (const s of SCENARIOS.filter((x) => x.api)) {
      const api = createFakeOrbitApi();
      await s.api!(api, user);
      if (['founder-investors', 'find-investors', 'sales-find', 'phd-find'].includes(s.id))
        expect(api.state.sourced.length, s.id).toBeGreaterThan(0);
      if (['reply-schedule', 'memory-pref'].includes(s.id)) expect(api.state.replies, s.id).toHaveLength(1);
      if (['phd-research', 'research-person'].includes(s.id)) expect(api.state.dossiers.size, s.id).toBe(1);
      if (['intern-route', 'founder-intro'].includes(s.id)) expect(api.state.paths.size, s.id).toBe(1);
      if (s.group === 'friends' && s.api) {
        // Ana: 120 people, six at the targets, closeness 1 to 3, the student's Maya Chen joined, one open ask
        const ana = api.state.friends.find((f) => f.name === 'Ana Okafor')!;
        expect(ana, s.id).toBeDefined();
        expect(ana.people, s.id).toHaveLength(120);
        const targets = api.state.targets.map((t) => t.toLowerCase());
        expect(
          ana.people.filter((p) => targets.includes(p.company?.toLowerCase() ?? '')),
          s.id,
        ).toHaveLength(6);
        for (const p of ana.people) expect([1, 2, 3], s.id).toContain(p.closeness);
        expect(ana.people.find((p) => p.displayName === 'Maya Chen')?.matchesPersonId, s.id).toBeTruthy();
        expect(
          api.state.friendAsks.filter((a) => a.friendUserId === user.id),
          s.id,
        ).toHaveLength(1);
        expect(api.state.ownShares.length, s.id).toBeGreaterThan(3);
        // a projection never carries an address or a score (plan 29 C2)
        for (const row of api.state.ownShares) expect(Object.keys(row), s.id).not.toContain('primaryEmail');
      }
      if (s.group === 'autopilot') {
        const classes = api.state.replies.map((r) => r.replyClass);
        for (const c of [
          'interested',
          'scheduling',
          'question',
          'objection',
          'referral',
          'not_now',
          'out_of_office',
          'decline',
          'unsubscribe',
          'thanks',
        ])
          expect(classes, s.id).toContain(c);
        expect(api.state.autopilot.mode, s.id).toBe('autopilot');
        expect(api.state.autopilot.sentToday, s.id).toHaveLength(3);
        expect(api.state.autopilot.queued, s.id).toHaveLength(2);
        expect(api.state.autopilot.held[0]?.personName, s.id).toBe('Priya Shah');
        expect(api.state.autopilot.needsYou[0]?.question, s.id).toMatch(/applied/);
        expect(api.state.voice.notes, s.id).toHaveLength(3);
      }
    }
  }, 90_000);

  it('answer the plan 29 routes the way the bench expects: a friend path, an ask, a hold, an answer, a forgotten note', async () => {
    // the seeds alone, over a few named people, so this needs no demo load and stays fast under a full run
    const user = { id: '7d0c4a52-6c38-4a8e-9a55-1f2e3d4c5b6a', firstName: 'Alex' };
    const api = createFakeOrbitApi({ user: fakeAccountUser({ id: user.id, firstName: user.firstName }) });
    const people = [
      {
        id: 'p_maya',
        displayName: 'Maya Chen',
        currentTitle: 'Software Engineer',
        currentOrganizationRaw: 'Stripe',
      },
      {
        id: 'p_lena',
        displayName: 'Lena Novak',
        currentTitle: 'Engineering Manager',
        currentOrganizationRaw: 'Ramp',
      },
      { id: 'p_daniel', displayName: 'Daniel Okafor', currentOrganizationRaw: 'Goldman Sachs' },
      { id: 'p_ethan', displayName: 'Ethan Park', currentOrganizationRaw: 'Anthropic' },
    ];
    withFriend(api, user, people);
    withReplies(api, user, people, NOW.getTime());
    const session = await (
      await api.fetch(`${api.base}/auth/session`, {
        method: 'POST',
        body: JSON.stringify({ code: api.code }),
      })
    ).json();
    const call = async (route: string, body?: unknown, method: 'GET' | 'POST' = 'POST') => {
      const res = await api.fetch(`${api.base}${route}`, {
        method,
        headers: { authorization: `Bearer ${session.accessToken}` },
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    // the friend list carries the counts the tab shows
    const list = await call('/friends', undefined, 'GET');
    const ana = (list.body.friends as { name: string; shares: number; atTargets: number }[])[0]!;
    expect(ana.name).toBe('Ana Okafor');
    expect(ana.shares).toBe(120);
    expect(ana.atTargets).toBe(6);
    // a route to Stripe runs through Ana, with the friend on the hop and 'friends' among the sources
    const stripe = await call('/paths/find', { target: { company: 'Stripe' } });
    expect(stripe.body.sources).toContain('friends');
    const paths = stripe.body.paths as {
      hops: { via?: { name: string } }[];
      names: Record<string, string>;
    }[];
    expect(paths.length).toBe(2);
    expect(paths[0]!.hops[0]!.via?.name).toBe('Ana Okafor');
    expect(Object.values(paths[0]!.names)).toContain('Dan Lee');
    // the ask goes to Ana; the shares a friend sees never carry the fake's own join hint
    const shares = await call(
      `/friends/shares/${api.state.friends[0]!.userId}?company=stripe`,
      undefined,
      'GET',
    );
    expect((shares.body.shares as Record<string, unknown>[]).length).toBe(2);
    for (const row of shares.body.shares as Record<string, unknown>[])
      expect(Object.keys(row)).not.toContain('matchesPersonId');
    const dan = (shares.body.shares as { personId: string; displayName: string }[]).find(
      (s) => s.displayName === 'Dan Lee',
    )!;
    const asked = await call('/friends/asks', {
      friendUserId: api.state.friends[0]!.userId,
      targetPersonId: dan.personId,
      note: 'Junior at Cornell, payments infra, would love 15 minutes.',
    });
    expect(asked.status).toBe(200);
    expect((asked.body.ask as { status: string }).status).toBe('asked');
    // Ana's ask of the student, forwarded, becomes a draft that quotes her note and cc's her
    const forwarded = await call('/friends/asks/ask_ana_lena/respond', { action: 'forward' });
    expect(forwarded.status).toBe(200);
    expect((forwarded.body.draft as { body: string }).body).toMatch(/Ana asked me|Cc'ing Ana/);
    // sharing nothing hides the student's people from the preview at once
    await call('/friends/settings', { mode: 'none' });
    expect(((await call('/friends/preview', undefined, 'GET')).body.shares as unknown[]).length).toBe(0);
    // autopilot: a hold moves the message, an answer fills the gap, a pause cancels the batch
    const held = await call('/autopilot/hold', { draftId: 'draft_ap_grace' });
    expect((held.body.item as { status: string }).status).toBe('held');
    expect(api.state.autopilot.queued).toHaveLength(1);
    const answered = await call('/replies/answer', {
      draftId: 'draft_daniel_question',
      answer: 'Yes, I applied on Monday.',
    });
    expect((answered.body.draft as { body: string; needsInput: string[] }).body).toContain(
      'Yes, I applied on Monday.',
    );
    expect((answered.body.draft as { needsInput: string[] }).needsInput).toEqual([]);
    expect(api.state.autopilot.needsYou).toHaveLength(0);
    const paused = await call('/autopilot/pause', { until: '2026-10-20T00:00:00.000Z' });
    expect(paused.body.cancelled).toBe(1);
    expect(api.state.autopilot.queued).toHaveLength(0);
    // voice: a forgotten note leaves the list
    await call('/voice/notes', { id: 'vn_thanks_either_way', action: 'forget' });
    expect(((await call('/voice', undefined, 'GET')).body.notes as unknown[]).length).toBe(2);
    expect((await call('/voice/relearn')).body.queued).toBe(true);
    expect((await call('/autopilot/mode', { mode: 'assist' })).body.mode).toBe('assist');
    expect(api.state.autopilot.mode).toBe('assist');
  }, 30_000);
});
