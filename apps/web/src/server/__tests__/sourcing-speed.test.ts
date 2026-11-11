/**
 * Sourcing speed (plan 39 option A): the whole search with every provider answering after a realistic delay (a tenth
 * of what production measured: LinkedIn pages about 2.3 s, a fit batch about 5 s), so the time the pipeline itself
 * adds by waiting in line shows. The answer must not change: each scenario's ranked rows are compared with the rows
 * the pipeline gave before it was made faster (sourcing-speed.baseline.json), and its time with the time it took then.
 *
 * Refresh the baseline only from a pipeline whose results are known good: SOURCING_BASELINE=write.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApollo } from '../../../../../supabase/functions/_shared/providers/apollo';
import { createExa } from '../../../../../supabase/functions/_shared/providers/exa';
import { createSemanticScholar } from '../../../../../supabase/functions/_shared/providers/semanticScholar';
import { createUnipileResearch } from '../../../../../supabase/functions/_shared/providers/unipileResearch';
import type { ClaudeDep, ClaudePrompt } from '../../../../../supabase/functions/_shared/research/deps';
import {
  type SourcingDeps,
  type SourcingGoal,
  type SourcingResult,
  sourcePeople,
} from '../../../../../supabase/functions/_shared/sourcing/search';
import { type Call, fakeFetch, instant, json, manualClock, type Route } from './fakes';

const UNIPILE = 'https://api9.unipile.com:13999';
const BASELINE = join(__dirname, 'sourcing-speed.baseline.json');
const WRITE = process.env.SOURCING_BASELINE === 'write';

/** What each provider takes to answer, a tenth of production. */
const DELAY = {
  unipileMe: 40,
  unipileParam: 60,
  unipilePage: 230,
  apollo: 80,
  exa: 100,
  fitBatch: 500,
  known: 3,
  reach: 15,
  inPipeline: 8,
  prefetch: 50,
  emails: 100,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stable number in [0, 1) from a string, so the same person always gets the same fit. */
function unit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

const FIRST = ['Ana', 'Ben', 'Cara', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jia', 'Kai', 'Lea', 'Max'];
const LAST = ['Shah', 'Ito', 'Chen', 'Park', 'Diaz', 'Okafor', 'Novak', 'Reyes', 'Haas', 'Moreau', 'Sato'];
const ORGS = ['Figma', 'Stripe', 'Notion', 'Ramp', 'Linear', 'Vercel', 'Plaid'];
const ROLES = ['Product Designer', 'Software Engineer', 'Product Manager', 'Design Lead', 'Recruiter'];

function person(i: number, salt: string) {
  const first = FIRST[i % FIRST.length]!;
  const last = LAST[(i * 7 + salt.length) % LAST.length]!;
  return {
    first,
    last,
    name: `${first} ${last}${i >= FIRST.length ? ` ${salt}${i}` : ''}`,
    org: ORGS[(i * 3 + salt.length) % ORGS.length]!,
    role: ROLES[(i * 5) % ROLES.length]!,
  };
}

/** LinkedIn: three pages of ten, by cursor; Apollo 25; Exa 10 per search. A few people appear in two sources. */
function upstream() {
  return fakeFetch((async (c: Call) => {
    if (c.url.includes('/users/me')) {
      await sleep(DELAY.unipileMe);
      return json({ object: 'AccountOwnerProfile', premium: false });
    }
    if (c.url.includes('/linkedin/search/parameters')) {
      await sleep(DELAY.unipileParam);
      const u = new URL(c.url);
      const type = u.searchParams.get('type') ?? '';
      const kw = u.searchParams.get('keywords') ?? '';
      return json({ items: [{ object: 'LinkedinSearchParameter', id: `${type}-${kw.length}`, title: kw }] });
    }
    if (c.url.includes('/linkedin/search?')) {
      await sleep(DELAY.unipilePage);
      const page = Number(new URL(c.url).searchParams.get('cursor') ?? '0');
      const items = Array.from({ length: 10 }, (_, k) => {
        const i = page * 10 + k;
        const p = person(i, 'li');
        return {
          type: 'PEOPLE',
          id: `ACoA${i}`,
          name: p.name,
          member_urn: `urn:li:member:${9000 + i}`,
          profile_url: `https://www.linkedin.com/in/li-${i}`,
          network_distance: i % 3 === 0 ? 'DISTANCE_2' : 'DISTANCE_3',
          location: 'San Francisco Bay Area',
          headline: `${p.role} at ${p.org}`,
        };
      });
      return json({ object: 'LinkedinSearch', items, cursor: page < 2 ? String(page + 1) : null });
    }
    if (c.url.includes('mixed_people/api_search')) {
      await sleep(DELAY.apollo);
      const people = Array.from({ length: 25 }, (_, i) => {
        // the first five are LinkedIn's people too, found again by full name and company
        const p = i < 5 ? person(i, 'li') : person(i, 'ap');
        return {
          id: `ap_${i}`,
          first_name: p.first,
          last_name: i < 5 ? p.name.slice(p.first.length + 1) : p.name.slice(p.first.length + 1),
          title: p.role,
          linkedin_url: i < 5 ? `https://www.linkedin.com/in/li-${i}` : undefined,
          organization: { name: p.org },
        };
      });
      return json({ people });
    }
    if (c.url.endsWith('api.exa.ai/search')) {
      await sleep(DELAY.exa);
      const body = c.body as { query?: string; includeDomains?: string[] };
      const tag = body.includeDomains?.length ? 'gh' : 'ex';
      const results = Array.from({ length: 10 }, (_, i) => {
        const p = person(i, tag);
        return {
          id: `https://www.linkedin.com/in/${tag}-${i}`,
          url: `https://www.linkedin.com/in/${tag}-${i}`,
          title: `${p.name} - ${p.role} - ${p.org} | LinkedIn`,
          highlights: [`${p.name} works on ${p.role.toLowerCase()} at ${p.org}.`],
        };
      });
      return json({ requestId: `r-${tag}`, results });
    }
    return undefined;
  }) as unknown as Route);
}

/** The fit model: a fixed fit per name, after a batch's delay; counts calls and the most it ran at once. */
function slowClaude() {
  let running = 0;
  const stats = { calls: 0, peak: 0 };
  const claude: ClaudeDep = {
    async parse(_task, schema, prompt: ClaudePrompt) {
      stats.calls++;
      running++;
      stats.peak = Math.max(stats.peak, running);
      await sleep(DELAY.fitBatch);
      running--;
      const lines = prompt.user.split('<candidates>')[1]!.split('</candidates>')[0]!.split('\n');
      const value = {
        scores: lines.map((l) => {
          const c = JSON.parse(l) as { id: string; name: string };
          return { id: c.id, fit: Math.round(unit(c.name) * 100) / 100, reasons: [`${c.name} fits`] };
        }),
      };
      const parsed = schema.safeParse(value);
      if (!parsed.success) return { ok: false, reason: 'error', message: 'schema' };
      return { ok: true, value: parsed.data, costUsd: 0.0005 } as never;
    },
  };
  return { claude, stats };
}

function deps(net: ReturnType<typeof upstream>, claude: ClaudeDep): SourcingDeps {
  const known = new Set(['Ben Ito', 'Hana Novak']);
  return {
    exa: createExa({ fetch: net.fetch, apiKey: 'ek', sleep: instant }),
    apollo: createApollo({ fetch: net.fetch, apiKey: 'ak', sleep: instant }),
    unipile: createUnipileResearch({ fetch: net.fetch, apiKey: 'uk', baseUrl: UNIPILE, sleep: instant }),
    semanticScholar: createSemanticScholar({ fetch: net.fetch, sleep: instant }),
    claude,
    clock: manualClock().clock,
    newId: () => 'batch-1',
    knownPerson: async (c) => {
      await sleep(DELAY.known);
      return known.has(c.name) ? { personId: `p-${c.name}`, score: 60 } : null;
    },
    reachOf: async (c) => {
      await sleep(DELAY.reach);
      return known.has(c.name) ? 0.8 : unit(`reach:${c.name}`) > 0.7 ? 0.3 : null;
    },
    responsiveness: (c) => Math.round(unit(`resp:${c.name}`) * 100) / 100,
    inPipeline: async (c) => {
      await sleep(DELAY.inPipeline);
      return c.name === 'Hana Novak';
    },
    prefetch: async () => {
      await sleep(DELAY.prefetch);
    },
    fillEmails: async (cands) => {
      await sleep(DELAY.emails);
      for (const c of cands.slice(0, 5))
        if (!c.email) c.email = `${(c.firstName ?? 'x').toLowerCase()}@example.com`;
    },
  };
}

const SCENARIOS: { id: string; goal: SourcingGoal; school?: string }[] = [
  {
    id: 'recruiting',
    goal: {
      id: 'g-rec',
      kind: 'recruiting',
      title: 'Design internship at a fintech',
      criteria: ['product design', 'fintech'],
      roles: ['Product Designer'],
      orgs: ['Stripe', 'Ramp'],
      location: 'San Francisco',
    },
    school: 'Stanford University',
  },
  {
    id: 'hiring',
    goal: {
      id: 'g-hire',
      kind: 'hiring',
      title: 'Founding engineer',
      criteria: ['TypeScript', 'early-stage startup'],
      roles: ['Software Engineer'],
      skills: ['TypeScript', 'Postgres'],
      pastCompanies: ['Stripe'],
    },
    school: 'UC Berkeley',
  },
  {
    id: 'advice',
    goal: {
      id: 'g-adv',
      kind: 'advice',
      title: 'Advice on breaking into product management',
      criteria: ['product management'],
      roles: ['Product Manager'],
      orgs: ['Notion'],
    },
  },
];

/** A result as compared: everything the student sees and the order depends on, nothing about timing or keys. */
function canonical(r: SourcingResult) {
  return {
    results: r.results
      .map((x) => ({
        name: x.candidate.name,
        title: x.candidate.title ?? null,
        org: x.candidate.org ?? null,
        email: x.candidate.email ?? null,
        warmth: x.candidate.warmth?.tier ?? null,
        sources: [...x.candidate.sources].sort(),
        source: x.source,
        external_id: x.external_id,
        person_id: x.person_id,
        rank: x.rank,
        fit: x.fit,
        reach: x.reach,
        responsiveness: x.responsiveness,
        reasons: x.reasons,
      }))
      .sort((a, b) => b.rank - a.rank || String(a.external_id).localeCompare(String(b.external_id))),
    unconfigured: r.unconfigured,
    relaxed: r.relaxed,
    errors: r.errors,
  };
}

async function run(s: (typeof SCENARIOS)[number]) {
  const net = upstream();
  const llm = slowClaude();
  const t0 = performance.now();
  const out = await sourcePeople(deps(net, llm.claude), {
    userId: 'u1',
    goal: s.goal,
    user: { firstName: 'Ari', school: s.school },
    unipileAccountId: 'acc1',
    limit: 50,
  });
  const ms = Math.round(performance.now() - t0);
  return { out, ms, fitCalls: llm.stats.calls, fitPeak: llm.stats.peak, calls: net.calls.length };
}

type Baseline = Record<string, { ms: number; result: ReturnType<typeof canonical> }>;

describe('sourcing speed (plan 39 A): faster, same answer', () => {
  const baseline: Baseline = WRITE ? {} : JSON.parse(readFileSync(BASELINE, 'utf8'));
  const written: Baseline = {};

  for (const s of SCENARIOS)
    it(`${s.id}: the same ranked rows as before, in less time`, { timeout: 30_000 }, async () => {
      const r = await run(s);
      const result = canonical(r.out);
      expect(result.results.length).toBeGreaterThan(10);
      if (WRITE) {
        written[s.id] = { ms: r.ms, result };
        writeFileSync(BASELINE, `${JSON.stringify({ ...JSON.parse(safeRead()), ...written }, null, 2)}\n`);
        return;
      }
      const before = baseline[s.id]!;
      expect(result).toEqual(before.result);
      console.log(
        `[sourcing-speed] ${s.id}: ${before.ms} ms before, ${r.ms} ms now (${Math.round((100 * r.ms) / before.ms)}%); fit calls ${r.fitCalls}, at most ${r.fitPeak} at once`,
      );
      // the fit batches run together, so the whole search takes well under its old time
      expect(r.ms).toBeLessThan(before.ms * 0.75);
    });
});

function safeRead(): string {
  try {
    return readFileSync(BASELINE, 'utf8');
  } catch {
    return '{}';
  }
}
