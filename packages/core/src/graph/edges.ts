import { normalizeCompany } from '../text/normalize';
import type { Affiliation, CalendarEvent, Edge, EmailThread, Organization, Person } from '../types';

const DAY = 86_400_000;

function sizeFactor(org?: Organization): number {
  if (!org?.sizeBucket) return 0.5;
  const b = org.sizeBucket;
  if (['1-10', '11-50', '51-200'].includes(b)) return 1;
  if (['201-500', '501-1000', '1001-5000'].includes(b)) return 0.7;
  return 0.4;
}

function monthsOverlap(a: Affiliation, b: Affiliation, now: Date): number {
  const aStart = a.startDate ? new Date(a.startDate).getTime() : Number.NEGATIVE_INFINITY;
  const bStart = b.startDate ? new Date(b.startDate).getTime() : Number.NEGATIVE_INFINITY;
  const aEnd = a.isCurrent || !a.endDate ? now.getTime() : new Date(a.endDate).getTime();
  const bEnd = b.isCurrent || !b.endDate ? now.getTime() : new Date(b.endDate).getTime();
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  if (!Number.isFinite(start)) return a.isCurrent && b.isCurrent ? 12 : 0; // unknown dates
  return Math.max(0, (end - start) / (30 * DAY));
}

function yearRange(a: Affiliation): [number, number] | undefined {
  const s = a.startDate ? new Date(a.startDate).getFullYear() : undefined;
  const e = a.endDate ? new Date(a.endDate).getFullYear() : undefined;
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
  // group affiliations by normalized org name / org id
  const groups = new Map<string, { personId: string; aff: Affiliation }[]>();
  for (const [pid, affs] of byPerson) {
    for (const a of affs) {
      const key = `${a.kind}:${a.organizationId ?? normalizeCompany(a.nameRaw)}`;
      if (!key.endsWith(':')) {
        const arr = groups.get(key) ?? [];
        arr.push({ personId: pid, aff: a });
        groups.set(key, arr);
      }
    }
  }
  for (const [key, members] of groups) {
    if (members.length < 2 || members.length > 400) continue;
    const isEmployment = key.startsWith('employment:');
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const A = members[i]!;
        const B = members[j]!;
        if (A.personId === B.personId) continue;
        if (isEmployment) {
          const org = A.aff.organizationId ? input.organizations.get(A.aff.organizationId) : undefined;
          const sf = sizeFactor(org);
          const overlap = monthsOverlap(A.aff, B.aff, now);
          const orgName = org?.name ?? A.aff.nameRaw;
          if (A.aff.isCurrent && B.aff.isCurrent && !A.aff.startDate && !B.aff.startDate) {
            put(A.personId, B.personId, 'same_current_company', 0.35 * sf, {
              orgName,
              text: `Both currently at ${orgName}`,
            });
          } else if (overlap > 0) {
            put(A.personId, B.personId, 'co_tenure', Math.min(1, 0.25 + 0.05 * overlap) * sf, {
              orgName,
              overlapMonths: Math.round(overlap),
              text: `Worked together at ${orgName} (${Math.round(overlap)} months overlap)`,
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
                text: `Both at ${school} around ${Math.max(ra[0], rb[0])}`,
              });
            else if (Math.abs(ra[1] - rb[1]) <= 2)
              put(A.personId, B.personId, 'same_school_cohort', 0.15, {
                school,
                text: `Both went to ${school} within two years`,
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
  }
  // email co-threads
  const threadCount = new Map<string, number>();
  for (const t of input.threads) {
    const ids = t.participantPersonIds.filter((id) => peopleIds.has(id));
    if (ids.length < 2 || ids.length > 8) continue;
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const [x, y] = ids[i]! < ids[j]! ? [ids[i]!, ids[j]!] : [ids[j]!, ids[i]!];
        threadCount.set(`${x}|${y}`, (threadCount.get(`${x}|${y}`) ?? 0) + 1);
      }
  }
  for (const [k, n] of threadCount) {
    const [x, y] = k.split('|') as [string, string];
    put(x, y, 'email_cothread', Math.min(0.8, 0.5 + 0.1 * (n - 1)), {
      threads: n,
      text: n === 1 ? 'On the same email thread with you' : `On ${n} email threads with you`,
    });
  }
  // introductions: the introducer knows the person well enough to vouch for the student, the strongest thread edge
  const byId = new Map(people.map((p) => [p.id, p]));
  for (const t of input.threads) {
    const intro = t.introduction;
    if (!intro) continue;
    const from = byId.get(intro.introducerId);
    if (!from) continue;
    for (const id of intro.introducedIds) {
      const to = byId.get(id);
      if (!to) continue;
      put(from.id, to.id, 'introduced_by', 0.85, {
        introducerId: from.id,
        at: intro.at,
        text: `${from.firstName} introduced you to ${to.firstName}`,
      });
    }
  }
  const eventCount = new Map<string, number>();
  for (const e of input.events) {
    const ids = e.attendeePersonIds.filter((id) => peopleIds.has(id));
    if (ids.length < 2 || ids.length > 8) continue;
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const [x, y] = ids[i]! < ids[j]! ? [ids[i]!, ids[j]!] : [ids[j]!, ids[i]!];
        eventCount.set(`${x}|${y}`, (eventCount.get(`${x}|${y}`) ?? 0) + 1);
      }
  }
  for (const [k, n] of eventCount) {
    const [x, y] = k.split('|') as [string, string];
    put(x, y, 'meeting_coattendee', Math.min(0.9, 0.6 + 0.1 * (n - 1)), {
      events: n,
      text: n === 1 ? 'In a meeting with you together' : `In ${n} meetings with you together`,
    });
  }
  return [...edges.values()];
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
