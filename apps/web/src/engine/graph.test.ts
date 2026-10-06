import type { Organization, Person, User } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { loadDemo } from './demo';
import {
  buildReachGraph,
  isUnambiguous,
  LINKEDIN_ONLY_WEIGHT,
  rankReachTargets,
  reachCompany,
  reachGraphFrom,
  reachPerson,
} from './graph';
import { ingestEmails, type RawEmail } from './ingest';

const NOW = new Date('2026-06-01T12:00:00Z');

const person = (id: string, extra: Partial<Person> = {}): Person => ({
  id,
  userId: 'u',
  displayName: id,
  firstName: id,
  lastName: 'X',
  nameNormalized: id,
  emails: [],
  relationshipType: 'unknown',
  strength: 0,
  interactionCount: 0,
  sources: ['manual'],
  isHuman: true,
  tags: [],
  createdAt: '',
  updatedAt: '',
  ...extra,
});
const org = (id: string, name: string, nameNormalized: string): Organization =>
  ({ id, name, nameNormalized, domains: [] }) as unknown as Organization;

describe('reach search ranking (GRL-14)', () => {
  const orgs = [
    org('o1', 'Stripe', 'stripe'),
    org('o2', 'Goldman Sachs', 'goldman sachs'),
    org('o3', 'Google', 'google'),
  ];
  const people = [
    person('a', { displayName: 'Priya Patel', currentOrganizationId: 'o3' }),
    person('b', { displayName: 'Daniel Kim', currentOrganizationId: 'o1' }),
    person('c', { displayName: 'Mei Chen', currentOrganizationId: 'o3' }),
  ];
  it('normalises company names', () => {
    for (const q of ['stripe inc', 'Stripe, Inc.', 'STRIPE']) {
      const c = rankReachTargets(q, people, orgs);
      expect(c[0]).toMatchObject({ kind: 'company', id: 'o1' });
      expect(isUnambiguous(c)).toBe(true);
    }
  });
  it('asks when a prefix matches several companies, bigger presence first', () => {
    const c = rankReachTargets('go', people, orgs);
    expect(c.map((x) => x.label)).toEqual(['Google', 'Goldman Sachs']);
    expect(isUnambiguous(c)).toBe(false);
  });
  it('finds companies people list even without an organization record', () => {
    const extra = [
      person('d', { displayName: 'Ana Ruiz', currentOrganizationRaw: 'Acme Robotics, Inc.' }),
      person('e', { displayName: 'Bo Li', currentOrganizationRaw: 'Acme Robotics' }),
    ];
    const c = rankReachTargets('acme robotics', [...people, ...extra], orgs);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: 'company', sub: '2 people in your network' });
  });
  it('an exact person name wins outright', () => {
    const c = rankReachTargets('daniel kim', people, orgs);
    expect(c[0]).toMatchObject({ kind: 'person', id: 'b' });
    expect(isUnambiguous(c)).toBe(true);
  });
});

describe('student tie on the reach graph (GRL-08)', () => {
  it('a recent LinkedIn-only connection is never weaker than an old one, and the text is truthful', () => {
    const recent = person('r', {
      firstName: 'Ana',
      strength: 0.041,
      interactionCount: 1,
      linkedinConnectedOn: '2026-01-02',
      strengthBreakdown: { raw: 0.06, recency: 0.1, counts: { linkedin_connected: 1 } },
    });
    const old = person('o', { firstName: 'Bo', strength: 0, linkedinConnectedOn: '2019-04-01' });
    const { g } = reachGraphFrom([recent, old], [], NOW);
    const wr = g.adj.get('user')!.get('r')!;
    const wo = g.adj.get('user')!.get('o')!;
    expect(wr.weight).toBeGreaterThanOrEqual(wo.weight);
    expect(wr.weight).toBe(LINKEDIN_ONLY_WEIGHT);
    expect(wr.text).toBe("You're connected with Ana on LinkedIn (since Jan 2026)");
    expect(wr.text).not.toMatch(/interaction/);
  });
});

describe('with the demo network', () => {
  let user: User;
  beforeAll(async () => {
    user = await loadDemo({ reset: true });
  }, 60_000);

  it('no one is a medium or strong tie without ever replying or meeting (GRL-01)', async () => {
    const people = await db.people.where('userId').equals(user.id).toArray();
    const twoWay = ['meeting', 'email_in', 'linkedin_in', 'manual_log', 'intro_observed'] as const;
    for (const p of people) {
      const counts = p.strengthBreakdown?.counts ?? {};
      if (!twoWay.some((k) => (counts[k] ?? 0) > 0)) expect(p.strength).toBeLessThan(0.3);
    }
  });

  it('mailing-list threads add no touchpoints, small threads add one CC touchpoint per thread (GRL-02)', async () => {
    const domain = 'club.example.edu';
    const members = Array.from(
      { length: 11 },
      (_, i) => `Member${String.fromCharCode(65 + i)} Lastname <m${i}@${domain}>`,
    );
    const big: RawEmail[] = Array.from({ length: 12 }, (_, i) => ({
      externalMessageId: `list-${i}`,
      externalThreadId: 'list-thread',
      from: members[0]!,
      to: [user.email, ...members.slice(1, 6)],
      cc: members.slice(6),
      subject: 'Club meeting this week',
      sentAt: new Date(Date.now() - (i + 1) * 86_400_000).toISOString(),
      bodyText: `Hi all, meeting number ${i} is on Thursday in the usual room.`,
      headers: {},
    }));
    const small: RawEmail[] = Array.from({ length: 6 }, (_, i) => ({
      externalMessageId: `small-${i}`,
      externalThreadId: 'small-thread',
      from: 'Jordan Blake <jordan@smallco.example.com>',
      to: [user.email],
      cc: ['Riley Stone <riley@smallco.example.com>'],
      subject: 'Project notes',
      sentAt: new Date(Date.now() - (i + 1) * 86_400_000).toISOString(),
      bodyText: `Notes for part ${i} of the project.`,
      headers: {},
    }));
    await ingestEmails(user, [...big, ...small], { useLlm: false });
    const all = await db.people.where('userId').equals(user.id).toArray();
    const listPeople = all.filter((p) => p.emails.some((e) => e.endsWith(`@${domain}`)));
    expect(listPeople.length).toBeGreaterThan(8);
    for (const p of listPeople) {
      expect(await db.touchpoints.where('personId').equals(p.id).count()).toBe(0);
      expect(p.strength).toBeLessThan(0.3);
    }
    const riley = all.find((p) => p.emails.includes('riley@smallco.example.com'))!;
    const tps = await db.touchpoints.where('personId').equals(riley.id).toArray();
    expect(tps.filter((t) => t.kind === 'email_cc').length).toBe(1);
  });

  it('company reach: normalised lookup, alumni inside the list, former employees within five years (GRL-14, GRL-15)', async () => {
    const c = await reachCompany(user.id, 'Stripe, Inc.');
    expect(c.org?.name).toBe('Stripe');
    expect(c.direct.length).toBeGreaterThan(0);
    const directIds = new Set(c.direct.map((d) => d.person.id));
    for (const a of c.alumni) expect(directIds.has(a.person.id)).toBe(true);
    for (const f of c.former) {
      expect(directIds.has(f.person.id)).toBe(false);
      if (f.endedAt) expect(Date.now() - new Date(f.endedAt).getTime()).toBeLessThan(5.1 * 365 * 86_400_000);
    }
    for (let i = 1; i < c.direct.length; i++)
      expect(c.direct[i - 1]!.strength).toBeGreaterThanOrEqual(c.direct[i]!.strength);
  });

  it('every multi-hop route explains each hop with both names (GRL-11)', async () => {
    const { people } = await buildReachGraph(user.id);
    const weak = [...people.values()].filter((p) => p.strength < 0.05).slice(0, 40);
    let checked = 0;
    for (const t of weak) {
      const paths = await reachPerson(user.id, t.id);
      for (const p of paths) {
        for (const h of p.hops) {
          expect(h.text).not.toMatch(/[–—!_]/);
          if (h.fromId === 'user') continue;
          const a = people.get(h.fromId)!;
          const b = people.get(h.toId)!;
          expect(h.text).toContain(a.firstName);
          expect(h.text).toContain(b.firstName);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
