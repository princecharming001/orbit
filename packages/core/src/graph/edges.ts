import { normalizeCompany } from '../text/normalize';
import type { Affiliation, CalendarEvent, Edge, EmailThread, Organization, Person } from '../types';
import { sizeFactor } from './orgSize';

const DAY = 86_400_000;

export * from './explain';
export { knownSizeBucket, sizeFactor } from './orgSize';

/** Affiliation groups up to this size get every pair as an edge (at most ~11k pairs). */
export const FULL_PAIRING_MAX = 150;
/**
 * Larger groups (a big employer, the student's own university) are not dropped: every member is paired with the
 * group's strongest ties to the student (its likely connectors), which keeps every useful route and grows linearly.
 */
export const CONNECTORS_PER_LARGE_GROUP = 20;

function time(d: string | undefined): number | undefined {
  if (!d) return undefined;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? undefined : t;
}

function utcYear(t: number): number {
  return new Date(t).getUTCFullYear();
}

function monthsOverlap(a: Affiliation, b: Affiliation, now: Date): number {
  const aStart = time(a.startDate) ?? Number.NEGATIVE_INFINITY;
  const bStart = time(b.startDate) ?? Number.NEGATIVE_INFINITY;
  const aEnd = a.isCurrent || !a.endDate ? now.getTime() : (time(a.endDate) ?? Number.NaN);
  const bEnd = b.isCurrent || !b.endDate ? now.getTime() : (time(b.endDate) ?? Number.NaN);
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  if (!Number.isFinite(start)) return a.isCurrent && b.isCurrent ? 12 : 0; // unknown dates
  if (Number.isNaN(end)) return 0;
  return Math.max(0, (end - start) / (30 * DAY));
}

/** True when the known dates prove two stints at the same employer never overlapped. */
function provablyDisjoint(a: Affiliation, b: Affiliation): boolean {
  const aStart = time(a.startDate);
  const bStart = time(b.startDate);
  const aEnd = a.isCurrent ? undefined : time(a.endDate);
  const bEnd = b.isCurrent ? undefined : time(b.endDate);
  if (aEnd !== undefined && bStart !== undefined && aEnd < bStart) return true;
  if (bEnd !== undefined && aStart !== undefined && bEnd < aStart) return true;
  if ((a.startDate && aStart === undefined) || (b.startDate && bStart === undefined)) return true; // garbage
  return false;
}

function yearRange(a: Affiliation): [number, number] | undefined {
  const st = time(a.startDate);
  const et = time(a.endDate);
  const s = st === undefined ? undefined : utcYear(st);
  const e = et === undefined ? undefined : utcYear(et);
  if (s === undefined && e === undefined) return undefined;
  return [s ?? e! - 4, e ?? s! + 4];
}

export interface EdgeInput {
  userId: string;
  people: Person[];
  affiliations: Affiliation[];
  organizations: Map<string, Organization>;
  threads: EmailThread[];
  events: CalendarEvent[];
  now?: Date;
}

export function inferEdges(input: EdgeInput): Edge[] {
  const now = input.now ?? new Date();
  const people = input.people.filter((p) => p.isHuman && !p.hiddenAt);
  const peopleIds = new Set(people.map((p) => p.id));
  const strengthOf = new Map(people.map((p) => [p.id, p.strength ?? 0]));
  const byPerson = new Map<string, Affiliation[]>();
  for (const a of input.affiliations) {
    if (!peopleIds.has(a.personId)) continue;
    const arr = byPerson.get(a.personId) ?? [];
    arr.push(a);
    byPerson.set(a.personId, arr);
  }
  // Also treat current org from the person row as an employment affiliation when none exists.
  for (const p of people) {
    const arr = byPerson.get(p.id) ?? [];
    if (p.currentOrganizationRaw && !arr.some((a) => a.kind === 'employment' && a.isCurrent)) {
      arr.push({
        id: `virt-${p.id}`,
        userId: input.userId,
        personId: p.id,
        kind: 'employment',
        organizationId: p.currentOrganizationId,
        nameRaw: p.currentOrganizationRaw,
        title: p.currentTitle,
        isCurrent: true,
        source: 'manual',
      });
    }
    if (p.school && !arr.some((a) => a.kind === 'education')) {
      arr.push({
        id: `virts-${p.id}`,
        userId: input.userId,
        personId: p.id,
        kind: 'education',
        nameRaw: p.school,
        isCurrent: false,
        source: 'manual',
      });
    }
    byPerson.set(p.id, arr);
  }
  const edges = new Map<string, Edge>();
  const put = (a: string, b: string, type: Edge['type'], weight: number, evidence: Edge['evidence']) => {
    if (a === b) return;
    const [x, y] = a < b ? [a, b] : [b, a];
    const key = `${x}|${y}|${type}`;
    const existing = edges.get(key);
    if (existing && existing.weight >= weight) return;
    edges.set(key, {
      id: key,
      userId: input.userId,
      personAId: x,
      personBId: y,
      type,
      weight: Math.min(1, weight),
      evidence,
    });
  };
  // group affiliations by org id, else by normalized name, so "Stripe" and "Stripe, Inc." are one group
  const groups = new Map<string, { personId: string; aff: Affiliation }[]>();
  for (const [pid, affs] of byPerson) {
    for (const a of affs) {
      const org = a.organizationId ? input.organizations.get(a.organizationId) : undefined;
      const norm = org?.nameNormalized || normalizeCompany(a.nameRaw);
      if (!norm) continue;
      const key = `${a.kind}:${norm}`;
      const arr = groups.get(key) ?? [];
      arr.push({ personId: pid, aff: a });
      groups.set(key, arr);
    }
  }
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const isEmployment = key.startsWith('employment:');
    const pairs = groupPairs(members, strengthOf);
    const orgRef = members.find((m) => m.aff.organizationId)?.aff.organizationId;
    const org = orgRef ? input.organizations.get(orgRef) : undefined;
    const distinct = new Set(members.map((m) => m.personId)).size;
    for (const [A, B] of pairs) {
      if (A.personId === B.personId) continue;
      if (isEmployment) {
        const orgName = org?.name ?? A.aff.nameRaw;
        const sf = sizeFactor(org?.sizeBucket, orgName, distinct);
        const bothCurrent = A.aff.isCurrent && B.aff.isCurrent;
        const current = [A, B].filter((m) => m.aff.isCurrent).map((m) => m.personId);
        // A stint's span is known only with a start date and, unless it is current, an end date. Without both
        // spans we cannot say since when (or whether) two people worked side by side.
        const spanKnown = (a: Affiliation) => !!a.startDate && (a.isCurrent || !!a.endDate);
        if (bothCurrent && !(spanKnown(A.aff) && spanKnown(B.aff))) {
          put(A.personId, B.personId, 'same_current_company', 0.35 * sf, {
            orgName,
            current,
            text: `Both currently at ${orgName}`,
          });
        } else if (!spanKnown(A.aff) || !spanKnown(B.aff)) {
          // A past stint with unknown dates: they may well have overlapped, but we cannot say when.
          if (provablyDisjoint(A.aff, B.aff)) continue;
          put(A.personId, B.personId, 'co_tenure', 0.15 * sf, {
            orgName,
            datesUnknown: true,
            current,
            text: current.length ? `Both have worked at ${orgName}` : `Both previously at ${orgName}`,
          });
        } else {
          const overlap = monthsOverlap(A.aff, B.aff, now);
          if (overlap <= 0) continue;
          const starts = [time(A.aff.startDate), time(B.aff.startDate)].filter((t) => t !== undefined);
          const ends = [A.aff, B.aff].map((a) => (a.isCurrent || !a.endDate ? undefined : time(a.endDate)));
          const fromYear = starts.length ? utcYear(Math.max(...starts)) : undefined;
          const ongoing = bothCurrent;
          const endKnown = ends.filter((t) => t !== undefined);
          const toYear = ongoing ? undefined : endKnown.length ? utcYear(Math.min(...endKnown)) : undefined;
          put(A.personId, B.personId, 'co_tenure', Math.min(1, 0.25 + 0.05 * overlap) * sf, {
            orgName,
            overlapMonths: Math.round(overlap),
            fromYear,
            toYear,
            ongoing,
            current,
            text: `Worked together at ${orgName}${yearSpan(fromYear, toYear, ongoing)}`,
          });
        }
      } else {
        const ra = yearRange(A.aff);
        const rb = yearRange(B.aff);
        const school = A.aff.nameRaw;
        if (ra && rb) {
          const overlap = Math.min(ra[1], rb[1]) - Math.max(ra[0], rb[0]);
          if (overlap >= 0)
            put(A.personId, B.personId, 'same_school_cohort', 0.3, {
              school,
              year: Math.max(ra[0], rb[0]),
              text: `Both at ${school} around ${Math.max(ra[0], rb[0])}`,
            });
          else if (Math.abs(ra[1] - rb[1]) <= 2)
            put(A.personId, B.personId, 'same_school_cohort', 0.15, {
              school,
              withinTwoYears: true,
              text: `Both went to ${school}, graduating within two years of each other`,
            });
        } else {
          put(A.personId, B.personId, 'same_school_cohort', 0.12, {
            school,
            text: `Both went to ${school}`,
          });
        }
      }
    }
  }
  // email co-threads
  const threadCount = new Map<string, { n: number; last?: string }>();
  for (const t of input.threads) {
    const ids = [...new Set(t.participantPersonIds.filter((id) => peopleIds.has(id)))];
    if (ids.length < 2 || ids.length > 8) continue;
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const [x, y] = ids[i]! < ids[j]! ? [ids[i]!, ids[j]!] : [ids[j]!, ids[i]!];
        const cur = threadCount.get(`${x}|${y}`) ?? { n: 0 };
        cur.n++;
        if (t.lastMessageAt && (!cur.last || t.lastMessageAt > cur.last)) cur.last = t.lastMessageAt;
        threadCount.set(`${x}|${y}`, cur);
      }
  }
  for (const [k, { n, last }] of threadCount) {
    const [x, y] = k.split('|') as [string, string];
    put(x, y, 'email_cothread', Math.min(0.8, 0.5 + 0.1 * (n - 1)), {
      threads: n,
      lastAt: last,
      text: n === 1 ? 'On the same email thread with you' : `On ${n} email threads with you`,
    });
  }
  const eventCount = new Map<string, { n: number; last?: string }>();
  for (const e of input.events) {
    const ids = [...new Set(e.attendeePersonIds.filter((id) => peopleIds.has(id)))];
    if (ids.length < 2 || ids.length > 8) continue;
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const [x, y] = ids[i]! < ids[j]! ? [ids[i]!, ids[j]!] : [ids[j]!, ids[i]!];
        const cur = eventCount.get(`${x}|${y}`) ?? { n: 0 };
        cur.n++;
        if (e.startAt && (!cur.last || e.startAt > cur.last)) cur.last = e.startAt;
        eventCount.set(`${x}|${y}`, cur);
      }
  }
  for (const [k, { n, last }] of eventCount) {
    const [x, y] = k.split('|') as [string, string];
    put(x, y, 'meeting_coattendee', Math.min(0.9, 0.6 + 0.1 * (n - 1)), {
      events: n,
      lastAt: last,
      text: n === 1 ? 'In a meeting with you together' : `In ${n} meetings with you together`,
    });
  }
  return [...edges.values()];
}

function yearSpan(from: number | undefined, to: number | undefined, ongoing: boolean): string {
  if (from === undefined) return '';
  if (ongoing) return ` since ${from}`;
  if (to === undefined || to === from) return ` in ${from}`;
  return ` from ${from} to ${to}`;
}

type Member = { personId: string; aff: Affiliation };

/** All pairs for normal groups; for large groups, every member paired with the group's strongest connectors. */
function groupPairs(members: Member[], strengthOf: Map<string, number>): [Member, Member][] {
  const out: [Member, Member][] = [];
  if (members.length <= FULL_PAIRING_MAX) {
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++) out.push([members[i]!, members[j]!]);
    return out;
  }
  const ranked = [...members].sort(
    (a, b) =>
      (strengthOf.get(b.personId) ?? 0) - (strengthOf.get(a.personId) ?? 0) ||
      (a.personId < b.personId ? -1 : 1),
  );
  const connectors = new Set<Member>();
  const seenPeople = new Set<string>();
  for (const m of ranked) {
    if (connectors.size >= CONNECTORS_PER_LARGE_GROUP) break;
    if (seenPeople.has(m.personId)) continue;
    seenPeople.add(m.personId);
    connectors.add(m);
  }
  const list = [...connectors];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) out.push([list[i]!, list[j]!]);
  for (const m of members) {
    if (connectors.has(m)) continue;
    for (const c of list) out.push([c, m]);
  }
  return out;
}

/** noisy-OR of all edges between a pair */
export function combinedPairWeights(edges: Edge[]): Map<string, { weight: number; edges: Edge[] }> {
  const out = new Map<string, { weight: number; edges: Edge[] }>();
  for (const e of edges) {
    const key = `${e.personAId}|${e.personBId}`;
    const cur = out.get(key) ?? { weight: 0, edges: [] };
    cur.edges.push(e);
    cur.weight = 1 - (1 - cur.weight) * (1 - e.weight);
    out.set(key, cur);
  }
  return out;
}
