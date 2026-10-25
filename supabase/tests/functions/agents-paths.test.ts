import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mutuals from '../../functions/_shared/__fixtures__/unipile-mutuals.json';
import villageCompany from '../../functions/_shared/__fixtures__/village-company-paths.json';
import villagePerson from '../../functions/_shared/__fixtures__/village-person-paths.json';
import villageToken from '../../functions/_shared/__fixtures__/village-token.json';
import {
  addPerson,
  addTie,
  api,
  fakeNet,
  jsonRes,
  type NetCall,
  signedInUser,
  UNIPILE,
} from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

type Found = {
  paths: {
    id: string;
    nodes: string[];
    p: number;
    firstHopId: string;
    reasonText: string;
    names: Record<string, string>;
  }[];
  fallback?: string;
  direct?: { personId: string; score: number };
  sources: string[];
  unconfigured: string[];
};

function villageAndUnipile() {
  return fakeNet((c: NetCall) => {
    if (c.url === 'https://api.village.do/v2/auth/tokens') return jsonRes(200, villageToken);
    if (c.url === 'https://api.village.do/v2/people/paths') return jsonRes(200, villagePerson);
    if (c.url === 'https://api.village.do/v2/companies/paths') return jsonRes(200, villageCompany);
    if (c.url.startsWith(`${UNIPILE}/api/v1/linkedin/search`)) return jsonRes(200, mutuals);
    if (c.url.startsWith(`${UNIPILE}/api/v1/users/ACoAADanaLee?`))
      return jsonRes(200, { provider_id: 'ACoAADanaLee', shared_connections_count: 2 });
    return undefined;
  });
}

describe('warm paths (§4)', () => {
  it('§4.8 test 1: a mutual who emails the target outranks a same-company-only pair', async () => {
    const call = api(t, fakeNet(), { env: {} });
    const { userId, token } = await signedInUser(t);
    const priya = await addPerson(t, userId, { name: 'Priya Ahmed', title: 'Product Manager', org: 'Figma' });
    const ana = await addPerson(t, userId, { name: 'Ana Silva', score: 60 });
    const ben = await addPerson(t, userId, { name: 'Ben Cole', score: 60 });
    await addTie(t, userId, ana, priya, 'email_exchange', 0.8, 0.95);
    await addTie(t, userId, ben, priya, 'same_current_company', 0.6, 0.6, { orgName: 'Figma' });
    const r = await call<Found>('/paths/find', token, { target: { personId: priya } });
    expect(r.status).toBe(200);
    expect(r.body.paths.length).toBe(2);
    expect(r.body.paths[0]!.firstHopId).toBe(ana);
    expect(r.body.paths[0]!.p).toBeGreaterThan(r.body.paths[1]!.p);
    expect(r.body.paths[0]!.reasonText).toContain('emails with Priya');
    expect(r.body.paths[0]!.names).toMatchObject({ user: 'You', [ana]: 'Ana Silva', [priya]: 'Priya Ahmed' });
    expect(r.body.paths[0]!.id).toMatch(/^path_[0-9a-f]{16}$/);
    // stable ids
    const again = await call<Found>('/paths/find', token, { target: { personId: priya } });
    expect(again.body.paths.map((p) => p.id)).toEqual(r.body.paths.map((p) => p.id));
    expect(r.body.sources).toEqual(['graph']);
    expect(r.body.unconfigured.sort()).toEqual(['unipile', 'village']);
  });

  it('§4.8 test 2: p_ask rises with the first hop’s score and falls after a recent ask', async () => {
    const call = api(t, fakeNet(), { env: {} });
    const { userId, token } = await signedInUser(t);
    const target = await addPerson(t, userId, { name: 'Tess Moore' });
    const a = await addPerson(t, userId, { name: 'Abe Long', score: 50 });
    await addTie(t, userId, a, target, 'email_exchange', 0.8, 0.95);
    const p0 = (await call<Found>('/paths/find', token, { target: { personId: target } })).body.paths[0]!.p;
    await t.db.sql`update orbit.tie_scores set score = 85 where person_id = ${a}::uuid`;
    const p1 = (await call<Found>('/paths/find', token, { target: { personId: target } })).body.paths[0]!.p;
    expect(p1).toBeGreaterThan(p0);
    await t.db.sql`
      insert into orbit.intro_requests (user_id, target_person_id, introducer_person_id, path, path_score, rank, asked_at)
      values (${userId}::uuid, ${target}::uuid, ${a}::uuid, '{}'::jsonb, 0.3, 1, now() - interval '5 days')`;
    const p2 = (await call<Found>('/paths/find', token, { target: { personId: target } })).body.paths[0]!.p;
    expect(p2).toBeLessThan(p1);
  });

  it('§4.8 test 4: mutuals and Village introducers become candidates and ties, cached for 30 days', async () => {
    const net = villageAndUnipile();
    const call = api(t, net);
    const { userId, token } = await signedInUser(t);
    await t.db.sql`insert into orbit.integration_accounts (user_id, provider, external_account_id, status)
      values (${userId}::uuid, 'linkedin', 'acc1', 'active')`;
    const dana = await addPerson(t, userId, {
      name: 'Dana Lee',
      title: 'Partner',
      linkedinUrl: 'https://www.linkedin.com/in/dana-lee',
      memberId: 'ACoAADanaLee',
    });
    const mia = await addPerson(t, userId, {
      name: 'Mia Chen',
      score: 55,
      linkedinUrl: 'https://www.linkedin.com/in/mia-chen',
    });
    const omar = await addPerson(t, userId, {
      name: 'Omar Hale',
      score: 45,
      linkedinUrl: 'https://www.linkedin.com/in/omar-hale',
    });
    const sam = await addPerson(t, userId, {
      name: 'Sam Ortiz',
      score: 70,
      linkedinUrl: 'https://www.linkedin.com/in/sam-ortiz',
    });
    const r = await call<Found>('/paths/find', token, { target: { personId: dana } });
    expect(r.status).toBe(200);
    expect(r.body.sources).toEqual(['graph', 'linkedin_mutual', 'village']);
    const ties = await t.db.sql<{ a: string; b: string; kind: string; weight: number; confidence: number }>`
      select a_person_id as a, b_person_id as b, kind, weight, confidence from orbit.ties
       where user_id = ${userId}::uuid order by kind, weight`;
    const other = (x: { a: string; b: string }) => (x.a === dana ? x.b : x.a);
    const mutualTies = ties.filter((x) => x.kind === 'linkedin_mutual');
    expect(mutualTies.map(other).sort()).toEqual([mia, omar].sort());
    for (const m of mutualTies) {
      expect(m.weight).toBeCloseTo(0.3);
      expect(m.confidence).toBeCloseTo(0.95);
    }
    const village = ties.filter((x) => x.kind === 'village_path');
    expect(village.map(other).sort()).toEqual([mia, sam].sort());
    for (const v of village) expect(v.confidence).toBeCloseTo(0.7);
    expect(village.find((v) => other(v) === sam)!.weight).toBeCloseTo(0.82);
    expect(r.body.paths.map((p) => p.firstHopId)).toEqual(expect.arrayContaining([sam, mia]));
    // Village token + paths, the target's profile (LinkedIn's shared count) and the filtered search
    const firstCalls = net.calls.length;
    expect(firstCalls).toBe(4);
    // the second request inside 30 days asks nobody upstream
    const r2 = await call<Found>('/paths/find', token, { target: { personId: dana } });
    expect(net.calls.length).toBe(firstCalls);
    expect(r2.body.paths.map((p) => p.id)).toEqual(r.body.paths.map((p) => p.id));
    const ledger = await t.db.sql<{ units: string }>`
      select units::text from orbit.usage_ledger where user_id = ${userId}::uuid and provider = 'village'`;
    expect(ledger.map((l) => Number(l.units))).toEqual([5]);
  });

  it('§4.8 test 5: a fundraising path whose first hop scores 25 is excluded; the same path for advice is kept', async () => {
    const call = api(t, fakeNet(), { env: {} });
    const { userId, token } = await signedInUser(t);
    const target = await addPerson(t, userId, { name: 'Vera Stone', title: 'Partner' });
    const weak = await addPerson(t, userId, { name: 'Will Park', score: 25 });
    await addTie(t, userId, weak, target, 'email_exchange', 0.9, 0.95);
    const fund = await call<{ goal: { id: string } }>('/goals/upsert', token, {
      goal: { kind: 'fundraising', title: 'Seed' },
    });
    const advice = await call<{ goal: { id: string } }>('/goals/upsert', token, {
      goal: { kind: 'advice', title: 'Learn' },
    });
    const f = await call<Found>('/paths/find', token, {
      target: { personId: target },
      goalId: fund.body.goal.id,
    });
    expect(f.body.paths).toEqual([]);
    expect(f.body.fallback).toBe('cold');
    const a = await call<Found>('/paths/find', token, {
      target: { personId: target },
      goalId: advice.body.goal.id,
    });
    expect(a.body.paths.map((p) => p.firstHopId)).toEqual([weak]);
  });

  it('answers a direct tie, a LinkedIn URL target and a company target', async () => {
    const net = villageAndUnipile();
    const call = api(t, net);
    const { userId, token } = await signedInUser(t);
    const close = await addPerson(t, userId, { name: 'Cleo Park', score: 72 });
    const d = await call<Found>('/paths/find', token, { target: { personId: close } });
    expect(d.body.direct).toMatchObject({ personId: close, score: 72 });
    expect(d.body.paths).toEqual([]);
    // a LinkedIn URL Orbit has not seen becomes a person, then is routed
    const u = await call<Found>('/paths/find', token, {
      target: {
        linkedinUrl: 'https://www.linkedin.com/in/new-person?trk=x',
        name: 'New Person',
        company: 'Acme',
      },
    });
    expect(u.status).toBe(200);
    const [np] = await t.db.sql<{ display_name: string; org_raw: string }>`
      select display_name, org_raw from orbit.people where user_id = ${userId}::uuid and linkedin_slug = 'new-person'`;
    expect(np).toEqual({ display_name: 'New Person', org_raw: 'Acme' });
    // a company: Village's people at Stripe become targets reachable through Sam
    const sam = await addPerson(t, userId, {
      name: 'Sam Ortiz',
      score: 70,
      linkedinUrl: 'https://www.linkedin.com/in/sam-ortiz',
    });
    const c = await call<Found>('/paths/find', token, {
      target: { company: 'Stripe', domain: 'stripe.com' },
    });
    expect(c.status).toBe(200);
    expect(c.body.paths.length).toBeGreaterThan(0);
    expect(c.body.paths[0]!.firstHopId).toBe(sam);
    expect(Object.values(c.body.paths[0]!.names)).toContain('Ana Ruiz');
    expect((await call('/paths/find', token, { target: {} })).status).toBe(400);
  });
});

describe('intros/ask (§4.3, §7.3)', () => {
  it('drafts the intro request and the forwardable blurb, records the request, and sends nothing', async () => {
    const net = fakeNet();
    const call = api(t, net, { env: {} });
    const { userId, token } = await signedInUser(t);
    const target = await addPerson(t, userId, {
      name: 'Priya Ahmed',
      title: 'Product Manager',
      org: 'Figma',
    });
    const intro = await addPerson(t, userId, { name: 'Ana Silva', email: 'ana@example.com', score: 60 });
    await addTie(t, userId, intro, target, 'email_exchange', 0.8, 0.95);
    const found = await call<Found>('/paths/find', token, { target: { personId: target } });
    const path = found.body.paths[0]!;
    const r = await call<{ introRequestId: string; draftIds: string[] }>('/intros/ask', token, {
      introducerPersonId: intro,
      targetPersonId: target,
      pathScore: path.p,
      path,
    });
    expect(r.status).toBe(200);
    expect(r.body.draftIds).toHaveLength(2);
    const drafts = await t.db.sql<{
      kind: string;
      status: string;
      person_id: string;
      via: { introRequestId: string };
      body: string;
      generated_by: string;
    }>`
      select kind, status, person_id, via, body, generated_by from orbit.drafts where id = any(${r.body.draftIds}::uuid[]) order by kind`;
    expect(drafts.map((d) => d.kind)).toEqual(['forwardable_blurb', 'intro_request']);
    for (const d of drafts) {
      expect(d.status).toBe('draft');
      expect(d.person_id).toBe(intro);
      expect(d.via.introRequestId).toBe(r.body.introRequestId);
      expect(d.generated_by).toBe('template');
    }
    expect(drafts[0]!.body).toContain('Sam');
    expect(drafts[1]!.body).toContain('Priya');
    const [ir] = await t.db.sql<{ status: string; introducer_person_id: string; target_person_id: string }>`
      select status, introducer_person_id, target_person_id from orbit.intro_requests where id = ${r.body.introRequestId}::uuid`;
    expect(ir).toEqual({ status: 'asked', introducer_person_id: intro, target_person_id: target });
    expect(net.calls).toHaveLength(0);
  });
});
