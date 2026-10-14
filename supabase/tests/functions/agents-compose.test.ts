import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordUsage } from '../../functions/_shared/budget.ts';
import { composeDraft } from '../../functions/_shared/compose/compose.ts';
import { PROMPT_VERSION } from '../../functions/_shared/compose/prompts.ts';
import { nextSendWindow, sendDayAllowed } from '../../functions/_shared/compose/window.ts';
import { vec } from '../../functions/_shared/rows.ts';
import { makeServices } from '../../functions/_shared/services.ts';
import {
  type AnthropicRequest,
  addPerson,
  addThread,
  agentConfig,
  anthropic,
  api,
  DAY,
  fakeEmbed,
  fakeNet,
  iso,
  signedInUser,
  systemText,
  userText,
} from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

const GOOD_FIRST_TOUCH = {
  subject: 'your talk on robots',
  body: `Hi Jane,

I am Sam, a student at Stanford. Your talk on warehouse robots stuck with me, and I have thought about it all week. I build small robot arms in our club. I want to work on robots that help people at work. I would like to learn how you got into this field and how your team picks what to build next. Would you have 15 minutes for a call in the next few weeks?

Best,
Sam`,
  ask: { kind: 'call', text: 'Would you have 15 minutes for a call in the next few weeks?' },
  hooks: [{ text: 'Your talk on warehouse robots', sourceId: 'S2' }],
};

async function janeWithDossier(userId: string, email = 'jane@northwind.example') {
  const jane = await addPerson(t, userId, {
    name: 'Jane Doe',
    email,
    title: 'VP Engineering',
    org: 'Northwind Robotics',
    score: 10,
  });
  await t.db.sql`
    insert into orbit.dossiers (user_id, person_id, status, content, sources, expires_at)
    values (${userId}::uuid, ${jane}::uuid, 'ready',
            ${{
              who: 'Jane Doe runs engineering at Northwind Robotics.',
              now: {
                role: 'VP Engineering',
                org: 'Northwind Robotics',
                since: '2023-02',
                source_ids: ['S1'],
              },
              recently: [{ date: '2026-06-02', text: 'Northwind raised a Series B.', source_ids: ['S2'] }],
              in_common: [],
              history: { first_contact: null, last_contact: null, summary: null },
              openers: [{ text: 'Your talk on warehouse robots stuck with me.', source_ids: ['S2'] }],
              careful: [],
              confidence: 'high',
            }}::jsonb,
            ${JSON.stringify([
              { id: 'S1', kind: 'linkedin_profile', url: 'https://www.linkedin.com/in/jane-doe-nw' },
              { id: 'S2', kind: 'web', url: 'https://news.example/northwind' },
            ])}::jsonb, now() + interval '30 days')`;
  return jane;
}

/** An outbound message of ≥ 25 words with its embedding, for the voice exemplars. */
async function sentMessage(userId: string, to: string, body: string) {
  const { messageIds } = await addThread(t, userId, to, [{ direction: 'out', at: iso(40 * DAY), body }]);
  await t.db
    .sql`update orbit.messages set embedding = ${vec(await fakeEmbed(body))}::vector where id = ${messageIds[0]!}::uuid`;
}

describe('compose (§7)', () => {
  it('writes in the user’s voice with Opus 5.5: the §7.6 prompt, research ids, exemplars by cosine, validated', async () => {
    const claude = anthropic(() => GOOD_FIRST_TOUCH);
    const net = fakeNet(claude.answer);
    const call = api(t, net);
    const { userId, token } = await signedInUser(t);
    const jane = await janeWithDossier(userId);
    const leo = await addPerson(t, userId, { name: 'Leo Grant' });
    const words =
      'I would love to hear how you think about robots and the people who build them at your company';
    await sentMessage(
      userId,
      leo,
      `Hi Leo, ${words}. Could we talk for fifteen minutes next week about robots? Thanks again, Sam`,
    );
    await sentMessage(
      userId,
      jane,
      `Hi Jane, ${words}. This one went to the same recipient and must not be used here.`,
    );
    const g = await call<{ goal: { id: string } }>('/goals/upsert', token, {
      goal: { kind: 'recruiting', title: 'Robotics internship', targets: { roles: ['robotics engineer'] } },
    });
    const r = await call<{
      draft: {
        generatedBy: string;
        validator: { ok: boolean };
        hooks: unknown[];
        status: string;
        subject: string;
        needsInput: string[];
      };
    }>('/drafts/compose', token, {
      personId: jane,
      kind: 'first_touch',
      channel: 'gmail',
      goalId: g.body.goal.id,
    });
    expect(r.status).toBe(200);
    expect(r.body.draft).toMatchObject({
      generatedBy: 'llm',
      status: 'draft',
      subject: 'your talk on robots',
      needsInput: [],
    });
    expect(r.body.draft.validator.ok).toBe(true);
    expect(claude.requests).toHaveLength(1);
    const q = claude.requests[0]!;
    expect(q.model).toBe('claude-opus-5-5');
    expect(q.output_config.effort).toBe('medium');
    expect(q.system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    const sys = systemText(q);
    expect(sys).toContain('You write one message that Sam will send as themselves.');
    expect(sys).toContain('- 50–110 words; one ask: call; subject 2–6 words.');
    expect(sys).toContain(
      "- Never claim familiarity, shared history or a mutual connection that isn't in the inputs.",
    );
    const u = userText(q);
    for (const tag of ['user_context', 'goal', 'recipient', 'research', 'thread', 'via', 'voice', 'examples'])
      expect(u).toContain(`<${tag}>`);
    expect(u).toContain('[S2]');
    expect(u).toContain('Hi [name], I would love to hear');
    expect(u).not.toContain('must not be used here');
    const [row] = await t.db.sql<{ prompt_version: string; generated_by: string }>`
      select prompt_version, generated_by from orbit.drafts where person_id = ${jane}::uuid`;
    expect(row).toEqual({ prompt_version: PROMPT_VERSION, generated_by: 'llm' });
  });

  it('§7.8 test 4: a draft naming someone not in the inputs is retried once, then the template is used', async () => {
    const invented = {
      ...GOOD_FIRST_TOUCH,
      body: GOOD_FIRST_TOUCH.body.replace(
        'I build small robot arms in our club.',
        'Priya Ahmed told me to write to you.',
      ),
    };
    const claude = anthropic(() => invented);
    const call = api(t, fakeNet(claude.answer));
    const { userId, token } = await signedInUser(t);
    const jane = await janeWithDossier(userId);
    const r = await call<{ draft: { generatedBy: string; body: string } }>('/drafts/compose', token, {
      personId: jane,
      kind: 'first_touch',
      channel: 'gmail',
    });
    expect(r.status).toBe(200);
    expect(claude.requests).toHaveLength(2);
    expect(userText(claude.requests[1]!)).toContain('<issues>');
    expect(userText(claude.requests[1]!)).toContain('unknown_detail: Priya Ahmed is not in the inputs');
    expect(r.body.draft.generatedBy).toBe('template');
    expect(r.body.draft.body).not.toContain('Priya');
  });

  it('a hook must cite a research id; [ASK USER: …] becomes needsInput', async () => {
    let n = 0;
    const claude = anthropic(() =>
      n++ === 0
        ? { ...GOOD_FIRST_TOUCH, hooks: [{ text: 'Your talk', sourceId: 'S9' }] }
        : {
            ...GOOD_FIRST_TOUCH,
            body: GOOD_FIRST_TOUCH.body.replace(
              'I build small robot arms in our club.',
              '[ASK USER: what you build in the club]',
            ),
          },
    );
    const call = api(t, fakeNet(claude.answer));
    const { userId, token } = await signedInUser(t);
    const jane = await janeWithDossier(userId);
    const r = await call<{
      draft: { generatedBy: string; needsInput: string[]; validator: { ok: boolean; issues: string[] } };
    }>('/drafts/compose', token, { personId: jane, kind: 'first_touch', channel: 'gmail' });
    expect(userText(claude.requests[1]!)).toContain('hook_source: S9');
    expect(r.body.draft.generatedBy).toBe('llm');
    expect(r.body.draft.needsInput).toEqual(['what you build in the club']);
    expect(r.body.draft.validator.ok).toBe(false);
  });

  it('refuses do-not-contact people, and sales first touches before a postal address is set (§14.8 test 3)', async () => {
    const call = api(t, fakeNet(), { env: {} });
    const { userId, token } = await signedInUser(t);
    const dnc = await addPerson(t, userId, {
      name: 'Dee Nolan',
      email: 'dee@example.com',
      doNotContact: true,
    });
    const d = await call<{ error: { code: string } }>('/drafts/compose', token, {
      personId: dnc,
      kind: 'first_touch',
      channel: 'gmail',
    });
    expect(d.status).toBe(409);
    expect(d.body.error.code).toBe('do_not_contact');
    const g = await call<{ goal: { id: string } }>('/goals/upsert', token, {
      goal: { kind: 'sales', title: 'Clinic pilots' },
    });
    const buyer = await janeWithDossier(userId);
    const s = await call<{ error: { code: string } }>('/drafts/compose', token, {
      personId: buyer,
      kind: 'first_touch',
      channel: 'gmail',
      goalId: g.body.goal.id,
    });
    expect(s.status).toBe(409);
    expect(s.body.error.code).toBe('needs_postal_address');
    await t.db
      .sql`update orbit.users set settings = ${{ postal_address: '1 Main St, Palo Alto, CA 94301', company: 'Orbitly', pitch: 'helps clinics book patients' }}::jsonb
      where id = ${userId}::uuid`;
    const ok = await call<{ draft: { id: string; body: string } }>('/drafts/compose', token, {
      personId: buyer,
      kind: 'first_touch',
      channel: 'gmail',
      goalId: g.body.goal.id,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.draft.body).toContain("If this isn't relevant, just say so and I won't follow up.");
    expect(ok.body.draft.body).toContain('1 Main St, Palo Alto, CA 94301');
    expect(ok.body.draft.body).toContain('Orbitly');
    // the address is removed again: the draft cannot be approved
    await t.db.sql`update orbit.users set settings = settings - 'postal_address' where id = ${userId}::uuid`;
    const ap = await call<{ error: { code: string } }>('/drafts/approve', token, {
      draftId: ok.body.draft.id,
    });
    expect(ap.status).toBe(409);
    expect(ap.body.error.code).toBe('needs_postal_address');
  });

  it('a postal address saved through /settings/profile is the one sales first touches read', async () => {
    const call = api(t, fakeNet(), { env: {} });
    const { userId, token } = await signedInUser(t, { settings: { company: 'Orbitly' } });
    const g = await call<{ goal: { id: string } }>('/goals/upsert', token, {
      goal: { kind: 'sales', title: 'Clinic pilots' },
    });
    const buyer = await janeWithDossier(userId);
    const compose = () =>
      call<{ draft?: { body: string }; error?: { code: string } }>('/drafts/compose', token, {
        personId: buyer,
        kind: 'first_touch',
        channel: 'gmail',
        goalId: g.body.goal.id,
      });
    expect((await compose()).body.error?.code).toBe('needs_postal_address');
    const saved = await call<{ postalAddress: string | null }>('/settings/profile', token, {
      postalAddress: '  20 Elm St, Ithaca, NY 14850 ',
    });
    expect(saved.body.postalAddress).toBe('20 Elm St, Ithaca, NY 14850');
    const [u] = await t.db.sql<{ settings: Record<string, unknown> }>`
      select settings from orbit.users where id = ${userId}::uuid`;
    expect(u!.settings).toEqual({ company: 'Orbitly', postal_address: '20 Elm St, Ithaca, NY 14850' });
    const ok = await compose();
    expect(ok.status).toBe(200);
    expect(ok.body.draft!.body).toContain('20 Elm St, Ithaca, NY 14850');
    // cleared again: the next sales first touch is refused
    await call('/settings/profile', token, { postalAddress: null });
    expect((await compose()).body.error?.code).toBe('needs_postal_address');
  });

  it('§7.8 test 3 (offline gate, template path): every kind × goal composed without a model passes the validator', async () => {
    const net = fakeNet();
    const s = makeServices(agentConfig(net, {}), { db: t.db });
    const { userId } = await signedInUser(t, {
      settings: {
        postal_address: '1 Main St, Palo Alto, CA',
        company: 'Orbitly',
        pitch: 'helps clinics book patients',
        research_topic: 'robot grasping in cluttered bins',
      },
    });
    const intro = await addPerson(t, userId, { name: 'Ana Silva', email: 'ana@example.com', score: 60 });
    const failures: string[] = [];
    for (const goal of [
      'recruiting',
      'advice',
      'fundraising',
      'sales',
      'hiring',
      'cofounder',
      'community',
      'collaboration',
    ] as const) {
      const [g] = await t.db.sql<{ id: string }>`
        insert into orbit.goals (user_id, kind, title, status) values (${userId}::uuid, ${goal}, ${`${goal} goal`}, 'paused') returning id`;
      for (const kind of [
        'first_touch',
        'warm_first_touch',
        'intro_request',
        'forwardable_blurb',
        'reengage',
        'bump',
        'thank_you',
      ] as const) {
        const jane = await janeWithDossier(userId, `jane.${goal}.${kind}@northwind.example`);
        const viaIntro = kind === 'intro_request' || kind === 'forwardable_blurb';
        const r = await composeDraft(s, {
          userId,
          personId: viaIntro ? intro : jane,
          kind,
          channel: 'gmail',
          goalId: g!.id,
          ...(viaIntro ? { targetPersonId: jane, via: { introducerId: intro, pathScore: 0.4 } } : {}),
          ...(kind === 'warm_first_touch' ? { via: { introducerId: intro, pathScore: 0.4 } } : {}),
        });
        expect(r.draft.generated_by).toBe('template');
        const unknown = r.draft.validator!.issues.filter((i) => i.startsWith('unknown_detail'));
        if (!r.draft.validator!.ok) failures.push(`${goal}/${kind}: ${r.draft.validator!.issues.join('; ')}`);
        expect(unknown, `${goal}/${kind}`).toEqual([]);
      }
    }
    expect(failures).toEqual([]);
    expect(net.calls).toHaveLength(0);
  });

  it('§13.8 test 3: over the daily Claude cap the next compose makes no model call and uses the template', async () => {
    const claude = anthropic(() => GOOD_FIRST_TOUCH);
    const call = api(t, fakeNet(claude.answer));
    const { userId, token } = await signedInUser(t);
    const jane = await janeWithDossier(userId);
    await recordUsage(t.db, { userId, provider: 'anthropic', operation: 'compose', units: 1, costUsd: 1.5 });
    const r = await call<{ draft: { generatedBy: string } }>('/drafts/compose', token, {
      personId: jane,
      kind: 'first_touch',
      channel: 'gmail',
    });
    expect(r.status).toBe(200);
    expect(r.body.draft.generatedBy).toBe('template');
    expect(claude.requests).toHaveLength(0);
  });

  it('§13.8 test 4: repeated composes send the same cached instruction block and record cached reads', async () => {
    const claude = anthropic(() => ({ type: 'message', ...wrap(GOOD_FIRST_TOUCH) }));
    const call = api(t, fakeNet(claude.answer));
    const { userId, token } = await signedInUser(t);
    const jane = await janeWithDossier(userId);
    await call('/drafts/compose', token, { personId: jane, kind: 'first_touch', channel: 'gmail' });
    await call('/drafts/compose', token, { personId: jane, kind: 'first_touch', channel: 'gmail' });
    const [a, b] = claude.requests as AnthropicRequest[];
    expect(a!.system).toEqual(b!.system);
    expect(a!.system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    const rows = await t.db.sql<{ cost_usd: string }>`
      select cost_usd::text from orbit.usage_ledger where user_id = ${userId}::uuid and provider = 'anthropic' order by id`;
    expect(rows).toHaveLength(2);
    expect(Number(rows[1]!.cost_usd)).toBeLessThan(Number(rows[0]!.cost_usd));
  });
});

let wraps = 0;
/** First call writes the cache, later ones read it. */
function wrap(out: unknown) {
  const first = wraps++ === 0;
  return {
    id: 'msg_test',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: JSON.stringify(out) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: first
      ? {
          input_tokens: 400,
          output_tokens: 300,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 2000,
        }
      : {
          input_tokens: 400,
          output_tokens: 300,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 0,
        },
  };
}

describe('send window (§7.3)', () => {
  it('is the next Tue–Thu 8:00–10:30 in the recipient’s zone, Monday on LinkedIn, never a US holiday, with jitter', () => {
    // Friday 2026-10-16 15:00 UTC → Tuesday 2026-10-20 8:00 New York (12:00 UTC)
    const fri = new Date('2026-10-16T15:00:00Z');
    expect(nextSendWindow(fri, 'America/New_York', 'gmail', () => 0).notBefore).toBe(
      '2026-10-20T12:00:00.000Z',
    );
    expect(nextSendWindow(fri, 'America/New_York', 'linkedin', () => 0).notBefore).toBe(
      '2026-10-19T12:00:00.000Z',
    );
    // jitter: at most 20 minutes
    expect(nextSendWindow(fri, 'America/New_York', 'gmail', () => 0.999).notBefore).toBe(
      '2026-10-20T12:20:00.000Z',
    );
    // inside today's window: now plus jitter
    const wedEarly = new Date('2026-10-14T13:00:00Z'); // 9:00 New York
    expect(nextSendWindow(wedEarly, 'America/New_York', 'gmail', () => 0).notBefore).toBe(
      '2026-10-14T13:00:00.000Z',
    );
    // Wednesday 2026-11-11 (Veterans Day) is skipped
    expect(sendDayAllowed('2026-11-11', 'gmail')).toBe(false);
    expect(
      nextSendWindow(new Date('2026-11-10T20:00:00Z'), 'America/New_York', 'gmail', () => 0).notBefore,
    ).toBe('2026-11-12T13:00:00.000Z');
    // the recipient's zone and DST: Los Angeles, after the November change (UTC−8)
    expect(
      nextSendWindow(new Date('2026-11-06T20:00:00Z'), 'America/Los_Angeles', 'gmail', () => 0).notBefore,
    ).toBe('2026-11-10T16:00:00.000Z');
  });
});
