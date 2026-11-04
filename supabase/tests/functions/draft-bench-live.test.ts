/**
 * The student draft bench (plan 30): realistic students in the three most common Orbit situations, each through the
 * real server path a signed-in student uses: their stated goal read by the real goal inference, then a first message,
 * a follow-up after a week of silence and a reply to the recipient's answer, each from the real composeDraft against
 * the real Claude API, then graded by a separate Claude judge on a per-niche rubric written from public guidance
 * (specificity, the niche's norms, the right ask, length, tone). Run by hand, never in CI:
 *
 *   ORBIT_DRAFT_BENCH=1 ANTHROPIC_API_KEY=… DRAFT_BENCH_OUT=/abs/dir \
 *     pnpm --filter @orbit/supabase-tests exec vitest run functions/draft-bench-live.test.ts
 *
 * DRAFT_BENCH_ONLY=id1,id2 runs a few personas. The key is read from the environment only and never written anywhere.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeDraft } from '../../functions/_shared/compose/compose.ts';
import { inferGoals } from '../../functions/_shared/goals/infer.ts';
import { makeServices } from '../../functions/_shared/services.ts';
import {
  addPerson,
  addThread,
  agentConfig,
  fakeNet,
  jsonRes,
  type NetCall,
  signedInUser,
} from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';
import { BENCH_PERSONAS, type BenchPersona, NICHE_NORMS, type Niche } from './draft-bench-personas.ts';

const LIVE = !!process.env.ORBIT_DRAFT_BENCH && !!process.env.ANTHROPIC_API_KEY;
const NOW = new Date('2026-11-03T16:00:00Z');
const DAY = 86_400_000;
const JUDGE_MODEL = 'claude-sonnet-5-5';

/** Anthropic answered by the real API with the request as the server built it; Google calls fail closed. */
function liveNet() {
  return fakeNet(
    (c: NetCall) =>
      c.url.startsWith('https://api.anthropic.com/')
        ? fetch(c.url, { method: c.method, headers: c.headers, body: JSON.stringify(c.body) })
        : undefined,
    // a connected calendar with the student free all week, so a reply can offer real times
    (c: NetCall) =>
      c.url === 'https://oauth2.googleapis.com/token'
        ? jsonRes(200, { access_token: 'ya29.bench', expires_in: 3600, token_type: 'Bearer' })
        : c.url === 'https://www.googleapis.com/calendar/v3/freeBusy'
          ? jsonRes(200, { calendars: { primary: { busy: [] } } })
          : undefined,
  );
}

type Step = 'first' | 'follow_up' | 'reply';
interface Graded {
  persona: string;
  niche: Niche;
  step: Step;
  goalKind: string;
  subject: string | null;
  body: string;
  generatedBy: string;
  words: number;
  scores: Record<'specificity' | 'norms' | 'ask' | 'length' | 'tone', number>;
  pass: boolean;
  notes: string;
  fix: string;
  /** why the model's drafts were refused before the template went out, from the audit log */
  refused?: string[];
}

const DIMS = ['specificity', 'norms', 'ask', 'length', 'tone'] as const;

const JUDGE_SYSTEM = [
  'You grade one networking message a college student is about to send, as a blunt career coach who has read thousands that worked and failed.',
  'Score five dimensions from 1 to 3 (3 = what a top coach would send, 2 = fine with a small flaw, 1 = would hurt the reply odds):',
  '- specificity: it names something concrete and true about this recipient (from the facts given) and something concrete about the student; it could not be sent to anyone else unchanged.',
  '- norms: it follows the norms of this niche and this step, given below. Breaking a hard norm is a 1.',
  '- ask: exactly one clear ask, the right one for this niche and step, easy to say yes to, with no pressure.',
  '- length: right for the step (first message about 70 to 150 words, research emails may reach 180; a follow-up under 70; a reply proportionate to what they said). Too long is a 1 when it is over by half.',
  '- tone: sounds like a real student of this year writing in their own voice: humble but not groveling, no clichés, no flattery, no filler, no AI-sounding phrasing, no em dashes. A claim the facts do not support (an attachment that does not exist, a shared history, an achievement the student did not mention) is a 1.',
  'Return only JSON: {"specificity":n,"norms":n,"ask":n,"length":n,"tone":n,"notes":"<=60 words on what is weak, quoting the message","fix":"<=30 words: the one change that helps most"}.',
].join('\n');

async function judgeDraft(
  p: BenchPersona,
  step: Step,
  subject: string | null,
  body: string,
  context: string,
) {
  const user = [
    `<niche>${p.niche}</niche>`,
    `<norms>\n${NICHE_NORMS[p.niche]}\n</norms>`,
    `<step>${step === 'first' ? 'first message (cold or warm first touch)' : step === 'follow_up' ? 'follow-up after 8 days with no reply' : 'reply to their answer'}</step>`,
    `<student>\n${p.studentSummary}\nIn their own words: ${Object.entries(p.about)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' | ')}${p.resume ? `\nResume: ${p.resume.text}` : ''}\n</student>`,
    `<recipient>\n${p.recipient.name}, ${p.recipient.title} at ${p.recipient.org}. Facts: ${p.recipient.facts.join(' | ')}\n</recipient>`,
    context ? `<their_message>\n${context}\n</their_message>` : '',
    `<message>\nSubject: ${subject ?? '(reply in thread)'}\n\n${body}\n</message>`,
  ]
    .filter(Boolean)
    .join('\n');
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        max_tokens: 1200,
        system: JUDGE_SYSTEM,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) continue;
    const j = (await res.json()) as { content: { type: string; text?: string }[] };
    const text = j.content.find((c) => c.type === 'text')?.text ?? '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) continue;
    try {
      const v = JSON.parse(m[0]) as Record<string, unknown>;
      const scores = Object.fromEntries(DIMS.map((d) => [d, Number(v[d]) || 1])) as Graded['scores'];
      return { scores, notes: String(v.notes ?? ''), fix: String(v.fix ?? '') };
    } catch {}
  }
  return {
    scores: Object.fromEntries(DIMS.map((d) => [d, 0])) as Graded['scores'],
    notes: 'judge returned no verdict',
    fix: '',
  };
}

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

const only = (process.env.DRAFT_BENCH_ONLY ?? '').split(',').filter(Boolean);
const personas = only.length ? BENCH_PERSONAS.filter((p) => only.includes(p.id)) : BENCH_PERSONAS;
const graded: Graded[] = [];

/** The student's account: profile, own words, resume and the goal their stated aim infers to. */
async function seedStudent(s: ReturnType<typeof makeServices>, p: BenchPersona) {
  const { userId } = await signedInUser(t, { firstName: p.firstName, settings: { about: p.about } });
  await t.db.sql`
    update orbit.users set full_name = ${p.fullName}, school = ${p.school}, grad_year = ${p.gradYear},
           degree = ${p.degree}, majors = ${p.majors}::text[], current_city = ${p.city ?? null}
     where id = ${userId}::uuid`;
  if (p.resume)
    await t.db.sql`
      insert into orbit.uploads (user_id, kind, filename, text, parsed, is_current)
      values (${userId}::uuid, 'resume', 'resume.pdf', ${p.resume.text}, ${{ facets: p.resume.facets }}::jsonb, true)`;
  const proposed = await inferGoals(s.claude, userId, [{ role: 'user', text: p.statedGoal }]);
  const g = proposed[0];
  const kind = g?.kind ?? 'advice';
  const [row] = await t.db.sql<{ id: string }>`
    insert into orbit.goals (user_id, kind, title, targets, criteria)
    values (${userId}::uuid, ${kind}, ${g?.title ?? p.statedGoal.slice(0, 60)},
            ${g?.targets ?? { organizations: [], roles: [], geographies: [], people: [] }}::jsonb,
            ${g?.criteria ?? {}}::jsonb)
    returning id`;
  return { userId, goalId: row!.id, goalKind: kind };
}

/** A fresh copy of the recipient (each step gets its own history), with what research found about them. */
async function seedRecipient(userId: string, p: BenchPersona, copy = 0) {
  const r = p.recipient;
  const id = await addPerson(t, userId, {
    name: r.name,
    org: r.org,
    title: r.title,
    email: copy ? r.email.replace('@', `+${copy}@`) : r.email,
    timezone: 'America/New_York',
    ...(r.score !== undefined ? { score: r.score } : {}),
  });
  if (r.alum) await t.db.sql`update orbit.people set is_alumni = true where id = ${id}::uuid`;
  for (const f of r.facts)
    await t.db.sql`
      insert into orbit.facts (user_id, person_id, type, text) values (${userId}::uuid, ${id}::uuid, 'research', ${f})`;
  return id;
}

describe.skipIf(!LIVE)('student draft bench against the real API (plan 30)', () => {
  for (const p of personas)
    it(`${p.id}: ${p.niche}`, async () => {
      const net = liveNet();
      const s = makeServices(agentConfig(net, { anthropicKey: process.env.ANTHROPIC_API_KEY! }), {
        db: t.db,
        now: () => NOW,
      });
      const { userId, goalId, goalKind } = await seedStudent(s, p);
      const record = async (step: Step, r: Awaited<ReturnType<typeof composeDraft>>, context = '') => {
        const v = await judgeDraft(p, step, r.composed.subject, r.composed.body, context);
        const vals = DIMS.map((d) => v.scores[d]);
        graded.push({
          persona: p.id,
          niche: p.niche,
          step,
          goalKind,
          subject: r.composed.subject,
          body: r.composed.body,
          generatedBy: r.draft.generated_by ?? '',
          words: r.composed.body.split(/\s+/).filter(Boolean).length,
          scores: v.scores,
          pass: vals.every((x) => x >= 2) && vals.reduce((a, b) => a + b, 0) / vals.length >= 2.5,
          notes: v.notes,
          fix: v.fix,
          refused: (
            await t.db.sql<{ d: { detail?: string[] } }>`
              select details as d from orbit.audit_log where target_id = ${r.draft.id} and action = 'draft.compose'`
          )[0]?.d.detail,
        });
      };

      // 1. the first message
      const first = await composeDraft(s, {
        userId,
        personId: await seedRecipient(userId, p),
        kind: p.firstKind ?? 'first_touch',
        channel: 'gmail',
        goalId,
        ...(p.topic ? { topic: p.topic } : {}),
      });
      await record('first', first);

      // 2. a follow-up eight days after that message went unanswered
      const quiet = await seedRecipient(userId, p, 1);
      await addThread(
        t,
        userId,
        quiet,
        [
          {
            direction: 'out',
            at: new Date(NOW.getTime() - 8 * DAY).toISOString(),
            body: first.composed.body,
          },
        ],
        { subject: first.composed.subject ?? 'Hello' },
      );
      await record(
        'follow_up',
        await composeDraft(s, { userId, personId: quiet, kind: 'bump', channel: 'gmail', goalId }),
      );

      // 3. a reply to what they wrote back
      const answered = await seedRecipient(userId, p, 2);
      const th = await addThread(
        t,
        userId,
        answered,
        [
          {
            direction: 'out',
            at: new Date(NOW.getTime() - 3 * DAY).toISOString(),
            body: first.composed.body,
          },
          {
            direction: 'in',
            at: new Date(NOW.getTime() - DAY).toISOString(),
            body: p.theirReply.body,
            replyClass: p.theirReply.replyClass,
          },
        ],
        { subject: first.composed.subject ?? 'Hello' },
      );
      if (p.theirReply.answer)
        await t.db
          .sql`update orbit.messages set answer = ${p.theirReply.answer} where id = ${th.messageIds[1]!}::uuid`;
      await record(
        'reply',
        await composeDraft(s, {
          userId,
          personId: answered,
          kind: 'reply',
          channel: 'gmail',
          goalId,
          replyToMessageId: th.messageIds[1]!,
        }),
        p.theirReply.body,
      );
      expect(graded.filter((g) => g.persona === p.id)).toHaveLength(3);
    }, 240_000);

  it('writes the report', () => {
    const out = process.env.DRAFT_BENCH_OUT;
    const byNiche = new Map<string, Graded[]>();
    for (const g of graded) byNiche.set(g.niche, [...(byNiche.get(g.niche) ?? []), g]);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const lines: string[] = [];
    lines.push(`drafts: ${graded.length}, pass ${graded.filter((g) => g.pass).length}`);
    for (const [niche, gs] of byNiche) {
      lines.push(
        `${niche}: pass ${gs.filter((g) => g.pass).length}/${gs.length}; ${DIMS.map((d) => `${d} ${mean(gs.map((g) => g.scores[d])).toFixed(2)}`).join('  ')}`,
      );
      for (const st of ['first', 'follow_up', 'reply'] as const) {
        const x = gs.filter((g) => g.step === st);
        lines.push(`  ${st}: pass ${x.filter((g) => g.pass).length}/${x.length}`);
      }
    }
    const md = graded
      .map(
        (g) =>
          `## ${g.persona} · ${g.step} · ${g.pass ? 'PASS' : 'FAIL'} (goal ${g.goalKind}, ${g.generatedBy}, ${g.words} words)\n${DIMS.map((d) => `${d} ${g.scores[d]}`).join('  ')}\nnotes: ${g.notes}\nfix: ${g.fix}${g.refused?.length ? `\nrefused: ${g.refused.join(' | ')}` : ''}\n\nSubject: ${g.subject ?? '(reply)'}\n\n${g.body}\n`,
      )
      .join('\n');
    console.log(lines.join('\n'));
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'drafts.json'), JSON.stringify(graded, null, 2));
      writeFileSync(join(out, 'drafts.md'), `${lines.join('\n')}\n\n${md}`);
    }
    expect(graded.length).toBe(personas.length * 3);
  });
});
