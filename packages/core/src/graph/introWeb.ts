import type { CoffeeChat, Edge, EmailThread, Person, PersonFact } from '../types';

/**
 * The student's referral web: who introduced or pointed them to whom, built only from records the engine keeps.
 *
 * - `intro`: an email introduction (an `introduced_by` edge, a thread's recorded introduction, or a chat opened
 *   from one, which carries `introducedAt`)
 * - `referral`: a chat whose `referrerPersonId` names who sent the student there, with no email intro behind it
 * - `suggested`: a "suggested I talk with you" connection fact from the prep tab's "anyone else?" answer
 *
 * Nothing is inferred beyond those records; two people who merely know each other are not in the web.
 */
export type IntroKind = 'intro' | 'referral' | 'suggested';

export interface IntroLink {
  /** the person who made the introduction */
  fromId: string;
  /** the person the student was introduced to */
  toId: string;
  kind: IntroKind;
  at?: string;
}

export interface IntroWeb {
  /** every recorded link, one per pair, oldest first */
  links: IntroLink[];
  /** the link each introduced person hangs from: their earliest introducer */
  parent: Map<string, IntroLink>;
  children: Map<string, IntroLink[]>;
  /** 1 = someone the student already knew who introduced others; 2 = introduced by them; and so on */
  generation: Map<string, number>;
  /** the first person in each member's chain (their lineage) */
  root: Map<string, string>;
  /** lineages, oldest first */
  roots: string[];
  members: Set<string>;
  /** the deepest generation */
  depth: number;
}

export interface IntroSources {
  people: Pick<Person, 'id' | 'isHuman' | 'hiddenAt'>[];
  edges?: Pick<Edge, 'personAId' | 'personBId' | 'type' | 'evidence'>[];
  threads?: Pick<EmailThread, 'introduction'>[];
  chats?: Pick<CoffeeChat, 'personId' | 'referrerPersonId' | 'introducedAt' | 'createdAt'>[];
  facts?: Pick<
    PersonFact,
    'personId' | 'type' | 'sourceTable' | 'sourceId' | 'occurredAt' | 'createdAt' | 'deletedAt'
  >[];
}

const KIND_RANK: Record<IntroKind, number> = { intro: 0, referral: 1, suggested: 2 };

const before = (a?: string, b?: string): boolean => {
  if (a === undefined) return false;
  if (b === undefined) return true;
  return a < b;
};

export function buildIntroWeb(src: IntroSources): IntroWeb {
  const shown = new Set(src.people.filter((p) => p.isHuman && !p.hiddenAt).map((p) => p.id));
  const byPair = new Map<string, IntroLink>();
  const add = (fromId: string | undefined, toId: string | undefined, kind: IntroKind, at?: string) => {
    if (!fromId || !toId || fromId === toId || !shown.has(fromId) || !shown.has(toId)) return;
    const key = `${fromId}>${toId}`;
    const cur = byPair.get(key);
    if (!cur) {
      byPair.set(key, { fromId, toId, kind, at });
      return;
    }
    // one link per pair: the strongest evidence of what kind it was, dated by the earliest record
    if (KIND_RANK[kind] < KIND_RANK[cur.kind]) cur.kind = kind;
    if (before(at, cur.at)) cur.at = at;
  };
  for (const e of src.edges ?? []) {
    if (e.type !== 'introduced_by') continue;
    const by = typeof e.evidence.introducerId === 'string' ? e.evidence.introducerId : undefined;
    if (by !== e.personAId && by !== e.personBId) continue;
    const to = by === e.personAId ? e.personBId : e.personAId;
    add(by, to, 'intro', typeof e.evidence.at === 'string' ? e.evidence.at : undefined);
  }
  for (const t of src.threads ?? []) {
    const intro = t.introduction;
    if (!intro) continue;
    for (const id of intro.introducedIds) add(intro.introducerId, id, 'intro', intro.at);
  }
  for (const c of src.chats ?? []) {
    if (!c.referrerPersonId) continue;
    add(c.referrerPersonId, c.personId, c.introducedAt ? 'intro' : 'referral', c.introducedAt ?? c.createdAt);
  }
  for (const f of src.facts ?? []) {
    if (f.deletedAt || f.type !== 'connection' || f.sourceTable !== 'suggested_by') continue;
    add(f.sourceId, f.personId, 'suggested', f.occurredAt ?? f.createdAt);
  }
  const order = (a: IntroLink, b: IntroLink) =>
    (before(a.at, b.at) ? -1 : before(b.at, a.at) ? 1 : 0) ||
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    (a.fromId < b.fromId ? -1 : a.fromId > b.fromId ? 1 : 0) ||
    (a.toId < b.toId ? -1 : a.toId > b.toId ? 1 : 0);
  const all = [...byPair.values()].sort(order);
  // Each person hangs from their earliest introducer. A link that would close a loop (A brought B, and later B is
  // recorded as bringing A) cannot describe how the student met either of them, so it is left out.
  const parent = new Map<string, IntroLink>();
  const links: IntroLink[] = [];
  const ancestorOf = (id: string, of: string): boolean => {
    let cur: string | undefined = id;
    for (let guard = 0; cur && guard < 10_000; guard++) {
      if (cur === of) return true;
      cur = parent.get(cur)?.fromId;
    }
    return false;
  };
  for (const l of all) {
    if (ancestorOf(l.fromId, l.toId)) continue;
    links.push(l);
    if (!parent.has(l.toId)) parent.set(l.toId, l);
  }
  const children = new Map<string, IntroLink[]>();
  const members = new Set<string>();
  for (const l of links) {
    members.add(l.fromId);
    members.add(l.toId);
  }
  for (const l of parent.values()) {
    const arr = children.get(l.fromId) ?? [];
    arr.push(l);
    children.set(l.fromId, arr);
  }
  const roots = [...members].filter((id) => !parent.has(id));
  const firstAt = (id: string) => children.get(id)?.[0]?.at;
  roots.sort((a, b) =>
    before(firstAt(a), firstAt(b)) ? -1 : before(firstAt(b), firstAt(a)) ? 1 : a < b ? -1 : 1,
  );
  const generation = new Map<string, number>();
  const root = new Map<string, string>();
  let depth = 0;
  const walk = (id: string, gen: number, lineage: string) => {
    generation.set(id, gen);
    root.set(id, lineage);
    depth = Math.max(depth, gen);
    for (const c of children.get(id) ?? []) walk(c.toId, gen + 1, lineage);
  };
  for (const r of roots) walk(r, 1, r);
  return { links, parent, children, generation, root, roots, members, depth };
}

/** The chain from the lineage's first person down to `id` (empty when `id` is not in the web). */
export function introChain(web: IntroWeb, id: string): string[] {
  if (!web.members.has(id)) return [];
  const out = [id];
  let cur = web.parent.get(id);
  while (cur && out.length < 10_000) {
    out.unshift(cur.fromId);
    cur = web.parent.get(cur.fromId);
  }
  return out;
}

/** Everyone `id` led the student to, directly or through others, nearest first. */
export function introDescendants(web: IntroWeb, id: string): string[] {
  const out: string[] = [];
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const c of web.children.get(cur) ?? []) {
      out.push(c.toId);
      queue.push(c.toId);
    }
  }
  return out;
}

const VERB: Record<IntroKind, string> = {
  intro: 'introduced you to',
  referral: 'referred you to',
  suggested: 'suggested you talk to',
};

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "Mei and Sam" grouped by how each was introduced: "introduced you to Mei and suggested you talk to Sam". */
function clauseFor(kids: IntroLink[], nameOf: (id: string) => string): string {
  const groups = new Map<IntroKind, string[]>();
  for (const k of kids) groups.set(k.kind, [...(groups.get(k.kind) ?? []), nameOf(k.toId)]);
  const parts = [...groups].map(([kind, names]) => `${VERB[kind]} ${listNames(names)}`);
  return listNames(parts);
}

function sentence(path: string[], ends: IntroLink[], web: IntroWeb, nameOf: (id: string) => string): string {
  const clauses: string[] = [];
  for (let i = 1; i < path.length; i++) {
    const link = web.parent.get(path[i]!)!;
    clauses.push(`${VERB[link.kind]} ${nameOf(path[i]!)}`);
  }
  if (ends.length) clauses.push(clauseFor(ends, nameOf));
  if (!clauses.length) return '';
  return `${nameOf(path[0]!)} ${clauses.join(', who ')}.`;
}

/**
 * One sentence for a person's place in the web: the chain that led to them, then whom they led the student to
 * ("Priya introduced you to Mei, who referred you to Sam."). Follows an only child down; several are listed.
 */
export function describeIntroChain(web: IntroWeb, id: string, nameOf: (id: string) => string): string {
  const path = introChain(web, id);
  if (!path.length) return '';
  let kids = web.children.get(id) ?? [];
  while (kids.length === 1) {
    path.push(kids[0]!.toId);
    kids = web.children.get(kids[0]!.toId) ?? [];
  }
  return sentence(path, kids, web, nameOf);
}

/**
 * Every chain in the web as sentences, one per branch, oldest lineage first. `focusId` is the person whose chain the
 * sentence tells (the last person named, or the one who introduced several).
 */
export function introStories(
  web: IntroWeb,
  nameOf: (id: string) => string,
): { rootId: string; focusId: string; text: string }[] {
  const out: { rootId: string; focusId: string; text: string }[] = [];
  const visit = (id: string, path: string[], rootId: string) => {
    const kids = web.children.get(id) ?? [];
    const leaves = kids.filter((k) => !(web.children.get(k.toId) ?? []).length);
    const inner = kids.filter((k) => (web.children.get(k.toId) ?? []).length);
    const here = [...path, id];
    if (leaves.length)
      out.push({
        rootId,
        focusId: leaves.length === 1 && !inner.length ? leaves[0]!.toId : id,
        text: sentence(here, leaves, web, nameOf),
      });
    for (const k of inner) visit(k.toId, here, rootId);
  };
  for (const r of web.roots) visit(r, [], r);
  return out;
}
