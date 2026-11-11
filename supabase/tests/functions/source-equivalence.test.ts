/**
 * POST /source/search end to end (plan 39 A), with everything the ranking reads: a goal with a person already in its
 * pipeline, a LinkedIn connection the search finds again, warm contacts at a target company, contacts' addresses that
 * teach a company's email pattern, a résumé, and an Apollo plan that refuses search (as the live one does). The
 * answer and the stored recommendations are compared with what the pipeline gave before it was made faster
 * (source-equivalence.baseline.json; refresh only from a known-good pipeline with SOURCING_BASELINE=write).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALL_KEYS,
  type AnthropicRequest,
  addPerson,
  agentConfig,
  anthropic,
  api,
  fakeNet,
  jsonRes,
  type NetCall,
  signedInUser,
  UNIPILE,
  userText,
} from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

const BASELINE = join(__dirname, 'source-equivalence.baseline.json');
const WRITE = process.env.SOURCING_BASELINE === 'write';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

const ORGS = ['Stripe', 'Ramp', 'Plaid', 'Notion'];
const FIRST = ['Ana', 'Ben', 'Cara', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jia'];
const LAST = ['Shah', 'Ito', 'Chen', 'Park', 'Diaz', 'Okafor', 'Novak'];

/** LinkedIn's three pages of ten: product designers, a few at Stripe. */
function linkedInPerson(i: number) {
  const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 3) % LAST.length]}${i >= 10 ? ` ${i}` : ''}`;
  const org = ORGS[i % ORGS.length]!;
  return {
    type: 'PEOPLE',
    id: `ACoA${i}`,
    name,
    member_urn: `urn:li:member:${7000 + i}`,
    profile_url: `https://www.linkedin.com/in/li-person-${i}`,
    network_distance: i % 4 === 0 ? 'DISTANCE_2' : 'DISTANCE_3',
    location: 'San Francisco Bay Area',
    headline: `${i % 2 ? 'Product Designer' : 'Design Lead'} at ${org}`,
  };
}

const unipile = (c: NetCall) => {
  if (!c.url.startsWith(UNIPILE)) return undefined;
  if (c.url.includes('/users/me')) return jsonRes(200, { object: 'AccountOwnerProfile', premium: false });
  if (c.url.includes('/linkedin/search/parameters')) {
    const u = new URL(c.url);
    return jsonRes(200, {
      items: [{ object: 'LinkedinSearchParameter', id: `${u.searchParams.get('type')}-1`, title: 'x' }],
    });
  }
  if (c.url.includes('/linkedin/search?')) {
    const page = Number(new URL(c.url).searchParams.get('cursor') ?? '0');
    return jsonRes(200, {
      object: 'LinkedinSearch',
      items: Array.from({ length: 10 }, (_, k) => linkedInPerson(page * 10 + k)),
      cursor: page < 2 ? String(page + 1) : null,
    });
  }
  return undefined;
};

/** Apollo's free plan, as live: search is not included. */
const apollo = (c: NetCall) =>
  c.url.includes('api.apollo.io')
    ? jsonRes(403, { error: 'The api/v1/mixed_people/api_search API is not included in your Free plan' })
    : undefined;

/** A stable number in [0, 1) from a string. */
function unit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

function fitAnswer(r: AnthropicRequest) {
  const block = userText(r).split('<candidates>')[1]?.split('</candidates>')[0] ?? '';
  const cands = block
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as { id: string; name: string });
  return {
    scores: cands.map((c) => ({
      id: c.id,
      fit: Math.round(unit(c.name) * 100) / 100,
      reasons: [`${c.name} designs products`],
    })),
  };
}

type Row = Record<string, unknown>;

describe('POST /source/search: the same answer and stored rows after plan 39 A', () => {
  it('a recruiting search with a goal, known people, warm contacts and a refusing Apollo', async () => {
    const claude = anthropic(fitAnswer);
    const net = fakeNet(claude.answer, unipile, apollo);
    const env = { ...ALL_KEYS, exaKey: undefined, semanticScholarKey: undefined };
    const call = api(t, net, { env, agent: { ...agentConfig(net, env), web: [] } });
    const { userId, token } = await signedInUser(t, { firstName: 'Ari' });
    await t.db.sql`
      insert into orbit.integration_accounts (user_id, provider, external_account_id, status)
      values (${userId}::uuid, 'linkedin', 'acc-li', 'active')`;
    await t.db.sql`
      insert into orbit.uploads (user_id, kind, filename, text, parsed, is_current)
      values (${userId}::uuid, 'resume', 'resume.pdf', 'Ari, Stanford, design',
              ${{ school: 'Stanford University', orgs: ['Plaid'], skills: ['product design', 'Figma'] }}::jsonb, true)`;
    const [g] = await t.db.sql<{ id: string }>`
      insert into orbit.goals (user_id, kind, title, targets)
      values (${userId}::uuid, 'recruiting', 'Product design internship at a fintech',
              ${{ organizations: ['Stripe'], roles: ['Product Designer'], geographies: [], people: [] }}::jsonb)
      returning id`;
    const goalId = g!.id;
    // a connection the search finds again (by LinkedIn URL), with a score
    await addPerson(t, userId, {
      name: linkedInPerson(1).name,
      linkedinUrl: 'https://www.linkedin.com/in/li-person-1',
      org: 'Ramp',
      score: 72,
    });
    // someone already in this goal's pipeline: the search drops them
    const inPipe = await addPerson(t, userId, {
      name: linkedInPerson(2).name,
      linkedinUrl: 'https://www.linkedin.com/in/li-person-2',
      org: 'Plaid',
    });
    await t.db.sql`
      insert into orbit.chats (user_id, person_id, goal_id, stage, stage_entered_at, data)
      values (${userId}::uuid, ${inPipe}::uuid, ${goalId}::uuid, 'identified', now(), '{}'::jsonb)`;
    // warm contacts at Stripe (one hop away for anyone there), whose addresses teach Stripe's pattern
    await addPerson(t, userId, {
      name: 'Wendy Warm',
      email: 'wendy.warm@stripe.com',
      org: 'Stripe',
      score: 85,
    });
    await addPerson(t, userId, { name: 'Omar Old', email: 'omar.old@stripe.com', org: 'Stripe', score: 30 });
    await addPerson(t, userId, { name: 'Lia Lee', email: 'lia.lee@plaid.com', org: 'Plaid', score: 65 });

    const r = await call<{ results: Row[]; unconfigured: string[]; relaxed: string[] }>(
      '/source/search',
      token,
      {
        goalId,
        purpose: 'recruiting',
        query: 'product designers at fintech companies',
        filters: { titles: ['Product Designer'], organizations: ['Stripe'] },
      },
    );
    expect(r.status).toBe(200);
    expect(r.body.results.length).toBeGreaterThan(10);

    const answer = {
      results: r.body.results.map(({ id: _id, ...rest }) => rest),
      unconfigured: r.body.unconfigured,
      relaxed: r.body.relaxed,
    };
    // ids differ run to run: compare who, not which uuid
    const noIds = (c: unknown) => {
      const o = c as { warmth?: { bridge?: { personId?: string } } };
      if (o?.warmth?.bridge) o.warmth.bridge = { ...o.warmth.bridge, personId: 'bridge' };
      return o;
    };
    const stored = (
      await t.db.sql<Row>`
        select person_id, candidate, source, external_id, rank, fit, reach, responsiveness, reasons, status
          from orbit.recommendations where user_id = ${userId}::uuid`
    )
      .map((x): Row => ({ ...x, person_id: x.person_id ? 'known' : null, candidate: noIds(x.candidate) }))
      .sort(
        (a, b) =>
          Number(b.rank) - Number(a.rank) || String(a.external_id).localeCompare(String(b.external_id)),
      );
    const named = (rows: Row[]) =>
      rows.map((x) => ({
        ...x,
        knownPersonId: x.knownPersonId ? 'known' : undefined,
        bridge: x.bridge ? { name: (x.bridge as { name?: string }).name } : undefined,
      }));
    const now = { answer: { ...answer, results: named(answer.results) }, stored };

    if (WRITE) {
      writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
      return;
    }
    const before = JSON.parse(readFileSync(BASELINE, 'utf8'));
    // the ranked answer (with its order) and every stored row are what they were
    expect(JSON.parse(JSON.stringify(now))).toEqual(before);
    // the person in the pipeline stays out, the known connection is labelled, the warm route is named
    const names = answer.results.map((x) => x.name);
    expect(names).not.toContain(linkedInPerson(2).name);
    expect(answer.results.some((x) => x.knownPersonId)).toBe(true);
  });
});
