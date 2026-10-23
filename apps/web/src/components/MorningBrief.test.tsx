import type { User } from '@orbit/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCurrentUserId } from '../db/repo';
import { db } from '../db/schema';
import { type MorningDeck, type MorningOutcome, morningDeck, morningSummary } from '../engine/morning';
import { SessionProvider } from '../state/session';
import { build, specs } from '../test/morningAccounts';
import { ToastProvider } from '../ui';
import { MorningBrief, openMorningBrief } from './MorningBrief';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};
const until = async (fn: () => boolean, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await settle(1);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const where = { path: '' };
/** What the walks did, so a pass means the paths were really taken. */
const tally = { resolved: 0, composed: 0, later: 0, skipped: 0, linkedIn: 0, moves: 0 };
function Probe() {
  const l = useLocation();
  where.path = l.pathname + l.search;
  return null;
}

async function mount(user: User) {
  await setCurrentUserId(user.id);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/']}>
        <SessionProvider>
          <ToastProvider>
            <MorningBrief />
            <Probe />
          </ToastProvider>
        </SessionProvider>
      </MemoryRouter>,
    ),
  );
  await settle();
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const q = (el: ParentNode, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (el: HTMLElement) => {
  await act(async () => el.click());
  await settle();
};

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

/** Walk one deck as a student would: read each step, decide some, put some off, skip the rest. */
async function walk(user: User, deck: MorningDeck) {
  const { host, unmount } = await mount(user);
  try {
    await act(async () => openMorningBrief());
    await until(() => !!q(document, 'morning-brief'), 'the brief');
    const dialog = q(document, 'morning-brief')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(q(document, 'morning-backdrop')).not.toBeNull();
    expect(q(dialog, 'morning-headline')?.textContent).toBe(deck.headline);
    const outcomes: Record<string, MorningOutcome> = {};
    const start = where.path;
    for (let step = 0; step < 40; step++) {
      const kind = dialog.getAttribute('data-step');
      if (kind === 'done') break;
      if (kind === 'decide') {
        const d = q(dialog, 'morning-decision')!;
        const k = Number(/Decision (\d+) of (\d+)/.exec(q(d, 'morning-count')!.textContent ?? '')?.[1]);
        const total = Number(/of (\d+)/.exec(q(d, 'morning-count')!.textContent ?? '')?.[1]);
        expect(total).toBe(deck.decisions.length);
        expect(k).toBeGreaterThanOrEqual(1);
        expect(k).toBeLessThanOrEqual(total);
        const s = deck.decisions[k - 1]!;
        expect(d.getAttribute('data-kind')).toBe(s.kind);
        // a name is a link: their LinkedIn, or their page in Orbit
        for (const a of d.querySelectorAll<HTMLAnchorElement>(
          '[data-testid="morning-person-name"], [data-testid="merge-record-name"]',
        ))
          expect(a.getAttribute('href')).toMatch(/linkedin\.com|\/people\//);
        const actions = q(d, 'morning-actions');
        expect(actions, `${s.kind} shows its buttons`).not.toBeNull();
        const primaries = d.querySelectorAll<HTMLElement>('[data-primary="true"]');
        expect(primaries.length, `${s.kind} has one main button`).toBe(1);
        let primary = primaries[0]!;
        const mode = k % 3;
        if (mode === 0 && primary.dataset.effect === 'tab') {
          // LinkedIn opens in a new tab; the deck stays and Done becomes the main button
          tally.linkedIn++;
          await click(primary);
          primary = d.querySelector<HTMLElement>('[data-primary="true"]')!;
          // with its chat, Done leads now; a step Orbit cannot log keeps LinkedIn first and offers Tomorrow
          expect(primary.dataset.testid).toBe(
            s.chatId ? 'morning-action-warm_done' : 'morning-action-open_linkedin',
          );
        }
        if (
          mode === 0 &&
          primary.dataset.effect === 'resolve' &&
          primary.dataset.testid !== 'morning-action-merge'
        ) {
          await click(primary);
          await until(
            () =>
              dialog.getAttribute('data-step') !== 'decide' ||
              q(dialog, 'morning-count')?.textContent !== `Decision ${k} of ${total}`,
            `${s.kind} to be decided`,
          );
          outcomes[s.id] = 'done';
          tally.resolved++;
          expect(q(dialog, 'morning-undo'), 'the footer offers Undo').not.toBeNull();
        } else if (mode === 0 && primary.dataset.effect === 'compose') {
          await click(primary);
          await until(() => !!q(dialog, 'morning-composer'), `${s.kind} draft to open in the deck`);
          tally.composed++;
          await click(q(dialog, 'morning-next')!);
          outcomes[s.id] = 'skipped';
        } else if (mode === 1 && q(d, 'morning-action-tomorrow')) {
          await click(q(d, 'morning-action-tomorrow')!);
          await until(
            () => q(dialog, 'morning-count')?.textContent !== `Decision ${k} of ${total}`,
            'the next step',
          );
          outcomes[s.id] = 'later';
          tally.later++;
        } else {
          await click(q(dialog, 'morning-next')!);
          outcomes[s.id] = 'skipped';
        }
        expect(where.path, `${s.kind}: nothing in the deck changes the page`).toBe(start);
        continue;
      }
      if (kind === 'moves') {
        const rows = dialog.querySelectorAll('[data-testid="morning-move"]');
        expect(rows.length).toBe(deck.moves.length);
        for (const r of rows) expect(r.querySelector('[data-testid="morning-move-action"]')).not.toBeNull();
        tally.moves += rows.length;
      }
      await click(q(dialog, 'morning-next')!);
    }
    expect(dialog.getAttribute('data-step')).toBe('done');
    const sum = morningSummary(deck, outcomes);
    expect(q(dialog, 'morning-rest')?.textContent).toBe(sum.rest);
    for (const l of sum.lines) expect(q(dialog, 'morning-summary')?.textContent).toContain(l);
    expect(where.path).toBe(start);
    // the end closes it for the day
    await click(q(dialog, 'morning-finish')!);
    expect(q(document, 'morning-brief')).toBeNull();
    void host;
  } finally {
    unmount();
  }
}

describe('the morning brief on screen', () => {
  const sample = specs().filter((_, k) => k % 12 === 0 || k < 13);
  it(`walks ${sample.length} generated briefs: counts, links, one main button each, finished in place`, async () => {
    expect(sample.length).toBeGreaterThan(30);
    for (const spec of sample) {
      vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
      vi.setSystemTime(spec.now);
      const b = await build(spec);
      const deck = await morningDeck(b.user, new Date());
      try {
        await walk(b.user, deck);
      } catch (e) {
        throw new Error(`${spec.name}: ${(e as Error).message}`);
      } finally {
        vi.useRealTimers();
      }
    }
    expect(tally.resolved).toBeGreaterThan(10);
    expect(tally.composed).toBeGreaterThan(3);
    expect(tally.later).toBeGreaterThan(5);
    expect(tally.linkedIn).toBeGreaterThan(0);
    expect(tally.moves).toBeGreaterThan(5);
  }, 600_000);

  it('minimizing keeps the step, and the pill brings it back to the same place', async () => {
    const spec = specs().find((s) => s.name === 'every kind, long names')!;
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(spec.now);
    const b = await build(spec);
    const { unmount } = await mount(b.user);
    try {
      await act(async () => openMorningBrief());
      await until(() => !!q(document, 'morning-brief'), 'the brief');
      await click(q(document, 'morning-next')!);
      await click(q(document, 'morning-next')!);
      expect(q(document, 'morning-count')?.textContent).toMatch(/^Decision 2 of/);
      // Esc puts it away as a pill
      await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      await settle();
      expect(q(document, 'morning-brief')).toBeNull();
      expect(q(document, 'morning-pill')?.textContent).toMatch(/Morning brief/);
      await click(q(document, 'morning-resume')!);
      expect(q(document, 'morning-count')?.textContent).toMatch(/^Decision 2 of/);
      // the arrow keys move, and the backdrop minimizes too
      await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' })));
      await settle();
      expect(q(document, 'morning-count')?.textContent).toMatch(/^Decision 1 of/);
      await click(q(document, 'morning-backdrop')!);
      expect(q(document, 'morning-pill')).not.toBeNull();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  }, 120_000);

  it('Undo takes the last decision back: the chat, the question and the card are as they were', async () => {
    const spec = specs().find((x) => x.name === 'confirm_stage alone')!;
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(spec.now);
    const b = await build(spec);
    const card = b.suggestions.find((x) => x.kind === 'confirm_stage' && x.status === 'pending')!;
    expect(card).toBeDefined();
    const { unmount } = await mount(b.user);
    try {
      await act(async () => openMorningBrief());
      await until(() => !!q(document, 'morning-brief'), 'the brief');
      await click(q(document, 'morning-next')!);
      await click(q(document, 'morning-action-yes')!);
      await until(() => !!q(document, 'morning-undo'), 'Undo');
      const ev = b.stageEvents.find((e) => e.id === card.payload.stageEventId)!;
      expect((await db.stageEvents.get(ev.id))?.status).toBe('confirmed');
      expect((await db.chats.get(ev.chatId))?.stage).toBe(ev.toStage);
      expect(q(document, 'morning-last')?.textContent).toMatch(/^Moved /);
      await click(q(document, 'morning-undo')!);
      await until(() => !q(document, 'morning-undo'), 'Undo to finish');
      expect((await db.stageEvents.get(ev.id))?.status).toBe('proposed');
      expect((await db.chats.get(ev.chatId))?.stage).toBe('outreach_sent');
      expect((await db.suggestions.get(card.id))?.status).toBe('pending');
      // back on the question, with its buttons again
      expect(q(document, 'morning-count')?.textContent).toMatch(/^Decision 1 of/);
      expect(q(document, 'morning-action-yes')).not.toBeNull();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  }, 120_000);
});
