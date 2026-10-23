/**
 * Every next step a card offers sends a sentence the no-key router turns into the tool the step means, so a chip
 * never answers with "I did not understand that".
 */
import { describe, expect, it } from 'vitest';
import type { MatchablePerson } from '../../agent/people-match';
import { type RouterContext, routeUtterance } from '../../agent/router';
import { registry } from '../../registry';
import {
  addTarget,
  afterStage,
  askForIntro,
  introTo,
  prepFor,
  showDrafts,
  warmUpFirst,
  whoKnows,
  whoWentQuiet,
  writeNow,
  writeTo,
  writeToEach,
} from './next';
import type { NextStep } from './parts';

const person = (id: string, first: string, last: string, org: string): MatchablePerson => ({
  id,
  displayName: `${first} ${last}`,
  firstName: first,
  lastName: last,
  currentOrganizationRaw: org,
  currentTitle: 'Engineer',
  strength: 0.5,
  isHuman: true,
});

const PEOPLE = [
  person('p1', 'Lena', 'Novak', 'Ramp'),
  person('p2', 'Daniel', 'Okafor', 'Stripe'),
  person('p3', 'Maya', 'Chen', 'Stripe'),
  person('p4', 'Noah', 'Kim', 'Figma'),
  person('p5', 'Priya', 'Ahmed', 'Stripe'),
  person('p6', 'Tomas', 'Yamamoto', 'Linear'),
];

function ctx(): RouterContext {
  return {
    registry,
    people: PEOPLE,
    companies: ['Stripe', 'Ramp', 'Figma', 'Linear'],
    modeNote: 'Add a key.',
    settingsHref: '/settings/integrations',
  };
}

function routes(step: NextStep | undefined, tool: string, input?: Record<string, unknown>) {
  expect(step, 'a step').toBeDefined();
  const r = routeUtterance(step!.message, ctx());
  expect(r.kind, `${step!.message} -> ${JSON.stringify(r)}`).toBe('tool');
  if (r.kind !== 'tool') return;
  expect(r.tool).toBe(tool);
  if (input) expect(r.input).toEqual(input);
}

describe('next-step chips route to the tool they mean', () => {
  it('writing to one person, with the kind or letting Orbit pick it', () => {
    routes(writeTo('Lena Novak', 'thank_you'), 'create_draft', { kind: 'thank_you', personId: 'p1' });
    routes(writeTo('Daniel Okafor', 'bump'), 'create_draft', { kind: 'bump', personId: 'p2' });
    routes(writeTo('Lena Novak', 'nurture'), 'create_draft', { kind: 'nurture', personId: 'p1' });
    routes(writeTo('Lena Novak', 'schedule'), 'create_draft', { kind: 'schedule', personId: 'p1' });
    routes(writeTo('Lena Novak', 'congratulate'), 'create_draft', { kind: 'congratulate', personId: 'p1' });
    routes(writeTo('Lena Novak', 'referral_ask'), 'create_draft', { kind: 'referral_ask', personId: 'p1' });
    // no kind: "Write to Lena Novak", and Orbit picks it from where the chat stands
    routes(writeTo('Lena Novak'), 'create_draft', { personId: 'p1' });
    expect(writeTo('Lena Novak', 'thank_you').label).toBe('Thank Lena');
    expect(writeTo('Lena Novak').label).toBe('Write to Lena');
  });

  it('several people at once, five at most', () => {
    routes(writeToEach(['Maya Chen', 'Priya Ahmed', 'Tomas Yamamoto']), 'create_drafts', {
      personIds: ['p3', 'p5', 'p6'],
    });
    routes(writeToEach(['Daniel Okafor', 'Noah Kim'], 'bump'), 'create_drafts', {
      personIds: ['p2', 'p4'],
      kind: 'bump',
    });
    const six = writeToEach(PEOPLE.map((p) => p.displayName))!;
    expect(six.label).toBe('Draft a message to the top 5');
    expect(six.message.split(',').length).toBe(4);
    // one name is one draft
    routes(writeToEach(['Noah Kim']), 'create_draft', { personId: 'p4' });
  });

  it('prep, intros, mutuals, targets and the lists', () => {
    routes(prepFor('Lena Novak'), 'get_person', { personId: 'p1', include: ['prep', 'facts'] });
    routes(introTo('Daniel Okafor'), 'find_routes', { personId: 'p2' });
    routes(whoKnows('Daniel Okafor'), 'get_person', { personId: 'p2', include: ['connections'] });
    routes(askForIntro('Maya Chen', 'Daniel Okafor'), 'create_draft', {
      kind: 'intro_request',
      personId: 'p3',
      targetPersonId: 'p2',
    });
    routes(addTarget('Stripe'), 'manage_target_company', { action: 'add', names: 'Stripe' });
    routes(whoWentQuiet, 'list_pipeline', { quietOnly: true });
    routes(showDrafts, 'list_drafts', { list: 'to_send' });
  });

  it('the warm-up choice for a LinkedIn-only stranger', () => {
    routes(warmUpFirst('Noah Kim'), 'create_draft', { personId: 'p4', warmUp: 'start' });
    routes(writeNow('Noah Kim'), 'create_draft', { personId: 'p4', warmUp: 'skip' });
  });

  it('after a chat moves', () => {
    routes(afterStage('Lena Novak', 'completed'), 'create_draft', { kind: 'thank_you', personId: 'p1' });
    routes(afterStage('Lena Novak', 'scheduled'), 'get_person', {
      personId: 'p1',
      include: ['prep', 'facts'],
    });
    routes(afterStage('Lena Novak', 'replied'), 'create_draft', { kind: 'schedule', personId: 'p1' });
    expect(afterStage('Lena Novak', 'outreach_sent')).toBeUndefined();
  });

  it('"add them all to People" points at Discover without a key', () => {
    const r = routeUtterance('Add them all to People', ctx());
    expect(r.kind).toBe('text');
    if (r.kind === 'text') expect(r.href).toBe('/discover?tab=find');
  });
});
