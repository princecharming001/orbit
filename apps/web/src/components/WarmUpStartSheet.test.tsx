import type { Person, User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setCurrentUserId } from '../db/repo';
import { db, wipeDatabase } from '../db/schema';
import { pullNow, refreshSyncStatus } from '../engine/serverSync';
import { SessionProvider } from '../state/session';
import { closeWarmUpSheet, openWarmUpSheet } from '../state/warmUpSheet';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import { advanceWarmup, type FakeOrbitApi } from '../test/fakeOrbitApi';
import { ToastProvider } from '../ui';
import { WarmUpCard } from './WarmUpCard';
import { WarmUpStartSheet } from './WarmUpStartSheet';
import { WarmUpWatch } from './WarmUpWatch';

/**
 * The start sheet of an automated warm-up, the progress on the person's page, Stop, and the done state, in a browser
 * signed in to the fake orbit-api with LinkedIn connected. What matters most: the comment that reaches the server is
 * the text in the box when Start was pressed, and nothing is sent before it.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = '2026-11-16T15:00:00.000Z';
const P = '7a1d2c3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d';
const DRAFTED = 'Did the week one rule hold once the team passed twenty people?';
const BANNED = /[–—!]/;

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
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (el: HTMLElement | null) => {
  if (!el) throw new Error('nothing to click');
  await act(async () => el.click());
  await settle();
};
const type = async (el: HTMLTextAreaElement, v: string) => {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

/** The person's warm-up card, as their page shows it. */
function PersonCard() {
  const data = useLiveQuery(async () => {
    const [u, p, c] = await Promise.all([
      db.users.get(user.id),
      db.people.get(P),
      db.chats.where('personId').equals(P).first(),
    ]);
    return { u, p, c };
  }, []);
  if (!data?.u || !data.p || !data.c?.warmUp) return null;
  return <WarmUpCard user={data.u} person={data.p} chat={data.c} />;
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
            <WarmUpWatch />
            <WarmUpStartSheet />
            <PersonCard />
          </ToastProvider>
        </SessionProvider>
      </MemoryRouter>,
    ),
  );
  await settle();
}

beforeEach(async () => {
  await wipeDatabase();
  const signedIn = await signInToFakeApi();
  api = signedIn.api;
  await db.users.update(signedIn.user.id, { onboardingCompletedAt: AT, timezone: 'America/New_York' });
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
  await act(async () => closeWarmUpSheet());
  unmount?.();
  unmount = undefined;
  document.body.innerHTML = '';
  await leaveFakeApi();
});

async function openSheet() {
  await mount();
  await act(async () => openWarmUpSheet({ personId: P, source: 'manual' }));
  await until(() => !!q('warmup-sheet') || !!q('warmup-sheet-refused'), 'the sheet');
}
const planText = () => [...(q('warmup-plan')?.querySelectorAll('li') ?? [])].map((li) => li.textContent);
const starts = () => api.calls.filter((c) => c.route === '/warmups/start');

describe('the start sheet', () => {
  it('says the whole plan in plain words, with the drafted comment in a box, and sends nothing yet', async () => {
    await openSheet();
    const lines = planText();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      /^(Today|Tomorrow|Monday|Tuesday|Wednesday|Thursday|Friday): view Priya's profile\.$/,
    );
    expect(lines[1]).toMatch(
      /: like their post: "New analysts should ship something real in their first week\."$/,
    );
    expect(lines[2]).toMatch(/: comment on that post\.$/);
    const box = q('warmup-comment-text') as HTMLTextAreaElement;
    expect(box.value).toBe(DRAFTED);
    expect(q('warmup-comment-switch')?.getAttribute('aria-checked')).toBe('true');
    expect(q('warmup-start')?.textContent).toBe('Start');
    expect(q('warmup-sheet')?.textContent).toMatch(/Orbit posts exactly these words/);
    expect(q('warmup-sheet')?.textContent).toMatch(/The message itself waits for your Send/);
    expect(q('warmup-sheet')?.textContent).not.toMatch(BANNED);
    expect(starts()).toEqual([]);
    expect(await db.chats.count()).toBe(0);
  });

  it('Start sends the comment exactly as edited, opens the warm-up, and asks nothing more', async () => {
    await openSheet();
    const edited =
      'Day two in prod, wow.  Did that hold at 20+ people?\nAsking as a student, très curious 🙂 ';
    await type(q('warmup-comment-text') as HTMLTextAreaElement, edited);
    await click(q('warmup-start'));
    await until(() => !q('warmup-sheet'), 'the sheet to close');
    expect(starts()).toHaveLength(1);
    expect(starts()[0]!.body.comment).toBe(edited);
    expect(api.state.warmups.started[0]!.comment).toBe(edited);
    expect(document.body.textContent).toContain(
      'Warm-up started for Priya. Orbit runs it and tells you when it is done.',
    );
    const chat = (await db.chats.where('personId').equals(P).first())!;
    expect(chat.stage).toBe('warming');
    expect(chat.warmUp?.auto?.comment).toBe(edited);
    // the person's page shows it running, with the approved words
    await until(() => !!q('warmup-running'), 'the progress card');
    expect(q('warmup-approved-comment')?.textContent).toContain('Day two in prod, wow.');
    expect(q('warmup-card')?.textContent).not.toMatch(BANNED);
    // no step card asks the student for anything
    expect((await db.suggestions.toArray()).filter((s) => s.kind === 'warm_up_engage')).toEqual([]);
  });

  it('leaves the comment out with the switch', async () => {
    await openSheet();
    await click(q('warmup-comment-switch'));
    expect(q('warmup-comment-text')).toBeNull();
    expect(q('warmup-comment-off')?.textContent).toBe(
      'No comment will be posted. Orbit views the profile and likes the post.',
    );
    expect(planText()).toHaveLength(2);
    expect(planText().join(' ')).not.toMatch(/comment on that post/);
    // back on: the words typed before are still there
    await click(q('warmup-comment-switch'));
    expect((q('warmup-comment-text') as HTMLTextAreaElement).value).toBe(DRAFTED);
    await click(q('warmup-comment-switch'));
    await click(q('warmup-start'));
    await until(() => !q('warmup-sheet'), 'the sheet to close');
    expect(starts()[0]!.body).toMatchObject({ comment: null });
    const chat = (await db.chats.where('personId').equals(P).first())!;
    expect(chat.warmUp?.actions.map((a) => a.kind)).toEqual(['view_profile', 'react_post']);
  });

  it('is the profile view only when they have not posted lately, and says so', async () => {
    api.state.warmups.post = null;
    await openSheet();
    expect(planText()).toHaveLength(1);
    expect(planText()[0]).toMatch(/: view Priya's profile\.$/);
    expect(q('warmup-no-post')?.textContent).toBe(
      'Priya has not posted lately, so this warm-up is the profile view only.',
    );
    expect(q('warmup-comment-text')).toBeNull();
    expect(q('warmup-comment-switch')).toBeNull();
    await click(q('warmup-start'));
    await until(() => !q('warmup-sheet'), 'the sheet to close');
    expect(starts()[0]!.body).toMatchObject({ comment: null });
  });

  it('does not start with an empty or overlong comment', async () => {
    await openSheet();
    await type(q('warmup-comment-text') as HTMLTextAreaElement, '   ');
    await click(q('warmup-start'));
    expect(q('warmup-sheet-problem')?.textContent).toBe('Write the comment, or leave it out.');
    await type(q('warmup-comment-text') as HTMLTextAreaElement, 'x'.repeat(601));
    expect(q('warmup-comment-left')?.textContent).toBe('-1');
    await click(q('warmup-start'));
    expect(q('warmup-sheet-problem')?.textContent).toBe('Keep the comment under 600 characters.');
    expect(starts()).toEqual([]);
    expect(await db.chats.count()).toBe(0);
  });

  it('asks the student to write the comment when Orbit could not', async () => {
    api.state.warmups.comment = null;
    await openSheet();
    // off until they write one, so Start alone posts no comment
    expect(q('warmup-comment-switch')?.getAttribute('aria-checked')).toBe('false');
    await click(q('warmup-comment-switch'));
    expect((q('warmup-comment-text') as HTMLTextAreaElement).value).toBe('');
    expect(q('warmup-sheet')?.textContent).toContain(
      'Orbit could not write a comment for this post. Write one here, or leave it out.',
    );
    await type(q('warmup-comment-text') as HTMLTextAreaElement, 'What changed for interns?');
    await click(q('warmup-start'));
    await until(() => !q('warmup-sheet'), 'the sheet to close');
    expect(starts()[0]!.body.comment).toBe('What changed for interns?');
  });

  it('says why it cannot run and offers the steps by hand', async () => {
    api.state.warmups.refuse = 'sign_in';
    await openSheet();
    expect(q('warmup-sheet-refused')?.textContent).toContain(
      'LinkedIn needs you to sign in again. Reconnect it in Settings, then start the warm-up.',
    );
    expect(q('warmup-sheet-retry')).toBeNull();
    await click(q('warmup-sheet-manual'));
    await until(() => !q('warmup-sheet-refused'), 'the sheet to close');
    const chat = (await db.chats.where('personId').equals(P).first())!;
    expect(chat.stage).toBe('warming');
    expect(chat.warmUp?.auto).toBeUndefined();
    expect(starts()).toEqual([]);
  });

  it('offers to try again when LinkedIn could not be read', async () => {
    api.state.warmups.refuse = 'busy';
    await openSheet();
    expect(q('warmup-sheet-refused')?.textContent).toContain('LinkedIn cannot be read right now.');
    api.state.warmups.refuse = undefined;
    await click(q('warmup-sheet-retry'));
    await until(() => !!q('warmup-sheet'), 'the plan');
    expect(planText()).toHaveLength(3);
  });
});

describe('the warm-up on the person’s page', () => {
  async function started() {
    await openSheet();
    await click(q('warmup-start'));
    await until(() => !!q('warmup-running'), 'the progress card');
    return api.state.warmups.runs[0]!;
  }

  it('shows each step as it runs, then Warmed up, and tells the student once', async () => {
    const run = await started();
    const step = (kind: string) => q(`warmup-step-${kind}`)?.textContent ?? '';
    expect(step('view_profile')).toMatch(
      /^Orbit views their profile(Today|Tomorrow|Monday|Tuesday|Wednesday|Thursday|Friday)$/,
    );
    expect(q('warmup-stop')).not.toBeNull();
    advanceWarmup(api, run.id, { at: '2026-11-16T15:01:00.000Z' });
    await act(async () => void (await pullNow(user.id)));
    await until(() => /Done/.test(step('view_profile')), 'the first step done');
    expect(step('react_post')).not.toMatch(/Done/);
    expect(q('warmup-running')?.textContent).toBe('Orbit is running it');
    advanceWarmup(api, run.id, { steps: 2, at: '2026-11-19T14:00:00.000Z' });
    await act(async () => void (await pullNow(user.id)));
    await until(() => !!q('warmup-warmed'), 'Warmed up');
    expect(q('warmup-warmed')?.textContent).toBe('Warmed up');
    expect(q('warmup-stop')).toBeNull();
    expect(q('warmup-done-line')?.textContent).toMatch(/Your first message is ready to write\.$/);
    // told once: a toast with a way to the message, one notification, and the server knows
    await until(
      () => document.body.textContent!.includes('Orbit finished the warm-up for Priya.'),
      'the toast',
    );
    await until(() => api.state.warmups.told.length === 1, 'the server to be told');
    expect(await db.notifications.where('userId').equals(user.id).count()).toBe(1);
    // the run comes down again: nothing is said twice
    advanceWarmup(api, run.id, { steps: 0 });
    await act(async () => void (await pullNow(user.id)));
    await settle(20);
    expect(await db.notifications.where('userId').equals(user.id).count()).toBe(1);
    expect(api.calls.filter((c) => c.route === '/warmups/told')).toHaveLength(1);
    expect(q('warmup-card')?.textContent).not.toMatch(BANNED);
  });

  it('Stop stops it on the server and takes the chat out of the warm-up', async () => {
    const run = await started();
    await click(q('warmup-stop'));
    await until(() => api.state.warmups.stopped.length === 1, 'the server to stop it');
    expect(api.state.warmups.runs.find((r) => r.id === run.id)?.status).toBe('stopped');
    await until(() => !q('warmup-running'), 'the card to change');
    const chat = (await db.chats.where('personId').equals(P).first())!;
    expect(chat.stage).toBe('identified');
    expect(document.body.textContent).toContain(
      'Stopped the warm-up for Priya. Nothing more will be done on LinkedIn.',
    );
    expect(q('warmup-stopped-line')?.textContent).toBe('You stopped this warm-up.');
  });

  it('says why Orbit stopped, and gives the steps left back with their links', async () => {
    const run = await started();
    advanceWarmup(api, run.id, { stop: 'linkedin_sign_in' });
    await act(async () => void (await pullNow(user.id)));
    await until(() => !!q('warmup-stopped-line'), 'the reason');
    expect(q('warmup-stopped-line')?.textContent).toBe(
      'LinkedIn needs you to sign in again, so Orbit stopped the warm-up. The steps left are yours to do.',
    );
    const links = [...(q('warmup-card')?.querySelectorAll('a[title="Open on LinkedIn"]') ?? [])];
    expect(links).toHaveLength(3);
    // the student can hand it over again once LinkedIn works, or stop it
    expect(q('warmup-hand-over')).not.toBeNull();
    expect(q('warmup-stop')).not.toBeNull();
  });
});
