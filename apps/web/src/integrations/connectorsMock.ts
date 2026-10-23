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
import { normalizeCompany, titleSimilarity } from '@orbit/core';
import { db } from '../db/schema';
import { DEMO_USER_ID } from '../engine/demo';
import { reachCompany, reachPerson } from '../engine/graph';
import { automationOverride } from './connectorOutcome';
import type { LinkedInFound, LiveConnection, Mutual } from './unipile';
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
  // after the first sync the new connections are among the student's people already: never list anyone twice
  const seen = new Set(existing.map((c) => c.url));
  return [...existing, ...fresh.filter((c) => !seen.has(c.url))];
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
    pictureUrl: p.photoUrl,
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

/** A LinkedIn search result in the mock pool: who they are, what LinkedIn's filters would match them on. */
interface PoolPerson {
  first: string;
  last: string;
  headline: string;
  title: string;
  company: string;
  location: string;
  /** schools in their education (LinkedIn's school filter matches these) */
  schools: string[];
  distance: 2 | 3;
  mutuals?: number;
}

/** The six people search always had first (chat and Map tests name them), then a large generated pool. */
const FIRST_SIX: PoolPerson[] = [
  {
    first: 'Nadia',
    last: 'Okafor',
    headline: 'Product Manager at Notion',
    title: 'Product Manager',
    company: 'Notion',
    location: 'San Francisco',
    schools: ['Cornell University'],
    distance: 2,
    mutuals: 4,
  },
  {
    first: 'Theo',
    last: 'Lindqvist',
    headline: 'Software Engineer at Linear',
    title: 'Software Engineer',
    company: 'Linear',
    location: 'New York',
    schools: ['University of Michigan'],
    distance: 2,
    mutuals: 2,
  },
  {
    first: 'Sofia',
    last: 'Marchetti',
    headline: 'Investor at Greylock',
    title: 'Investor',
    company: 'Greylock',
    location: 'Menlo Park',
    schools: ['Stanford University'],
    distance: 3,
  },
  {
    first: 'Kenji',
    last: 'Watanabe',
    headline: 'Design Lead at Figma',
    title: 'Design Lead',
    company: 'Figma',
    location: 'San Francisco',
    schools: ['Carnegie Mellon University'],
    distance: 2,
    mutuals: 7,
  },
  {
    first: 'Amara',
    last: 'Diallo',
    headline: 'Data Scientist at Airbnb',
    title: 'Data Scientist',
    company: 'Airbnb',
    location: 'Seattle',
    schools: ['Georgia Tech'],
    distance: 3,
  },
  {
    first: 'Lucas',
    last: 'Ferreira',
    headline: 'Founder at Ledgerly (YC W25)',
    title: 'Founder',
    company: 'Ledgerly',
    location: 'Boston',
    schools: ['MIT'],
    distance: 3,
  },
];

const FIRSTS = [
  'Maya',
  'Jordan',
  'Priyanka',
  'Diego',
  'Hannah',
  'Omar',
  'Grace',
  'Mateo',
  'Aisha',
  'Ethan',
  'Leila',
  'Noah',
  'Chloe',
  'Arjun',
  'Zoe',
  'Samuel',
  'Ines',
  'Kofi',
  'Ruby',
  'Daniel',
  'Mei',
  'Tariq',
  'Clara',
  'Felix',
  'Yara',
  'Julian',
  'Anika',
  'Marco',
  'Sana',
  'Lena',
  'Victor',
  'Imani',
  'Hugo',
  'Rhea',
  'Caleb',
  'Nora',
  'Ravi',
  'Elise',
];
const LASTS = [
  'Alvarez',
  'Bennett',
  'Chowdhury',
  'Dubois',
  'Eriksen',
  'Fujita',
  'Garcia',
  'Haddad',
  'Iyer',
  'Jensen',
  'Kowalski',
  'Laurent',
  'Mensah',
  'Nakamura',
  'Oduya',
  'Petrov',
  'Quintero',
  'Rossi',
  'Sato',
  'Thornton',
  'Ueda',
  'Varga',
  'Whitaker',
  'Xu',
  'Yilmaz',
  'Zhang',
  'Abbott',
  'Brooks',
  'Castillo',
  'Delgado',
  'Ellison',
  'Foster',
  'Gupta',
];
const ROLES: [string, number][] = [
  ['Software Engineer', 9],
  ['Senior Software Engineer', 4],
  ['Product Manager', 7],
  ['Associate Product Manager', 4],
  ['Senior Product Manager', 2],
  ['Staff Engineer', 1],
  ['Engineering Manager', 2],
  ['Machine Learning Engineer', 3],
  ['Data Scientist', 2],
  ['Product Designer', 2],
  ['Strategy and Operations Associate', 2],
  ['Director of Engineering', 1],
  ['Head of Product', 1],
  ['Investment Banking Analyst', 1],
  ['Software Engineer Intern', 1],
];
const COMPANIES: [string, number][] = [
  ['Stripe', 6],
  ['Figma', 4],
  ['Anthropic', 4],
  ['Ramp', 3],
  ['Notion', 3],
  ['Linear', 2],
  ['Datadog', 2],
  ['Plaid', 2],
  ['Brex', 2],
  ['Databricks', 2],
  ['Google', 2],
  ['Vercel', 1],
  ['Airbnb', 1],
  ['Jane Street', 1],
  ['Goldman Sachs', 1],
];
const PLACES = [
  'New York',
  'San Francisco Bay Area',
  'San Francisco',
  'Seattle',
  'Boston',
  'Austin',
  'Remote',
];
const SCHOOLS = [
  'Cornell University',
  'Cornell University',
  'University of Michigan',
  'Carnegie Mellon University',
  'UC Berkeley',
  'NYU',
  'Georgia Tech',
  'Stanford University',
];

/** A small seeded random generator (mulberry32), so the pool is the same on every load. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, xs: [T, number][]): T {
  const total = xs.reduce((n, [, w]) => n + w, 0);
  let r = rand() * total;
  for (const [x, w] of xs) {
    r -= w;
    if (r <= 0) return x;
  }
  return xs[xs.length - 1]![0];
}

/** About a hundred people a search can turn up: mostly engineers and product people at the demo's kind of firms. */
const SEARCH_POOL: PoolPerson[] = (() => {
  const rand = seeded(17);
  const out = [...FIRST_SIX];
  const names = new Set(out.map((p) => `${p.first} ${p.last}`));
  for (let i = 0; out.length < 104 && i < 1000; i++) {
    const first = FIRSTS[Math.floor(rand() * FIRSTS.length)]!;
    const last = LASTS[Math.floor(rand() * LASTS.length)]!;
    if (names.has(`${first} ${last}`)) continue;
    names.add(`${first} ${last}`);
    const title = pick(rand, ROLES);
    const company = pick(rand, COMPANIES);
    const location = PLACES[Math.floor(rand() * PLACES.length)]!;
    const school = SCHOOLS[Math.floor(rand() * SCHOOLS.length)]!;
    const distance = rand() < 0.62 ? 2 : 3;
    // LinkedIn does not always say how many mutual connections there are
    const mutuals = distance === 2 && rand() < 0.85 ? 1 + Math.floor(rand() ** 2 * 30) : undefined;
    // a few headlines are students who only hope for the role: Discover must not call them bankers or engineers
    const hopeful = rand() < 0.06;
    const extra = rand() < 0.3 ? ` | ${school.replace(/ University$|University of /g, '')} alum` : '';
    out.push({
      first,
      last,
      title: hopeful ? `Aspiring ${title}` : title,
      company: hopeful ? '' : company,
      headline: hopeful ? `Aspiring ${title} | ${school}` : `${title} at ${company}${extra}`,
      location,
      schools: [school],
      distance,
      mutuals,
    });
  }
  return out;
})();

const HUES = [12, 28, 160, 200, 220, 260, 290, 330];
const SKIN = ['#f2d3b8', '#e0b48f', '#c68c5d', '#9a6440', '#6e4428'];
const HAIR = ['#2b1d16', '#4a3121', '#7a4b2a', '#b98a4e', '#1c1c1c', '#5c5c5c'];

/** An illustrated stand-in for a LinkedIn photo (the sample student has no real ones), as a small SVG. */
function mockPhoto(seedText: string): string {
  let h = 7;
  for (const ch of seedText) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const bg = HUES[h % HUES.length]!;
  const skin = SKIN[(h >>> 3) % SKIN.length]!;
  const hair = HAIR[(h >>> 6) % HAIR.length]!;
  const longHair = (h >>> 9) % 2 === 0;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${bg} 45% 82%)"/><path d="M10 64c2-14 11-20 22-20s20 6 22 20z" fill="hsl(${bg} 30% 38%)"/>${longHair ? `<path d="M17 30c0-12 7-18 15-18s15 6 15 18v14H17z" fill="${hair}"/>` : ''}<circle cx="32" cy="29" r="11" fill="${skin}"/><path d="M20 27c1-9 6-13 12-13s11 4 12 13c-3-5-7-7-12-7s-9 2-12 7z" fill="${hair}"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function toFound(p: PoolPerson): LinkedInFound {
  const slug = `${p.first}-${p.last}`.toLowerCase();
  return {
    memberId: `demo-search-${slug}`,
    name: `${p.first} ${p.last}`,
    headline: p.headline,
    location: p.location,
    profileUrl: `https://www.linkedin.com/in/${slug}`,
    distance: p.distance,
    pictureUrl: mockPhoto(slug),
    mutualCount: p.mutuals,
  };
}

/** A mock LinkedIn people search: the pool, best matches to the words first. */
export function mockLinkedInSearch(keywords: string | undefined, limit = 6): LinkedInFound[] {
  return mockLinkedInSearchPage({ keywords }, undefined, limit).people;
}

const MOCK_PAGE = 10;
const lower = (s: string | undefined) => (s ?? '').toLowerCase();

/**
 * One page of a mock LinkedIn people search. Filters narrow it the way LinkedIn's do (a title like theirs, the same
 * company, a school in their education, the place); keywords only rank. The cursor is the offset of the next page,
 * and there is none after the last.
 */
export function mockLinkedInSearchPage(
  q: { keywords?: string; title?: string; company?: string; school?: string; location?: string },
  cursor?: string,
  limit = MOCK_PAGE,
): { people: LinkedInFound[]; cursor?: string; total: number } {
  const words = lower(q.keywords)
    .split(/\W+/)
    .filter((w) => w.length > 2);
  const company = normalizeCompany(q.company);
  const matches = SEARCH_POOL.filter(
    (p) =>
      (!q.title || titleSimilarity(p.title, q.title) >= 0.5) &&
      (!company || normalizeCompany(p.company) === company) &&
      (!q.school ||
        p.schools.some((s) => lower(s).includes(lower(q.school)) || lower(q.school).includes(lower(s)))) &&
      (!q.location || lower(p.location).includes(lower(q.location).split(',')[0]!.trim())),
  );
  const score = (p: PoolPerson) =>
    words.filter((w) => lower(`${p.headline} ${p.location} ${p.company}`).includes(w)).length +
    (q.title ? titleSimilarity(p.title, q.title) : 0);
  const ranked = matches
    .map((p, i) => ({ p, s: score(p), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(({ p }) => p);
  const from = Math.max(0, Number(/^mock:(\d+)$/.exec(cursor ?? '')?.[1] ?? 0));
  const page = ranked.slice(from, from + limit);
  const next = from + limit < ranked.length ? `mock:${from + limit}` : undefined;
  return { people: page.map(toFound), cursor: next, total: ranked.length };
}
