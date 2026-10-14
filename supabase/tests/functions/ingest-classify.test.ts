/**
 * classify.message (§8.3, §8.6): the heuristic first, Haiku below 0.75 confidence when configured, and the effects
 * of a reply: the answered draft, do_not_contact on unsubscribe, and intro request outcomes (§4.3).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeClaude } from '../../functions/_shared/claude.ts';
import { defaultHandlers } from '../../functions/orbit-worker/worker.ts';
import { jsonRes, recordingFetch } from '../helpers/google.ts';
import { clearQueues, connectedUser, drain } from '../helpers/ingest.ts';
import { ago, NOW } from '../helpers/mailFixtures.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});
beforeEach(async () => {
  await clearQueues(t);
});

async function world() {
  const u = await connectedUser(t.db);
  const mk = async (name: string, email: string) => {
    const [p] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, name_norm, primary_email)
      values (${u}::uuid, ${name}, ${name.toLowerCase()}, ${email}) returning id`;
    return p!.id;
  };
  return { u, mk };
}

async function thread(u: string, ext: string) {
  const [th] = await t.db.sql<{ id: string }>`
    insert into orbit.threads (user_id, provider, external_id, is_networking) values (${u}::uuid, 'gmail', ${ext}, true)
    returning id`;
  return th!.id;
}

async function message(
  u: string,
  th: string,
  m: {
    ext: string;
    dir: 'in' | 'out';
    from?: string;
    body: string;
    at: string;
    rfc?: string;
    inReplyTo?: string;
  },
) {
  const [row] = await t.db.sql<{ id: string }>`
    insert into orbit.messages (user_id, thread_id, provider, external_id, rfc_message_id, in_reply_to, direction,
                                from_person_id, sent_at, body_text)
    values (${u}::uuid, ${th}::uuid, 'gmail', ${m.ext}, ${m.rfc ?? null}, ${m.inReplyTo ?? null}, ${m.dir},
            ${m.from ?? null}::uuid, ${m.at}::timestamptz, ${m.body})
    returning id`;
  return row!.id;
}

const classify = (u: string, messageId: string) =>
  t.db
    .sql`select orbit.enqueue('orbit_classify', ${{ kind: 'classify.message', userId: u, payload: { messageId } }}::jsonb, 0)`;

describe('classify.message', () => {
  it('marks the sent draft the reply answers, by In-Reply-To or thread', async () => {
    const { u, mk } = await world();
    const rae = await mk('Rae Moon', 'rae@moon.co');
    const th = await thread(u, 'T-rae');
    await message(u, th, {
      ext: 'g-sent-1',
      dir: 'out',
      body: 'Hi Rae!',
      at: ago(3),
      rfc: '<sent-1@mail.gmail.com>',
    });
    const [d] = await t.db.sql<{ id: string }>`
      insert into orbit.drafts (user_id, person_id, channel, kind, body, status, sent_at, provider_message_id)
      values (${u}::uuid, ${rae}::uuid, 'gmail', 'outreach', 'Hi Rae!', 'sent', ${ago(3)}::timestamptz, 'g-sent-1')
      returning id`;
    const reply = await message(u, th, {
      ext: 'g-in-1',
      dir: 'in',
      from: rae,
      body: 'Sure, how about Thursday at 3pm?',
      at: ago(2),
      inReplyTo: '<sent-1@mail.gmail.com>',
    });
    await classify(u, reply);
    await drain(t, defaultHandlers({}), () => new Date(NOW));
    const [m] = await t.db.sql<{
      reply_class: string;
      reply_confidence: number;
      extraction: { classifiedBy: string };
    }>`
      select reply_class, reply_confidence, extraction from orbit.messages where id = ${reply}::uuid`;
    expect(m).toMatchObject({ reply_class: 'scheduling', extraction: { classifiedBy: 'heuristic' } });
    expect(m!.reply_confidence).toBeGreaterThanOrEqual(0.75);
    const [draft] = await t.db.sql<{ replied_at: Date; reply_class: string }>`
      select replied_at, reply_class from orbit.drafts where id = ${d!.id}::uuid`;
    expect(draft!.reply_class).toBe('scheduling');
    expect(new Date(draft!.replied_at).toISOString()).toBe(ago(2));
  });

  it('moves an intro request to agreed on a referral, and to declined on a decline', async () => {
    const { u, mk } = await world();
    const ivy = await mk('Ivy Stone', 'ivy@stone.vc');
    const omar = await mk('Omar Haddad', 'omar@stripe.com');
    const th = await thread(u, 'T-ivy');
    await t.db.sql`
      insert into orbit.drafts (user_id, person_id, channel, kind, body, status, sent_at, thread_external_id)
      values (${u}::uuid, ${ivy}::uuid, 'gmail', 'intro_request', 'Would you introduce me to Omar?', 'sent',
              ${ago(4)}::timestamptz, 'T-ivy')`;
    const [req] = await t.db.sql<{ id: string }>`
      insert into orbit.intro_requests (user_id, target_person_id, introducer_person_id, path, path_score, rank, asked_at)
      values (${u}::uuid, ${omar}::uuid, ${ivy}::uuid, '{}'::jsonb, 0.5, 1, ${ago(4)}::timestamptz) returning id`;
    const reply = await message(u, th, {
      ext: 'g-ivy-1',
      dir: 'in',
      from: ivy,
      body: "Happy to introduce you to my colleague Omar Haddad at Stripe, I'll send a note today.",
      at: ago(3),
    });
    await classify(u, reply);
    await drain(t, defaultHandlers({}), () => new Date(NOW));
    const [r] = await t.db.sql<{ status: string; outcome_at: Date }>`
      select status, outcome_at from orbit.intro_requests where id = ${req!.id}::uuid`;
    expect(r!.status).toBe('agreed');
  });

  it('asks Haiku when the heuristic is unsure, and keeps the heuristic when Claude is not configured', async () => {
    const { u, mk } = await world();
    const zed = await mk('Zed Park', 'zed@park.io');
    const th = await thread(u, 'T-zed');
    await message(u, th, { ext: 'g-zed-0', dir: 'out', body: 'Could we talk this month?', at: ago(6) });
    const reply = await message(u, th, { ext: 'g-zed-1', dir: 'in', from: zed, body: 'ok', at: ago(5) });

    await classify(u, reply);
    await drain(t, defaultHandlers({}), () => new Date(NOW));
    const [h] = await t.db.sql<{ reply_class: string; extraction: { classifiedBy: string } }>`
      select reply_class, extraction from orbit.messages where id = ${reply}::uuid`;
    expect(h).toMatchObject({ reply_class: 'other', extraction: { classifiedBy: 'heuristic' } });

    const api = recordingFetch(() =>
      jsonRes(200, {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-5-5',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              class: 'not_now',
              confidence: 0.82,
              proposed_times: [],
              return_date: null,
              referred_people: [],
              question: null,
            }),
          },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 300, output_tokens: 40 },
      }),
    );
    const claude = makeClaude({ apiKey: 'sk-placeholder', fetch: api.fetch, db: t.db });
    await t.db.sql`delete from orbit.job_runs`;
    await classify(u, reply);
    await drain(t, defaultHandlers({ claude }), () => new Date(NOW));
    const [m] = await t.db.sql<{
      reply_class: string;
      reply_confidence: number;
      extraction: { classifiedBy: string };
    }>`
      select reply_class, reply_confidence, extraction from orbit.messages where id = ${reply}::uuid`;
    expect(m).toMatchObject({ reply_class: 'not_now', extraction: { classifiedBy: 'llm' } });
    expect(m!.reply_confidence).toBeCloseTo(0.82, 5);
    expect(api.calls).toHaveLength(1);
    const sent = JSON.parse(api.calls[0]!.body) as {
      model: string;
      system: { text: string }[];
      messages: { content: string }[];
    };
    expect(sent.model).toBe('claude-haiku-5-5');
    expect(sent.system[0]!.text).toContain('Classify the newest message in this thread');
    // oldest first, the user's message included, as the thread reads
    expect(sent.messages[0]!.content.indexOf('Could we talk')).toBeLessThan(
      sent.messages[0]!.content.indexOf('ok'),
    );
    const usage = await t.db
      .sql`select 1 from orbit.usage_ledger where user_id = ${u}::uuid and provider = 'anthropic'`;
    expect(usage).toHaveLength(1);
  });

  it('leaves outbound and automated messages alone', async () => {
    const { u, mk } = await world();
    const bot = await mk('Bot Person', 'bot@x.io');
    const th = await thread(u, 'T-bot');
    const out = await message(u, th, {
      ext: 'g-o',
      dir: 'out',
      body: 'Please remove me from your list',
      at: ago(1),
    });
    const auto = await message(u, th, { ext: 'g-a', dir: 'in', from: bot, body: 'Unsubscribe', at: ago(1) });
    await t.db.sql`update orbit.messages set is_automated = true where id = ${auto}::uuid`;
    await classify(u, out);
    await classify(u, auto);
    await drain(t, defaultHandlers({}), () => new Date(NOW));
    const rows = await t.db.sql<{ reply_class: string | null }>`
      select reply_class from orbit.messages where thread_id = ${th}::uuid`;
    expect(rows.every((r) => r.reply_class === null)).toBe(true);
    const [p] = await t.db.sql<{
      do_not_contact: boolean;
    }>`select do_not_contact from orbit.people where id = ${bot}::uuid`;
    expect(p!.do_not_contact).toBe(false);
  });
});
