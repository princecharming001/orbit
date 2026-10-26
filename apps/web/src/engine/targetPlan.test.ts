import type { CoffeeChat, Edge, Person, PostingInfo, User } from '@orbit/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { createLocalUser } from './account';
import { companyPeople, reachGraphFrom } from './graph';
import {
  buildTargetPlan,
  draftPlan,
  planFromInput,
  planPicks,
  postingLine,
  releaseHeldSteps,
  roleOf,
  whenText,
  whyLine,
} from './targetPlan';
import { addTarget } from './targets';

// a Tuesday
const NOW = new Date('2026-10-20T15:00:00Z');
const POSTING: PostingInfo = {
  company: 'Stripe',
  role: 'Software Engineer Intern',
  team: 'Payments',
  location: 'San Francisco, CA',
  namesOnPage: { recruiters: [], managers: [] },
};

const person = (id: string, extra: Partial<Person> = {}): Person => ({
  id,
  userId: 'u',
  displayName: `${id} Lee`,
  firstName: id,
  lastName: 'Lee',
  nameNormalized: `${id.toLowerCase()} lee`,
  emails: [],
  relationshipType: 'unknown',
  strength: 0,
  interactionCount: 0,
  sources: ['manual'],
  isHuman: true,
  tags: [],
  createdAt: '',
  updatedAt: '',
  currentOrganizationRaw: 'Stripe',
  ...extra,
});
const edge = (a: string, b: string, w = 0.7): Edge => ({
  id: `${a}|${b}`,
  userId: 'u',
  personAId: a,
  personBId: b,
  type: 'co_tenure',
  weight: w,
  confidence: 0.9,
  kinds: ['co_tenure'],
  evidence: {},
});
const chat = (personId: string, stage: CoffeeChat['stage'], extra: Partial<CoffeeChat> = {}) =>
  ({ personId, stage, updatedAt: '2026-10-15T15:00:00Z', ...extra }) as CoffeeChat;

// Dana: engineer on Payments the student knows; Priya: recruiter, through Kenji; Marcus: engineering manager,
// through Dana; Omar: a cold engineer; Zed: do-not-contact recruiter; Sky: an engineer already in the pipeline
const dana = person('Dana', { currentTitle: 'Software Engineer, Payments', strength: 0.68, isAlumni: true });
const kenji = person('Kenji', { currentTitle: 'Analyst', currentOrganizationRaw: 'Lazard', strength: 0.82 });
const priya = person('Priya', { currentTitle: 'University Recruiter' });
const marcus = person('Marcus', { currentTitle: 'Engineering Manager, Payments' });
const omar = person('Omar', { currentTitle: 'Software Engineer' });
const zed = person('Zed', { currentTitle: 'Technical Recruiter', doNotContact: true, strength: 0.6 });
const sky = person('Sky', { currentTitle: 'Software Engineer', strength: 0.5 });
const network = [dana, kenji, priya, marcus, omar, zed, sky];
const edges = [edge('Kenji', 'Priya'), edge('Dana', 'Marcus', 0.8)];
const { g } = reachGraphFrom(network, edges, NOW);
const atStripe = companyPeople(g, [dana, priya, marcus, omar, zed, sky]);

describe('roles from titles', () => {
  it('recruiter, team, manager and alum', () => {
    const role = (id: string) => roleOf(atStripe.find((c) => c.person.id === id)!, POSTING);
    expect(role('Priya')).toEqual(['recruiter']);
    expect(role('Dana')).toEqual(['team', 'alum']);
    expect(role('Marcus')).toEqual(['manager']);
    expect(role('Omar')).toEqual(['team']);
  });
});

describe('the picks (plan 23 §4.1)', () => {
  const picks = planPicks({
    people: atStripe,
    chats: [chat('Sky', 'replied', { lastInboundAt: '2026-10-15T15:00:00Z' })],
    posting: POSTING,
    now: NOW,
    tz: 'UTC',
  });
  const step = (id: string) => picks.steps.find((s) => s.personId === id);

  it('one per role, never do-not-contact, declined or live chats', () => {
    expect(picks.steps.map((s) => [s.personId, s.role])).toEqual([
      ['Dana', 'team'],
      ['Priya', 'recruiter'],
      ['Marcus', 'manager'],
    ]);
    expect(step('Zed')).toBeUndefined();
    expect(step('Sky')).toBeUndefined();
    expect(picks.inPipeline).toEqual([{ personId: 'Sky', line: 'already in your pipeline · replied Thu' }]);
    const declined = planPicks({
      people: atStripe,
      chats: [chat('Priya', 'declined')],
      posting: POSTING,
      now: NOW,
    });
    expect(declined.steps.some((s) => s.personId === 'Priya')).toBe(false);
  });

  it('orders them: the strongest direct tie today, the warm ask in two days, the manager after a reply', () => {
    expect(step('Dana')).toMatchObject({ draft: 'outreach', status: 'proposed', when: { kind: 'today' } });
    expect(step('Priya')).toMatchObject({ draft: 'intro_request', when: { kind: 'on' } });
    expect(Date.parse(step('Priya')!.when.at) - NOW.getTime()).toBe(2 * 86_400_000);
    expect(step('Marcus')).toMatchObject({
      draft: 'intro_request',
      status: 'held',
      when: { kind: 'after_reply', afterPersonId: 'Dana' },
    });
    const name = (id: string) => id;
    expect(picks.steps.map((s) => whenText(s, name, NOW, 'UTC'))).toEqual([
      'today',
      'Thu',
      'after Dana replies',
    ]);
  });

  it('says why each person, and never with a dash', () => {
    expect(step('Dana')!.roleText).toBe('on the Payments team');
    expect(step('Priya')!.roleText).toBe('recruits at Stripe');
    expect(step('Marcus')!.roleText).toBe('leads on the Payments team');
    expect(step('Priya')!.route.line).toMatch(/^via Kenji/);
    expect(whyLine('Priya', step('Priya')!, POSTING)).toBe(
      "I'm applying for the Software Engineer Intern role at Stripe, and Priya recruits at Stripe.",
    );
    expect(postingLine(POSTING)).toBe('Software Engineer Intern · Payments · Stripe · San Francisco, CA');
    for (const s of picks.steps) {
      expect(s.roleText).not.toMatch(/[–—]/);
      expect(s.route.line).not.toMatch(/[–—]/);
    }
  });

  it('a name the posting gives wins its role, and says so', () => {
    const named = planPicks({
      people: atStripe,
      chats: [],
      posting: { ...POSTING, namesOnPage: { recruiters: [], managers: ['Omar Lee'] } },
      now: NOW,
    });
    expect(named.steps.find((s) => s.role === 'manager')).toMatchObject({
      personId: 'Omar',
      roleText: 'the hiring manager',
    });
  });

  it('nobody is picked twice across two postings in a week', () => {
    const again = planPicks({
      people: atStripe,
      chats: [],
      posting: POSTING,
      now: NOW,
      exclude: new Set(['Dana']),
    });
    expect(again.steps.some((s) => s.personId === 'Dana')).toBe(false);
  });
});

describe('the plan, kept and drafted', () => {
  let user: User;
  beforeEach(async () => {
    await wipeDatabase();
    user = await createLocalUser({
      fullName: 'Ravi Jain',
      email: 'ravi@umich.edu',
      school: 'University of Michigan',
    });
    await db.people.bulkAdd(
      network.map((p) => ({
        ...p,
        userId: user.id,
        primaryEmail: `${p.id.toLowerCase()}@x.com`,
        emails: [`${p.id.toLowerCase()}@x.com`],
        linkedinConnectedOn: p.strength > 0.3 ? '2024-01-01' : undefined,
      })),
    );
    await db.edges.bulkAdd(edges.map((e) => ({ ...e, userId: user.id })));
  });

  it('a pasted line makes the target, with its organization, and the plan', async () => {
    const r = await planFromInput(user, 'Software Engineer Intern at Stripe', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = (await db.targetCompanies.get(r.plan.targetCompanyId))!;
    expect(t).toMatchObject({ nameRaw: 'Stripe', role: 'Software Engineer Intern', status: 'researching' });
    expect(t.organizationId).toBeTruthy();
    expect(r.plan.steps.length).toBe(3);
  });

  it('drafting writes cards and holds the step that waits on a reply, which the reply check releases', async () => {
    const { target } = await addTarget(user.id, 'Stripe', { role: POSTING.role });
    const plan = await buildTargetPlan(user, target!, POSTING, { now: NOW });
    const r = await draftPlan(user, plan.id, undefined, NOW);
    expect(r).toMatchObject({ drafted: 2, held: 1 });
    const cards = await db.suggestions.toArray();
    expect(cards.map((s) => s.kind).sort()).toEqual(['intro_request', 'new_outreach']);
    expect(await db.outbound.where('status').equals('sent').count()).toBe(0);
    const outreach = cards.find((s) => s.kind === 'new_outreach')!;
    expect(outreach.reasonText).toMatch(/your plan for the Software Engineer Intern role at Stripe/);
    const draft = (await db.outbound.get(outreach.outboundMessageId!))!;
    expect(draft.status).toBe('draft');
    expect(draft.bodyDraft).not.toMatch(/[–—]/);
    // nobody replied and the day has not come: still held
    expect(await releaseHeldSteps(user, new Date(NOW.getTime() + 86_400_000))).toBe(0);
    // Dana replies: Marcus's ask is drafted
    await db.chats.put({
      id: 'c_dana',
      userId: user.id,
      personId: 'Dana',
      stage: 'replied',
      stageEnteredAt: NOW.toISOString(),
      source: 'manual',
      goalTags: [],
      bumpCount: 0,
      priority: 2,
      lastInboundAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(await releaseHeldSteps(user, new Date(NOW.getTime() + 2 * 3_600_000))).toBe(1);
    const kept = (await db.targetPlans.get(plan.id))!;
    expect(kept.steps.find((s) => s.personId === 'Marcus')!.status).toBe('drafted');
  });

  it('is rebuilt when a pick leaves the company', async () => {
    const { target } = await addTarget(user.id, 'Stripe', { role: POSTING.role });
    const first = await buildTargetPlan(user, target!, POSTING, { now: NOW });
    expect(first.steps.some((s) => s.personId === 'Priya')).toBe(true);
    await db.people.update('Priya', { currentOrganizationRaw: 'Ramp' });
    const again = await buildTargetPlan(user, target!, POSTING, { now: NOW });
    expect(again.id).toBe(first.id);
    expect(again.steps.some((s) => s.personId === 'Priya')).toBe(false);
  });
});
