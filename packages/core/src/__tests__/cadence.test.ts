import { describe, expect, it } from 'vitest';
import {
  type CadenceDraft,
  type CadenceInput,
  type CadenceMessage,
  type CadencePerson,
  cadenceActions,
  cancelIfReplied,
  isSendDay,
  MAX_UNANSWERED,
  nextSendDay,
  unansweredCount,
  wentQuiet,
} from '../pipeline/cadence';
import type { CoffeeChat, Goal } from '../types';

// Wednesday 14 October 2026, 15:00 UTC
const NOW = new Date('2026-10-14T15:00:00Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const chat = (id: string, extra: Partial<CoffeeChat> = {}): CoffeeChat => ({
  id,
  userId: 'u',
  personId: `p-${id}`,
  stage: 'outreach_sent',
  stageEnteredAt: ago(30),
  source: 'manual',
  goalTags: [],
  outreachChannel: 'gmail',
  firstOutreachAt: ago(30),
  lastOutboundAt: ago(30),
  bumpCount: 0,
  priority: 2,
  createdAt: ago(30),
  updatedAt: ago(30),
  ...extra,
});

const cp = (id: string, score: number, extra: Partial<CadencePerson> = {}): [string, CadencePerson] => [
  id,
  {
    person: { id, firstName: id, currentTitle: 'Software Engineer', currentOrganizationRaw: 'Figma' },
    score,
    ...extra,
  },
];

const goal = (id: string, kind: Goal['kind'], people: string[] = []): Goal => ({
  id,
  userId: 'u',
  kind,
  title: kind,
  targets: { organizations: [], roles: [], geographies: [], people },
  criteria: {},
  priority: 2,
  status: 'active',
  source: 'user',
  createdAt: ago(60),
  updatedAt: ago(60),
});

const input = (extra: Partial<CadenceInput>): CadenceInput => ({
  chats: [],
  drafts: [],
  messages: [],
  people: new Map(),
  goals: [],
  settings: { maxBumps: 2, timezone: 'America/New_York' },
  now: NOW,
  ...extra,
});

const out = (
  personId: string,
  days: number,
  channel: CadenceMessage['channel'] = 'email',
): CadenceMessage => ({
  personId,
  direction: 'out',
  at: ago(days),
  channel,
});
const inn = (personId: string, days: number): CadenceMessage => ({
  personId,
  direction: 'in',
  at: ago(days),
  channel: 'email',
});

describe('cadence (§9.2)', () => {
  it('a first bump is due after the v1 business days, and nothing while on vacation', () => {
    const c = chat('a', { lastOutboundAt: ago(10) });
    const inp = input({ chats: [c], people: new Map([cp('p-a', 10)]), messages: [out('p-a', 10)] });
    const a = cadenceActions(inp);
    expect(a.filter((x) => x.kind === 'bump')).toEqual([
      expect.objectContaining({ chatId: 'a', personId: 'p-a', bumpNumber: 1, draftKind: 'bump' }),
    ]);
    expect(cadenceActions({ ...inp, settings: { ...inp.settings, quietUntil: ago(-5) } })).toEqual([]);
  });

  it('sales, fundraising and hiring cold outreach gets a second bump seven business days after the first', () => {
    const c = chat('s', { lastOutboundAt: ago(10), bumpCount: 1, goalId: 'g1' });
    const base = {
      chats: [c],
      people: new Map([cp('p-s', 10)]),
      messages: [out('p-s', 25), out('p-s', 10)],
    };
    const sales = cadenceActions(input({ ...base, goals: [goal('g1', 'sales')] }));
    expect(sales.find((x) => x.kind === 'bump')).toMatchObject({ bumpNumber: 2, goalId: 'g1' });
    // a tech contact on a recruiting goal gets one bump only (v1 sector cap)
    const recruiting = cadenceActions(input({ ...base, goals: [goal('g1', 'recruiting')] }));
    expect(recruiting.some((x) => x.kind === 'bump')).toBe(false);
    // and not before seven business days
    const early = cadenceActions(
      input({ ...base, chats: [{ ...c, lastOutboundAt: ago(5) }], goals: [goal('g1', 'fundraising')] }),
    );
    expect(early.some((x) => x.kind === 'bump')).toBe(false);
    // someone the student knows is not cold
    const warm = cadenceActions(
      input({ ...base, people: new Map([cp('p-s', 55)]), goals: [goal('g1', 'hiring')] }),
    );
    expect(warm.some((x) => x.kind === 'bump')).toBe(false);
  });

  it('§9.4 test 4: never more than three unanswered messages to one person, across channels', () => {
    // two emails and a LinkedIn message, no answer: no bump on any chat
    const c = chat('x', { lastOutboundAt: ago(12), bumpCount: 1 });
    const messages = [out('p-x', 30), out('p-x', 20, 'linkedin'), out('p-x', 12)];
    expect(unansweredCount('p-x', messages)).toBe(MAX_UNANSWERED);
    const a = cadenceActions(
      input({
        chats: [c, chat('y', { personId: 'p-x', outreachChannel: 'linkedin', lastOutboundAt: ago(20) })],
        people: new Map([cp('p-x', 10)]),
        messages,
        goals: [goal('g', 'sales', ['p-x'])],
      }),
    );
    expect(a.filter((x) => x.kind === 'bump' || x.kind === 'nurture')).toEqual([]);
    // an answer resets the count
    expect(unansweredCount('p-x', [...messages, inn('p-x', 5), out('p-x', 4)])).toBe(1);
    // and an approved draft to them is not sent either
    const draft: CadenceDraft = {
      id: 'd',
      personId: 'p-x',
      kind: 'bump',
      status: 'approved',
      sendAt: ago(0.01),
      createdAt: ago(1),
    };
    expect(
      cadenceActions(input({ drafts: [draft], people: new Map([cp('p-x', 10)]), messages })).some(
        (x) => x.kind === 'send_due',
      ),
    ).toBe(false);
  });

  it('§9.4 test 3: a bump is never sent when an inbound message arrived after it was drafted', () => {
    const draft: CadenceDraft = {
      id: 'd1',
      personId: 'p',
      chatId: 'c',
      kind: 'bump',
      status: 'approved',
      sendAt: ago(0.01),
      createdAt: ago(2),
    };
    const people = new Map([cp('p', 20)]);
    expect(
      cadenceActions(input({ drafts: [draft], people, messages: [out('p', 9)] })).map((x) => x.kind),
    ).toEqual(['send_due']);
    const replied = [out('p', 9), inn('p', 1)];
    expect(cancelIfReplied(draft, replied)).toEqual({ cancel: true, reason: 'replied', at: ago(1) });
    expect(cadenceActions(input({ drafts: [draft], people, messages: replied }))).toEqual([]);
    // a reply from before the draft does not cancel it
    expect(cancelIfReplied(draft, [inn('p', 3)])).toEqual({ cancel: false });
  });

  it('flags went-quiet chats, thank-yous and stage timers with the v1 rules', () => {
    const quiet = chat('q', { lastOutboundAt: ago(8), bumpCount: 2 });
    const met = chat('m', {
      stage: 'completed',
      completedAt: ago(1),
      stageEnteredAt: ago(1),
      lastOutboundAt: ago(5),
    });
    const old = chat('o', { stage: 'followed_up', stageEnteredAt: ago(20), lastOutboundAt: ago(20) });
    const silent = chat('n', { lastOutboundAt: ago(40), bumpCount: 2 });
    const a = cadenceActions(
      input({
        chats: [quiet, met, old, silent],
        people: new Map([cp('p-q', 10), cp('p-m', 50), cp('p-o', 60), cp('p-n', 10)]),
      }),
    );
    expect(a.find((x) => x.kind === 'went_quiet' && x.chatId === 'q')).toBeDefined();
    expect(a.find((x) => x.kind === 'thank_you')).toMatchObject({ chatId: 'm', draftKind: 'thank_you' });
    expect(a.find((x) => x.kind === 'stage_timer' && x.chatId === 'o')).toMatchObject({
      toStage: 'nurturing',
    });
    expect(a.find((x) => x.kind === 'stage_timer' && x.chatId === 'n')).toMatchObject({
      toStage: 'no_response',
    });
    expect(wentQuiet(quiet, NOW)).toBe(true);
    expect(wentQuiet({ ...quiet, lastInboundAt: ago(1) }, NOW)).toBe(false);
  });

  it('nurtures close, strong and goal-linked people with a reason, at most three a week', () => {
    const people = new Map([
      cp('close', 85, { lastContactAt: ago(70), nurtureReason: 'Started a new role at Ramp' }),
      cp('strong', 65, { lastContactAt: ago(100), nurtureReason: 'Posted about their launch' }),
      cp('strong-recent', 65, { lastContactAt: ago(40), nurtureReason: 'Posted' }),
      cp('goal', 30, { lastContactAt: ago(35), nurtureReason: 'Their fund closed' }),
      cp('no-reason', 90, { lastContactAt: ago(200) }),
      cp('weak', 30, { lastContactAt: ago(400), nurtureReason: 'News' }),
      cp('dnc', 90, {
        lastContactAt: ago(200),
        nurtureReason: 'News',
        person: { id: 'dnc', firstName: 'D', doNotContact: true },
      }),
      cp('dormant', 70, { lastContactAt: ago(200), nurtureReason: 'Moved to London' }),
    ]);
    const a = cadenceActions(input({ people, goals: [goal('g', 'fundraising', ['goal'])] }));
    const n = a.filter((x) => x.kind === 'nurture');
    expect(n.map((x) => x.personId)).toEqual(['goal', 'close', 'dormant']);
    expect(n.find((x) => x.personId === 'dormant')!.draftKind).toBe('reengage');
    expect(n.find((x) => x.personId === 'close')!.reason).toBe('Started a new role at Ramp');
    const capped = cadenceActions(
      input({ people, goals: [goal('g', 'fundraising', ['goal'])], recentNurtureAt: [ago(2), ago(3)] }),
    );
    expect(capped.filter((x) => x.kind === 'nurture').map((x) => x.personId)).toEqual(['goal']);
  });

  it('skips weekends and US federal holidays for sends', () => {
    const tz = 'America/New_York';
    expect(isSendDay(new Date('2026-10-14T15:00:00Z'), tz)).toBe(true);
    expect(isSendDay(new Date('2026-10-17T15:00:00Z'), tz)).toBe(false); // Saturday
    expect(isSendDay(new Date('2026-11-26T15:00:00Z'), tz)).toBe(false); // Thanksgiving
    expect(isSendDay(new Date('2026-10-12T15:00:00Z'), tz)).toBe(false); // Columbus Day
    // Saturday → Monday 9:00 New York
    expect(nextSendDay(new Date('2026-10-17T15:00:00Z'), tz).toISOString()).toBe('2026-10-19T13:00:00.000Z');
    const sat = new Date('2026-10-17T15:00:00Z');
    const draft: CadenceDraft = {
      id: 'd',
      personId: 'p',
      kind: 'bump',
      status: 'approved',
      sendAt: '2026-10-17T14:00:00Z',
      createdAt: '2026-10-16T14:00:00Z',
    };
    const inp = input({ now: sat, drafts: [draft], people: new Map([cp('p', 10)]) });
    expect(cadenceActions(inp).some((x) => x.kind === 'send_due')).toBe(false);
    const bump = cadenceActions({
      ...inp,
      drafts: [],
      chats: [chat('w', { personId: 'p', lastOutboundAt: '2026-10-05T14:00:00Z' })],
    });
    expect(bump.find((x) => x.kind === 'bump')!.dueAt).toBe('2026-10-19T13:00:00.000Z');
  });
});
