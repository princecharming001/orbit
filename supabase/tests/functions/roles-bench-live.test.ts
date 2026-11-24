/**
 * The Roles bench (plan 44 §6.7): made-up people (fixtures/roles/profiles.json) read by the real profile reading,
 * then scored against real postings captured from public job boards (fixtures/roles/postings.json) by the real
 * requirements read and close read, through the real server path: the real intake keeps each posting, `scoreOne`
 * reads and scores it. Each pair has the band a careful recruiter would give it on paper, written by hand before the
 * run (fixtures/roles/expected.json). The bench prints the table of expected against got and holds the score to the
 * bar in §6.7:
 *
 *   - at least 75% of pairs land in the expected band, and at least 95% within one band of it
 *   - no pair with a cap shows as a good or strong fit
 *   - at least three of the four bands appear
 *   - every pair is read (none left "Not read closely yet"), no requirement is a trait (communication, curiosity),
 *     and a requirement that accepts alternatives ("Figma/Canva") counts when the person has one of them
 *
 * Run by hand, never in CI, and never with an API key: every model call goes through the developer's own Claude
 * login.
 *
 *   # through a running shim (node scripts/claude-cli-shim.mjs with SHIM_PORT=8791 SHIM_CONCURRENCY=9)
 *   ORBIT_ROLES_BENCH=1 ROLES_BENCH_SHIM=http://127.0.0.1:8791 \
 *     pnpm --filter @orbit/supabase-tests exec vitest run functions/roles-bench-live.test.ts
 *
 *   # or through the local `claude` command line, called per request (as draft-bench-live.test.ts does)
 *   ORBIT_ROLES_BENCH=1 ROLES_BENCH_VIA=cli \
 *     pnpm --filter @orbit/supabase-tests exec vitest run functions/roles-bench-live.test.ts
 *
 * ROLES_BENCH_ONLY=id1,id2 runs a few people, ROLES_BENCH_POSTINGS=id1,id2 a few postings (the bar is then only
 * printed, not held). ROLES_BENCH_PARALLEL is how many pairs are read at once (8; keep it under the shim's own
 * limit). ROLES_BENCH_OUT=<file> also writes the table there. CLAUDE_BIN points at a command line new enough for the
 * models used.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bandOf } from '../../../packages/core/src/roles/fit.ts';
import type {
  FitBand,
  JobListing,
  JobSource,
  ProfileLines,
  RoleMatch,
  RoleProfile,
} from '../../../packages/core/src/roles/types.ts';
import type { RoleSources } from '../../functions/_shared/roles/contracts.ts';
import { keep } from '../../functions/_shared/roles/intake.ts';
import { readProfile, saveProfile } from '../../functions/_shared/roles/profile.ts';
import { isSoftSkill, ROLE_TIMEOUTS } from '../../functions/_shared/roles/score.ts';
import { scoreOne } from '../../functions/_shared/roles/search.ts';
import { makeServices } from '../../functions/_shared/services.ts';
import { agentConfig, fakeNet, type NetCall, signedInUser } from '../helpers/agents.ts';
import { cliMessages, cliTotals } from '../helpers/cli-anthropic.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

const VIA_CLI = process.env.ROLES_BENCH_VIA === 'cli';
const SHIM = process.env.ROLES_BENCH_SHIM?.replace(/\/+$/, '');
const LIVE = !!process.env.ORBIT_ROLES_BENCH && (VIA_CLI || !!SHIM);
const list = (v: string | undefined) => (v ?? '').split(',').filter(Boolean);
const ONLY = list(process.env.ROLES_BENCH_ONLY);
const ONLY_POSTINGS = list(process.env.ROLES_BENCH_POSTINGS);
const PARALLEL = Math.max(1, Number(process.env.ROLES_BENCH_PARALLEL ?? 8));
const WHOLE = !ONLY.length && !ONLY_POSTINGS.length;

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/roles/${name}`, import.meta.url), 'utf8'));
const PROFILES: { profiles: { id: string; about: string; lines: ProfileLines }[] } = fixture('profiles.json');
interface Posting {
  id: string;
  source: JobSource;
  company: string;
  title: string;
  location: string;
  url: string;
  text: string;
}
const POSTINGS: { postings: Posting[] } = fixture('postings.json');
/** The recruiter's band for each pair; a pair not named is out. */
const EXPECTED: { bands: Record<string, Record<string, FitBand>> } = fixture('expected.json');

const BANDS: FitBand[] = ['out', 'stretch', 'good', 'strong'];
const expectedOf = (student: string, posting: string): FitBand => EXPECTED.bands[student]?.[posting] ?? 'out';

/** Anthropic answered by the developer's own login; nothing else is reachable. */
function liveNet() {
  return fakeNet((c: NetCall) => {
    if (!c.url.startsWith('https://api.anthropic.com/')) return undefined;
    if (VIA_CLI) return cliMessages(c.body as Parameters<typeof cliMessages>[0]);
    // the shim answers the Messages API; no key is sent
    return fetch(`${SHIM}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(c.body),
    });
  });
}

/**
 * The source side as the bench needs it: the real intake keeps each posting (so its level, term and places are read
 * as in production), its text is the fixture's, and a posting's link is answered from the fixtures.
 */
const benchSources: RoleSources = {
  keep,
  async text(db, _net, jobId) {
    const [r] = await db.sql<{
      text: string | null;
    }>`select text from orbit_private.jobs where id = ${jobId}::uuid`;
    return r?.text ?? undefined;
  },
  linkedinSearch: async () => [],
  async readUrl(_net, url) {
    const p = POSTINGS.postings.find((x) => x.url === url);
    if (!p) return { problem: 'not in the fixtures' };
    return {
      source: p.source,
      externalId: p.id,
      companyName: p.company,
      title: p.title,
      locations: p.location
        .split(/;\s*/)
        .map((x) => x.trim())
        .filter(Boolean),
      url: p.url,
      text: p.text,
    } satisfies JobListing;
  },
};

/** Run `jobs` with at most `n` going at once, in order of starting. */
async function pool<T>(n: number, jobs: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]!();
      }
    }),
  );
  return out;
}

interface Row {
  student: string;
  posting: string;
  title: string;
  expected: FitBand;
  got?: FitBand;
  score?: number;
  raw?: number;
  caps: string[];
  match?: RoleMatch;
  problem?: string;
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));

describe.skipIf(!LIVE)('Roles bench (live, through the CLI)', () => {
  let t: TestDb;
  // the command line starts slowly: its calls get the time a live API call never needs
  if (LIVE) Object.assign(ROLE_TIMEOUTS, { text: 30_000, requirements: 240_000, score: 240_000 });

  beforeAll(async () => {
    t = await freshDb();
  });
  afterAll(async () => {
    await t?.pg.close();
    console.log(`model calls: ${cliTotals.calls}, tokens in ${cliTotals.input}, out ${cliTotals.output}`);
  });

  it('every pair lands where a careful recruiter would put it', async () => {
    const students = PROFILES.profiles.filter((p) => !ONLY.length || ONLY.includes(p.id));
    const postings = POSTINGS.postings.filter((p) => !ONLY_POSTINGS.length || ONLY_POSTINGS.includes(p.id));
    const net = liveNet();
    // a placeholder key makes the client; every request goes to the CLI or the shim, never to Anthropic
    const s = makeServices(agentConfig(net, { anthropicKey: 'sk-ant-bench-placeholder' }), { db: t.db });
    const deps = { sources: benchSources };

    // 1. each person's profile, read from their lines by the real reading and saved as they would confirm it
    const people = await pool(
      PARALLEL,
      students.map((student) => async () => {
        const u = await signedInUser(t);
        const read = await readProfile(s, u.userId, student.lines);
        const proposed = read.proposed!;
        const profile: RoleProfile = { ...proposed, kinds: proposed.kinds.map((k) => ({ ...k, on: true })) };
        await saveProfile(t.db, u.userId, profile, new Date());
        return { student, userId: u.userId, profile, note: read.note };
      }),
    );
    for (const p of people)
      console.log(
        `\n== ${p.student.id} (${p.profile.level}${p.profile.graduation ? `, graduating ${p.profile.graduation}` : ''}, ${p.profile.fullTimeMonths} months full-time): ${p.student.about}`,
        p.note ? `\n   note: ${p.note}` : '',
        `\n   skills: ${p.profile.skills.map((k) => `${k.name}${k.from === 'read' ? '*' : ''}`).join(', ')}`,
        `\n   kinds: ${p.profile.kinds.map((k) => k.title).join(' | ')}`,
      );

    const score = async (who: (typeof people)[number], p: Posting): Promise<Row> => {
      const row: Row = {
        student: who.student.id,
        posting: p.id,
        title: p.title,
        expected: expectedOf(who.student.id, p.id),
        caps: [],
      };
      try {
        const r = await scoreOne(s, deps, who.userId, { url: p.url });
        row.match = r.match;
        row.problem = r.problem;
        const f = r.match?.fit;
        if (f) {
          row.got = f.band;
          row.score = f.score;
          row.raw = f.raw;
          row.caps = f.caps.map((c) => c.label);
        }
      } catch (e) {
        row.problem = e instanceof Error ? e.message : String(e);
      }
      return row;
    };

    // 2. the first person reads every posting, so its requirements are read once and kept for the others
    const first = await pool(
      PARALLEL,
      postings.map((p) => () => score(people[0]!, p)),
    );
    // 3. everyone else, a few pairs at a time
    const rest = await pool(
      PARALLEL,
      people.slice(1).flatMap((who) => postings.map((p) => () => score(who, p))),
    );
    const rows = [...first, ...rest];

    // ---- what each pair rests on, for a person to read -------------------------------------------------------------
    const lines: string[] = [];
    for (const who of people) {
      lines.push(`\n== ${who.student.id}: ${who.student.about}`);
      for (const r of rows.filter((x) => x.student === who.student.id)) {
        const m = r.match;
        const f = m?.fit;
        const parts = f
          ? Object.entries(f.parts)
              .map(([k, v]) => `${k} ${Math.round((v ?? 0) * 100)}%`)
              .join(', ')
          : 'not read';
        const mark = !r.got ? '??' : r.got === r.expected ? 'ok' : 'XX';
        lines.push(
          `   ${mark} ${pad(r.title, 52)} expected ${pad(r.expected, 7)} got ${f ? `${f.score}/10 ${f.band} (raw ${f.raw})` : `no score: ${r.problem ?? 'not read'}`}; ${parts}`,
        );
        if (f?.caps.length) lines.push(`        caps: ${f.caps.map((c) => c.label).join('; ')}`);
        if (m?.answers && (r.got !== r.expected || r.expected !== 'out')) {
          lines.push(
            `        skills: ${m.answers.skills.map((x) => `${x.name} ${x.need} ${x.answer}`).join(', ') || 'none asked'}`,
            `        experience ${m.answers.experience.answer}, education ${m.answers.education.answer}, level ${m.answers.level.answer}`,
          );
          if (m.reason) lines.push(`        why: ${m.reason}`);
          if (m.gaps?.length) lines.push(`        gaps: ${m.gaps.join('; ')}`);
        }
      }
    }

    // ---- the table: people down, postings across ---------------------------------------------------------------------
    const short: Record<FitBand, string> = { strong: 'STRONG', good: 'good', stretch: 'stretch', out: '.' };
    const cell = (r: Row) => {
      const got = r.got ? `${short[r.got]}${r.got === 'out' ? '' : ` ${r.score}`}` : '??';
      return r.got === r.expected
        ? got
        : `${got} (want ${short[r.expected] === '.' ? 'out' : short[r.expected]})`;
    };
    const table: string[] = [
      '',
      'Expected against got. "." is out and expected out; a cell that differs says what was wanted.',
      '',
    ];
    for (const p of postings) table.push(`  ${pad(p.id, 24)} ${p.title} (${p.company})`);
    table.push('');
    for (const who of people) {
      table.push(`${who.student.id} (${who.profile.level})`);
      for (const r of rows.filter((x) => x.student === who.student.id))
        if (r.got !== r.expected || r.expected !== 'out') table.push(`    ${pad(r.posting, 24)} ${cell(r)}`);
    }

    // ---- the bar (§6.7) ----------------------------------------------------------------------------------------------------
    const read = rows.filter((r) => r.got);
    const exact = read.filter((r) => r.got === r.expected);
    const near = read.filter((r) => Math.abs(BANDS.indexOf(r.got!) - BANDS.indexOf(r.expected)) <= 1);
    const fits = rows.filter((r) => r.expected !== 'out');
    const fitsExact = fits.filter((r) => r.got === r.expected);
    const fitsNear = fits.filter(
      (r) => r.got && Math.abs(BANDS.indexOf(r.got) - BANDS.indexOf(r.expected)) <= 1,
    );
    const cappedHigh = rows.filter((r) => r.caps.length && (r.got === 'good' || r.got === 'strong'));
    const seen = new Set(read.map((r) => r.got));
    const confusion = BANDS.map(
      (want) =>
        `  wanted ${pad(want, 8)} ${BANDS.map((got) => `${got} ${String(rows.filter((r) => r.expected === want && r.got === got).length).padStart(3)}`).join('   ')}`,
    );
    const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : 'n/a');
    const summary = [
      '',
      `pairs ${rows.length}, read ${read.length}`,
      `in the expected band   ${exact.length}/${rows.length}  ${pct(exact.length, rows.length)}   (bar 75%)`,
      `within one band        ${near.length}/${rows.length}  ${pct(near.length, rows.length)}   (bar 95%)`,
      `of the ${fits.length} pairs a recruiter does not call out: ${fitsExact.length} in band (${pct(fitsExact.length, fits.length)}), ${fitsNear.length} within one (${pct(fitsNear.length, fits.length)})`,
      `capped and still good or strong: ${cappedHigh.length}   (bar 0)`,
      `bands that appear: ${[...seen].join(', ')}   (bar 3)`,
      ...confusion,
    ];
    const report = [...lines, ...table, ...summary].join('\n');
    console.log(report);
    if (process.env.ROLES_BENCH_OUT) writeFileSync(process.env.ROLES_BENCH_OUT, `${report}\n`);

    // ---- what must hold for every pair -----------------------------------------------------------------------------------
    for (const r of rows) {
      const f = r.match?.fit;
      // read closely: the retry for a role the model leaves out of its answer keeps every pair read
      expect(f, `${r.student} x ${r.posting}: ${r.problem ?? 'not read closely'}`).toBeDefined();
      if (!f) continue;
      expect(f.score).toBeGreaterThanOrEqual(1);
      expect(f.score).toBeLessThanOrEqual(10);
      expect(f.band).toBe(bandOf(f.score));
      for (const text of [r.match!.reason ?? '', ...(r.match!.gaps ?? [])]) expect(text).not.toMatch(/[—–!]/);
      // a trait is never a requirement: nothing like "communication" is counted as a missing skill
      for (const sk of r.match!.answers!.skills)
        expect(isSoftSkill(sk.name), `${r.posting}: "${sk.name}" is a trait`).toBe(false);
    }
    // a requirement that accepts alternatives counts with one of them: the design intern asks for "Figma/Canva"
    const figma = rows
      .find((r) => r.student === 'design-student' && r.posting === 'stripe-8332681')
      ?.match?.answers?.skills.find((x) => /figma/i.test(x.name));
    if (figma) expect(figma.answer, `Figma for "${figma.name}"`).not.toBe('none');

    if (!WHOLE) return;
    expect(
      cappedHigh.map((r) => `${r.student} x ${r.posting}: ${r.score} with ${r.caps.join(', ')}`),
    ).toEqual([]);
    expect(exact.length / rows.length, 'in the expected band').toBeGreaterThanOrEqual(0.75);
    expect(near.length / rows.length, 'within one band').toBeGreaterThanOrEqual(0.95);
    expect(seen.size, 'bands that appear').toBeGreaterThanOrEqual(3);
    // the same bar on the pairs that are not plainly out, so a bench that is mostly "out" cannot pass on those alone
    expect(
      fitsNear.length / fits.length,
      'within one band, of the pairs a recruiter does not call out',
    ).toBeGreaterThanOrEqual(0.9);
  }, 3_600_000);
});
