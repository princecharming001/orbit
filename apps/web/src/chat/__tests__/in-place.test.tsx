/**
 * Plan 37 §4, a button is the action. "Add Stripe to targets" on a company card runs where it is: the target is added,
 * the chip says so, the thread gets no new turn, a reload shows it done, and the next message tells the model so it
 * never offers the step again. Adding picked people and showing a hidden person act the same way.
 */
import type { User } from '@orbit/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/schema';
import { loadDemo } from '../../engine/demo';
import { clearPrefs, writePrefs } from '../../integrations/prefs';
import { createChatEngine } from '../agent';
import { makeChatClient, setChatClientFactoryForTests } from '../agent/client';
import { ChatStore } from '../agent/store';
import { execute, registry } from '../registry';
import { type FakeAnthropic, messageRequests, scriptedFetch } from '../test/fakeAnthropic';
import { type ResultEnvelope, type StepRun, tapActionId } from '../types';
import {
  addPicked,
  addTarget,
  afterStage,
  askForIntro,
  introTo,
  prepFor,
  routesToEach,
  warmUpFirst,
  writeNow,
  writeTo,
  writeToEach,
} from '../ui/cards/next';
import type { NextStep } from '../ui/cards/parts';
import { ResultCard } from '../ui/cards/ResultCard';
import { cardSteps } from '../ui/cards/steps';
import { hydrate, type ToolBlock } from '../ui/threadStore';
import { makeCtx, NOW } from './helpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let user: User;
beforeAll(async () => {
  user = await loadDemo({ reset: true, now: NOW });
  await clearPrefs();
}, 90_000);

describe('the steps that act in place', () => {
  it('name a real tool with an input it accepts, and still say the same request in words', () => {
    const steps: NextStep[] = [
      addTarget('Stripe'),
      addPicked([{ name: 'Dana Lee', rec: 'li:1' }, { name: 'Kai Ito' }])!,
      ...cardSteps('get_person', {
        kind: 'person',
        data: { person: { id: 'p1', displayName: 'Maya Chen', hiddenAt: '2026-01-01' } },
        summary: 'Hid Maya Chen.',
      }),
    ];
    for (const s of steps) {
      expect(s.run, s.label).toBeDefined();
      const spec = registry.get(s.run!.tool);
      expect(spec, s.run!.tool).toBeDefined();
      expect(spec!.input.safeParse(s.run!.input).success, s.label).toBe(true);
      expect(s.message.length).toBeGreaterThan(5);
    }
    expect(addPicked([{ name: 'Dana Lee', rec: 'li:1' }, { name: 'Kai Ito' }])!.run!.input).toEqual({
      recommendationIds: ['li:1'],
    });
    // adding and then writing or routing opens beside the chat (plan 42); a mix the card cannot name by id is a turn
    expect(addPicked([{ name: 'Dana Lee', rec: 'li:1' }], 'drafts')!.run).toMatchObject({
      tool: 'add_sourced',
      input: { recommendationIds: ['li:1'], next: 'drafts' },
      show: 'panel',
    });
    expect(
      addPicked([{ name: 'Dana Lee', rec: 'li:1' }, { name: 'Kai Ito' }], 'routes')!.run,
    ).toBeUndefined();
  });

  it('every step that opens beside the chat names a real tool with an input it accepts (plan 42)', () => {
    const panel: NextStep[] = [
      writeTo('Zain Kundi', undefined, 'p_zain'),
      writeTo('Zain Kundi', 'thank_you', 'p_zain'),
      writeToEach(['Zain Kundi', 'Vyom K'], 'bump', ['p_zain', 'p_vyom'])!,
      routesToEach(['Zain Kundi'], ['p_zain'])!,
      routesToEach(['Zain Kundi', 'Vyom K'], ['p_zain', 'p_vyom'])!,
      introTo('Zain Kundi', 'p_zain'),
      askForIntro('Arnav Goel', 'Zain Kundi', 'p_arnav', 'p_zain'),
      warmUpFirst('Zain Kundi', 'p_zain'),
      writeNow('Zain Kundi', 'p_zain'),
      addPicked([{ name: 'Dana Lee', rec: 'li:1' }], 'routes')!,
      addPicked(
        [
          { name: 'Dana Lee', id: 'p_dana' },
          { name: 'Kai Ito', id: 'p_kai' },
        ],
        'drafts',
      )!,
      afterStage('Zain Kundi', 'completed', 'p_zain')!,
    ];
    for (const s of panel) {
      expect(s.run?.show, s.label).toBe('panel');
      const spec = registry.get(s.run!.tool);
      expect(spec, s.run!.tool).toBeDefined();
      expect(spec!.input.safeParse(s.run!.input).success, `${s.label}: ${JSON.stringify(s.run!.input)}`).toBe(
        true,
      );
      // the same request in words stays, for "do it" and the no-key router
      expect(s.message.length).toBeGreaterThan(5);
      expect(s.run!.done).not.toMatch(/[—–!]/);
    }
    // prep is a page: the person's prep deck beside the chat, no tool
    expect(prepFor('Zain Kundi', 'p_zain')).toMatchObject({ open: '/people/p_zain?prep=1' });
    expect(prepFor('Zain Kundi', 'p_zain').run).toBeUndefined();
    // by name alone a step stays the message, as before
    for (const s of [
      writeTo('Zain Kundi'),
      introTo('Zain Kundi'),
      askForIntro('Arnav Goel', 'Zain Kundi'),
      prepFor('Zain'),
    ])
      expect(s.run ?? s.open).toBeUndefined();
  });

  it('a different input on the same card is another tap', () => {
    const run = (ids: string[]): { label: string; run: StepRun } => ({
      label: 'Add to People',
      run: { tool: 'add_sourced', input: { recommendationIds: ids }, done: 'Added to People' },
    });
    expect(tapActionId('toolu_1', run(['a']))).not.toBe(tapActionId('toolu_1', run(['b'])));
    expect(tapActionId('toolu_1', run(['a']))).toBe(tapActionId('toolu_1', run(['a'])));
  });
});

describe('Add to targets on a company card', () => {
  let host: HTMLDivElement;
  let root: Root | undefined;
  afterEach(async () => {
    if (root) act(() => root!.unmount());
    root = undefined;
    host?.remove();
    await db.targetCompanies
      .where('userId')
      .equals(user.id)
      .filter((t) => t.nameRaw === 'Juniper Health')
      .delete();
  });

  async function render(
    block: ToolBlock,
    runStep: (origin: string, step: { label: string; run: StepRun }) => Promise<ResultEnvelope>,
    sent: string[],
  ) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <MemoryRouter>
          <ResultCard
            block={block}
            actions={{
              approve: async () => undefined,
              cancel: async () => {},
              send: (t) => {
                sent.push(t);
              },
              runStep,
            }}
          />
        </MemoryRouter>,
      );
    });
  }

  it('adds the target in place: no message, the button and the chip say it is done, and a reload agrees', async () => {
    const engine = createChatEngine({
      registry,
      execute,
      user: () => user,
      store: new ChatStore(),
      now: () => NOW,
    });
    const c = await engine.startConversation({ temporary: false });
    const env = await execute(
      'find_routes',
      { company: 'Juniper Health' },
      makeCtx(user, { conversationId: c.id }),
    );
    expect(env.kind).toBe('company');
    const block: ToolBlock = {
      type: 'tool',
      toolUseId: 'toolu_jh',
      toolName: 'find_routes',
      envelope: env,
      status: 'done',
    };
    const sent: string[] = [];
    const runs: string[] = [];
    await render(
      block,
      (origin, step) => {
        runs.push(step.label);
        return engine.runStep(c.id, origin, step);
      },
      sent,
    );
    const button = [...host.querySelectorAll<HTMLElement>('[data-testid="next-step"]')].find((b) =>
      /Add Juniper Health to targets/.test(b.textContent ?? ''),
    )!;
    expect(button.dataset.state).toBe('ready');
    await act(async () => button.click());
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="next-step"][data-state="done"]')).not.toBeNull(),
    );
    expect(runs).toEqual(['Add Juniper Health to targets']);
    expect(sent).toEqual([]);
    const targets = await db.targetCompanies.where('userId').equals(user.id).toArray();
    expect(targets.some((t) => t.nameRaw === 'Juniper Health')).toBe(true);
    const done = host.querySelector<HTMLElement>('[data-testid="next-step"][data-state="done"]');
    expect(done?.textContent).toBe('Added to targets');
    expect(host.textContent).toMatch(/Target/);
    // nothing was said in the conversation; the tap is one action row under the card
    expect(await new ChatStore().messages(c.id)).toEqual([]);
    const rows = await new ChatStore().actions(c.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      toolName: 'manage_target_company',
      status: 'done',
      origin: { toolUseId: 'toolu_jh', label: 'Add Juniper Health to targets' },
    });
    // a reload: the same card from scratch shows it done, and hydrating the chat adds no turn
    act(() => root!.unmount());
    host.remove();
    await render(block, async () => ({ kind: 'error', data: undefined, summary: 'never' }), sent);
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="next-step"][data-state="done"]')).not.toBeNull(),
    );
    expect(host.querySelector<HTMLElement>('[data-testid="next-step"][data-state="done"]')?.textContent).toBe(
      'Added to targets',
    );
    expect(hydrate([], rows)).toEqual([]);
  });

  it('a failure says so in place and can be tapped again', async () => {
    const env = await execute('find_routes', { company: 'Juniper Health' }, makeCtx(user));
    const block: ToolBlock = {
      type: 'tool',
      toolUseId: 'toolu_fail',
      toolName: 'find_routes',
      envelope: env,
      status: 'done',
    };
    let calls = 0;
    await render(block, async () => {
      calls++;
      return { kind: 'error', data: undefined, summary: 'Could not add it.' };
    }, []);
    const button = () =>
      [...host.querySelectorAll<HTMLElement>('[data-testid="next-step"]')].find((b) =>
        /Add Juniper Health to targets/.test(b.textContent ?? ''),
      )!;
    await act(async () => button().click());
    await vi.waitFor(() => expect(host.querySelector('[data-testid="next-step-error"]')).not.toBeNull());
    expect(host.querySelector('[data-testid="next-step-error"]')?.textContent).toBe('Could not add it.');
    expect(button().dataset.state).toBe('failed');
    await act(async () => button().click());
    expect(calls).toBe(2);
  });
});

describe('the model hears about taps once', () => {
  let fake: FakeAnthropic;
  afterEach(async () => {
    setChatClientFactoryForTests(undefined);
    await clearPrefs();
    await db.targetCompanies
      .where('userId')
      .equals(user.id)
      .filter((t) => t.nameRaw === 'Figma Labs')
      .delete();
  });

  it('the next message carries an Orbit note after the words, the bubble does not show it, and it is said once', async () => {
    fake = scriptedFetch();
    setChatClientFactoryForTests((key) => makeChatClient(key, { fetch: fake.fetch, maxRetries: 0 }));
    writePrefs({ anthropicApiKey: 'sk-ant-test' });
    const store = new ChatStore();
    const engine = createChatEngine({ registry, execute, user: () => user, store, now: () => NOW });
    const c = await engine.startConversation({ temporary: false });
    await engine.runStep(c.id, 'toolu_card', addTarget('Figma Labs') as { label: string; run: StepRun });
    fake.push({ text: 'Nice, Figma Labs is on your list.' });
    await engine.send(c.id, 'what next', () => {});
    const sentTo = messageRequests(fake).at(-1)!.body.messages.at(-1) ?? {};
    const user0 = messageRequests(fake)
      .at(-1)!
      .body.messages.filter((m: { role: string }) => m.role === 'user')
      .at(-1) as { content: { type: string; text: string }[] };
    expect(user0.content[0]!.text).toBe('what next');
    expect(user0.content[1]!.text).toMatch(
      /^\[Orbit\] Since your last reply the student tapped, in cards: Add Figma Labs to targets/,
    );
    expect(sentTo).toBeDefined();
    // the reopened chat shows the student's words only
    const turns = hydrate(await store.messages(c.id), await store.actions(c.id));
    expect(turns.find((t) => t.role === 'user')).toMatchObject({ text: 'what next' });
    // told once
    fake.push({ text: 'Sure.' });
    await engine.send(c.id, 'and then', () => {});
    const last = messageRequests(fake)
      .at(-1)!
      .body.messages.filter((m: { role: string }) => m.role === 'user')
      .at(-1) as { content: { type: string; text: string }[] };
    expect(last.content).toHaveLength(1);
  });
});
