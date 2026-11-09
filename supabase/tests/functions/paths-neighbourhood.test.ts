/**
 * Plan 35 B7: a person search loads only the target's neighbourhood (people within two pairs of the target, every
 * tie touching them, evidence trimmed to what ranking reads), patches it after new ties instead of loading it again,
 * and fetches full evidence for the chosen routes only. The routes, their words and the direct tie must equal what
 * the whole graph (loadGraph, full evidence) gives, with one people query per search.
 */
import { rankWarmPaths } from '@orbit/core/graph/route';
import { responsePrior } from '@orbit/core/recommend/score';
import type { Person } from '@orbit/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mutuals from '../../functions/_shared/__fixtures__/unipile-mutuals.json';
import villageCompany from '../../functions/_shared/__fixtures__/village-company-paths.json';
import villagePerson from '../../functions/_shared/__fixtures__/village-person-paths.json';
import villageToken from '../../functions/_shared/__fixtures__/village-token.json';
import type { Db } from '../../functions/_shared/db.ts';
import { scorePeople } from '../../functions/_shared/ingest/score.ts';
import { refreshTies } from '../../functions/_shared/ingest/ties.ts';
import { findPaths, loadGraph } from '../../functions/_shared/paths/find.ts';
import { makeServices } from '../../functions/_shared/services.ts';
import {
  addPerson,
  addTie,
  agentConfig,
  fakeNet,
  jsonRes,
  type NetCall,
  signedInUser,
  UNIPILE,
} from '../helpers/agents.ts';
import { seedBigNetwork } from '../helpers/bigNetwork.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

const NOW = new Date('2026-11-10T07:30:00Z');

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

/** A Db that counts the graph's people loads (the select that joins tie_scores to people). */
function counting(db: Db) {
  let people = 0;
  const see = (q: string) => {
    if (/left join orbit\.tie_scores ts on ts\.user_id = p\.user_id/.test(q)) people++;
  };
  const out: Db = {
    sql: (s, ...v) => {
      see(s.join('?'));
      return db.sql(s, ...v);
    },
    query: (q, p) => {
      see(q);
      return db.query(q, p);
    },
    begin: (fn) => db.begin(fn),
  };
  return {
    db: out,
    people: () => people,
    reset: () => {
      people = 0;
    },
  };
}

/** What findPaths answered before plan 35 B7: core's ranking over the whole graph with full evidence. */
async function reference(userId: string, targetId: string) {
  const g = await loadGraph(t.db, userId, NOW);
  const target = g.people.get(targetId)!;
  const [me] = await t.db.sql<{ school: string | null; majors: string[] }>`
    select school, majors from orbit.users where id = ${userId}::uuid`;
  const user = { school: me?.school ?? '', majors: me?.majors ?? [] };
  const like = {
    isAlumni: target.isAlumni,
    currentTitle: target.title,
    lastInteractionAt: target.lastContactAt,
  } as Person;
  return rankWarmPaths({
    targetId,
    target: {
      name: target.name,
      isAlum: target.isAlumni,
      title: target.title,
      pReply: target.score > 0 ? responsePrior(like, user) : undefined,
    },
    people: g.people,
    pairs: g.pairs,
    blockedPairs: g.blocked,
    now: NOW,
  });
}

const shape = (r: Awaited<ReturnType<typeof findPaths>>) => ({
  paths: r.paths.map(({ id: _id, names: _names, ...p }) => p),
  fallback: r.fallback,
  direct: r.direct ? { score: r.direct.score, band: r.direct.band, text: r.direct.text } : undefined,
});

describe('findPaths over the target’s neighbourhood (plan 35 B7)', () => {
  it('gives the same routes, words and direct tie as the whole graph, with one people query', async () => {
    const { userId } = await signedInUser(t);
    const ids = (
      await seedBigNetwork(
        t.db,
        userId,
        {
          people: 360,
          orgs: 50,
          cities: 20,
          schools: 15,
          withOrg: 0.6,
          withCity: 0.3,
          withSchool: 0.2,
          withHistory: 0.3,
          withEmail: 0.35,
          threads: 140,
          events: 40,
        },
        5,
      )
    ).personIds;
    await refreshTies(t.db, userId, NOW);
    const sorted = [...ids].sort();
    for (let i = 0; i < sorted.length; i += 100)
      await scorePeople(t.db, userId, { now: NOW, personIds: sorted.slice(i, i + 100) });
    // evidence ranking reads (one-way engagement, a fading thread, an old job) and words it does not (the org name)
    await addTie(t, userId, ids[1]!, ids[2]!, 'linkedin_engagement', 0.4, 0.8, {
      reciprocal: false,
      wBy: { [ids[2]!]: 0.5 },
      counts: { comments: 2 },
      items: 4,
    });
    await addTie(t, userId, ids[2]!, ids[3]!, 'email_exchange', 0.7, 0.95, {
      threads: 5,
      firstAt: '2023-01-01T00:00:00Z',
      lastAt: '2024-01-01T00:00:00Z',
      lastSubject: 'Lunch',
    });
    await addTie(t, userId, ids[3]!, ids[4]!, 'co_tenure', 0.6, 0.8, { orgName: 'Initech', toYear: 2019 });
    // a hidden person and a blocked pair stay out of every route
    await t.db.sql`update orbit.people set hidden_at = now() where id = ${ids[5]!}::uuid`;
    const [lo, hi] = ids[2]! < ids[4]! ? [ids[2]!, ids[4]!] : [ids[4]!, ids[2]!];
    await t.db.sql`insert into orbit.blocked_pairs (user_id, a_person_id, b_person_id)
      values (${userId}::uuid, ${lo}::uuid, ${hi}::uuid)`;

    // targets: the people with the most ties (dense neighbourhoods), the tie-rich few above, and a sample of the rest
    const busiest = await t.db.sql<{ id: string }>`
      select id from (
        select a_person_id as id from orbit.ties where user_id = ${userId}::uuid
        union all select b_person_id from orbit.ties where user_id = ${userId}::uuid) x
       group by id order by count(*) desc, id limit 6`;
    const targets = [
      ...new Set([...busiest.map((b) => b.id), ids[3]!, ids[4]!, ...ids.filter((_, i) => i % 41 === 0)]),
    ];
    const c = counting(t.db);
    const s = makeServices(agentConfig(fakeNet(), {}), { db: c.db, now: () => NOW });
    let routed = 0;
    const words: string[] = [];
    for (const target of targets) {
      c.reset();
      const got = await findPaths(s, userId, { target: { personId: target } });
      expect(c.people(), target).toBe(1);
      const want = await reference(userId, target);
      expect(shape(got), target).toEqual({ paths: want.paths, fallback: want.fallback, direct: want.direct });
      if (got.paths.length) routed++;
      for (const p of got.paths) words.push(p.reasonText);
    }
    expect(routed).toBeGreaterThan(3);
    // the words came from the full evidence (company names are not among the keys ranking reads)
    expect(words.some((w) => /Company \d+/.test(w))).toBe(true);
  }, 120_000);

  it('patches the graph after new mutuals and Village ties instead of loading it again', async () => {
    const net = fakeNet((call: NetCall) => {
      if (call.url === 'https://api.village.do/v2/auth/tokens') return jsonRes(200, villageToken);
      if (call.url === 'https://api.village.do/v2/people/paths') return jsonRes(200, villagePerson);
      if (call.url === 'https://api.village.do/v2/companies/paths') return jsonRes(200, villageCompany);
      if (call.url.startsWith(`${UNIPILE}/api/v1/linkedin/search`)) return jsonRes(200, mutuals);
      if (call.url.startsWith(`${UNIPILE}/api/v1/users/ACoAADanaLee?`))
        return jsonRes(200, { provider_id: 'ACoAADanaLee', shared_connections_count: 2 });
      return undefined;
    });
    const { userId } = await signedInUser(t);
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
    await addPerson(t, userId, {
      name: 'Omar Hale',
      score: 45,
      linkedinUrl: 'https://www.linkedin.com/in/omar-hale',
    });
    await addPerson(t, userId, {
      name: 'Sam Ortiz',
      score: 70,
      linkedinUrl: 'https://www.linkedin.com/in/sam-ortiz',
    });
    // Mia's own people, out of Dana's reach until the mutuals tie Mia to Dana: their ties must come along
    const xena = await addPerson(t, userId, { name: 'Xena Ward', score: 80 });
    const yuri = await addPerson(t, userId, { name: 'Yuri Bell', score: 35 });
    const zoe = await addPerson(t, userId, { name: 'Zoe Kim', score: 30 });
    await addTie(t, userId, mia, xena, 'email_exchange', 0.9, 0.95, { threads: 3 });
    await addTie(t, userId, xena, yuri, 'email_exchange', 0.8, 0.95, { threads: 2 });
    await addTie(t, userId, yuri, zoe, 'meeting_coattendee', 0.7, 0.9, { events: 2 });
    await addTie(t, userId, xena, zoe, 'email_exchange', 0.6, 0.95, { threads: 1 });

    const c = counting(t.db);
    const s = makeServices(agentConfig(net), { db: c.db, now: () => NOW });
    const got = await findPaths(s, userId, { target: { personId: dana } });
    // the neighbourhood, then only the people the new ties brought near
    expect(c.people()).toBeLessThanOrEqual(2);
    expect(got.paths.length).toBeGreaterThan(0);
    const want = await reference(userId, dana);
    expect(shape(got)).toEqual({ paths: want.paths, fallback: want.fallback, direct: want.direct });
    expect(got.paths.some((p) => p.nodes.includes(xena))).toBe(true);
  }, 60_000);
});
