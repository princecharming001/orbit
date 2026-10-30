/**
 * Draft simulation: 44 deterministic student personas (schools from elite to community college and abroad, majors
 * from CS to art history, first-years to PhDs, goals from SWE recruiting to fundraising and finding a co-founder,
 * resumes from rich to empty, own-words answers from detailed to blank, typo-ridden, non-native or emoji, and
 * never rules) x 6 recipient archetypes x 13 message scenarios, all through the real template writer (no network,
 * no LLM), each graded by the validator and a reply-likelihood rubric (./rubric.ts).
 *
 * Hard checks (fail the run): validator-blocking issues and placeholders, except the ones recorded in
 * ./known.ts, which run as `it.fails` so a fix shows up as a failure to clear from the list. Rubric misses are
 * collected and printed (pass rates, persona x scenario table, the 15 worst drafts), never thrown.
 *
 * Run: cd packages/core && npx vitest run src/__tests__/sim-drafts
 * Full per-draft JSON: SIM_OUT=/some/dir npx vitest run src/__tests__/sim-drafts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateDraft } from '../../drafts/templates';
import { buildContext, RECIPIENTS, SCENARIOS, type ScenarioId } from './harness';
import { KNOWN_HARD } from './known';
import { buildPersonas } from './personas';
import { type Graded, grade, RUBRIC_IDS, type RubricId, WEIGHT } from './rubric';

const personas = buildPersonas();
const results: Graded[] = [];
for (const p of personas)
  for (const r of RECIPIENTS)
    for (const s of SCENARIOS) {
      // a student raising money or looking for a co-founder has no application to ask a referral for
      if (s === 'referral_ask' && ['fundraising', 'cofounder'].includes(p.goal.id)) continue;
      const b = buildContext(p, r, s);
      results.push(grade(b, generateDraft(b.ctx)));
    }

const keyOf = (g: Graded) => `${g.persona.id}/${g.recipient}/${g.scenario}`;
const hardOf = (g: Graded) =>
  [g.grade.blocking, g.grade.placeholder]
    .filter((c) => c.pass === false)
    .map((c) => c.detail)
    .join(' | ');

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '-');

describe('draft simulation: hard checks', () => {
  it('covers at least 40 personas and every scenario', () => {
    expect(personas.length).toBeGreaterThanOrEqual(40);
    expect(new Set(results.map((r) => r.scenario)).size).toBe(SCENARIOS.length);
  });
  for (const p of personas)
    it(`${p.id} ${p.label}: nothing blocks and no placeholder`, () => {
      const bad = results
        .filter((g) => g.persona.id === p.id && !KNOWN_HARD.has(keyOf(g)))
        .filter((g) => g.grade.blocking.pass === false || g.grade.placeholder.pass === false)
        .map((g) => `${keyOf(g)}: ${hardOf(g)}\n${g.draft.body}`);
      expect(bad, bad.join('\n\n')).toEqual([]);
    });
  // recorded failures: each still fails today; when one is fixed this flips and it should leave known.ts
  for (const k of KNOWN_HARD)
    it.fails(`known: ${k}`, () => {
      const g = results.find((x) => keyOf(x) === k);
      expect(g, `${k} not generated`).toBeDefined();
      expect(hardOf(g!)).toBe('');
    });
});

describe('draft simulation: reply-likelihood rubric (informative)', () => {
  it('prints pass rates, the persona x scenario table and the worst drafts', () => {
    const out: string[] = [];
    out.push(
      `\n# Draft simulation: ${personas.length} personas x ${RECIPIENTS.length} recipients x ${SCENARIOS.length} scenarios = ${results.length} drafts (no referral ask for fundraising or co-founder goals)\n`,
    );

    // pass rate per rubric item, overall and per scenario
    const head = [
      'item',
      'weight',
      'overall',
      ...SCENARIOS.map((s) => s.replace('outreach_', 'out_').replace('reply_', 're_')),
    ];
    out.push(head.join(' | '));
    out.push(head.map(() => '---').join(' | '));
    const rates: Record<string, { pass: number; n: number }> = {};
    for (const id of RUBRIC_IDS) {
      const row = [id, String(WEIGHT[id])];
      const app = results.filter((g) => g.grade[id].pass !== null);
      const pass = app.filter((g) => g.grade[id].pass).length;
      rates[id] = { pass, n: app.length };
      row.push(`${pct(pass, app.length)} (${app.length})`);
      for (const s of SCENARIOS) {
        const a = app.filter((g) => g.scenario === s);
        row.push(pct(a.filter((g) => g.grade[id].pass).length, a.length));
      }
      out.push(row.join(' | '));
    }

    // persona x scenario: share of applicable checks passed (6 recipients each), and the most common miss
    out.push('\n## Persona x scenario (checks passed across the 6 recipients; most common miss)\n');
    const abbr = (s: ScenarioId) =>
      s
        .replace('outreach_', 'o_')
        .replace('reply_question_llm', 'r_q_llm')
        .replace('reply_', 'r_')
        .slice(0, 12);
    out.push(['persona', ...SCENARIOS.map(abbr)].join(' | '));
    out.push(['---', ...SCENARIOS.map(() => '---')].join(' | '));
    for (const p of personas) {
      const row = [
        `${p.id} ${p.label.split(' · ').slice(0, 2).join('/')}/${p.goal.id}/${p.resumeLevel}/${p.wordsStyle}`,
      ];
      for (const s of SCENARIOS) {
        const gs = results.filter((g) => g.persona.id === p.id && g.scenario === s);
        let pass = 0;
        let n = 0;
        const miss = new Map<RubricId, number>();
        for (const g of gs)
          for (const id of RUBRIC_IDS) {
            if (id === 'compose_v2' || g.grade[id].pass === null) continue;
            n++;
            if (g.grade[id].pass) pass++;
            else miss.set(id, (miss.get(id) ?? 0) + 1);
          }
        const top = [...miss.entries()].sort((a, b) => b[1] - a[1] || WEIGHT[b[0]] - WEIGHT[a[0]])[0];
        row.push(`${pct(pass, n)}${top ? ` ${top[0]}` : ''}`);
      }
      out.push(row.join(' | '));
    }

    // failure details by item: the most common reasons
    out.push('\n## Most common reasons per item\n');
    for (const id of RUBRIC_IDS) {
      const reasons = new Map<string, number>();
      for (const g of results)
        if (g.grade[id].pass === false) {
          const d = (g.grade[id].detail ?? '').replace(/\d+/g, '#').slice(0, 110);
          reasons.set(d, (reasons.get(d) ?? 0) + 1);
        }
      if (!reasons.size) continue;
      out.push(
        `- ${id}: ${[...reasons.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([d, n]) => `${n}x ${d}`)
          .join(' || ')}`,
      );
    }

    // worst 15, one per persona+scenario so the list is not one template 6 times
    out.push('\n## Worst 15 drafts\n');
    // spread over scenarios and recipients (at most 2 per scenario, 4 per recipient, 1 per persona+scenario)
    const perS = new Map<string, number>();
    const perR = new Map<string, number>();
    const seen = new Set<string>();
    const worst = [...results]
      .sort((a, b) => b.score - a.score || keyOf(a).localeCompare(keyOf(b)))
      .filter((g) => {
        const k = `${g.persona.id}/${g.scenario.replace('outreach_linkedin', 'outreach_email')}`;
        if (seen.has(k) || (perS.get(g.scenario) ?? 0) >= 2 || (perR.get(g.recipient) ?? 0) >= 4)
          return false;
        seen.add(k);
        perS.set(g.scenario, (perS.get(g.scenario) ?? 0) + 1);
        perR.set(g.recipient, (perR.get(g.recipient) ?? 0) + 1);
        return true;
      })
      .slice(0, 15);
    for (const g of worst) {
      const fails = RUBRIC_IDS.filter((id) => g.grade[id].pass === false).map(
        (id) => `  - ${id} (${WEIGHT[id]}): ${g.grade[id].detail ?? ''}`,
      );
      out.push(
        `### ${keyOf(g)} -> written as ${g.draft.kind} (score ${g.score})\n${g.persona.label} | never: ${g.persona.never.text || '-'} | to ${g.draft.kind === 'reply' || g.scenario.startsWith('reply') ? 'thread' : g.ctx.person.fullName}${g.ctx.person.title ? `, ${g.ctx.person.title} at ${g.ctx.person.org}` : ''}`,
      );
      if (g.draft.subject) out.push(`Subject: ${g.draft.subject}`);
      out.push('```');
      out.push(g.draft.body);
      if (g.draft.bodyShort) out.push(`--- note (${g.draft.bodyShort.length} chars): ${g.draft.bodyShort}`);
      out.push('```');
      out.push(fails.join('\n'));
      out.push('');
    }
    const text = out.join('\n');
    console.log(text);
    const dir = process.env.SIM_OUT;
    if (dir) {
      writeFileSync(join(dir, 'sim-drafts-summary.md'), text);
      writeFileSync(
        join(dir, 'sim-drafts-results.json'),
        JSON.stringify(
          results.map((g) => ({
            key: keyOf(g),
            persona: g.persona.label,
            never: g.persona.never.text,
            writtenAs: g.draft.kind,
            subject: g.draft.subject,
            body: g.draft.body,
            bodyShort: g.draft.bodyShort,
            score: g.score,
            fails: Object.fromEntries(
              RUBRIC_IDS.filter((id) => g.grade[id].pass === false).map((id) => [id, g.grade[id].detail]),
            ),
          })),
          null,
          1,
        ),
      );
      writeFileSync(join(dir, 'sim-drafts-rates.json'), JSON.stringify(rates, null, 1));
    }
    expect(results.length).toBeGreaterThan(personas.length * RECIPIENTS.length * (SCENARIOS.length - 1));
  });
});
