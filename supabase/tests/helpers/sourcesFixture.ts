/**
 * Plan 43's fixture student (§3.2, §8.1): rows from LinkedIn and Gmail (the base) and from each optional source
 * (Instagram, X, texts), seeded the same way every time, and a snapshot of what every entry point gives for them:
 * closeness, paths to a person and to a company, what the browser pulls, the friend projection and the context a draft
 * is written from. Ids, row times and the student's own id are taken out, people are named, so two students seeded
 * the same way compare equal.
 */
import { prepareCompose } from '../../functions/_shared/compose/compose.ts';
import type { Db } from '../../functions/_shared/db.ts';
import { refreshFriendShares } from '../../functions/_shared/friends/shares.ts';
import { findPaths } from '../../functions/_shared/paths/find.ts';
import { makeServices, type Services } from '../../functions/_shared/services.ts';
import { sourcesFor } from '../../functions/_shared/sources/states.ts';
import { pull } from '../../functions/orbit-api/sync.ts';
import { PULL_BY_NAME, type PullTable } from '../../functions/orbit-api/tables.ts';
import { fakeEmbed, fakeNet } from './agents.ts';
import { makeUser, type TestDb } from './pglite.ts';

export type Optional = 'instagram' | 'x' | 'imessage';
export const NOW = new Date('2026-11-01T12:00:00Z');
const DAY = 86_400_000;
const ago = (days: number, hours = 0) =>
  new Date(NOW.getTime() - days * DAY - hours * 3_600_000).toISOString();

/** The tables the browser pulled before plan 43. */
export const BASE_PULL_TABLES = [
  'organizations',
  'people',
  'person_identities',
  'affiliations',
  'merge_suggestions',
  'goals',
  'threads',
  'messages',
  'calendar_events',
  'ties',
  'tie_scores',
  'tie_labels',
  'chats',
  'stage_events',
  'drafts',
  'notes',
  'uploads',
  'facts',
  'dossiers',
  'recommendations',
  'intro_requests',
  'suggestions',
  'notifications',
];

export interface Seeded {
  userId: string;
  people: Record<string, string>;
}

export interface SeedOptions {
  /** LinkedIn and Gmail rows */
  base: boolean;
  /** which optional sources' rows to seed */
  rows: readonly Optional[];
  /** each optional source's state (no row when unset) */
  states?: Partial<Record<Optional, 'on' | 'off' | 'removed' | 'not_connected'>>;
}

let seq = 0;

export async function seedStudent(t: TestDb, o: SeedOptions): Promise<Seeded> {
  const db = t.db;
  const u = await makeUser(db, {
    email: `sources-${++seq}-${Math.random().toString(36).slice(2, 8)}@example.com`,
  });
  await db.sql`update orbit.users set full_name = 'Sam Rivera', first_name = 'Sam', last_name = 'Rivera',
                school = 'Stanford', current_city = 'New York, NY', timezone = 'America/Los_Angeles'
                where id = ${u}::uuid`;
  const people: Record<string, string> = {};
  const person = async (
    key: string,
    name: string,
    p: {
      sources: string[];
      email?: string;
      title?: string;
      org?: string;
      member?: string;
      self?: boolean;
      sourceAccount?: string;
      listed?: boolean;
    },
  ) => {
    const [first, ...rest] = name.split(' ');
    const [row] = await db.sql<{ id: string }>`
      insert into orbit.people (user_id, is_self, display_name, first_name, last_name, name_norm, primary_email, title,
                                org_raw, linkedin_member_id, linkedin_slug, linkedin_url, sources, source_account, listed)
      values (${u}::uuid, ${p.self ?? false}, ${name}, ${first}, ${rest.join(' ') || null}, ${name.toLowerCase()},
              ${p.email ?? null}, ${p.title ?? null}, ${p.org ?? null}, ${p.member ?? null},
              ${p.member ? `${key}-slug` : null}, ${p.member ? `https://www.linkedin.com/in/${key}-slug` : null},
              ${p.sources}::text[], ${p.sourceAccount ?? null}, ${p.listed ?? true})
      returning id`;
    people[key] = row!.id;
    if (p.email) await identity(key, 'email', p.email, p.sources[0] ?? 'gmail');
    if (p.member) await identity(key, 'linkedin_member', p.member, 'linkedin_relation', ago(400));
    return row!.id;
  };
  const identity = (key: string, kind: string, value: string, source: string, at?: string) =>
    db.sql`insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source, created_at)
           values (${u}::uuid, ${people[key]!}::uuid, ${kind}, ${value}, ${value}, ${source},
                   coalesce(${at ?? null}::timestamptz, now()))`;
  const tie = async (
    a: string,
    b: string,
    kind: string,
    weight: number,
    confidence: number,
    ev: object = {},
  ) => {
    const [x, y] = [people[a]!, people[b]!].sort();
    await db.sql`insert into orbit.ties (user_id, a_person_id, b_person_id, kind, weight, confidence, evidence,
                                         first_seen_at, last_seen_at)
                 values (${u}::uuid, ${x}::uuid, ${y}::uuid, ${kind}, ${weight}, ${confidence}, ${ev}::jsonb,
                         ${ago(200)}::timestamptz, ${ago(20)}::timestamptz)`;
  };
  let threadNo = 0;
  const thread = async (
    provider: string,
    key: string,
    msgs: { dir: 'in' | 'out'; days: number; words?: boolean; text?: string }[],
    o: { participants?: number; account?: string; networking?: boolean } = {},
  ) => {
    const pid = people[key]!;
    // mail threads are numbered in seeding order; a chat is named by its source and person, whatever was seeded before
    const ext = provider === 'gmail' ? `${provider}-${key}-${++threadNo}` : `${provider}-${key}`;
    const sorted = [...msgs].sort((a, b) => b.days - a.days);
    const last = sorted.at(-1)!;
    const [th] = await db.sql<{ id: string }>`
      insert into orbit.threads (user_id, provider, external_id, subject, participant_person_ids, participant_count,
                                 first_at, last_at, message_count, last_direction, is_networking, social_account_id)
      values (${u}::uuid, ${provider}, ${ext}, ${provider === 'gmail' ? 'Catching up' : null}, ${[pid]}::uuid[],
              ${o.participants ?? 1}, ${ago(sorted[0]!.days)}::timestamptz, ${ago(last.days)}::timestamptz,
              ${msgs.length}, ${last.dir}, ${o.networking ?? true}, ${o.account ?? null})
      returning id`;
    let i = 0;
    for (const m of sorted)
      await db.sql`
        insert into orbit.messages (user_id, thread_id, provider, external_id, direction, from_person_id, from_addr,
                                    to_person_ids, sent_at, subject, body_text, snippet, social_account_id, has_words)
        values (${u}::uuid, ${th!.id}::uuid, ${provider}, ${`${ext}-${i++}`}, ${m.dir},
                ${m.dir === 'in' ? pid : null}::uuid, ${m.dir === 'in' ? `${key}@example.org` : 'sam@example.com'},
                ${m.dir === 'out' ? [pid] : []}::uuid[], ${ago(m.days)}::timestamptz,
                ${provider === 'gmail' ? 'Catching up' : null}, ${m.text ?? 'Good to hear from you, talk soon.'},
                ${m.text ?? 'Good to hear from you'}, ${o.account ?? null},
                ${provider === 'gmail' || provider === 'linkedin' ? null : (m.words ?? true)})`;
    return th!.id;
  };

  await person('self', 'Sam Rivera', { sources: ['self'], self: true, email: 'sam@example.com' });
  // the target: at Stripe; a manual entry for a student with neither LinkedIn nor Gmail
  await person('cara', 'Cara Diaz', {
    sources: o.base ? ['linkedin'] : ['manual'],
    title: 'Product Designer',
    org: 'Stripe',
    member: o.base ? 'm-cara' : undefined,
  });
  if (o.base) {
    await person('ana', 'Ana Lopez', {
      sources: ['gmail'],
      email: 'ana@example.org',
      title: 'Analyst',
      org: 'Ramp',
    });
    await person('ben', 'Ben Ortiz', {
      sources: ['linkedin'],
      title: 'Engineer',
      org: 'Stripe',
      member: 'm-ben',
    });
    await person('dev', 'Dev Shah', {
      sources: ['gmail'],
      email: 'dev@example.org',
      title: 'Founder',
      org: 'Plaid',
    });
    await thread('gmail', 'ana', [
      { dir: 'out', days: 40 },
      { dir: 'in', days: 39 },
      { dir: 'out', days: 12 },
      { dir: 'in', days: 11 },
    ]);
    await thread('gmail', 'dev', [{ dir: 'in', days: 90 }]);
    await tie('ben', 'cara', 'linkedin_mutual', 0.3, 0.95, { source: 'unipile' });
    await tie('ana', 'dev', 'email_cc', 0.4, 0.8, { threads: 1 });
    await tie('dev', 'cara', 'email_exchange', 0.5, 0.9, { threads: 1, messages: 2 });
    await db.sql`insert into orbit.tie_labels (user_id, person_id, closeness) values (${u}::uuid, ${people.ana!}::uuid, 4)`;
  } else {
    await person('eve', 'Eve Ford', { sources: ['manual'], title: 'Student', org: 'Stanford' });
    await db.sql`insert into orbit.notes (user_id, person_ids, source, occurred_at, raw_text)
                 values (${u}::uuid, ${[people.eve!]}::uuid[], 'manual', ${ago(30)}::timestamptz, 'Met Eve at a talk')`;
  }

  if (o.rows.includes('instagram')) {
    await db.sql`insert into orbit.integration_accounts (user_id, provider, external_account_id, social_account_id, status)
                 values (${u}::uuid, 'instagram', 'unipile-ig', 'ig_me', 'active')`;
    await person('ivy', 'Ivy Park', { sources: ['instagram'], sourceAccount: 'instagram:ig_ivy' });
    await person('uma', 'Uma Bell', {
      sources: ['instagram'],
      sourceAccount: 'instagram:ig_uma',
      listed: false,
    });
    await identity('ivy', 'instagram_id', 'ig_ivy', 'instagram');
    await identity('uma', 'instagram_id', 'ig_uma', 'instagram');
    await db.sql`insert into orbit.social_links (user_id, platform, account_id, person_id, via)
                 values (${u}::uuid, 'instagram', 'ig_ivy', ${people.ivy!}::uuid, 'proof'),
                        (${u}::uuid, 'instagram', 'ig_uma', ${people.uma!}::uuid, 'proof')`;
    await thread(
      'instagram',
      'ivy',
      [
        { dir: 'out', days: 9 },
        { dir: 'in', days: 9 },
        { dir: 'in', days: 3, words: false },
        { dir: 'out', days: 2 },
      ],
      { account: 'ig_ivy' },
    );
    await tie('ivy', 'cara', 'instagram_mutual', 0.3, 0.9, { source: 'instagram' });
    await tie('uma', 'cara', 'instagram_mutual', 0.3, 0.9, { source: 'instagram' });
    await db.sql`insert into orbit.social_follows (platform, follower_id, followed_id, owner_user_id)
                 values ('instagram', 'ig_me', 'ig_uma', ${u}::uuid), ('instagram', 'ig_uma', 'ig_me', ${u}::uuid),
                        ('instagram', 'ig_me', 'ig_ivy', ${u}::uuid)`;
    await db.sql`insert into orbit.social_list_reads (platform, account_id, list, owner_user_id, read_by, rows_read, ended)
                 values ('instagram', 'ig_me', 'following', ${u}::uuid, ${u}::uuid, 3, true)`;
    if (o.base) {
      await db.sql`insert into orbit.social_links (user_id, platform, account_id, person_id, via)
                   values (${u}::uuid, 'instagram', 'ig_ben', ${people.ben!}::uuid, 'proof')`;
      await identity('ben', 'instagram_id', 'ig_ben', 'instagram');
      await db.sql`insert into orbit.social_follows (platform, follower_id, followed_id, owner_user_id)
                   values ('instagram', 'ig_me', 'ig_ben', ${u}::uuid), ('instagram', 'ig_ben', 'ig_me', ${u}::uuid)`;
      await thread(
        'instagram',
        'ben',
        [
          { dir: 'out', days: 5 },
          { dir: 'in', days: 4 },
        ],
        { account: 'ig_ben' },
      );
      await tie('ben', 'ivy', 'instagram_follow', 0.1, 0.9, { followerId: people.ben });
    }
  }
  if (o.rows.includes('x')) {
    await db.sql`insert into orbit.integration_accounts (user_id, provider, external_account_id, social_account_id, status)
                 values (${u}::uuid, 'x', 'x-oauth', 'x_me', 'active')`;
    await person('xan', 'Xan Wu', { sources: ['x'], sourceAccount: 'x:x_xan' });
    await identity('xan', 'x_id', 'x_xan', 'x');
    await db.sql`insert into orbit.social_links (user_id, platform, account_id, person_id, via)
                 values (${u}::uuid, 'x', 'x_xan', ${people.xan!}::uuid, 'proof')`;
    await db.sql`insert into orbit.social_follows (platform, follower_id, followed_id, owner_user_id)
                 values ('x', 'x_me', 'x_xan', ${u}::uuid), ('x', 'x_xan', 'x_me', ${u}::uuid)`;
    await thread(
      'x',
      'xan',
      [
        { dir: 'out', days: 15 },
        { dir: 'in', days: 14 },
      ],
      { account: 'x_xan' },
    );
    await tie('xan', 'cara', 'x_mutual', 0.25, 0.9, { source: 'x' });
    if (o.base) await tie('xan', 'ben', 'x_follow', 0.1, 0.9, { followerId: people.xan });
  }
  if (o.rows.includes('imessage')) {
    await person('tia', 'Tia Moss', { sources: ['imessage'] });
    await identity('tia', 'phone', '+15550001111', 'imessage');
    const days = (key: string, rows: [number, number, number, number][]) =>
      db.sql`insert into orbit.text_days (user_id, person_id, day, in_count, out_count, group_size, words)
             select ${u}::uuid, ${people[key]!}::uuid, (${NOW.toISOString()}::timestamptz - make_interval(days => r.d))::date,
                    r.i, r.o, r.g, true
               from unnest(${rows.map((r) => r[0])}::int[], ${rows.map((r) => r[1])}::int[],
                           ${rows.map((r) => r[2])}::int[], ${rows.map((r) => r[3])}::int[]) as r(d, i, o, g)`;
    await days('tia', [
      [2, 3, 4, 2],
      [6, 1, 2, 2],
      [20, 2, 0, 4],
    ]);
    if (o.base)
      await days('ana', [
        [1, 2, 2, 2],
        [8, 1, 1, 2],
      ]);
  }
  for (const [source, state] of Object.entries(o.states ?? {}))
    await db.sql`insert into orbit.source_states (user_id, source, state, off_since)
                 values (${u}::uuid, ${source}, ${state}, ${state === 'off' ? NOW.toISOString() : null}::timestamptz)`;
  return { userId: u, people };
}

/** Services with no provider configured: nothing leaves the test. */
export function quietServices(db: Db, extra: Record<string, unknown> = {}): Services {
  const net = fakeNet();
  return makeServices(
    { env: { ...extra }, fetch: net.fetch, embed: fakeEmbed, sleep: async () => {}, random: () => 0 },
    { db, now: () => NOW },
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DROP = new Set([
  'id',
  'userId',
  'user_id',
  'ownerUserId',
  'owner_user_id',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
  'scoredAt',
  'scored_at',
  'computedAt',
  'computed_at',
  'emailHash',
  'email_hash',
]);

const PAIRS = [
  ['aPersonId', 'bPersonId'],
  ['personAId', 'personBId'],
  ['a_person_id', 'b_person_id'],
] as const;

/** Ids to names, row times and owners out, so two students seeded alike compare equal. */
export function normalize(v: unknown, names: Map<string, string>): unknown {
  if (Array.isArray(v)) return v.map((x) => normalize(x, names));
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      if (DROP.has(k)) continue;
      const key = names.get(k) ?? k;
      out[key] = normalize((v as Record<string, unknown>)[k], names);
    }
    // a pair is stored with the smaller id first: by name, so the order does not depend on the ids drawn
    for (const [a, b] of PAIRS)
      if (typeof out[a] === 'string' && typeof out[b] === 'string' && (out[a] as string) > (out[b] as string))
        [out[a], out[b]] = [out[b], out[a]];
    return out;
  }
  if (typeof v === 'string') {
    if (names.has(v)) return names.get(v);
    if (UUID.test(v)) return '<id>';
    let s = v;
    for (const [id, name] of names) if (s.includes(id)) s = s.split(id).join(name);
    return s.replace(/path_[0-9a-f]{16}/g, 'path_<id>');
  }
  return v;
}

const sortRows = (rows: unknown[]) =>
  [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

export interface Snapshot {
  scores: unknown;
  paths: unknown;
  company: unknown;
  pull: unknown;
  friends: unknown;
  draft: unknown;
}

export interface SnapshotOptions {
  /** tables to pull (default: the ones before plan 43) */
  tables?: string[];
  /** the optional sources the owner offers (ORBIT_EXTRA_SOURCES); none by default */
  offered?: Optional[];
}

/** What every entry point gives for the student, named and without ids. */
export async function snapshot(t: TestDb, s: Seeded, o: SnapshotOptions = {}): Promise<Snapshot> {
  const db = t.db;
  const u = s.userId;
  const names = new Map<string, string>();
  const all = await db.sql<{ id: string; display_name: string }>`
    select id, display_name from orbit.people where user_id = ${u}::uuid`;
  for (const p of all) names.set(p.id, `person:${p.display_name}`);
  names.set(u, 'student');
  const offered = o.offered ?? [];
  const svc = quietServices(db, offered.length ? { extraSources: offered } : {});
  const src = await sourcesFor(db, u, offered);

  const tables = (o.tables ?? BASE_PULL_TABLES)
    .map((n) => PULL_BY_NAME.get(n))
    .filter((x): x is PullTable => !!x);
  const pulled = await pull(db, u, {
    cursor: {},
    tables,
    limit: 2000,
    upTo: new Date('2100-01-01T00:00:00Z'),
    sources: src,
  });
  const pullOut: Record<string, unknown> = {};
  for (const [table, rows] of Object.entries(pulled.changes))
    pullOut[table] = sortRows(normalize(rows, names) as unknown[]);
  const deleted: Record<string, unknown> = {};
  for (const [table, ids] of Object.entries(pulled.deleted))
    deleted[table] = [...(normalize(ids, names) as string[])].sort();

  // closeness, for the people the browser is given
  const shown = new Set(((pulled.changes.people ?? []) as { id: string }[]).map((p) => p.id));
  const scoreRows = await db.sql<Record<string, unknown>>`
    select p.id, p.display_name, p.strength, p.last_interaction_at, ts.score, ts.share_score, ts.band, ts.features,
           ts.explanation
      from orbit.people p left join orbit.tie_scores ts on ts.user_id = p.user_id and ts.person_id = p.id
     where p.user_id = ${u}::uuid and not p.is_self order by p.display_name`;
  const scores = normalize(
    scoreRows.filter((r) => shown.has(r.id as string)),
    names,
  );

  const target = s.people.cara!;
  // routes of equal score come in the order of their ids: sorted, so the order does not depend on the ids drawn
  const routes = (r: unknown) => {
    const o = r as { paths?: unknown[] };
    return { ...o, paths: sortRows(o.paths ?? []) };
  };
  const paths = routes(normalize(await findPaths(svc, u, { target: { personId: target } }), names));
  const company = routes(normalize(await findPaths(svc, u, { target: { company: 'Stripe' } }), names));

  await refreshFriendShares(db, u, NOW, src);
  const shares = await db.sql<Record<string, unknown>>`
    select * from orbit.friend_shares where owner_user_id = ${u}::uuid order by display_name`;
  const friends = normalize(shares, names);

  const draftFor = async (personId: string, kind: 'bump' | 'first_touch') => {
    const p = await prepareCompose(svc, { userId: u, personId, kind, channel: 'gmail' });
    return { system: p.system, user: p.user };
  };
  const draft = normalize(
    {
      target: await draftFor(target, 'first_touch'),
      ...(s.people.ana ? { ana: await draftFor(s.people.ana, 'bump') } : {}),
    },
    names,
  );
  return { scores, paths, company, pull: { changes: pullOut, deleted }, friends, draft };
}
