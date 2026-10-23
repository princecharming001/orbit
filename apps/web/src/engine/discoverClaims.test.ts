import type { Affiliation, Edge, Person, Recommendation, User } from '@orbit/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { importConnectionsCsv } from './linkedin';
import { loadPointContext, type PointContext, personPoints } from './personPoints';

const NOW = new Date('2026-10-06T15:00:00.000Z');
const person = (id: string, first: string, extra: Partial<Person> = {}): Person => ({
  id,
  userId: 'u',
  displayName: `${first} Test`,
  firstName: first,
  lastName: 'Test',
  nameNormalized: first.toLowerCase(),
  emails: [],
  relationshipType: 'unknown' as Person['relationshipType'],
  strength: 0.05,
  interactionCount: 0,
  sources: [],
  isHuman: true,
  tags: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...extra,
});
const rec = (personId: string): Recommendation => ({
  id: `r-${personId}`,
  userId: 'u',
  personId,
  score: 0.5,
  fitScore: 0.5,
  reachScore: 0.3,
  responsePrior: 0.5,
  reasons: [],
  status: 'new',
  batchDate: '2026-10-06',
});
const edge = (a: string, b: string, type: Edge['type'], evidence: Edge['evidence'] = {}): Edge => ({
  id: `${a}-${b}-${type}`,
  userId: 'u',
  personAId: a,
  personBId: b,
  type,
  weight: 0.5,
  evidence,
});

describe('"Knows X, whom you know well" is said only when it is true', () => {
  const target = person('t', 'Taylor');
  const ctx = (morgan: Person, edges: Edge[], smallThreads: string[] = []): PointContext => ({
    user: { id: 'u', school: 'Cornell University' },
    mine: [],
    people: new Map([
      [target.id, target],
      [morgan.id, morgan],
    ]),
    affiliations: [],
    facts: [],
    edges,
    smallThreads: new Set(smallThreads),
    now: NOW,
  });
  const knows = (c: PointContext) =>
    personPoints(target, rec(target.id), c).find((p) => p.text.startsWith('Knows'));

  it('a close friend on a small thread with them: yes', () => {
    const morgan = person('m', 'Morgan', { strength: 0.55, tieScore: 55, tieBand: 'warm' });
    expect(knows(ctx(morgan, [edge('m', 't', 'email_cothread')], ['m|t']))?.text).toBe(
      'Knows Morgan, whom you know well',
    );
  });

  it('a big thread, or someone the student knows only lightly: no', () => {
    const warm = person('m', 'Morgan', { strength: 0.55, tieScore: 55, tieBand: 'warm' });
    expect(knows(ctx(warm, [edge('m', 't', 'email_cothread')]))).toBeUndefined();
    const light = person('m', 'Morgan', { strength: 0.32, tieScore: 32, tieBand: 'light' });
    expect(knows(ctx(light, [edge('m', 't', 'email_cothread')], ['m|t']))).toBeUndefined();
  });

  it('overlapping years at one employer count, an employer with unknown dates does not', () => {
    const morgan = person('m', 'Morgan', { strength: 0.7, tieScore: 70, tieBand: 'strong' });
    expect(knows(ctx(morgan, [edge('m', 't', 'co_tenure', { datesUnknown: true })]))).toBeUndefined();
    expect(knows(ctx(morgan, [edge('m', 't', 'co_tenure', { overlapMonths: 14 })]))?.text).toBe(
      'Knows Morgan, whom you know well',
    );
  });
});

describe('a LinkedIn re-import records a job change only when there is one', () => {
  const user: User = {
    id: 'u',
    email: 'ravi@umich.edu',
    fullName: 'Ravi Jain',
    firstName: 'Ravi',
    lastName: 'Jain',
    school: 'University of Michigan',
    majors: [],
    timezone: 'America/Detroit',
    onboardingStep: 11,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const HDR = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On\n';
  const row = (company: string, title: string) =>
    `${HDR}Dana,Ito,https://www.linkedin.com/in/dana-ito,,${company},"${title}",12 Mar 2025\n`;
  const jobs = async () =>
    (await db.affiliations.toArray()).filter((a: Affiliation) => a.kind === 'employment');
  const points = async () => {
    const p = (await db.people.toArray())[0]!;
    const c = await loadPointContext(user, [p.id], NOW);
    return personPoints(p, rec(p.id), { ...c, dossier: undefined }).map((x) => x.text);
  };

  beforeEach(async () => {
    await wipeDatabase();
    await db.users.put(user);
    await importConnectionsCsv(user, row('Stripe', 'Software Engineer'));
  });

  it('a team added to the same title is not news, and nothing says they just joined', async () => {
    await importConnectionsCsv(user, row('Stripe', 'Software Engineer, Payments'));
    const all = await jobs();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ isCurrent: true, title: 'Software Engineer, Payments' });
    expect((await points()).join(' ')).not.toMatch(/Joined|Moved|New role/);
  });

  it('a new company is a move, said as what LinkedIn showed, not as a start date', async () => {
    await importConnectionsCsv(user, row('Figma', 'Software Engineer'));
    expect((await jobs()).filter((a) => a.isCurrent)).toHaveLength(1);
    const said = await points();
    expect(said).toContain('Moved from Stripe to Figma');
    expect(said.join(' ')).not.toMatch(/in the last year|years in the role/);
  });

  it('a promotion is a new role', async () => {
    await importConnectionsCsv(user, row('Stripe', 'Senior Software Engineer'));
    expect(await jobs()).toHaveLength(2);
    expect(await points()).toContain('New role: Senior Software Engineer');
  });
});
