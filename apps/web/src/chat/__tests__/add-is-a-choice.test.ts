/**
 * Adding someone to the student's People is always their own clear decision (Anish, 2026-11-08: "There should be a
 * very clear decision to add this set of people or this person to your contacts... across the app"). The model can
 * only ask: every tool that adds people needs Approve when the model calls it. The student's own words, read exactly
 * by the router ("Add to People: Dana Lee [rec li:1]", "add a person Priya Shah, priya@evercore.com"), are the choice.
 */
import type { Person, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../../db/schema';
import { createLocalUser } from '../../engine/account';
import { setOrbitApiBaseForTests } from '../../integrations/orbitApi';
import { routeUtterance } from '../agent/router';
import { routerContextFor } from '../agent/routerContext';
import { execute, registry } from '../registry';
import { makeCtx, nextToolUseId } from './helpers';

const at = '2026-10-06T12:00:00.000Z';

/** Every tool that can put a new person in the student's People. */
const ADDS_PEOPLE = ['add_sourced', 'add_person', 'save_suggested_contacts'] as const;

async function seedPerson(user: User, id: string, name: string): Promise<Person> {
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
    strength: 0.5,
    interactionCount: 3,
    sources: ['manual'],
    isHuman: true,
    tags: [],
    createdAt: at,
    updatedAt: at,
  } as Person;
  await db.people.put(p);
  return p;
}

const othersThan = async (...ids: string[]) =>
  (await db.people.toArray()).filter((p) => !ids.includes(p.id));

describe('the tools that add people', () => {
  it('each one asks the student to approve and explains on the Approve card who would join People', () => {
    for (const name of ADDS_PEOPLE) {
      const spec = registry.get(name);
      expect(spec, name).toBeDefined();
      expect(spec!.kind, name).toBe('risky');
      expect(spec!.summarizeIntent, name).toBeTypeOf('function');
    }
  });

  it('only a tool that needs Approve can run on the student’s own words, and suggested names never do', () => {
    for (const spec of registry.values())
      if (spec.runsOnStudentWords) expect(spec.kind, spec.name).toBe('risky');
    // "Priya suggested I talk to Tom" tells Orbit something; it does not ask to add Tom
    expect(registry.get('save_suggested_contacts')!.runsOnStudentWords).toBeFalsy();
    expect(registry.get('add_sourced')!.runsOnStudentWords).toBe(true);
    expect(registry.get('add_person')!.runsOnStudentWords).toBe(true);
  });

  it('every description tells the model to ask first instead of adding as a side effect', () => {
    expect(registry.get('add_sourced')!.description).toMatch(/Never call it on your own after a search/);
    expect(registry.get('add_sourced')!.description).toMatch(/"Want me to add them\?"/);
    expect(registry.get('add_person')!.description).toMatch(
      /Never to save someone you found, researched or are drafting to/,
    );
    expect(registry.get('find_people')!.description).toMatch(/Finding people never adds them/);
  });
});

describe('adding people, local mode', () => {
  let user: User;
  beforeEach(async () => {
    await wipeDatabase();
    setOrbitApiBaseForTests(null);
    user = await createLocalUser({
      fullName: 'Alex Rivera',
      firstName: 'Alex',
      school: 'Cornell University',
    });
    await seedPerson(user, 'p_priya', 'Priya Shah');
  });
  afterEach(() => setOrbitApiBaseForTests(undefined));

  const input = { name: 'Tom Lee', company: 'Stripe', title: 'Analyst', email: 'tom.lee@example.com' };

  it('add_person from the model: an Approve card naming them, and no one is added until it is pressed', async () => {
    const asked = await execute('add_person', input, makeCtx(user, { caller: 'llm' }));
    expect(asked.kind).toBe('needs_confirmation');
    expect(asked.summary).toBe(
      'Add Tom Lee, Analyst at Stripe (tom.lee@example.com) to your People. Nothing happens until you approve it.',
    );
    expect(await othersThan('p_priya')).toHaveLength(0);
    const done = await execute(
      'add_person',
      input,
      makeCtx(user, { caller: 'ui', confirmation: asked.confirmationId, toolUseId: nextToolUseId() }),
    );
    expect(done.kind).toBe('person');
    expect(done.summary).toMatch(/^Added Tom Lee\./);
    expect((await othersThan('p_priya')).map((p) => p.displayName)).toEqual(['Tom Lee']);
  });

  it('add_person with no way to reach them is blocked on the card, before anything is saved', async () => {
    const asked = await execute('add_person', { name: 'Tom Lee' }, makeCtx(user, { caller: 'llm' }));
    expect(asked.kind).toBe('needs_confirmation');
    expect((asked.data as { blockedReason?: string }).blockedReason).toMatch(
      /an email address or a LinkedIn/,
    );
    expect(await othersThan('p_priya')).toHaveLength(0);
  });

  it('the student typing "add a person …" is the choice: the router runs it at once', async () => {
    const intent = routeUtterance('add a person Tom Lee at Stripe, tom.lee@example.com', {
      registry,
      ...(await routerContextFor(user.id, new Date(at))),
    });
    expect(intent).toMatchObject({ kind: 'tool', tool: 'add_person' });
    const done = await execute(
      'add_person',
      (intent as { input: Record<string, unknown> }).input,
      makeCtx(user, { caller: 'router' }),
    );
    expect(done.kind).toBe('person');
    expect((await othersThan('p_priya')).map((p) => p.displayName)).toEqual(['Tom Lee']);
  });

  it('a chip or other UI call without a token still asks first', async () => {
    const asked = await execute('add_person', input, makeCtx(user, { caller: 'ui' }));
    expect(asked.kind).toBe('needs_confirmation');
    expect(await othersThan('p_priya')).toHaveLength(0);
  });

  it('who someone suggested is saved only after Approve, even when the router read the names', async () => {
    const intent = routeUtterance('Priya Shah suggested I talk to Tom Lee at Stripe', {
      registry,
      ...(await routerContextFor(user.id, new Date(at))),
    });
    expect(intent).toMatchObject({ kind: 'tool', tool: 'save_suggested_contacts' });
    const via = (intent as { input: Record<string, unknown> }).input;
    const asked = await execute('save_suggested_contacts', via, makeCtx(user, { caller: 'router' }));
    expect(asked.kind).toBe('needs_confirmation');
    expect(asked.summary).toMatch(
      /^Add Tom Lee at Stripe to your People and Discover, as suggested by Priya\./,
    );
    expect(await othersThan('p_priya')).toHaveLength(0);
    const done = await execute(
      'save_suggested_contacts',
      via,
      makeCtx(user, { caller: 'ui', confirmation: asked.confirmationId, toolUseId: nextToolUseId() }),
    );
    expect(done.kind).toBe('people');
    expect((await othersThan('p_priya')).map((p) => p.displayName)).toEqual(['Tom Lee']);
  });

  it('a token for one add never approves a different set of people', async () => {
    const asked = await execute('add_person', input, makeCtx(user, { caller: 'llm' }));
    const other = await execute(
      'add_person',
      { ...input, name: 'Someone Else', email: 'else@example.com' },
      makeCtx(user, { caller: 'ui', confirmation: asked.confirmationId, toolUseId: nextToolUseId() }),
    );
    expect(other.kind).toBe('error');
    expect(await othersThan('p_priya')).toHaveLength(0);
  });
});
