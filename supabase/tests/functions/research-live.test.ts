/**
 * A live check of deep research (docs/plan/20 §8), run by hand and never in CI: the real pipeline (runBrief) against
 * the real Claude API, on a few public professionals and two low-footprint names, printing what each brief cost, how
 * long it took and which pages it cited, so identity precision can be read off.
 *
 *   ORBIT_RESEARCH_LIVE=1 ANTHROPIC_API_KEY=… [EXA_API_KEY=…] [ORBIT_RESEARCH_LIVE_ONLY=name] \
 *     [ORBIT_RESEARCH_LIVE_OUT=dir] pnpm --filter @orbit/supabase-tests exec vitest run functions/research-live.test.ts
 *
 * Skipped unless ORBIT_RESEARCH_LIVE is set. The key is read from the environment only and never written anywhere.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { makeClaude } from '../../functions/_shared/claude.ts';
import { createExa } from '../../functions/_shared/providers/exa';
import {
  BOTH_CAP_USD,
  type BriefRequest,
  DEEPER_DEADLINE_MS,
  profileText,
  QUICK_CAP_USD,
  QUICK_DEADLINE_MS,
  runBrief,
} from '../../functions/_shared/research/brief';
import type { ClaudeDep } from '../../functions/_shared/research/deps';
import { supportSchema, supportSystem, supportUser } from '../../functions/_shared/research/prompts';
import { claimsOf } from '../../functions/_shared/research/support';
import {
  cachedPage,
  claudeWeb,
  exaWeb,
  memorySharedCache,
  type SharedCache,
  type WebSource,
} from '../../functions/_shared/research/web';

/**
 * v3 §8: claim support is graded by the writing model on a sample, not by the checker itself. The final brief's claims go to
 * the writing model with the text of the pages they cite (from the run's cache) and the profile.
 */
async function gradeWithOpus(
  cache: SharedCache,
  out: { content: unknown; sources: { id: string; url: string; kind: string; title?: string }[] },
  profile: BriefRequest['profile'],
  name: string,
) {
  const key = process.env.ANTHROPIC_API_KEY!;
  const claude = makeClaude({ apiKey: key, client: new Anthropic({ apiKey: key, maxRetries: 1 }) });
  const texts: { id: string; text: string; title?: string }[] = [];
  for (const s of out.sources) {
    if (s.kind === 'linkedin_profile' && profile) texts.push({ id: s.id, text: profileText(profile, name) });
    else {
      const p = await cachedPage(cache, s.url);
      if (p) texts.push({ id: s.id, text: p.text, title: p.title });
    }
  }
  const content = out.content as Parameters<typeof claimsOf>[0];
  const located = claimsOf(
    content,
    texts.map((t) => t.id),
  );
  if (!located.length) return { claims: 0, supported: 0, partial: 0, unsupported: 0, costUsd: 0 };
  const r = await claude.structured({
    task: 'dossier',
    system: supportSystem,
    user: supportUser(
      located.map((l) => l.claim),
      texts,
    ),
    schema: supportSchema,
    userId: null,
    timeoutMs: 120_000,
  });
  if (!r.ok) return { error: JSON.stringify(r).slice(0, 200) };
  const v = r.data.verdicts;
  return {
    claims: located.length,
    supported: v.filter((x) => x.verdict === 'supported').length,
    partial: v.filter((x) => x.verdict === 'partial').length,
    unsupported: v.filter((x) => x.verdict === 'unsupported').length,
    costUsd: r.costUsd,
    flagged: v
      .filter((x) => x.verdict !== 'supported')
      .map((x) => `${x.verdict}: ${located.find((l) => l.claim.id === x.id)?.claim.text.slice(0, 140)}`),
  };
}

const LIVE = !!process.env.ORBIT_RESEARCH_LIVE && !!process.env.ANTHROPIC_API_KEY;

interface Case {
  label: string;
  low?: boolean;
  deeper?: boolean;
  req: BriefRequest['person'];
  profile: BriefRequest['profile'];
}

const student = {
  firstName: 'Sam',
  context:
    'Sam is a junior studying computer science at the University of Michigan, recruiting for product and software internships.',
  goalSentence: 'find a product or software engineering internship for next summer',
  goalKind: 'recruiting' as const,
};

const CASES: Case[] = [
  {
    label: 'Lenny Rachitsky',
    req: {
      name: 'Lenny Rachitsky',
      firstName: 'Lenny',
      lastName: 'Rachitsky',
      title: 'Author',
      org: "Lenny's Newsletter",
      linkedinUrl: 'https://www.linkedin.com/in/lennyrachitsky',
    },
    profile: {
      headline: "Lenny's Newsletter and Lenny's Podcast",
      location: 'San Francisco, California',
      publicIdentifier: 'lennyrachitsky',
      experience: [
        { title: 'Author', company: "Lenny's Newsletter", current: true, start: '2019' },
        { title: 'Product Lead', company: 'Airbnb', start: '2012', end: '2019' },
        { title: 'Co-founder', company: 'Localmind', start: '2010', end: '2012' },
      ],
      education: [{ school: 'University of Wisconsin-Madison' }],
    },
  },
  {
    label: 'Julia Evans',
    deeper: true,
    req: {
      name: 'Julia Evans',
      firstName: 'Julia',
      lastName: 'Evans',
      title: 'Founder',
      org: 'Wizard Zines',
      linkedinUrl: 'https://www.linkedin.com/in/jvns',
    },
    profile: {
      headline: 'Making zines about programming',
      location: 'Montreal, Quebec',
      publicIdentifier: 'jvns',
      experience: [
        { title: 'Founder', company: 'Wizard Zines', current: true, start: '2019' },
        { title: 'Software Engineer', company: 'Stripe', start: '2013', end: '2019' },
      ],
      education: [{ school: 'McGill University' }],
    },
  },
  {
    label: 'Charity Majors',
    req: {
      name: 'Charity Majors',
      firstName: 'Charity',
      lastName: 'Majors',
      title: 'CTO',
      org: 'Honeycomb',
      linkedinUrl: 'https://www.linkedin.com/in/charity-majors',
    },
    profile: {
      headline: 'CTO, Honeycomb',
      location: 'San Francisco, California',
      publicIdentifier: 'charity-majors',
      experience: [
        { title: 'Co-founder and CTO', company: 'Honeycomb', current: true, start: '2016' },
        { title: 'Production Engineering Manager', company: 'Facebook', start: '2013', end: '2015' },
        { title: 'Infrastructure Tech Lead', company: 'Parse', start: '2012', end: '2013' },
      ],
      education: [{ school: 'University of Idaho' }],
    },
  },
  {
    label: 'Shreyas Doshi',
    req: {
      name: 'Shreyas Doshi',
      firstName: 'Shreyas',
      lastName: 'Doshi',
      title: 'Advisor',
      org: 'Independent',
      linkedinUrl: 'https://www.linkedin.com/in/shreyasdoshi',
    },
    profile: {
      headline: 'Product leader; advisor to founders',
      location: 'San Francisco Bay Area',
      publicIdentifier: 'shreyasdoshi',
      experience: [
        { title: 'Product Lead', company: 'Stripe', start: '2016', end: '2020' },
        { title: 'Product Manager', company: 'Twitter', start: '2013', end: '2016' },
        { title: 'Product Manager', company: 'Google', start: '2010', end: '2013' },
      ],
    },
  },
  {
    label: 'low: Emily Johnson, PM at Ramp',
    low: true,
    req: {
      name: 'Emily Johnson',
      firstName: 'Emily',
      lastName: 'Johnson',
      title: 'Product Manager',
      org: 'Ramp',
      linkedinUrl: 'https://www.linkedin.com/in/emily-johnson-ramp-pm',
    },
    profile: {
      headline: 'Product Manager at Ramp',
      location: 'New York, New York',
      publicIdentifier: 'emily-johnson-ramp-pm',
      experience: [
        { title: 'Product Manager', company: 'Ramp', current: true, start: '2024' },
        { title: 'Associate Product Manager', company: 'Capital One', start: '2021', end: '2024' },
      ],
      education: [{ school: 'University of Michigan' }],
    },
  },
  {
    label: 'low: David Kim, engineer at Plaid',
    low: true,
    req: {
      name: 'David Kim',
      firstName: 'David',
      lastName: 'Kim',
      title: 'Software Engineer',
      org: 'Plaid',
      linkedinUrl: 'https://www.linkedin.com/in/david-kim-plaid-swe',
    },
    profile: {
      headline: 'Software Engineer at Plaid',
      location: 'San Francisco, California',
      publicIdentifier: 'david-kim-plaid-swe',
      experience: [{ title: 'Software Engineer', company: 'Plaid', current: true, start: '2023' }],
      education: [{ school: 'University of California, Berkeley' }],
    },
  },
];

function deps(cache = memorySharedCache()) {
  const key = process.env.ANTHROPIC_API_KEY!;
  const client = new Anthropic({ apiKey: key, maxRetries: 1 });
  const claude = makeClaude({ apiKey: key, client });
  const dep: ClaudeDep = {
    async parse(task, schema, prompt) {
      // ORBIT_RESEARCH_LIVE_KEEP: keep the support check's input, to replay it on other models
      if (task === 'support' && process.env.ORBIT_RESEARCH_LIVE_KEEP) {
        mkdirSync(process.env.ORBIT_RESEARCH_LIVE_KEEP, { recursive: true });
        writeFileSync(
          join(process.env.ORBIT_RESEARCH_LIVE_KEEP, `support-${Date.now()}.json`),
          JSON.stringify(prompt),
        );
      }
      const r = await claude.structured({
        task: task === 'support' ? 'support' : 'dossier',
        system: prompt.system,
        user: prompt.user,
        schema,
        userId: null,
        timeoutMs: prompt.timeoutMs,
      });
      if (r.ok) return { ok: true, value: r.data, costUsd: r.costUsd };
      return { ok: false, reason: 'error', message: JSON.stringify(r).slice(0, 200) };
    },
  };
  const web: WebSource[] = [];
  if (process.env.EXA_API_KEY) web.push(exaWeb(createExa({ fetch, apiKey: process.env.EXA_API_KEY }), cache));
  web.push(claudeWeb(client, cache));
  return { web, claude: dep, clock: Date.now };
}

describe.skipIf(!LIVE)('deep research, live', () => {
  const only = process.env.ORBIT_RESEARCH_LIVE_ONLY;
  const out = process.env.ORBIT_RESEARCH_LIVE_OUT;
  for (const c of CASES.filter((x) => !only || only.split(',').some((o) => x.label.includes(o.trim()))))
    it(c.label, async () => {
      const cache = memorySharedCache();
      const d = deps(cache);
      const req: BriefRequest = { kind: 'quick', person: c.req, profile: c.profile, student };
      const t0 = Date.now();
      const r = await runBrief(d, req, { capUsd: QUICK_CAP_USD, deadline: Date.now() + QUICK_DEADLINE_MS });
      const ms = Date.now() - t0;
      const report: Record<string, unknown> = {
        label: c.label,
        status: r.status,
        costUsd: r.costUsd,
        ms,
        notes: r.notes,
        steps: r.steps,
      };
      if ((r.status === 'ready' || r.status === 'partial') && process.env.ORBIT_RESEARCH_LIVE_GRADE)
        report.opusGrade = await gradeWithOpus(cache, r, c.profile, c.req.name);
      if (r.status === 'ready' || r.status === 'partial')
        Object.assign(report, {
          provider: r.provider,
          checked: r.checked,
          strongPages: r.strongPages,
          dropped: r.debug?.dropped,
          sources: r.sources.map((s) => `${s.id} ${s.kind} ${s.url} | ${s.title ?? ''}`),
          content: r.content,
        });
      if (c.deeper && (r.status === 'ready' || r.status === 'partial')) {
        const t1 = Date.now();
        const deeper = await runBrief(
          d,
          { ...req, kind: 'deeper' },
          {
            capUsd: BOTH_CAP_USD - r.costUsd,
            deadline: Date.now() + DEEPER_DEADLINE_MS,
          },
        );
        report.deeper = {
          status: deeper.status,
          costUsd: deeper.costUsd,
          ms: Date.now() - t1,
          notes: deeper.notes,
          steps: deeper.steps,
          ...(deeper.status === 'ready' || deeper.status === 'partial'
            ? {
                sources: deeper.sources.map((s) => `${s.id} ${s.kind} ${s.url} | ${s.title ?? ''}`),
                content: deeper.content,
              }
            : {}),
        };
      }
      console.log(JSON.stringify(report, null, 2));
      if (out) {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, `${c.label.replace(/[^\w]+/g, '_')}.json`), JSON.stringify(report, null, 2));
      }
      expect(['ready', 'partial', 'needs_disambiguation']).toContain(r.status);
      expect(r.costUsd).toBeLessThanOrEqual(QUICK_CAP_USD + 0.02);
    }, 200_000);
});
