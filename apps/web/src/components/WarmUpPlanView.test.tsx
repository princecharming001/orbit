import {
  buildWarmUpPlan,
  type CoffeeChat,
  type Person,
  planFromRun,
  type User,
  type WarmUpPlan,
  type WarmUpRun,
} from '@orbit/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setCurrentUserId } from '../db/repo';
import { db, wipeDatabase } from '../db/schema';
import { refreshSyncStatus } from '../engine/serverSync';
import { SessionProvider } from '../state/session';
import { closeWarmUpPlan, openWarmUpPlan } from '../state/warmUpPlan';
import { closeWarmUpSheet } from '../state/warmUpSheet';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import type { FakeOrbitApi } from '../test/fakeOrbitApi';
import { ToastProvider } from '../ui';
import { planWhen, WarmUpPlanSheet, warmUpPlanRows } from './WarmUpPlanView';
import { WarmUpStartSheet } from './WarmUpStartSheet';

/**
 * The plan of a warm-up, opened from wherever the warm-up is listed: every step with its day and time in the
 * student's time zone, who does it, the post, the comment or that it is not written yet, and last the connection
 * request and first message, which wait for the student's Send.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = '2026-11-16T15:00:00.000Z';
const P = '7a1d2c3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d';
const C = 'c-warm-1';
const TZ = 'America/New_York';
const COMMENT = 'Did the week one rule hold once the team passed twenty people?';
const EXCERPT = 'New analysts should ship something real in their first week.';
const BANNED = /[–—!]/;
const DAY = 86_400_000;

let api: FakeOrbitApi;
let user: User;
let unmount: (() => void) | undefined;

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};
const until = async (fn: () => boolean, what: string) => {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await settle(1);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const q = (id: string, root: ParentNode = document.body) =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (el: HTMLElement | null) => {
  if (!el) throw new Error('nothing to click');
  await act(async () => el.click());
  await settle();
};
const step = (kind: string) => q(`warmup-plan-step-${kind}`);
const stepTexts = () =>
  [...document.body.querySelectorAll('[data-testid="warmup-plan-step-text"]')].map((e) => e.textContent);

async function putChat(warmUp: WarmUpPlan, extra: Partial<CoffeeChat> = {}) {
  await db.chats.put({
    id: C,
    userId: user.id,
    personId: P,
    stage: 'warming',
    stageEnteredAt: warmUp.startedAt,
    source: 'manual',
    goalTags: [],
    outreachChannel: 'linkedin',
    bumpCount: 0,
    priority: 2,
    warmUp,
    createdAt: warmUp.startedAt,
    updatedAt: warmUp.startedAt,
    ...extra,
  } as CoffeeChat);
}

/** A run Orbit has under way: the profile view done yesterday, the like and the comment still to come. */
function runningRun(comment: string | null, withComment = true): WarmUpRun {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    id: 'run-1',
    userId: user.id,
    personId: P,
    status: 'running',
    post: {
      url: 'https://www.linkedin.com/feed/update/urn:li:activity:1/',
      excerpt: EXCERPT,
      topic: 'first weeks',
    },
    comment,
    steps: [
      {
        id: 's1',
        seq: 1,
        kind: 'view_profile',
        dueAt: iso(now - DAY),
        status: 'done',
        attempts: 1,
        ranAt: iso(now - DAY),
      },
      { id: 's2', seq: 2, kind: 'react_post', dueAt: iso(now + 2 * DAY), status: 'pending', attempts: 0 },
      ...(withComment
        ? [
            {
              id: 's3',
              seq: 3,
              kind: 'comment_post' as const,
              dueAt: iso(now + 3 * DAY),
              status: 'pending' as const,
              attempts: 0,
            },
          ]
        : []),
    ],
    startedAt: iso(now - DAY),
    readyAt: iso(now + 4 * DAY),
  };
}

async function mount() {
  await setCurrentUserId(user.id);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  unmount = () => {
    act(() => root.unmount());
    host.remove();
  };
  await act(async () =>
    root.render(
      <MemoryRouter>
        <SessionProvider>
          <ToastProvider>
            <WarmUpPlanSheet />
            <WarmUpStartSheet />
          </ToastProvider>
        </SessionProvider>
      </MemoryRouter>,
    ),
  );
  await settle();
}

async function openPlan() {
  await mount();
  await act(async () => openWarmUpPlan({ chatId: C }));
  await until(() => !!q('warmup-plan-view'), 'the plan');
}

beforeEach(async () => {
  await wipeDatabase();
  const signedIn = await signInToFakeApi();
  api = signedIn.api;
  await db.users.update(signedIn.user.id, { onboardingCompletedAt: AT, timezone: TZ });
  user = (await db.users.get(signedIn.user.id))!;
  api.state.linkedin.status = 'active';
  api.state.status.marks = { changed: 'm0', linkedin: 'l0', autopilot: 'a0' };
  await refreshSyncStatus();
  await db.people.put({
    id: P,
    userId: user.id,
    displayName: 'Priya Rao',
    firstName: 'Priya',
    lastName: 'Rao',
    nameNormalized: 'priya rao',
    emails: [],
    linkedinSlug: 'priya-rao',
    relationshipType: 'unknown',
    strength: 0.05,
    interactionCount: 0,
    sources: ['linkedin_csv'],
    isHuman: true,
    tags: [],
    createdAt: AT,
    updatedAt: AT,
  } as Person);
});
afterEach(async () => {
  await act(async () => {
    closeWarmUpPlan();
    closeWarmUpSheet();
  });
  unmount?.();
  unmount = undefined;
  document.body.innerHTML = '';
  await leaveFakeApi();
});

describe('the warm-up plan', () => {
  it('a warm-up Orbit runs: each step with its time, the post, the approved comment, and the message last', async () => {
    await putChat(planFromRun(runningRun(COMMENT), 'priya-rao'));
    await openPlan();
    expect(q('warmup-plan-status')?.textContent).toBe('Orbit is running it');
    expect(stepTexts()).toEqual([
      "Orbit views Priya's profile",
      "Orbit likes Priya's post",
      'Orbit comments on that post',
      'Your connection request and first message are ready for you to send',
    ]);
    expect(step('view_profile')?.dataset.status).toBe('done');
    expect(q('warmup-plan-step-status', step('view_profile')!)?.textContent).toBe('Done');
    expect(step('react_post')?.dataset.status).toBe('upcoming');
    expect(step('react_post')?.dataset.who).toBe('orbit');
    // the post the like and the comment go on, with a link to it
    const post = q('warmup-plan-post', step('react_post')!);
    expect(post?.textContent).toContain(EXCERPT);
    expect(post?.querySelector('a')?.getAttribute('href')).toContain('linkedin.com/feed/update');
    // the comment, exactly as approved
    expect(q('warmup-plan-comment', step('comment_post')!)?.textContent).toContain(COMMENT);
    // the last step is the student's: nothing goes out on its own
    const msg = step('message')!;
    expect(msg.dataset.who).toBe('you');
    expect(msg.textContent).toContain('Nothing goes out until you press Send.');
    // every step has a time of day in the student's time zone
    for (const w of document.body.querySelectorAll('[data-testid="warmup-plan-when"]'))
      expect(w.textContent).toMatch(/, \d{1,2}:\d{2} (AM|PM)$/);
    expect(q('warmup-plan-stop')).not.toBeNull();
    expect(q('warmup-plan-hand-over')).toBeNull();
    expect(q('warmup-plan-profile')?.getAttribute('href')).toBe(`/people/${P}`);
    expect(q('warmup-plan-person')?.textContent).toBe('Priya Rao');
    expect(q('warmup-plan-view')?.textContent).not.toMatch(BANNED);
  });

  it("a warm-up done by hand: the steps are the student's, the comment is not written yet, and Orbit can take over", async () => {
    await putChat(buildWarmUpPlan('priya-rao', new Date(Date.now() - 60_000), 4, TZ));
    await openPlan();
    expect(q('warmup-plan-status')?.textContent).toBe('By hand');
    expect(stepTexts()[0]).toContain("You look at Priya's profile and what they post about");
    expect(stepTexts()[1]).toContain("You react to one of Priya's recent posts");
    expect(stepTexts()[2]).toContain('You comment on that post');
    expect(step('view_profile')?.dataset.status).toBe('today');
    expect(step('comment_post')?.dataset.status).toBe('upcoming');
    // each step the student does links to LinkedIn
    expect(step('view_profile')?.querySelector('a')?.getAttribute('href')).toContain(
      'linkedin.com/in/priya-rao',
    );
    const none = q('warmup-plan-comment', step('comment_post')!);
    expect(q('warmup-plan-comment-none', none!)?.textContent).toBe('Comment not written yet.');
    expect(none?.textContent).toContain('you post it yourself');
    expect(step('message')?.textContent).toContain(
      'Your connection request and first message are ready for you to send',
    );
    expect(q('warmup-plan-view')?.textContent).not.toMatch(BANNED);
    // Orbit can run warm-ups for this student: "Let Orbit run it" hands over to the start sheet
    await until(() => !!q('warmup-plan-hand-over'), 'Let Orbit run it');
    expect(q('warmup-plan-stop')).not.toBeNull();
    await click(q('warmup-plan-hand-over'));
    expect(q('warmup-plan-view')).toBeNull();
    await until(() => !!q('warmup-sheet-loading') || !!q('warmup-sheet'), 'the start sheet');
  });

  it('a comment step with no words yet says so, and a run with the comment left out has no comment step', async () => {
    const plan = planFromRun(runningRun(null), 'priya-rao');
    // a comment step whose words are not there yet
    delete plan.auto!.comment;
    await putChat(plan);
    await openPlan();
    const none = q('warmup-plan-comment', step('comment_post')!);
    expect(q('warmup-plan-comment-none', none!)?.textContent).toBe('Comment not written yet.');
    expect(none?.textContent).toContain('Orbit shows it to you before anything is posted.');
    expect(q('warmup-plan-view')?.textContent).not.toMatch(BANNED);

    const rows = warmUpPlanRows({
      chat: { stage: 'warming', warmUp: planFromRun(runningRun(null, false), 'priya-rao') },
      person: { firstName: 'Priya', displayName: 'Priya Rao', linkedinConnectedOn: '2025-01-02' },
      now: new Date(),
      tz: TZ,
    });
    expect(rows.map((r) => r.kind)).toEqual(['view_profile', 'react_post', 'message']);
    // already connected: only the first message is left to send
    expect(rows.at(-1)?.text).toBe('Your first message is ready for you to send');
  });

  it("says the day and the time in the student's time zone", () => {
    const now = new Date('2026-11-17T14:00:00Z'); // Tuesday 9:00 in New York
    expect(planWhen('2026-11-17T15:00:00Z', now, TZ)).toBe('Today, 10:00 AM');
    expect(planWhen('2026-11-18T15:00:00Z', now, TZ)).toBe('Tomorrow, 10:00 AM');
    expect(planWhen('2026-11-20T15:00:00Z', now, TZ)).toBe('Friday, 10:00 AM');
    expect(planWhen('2026-11-16T15:20:00Z', now, TZ)).toBe('Mon, Nov 16, 10:20 AM');
    expect(planWhen('2026-11-17T15:00:00Z', now, 'Europe/London')).toBe('Today, 3:00 PM');
  });
});
