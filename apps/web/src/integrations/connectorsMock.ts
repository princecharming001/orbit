/**
 * The mock connector the sample student uses, so live LinkedIn (connect, sync, mutual connections) and Village warm
 * intros are visible and testable without keys or network. Everything is built from the demo's own people and graph:
 * a live sync returns the demo's LinkedIn connections plus a few new ones, mutual connections for a person are demo
 * people at their company or school, and warm intro paths come from the demo graph's introducers with warmth scores
 * and hops. Connect succeeds at once, with no popup.
 *
 * Which accounts use it: the sample student always; any account when a test turns it on (setConnectorsMockForTests,
 * or window.__ORBIT_CONNECTORS__ = 'mock' in an end-to-end test).
 */
import type { Person } from '@orbit/core';
import { normalizeCompany } from '@orbit/core';
import { db } from '../db/schema';
import { DEMO_USER_ID } from '../engine/demo';
import { reachCompany, reachPerson } from '../engine/graph';
import { automationOverride } from './connectorOutcome';
import type { LiveConnection, Mutual } from './unipile';
import type { VillagePath } from './village';

export const MOCK_ACCOUNT_ID = 'demo-linkedin-account';

let toggle: boolean | undefined;

/** Unit-test hook: true puts every account on the mock, false takes even the sample student off it. */
export function setConnectorsMockForTests(on: boolean | undefined): void {
  toggle = on;
}

export function usesMockConnectors(userId: string | undefined): boolean {
  if (toggle !== undefined) return toggle;
  return userId === DEMO_USER_ID || automationOverride() === 'mock';
}

const DAY = 86_400_000;

/** People who joined the sample student's LinkedIn since the export was taken: what a live sync adds. */
const NEW_CONNECTIONS: { first: string; last: string; title: string; company: string; daysAgo: number }[] = [
  { first: 'Priya', last: 'Raman', title: 'Product Manager', company: 'Stripe', daysAgo: 3 },
  { first: 'Marcus', last: 'Oyelaran', title: 'Software Engineer', company: 'Figma', daysAgo: 6 },
  {
    first: 'Elena',
    last: 'Vasquez',
    title: 'Strategy and Operations Associate',
    company: 'Ramp',
    daysAgo: 9,
  },
  { first: 'Jamal', last: 'Whitfield', title: 'Product Designer', company: 'Datadog', daysAgo: 12 },
];

const slugOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const memberIdFor = (p: Pick<Person, 'linkedinMemberId' | 'linkedinSlug' | 'id'>) =>
  p.linkedinMemberId ?? `mock_${p.linkedinSlug ?? p.id}`;

async function visiblePeople(userId: string): Promise<Person[]> {
  return db.people
    .where('userId')
    .equals(userId)
    .filter((p) => p.isHuman && !p.hiddenAt)
    .toArray();
}

/** A believable live sync: the demo's LinkedIn connections, plus a few people connected since. */
export async function mockLinkedInConnections(userId: string, now = new Date()): Promise<LiveConnection[]> {
  const people = await visiblePeople(userId);
  const existing: LiveConnection[] = people
    .filter((p) => p.linkedinConnectedOn && p.linkedinUrl)
    .map((p) => ({
      firstName: p.firstName,
      lastName: p.lastName,
      position: p.currentTitle,
      company: p.currentOrganizationRaw,
      url: p.linkedinUrl,
      connectedOn: p.linkedinConnectedOn,
      memberId: memberIdFor(p),
    }));
  const fresh: LiveConnection[] = NEW_CONNECTIONS.map((c) => {
    const slug = slugOf(`${c.first} ${c.last} li`);
    return {
      firstName: c.first,
      lastName: c.last,
      position: c.title,
      company: c.company,
      url: `https://www.linkedin.com/in/${slug}`,
      connectedOn: new Date(now.getTime() - c.daysAgo * DAY).toISOString().slice(0, 10),
      memberId: `mock_${slug}`,
    };
  });
  return [...existing, ...fresh];
}

function sameCompany(a: Person, b: Person): boolean {
  if (a.currentOrganizationId && a.currentOrganizationId === b.currentOrganizationId) return true;
  const na = normalizeCompany(a.currentOrganizationRaw);
  return !!na && na === normalizeCompany(b.currentOrganizationRaw);
}

/** Mutual connections for a person: demo people at their company first, then at their school, closest first. */
export async function mockMutuals(userId: string, target: Person, limit = 6): Promise<Mutual[]> {
  const people = (await visiblePeople(userId)).filter((p) => p.id !== target.id);
  const atCompany = people.filter((p) => sameCompany(p, target));
  const atSchool = target.school
    ? people.filter((p) => p.school === target.school && !atCompany.includes(p))
    : [];
  const byStrength = (a: Person, b: Person) =>
    b.strength - a.strength || a.displayName.localeCompare(b.displayName);
  return [...atCompany.sort(byStrength), ...atSchool.sort(byStrength)].slice(0, limit).map((p) => ({
    name: p.displayName,
    headline:
      p.headline ?? ([p.currentTitle, p.currentOrganizationRaw].filter(Boolean).join(' at ') || undefined),
    url: p.linkedinUrl,
    memberId: memberIdFor(p),
  }));
}

/** A mock warm path, with the Orbit ids the app needs to act on it. */
export interface MockVillagePath extends VillagePath {
  introducerId: string;
  targetPersonId?: string;
}

const clamp = (n: number) => Math.round(Math.max(0.05, Math.min(0.98, n)) * 100) / 100;
/** Village scores a route through a friend higher than Orbit's raw path strength does. */
const routeWarmth = (score: number) => clamp(0.35 + score * 1.1);

/**
 * Warm intro paths from the demo graph. For a person: the graph's routes through someone the student knows, then
 * the target's colleagues. For a company: routes to someone there through a closer contact, then the people there
 * the student knows well enough to ask.
 */
export async function mockVillagePaths(
  userId: string,
  target: { personId?: string; company?: string },
  limit = 4,
): Promise<MockVillagePath[]> {
  const out: MockVillagePath[] = [];
  const seen = new Set<string>();
  const push = (p: MockVillagePath) => {
    if (seen.has(p.introducerId) || out.length >= limit) return;
    seen.add(p.introducerId);
    out.push(p);
  };
  if (target.personId) {
    const person = await db.people.get(target.personId);
    if (!person || person.userId !== userId) return [];
    const paths = await reachPerson(userId, person.id, 4);
    const ids = new Set(paths.flatMap((p) => p.hops.map((h) => h.toId)));
    const byId = new Map(
      (await db.people.bulkGet([...ids])).filter((p): p is Person => !!p).map((p) => [p.id, p]),
    );
    for (const path of paths) {
      if (path.hops.length < 2) continue;
      const intro = byId.get(path.hops[0]!.toId);
      if (!intro) continue;
      push({
        introducer: { name: intro.displayName, headline: intro.headline, linkedinUrl: intro.linkedinUrl },
        introducerId: intro.id,
        targetPersonId: person.id,
        warmth: routeWarmth(path.score),
        hops: ['You', ...path.hops.map((h) => byId.get(h.toId)?.displayName ?? 'someone')],
        note: path.hops[1]?.text,
      });
    }
    const colleagues = (await visiblePeople(userId))
      .filter((p) => p.id !== person.id && sameCompany(p, person) && p.strength >= 0.15)
      .sort((a, b) => b.strength - a.strength);
    for (const c of colleagues)
      push({
        introducer: { name: c.displayName, headline: c.headline, linkedinUrl: c.linkedinUrl },
        introducerId: c.id,
        targetPersonId: person.id,
        warmth: clamp(0.3 + c.strength * 0.6),
        hops: ['You', c.displayName, person.displayName],
        note: person.currentOrganizationRaw
          ? `Works with ${person.firstName} at ${person.currentOrganizationRaw}`
          : undefined,
      });
    return out.sort((a, b) => b.warmth - a.warmth);
  }
  if (!target.company) return [];
  const reach = await reachCompany(userId, target.company);
  const name = reach.org?.name ?? target.company;
  for (const t of reach.twoHop) {
    const ids = t.path.hops.map((h) => h.toId);
    const chain = (await db.people.bulkGet(ids)).filter((p): p is Person => !!p);
    const first = chain[0];
    if (!first || chain.length !== ids.length) continue;
    push({
      introducer: { name: first.displayName, headline: first.headline, linkedinUrl: first.linkedinUrl },
      introducerId: first.id,
      targetPersonId: t.target.id,
      warmth: routeWarmth(t.path.score),
      hops: ['You', ...chain.map((p) => p.displayName), name],
      note: t.path.hops[1]?.text,
    });
  }
  for (const d of reach.direct.filter((x) => x.strength >= 0.2))
    push({
      introducer: {
        name: d.person.displayName,
        headline: d.person.headline,
        linkedinUrl: d.person.linkedinUrl,
      },
      introducerId: d.person.id,
      warmth: clamp(0.35 + d.strength * 0.6),
      hops: ['You', d.person.displayName, name],
      note: `Works at ${name}${d.person.isAlumni ? ', and went to your school' : ''}`,
    });
  return out.sort((a, b) => b.warmth - a.warmth);
}
