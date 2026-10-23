import { describe, expect, it } from 'vitest';
import type { MatchablePerson } from '../agent/people-match';
import { type RouterContext, routeUtterance, splitAsks } from '../agent/router';
import type { ThreadContext } from '../agent/routerThread';
import { shortenMessage } from '../agent/shorten';
import { fixTypos } from '../agent/typos';
import { registry } from '../registry';

/**
 * The no-key router reading a message against what the conversation just showed (routerThread.ts): pronouns, "the
 * top 3", "send the first", "make it shorter", "and Dan?", "do it", "ask Maya" and "wait a week", plus the typo repair,
 * the two-asks split and the shortener they lean on. The offline simulation (sim/offline) plays the same in threads.
 */
const person = (id: string, first: string, last: string, org: string, strength = 0.5): MatchablePerson => ({
  id,
  displayName: `${first} ${last}`,
  firstName: first,
  lastName: last,
  currentOrganizationRaw: org,
  strength,
  isHuman: true,
});

const PEOPLE = [
  person('p1', 'Priya', 'Raman', 'Stripe', 0.8),
  person('p2', 'Aisha', 'Khan', 'Stripe'),
  person('p3', 'Jake', 'Morrison', 'Stripe'),
  person('p4', 'Marcus', 'Lee', 'Figma'),
  person('p5', 'Tomás', 'Herrera', 'Notion', 0.6),
  person('p6', 'Maya', 'Chen', 'Stripe', 0.7),
];

const BODY =
  "Hi Priya,\n\nI hope this finds you well. I'm a CS junior at Michigan and saw your talk on Stripe's billing roadmap. I spent the summer as a PM intern at Domino's. Would you have 20 minutes in the next couple of weeks to talk about moving from engineering into product? Completely understand if the next few weeks are busy.\n\nBest,\nRiley";

function ctx(thread?: ThreadContext, over: Partial<RouterContext> = {}): RouterContext {
  return {
    registry,
    people: PEOPLE,
    companies: ['Stripe', 'Figma', 'Notion'],
    cards: [{ id: 's_p4', personId: 'p4', kind: 'follow_up_bump' }],
    drafts: [],
    modeNote: 'Add your own key in Settings, Integrations to chat freely.',
    settingsHref: '/settings/integrations',
    thread,
    ...over,
  };
}

const route = (text: string, thread?: ThreadContext, over?: Partial<RouterContext>) =>
  routeUtterance(text, ctx(thread, over));

describe('router follow-ups: what the last card showed', () => {
  const list: ThreadContext = {
    list: [
      { id: 'p1', name: 'Priya Raman' },
      { id: 'p2', name: 'Aisha Khan' },
      { id: 'p3', name: 'Jake Morrison' },
    ],
    listIsNewest: true,
  };

  it('"draft to the top 3" and "write to all of them" write to the people the list showed', () => {
    for (const u of ['draft to the top 3', 'write to all of them', 'draft a message to each of them'])
      expect(route(u, list), u).toMatchObject({
        tool: 'create_drafts',
        input: { personIds: ['p1', 'p2', 'p3'] },
      });
    expect(route('write to the top 2', list)).toMatchObject({
      tool: 'create_drafts',
      input: { personIds: ['p1', 'p2'] },
    });
  });

  it('"the second one" opens the second person; "write to the first one" drafts to the first', () => {
    expect(route('the second one', list)).toMatchObject({ tool: 'get_person', input: { personId: 'p2' } });
    expect(route('write to the first one', list)).toMatchObject({
      tool: 'create_draft',
      input: { personId: 'p1' },
    });
  });

  it('pronouns point at the person the conversation is about, never at a name that starts the same', () => {
    const focus: ThreadContext = { focus: { id: 'p5', name: 'Tomás Herrera' } };
    expect(route('write to her', focus)).toMatchObject({ tool: 'create_draft', input: { personId: 'p5' } });
    expect(route('what do I know about him', focus)).toMatchObject({
      tool: 'get_person',
      input: { personId: 'p5' },
    });
    // with nothing before, "her" is nobody (it is not the start of "Herrera"): a question back
    const cold = route('write to her');
    expect(cold.kind).toBe('text');
    expect((cold as { text: string }).text).toMatch(/Who do you mean\?/);
  });

  it('the draft just made: send it (Approve still decides), make it shorter, discard it, show it', () => {
    const t: ThreadContext = {
      focus: { id: 'p1', name: 'Priya Raman' },
      drafts: [{ id: 'out_1', personId: 'p1', name: 'Priya Raman', status: 'draft', body: BODY }],
      lastKind: 'draft',
    };
    expect(route('send it', t)).toMatchObject({ tool: 'send_draft', input: { draftId: 'out_1' } });
    expect(route('yes', t)).toMatchObject({ tool: 'send_draft', input: { draftId: 'out_1' } });
    const short = route('make it shorter', t);
    expect(short).toMatchObject({ tool: 'update_draft_body', input: { draftId: 'out_1' } });
    const body = (short as unknown as { input: { body: string } }).input.body;
    expect(body.length).toBeLessThan(BODY.length);
    expect(body).toMatch(/Would you have 20 minutes/);
    expect(body).not.toMatch(/hope this finds you well|Completely understand/);
    expect(route('discard it', t)).toMatchObject({ tool: 'discard_draft', input: { draftId: 'out_1' } });
    expect(route('show it', t)).toMatchObject({ tool: 'get_draft', input: { draftId: 'out_1' } });
    expect(route('make it a referral ask instead', t)).toMatchObject({
      tool: 'create_draft',
      input: { personId: 'p1', kind: 'referral_ask' },
    });
  });

  it('several drafts: "send the first" sends the first one shown; "make it shorter" asks which', () => {
    const t: ThreadContext = {
      drafts: [
        { id: 'out_1', personId: 'p1', name: 'Priya Raman', status: 'draft', body: BODY },
        { id: 'out_2', personId: 'p2', name: 'Aisha Khan', status: 'draft', body: BODY },
      ],
      list: [
        { id: 'p1', name: 'Priya Raman' },
        { id: 'p2', name: 'Aisha Khan' },
      ],
      listIsNewest: true,
    };
    expect(route('send the first', t)).toMatchObject({ tool: 'send_draft', input: { draftId: 'out_1' } });
    expect(route('send the second draft', t)).toMatchObject({
      tool: 'send_draft',
      input: { draftId: 'out_2' },
    });
    expect(route('make it shorter', t)).toMatchObject({
      tool: 'offer_choices',
      lead: 'Which one should I shorten?',
    });
  });

  it('"and Dan?" asks the same about someone else; "undo that" undoes the move just made', () => {
    const t: ThreadContext = {
      focus: { id: 'p4', name: 'Marcus Lee' },
      last: { tool: 'move_pipeline_stage', input: { personId: 'p4', stage: 'replied' } },
    };
    expect(route('undo that', t)).toMatchObject({ tool: 'undo_stage_move', input: { personId: 'p4' } });
    const who: ThreadContext = {
      focus: { id: 'p1', name: 'Priya Raman' },
      last: { tool: 'get_person', input: { personId: 'p1' } },
    };
    expect(route('and Aisha?', who)).toMatchObject({ tool: 'get_person', input: { personId: 'p2' } });
    expect(route('what about Jake', who)).toMatchObject({ tool: 'get_person', input: { personId: 'p3' } });
  });

  it('"do it" and "yes" take the card\'s first next step; a waiting confirmation is never approved by words', () => {
    const t: ThreadContext = { steps: [{ label: 'Write to Jake', message: 'Write to Jake Morrison' }] };
    expect(route('do it', t)).toMatchObject({ tool: 'create_draft', input: { personId: 'p3' } });
    const pending: ThreadContext = { ...t, pending: { id: 'conf_1', tool: 'send_draft' } };
    const r = route('yes', pending);
    expect(r.kind).toBe('text');
    expect((r as { text: string }).text).toMatch(/Tap Approve/);
  });

  it('after routes, "ask Maya" drafts the intro request to the target', () => {
    const t: ThreadContext = { target: { id: 'p3', name: 'Jake Morrison' }, introducers: ['Maya Chen'] };
    expect(route('ask Maya', t)).toMatchObject({
      tool: 'create_draft',
      input: { kind: 'intro_request', personId: 'p6', targetPersonId: 'p3' },
    });
    expect(route('ask the first one', t)).toMatchObject({ tool: 'create_draft', input: { personId: 'p6' } });
  });

  it('"wait a week" snoozes the card about that person, and says so plainly when there is none', () => {
    const marcus: ThreadContext = { focus: { id: 'p4', name: 'Marcus Lee' } };
    expect(route('actually wait a week', marcus)).toMatchObject({
      tool: 'manage_suggestion',
      input: { suggestionId: 's_p4', action: 'snooze', days: 7 },
    });
    expect(route('remind me in 3 days', marcus)).toMatchObject({
      tool: 'manage_suggestion',
      input: { days: 3 },
    });
    const r = route('wait a week', { focus: { id: 'p2', name: 'Aisha Khan' } });
    expect(r.kind).toBe('text');
    expect((r as { text: string }).text).toMatch(/nothing goes out until you send it/);
  });

  it('"what should I ask" after a prep is the prep, not a judgement call', () => {
    expect(route('what should I ask', { focus: { id: 'p1', name: 'Priya Raman' } })).toMatchObject({
      tool: 'get_person',
      input: { personId: 'p1', include: ['prep'] },
    });
  });
});

describe('router: typos, two asks, the shortener', () => {
  it('puts a slipped letter right in a command word and leaves names and everyday words alone', () => {
    const keep = new Set(['stripe', 'evercore', 'tomas']);
    expect(fixTypos('shwo my piepline', keep)).toBe('show my pipeline');
    expect(fixTypos('who went queit', keep)).toBe('who went quiet');
    expect(fixTypos('Move Marcus to no resopnse', keep)).toBe('Move Marcus to no response');
    for (const s of [
      'whats on today',
      'waiting on a reply',
      'add Evercore to my targets',
      'who knows Lauren',
      'what states',
    ])
      expect(fixTypos(s, keep), s).toBe(s);
  });

  it('splits a message that asks for two things, and keeps a list of names whole', () => {
    expect(splitAsks('show my pipeline and draft a follow up to Marcus')).toEqual([
      'show my pipeline',
      'draft a follow up to Marcus',
    ]);
    expect(splitAsks("what's on today, then who went quiet")).toEqual(["what's on today", 'who went quiet']);
    expect(splitAsks('draft a message to each of: Priya, Aisha and Jake')).toEqual([
      'draft a message to each of: Priya, Aisha and Jake',
    ]);
    expect(route('show my pipeline and draft a follow up to Marcus')).toMatchObject({
      tool: 'list_pipeline',
      andThen: ['draft a follow up to Marcus'],
    });
  });

  it('shortens to the greeting, the opening, the ask and the sign-off, and keeps a gap to fill', () => {
    const out = shortenMessage(BODY);
    expect(out.startsWith('Hi Priya,')).toBe(true);
    expect(out).toMatch(/Best,\nRiley$/);
    expect(out.split(/\s+/).length).toBeLessThan(BODY.split(/\s+/).length * 0.85);
    const gap =
      "Hi Aisha,\n\nHope you're well. [Why them: your post on onboarding] I'm a junior at Michigan. I spent the summer at Domino's. I also run a club. Would you have 15 minutes to chat? No worries if not.\n\nThanks,\nRiley";
    expect(shortenMessage(gap)).toMatch(/\[Why them: your post on onboarding\]/);
    expect(shortenMessage('Hi Jake,\n\nWould you have 15 minutes?\n\nBest,\nRiley')).toBe(
      'Hi Jake,\n\nWould you have 15 minutes?\n\nBest,\nRiley',
    );
  });
});
