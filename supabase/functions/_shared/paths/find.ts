/**
 * Warm paths on the server (§4): the user's graph from orbit.people, tie_scores, ties and intro_requests in the core
 * routing shape; Unipile mutuals and Village introducers gathered (30-day cache) and stored as ties; then core's
 * `rankWarmPaths` for a person and `rankCompanyTargets` for a company. Each path gets a stable id (a hash of the
 * user and its nodes) and the names of its nodes.
 */
import {
  pairKeyOf,
  type RoutePerson,
  rankCompanyTargets,
  rankWarmPaths,
  type TargetInfo,
  type WarmPath,
} from '@orbit/core/graph/route';
import {
  combineTies,
  ROUTABLE_TIE_KINDS,
  TIE_KINDS,
  type Tie,
  type TieKind,
  type TiePair,
} from '@orbit/core/graph/ties';
import { responsePrior } from '@orbit/core/recommend/score';
import { looksLikeMinor } from '@orbit/core/safety/rules';
import type { PathsFindRequest, PathsFindResponse } from '@orbit/core/server/api';
import { normalizeEmail, parseName } from '@orbit/core/text/normalize';
import type { GoalKind, Person } from '@orbit/core/types';
import { sha256Hex } from '../crypto.ts';
import type { Db } from '../db.ts';
import {
  CLOSENESS_P,
  closenessPhrase,
  friendNode,
  friendPersonNode,
  isFriendNode,
  matchShares,
  type ShareRow,
  type SharingFriend,
  sharingFriends,
  visibleShares,
} from '../friends/shares.ts';
import { HttpError } from '../http.ts';
import { cleanLinkedInUrl, linkedInSlugOf } from '../providers/unipileResearch';
import { sqlBudget, sqlCache } from '../research/bind.ts';
import { iso, num } from '../rows.ts';
import { requestReads } from '../search/reading.ts';
import type { Services } from '../services.ts';
import { hiddenPeople, NO_SOURCES, offeredOf, type SourcesInUse, sourcesFor } from '../sources/states.ts';
import {
  type ExternalResult,
  type ExternalTarget,
  gatherExternalCandidates,
  type PersonRef,
  type TieRow,
} from './externalCandidates';
import { enqueueHopEvidence, hopEvidenceFresh, linkedinAccountOf } from './hopJob';

const DAY = 86_400_000;

export interface GraphPerson extends RoutePerson {
  displayName: string;
  title?: string;
  org?: string;
  isAlumni: boolean;
  linkedinUrl?: string;
  memberId?: string;
  doNotContact: boolean;
}

export interface UserGraph {
  selfId: string | null;
  people: Map<string, GraphPerson>;
  pairs: Map<string, TiePair>;
  /** pairs the student said do not really know each other (plan 21 §3.5), keyed `${a}|${b}` with a < b */
  blocked: Set<string>;
}

const TIE_KIND_SET = new Set<string>(TIE_KINDS);

type GraphPersonRow = {
  id: string;
  is_self: boolean;
  display_name: string;
  first_name: string | null;
  title: string | null;
  org_raw: string | null;
  org_name: string | null;
  is_alumni: boolean;
  linkedin_url: string | null;
  linkedin_member_id: string | null;
  hidden_at: Date | null;
  do_not_contact: boolean;
  last_interaction_at: Date | null;
  score: number | null;
  reciprocity: unknown;
};

type GraphTieRow = {
  a_person_id: string;
  b_person_id: string;
  kind: string;
  weight: number;
  confidence: number;
  evidence: Record<string, unknown> | null;
  first_seen_at: Date;
  last_seen_at: Date;
};

/**
 * Only the tie score's reciprocity feature is read here (pAsk); the rest of `features` never leaves the database.
 * People known only from an optional source out of use are left out (plan 43 §3.2); `hidden` is the parameter that
 * holds those sources.
 */
const personColumns = (hidden: string) => `p.id, p.is_self, p.display_name, p.first_name, p.title, p.org_raw,
       o.name as org_name, p.is_alumni, p.linkedin_url, p.linkedin_member_id, p.hidden_at, p.do_not_contact,
       p.last_interaction_at, ts.score::int as score, ts.features->'reciprocity' as reciprocity
  from orbit.people p
  left join orbit.organizations o on o.id = p.org_id
  left join orbit.tie_scores ts on ts.user_id = p.user_id and ts.person_id = p.id
 where p.user_id = $1::uuid and p.deleted_at is null and p.merged_into is null
   and orbit.person_in_use(p.sources, p.source_account, ${hidden}::text[])`;

/**
 * The evidence keys ranking reads (plan 35 B7): one-way engagement (pKnowDirected), the counts and dates that say a
 * pair is fading (pairFading) and whether it is old (pairIsOld). Phrases read the rest, fetched for the chosen routes
 * only (`withFullEvidence`).
 */
export const RANKING_EVIDENCE_KEYS = [
  'reciprocal',
  'wBy',
  'threads',
  'events',
  'messages',
  'items',
  'firstAt',
  'lastAt',
  'ongoing',
  'current',
  'toYear',
] as const;
/** `current` is read only for its length (two people there now): a stand-in of the same length, not their ids. */
const slimKey = (k: (typeof RANKING_EVIDENCE_KEYS)[number]) =>
  k === 'current'
    ? `'current', case when jsonb_typeof(t.evidence->'current') = 'array'
         then (select coalesce(jsonb_agg(0), '[]'::jsonb) from jsonb_array_elements(t.evidence->'current')) end`
    : `'${k}', t.evidence->'${k}'`;
const SLIM_EVIDENCE = `jsonb_strip_nulls(jsonb_build_object(${RANKING_EVIDENCE_KEYS.map(slimKey).join(', ')}))`;
const TIE_COLUMNS = (slim: boolean) =>
  `t.a_person_id, t.b_person_id, t.kind, t.weight, t.confidence, ${slim ? SLIM_EVIDENCE : 't.evidence'} as evidence,
   t.first_seen_at, t.last_seen_at`;

interface GraphContext {
  intros: { introducer_person_id: string | null; status: string; asked_at: Date; outcome_at: Date | null }[];
  targetOrgs: Set<string>;
  owes: Set<string>;
  blocked: Set<string>;
  /** which optional sources count (plan 43 §3.2) */
  src: SourcesInUse;
  /** people known only from sources out of use: a tie that touches one is left out */
  hidden: Set<string>;
}

/**
 * What every graph load reads besides people and ties: intro requests, goal target companies, owed replies, blocks,
 * and the people and tie kinds the optional sources out of use leave out (plan 43 §3.2).
 */
async function graphContext(
  db: Db,
  userId: string,
  now: Date,
  src: SourcesInUse = NO_SOURCES,
): Promise<GraphContext> {
  const intros = await db.sql<GraphContext['intros'][number]>`
    select introducer_person_id, status, asked_at, outcome_at from orbit.intro_requests
     where user_id = ${userId}::uuid and introducer_person_id is not null`;
  const goals = await db.sql<{ targets: { organizations?: string[] } }>`
    select targets from orbit.goals where user_id = ${userId}::uuid and status = 'active' and deleted_at is null`;
  const targetOrgs = new Set(
    goals.flatMap((g) => g.targets?.organizations ?? []).map((o) => o.toLowerCase().trim()),
  );
  const owes = await db.sql<{ person_id: string }>`
    select distinct m.from_person_id as person_id from orbit.threads t
      join orbit.messages m on m.thread_id = t.id and m.sent_at = t.last_at
     where t.user_id = ${userId}::uuid and t.last_direction = 'in' and t.is_networking
       and t.provider <> all(${src.excluded.providers}::text[])
       and m.from_person_id is not null and t.last_at > ${new Date(now.getTime() - 30 * DAY)}::timestamptz`;
  const blockedRows = await db.sql<{ a_person_id: string; b_person_id: string }>`
    select a_person_id, b_person_id from orbit.blocked_pairs where user_id = ${userId}::uuid`;
  return {
    intros,
    targetOrgs,
    owes: new Set(owes.map((o) => o.person_id)),
    blocked: new Set(blockedRows.map((b) => pairKeyOf(b.a_person_id, b.b_person_id))),
    src,
    hidden: await hiddenPeople(db, userId, src),
  };
}

function graphPerson(r: GraphPersonRow, c: GraphContext, now: Date): GraphPerson {
  const mine = c.intros.filter((i) => i.introducer_person_id === r.id);
  const declined = mine
    .filter((i) => i.status === 'declined')
    .map((i) => iso(i.outcome_at ?? i.asked_at)!)
    .sort()
    .pop();
  const org = r.org_name ?? r.org_raw ?? undefined;
  return {
    id: r.id,
    name: r.first_name ?? r.display_name.split(/\s+/)[0]!,
    displayName: r.display_name,
    score: r.score ?? 0,
    reciprocity: num(r.reciprocity),
    sharesGoalTargetOrg: !!org && c.targetOrgs.has(org.toLowerCase().trim()),
    askedRecently: mine.some((i) => now.getTime() - new Date(i.asked_at).getTime() < 30 * DAY),
    introducedUserBefore: mine.some((i) => i.status === 'intro_made' || i.status === 'meeting'),
    owesReply: c.owes.has(r.id),
    lastContactAt: iso(r.last_interaction_at) ?? undefined,
    hidden: !!r.hidden_at || r.do_not_contact,
    declinedIntroAt: declined,
    title: r.title ?? undefined,
    org,
    isAlumni: r.is_alumni,
    linkedinUrl: r.linkedin_url ?? undefined,
    memberId: r.linkedin_member_id ?? undefined,
    doNotContact: r.do_not_contact,
  };
}

const tieKey = (a: string, b: string, kind: string) => `${a}|${b}|${kind}`;

function tieOf(t: GraphTieRow, userId: string): Tie {
  return {
    id: tieKey(t.a_person_id, t.b_person_id, t.kind),
    userId,
    aId: t.a_person_id,
    bId: t.b_person_id,
    kind: t.kind as TieKind,
    weight: num(t.weight),
    confidence: num(t.confidence),
    evidence: t.evidence ?? {},
    firstSeenAt: iso(t.first_seen_at) ?? undefined,
    lastSeenAt: iso(t.last_seen_at) ?? undefined,
  };
}

/** A loaded graph that can grow (`extendNeighbourhood`) and take full evidence later (`withFullEvidence`). */
interface LoadedGraph extends UserGraph {
  userId: string;
  now: Date;
  ctx: GraphContext;
  /** every tie loaded, by `${a}|${b}|${kind}` (the self's ties left out, as core never routes through them) */
  ties: Map<string, Tie>;
  /** a neighbourhood load: hops from the target per person whose every tie is loaded; undefined for the whole graph */
  depth?: Map<string, number>;
  /** pairs whose ties carry their full evidence */
  full: Set<string>;
}

function addTies(g: LoadedGraph, rows: GraphTieRow[]): void {
  const off = new Set<string>(g.ctx.src.excluded.tieKinds);
  for (const t of rows) {
    if (!TIE_KIND_SET.has(t.kind) || t.a_person_id === g.selfId || t.b_person_id === g.selfId) continue;
    // plan 43 §3.2: a tie of a source out of use, or to someone only that source knows, is not there
    if (off.has(t.kind) || g.ctx.hidden.has(t.a_person_id) || g.ctx.hidden.has(t.b_person_id)) continue;
    const tie = tieOf(t, g.userId);
    g.ties.set(tie.id, tie);
  }
}

function rebuildPairs(g: LoadedGraph): void {
  g.pairs = combineTies([...g.ties.values()], g.now);
}

/** The user's people and ties in the shape core routes over (every person and tie; full evidence unless `slim`). */
export async function loadGraph(
  db: Db,
  userId: string,
  now: Date,
  opts: { slim?: boolean; sources?: SourcesInUse } = {},
): Promise<UserGraph> {
  return loadWhole(db, userId, now, opts.slim ?? false, opts.sources);
}

async function loadWhole(
  db: Db,
  userId: string,
  now: Date,
  slim: boolean,
  src: SourcesInUse = NO_SOURCES,
): Promise<LoadedGraph> {
  const rows = await db.query<GraphPersonRow>(`select ${personColumns('$2')}`, [userId, src.hidden]);
  const ctx = await graphContext(db, userId, now, src);
  const g = graphOf(userId, now, ctx, rows);
  addTies(
    g,
    await db.query<GraphTieRow>(`select ${TIE_COLUMNS(slim)} from orbit.ties t where t.user_id = $1::uuid`, [
      userId,
    ]),
  );
  rebuildPairs(g);
  if (!slim) for (const k of g.pairs.keys()) g.full.add(k);
  return g;
}

function graphOf(userId: string, now: Date, ctx: GraphContext, rows: GraphPersonRow[]): LoadedGraph {
  let selfId: string | null = null;
  const people = new Map<string, GraphPerson>();
  for (const r of rows) {
    if (r.is_self) selfId = r.id;
    else people.set(r.id, graphPerson(r, ctx, now));
  }
  return {
    userId,
    now,
    ctx,
    selfId,
    people,
    pairs: new Map(),
    blocked: ctx.blocked,
    ties: new Map(),
    full: new Set(),
  };
}

/** Hops from the target a route of at most three hops can reach: you → A → B → target leaves A two pairs away. */
export const NEIGHBOURHOOD_HOPS = 2;

/**
 * People within `NEIGHBOURHOOD_HOPS` pairs of the seeds (each seed at its own starting depth), over every tie but the
 * self's: a recursive walk in the database, so only the target's neighbourhood leaves it.
 */
async function nearby(
  db: Db,
  userId: string,
  seeds: { id: string; depth: number }[],
  ctx: Pick<GraphContext, 'src' | 'hidden'>,
): Promise<Map<string, number>> {
  if (!seeds.length) return new Map();
  const rows = await db.query<{ id: string; depth: number }>(
    `with recursive me as (
       select id from orbit.people where user_id = $1::uuid and is_self
     ), near(id, depth) as (
       select s.id, s.depth from unnest($2::uuid[], $3::int[]) as s(id, depth)
       union
       select x.other, n.depth + 1
         from near n
         cross join lateral (
           select t.b_person_id as other from orbit.ties t
            where t.user_id = $1::uuid and t.a_person_id = n.id and t.kind <> all($5::text[])
           union all
           select t.a_person_id from orbit.ties t
            where t.user_id = $1::uuid and t.b_person_id = n.id and t.kind <> all($5::text[])
         ) x
        where n.depth < $4 and n.id not in (select id from me) and x.other not in (select id from me)
          and x.other <> all($6::uuid[])
     )
     select id, min(depth)::int as depth from near group by id`,
    [
      userId,
      seeds.map((s) => s.id),
      seeds.map((s) => s.depth),
      NEIGHBOURHOOD_HOPS,
      ctx.src.excluded.tieKinds,
      [...ctx.hidden],
    ],
  );
  return new Map(rows.map((r) => [r.id, r.depth]));
}

/**
 * The target's neighbourhood (plan 35 B7): the self, the people within two pairs of the target (every route of at
 * most three hops runs through them), every tie among them and every routable tie leaving them, so common contacts
 * count exactly as on the whole graph. Evidence holds only what ranking reads until `withFullEvidence`. Routes are the same as over
 * `loadGraph`: core's search never leaves this set (hopsToTarget), and every pair it scores is here whole.
 */
export async function loadNeighbourhood(
  db: Db,
  userId: string,
  targetId: string,
  now: Date,
  src: SourcesInUse = NO_SOURCES,
): Promise<LoadedGraph> {
  const ctx = await graphContext(db, userId, now, src);
  const depth = await nearby(db, userId, [{ id: targetId, depth: 0 }], ctx);
  const ids = [...depth.keys()];
  const rows = await db.query<GraphPersonRow>(
    `select ${personColumns('$3')} and (p.is_self or p.id = any($2::uuid[]))`,
    [userId, ids, src.hidden],
  );
  const g = graphOf(userId, now, ctx, rows);
  g.depth = depth;
  addTies(g, await tiesTouching(db, userId, ids, ids));
  rebuildPairs(g);
  return g;
}

/**
 * The ties touching `ids`: every kind between two people of the neighbourhood (`within`), and only the routable
 * kinds out of it, which is all common contacts count (core withCommonContacts). A same-company clique around the
 * target stays in the database.
 */
async function tiesTouching(db: Db, userId: string, ids: string[], within: string[]): Promise<GraphTieRow[]> {
  if (!ids.length) return [];
  return db.query<GraphTieRow>(
    `select ${TIE_COLUMNS(true)} from orbit.ties t
      where t.user_id = $1::uuid and (t.a_person_id = any($2::uuid[]) or t.b_person_id = any($2::uuid[]))
        and (t.kind = any($4::text[]) or (t.a_person_id = any($3::uuid[]) and t.b_person_id = any($3::uuid[])))`,
    [userId, ids, within, [...ROUTABLE_TIE_KINDS]],
  );
}

/**
 * After new ties were stored (Unipile mutuals, Village introducers) and member ids learned: the same graph patched,
 * never loaded again. The new ties are read back as stored (the upsert keeps the larger weight); a person they bring
 * nearer the target brings their own neighbourhood.
 */
async function extendNeighbourhood(
  db: Db,
  g: LoadedGraph,
  added: TieRow[],
  learned: { personId: string; memberId: string }[],
): Promise<void> {
  for (const l of learned) {
    const p = g.people.get(l.personId);
    if (p) p.memberId = l.memberId;
  }
  if (!added.length) return;
  const stored = await db.query<GraphTieRow>(
    `select ${TIE_COLUMNS(true)} from orbit.ties t
       join unnest($2::uuid[], $3::uuid[], $4::text[]) as k(a, b, kind)
         on t.a_person_id = k.a and t.b_person_id = k.b and t.kind = k.kind
      where t.user_id = $1::uuid`,
    [g.userId, added.map((t) => t.a_person_id), added.map((t) => t.b_person_id), added.map((t) => t.kind)],
  );
  addTies(g, stored);
  for (const t of stored) g.full.delete(pairKeyOf(t.a_person_id, t.b_person_id));
  const depth = g.depth;
  if (depth) {
    // an end of a new tie may now be nearer the target than it was (the new ties all touch the target or a
    // person next to it, so two passes settle it)
    const d = (id: string) => depth.get(id) ?? Number.POSITIVE_INFINITY;
    const nearer = new Map<string, number>();
    const at = (id: string) => Math.min(d(id), nearer.get(id) ?? Number.POSITIVE_INFINITY);
    for (let pass = 0; pass < NEIGHBOURHOOD_HOPS; pass++)
      for (const t of stored)
        for (const [x, y] of [
          [t.a_person_id, t.b_person_id],
          [t.b_person_id, t.a_person_id],
        ] as const) {
          const via = at(y) + 1;
          if (via <= NEIGHBOURHOOD_HOPS && via < at(x)) nearer.set(x, via);
        }
    const seeds = [...nearer].map(([id, dd]) => ({ id, depth: dd }));
    const reach = await nearby(db, g.userId, seeds, g.ctx);
    const fresh = [...reach.keys()].filter((id) => !depth.has(id));
    for (const [id, dd] of reach) if (dd < d(id)) depth.set(id, dd);
    if (fresh.length) {
      const rows = await db.query<GraphPersonRow>(
        `select ${personColumns('$3')} and p.id = any($2::uuid[])`,
        [g.userId, fresh, g.ctx.src.hidden],
      );
      for (const r of rows) if (!r.is_self) g.people.set(r.id, graphPerson(r, g.ctx, g.now));
      // a tie between a fresh person and one already here may be of any kind now that both are inside
      addTies(g, await tiesTouching(db, g.userId, fresh, [...depth.keys()]));
    }
  }
  rebuildPairs(g);
}

/**
 * Full evidence for the pairs the routes walk (plan 35 B7): ranking read only RANKING_EVIDENCE_KEYS, the phrases and
 * reasons read the rest. Returns true when anything changed (the caller ranks again, to the same routes).
 */
async function withFullEvidence(db: Db, g: LoadedGraph, paths: Pick<WarmPath, 'nodes'>[]): Promise<boolean> {
  const want = new Set<string>();
  for (const p of paths)
    for (let i = 1; i < p.nodes.length - 1; i++) {
      const k = pairKeyOf(p.nodes[i]!, p.nodes[i + 1]!);
      // stored ties only: a friend's hop (plan 29 §A4) is made here and has no row
      if (!g.full.has(k) && g.pairs.get(k)?.ties.some((t) => g.ties.has(t.id))) want.add(k);
    }
  if (!want.size) return false;
  const pairs = [...want].map((k) => k.split('|') as [string, string]);
  const rows = await db.query<{ a_person_id: string; b_person_id: string; kind: string; evidence: unknown }>(
    `select t.a_person_id, t.b_person_id, t.kind, t.evidence from orbit.ties t
       join unnest($2::uuid[], $3::uuid[]) as k(a, b)
         on (t.a_person_id = k.a and t.b_person_id = k.b) or (t.a_person_id = k.b and t.b_person_id = k.a)
      where t.user_id = $1::uuid`,
    [g.userId, pairs.map((x) => x[0]), pairs.map((x) => x[1])],
  );
  for (const r of rows) {
    const tie = g.ties.get(tieKey(r.a_person_id, r.b_person_id, r.kind));
    if (tie) tie.evidence = (r.evidence as Record<string, unknown>) ?? {};
  }
  for (const k of want) g.full.add(k);
  return true;
}

// ---- the friend layer (plan 29 §A4) -------------------------------------------------------------------------------

/** What a friend shares with the student, as a route can use it: the row, whose it is, and the student's own person
 * for the same human when the identity join (§A2.6) found one. */
export interface FriendShareNode {
  friend: SharingFriend;
  share: ShareRow;
  /** the student's own person id for the same human, else undefined (the share stands as a `friend_person:` node) */
  matchesPersonId?: string;
}

export interface FriendLayer {
  friends: SharingFriend[];
  shares: FriendShareNode[];
}

/**
 * Every active friend who shares with the student, and the rows they share, each joined to the student's own person
 * when there is one. Read through `sharingFriends` (the one cross-tenant path, guarded by the friendship and the
 * owner's mode); never the friend's own tables.
 */
export async function loadFriendLayer(
  db: Db,
  userId: string,
  hidden: readonly string[] = NO_SOURCES.hidden,
): Promise<FriendLayer> {
  const friends = await sharingFriends(db, userId);
  if (!friends.length) return { friends, shares: [] };
  const all: { friend: SharingFriend; share: ShareRow }[] = [];
  for (const friend of friends)
    for (const share of await visibleShares(db, friend)) all.push({ friend, share });
  const matches = await matchShares(
    db,
    userId,
    all.map((x) => x.share),
    hidden,
  );
  return {
    friends,
    shares: all.map((x) => ({ ...x, matchesPersonId: matches.get(x.share.person_id) })),
  };
}

/**
 * Put the friend layer into the student's graph: each friend is a node `friend:<userId>` tied to the student at p 0.9
 * (a friend is asked, not a stranger), and each share that reaches a target becomes a hop friend → person with p from
 * the closeness word (1: 0.35, 2: 0.6, 3: 0.85). A share the student does not have themselves stands as a
 * `friend_person:<id>` node, so a company lookup can list it as a way in; `rankWarmPaths` treats it as any hop.
 */
export function applyFriendLayer(g: UserGraph, shares: FriendShareNode[]): void {
  if (!shares.length) return;
  const used = new Set<string>();
  for (const x of shares) {
    const fid = friendNode(x.friend.userId);
    if (!used.has(fid)) {
      used.add(fid);
      g.people.set(fid, {
        id: fid,
        name: x.friend.firstName,
        displayName: x.friend.name,
        score: 100,
        pAsk: 0.9,
        isAlumni: false,
        doNotContact: false,
      });
    }
    const target = x.matchesPersonId ?? friendPersonNode(x.share.person_id);
    if (!x.matchesPersonId && !g.people.has(target))
      g.people.set(target, {
        id: target,
        name: x.share.display_name.split(/\s+/)[0]!,
        displayName: x.share.display_name,
        score: 0,
        isAlumni: false,
        title: x.share.title ?? undefined,
        org: x.share.company ?? undefined,
        linkedinUrl: x.share.linkedin_slug
          ? `https://www.linkedin.com/in/${x.share.linkedin_slug}`
          : undefined,
        doNotContact: false,
      });
    const key = pairKeyOf(fid, target);
    if (g.pairs.has(key)) continue;
    const p = CLOSENESS_P[x.share.closeness as 1 | 2 | 3] ?? CLOSENESS_P[1];
    const [a, b] = key.split('|') as [string, string];
    const tie: Tie = {
      id: `${key}|student_says_close`,
      userId: x.friend.userId,
      aId: a,
      bId: b,
      kind: 'student_says_close',
      weight: p,
      confidence: 1,
      evidence: { source: 'friend', closeness: x.share.closeness },
      lastSeenAt: iso(x.share.updated_at) ?? undefined,
    };
    g.pairs.set(key, {
      aId: a,
      bId: b,
      weight: p,
      confidence: 1,
      kinds: ['student_says_close'],
      ties: [tie],
    });
  }
}

/** The shares of the layer that reach one person: joined to that person by identity. */
export function sharesFor(layer: FriendLayer, personId: string): FriendShareNode[] {
  return layer.shares.filter((x) => x.matchesPersonId === personId);
}

/** The shares of the layer at one company, by domain or by name. */
export function sharesAt(layer: FriendLayer, company: string, domain?: string): FriendShareNode[] {
  const name = company.trim().toLowerCase();
  const dom = domain?.trim().toLowerCase();
  return layer.shares.filter(
    (x) =>
      (dom && x.share.company_domain?.toLowerCase() === dom) ||
      (!!name && x.share.company?.trim().toLowerCase() === name),
  );
}

/**
 * A path whose first hop is a friend says so (plan 29 §A4): both hops carry `via`, the friend's hop reads as their
 * closeness word, and the reason is the friend's, never a tie score the student does not have.
 */
export function decorateFriendPath<P extends WarmPath>(p: P, layer: FriendLayer, targetFirst: string): P {
  const first = p.nodes[1];
  if (!first || !isFriendNode(first)) return p;
  const friend = layer.friends.find((f) => friendNode(f.userId) === first);
  if (!friend) return p;
  const last = p.nodes[p.nodes.length - 1]!;
  const share = layer.shares.find(
    (x) =>
      x.friend.userId === friend.userId &&
      (x.matchesPersonId === last || friendPersonNode(x.share.person_id) === last),
  );
  const closeness = (share?.share.closeness ?? 1) as 1 | 2 | 3;
  const via = { kind: 'friend' as const, userId: friend.userId, name: friend.name };
  const phrase = closenessPhrase(closeness, targetFirst);
  const at = share?.share.company ? ` at ${share.share.company}` : '';
  return {
    ...p,
    hops: p.hops.map((h, i) => (i === 0 ? { ...h, via } : i === 1 ? { ...h, via, phrase } : h)),
    reasonText: `${friend.firstName} (friend) ${phrase}${at}.`,
  };
}

/** A local person for a LinkedIn member, URL or slug, or a unique exact name; null when unknown. */
export async function resolvePersonRef(db: Db, userId: string, p: PersonRef): Promise<string | null> {
  const url = cleanLinkedInUrl(p.linkedinUrl);
  const slug = linkedInSlugOf(url);
  const [hit] = await db.sql<{ id: string }>`
    select p.id from orbit.people p
     where p.user_id = ${userId}::uuid and p.deleted_at is null and not p.is_self
       and ((${p.memberId ?? null}::text is not null and p.linkedin_member_id = ${p.memberId ?? null})
         or (${slug ?? null}::text is not null and lower(p.linkedin_slug) = ${slug ?? null})
         or (${url ?? null}::text is not null and lower(rtrim(p.linkedin_url, '/')) = ${url ?? null})
         or exists (select 1 from orbit.person_identities i where i.person_id = p.id
                     and ((i.kind = 'linkedin_member' and i.value_norm = ${p.memberId ?? ''})
                       or (i.kind = 'linkedin_slug' and i.value_norm = ${slug ?? ''}))))
     order by p.merged_into is null desc limit 1`;
  if (hit) return hit.id;
  const name = p.name.trim().toLowerCase();
  if (!name) return null;
  const byName = await db.sql<{ id: string }>`
    select id from orbit.people
     where user_id = ${userId}::uuid and deleted_at is null and not is_self and lower(display_name) = ${name}
     limit 2`;
  return byName.length === 1 ? byName[0]!.id : null;
}

/** An existing person for the reference, or a new one (sources = [source]). */
export async function ensurePerson(
  db: Db,
  userId: string,
  p: PersonRef & { org?: string; title?: string; email?: string; location?: string },
  source: string,
): Promise<string> {
  const found = await resolvePersonRef(db, userId, p);
  if (found) return found;
  const url = cleanLinkedInUrl(p.linkedinUrl);
  const slug = linkedInSlugOf(url);
  const name = p.name.trim() || slug || 'Unknown';
  const parsed = parseName(name);
  const [first, ...rest] = name.split(/\s+/);
  const [row] = await db.sql<{ id: string }>`
    insert into orbit.people (user_id, display_name, first_name, last_name, name_norm, title, org_raw, headline,
                              location, linkedin_url, linkedin_slug, linkedin_member_id, primary_email, sources,
                              first_seen_at)
    values (${userId}::uuid, ${name}, ${parsed.first || first || null}, ${parsed.last || rest.join(' ') || null},
            ${parsed.normalized || name.toLowerCase()},
            ${p.title ?? null}, ${p.org ?? null}, ${p.headline ?? null}, ${p.location ?? null}, ${url ?? null},
            ${slug ?? null}, ${p.memberId ?? null}, ${p.email ? normalizeEmail(p.email) : null}, ${[source]}::text[],
            now())
    returning id`;
  const id = row!.id;
  if (p.memberId)
    await db.sql`
      insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source)
      values (${userId}::uuid, ${id}::uuid, 'linkedin_member', ${p.memberId}, ${p.memberId}, ${source})
      on conflict (user_id, kind, value_norm) do nothing`;
  if (slug)
    await db.sql`
      insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source)
      values (${userId}::uuid, ${id}::uuid, 'linkedin_slug', ${slug}, ${url ?? slug}, ${source})
      on conflict (user_id, kind, value_norm) do nothing`;
  if (p.email)
    await db.sql`
      insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source)
      values (${userId}::uuid, ${id}::uuid, 'email', ${normalizeEmail(p.email)}, ${p.email}, ${source})
      on conflict (user_id, kind, value_norm) do nothing`;
  return id;
}

export async function upsertTies(db: Db, ties: TieRow[]): Promise<void> {
  for (const t of ties)
    await db.sql`
      insert into orbit.ties (user_id, a_person_id, b_person_id, kind, weight, confidence, evidence, first_seen_at,
                              last_seen_at)
      values (${t.user_id}::uuid, ${t.a_person_id}::uuid, ${t.b_person_id}::uuid, ${t.kind}, ${t.weight}::real,
              ${t.confidence}::real, ${t.evidence}::jsonb, ${t.last_seen_at}::timestamptz, ${t.last_seen_at}::timestamptz)
      on conflict (user_id, a_person_id, b_person_id, kind) do update set
        weight = greatest(orbit.ties.weight, excluded.weight), confidence = excluded.confidence,
        evidence = excluded.evidence, last_seen_at = greatest(orbit.ties.last_seen_at, excluded.last_seen_at)
      where (orbit.ties.weight, orbit.ties.confidence, orbit.ties.evidence, orbit.ties.last_seen_at)
            is distinct from (greatest(orbit.ties.weight, excluded.weight), excluded.confidence, excluded.evidence,
                              greatest(orbit.ties.last_seen_at, excluded.last_seen_at))`;
}

async function externalFor(s: Services, userId: string, target: ExternalTarget): Promise<ExternalResult> {
  const accountId = await linkedinAccountOf(s.db, userId);
  const [u] = await s.db.sql<{ email: string }>`select email from orbit.users where id = ${userId}::uuid`;
  return gatherExternalCandidates(
    {
      unipile: s.unipile,
      village: s.village,
      cache: sqlCache(s.db, s.now),
      budget: sqlBudget(s.db, s.now),
      clock: () => s.now().getTime(),
      resolvePerson: (p) => resolvePersonRef(s.db, userId, p),
    },
    {
      userId,
      target,
      unipileAccountId: accountId,
      villageUser: u ? { externalUserId: userId, email: u.email } : undefined,
    },
  );
}

export async function pathId(userId: string, nodes: string[]): Promise<string> {
  return `path_${(await sha256Hex(`${userId}:${nodes.join('>')}`)).slice(0, 16)}`;
}

function namesOf(g: UserGraph, nodes: string[], extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of nodes)
    out[n] = n === 'user' ? 'You' : (g.people.get(n)?.displayName ?? extra[n] ?? 'Someone');
  return out;
}

function personLike(p: GraphPerson): Person {
  return {
    isAlumni: p.isAlumni,
    currentTitle: p.title,
    lastInteractionAt: p.lastContactAt,
  } as Person;
}

export async function findPaths(
  s: Services,
  userId: string,
  req: PathsFindRequest,
): Promise<PathsFindResponse> {
  const db = s.db;
  const now = s.now();
  // plan 43 §3.2: which optional sources count for this student
  const src = await sourcesFor(db, userId, offeredOf(s.env));
  let goalKind: GoalKind | undefined;
  if (req.goalId) {
    const [g] = await db.sql<{ kind: GoalKind }>`
      select kind from orbit.goals where id = ${req.goalId}::uuid and user_id = ${userId}::uuid`;
    if (!g) throw new HttpError(404, 'not_found', 'no such goal');
    goalKind = g.kind;
  }
  const t = req.target as Record<string, unknown>;
  const [me] = await db.sql<{ school: string | null; majors: string[] }>`
    select school, majors from orbit.users where id = ${userId}::uuid`;
  const user = { school: me?.school ?? '', majors: me?.majors ?? [] };

  // ---- a company ---------------------------------------------------------------------------------------------
  if (typeof t.company === 'string' && !('personId' in t) && !('linkedinUrl' in t)) {
    const company = t.company.trim();
    const domain = typeof t.domain === 'string' ? t.domain.trim().toLowerCase() : undefined;
    if (!company) throw new HttpError(400, 'bad_request', 'company is required');
    const ext = await externalFor(s, userId, { kind: 'company', domain, name: company });
    // Village's people at the company become targets (they are who the introducers reach)
    for (const c of ext.candidates) {
      if (!c.personId || c.target.personId || !c.target.name) continue;
      const tid = await ensurePerson(
        db,
        userId,
        { name: c.target.name, linkedinUrl: c.target.linkedinUrl, org: company },
        'village',
      );
      c.target.personId = tid;
      const [lo, hi] = c.personId < tid ? [c.personId, tid] : [tid, c.personId];
      if (lo !== hi)
        ext.ties.push({
          user_id: userId,
          a_person_id: lo,
          b_person_id: hi,
          kind: 'village_path',
          weight: c.warmth,
          confidence: 0.7,
          evidence: c.evidence,
          last_seen_at: now.toISOString(),
        });
    }
    await upsertTies(db, ext.ties);
    // PageRank over the whole network picks among many people there, so the whole graph, without its evidence
    const g = await loadWhole(db, userId, now, true, src);
    // plan 29 §A4: friends' people at the company join the targets, as the student's own person when they have them
    const layer = await loadFriendLayer(db, userId, src.hidden);
    const friendShares = sharesAt(layer, company, domain);
    applyFriendLayer(g, friendShares);
    const atCompany = await db.sql<{ id: string }>`
      select p.id from orbit.people p left join orbit.organizations o on o.id = p.org_id
       where p.user_id = ${userId}::uuid and p.deleted_at is null and not p.is_self
         and (lower(p.org_raw) = lower(${company}) or lower(o.name) = lower(${company})
              or (${domain ?? null}::text is not null and ${domain ?? ''} = any(o.domains)))`;
    const villageTargets = ext.candidates.map((c) => c.target.personId).filter((x): x is string => !!x);
    const friendTargets = friendShares.map((x) => x.matchesPersonId ?? friendPersonNode(x.share.person_id));
    const ids = [...new Set([...atCompany.map((r) => r.id), ...villageTargets, ...friendTargets])];
    const targets: TargetInfo[] = ids
      .map((id) => g.people.get(id))
      .filter((p): p is GraphPerson => !!p && !p.doNotContact && !looksLikeMinor({ title: p.title }))
      .map((p) => ({
        id: p.id,
        name: p.name,
        isAlum: p.isAlumni,
        title: p.title,
        pReply: p.score > 0 ? responsePrior(personLike(p), user) : undefined,
      }));
    const rank = (ts: TargetInfo[]) =>
      rankCompanyTargets({
        targets: ts,
        goal: goalKind,
        people: g.people,
        pairs: g.pairs,
        blockedPairs: g.blocked,
        now,
      });
    let chosen = rank(targets);
    // the chosen routes' words need their full evidence; ranking just the chosen targets again gives the same routes
    if (
      await withFullEvidence(
        db,
        g,
        chosen.map((x) => x.path),
      )
    ) {
      const picked = new Set(chosen.map((x) => x.target.id));
      chosen = rank(targets.filter((x) => picked.has(x.id)));
    }
    // the people a company lookup routes to are worth reading in the background (plan 35 B6); a friend's person
    // (`friend_person:<id>`) is not the student's to read
    await requestReads(
      db,
      userId,
      chosen.map((x) => x.target.id).filter((id) => !id.includes(':')),
    );
    const paths: PathsFindResponse['paths'] = [];
    for (const x of chosen) {
      const p = decorateFriendPath(x.path, layer, x.target.name ?? 'them');
      paths.push({ ...p, id: await pathId(userId, p.nodes), names: namesOf(g, p.nodes) });
    }
    return {
      paths,
      ...(paths.length ? {} : { fallback: 'cold' as const }),
      sources: sourcesOf(ext, layer),
      unconfigured: ext.unconfigured,
    };
  }

  // ---- a person ------------------------------------------------------------------------------------------------
  let targetId: string;
  if (typeof t.personId === 'string') {
    const [p] = await db.sql<{ id: string }>`
      select id from orbit.people where id = ${t.personId}::uuid and user_id = ${userId}::uuid and deleted_at is null`;
    if (!p) throw new HttpError(404, 'not_found', 'no such person');
    targetId = p.id;
  } else if (typeof t.linkedinUrl === 'string' && cleanLinkedInUrl(t.linkedinUrl)) {
    targetId = await ensurePerson(
      db,
      userId,
      {
        name: typeof t.name === 'string' ? t.name : '',
        linkedinUrl: t.linkedinUrl,
        org: typeof t.company === 'string' ? t.company : undefined,
      },
      'paths',
    );
  } else throw new HttpError(400, 'bad_request', 'target needs personId, linkedinUrl or company');

  // plan 35 B7: only the target's neighbourhood, loaded once and patched after new ties
  const g = await loadNeighbourhood(db, userId, targetId, now, src);
  const target = g.people.get(targetId);
  if (!target) throw new HttpError(404, 'not_found', 'no such person');
  if (looksLikeMinor({ title: target.title })) return { paths: [], sources: [], unconfigured: [] };
  // a Map target is someone the student wants to know more about: the background reading reads them (plan 35 B6)
  await requestReads(db, userId, [targetId]);
  const ext = await externalFor(s, userId, {
    kind: 'person',
    personId: targetId,
    memberId: target.memberId,
    linkedinUrl: target.linkedinUrl,
    name: target.displayName,
    company: target.org,
  });
  const learned = await learnMemberIds(db, userId, ext);
  if (ext.ties.length || learned.length) {
    await upsertTies(db, ext.ties);
    await extendNeighbourhood(db, g, ext.ties, learned);
  }
  // plan 29 §A4: a friend who shares this person is one more way in, ranked with the rest
  const layer = await loadFriendLayer(db, userId, src.hidden);
  applyFriendLayer(g, sharesFor(layer, targetId));
  const rank = () =>
    rankWarmPaths({
      targetId,
      target: {
        name: target.name,
        isAlum: target.isAlumni,
        title: target.title,
        pReply: target.score > 0 ? responsePrior(personLike(target), user) : undefined,
      },
      goal: goalKind,
      people: g.people,
      pairs: g.pairs,
      blockedPairs: g.blocked,
      now,
    });
  let r = rank();
  // the chosen routes' words need their full evidence; ranking again over the same graph gives the same routes
  if (await withFullEvidence(db, g, r.paths)) r = rank();
  const paths: PathsFindResponse['paths'] = [];
  for (const raw of r.paths as WarmPath[]) {
    const p = decorateFriendPath(raw, layer, target.name);
    paths.push({ ...p, id: await pathId(userId, p.nodes), names: namesOf(g, p.nodes) });
  }
  const hopEvidence = await queueHopEvidence(s, userId, g, targetId, r.paths, ext);
  return {
    paths,
    ...(r.fallback ? { fallback: r.fallback } : {}),
    ...(r.direct ? { direct: { personId: targetId, ...r.direct } } : {}),
    sources: sourcesOf(ext, layer),
    unconfigured: ext.unconfigured,
    ...(hopEvidence ? { hopEvidence } : {}),
  };
}

/**
 * Keep the member id LinkedIn's mutuals search gave for a person found by the same LinkedIn profile address (never
 * by name: names never bind, plan 17): hop evidence matches by member id only (plan 21 §6). Returns the new ones.
 */
async function learnMemberIds(
  db: Db,
  userId: string,
  ext: ExternalResult,
): Promise<{ personId: string; memberId: string }[]> {
  const learned: { personId: string; memberId: string }[] = [];
  for (const c of ext.candidates) {
    const slug = linkedInSlugOf(c.linkedinUrl);
    if (c.source !== 'linkedin_mutual' || !c.personId || !c.memberId || !slug) continue;
    const rows = await db.sql`
      update orbit.people set linkedin_member_id = ${c.memberId}
       where id = ${c.personId}::uuid and user_id = ${userId}::uuid and linkedin_member_id is null
         and lower(linkedin_slug) = ${slug}
         and not exists (select 1 from orbit.people q where q.user_id = ${userId}::uuid
                          and q.linkedin_member_id = ${c.memberId} and q.id <> ${c.personId}::uuid)
         and not exists (select 1 from orbit.person_identities i where i.user_id = ${userId}::uuid
                          and i.kind = 'linkedin_member' and i.value_norm = ${c.memberId}
                          and i.person_id <> ${c.personId}::uuid)
      returning 1`;
    if (!rows.length) continue;
    learned.push({ personId: c.personId, memberId: c.memberId });
    await db.sql`
      insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source)
      values (${userId}::uuid, ${c.personId}::uuid, 'linkedin_member', ${c.memberId}, ${c.memberId}, 'unipile')
      on conflict (user_id, kind, value_norm) do nothing`;
  }
  return learned;
}

/**
 * The target's LinkedIn mutuals with member ids, best first: the introducers of the ranked routes in order, then the
 * other mutuals by the student's tie score. Blocked pairs are left out (nothing to weigh).
 */
export function mutualsToWeigh(
  g: UserGraph,
  targetId: string,
  paths: Pick<WarmPath, 'nodes'>[],
  candidateIds: string[],
): string[] {
  const ids = new Set<string>();
  for (const id of candidateIds) ids.add(id);
  for (const p of g.pairs.values()) {
    if (!p.kinds.includes('linkedin_mutual')) continue;
    if (p.aId === targetId) ids.add(p.bId);
    else if (p.bId === targetId) ids.add(p.aId);
  }
  const ok = (id: string) =>
    id !== targetId && !!g.people.get(id)?.memberId && !g.blocked.has(pairKeyOf(id, targetId));
  const out: string[] = [];
  for (const p of paths) {
    const before = p.nodes[p.nodes.length - 2];
    if (before && ids.has(before) && ok(before) && !out.includes(before)) out.push(before);
  }
  const rest = [...ids]
    .filter((id) => ok(id) && !out.includes(id))
    .sort((a, b) => (g.people.get(b)?.score ?? 0) - (g.people.get(a)?.score ?? 0) || a.localeCompare(b));
  return [...out, ...rest];
}

/**
 * Queue the hop_evidence job for a person target (plan 21 §4: only when the student opens a target, never on a timer)
 * when it has mutuals with member ids and its evidence is not fresh; 'queued' tells the app hop words may still change.
 */
async function queueHopEvidence(
  s: Services,
  userId: string,
  g: UserGraph,
  targetId: string,
  paths: Pick<WarmPath, 'nodes'>[],
  ext: ExternalResult,
): Promise<PathsFindResponse['hopEvidence']> {
  const target = g.people.get(targetId);
  if (!target?.memberId || !s.unipile.configured) return undefined;
  const accountId = await linkedinAccountOf(s.db, userId);
  if (!accountId) return undefined;
  const fromSearch = ext.candidates
    .filter((c) => c.source === 'linkedin_mutual' && c.personId)
    .map((c) => c.personId!);
  const mutuals = mutualsToWeigh(g, targetId, paths, fromSearch);
  if (!mutuals.length) return undefined;
  if (await hopEvidenceFresh(sqlCache(s.db, s.now), userId, accountId, target.memberId)) return 'checked';
  await enqueueHopEvidence(s, userId, targetId, mutuals);
  return 'queued';
}

function sourcesOf(ext: ExternalResult, layer?: FriendLayer): string[] {
  const out = ['graph'];
  const asked = (prefix: string) => !ext.skipped.some((x) => x.startsWith(prefix));
  if (!ext.unconfigured.includes('unipile') && asked('mutuals')) out.push('linkedin_mutual');
  if (!ext.unconfigured.includes('village') && asked('village')) out.push('village');
  // friends count as a source when at least one shares with the student (plan 29 §A4)
  if (layer?.friends.length) out.push('friends');
  return out;
}

/** The best path P to a known person, for sourcing reach (§6.2); a direct tie counts as its score. */
export function bestReach(
  g: UserGraph,
  personId: string,
  goal: GoalKind | undefined,
  now: Date,
): number | null {
  const p = g.people.get(personId);
  if (!p) return null;
  const r = rankWarmPaths({
    targetId: personId,
    target: { name: p.name, isAlum: p.isAlumni, title: p.title },
    goal,
    people: g.people,
    pairs: g.pairs,
    blockedPairs: g.blocked,
    now,
    limit: 1,
  });
  if (r.direct) return Math.min(1, r.direct.score / 100);
  return r.paths[0]?.p ?? null;
}
