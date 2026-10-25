import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentUserId } from '../db/repo';
import { db } from '../db/schema';
import { createLocalUser } from '../engine/account';
import type { LiveConnectResult } from '../engine/linkedinLive';
import { SessionProvider } from '../state/session';
import { Onboarding } from './Onboarding';
import {
  QUESTION_STEPS,
  resolveStep,
  STEP,
  stepAddress,
  stepFromAddress,
  stepPath,
  stepStatuses,
  visibleSteps,
} from './onboardingSteps';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// each step scrolls to its top; jsdom has no scrolling
window.scrollTo = () => {};

const live = vi.hoisted(() => ({
  available: false,
  result: {
    ok: false,
    reason: 'unconfigured',
    message: 'Live LinkedIn is not switched on yet.',
  } as LiveConnectResult,
}));
vi.mock('../engine/linkedinLive', () => ({
  liveLinkedInAvailable: () => live.available,
  connectLinkedInLive: async () => live.result,
}));

describe('setup steps', () => {
  it('shows Gmail only when Google sign-in is set up', () => {
    expect(visibleSteps(true)).toEqual([1, 2, 3, ...QUESTION_STEPS, 4, 5, 6]);
    expect(visibleSteps(false)).toEqual([1, 2, 3, ...QUESTION_STEPS, 4, 6]);
    expect(visibleSteps(false)).not.toContain(STEP.gmail);
    expect(visibleSteps(false, true)).toEqual([1, 2, 3, ...QUESTION_STEPS, 4, 5.5, 6]);
  });

  it('puts the five written questions between Goals and LinkedIn, at word addresses', () => {
    expect(QUESTION_STEPS).toEqual([STEP.aim, STEP.story, STEP.people, STEP.style, STEP.job]);
    expect(QUESTION_STEPS.map(stepAddress)).toEqual(['aim', 'story', 'people', 'style', 'job']);
    for (const s of QUESTION_STEPS) {
      expect(s).toBeGreaterThan(STEP.goals);
      expect(s).toBeLessThan(STEP.linkedin);
      expect(stepFromAddress(stepAddress(s))).toBe(s);
    }
    // the numbered addresses are as before
    expect(stepAddress(STEP.welcome)).toBe('0');
    expect(stepAddress(STEP.rate)).toBe('4.5');
    expect(stepFromAddress('4.5')).toBe(STEP.rate);
    expect(stepFromAddress('2')).toBe(STEP.goals);
    expect(stepFromAddress(undefined)).toBe(STEP.welcome);
    expect(stepFromAddress('nope')).toBeNaN();
    // Goals is followed by the first question; someone stored past Goals in the older setup is not sent back
    expect(resolveStep(3.1, false)).toBe(STEP.aim);
    expect(resolveStep(4, false)).toBe(STEP.linkedin);
    expect(stepPath(3.2, false)).toBe('/onboarding/aim');
  });

  it('opens a new profile on Welcome, at /onboarding/0', () => {
    expect(resolveStep(1, true)).toBe(STEP.welcome);
    expect(stepPath(1, false)).toBe('/onboarding/0');
    // nothing below the first step
    expect(resolveStep(0, true)).toBe(STEP.welcome);
    expect(resolveStep(-3, false)).toBe(STEP.welcome);
    expect(resolveStep(Number.NaN, false)).toBe(STEP.welcome);
  });

  it('moves a step of the older, longer setup forward to the step that comes next', () => {
    // old 2 About you, 3 Goals: the same content
    expect(resolveStep(2, true)).toBe(STEP.you);
    expect(resolveStep(3, true)).toBe(STEP.goals);
    // old 4 Resume (no longer a step): LinkedIn comes next
    expect(resolveStep(4, true)).toBe(STEP.linkedin);
    // old 5 Google: Gmail, or Ready on a build without Google
    expect(resolveStep(5, true)).toBe(STEP.gmail);
    expect(resolveStep(5, false)).toBe(STEP.ready);
    // old 6 LinkedIn, 7 meeting notes, 8 preferences, and anything past the end: Ready
    for (const old of [6, 7, 8, 10, 99]) {
      expect(resolveStep(old, true)).toBe(STEP.ready);
      expect(resolveStep(old, false)).toBe(STEP.ready);
    }
    expect(stepPath(8, false)).toBe('/onboarding/5');
  });

  it('never moves a stored step backwards', () => {
    for (const google of [true, false])
      for (const s of [1, 2, 3, 3.2, 3.5, 3.9, 4, 5, 5.5, 6, 7, 8, 9, 10, 11]) {
        const r = resolveStep(s, google);
        expect(visibleSteps(google)).toContain(r);
        if (s <= STEP.ready) expect(r).toBeGreaterThanOrEqual(s);
      }
  });

  it('marks an optional step passed without doing it as skipped, never done', () => {
    const steps = visibleSteps(false);
    expect(stepStatuses(steps, STEP.ready, { [STEP.aim]: true, [STEP.linkedin]: false })).toEqual([
      'done',
      'done',
      'done',
      'done',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'current',
    ]);
    expect(stepStatuses(steps, STEP.ready, { [STEP.linkedin]: true })[8]).toBe('done');
    expect(stepStatuses(steps, STEP.you, {}).slice(0, 4)).toEqual(['done', 'current', 'todo', 'todo']);
  });
});

/** Renders setup at an address for a profile that has reached `stored`, and lets its live queries settle. */
async function renderSetup(address: string, stored: number) {
  const u = await createLocalUser({ fullName: 'Sam Okafor', school: 'Michigan', onboardingStep: stored });
  await setCurrentUserId(u.id);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[address]}>
        <SessionProvider>
          <Routes>
            <Route path="/onboarding/:step" element={<Onboarding />} />
            <Route path="/" element={<p data-testid="home">home</p>} />
          </Routes>
        </SessionProvider>
      </MemoryRouter>,
    );
  });
  await settle();
  const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  return { host, q, done: () => act(() => root.unmount()) };
}

async function settle() {
  for (let i = 0; i < 20; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
}

describe('the LinkedIn step', () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
    live.available = false;
  });

  it('offers the export upload, and no live button, while live LinkedIn is not available', async () => {
    const { q, done } = await renderSetup('/onboarding/3', STEP.linkedin);
    expect(q('ob-linkedin-live')).toBeNull();
    expect(q('ob-linkedin')).not.toBeNull();
    expect(q('ob-skip')?.textContent).toMatch(/do this later/);
    done();
  });

  it('makes live connect the primary action, with the export one tap away', async () => {
    live.available = true;
    const { q, done } = await renderSetup('/onboarding/3', STEP.linkedin);
    expect(q('ob-linkedin-live')?.textContent).toBe('Connect LinkedIn');
    expect(q('ob-linkedin')).toBeNull();
    await act(async () => q('ob-linkedin-upload')!.click());
    expect(q('ob-linkedin')).not.toBeNull();
    done();
  });

  it('says so and opens the upload when live LinkedIn turns out not to be switched on', async () => {
    live.available = true;
    const { host, q, done } = await renderSetup('/onboarding/3', STEP.linkedin);
    await act(async () => q('ob-linkedin-live')!.click());
    await settle();
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/not switched on yet/);
    expect(q('ob-linkedin')).not.toBeNull();
    // the button that just failed is not offered again
    expect(q('ob-linkedin-live')).toBeNull();
    done();
  });

  it('shows what a live connect imported', async () => {
    live.available = true;
    live.result = { ok: true, rows: 120, added: 118 };
    const { q, done } = await renderSetup('/onboarding/3', STEP.linkedin);
    await act(async () => q('ob-linkedin-live')!.click());
    await settle();
    expect(q('ob-linkedin-done')?.textContent).toMatch(/120 connections imported/);
    done();
  });
});

describe('setup addresses', () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });

  it('opens a new profile on Welcome, even from the address of the step after it', async () => {
    const { q, done } = await renderSetup('/onboarding/1', 1);
    expect(q('ob-welcome')).not.toBeNull();
    done();
  });

  it('moves a profile left on the older Resume step to LinkedIn', async () => {
    const { host, done } = await renderSetup('/onboarding/3', 4);
    expect(host.querySelector('h1')?.textContent).toMatch(/LinkedIn/);
    done();
  });

  it('moves a profile left on the older Google step to Ready on a build without Google', async () => {
    const { q, done } = await renderSetup('/onboarding/4', 5);
    expect(q('ob-ready')).not.toBeNull();
    expect(q('ob-ready-gmail')).toBeNull();
    done();
  });
});

/** Types into a field the way a person does, so React sees the change. */
function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('the written questions (plan 24)', () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });

  it('saves what is written on Continue and opens the next question', async () => {
    const { q, done } = await renderSetup('/onboarding/aim', STEP.aim);
    expect(q('ob-q')?.dataset.step).toBe('aim');
    expect(q('ob-eyebrow')?.textContent).toBe('In your words · 1 of 5');
    await act(async () =>
      type(q('ob-q-aim') as HTMLTextAreaElement, '  Product roles at fintech startups.  '),
    );
    await act(async () => q('ob-q-next')!.click());
    await settle();
    expect(q('ob-q')?.dataset.step).toBe('story');
    const [g] = await db.goals.toArray();
    expect(g?.aim).toBe('Product roles at fintech startups.');
    expect(g?.success).toBeUndefined();
    done();
  });

  it('changes nothing on Skip', async () => {
    const { q, done } = await renderSetup('/onboarding/story', STEP.story);
    await act(async () => type(q('ob-q-story') as HTMLTextAreaElement, 'I am a junior.'));
    await act(async () => q('ob-q-skip')!.click());
    await settle();
    expect(q('ob-q')?.dataset.step).toBe('people');
    expect((await db.goals.toArray())[0]?.story).toBeUndefined();
    done();
  });

  it('tells the posting link from the words in the job box', async () => {
    const { host, q, done } = await renderSetup('/onboarding/job', STEP.job);
    await act(async () =>
      type(q('ob-q-job') as HTMLInputElement, 'Stripe, PM intern https://jobs.lever.co/stripe/123'),
    );
    expect(q('ob-job-preview')?.textContent).toMatch(/Stripe, PM intern.*jobs\.lever\.co\/stripe/);
    await act(async () => q('ob-q-next')!.click());
    await settle();
    expect((await db.goals.toArray())[0]?.currentJob).toEqual({
      url: 'https://jobs.lever.co/stripe/123',
      text: 'Stripe, PM intern',
    });
    // the next step is LinkedIn
    expect(host.querySelector('h1')?.textContent).toMatch(/LinkedIn/);
    done();
  });
});
