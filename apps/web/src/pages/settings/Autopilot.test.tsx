/**
 * Settings, Autopilot (plan 29 §B1, §B5) and Tomorrow's batch with first messages, against the fake orbit-api: the
 * three modes with the rules printed under Autopilot, the rungs with their counts, a goal's "Run on autopilot" switch,
 * Stop everything, and in the batch the first messages that wait for a tap, the rung line, and an ask to a friend.
 * No dash and no exclamation mark anywhere on either.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TomorrowBatch } from '../../components/autopilot/TomorrowBatch';
import { useAutopilotStatus } from '../../components/autopilot/useAutopilotStatus';
import { setCurrentUserId } from '../../db/repo';
import { db, wipeDatabase } from '../../db/schema';
import { SessionProvider, useSession } from '../../state/session';
import { leaveFakeApi, signInToFakeApi } from '../../test/account';
import { type FakeOrbitApi, withReplies } from '../../test/fakeOrbitApi';
import { ToastProvider } from '../../ui';
import { AutopilotSection } from './Autopilot';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};
const until = async (fn: () => boolean, what: string) => {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await settle(1);
  }
  throw new Error(`timed out waiting for ${what}`);
};

let api: FakeOrbitApi;
let host: HTMLDivElement;
let unmount: () => void;
let userId: string;

function Batch() {
  const { user } = useSession();
  const view = useAutopilotStatus(user);
  return <TomorrowBatch view={view} />;
}

async function mount(what: 'page' | 'batch') {
  host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/settings/autopilot']}>
        <SessionProvider>
          <ToastProvider>{what === 'page' ? <AutopilotSection /> : <Batch />}</ToastProvider>
        </SessionProvider>
      </MemoryRouter>,
    ),
  );
  unmount = () => {
    act(() => root.unmount());
    host.remove();
  };
}

beforeEach(async () => {
  await wipeDatabase();
  const signedIn = await signInToFakeApi();
  api = signedIn.api;
  userId = signedIn.user.id;
  withReplies(api, { id: userId, firstName: 'Maya' });
  await setCurrentUserId(userId);
  await db.userGoals.put({ ...api.state.goals[0]!, userId });
});
afterEach(async () => {
  unmount();
  await leaveFakeApi();
});

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const calls = (route: string) => api.calls.filter((c) => c.route === route);

describe('Settings, Autopilot', () => {
  it('prints the three modes with the rules under Autopilot and the rungs as they stand', async () => {
    await mount('page');
    await until(() => !!q('autopilot-rung-first_touch'), 'the rungs');
    expect(q('autopilot-mode-off')!.textContent).toContain('Orbit writes, you send.');
    expect(q('autopilot-mode-assist')!.textContent).toContain('Tuesday to Thursday morning');
    expect(q('autopilot-mode-autopilot')!.getAttribute('aria-checked')).toBe('true');
    const rules = q('autopilot-rules')!.textContent!;
    for (const r of [
      'Email only, never LinkedIn.',
      "Only to alumni, people you know (closeness 40 or more) or a friend's contact.",
      'At most 5 sends a day on its own, 12 first messages a week.',
      'Only companies on your goals.',
      'Stops and tells you at the first decline, unsubscribe or pushback.',
      'Every message appears under Sent for you with a minute to undo, and in your morning brief.',
      'Pause is one tap, here and in the chat.',
    ])
      expect(rules).toContain(r);
    expect(q('autopilot-rung-first_touch')!.textContent).toContain('14 of 20');
    expect(q('autopilot-rung-bump')!.textContent).toContain('Bumps');
    expect(host.textContent).not.toMatch(/[!–—]/);
    // an account sends from the server: no local-mode line
    expect(q('autopilot-local-note')).toBeNull();
  });

  it('a mode is one tap, the goal switch writes the goal level, and Stop everything pauses it all', async () => {
    await mount('page');
    await until(() => !!q('autopilot-mode-assist'), 'the modes');
    await act(async () => (q('autopilot-mode-assist') as HTMLButtonElement).click());
    await until(() => calls('/autopilot/mode').length === 1, 'the mode');
    expect(calls('/autopilot/mode')[0]!.body).toEqual({ mode: 'assist' });

    const goal = api.state.goals[0]!;
    await until(() => !!q(`goal-autopilot-${goal.id}`), 'the goal row');
    const sw = q(`goal-autopilot-${goal.id}`)!.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => sw.click());
    await until(() => calls('/autopilot/mode').length === 2, 'the goal mode');
    expect(calls('/autopilot/mode')[1]!.body).toEqual({ mode: 'autopilot', goalId: goal.id });
    expect((await db.userGoals.get(goal.id))!.autonomyLevel).toBe(2);

    await until(() => !(q('autopilot-stop') as HTMLButtonElement | null)?.disabled, 'the page to settle');
    await act(async () => (q('autopilot-stop') as HTMLButtonElement).click());
    await until(() => calls('/autopilot/pause').length === 1, 'the stop');
    expect(Date.parse(String(calls('/autopilot/pause')[0]!.body.until))).toBeGreaterThan(
      Date.now() + 300 * 86_400_000,
    );
    expect(api.state.autopilot.queued).toEqual([]);
    await until(() => q('autopilot-pause-state')!.textContent!.includes('Stopped'), 'the stopped line');
  });
});

describe("Tomorrow's batch with first messages", () => {
  it('a first message before the rung waits for a tap; the tap sends it in the morning as the student', async () => {
    await mount('batch');
    await until(() => host.querySelectorAll('[data-testid="batch-item"]').length === 2, 'the batch');
    expect(host.querySelectorAll('[data-testid="batch-needs-tap"]')).toHaveLength(2);
    expect(q('batch-rung')!.textContent).toBe(
      '14 of 20 first messages approved unchanged. Until 6 more go out as Orbit wrote them, each first message in the evening batch waits for your tap.',
    );
    const grace = [...host.querySelectorAll('[data-testid="batch-item"]')].find((x) =>
      x.textContent!.includes('Grace Liu'),
    )!;
    await act(async () => grace.querySelector<HTMLButtonElement>('[data-testid="batch-tap"]')!.click());
    await until(() => calls('/drafts/approve').length === 1, 'the tap');
    expect(calls('/drafts/approve')[0]!.body).toEqual({
      draftId: 'draft_ap_grace',
      sendAt: '2026-10-07T12:40:00.000Z',
    });
    await until(() => host.querySelectorAll('[data-testid="batch-needs-tap"]').length === 1, 'one tapped');
    expect(host.textContent).not.toMatch(/[!–—]/);
  });

  it('an ask to a friend the plan drafted goes to the friend, or is set aside with Not now', async () => {
    api.state.autopilot.friendAsks = [
      {
        id: '9b1c4d2e-0000-4000-8000-000000000001',
        friendUserId: 'u_ana',
        friendName: 'Ana Okafor',
        targetPersonId: 'ana_p_dan',
        targetName: 'Dan Lee',
        company: 'Stripe',
        note: "I'm Maya, a Cornell junior working toward PM internships.",
        goalId: null,
      },
    ];
    await mount('batch');
    await until(() => !!q('batch-ask'), 'the ask');
    expect(q('batch-ask')!.textContent).toContain('Ana Okafor knows Dan Lee at Stripe');
    expect(q('batch-asks')!.textContent).toContain('the ask goes to the friend, never to them');
    await act(async () => (q('batch-ask-skip') as HTMLButtonElement).click());
    await until(() => calls('/autopilot/dismiss').length === 1, 'the dismiss');
    await until(() => !q('batch-ask'), 'the ask to go');
    // nothing was drafted or sent to Dan
    expect(calls('/drafts/compose')).toEqual([]);
  });
});
