/**
 * The Roles bench (plan 44 §6.7, stage 1b): made-up students (fixtures/roles/profiles.json) read by the real profile
 * reading, then scored against real postings captured from a public job board (fixtures/roles/postings.json) by the
 * real requirements read and close read, through the real server path. It prints each score with its parts, caps,
 * reason and gaps, for a person to read. Run by hand, never in CI, and never with an API key: every model call goes
 * through the developer's own Claude login.
 *
 *   # through the local `claude` command line, called per request (as draft-bench-live.test.ts does)
 *   ORBIT_ROLES_BENCH=1 ROLES_BENCH_VIA=cli \
 *     pnpm --filter @orbit/supabase-tests exec vitest run functions/roles-bench-live.test.ts
 *
 *   # or through a running shim (node scripts/claude-cli-shim.mjs with SHIM_PORT=8791)
 *   ORBIT_ROLES_BENCH=1 ROLES_BENCH_SHIM=http://127.0.0.1:8791 \
 *     pnpm --filter @orbit/supabase-tests exec vitest run functions/roles-bench-live.test.ts
 *
 * ROLES_BENCH_ONLY=id1,id2 runs a few students. CLAUDE_BIN points at a command line new enough for the models used.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobListing, ProfileLines, RoleProfile } from '../../../packages/core/src/roles/types.ts';
import { normalizeCompany } from '../../../packages/core/src/text/normalize.ts';
import { sha256Hex } from '../../functions/_shared/crypto.ts';
import type { RoleSources } from '../../functions/_shared/roles/contracts.ts';
import { readProfile, saveProfile } from '../../functions/_shared/roles/profile.ts';
import { scoreOne } from '../../functions/_shared/roles/search.ts';
import { makeServices } from '../../functions/_shared/services.ts';
import { agentConfig, fakeNet, type NetCall, signedInUser } from '../helpers/agents.ts';
import { cliMessages, cliTotals } from '../helpers/cli-anthropic.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

const VIA_CLI = process.env.ROLES_BENCH_VIA === 'cli';
const SHIM = process.env.ROLES_BENCH_SHIM?.replace(/\/+$/, '');
const LIVE = !!process.env.ORBIT_ROLES_BENCH && (VIA_CLI || !!SHIM);
const ONLY = (process.env.ROLES_BENCH_ONLY ?? '').split(',').filter(Boolean);

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/roles/${name}`, import.meta.url), 'utf8'));
const PROFILES: { profiles: { id: string; about: string; lines: ProfileLines }[] } = fixture('profiles.json');
const POSTINGS: {
  postings: { id: string; company: string; title: string; location: string; url: string; text: string }[];
} = fixture('postings.json');

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

/** The source side as the bench needs it: a posting kept as given, its text as given. */
const benchSources: RoleSources = {
  async keep(db, listings) {
    const out = [];
    for (const l of listings) {
      const [r] = await db.sql<{ id: string }>`
        insert into orbit_private.jobs (source, external_id, company_key, company_name, title, title_key, places,
                                        url, text, text_hash)
        values (${l.source}, ${l.externalId}, ${normalizeCompany(l.companyName)}, ${l.companyName}, ${l.title},
                ${l.title.toLowerCase()}, ${l.locations}::text[], ${l.url}, ${l.text ?? null},
                ${l.text ? (await sha256Hex(l.text)).slice(0, 32) : null})
        on conflict (source, external_id) do update set title = excluded.title
        returning id::text as id`;
      out.push({
        id: r!.id,
        source: l.source,
        externalId: l.externalId,
        companyKey: normalizeCompany(l.companyName),
        companyName: l.companyName,
        title: l.title,
        places: l.locations,
        countries: [],
        degrees: [],
        url: l.url,
        firstSeenAt: new Date().toISOString(),
      });
    }
    return out;
  },
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
      source: 'greenhouse',
      externalId: p.id,
      companyName: p.company,
      title: p.title,
      locations: [p.location],
      url: p.url,
      text: p.text,
    } satisfies JobListing;
  },
};

describe.skipIf(!LIVE)('Roles bench (live, through the CLI)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await freshDb();
  });
  afterAll(async () => {
    await t?.pg.close();
    console.log(`model calls: ${cliTotals.calls}, tokens in ${cliTotals.input}, out ${cliTotals.output}`);
  });

  for (const student of PROFILES.profiles.filter((p) => !ONLY.length || ONLY.includes(p.id)))
    it(`${student.id}: ${student.about}`, async () => {
      const net = liveNet();
      // a placeholder key makes the client; every request goes to the CLI or the shim, never to Anthropic
      const s = makeServices(agentConfig(net, { anthropicKey: 'sk-ant-bench-placeholder' }), { db: t.db });
      const u = await signedInUser(t);
      const read = await readProfile(s, u.userId, student.lines);
      const proposed = read.proposed!;
      console.log(
        `\n== ${student.id} (${proposed.level}${proposed.graduation ? `, graduating ${proposed.graduation}` : ''})`,
        read.note ? `\n   note: ${read.note}` : '',
        `\n   skills: ${proposed.skills.map((k) => `${k.name}${k.from === 'read' ? '*' : ''}`).join(', ')}`,
        `\n   kinds: ${proposed.kinds.map((k) => `${k.title}${k.on ? '' : ' (off)'}: ${k.why ?? ''}`).join(' | ')}`,
      );
      const profile: RoleProfile = { ...proposed, kinds: proposed.kinds.map((k) => ({ ...k, on: true })) };
      await saveProfile(t.db, u.userId, profile, new Date());
      for (const p of POSTINGS.postings) {
        const r = await scoreOne(s, { sources: benchSources }, u.userId, { url: p.url });
        const m = r.match;
        expect(m, r.problem).toBeDefined();
        const f = m!.fit;
        const parts = f
          ? Object.entries(f.parts)
              .map(([k, v]) => `${k} ${Math.round((v ?? 0) * 100)}%`)
              .join(', ')
          : 'not read';
        console.log(
          `   ${p.title}: ${f ? `${f.score}/10 (${f.band}, raw ${f.raw})` : 'no score'}; ${parts}`,
          f?.caps.length ? `\n      caps: ${f.caps.map((c) => c.label).join('; ')}` : '',
          m!.answers
            ? `\n      skills: ${m!.answers.skills.map((x) => `${x.name} ${x.need} ${x.answer}`).join(', ')}` +
                `\n      experience ${m!.answers.experience.answer}, education ${m!.answers.education.answer}, level ${m!.answers.level.answer}`
            : '',
          m!.reason ? `\n      why: ${m!.reason}` : '',
          m!.gaps?.length ? `\n      gaps: ${m!.gaps.join('; ')}` : '',
        );
        if (f) {
          expect(f.score).toBeGreaterThanOrEqual(1);
          expect(f.score).toBeLessThanOrEqual(10);
          for (const text of [m!.reason ?? '', ...(m!.gaps ?? [])]) expect(text).not.toMatch(/[—–!]/);
        }
      }
    }, 600_000);
});
