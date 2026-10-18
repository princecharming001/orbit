import type { Organization, Person, RelationshipType } from '@orbit/core';
import { MEDIUM_TIE, orbitGroupKey } from '@orbit/core';

/**
 * The made-up network the landing page's map searches: a student's ~60 connections across ten companies, who
 * among them knows whom, and why. Nothing here touches the student's own data; it only feeds the map and the routes
 * the visitor can try before signing up.
 */

const COMPANIES = [
  'Stripe',
  'Figma',
  'Notion',
  'Linear',
  'Ramp',
  'Anthropic',
  'Datadog',
  'Goldman Sachs',
  'McKinsey & Company',
  'Vercel',
] as const;

type Row = [
  name: string,
  company: (typeof COMPANIES)[number],
  title: string,
  strength: number,
  how?: RelationshipType,
];

// strength: 0.6 and up sits on the inner ring (close ties), 0.3 to 0.6 the middle, below that the outer ring
const ROWS: Row[] = [
  ['Maya Chen', 'Stripe', 'Software Engineer', 0.82, 'alumni'],
  ['Noah Kim', 'Stripe', 'Product Manager', 0.46],
  ['Yuki Lopez', 'Stripe', 'Product Designer', 0.32, 'alumni'],
  ['Amara Adeyemi', 'Stripe', 'Engineering Manager', 0.22],
  ['Felix Garcia', 'Stripe', 'Staff Engineer', 0.18],
  ['Mei Silva', 'Stripe', 'Data Scientist', 0.14],
  ['Priya Costa', 'Stripe', 'Recruiter', 0.12],
  ['Hannah Brooks', 'Figma', 'Product Manager', 0.52],
  ['Priya Ahmed', 'Figma', 'Senior Product Designer', 0.16],
  ['Zara Fischer', 'Figma', 'Analytics Engineer', 0.36, 'alumni'],
  ['Omar Haddad', 'Figma', 'Design Engineer', 0.2],
  ['Lucas Moreau', 'Figma', 'Software Engineer', 0.12],
  ['Ava Brennan', 'Figma', 'Head of Design Systems', 0.1],
  ['Jonah Reyes', 'Notion', 'Software Engineer', 0.78],
  ['Caleb Weber', 'Notion', 'Software Engineer', 0.38],
  ['Grace Lopez', 'Notion', 'Product Marketing', 0.24, 'alumni'],
  ['Mateo Adeyemi', 'Notion', 'Product Designer', 0.16],
  ['Ruth Okoye', 'Notion', 'Engineering Manager', 0.11],
  ['Lena Novak', 'Linear', 'Engineering Manager', 0.74, 'mentor'],
  ['Rhea Iyer', 'Linear', 'Software Engineer', 0.42],
  ['Ines Park', 'Linear', 'Product Designer', 0.2],
  ['Sam Ortiz', 'Linear', 'Founding Engineer', 0.13],
  ['Daniel Okafor', 'Ramp', 'Product Manager', 0.7],
  ['Jade Murphy', 'Ramp', 'Software Engineer', 0.34, 'alumni'],
  ['Victor Castro', 'Ramp', 'Strategy & Ops', 0.19],
  ['Nina Rossi', 'Ramp', 'Data Scientist', 0.12],
  ['Arjun Cohen', 'Anthropic', 'Research Engineer', 0.15],
  ['Kai Tanaka', 'Anthropic', 'Software Engineer', 0.28, 'alumni'],
  ['Lila Moss', 'Anthropic', 'Product Manager', 0.21],
  ['Ethan Park', 'Anthropic', 'Member of Technical Staff', 0.12],
  ['Clara Diaz', 'Anthropic', 'Recruiting Lead', 0.1],
  ['Sofia Bennett', 'Datadog', 'Senior Product Manager', 0.76, 'mentor'],
  ['Keiko Yamamoto', 'Datadog', 'Machine Learning Engineer', 0.48, 'alumni'],
  ['Elena Cohen', 'Datadog', 'Staff Engineer', 0.3],
  ['Tom Becker', 'Datadog', 'Solutions Engineer', 0.17],
  ['Ines Rahman', 'Goldman Sachs', 'Investment Banking Analyst', 0.72, 'alumni'],
  ['Marcus Lee', 'Goldman Sachs', 'Associate', 0.36],
  ['Olivia Grant', 'Goldman Sachs', 'Vice President', 0.18],
  ['Ravi Shah', 'Goldman Sachs', 'Analyst', 0.24, 'alumni'],
  ['Elena Garcia', 'McKinsey & Company', 'Business Analyst', 0.2],
  ['Ben Archer', 'McKinsey & Company', 'Associate', 0.4, 'alumni'],
  ['Tara Singh', 'McKinsey & Company', 'Engagement Manager', 0.14],
  ['Theo Lindqvist', 'Vercel', 'Product Designer', 0.68],
  ['Sana Sato', 'Vercel', 'Developer Advocate', 0.44],
  ['Diego Mehta', 'Vercel', 'Software Engineer', 0.22, 'alumni'],
  ['Freya Holm', 'Vercel', 'Product Manager', 0.12],
];

/** Ties between two people in the network: who knows whom, how well (0 to 1), and how they know each other. */
const BRIDGES: [a: string, b: string, weight: number, why: string][] = [
  ['Theo Lindqvist', 'Priya Ahmed', 0.82, 'worked together at Vercel until 2024'],
  ['Hannah Brooks', 'Priya Ahmed', 0.7, 'ship the same product at Figma'],
  ['Jonah Reyes', 'Kai Tanaka', 0.76, 'were roommates at Berkeley'],
  ['Kai Tanaka', 'Arjun Cohen', 0.72, 'are on the same team at Anthropic'],
  ['Lena Novak', 'Lila Moss', 0.64, 'worked together at Stripe'],
  ['Ines Rahman', 'Elena Garcia', 0.74, 'ran Cornell’s consulting club together'],
  ['Ben Archer', 'Tara Singh', 0.6, 'staffed the same engagement'],
  ['Maya Chen', 'Rhea Iyer', 0.66, 'worked together at Stripe'],
  ['Daniel Okafor', 'Noah Kim', 0.62, 'started a product club at Michigan together'],
  ['Sofia Bennett', 'Hannah Brooks', 0.5, 'met speaking at Config'],
  ['Sofia Bennett', 'Ethan Park', 0.58, 'worked together at Datadog'],
  ['Maya Chen', 'Felix Garcia', 0.68, 'are on the payments team at Stripe'],
  ['Maya Chen', 'Mei Silva', 0.55, 'sit together at Stripe'],
  ['Daniel Okafor', 'Victor Castro', 0.66, 'work together at Ramp'],
  ['Jonah Reyes', 'Ruth Okoye', 0.6, 'work together at Notion'],
  ['Lena Novak', 'Sam Ortiz', 0.7, 'work together at Linear'],
  ['Ines Rahman', 'Olivia Grant', 0.58, 'are on the same desk at Goldman Sachs'],
  ['Theo Lindqvist', 'Freya Holm', 0.6, 'work together at Vercel'],
  ['Theo Lindqvist', 'Ava Brennan', 0.48, 'met at a design meetup in New York'],
  ['Sofia Bennett', 'Tom Becker', 0.6, 'work together at Datadog'],
  ['Noah Kim', 'Priya Costa', 0.5, 'work together at Stripe'],
  ['Caleb Weber', 'Mateo Adeyemi', 0.55, 'work together at Notion'],
  ['Keiko Yamamoto', 'Clara Diaz', 0.46, 'were in the same ML reading group'],
  ['Rhea Iyer', 'Ines Park', 0.58, 'work together at Linear'],
  ['Jade Murphy', 'Nina Rossi', 0.52, 'work together at Ramp'],
  ['Hannah Brooks', 'Lucas Moreau', 0.6, 'work together at Figma'],
  ['Hannah Brooks', 'Omar Haddad', 0.54, 'work together at Figma'],
  ['Marcus Lee', 'Ravi Shah', 0.56, 'work together at Goldman Sachs'],
  ['Sana Sato', 'Diego Mehta', 0.55, 'work together at Vercel'],
  ['Maya Chen', 'Amara Adeyemi', 0.6, 'work together at Stripe'],
];

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const STAMP = '2026-09-01T12:00:00.000Z';

export const SAMPLE_ORGS = new Map<string, Organization>(
  COMPANIES.map((name) => [
    `org-${slug(name)}`,
    { id: `org-${slug(name)}`, name, nameNormalized: slug(name).replace(/-/g, ' '), domains: [] },
  ]),
);

export const SAMPLE_PEOPLE: Person[] = ROWS.map(([name, company, title, strength, how]) => {
  const [firstName, ...rest] = name.split(' ');
  return {
    id: `p-${slug(name)}`,
    userId: 'landing',
    displayName: name,
    firstName: firstName!,
    lastName: rest.join(' '),
    nameNormalized: name.toLowerCase(),
    emails: [],
    currentTitle: title,
    currentOrganizationId: `org-${slug(company)}`,
    currentOrganizationRaw: company,
    school: how === 'alumni' ? 'Cornell University' : undefined,
    isAlumni: how === 'alumni',
    relationshipType: how ?? 'peer',
    strength,
    interactionCount: Math.round(strength * 12),
    sources: ['linkedin_csv'],
    isHuman: true,
    tags: [],
    createdAt: STAMP,
    updatedAt: STAMP,
  };
});

export const SAMPLE_BY_ID = new Map(SAMPLE_PEOPLE.map((p) => [p.id, p]));
const idOf = (name: string) => `p-${slug(name)}`;

interface Tie {
  weight: number;
  why: string;
}
const ties = new Map<string, Map<string, Tie>>();
for (const [a, b, weight, why] of BRIDGES) {
  for (const [x, y] of [
    [idOf(a), idOf(b)],
    [idOf(b), idOf(a)],
  ] as const) {
    if (!SAMPLE_BY_ID.has(x) || !SAMPLE_BY_ID.has(y))
      throw new Error(`sample network: unknown person in ${a} / ${b}`);
    const m = ties.get(x) ?? new Map<string, Tie>();
    m.set(y, { weight, why });
    ties.set(x, m);
  }
}

/** Each person's ties inside the network, strongest first: the map draws these lines on hover. */
export const SAMPLE_CONNECTIONS = new Map<string, string[]>(
  [...ties].map(([id, m]) => [id, [...m].sort((a, b) => b[1].weight - a[1].weight).map(([to]) => to)]),
);

/** How the student knows someone directly, in words. */
export function directWhy(p: Person): string {
  if (p.relationshipType === 'mentor') return 'your mentor, you talk most months';
  if (p.strength >= 0.6) return `you’ve had coffee and email often`;
  if (p.isAlumni) return 'a Cornell alum you’re connected with on LinkedIn';
  if (p.strength >= 0.3) return 'you met at a recruiting event';
  return 'a LinkedIn connection you’ve never messaged';
}

export interface Hop {
  id: string;
  why: string;
}
export interface Route {
  /** the people on the way, the target last; the student is not listed */
  hops: Hop[];
  /** how likely the ask lands, 0 to 1 */
  score: number;
  band: 'Strong route' | 'Good route' | 'Long shot';
}

const band = (s: number): Route['band'] =>
  s >= 0.42 ? 'Strong route' : s >= 0.22 ? 'Good route' : 'Long shot';

/**
 * The warmest ways to someone: straight to them, or through one or two people the student knows, each first hop
 * used once, best first. A route's score multiplies how well each pair knows each other.
 */
export function routesTo(targetId: string, max = 3): Route[] {
  const target = SAMPLE_BY_ID.get(targetId);
  if (!target) return [];
  const found: Route[] = [
    { hops: [{ id: targetId, why: directWhy(target) }], score: target.strength * 0.9, band: 'Long shot' },
  ];
  for (const first of SAMPLE_PEOPLE) {
    if (first.id === targetId) continue;
    const t1 = ties.get(first.id);
    if (!t1) continue;
    const firstHop = { id: first.id, why: directWhy(first) };
    const direct = t1.get(targetId);
    if (direct)
      found.push({
        hops: [firstHop, { id: targetId, why: direct.why }],
        score: first.strength * direct.weight,
        band: 'Long shot',
      });
    for (const [midId, mid] of t1) {
      if (midId === targetId) continue;
      const last = ties.get(midId)?.get(targetId);
      if (last)
        found.push({
          hops: [firstHop, { id: midId, why: mid.why }, { id: targetId, why: last.why }],
          score: first.strength * mid.weight * last.weight,
          band: 'Long shot',
        });
    }
  }
  found.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: Route[] = [];
  for (const r of found) {
    const key = r.hops[0]!.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...r, band: band(r.score) });
    if (out.length === max) break;
  }
  return out;
}

export interface CompanyResult {
  name: string;
  groupKey: string;
  people: Person[];
  warm: number;
  /** the best way to each person there, warmest first */
  intros: { person: Person; route: Route }[];
}

export function companyResult(name: string): CompanyResult | undefined {
  const org = [...SAMPLE_ORGS.values()].find((o) => o.name === name);
  if (!org) return undefined;
  const people = SAMPLE_PEOPLE.filter((p) => p.currentOrganizationId === org.id);
  const intros = people
    .map((person) => ({ person, route: routesTo(person.id, 1)[0]! }))
    .sort((a, b) => b.route.score - a.route.score);
  return {
    name: org.name,
    groupKey: orbitGroupKey(people[0]!, SAMPLE_ORGS),
    people,
    warm: people.filter((p) => p.strength >= MEDIUM_TIE).length,
    intros,
  };
}

export type Suggestion =
  | { kind: 'company'; name: string; count: number }
  | { kind: 'person'; person: Person };

/** What the search box offers for what has been typed: companies first, then people, six at most. */
export function suggest(q: string): Suggestion[] {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const companies: Suggestion[] = COMPANIES.filter((c) => c.toLowerCase().includes(s)).map((name) => ({
    kind: 'company',
    name,
    count: SAMPLE_PEOPLE.filter((p) => p.currentOrganizationRaw === name).length,
  }));
  const people: Suggestion[] = SAMPLE_PEOPLE.filter(
    (p) =>
      p.displayName
        .toLowerCase()
        .split(' ')
        .some((w) => w.startsWith(s)) || p.displayName.toLowerCase().startsWith(s),
  ).map((person) => ({ kind: 'person', person }));
  return [...companies, ...people].slice(0, 6);
}

export const SAMPLE_COMPANIES = COMPANIES;
export const sampleId = idOf;
