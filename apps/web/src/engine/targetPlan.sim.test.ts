/**
 * Plan 23 §4.1, simulated: 300 made-up students, networks from nothing to 2,000 people, postings at companies they do
 * and do not touch, with and without LinkedIn. A career coach's rules, checked on every plan.
 */
import { mulberry32, type Person, type PostingInfo } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import type { CompanyPerson, CompanyTeam } from './graph';
import { planPicks, roleOf } from './targetPlan';

const TITLES: [string, CompanyTeam][] = [
  ['Software Engineer', 'engineering'],
  ['Senior Software Engineer, Payments', 'engineering'],
  ['Engineering Manager, Payments', 'engineering'],
  ['Director of Engineering', 'engineering'],
  ['University Recruiter', 'recruiting'],
  ['Technical Recruiter', 'recruiting'],
  ['Product Manager', 'product'],
  ['Product Designer', 'design'],
  ['Data Scientist', 'data'],
  ['Account Executive', 'sales'],
  ['Chief Financial Officer', 'leadership'],
  ['Office Coordinator', 'other'],
];
const POSTING: PostingInfo = {
  company: 'Stripe',
  role: 'Software Engineer Intern',
  team: 'Payments',
  namesOnPage: { recruiters: [], managers: [] },
};

function student(seed: number) {
  const rnd = mulberry32(seed);
  // network size 0 to 2,000, most students small
  const size = Math.floor(2000 * rnd() ** 3);
  // how many of them are at the posting's company: none for a company they do not touch
  const touches = rnd() < 0.75;
  const here = touches ? Math.min(size, Math.floor(1 + rnd() * Math.min(60, size / 10 + 3))) : 0;
  const linkedIn = rnd() < 0.7;
  const people: CompanyPerson[] = [];
  for (let i = 0; i < here; i++) {
    const [title, team] = TITLES[Math.floor(rnd() * TITLES.length)]!;
    const kind = rnd();
    const route =
      kind < 0.3
        ? {
            kind: 'direct' as const,
            score: 0.4 + rnd() * 0.5,
            line: `You know p${i} directly · your tie · 60`,
          }
        : kind < 0.75
          ? {
              kind: 'warm' as const,
              score: 0.1 + rnd() * 0.6,
              line: `via v${i} (your tie · 50)`,
              via: { id: `v${i}`, name: `v${i}` },
            }
          : { kind: 'cold' as const, score: 0, line: 'No one you know knows them yet' };
    const person = {
      id: `s${seed}p${i}`,
      displayName: `Person ${i} Lee`,
      firstName: `Person${i}`,
      currentTitle: title,
      isAlumni: rnd() < 0.15,
      doNotContact: rnd() < 0.03,
    } as Person;
    people.push({ person, team, alum: !!person.isAlumni, route, action: 'write' });
  }
  const chats = people
    .filter(() => rnd() < 0.1)
    .map((c) => ({
      personId: c.person.id,
      stage: (rnd() < 0.3 ? 'declined' : 'replied') as 'declined' | 'replied',
      updatedAt: '2026-10-15T15:00:00Z',
    }));
  return { people, chats, linkedIn };
}

describe('the plan over 300 made-up students (plan 23 §4.1)', () => {
  const NOW = new Date('2026-10-20T15:00:00Z');
  const students = Array.from({ length: 300 }, (_, i) => ({ seed: i + 1, ...student(i + 1) }));

  it('holds the coach rules on every plan', () => {
    let full = 0;
    let fillable = 0;
    for (const s of students) {
      const picks = planPicks({ people: s.people, chats: s.chats, posting: POSTING, now: NOW });
      const byId = new Map(s.people.map((c) => [c.person.id, c]));
      const live = new Set(s.chats.map((c) => c.personId));
      // at most three, nobody twice, never do-not-contact, declined or already in the pipeline
      expect(picks.steps.length).toBeLessThanOrEqual(3);
      expect(new Set(picks.steps.map((p) => p.personId)).size).toBe(picks.steps.length);
      for (const step of picks.steps) {
        const c = byId.get(step.personId)!;
        expect(c.person.doNotContact).toBeFalsy();
        expect(live.has(step.personId)).toBe(false);
        // every pick has a reason naming their tie to the posting, and the way in
        expect(step.roleText.length).toBeGreaterThan(5);
        expect(step.route.line.length).toBeGreaterThan(5);
        expect(`${step.roleText} ${step.route.line}`).not.toMatch(/[–—]/);
        // a warm pick never outranks a strong direct tie who could fill the same role
        if (step.route.kind === 'warm' && step.role !== 'alum')
          for (const other of s.people)
            if (
              other.route.kind === 'direct' &&
              other.route.score >= 0.6 &&
              !other.person.doNotContact &&
              !live.has(other.person.id) &&
              !picks.steps.some((x) => x.personId === other.person.id) &&
              roleOf(other, POSTING).includes(step.role)
            )
              expect(other.route.score, `seed ${s.seed}`).toBeLessThanOrEqual(step.route.score);
      }
      // the three roles are filled when the network allows
      const can = (role: 'recruiter' | 'team' | 'manager') =>
        s.people.some(
          (c) => !c.person.doNotContact && !live.has(c.person.id) && roleOf(c, POSTING).includes(role),
        );
      const distinct = new Set(
        s.people.filter((c) => !c.person.doNotContact && !live.has(c.person.id)).map((c) => c.person.id),
      ).size;
      if (can('recruiter') && can('team') && can('manager') && distinct >= 3) {
        fillable++;
        const roles = new Set(picks.steps.map((p) => p.role));
        if (roles.has('recruiter') && roles.has('team') && roles.has('manager')) full++;
      }
      // the first step goes today; a held step waits on someone who is in the plan
      if (picks.steps.length) expect(picks.steps[0]!.when.kind).toBe('today');
      for (const step of picks.steps.filter((x) => x.status === 'held'))
        expect(picks.steps.some((x) => x.personId === step.when.afterPersonId)).toBe(true);
    }
    // three roles, one person each, nearly always when the network has them (a person can hold two)
    expect(full / Math.max(1, fillable)).toBeGreaterThan(0.9);
  });

  it('nobody is picked twice across two postings in a week', () => {
    for (const s of students.slice(0, 120)) {
      const first = planPicks({ people: s.people, chats: s.chats, posting: POSTING, now: NOW });
      const second = planPicks({
        people: s.people,
        chats: s.chats,
        posting: { ...POSTING, role: 'Data Science Intern', team: undefined },
        now: NOW,
        exclude: new Set(first.steps.map((x) => x.personId)),
      });
      for (const st of second.steps) expect(first.steps.some((x) => x.personId === st.personId)).toBe(false);
    }
  });

  it('a company nobody in the network touches gives an empty plan, never someone from elsewhere', () => {
    const none = students.filter((s) => s.people.length === 0);
    expect(none.length).toBeGreaterThan(20);
    for (const s of none)
      expect(planPicks({ people: s.people, chats: [], posting: POSTING, now: NOW }).steps).toEqual([]);
  });
});
