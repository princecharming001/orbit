/**
 * Plan 37 §5, Auto mode. Forty messages labelled by hand go through the real router on the demo account: lookups, taps,
 * small talk and small changes run Quick; drafts, advice, plans, pasted postings and anything the router cannot name
 * run Smart. A turn after a draft, and a short answer to Orbi's question, run Smart.
 */

import type { User } from '@orbit/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadDemo } from '../../engine/demo';
import { clearPrefs, writePrefs } from '../../integrations/prefs';
import { createChatEngine, lastTurnOf } from '../agent';
import { makeChatClient, setChatClientFactoryForTests } from '../agent/client';
import type { EffortChoice } from '../agent/effort';
import { pickEffort } from '../agent/effort';
import { routeUtterance } from '../agent/router';
import { routerContextFor } from '../agent/routerContext';
import { ChatStore } from '../agent/store';
import { pickMessage, routedText } from '../clarify';
import { execute, registry } from '../registry';
import { messageRequests, scriptedFetch } from '../test/fakeAnthropic';
import type { ChatMessage } from '../types';
import { NOW } from './helpers';

let user: User;
let ctx: Awaited<ReturnType<typeof routerContextFor>>;
beforeAll(async () => {
  user = await loadDemo({ reset: true, now: NOW });
  ctx = await routerContextFor(user.id, NOW);
}, 90_000);

const pick = (text: string, extra: Parameters<typeof pickEffort>[1] = {}) =>
  pickEffort(text, {
    intent: routeUtterance(routedText(text), { registry, ...ctx, firstName: user.firstName }),
    registry,
    ...extra,
  });

const QUICK = [
  'who went quiet',
  'show my pipeline',
  'when is my next chat',
  'what is on today',
  'show my drafts',
  'who do I know at Stripe',
  'tell me about Lena Novak',
  'who is Lena',
  'move Lena to scheduled',
  'add Ramp to my targets',
  'thanks',
  'ok',
  'lol',
  'hey',
  'what are my goals',
  'open the map',
  'who are my alumni',
  'remember I prefer email',
  pickMessage(
    'company',
    'Juniper',
    { id: 'org_juniper-health', label: 'Juniper Health' },
    'who do I know at Juniper',
  ),
  'hide Victor Castro',
];

const SMART = [
  'draft a thank you to Lena',
  'write to Daniel Okafor',
  'should I email Lena again or wait',
  'what do you think about Ramp vs Stripe for me',
  'how do I ask for a referral without being weird',
  'help me prep for my chat with Lena',
  'reply to Lena with some times that work for me',
  "they haven't replied in 2 weeks, what now",
  'bump everyone who has not replied',
  'is it weird to message on LinkedIn and email',
  'do everything you can to help me land Stripe',
  "I'm applying to https://stripe.com/jobs/listing/swe-intern/123",
  'ask Daniel to intro me to someone on his team',
  `Here is the posting: ${'We are hiring a software engineering intern to work on payments infrastructure. '.repeat(5)}`,
  'I got the offer from Stripe, how do I negotiate',
  'why did Lena not answer',
  'make a plan for my week',
  'compare Figma and Notion for a PM internship',
  pickMessage('person', 'Keiko', { id: 'p1', label: 'Keiko Silva' }, 'draft a thank you to Keiko'),
  'what should I say in my follow up',
];

describe('Auto picks Quick for lookups and Smart for thought', () => {
  it.each(QUICK)('Quick: %s', (text) => {
    expect(pick(text), text).toMatchObject({ effort: 'low' });
  });
  it.each(SMART)('Smart: %s', (text) => {
    expect(pick(text), text).toMatchObject({ effort: 'medium' });
  });

  it('a turn after a draft is Smart, and a short answer to a question is too', () => {
    expect(pick('who went quiet', { afterJudgement: true })).toMatchObject({
      effort: 'medium',
      reason: 'after a draft',
    });
    expect(pick('yes', { answeringQuestion: true })).toMatchObject({ effort: 'medium' });
    expect(pick('yes')).toMatchObject({ effort: 'low' });
  });

  it('anything the router cannot name is Smart', () => {
    expect(pick('my cofounder and I disagree about whether to raise')).toMatchObject({ effort: 'medium' });
  });
});

describe('what the last turn did', () => {
  const row = (role: ChatMessage['role'], content: unknown, meta?: ChatMessage['meta']): ChatMessage =>
    ({
      id: Math.random().toString(),
      conversationId: 'c',
      userId: 'u',
      seq: 0,
      role,
      content,
      meta,
      createdAt: '',
    }) as ChatMessage;

  it('reads the turn since the student last said something: a draft tool, and a closing question', () => {
    const rows = [
      row('user', [{ type: 'text', text: 'draft to Lena' }]),
      row('assistant', [{ type: 'tool_use', id: 't1', name: 'create_draft', input: {} }]),
      row('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      row('assistant', [{ type: 'text', text: 'Drafted it. Want it shorter?' }]),
    ];
    expect(lastTurnOf(rows)).toEqual({ afterJudgement: true, answeringQuestion: true });
    expect(
      lastTurnOf([
        ...rows,
        row('user', [{ type: 'text', text: 'no' }]),
        row('assistant', [{ type: 'text', text: 'Ok.' }]),
      ]),
    ).toEqual({ afterJudgement: false, answeringQuestion: false });
    expect(lastTurnOf([])).toEqual({ afterJudgement: false, answeringQuestion: false });
  });
});

describe('the engine in Auto', () => {
  afterEach(async () => {
    setChatClientFactoryForTests(undefined);
    await clearPrefs();
  });

  it('sends each turn at the level Auto picks, as a per-message change, and says what it picked', async () => {
    const fake = scriptedFetch();
    setChatClientFactoryForTests((key) => makeChatClient(key, { fetch: fake.fetch, maxRetries: 0 }));
    writePrefs({ anthropicApiKey: 'sk-ant-test' });
    const picks: EffortChoice[] = [];
    const engine = createChatEngine({
      registry,
      execute,
      user: () => user,
      store: new ChatStore(),
      now: () => NOW,
      chatMode: () => 'auto',
      onEffort: (c) => picks.push(c),
    });
    const c = await engine.startConversation({ temporary: false });
    fake.push({ text: 'Nobody went quiet.' });
    await engine.send(c.id, 'who went quiet', () => {});
    fake.push({ text: 'Here is a start.' });
    await engine.send(c.id, 'should I email Lena again or wait', () => {});
    expect(picks.map((p) => p.effort)).toEqual(['low', 'medium']);
    const levels = messageRequests(fake).map((r) =>
      r.body.messages
        .filter(
          (m: { role: string; output_config?: { effort: string } }) => m.role === 'system' && m.output_config,
        )
        .map((m: { output_config: { effort: string } }) => m.output_config.effort),
    );
    expect(levels).toEqual([['low'], ['low', 'medium']]);
    for (const r of messageRequests(fake)) expect(r.body.output_config).toEqual({ effort: 'medium' });
  });

  it('Smart and Quick pin the level whatever the message says', async () => {
    const fake = scriptedFetch();
    setChatClientFactoryForTests((key) => makeChatClient(key, { fetch: fake.fetch, maxRetries: 0 }));
    writePrefs({ anthropicApiKey: 'sk-ant-test' });
    for (const [mode, want] of [
      ['smart', []],
      ['quick', ['low']],
    ] as const) {
      const engine = createChatEngine({
        registry,
        execute,
        user: () => user,
        store: new ChatStore(),
        now: () => NOW,
        chatMode: () => mode,
      });
      const c = await engine.startConversation({ temporary: false });
      fake.push({ text: 'ok' });
      await engine.send(c.id, mode === 'smart' ? 'who went quiet' : 'should I email Lena again', () => {});
      const body = messageRequests(fake).at(-1)!.body;
      expect(
        body.messages
          .filter(
            (m: { role: string; output_config?: { effort: string } }) =>
              m.role === 'system' && m.output_config,
          )
          .map((m: { output_config: { effort: string } }) => m.output_config.effort),
      ).toEqual(want);
    }
  });
});
