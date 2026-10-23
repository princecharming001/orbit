/**
 * What the chat learns about the student in this browser (plan 17 §G): memories from what they say, and recruiting
 * targets that reach the goals drafts and recommendations read, with Orbit's rules or with Claude's read checked.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Person, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setSharedLlmClientFactoryForTests } from '../integrations/anthropic';
import { setOrbitApiBaseForTests } from '../integrations/orbitApi';
import { clearPrefs, writePrefs } from '../integrations/prefs';
import { setSharedClaudeUrlForTests } from '../integrations/shared-claude';
import { createLocalUser } from './account';
import { buildDraftContext, recommendationsRefresh } from './brief';
import { activeGoals, saveGoal } from './goals';
import { learnedNote, learnFromTurn } from './memoryLearn';
import { localMemories } from './memoryLocal';
import { saveGoals } from './settings';

const at = '2026-10-06T12:00:00.000Z';
const NOW = new Date('2026-10-22T15:00:00Z');
let user: User;

async function person(id: string, name: string, extra: Partial<Person>): Promise<Person> {
  const [first, ...rest] = name.split(' ');
  const p = {
    id,
    userId: user.id,
    displayName: name,
    firstName: first!,
    lastName: rest.join(' '),
    nameNormalized: name.toLowerCase(),
    emails: [],
    relationshipType: 'unknown',
    strength: 0.2,
    interactionCount: 0,
    sources: ['manual'],
    isHuman: true,
    tags: [],
    createdAt: at,
    updatedAt: at,
    ...extra,
  } as Person;
  await db.people.put(p);
  return p;
}

const say = (text: string) => learnFromTurn(user, [{ role: 'user', text }], { now: NOW });

beforeEach(async () => {
  await wipeDatabase();
  await clearPrefs();
  setOrbitApiBaseForTests(null);
  setSharedClaudeUrlForTests(null);
  user = await createLocalUser({ fullName: 'Alex Rivera', firstName: 'Alex', lastName: 'Rivera' });
  await saveGoals(user.id, { cycleLabel: 'Summer 2027 internship', targetFunctions: ['swe'] });
});
afterEach(() => {
  setOrbitApiBaseForTests(undefined);
  setSharedClaudeUrlForTests(undefined);
  setSharedLlmClientFactoryForTests(undefined);
});

describe('learning from what the student says, with Orbit rules', () => {
  it('remembers the statement with their words and puts its targets in every goal store', async () => {
    const l = await say("I'm targeting product manager internships at fintech startups in New York");
    expect(l.via).toBe('rules');
    const mem = await localMemories(user.id);
    expect(mem).toHaveLength(1);
    expect(mem[0]).toMatchObject({
      kind: 'goal_detail',
      text: 'Targeting product manager internships at fintech startups in New York',
      quote: "I'm targeting product manager internships at fintech startups in New York",
      source: 'rules',
    });
    // the row drafts and recommendations read
    const goals = await db.goals.get(user.id);
    expect(goals?.targetFunctions).toEqual(['swe', 'pm']);
    expect(goals?.targetRoles).toEqual(['Product Manager']);
    expect(goals?.targetIndustries).toEqual(['Fintech']);
    expect(goals?.targetLocations).toEqual(['New York City']);
    expect(goals?.cycleLabel).toBe('Summer 2027 internship');
    // the goal record the chat reads
    const records = await activeGoals(user.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'recruiting',
      title: 'Product manager internships at fintech startups in New York',
      source: 'inferred',
      evidence: "I'm targeting product manager internships at fintech startups in New York",
      targets: { roles: ['Product Manager'], geographies: ['New York City'] },
      criteria: { sector: 'Fintech', stage: 'startup' },
    });
    expect(learnedNote(l)).toBe(
      'Noted for later: Targeting product manager internships at fintech startups in New York. Added to your goals: Product Manager, Fintech, New York City.',
    );
    // said again: nothing new, and no second goal
    const again = await say("I'm targeting product manager internships at fintech startups in New York");
    expect(learnedNote(again)).toBeUndefined();
    expect(await activeGoals(user.id)).toHaveLength(1);
  });

  it('a goal said in chat changes the next recommendation refresh and the draft context', async () => {
    const pm = await person('p_pm', 'Pat Lee', {
      currentTitle: 'Product Manager',
      currentOrganizationRaw: 'Ramp',
      headline: 'Product Manager at Ramp, fintech',
    });
    await recommendationsRefresh(user, NOW);
    expect(await db.recommendations.where('personId').equals(pm.id).count()).toBe(0);
    await say("I'm targeting PM roles at fintech startups. I'm applying to Ramp and Brex");
    await recommendationsRefresh(user, NOW);
    const rec = await db.recommendations.where('personId').equals(pm.id).first();
    expect(rec?.reasons.map((r) => r.code)).toEqual(
      expect.arrayContaining(['function_match', 'target_company']),
    );
    const targets = (await db.targetCompanies.where('userId').equals(user.id).toArray()).map(
      (t) => t.nameRaw,
    );
    expect(targets.sort()).toEqual(['Brex', 'Ramp']);
    const ctx = await buildDraftContext((await db.users.get(user.id))!, pm, 'outreach', 'gmail');
    expect(ctx.user.targetFunctions).toContain('pm');
  });

  it('fills empty profile fields from what the student says, and never overwrites one they set', async () => {
    const l = await say("I'm a junior at Cornell studying CS. I graduate in May 2027");
    expect(l.profile.sort()).toEqual(['graduationYear', 'majors', 'school']);
    expect(await db.users.get(user.id)).toMatchObject({
      school: 'Cornell',
      majors: ['CS'],
      graduationYear: 2027,
    });
    await say("I'm a junior at Georgia Tech");
    expect((await db.users.get(user.id))?.school).toBe('Cornell');
    expect(learnedNote(await say("I'm a junior at Amma Health Inc."))).toBeUndefined();
  });

  it('never stores a guess, a question or someone else’s plan', async () => {
    for (const text of [
      'my friend wants PM roles',
      'Should I target consulting?',
      'Maybe I want to work in London',
      'Find PMs in New York',
    ])
      expect(learnedNote(await say(text)), text).toBeUndefined();
    expect(await localMemories(user.id)).toEqual([]);
    expect((await db.goals.get(user.id))?.targetFunctions).toEqual(['swe']);
  });

  it('ties a do-not-contact to the one person with that name', async () => {
    await person('p_maya', 'Maya Chen', {});
    await say("Don't contact Maya Chen");
    const [m] = await localMemories(user.id);
    expect(m).toMatchObject({
      kind: 'constraint',
      personId: 'p_maya',
      text: 'Does not want to contact Maya Chen',
    });
  });
});

describe('set_goal for recruiting writes the goals drafts and recommendations read', () => {
  it('mirrors the record into the goals row and the target companies', async () => {
    await saveGoal(user, {
      kind: 'recruiting',
      title: 'Land a consulting internship',
      targets: { organizations: ['McKinsey'], roles: ['Consultant'], geographies: ['Chicago'], people: [] },
      criteria: { sector: 'healthcare' },
    });
    const goals = await db.goals.get(user.id);
    expect(goals?.targetFunctions).toEqual(['swe', 'consulting']);
    expect(goals?.targetLocations).toEqual(['Chicago']);
    expect(goals?.targetIndustries).toEqual(['Healthcare and biotech']);
    expect((await db.targetCompanies.toArray()).map((t) => t.nameRaw)).toEqual(['McKinsey']);
    // a fundraising goal leaves recruiting alone
    await saveGoal(user, { kind: 'fundraising', title: 'Raise a pre-seed' });
    expect((await db.goals.get(user.id))?.targetFunctions).toEqual(['swe', 'consulting']);
  });
});

describe('learning with Claude, through Orbit’s shared access', () => {
  let answer: unknown;
  let asked = 0;
  beforeEach(() => {
    asked = 0;
    setSharedClaudeUrlForTests('https://proxy.test/functions/v1/orbit-claude');
    writePrefs({ anthropicApiKey: undefined });
    setSharedLlmClientFactoryForTests(
      () =>
        new Anthropic({
          apiKey: 'orbit-shared',
          baseURL: 'https://proxy.test/functions/v1/orbit-claude',
          dangerouslyAllowBrowser: true,
          maxRetries: 0,
          fetch: (async () => {
            asked++;
            return new Response(
              JSON.stringify({
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                model: 'claude-opus-5-5',
                content: [{ type: 'text', text: JSON.stringify(answer) }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 10 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }) as unknown as typeof fetch,
        }),
    );
  });

  it('keeps what Claude read only when the quote is the student’s and the targets are in their words', async () => {
    const text =
      "I'm in Ithaca this semester but I prefer meeting people in person, and I'm targeting PM roles at Ramp";
    answer = {
      memories: [
        {
          kind: 'preference',
          text: 'Prefers meeting people in person',
          person_name: null,
          importance: 0.6,
          quote: 'I prefer meeting people in person',
          replaces: [],
        },
        // not the student's words: dropped
        {
          kind: 'goal_detail',
          text: 'Wants a job at Google',
          person_name: null,
          importance: 0.9,
          quote: 'I want Google',
          replaces: [],
        },
        // a sensitive topic: dropped
        {
          kind: 'note',
          text: 'Is in therapy',
          person_name: null,
          importance: 0.5,
          quote: "I'm in Ithaca",
          replaces: [],
        },
      ],
      recruiting: {
        functions: ['pm', 'ib'],
        industries: [],
        locations: ['San Francisco'],
        organizations: ['Ramp', 'Stripe'],
        phrase: 'PM roles at Ramp',
        quote: "I'm targeting PM roles at Ramp",
      },
    };
    const l = await say(text);
    expect(asked).toBe(1);
    expect(l.via).toBe('claude');
    expect((await localMemories(user.id)).map((m) => [m.text, m.source])).toEqual([
      ['Prefers meeting people in person', 'chat'],
    ]);
    const goals = await db.goals.get(user.id);
    expect(goals?.targetFunctions).toEqual(['swe', 'pm']);
    expect(goals?.targetLocations).toEqual([]);
    expect((await db.targetCompanies.toArray()).map((t) => t.nameRaw)).toEqual(['Ramp']);
  });

  it('forgets the memory a new one replaces, but only one it was shown, of the same kind and named exactly', async () => {
    // two memories from Orbit's own rules first (no model call)
    const rules = (text: string) =>
      learnFromTurn(user, [{ role: 'user', text }], { now: NOW, claude: false });
    await rules('I prefer morning calls, honestly');
    await rules('I want to work in New York, honestly');
    const [calls, place] = (await localMemories(user.id)).map((m) => m.text).sort();
    expect([calls, place]).toEqual(['Prefers morning calls', 'Wants to work in New York']);
    answer = {
      memories: [
        {
          kind: 'preference',
          text: 'Prefers evening calls',
          person_name: null,
          importance: 0.6,
          quote: 'I prefer evening calls now',
          // the same memory in different casing and punctuation still names it; a different kind and an unknown
          // text do not
          replaces: ['prefers morning calls.', 'Wants to work in New York', 'Has a dog'],
        },
      ],
      recruiting: null,
    };
    const l = await say('Actually I prefer evening calls now');
    expect(l.via).toBe('claude');
    expect(l.replaced).toEqual(['Prefers morning calls']);
    expect((await localMemories(user.id)).map((m) => m.text).sort()).toEqual([
      'Prefers evening calls',
      'Wants to work in New York',
    ]);
    expect(learnedNote(l)).toBe(
      'Noted for later: Prefers evening calls. Forgot the old version: Prefers morning calls.',
    );
  });

  it('asks Claude nothing for a question or a request, and falls back to the rules when the read fails', async () => {
    await say('Who should I email about PM roles today?');
    expect(asked).toBe(0);
    answer = 'not json';
    const l = await say('I prefer morning calls, honestly');
    expect(asked).toBe(1);
    expect(l.via).toBe('rules');
    expect((await localMemories(user.id)).map((m) => m.text)).toEqual(['Prefers morning calls']);
  });
});
