import 'fake-indexeddb/auto';
import type { Suggestion, SuggestionKind, User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCurrentUserId } from '../../db/repo';
import { db } from '../../db/schema';
import { nextStepPhrase, nextStepTitle, SUGGESTION_KIND_LABELS } from '../../engine/today';
import { SessionProvider } from '../../state/session';
import { type Built, build, TUESDAY } from '../../test/morningAccounts';
import { ToastProvider } from '../../ui';
import { NEXT_PARAM, NextStepPanel, NextStepPill } from './NextStep';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// each test mounts the real card over a (fake) database: on a busy machine that takes more than the default five seconds
vi.setConfig({ testTimeout: 30_000 });

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};
const until = async (fn: () => boolean, what: string, tries = 600) => {
  for (let i = 0; i < tries; i++) {
    if (fn()) return;
    await settle(1);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const q = (id: string, within: ParentNode = document) =>
  within.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (el: HTMLElement) => {
  await act(async () => el.click());
  await settle();
};

const where = { path: '' };
function Probe() {
  const l = useLocation();
  where.path = l.pathname + l.search;
  return null;
}

/** Stands in for the board: one pill per waiting step, read live, so a step dealt with loses its pill. */
function Pills({ userId }: { userId: string }) {
  const waiting =
    useLiveQuery(
      () =>
        db.suggestions
          .where('userId')
          .equals(userId)
          .filter((s) => s.status === 'pending')
          .toArray(),
      [userId],
    ) ?? [];
  return (
    <ul data-testid="board">
      {waiting.map((s) => (
        <li key={s.id} data-kind={s.kind}>
          <NextStepPill s={s} />
        </li>
      ))}
    </ul>
  );
}

let seed = 9000;
/** An account with one waiting step of each kind asked for, each message with a draft ready to edit. */
async function account(kinds: SuggestionKind[]): Promise<Built> {
  const built = await build({
    name: 'next step',
    seed: seed++,
    now: TUESDAY,
    people: kinds.length + 1,
    kinds,
  });
  for (const s of built.suggestions) {
    let outboundMessageId = s.outboundMessageId;
    if (s.chatId && !outboundMessageId && s.kind !== 'confirm_stage') {
      outboundMessageId = `${s.id}-o`;
      await db.outbound.put({
        id: outboundMessageId,
        userId: s.userId,
        personId: s.personId!,
        chatId: s.chatId,
        suggestionId: s.id,
        channel: 'gmail',
        kind: 'outreach',
        bodyDraft: 'Hi,\n\nA short note.\n\nSam',
        status: 'draft',
        generatedBy: 'template',
        createdAt: TUESDAY.toISOString(),
      });
    }
    if (outboundMessageId) await db.outbound.update(outboundMessageId, { status: 'draft' });
    await db.suggestions.update(s.id, {
      status: 'pending',
      deferred: false,
      snoozedUntil: undefined,
      outboundMessageId,
    });
  }
  return { ...built, suggestions: await db.suggestions.where('userId').equals(built.user.id).toArray() };
}

async function mount(user: User, at = '/people?view=board') {
  await setCurrentUserId(user.id);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[at]}>
        <SessionProvider>
          <ToastProvider>
            <Pills userId={user.id} />
            <NextStepPanel />
            <Probe />
          </ToastProvider>
        </SessionProvider>
      </MemoryRouter>,
    ),
  );
  await settle();
  return {
    host,
    pill: (kind: SuggestionKind) => q('chat-next', host.querySelector(`[data-kind="${kind}"]`) ?? host),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const of = (b: Built, kind: SuggestionKind): Suggestion => b.suggestions.find((s) => s.kind === kind)!;
const firstNameOf = (b: Built, s: Suggestion) => b.people.find((p) => p.id === s.personId)!.firstName;

/** The lines the panel showed as it closed, caught as they appeared (each is on screen for a moment only). */
function doneLines() {
  const seen: string[] = [];
  const watch = new MutationObserver(() => {
    const text = q('next-panel-done')?.textContent;
    if (text && seen[seen.length - 1] !== text) seen.push(text);
  });
  watch.observe(document.body, { childList: true, subtree: true, characterData: true });
  return { seen, stop: () => watch.disconnect() };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the next step, said as a title', () => {
  it('reads naturally for each kind and falls back to "Label: Name"', () => {
    expect(nextStepTitle('schedule_propose', 'Maya')).toBe('Find a time with Maya');
    expect(nextStepTitle('new_outreach', 'Maya')).toBe('First message to Maya');
    expect(nextStepTitle('follow_up_bump', 'Maya')).toBe('Follow up with Maya');
    expect(nextStepTitle('thank_you', 'Maya')).toBe('Thank Maya');
    expect(nextStepTitle('prep_brief', 'Maya')).toBe('Prep for Maya');
    expect(nextStepTitle('confirm_merge', 'Maya')).toBe('Possible duplicate: Maya');
    // a label that is a question loses its mark before the colon
    expect(nextStepTitle('confirm_social_match', 'Maya')).toBe('Same person: Maya');
    // nobody to name: the label alone
    expect(nextStepTitle('schedule_propose')).toBe('Find a time');
  });

  it('has a place for the name in every kind, and no em dash or exclamation mark', () => {
    for (const kind of Object.keys(SUGGESTION_KIND_LABELS) as SuggestionKind[]) {
      const phrase = nextStepPhrase(kind);
      expect(phrase.split('{name}'), kind).toHaveLength(2);
      expect(phrase, kind).not.toMatch(/[\u2014!]/);
    }
  });
});

describe('the next step panel', () => {
  it("opens from the pill, in place, with what it is and for whom and the step's own card", async () => {
    const b = await account(['schedule_propose', 'new_outreach']);
    const s = of(b, 'schedule_propose');
    const { pill, unmount } = await mount(b.user);
    try {
      const p = pill('schedule_propose')!;
      // the pill is a button now, not a link to another page
      expect(p.tagName).toBe('BUTTON');
      expect(p.getAttribute('aria-haspopup')).toBe('dialog');
      expect(p.getAttribute('title')).toBe('Do this here');
      expect(p.textContent).toBe('Find a time');
      expect(q('next-panel')).toBeNull();
      await click(p);
      await until(() => !!q('next-panel'), 'the panel');
      const panel = q('next-panel')!;
      // the page stays where it was: the step is a search param on it
      expect(where.path).toBe(`/people?view=board&${NEXT_PARAM}=${s.id}`);
      expect(q('board')).not.toBeNull();
      expect(panel.getAttribute('role')).toBe('dialog');
      expect(panel.getAttribute('aria-modal')).toBe('true');
      const title = q('next-panel-title')!;
      expect(panel.getAttribute('aria-labelledby')).toBe(title.id);
      await until(() => title.textContent === `Find a time with ${firstNameOf(b, s)}`, 'the title');
      // the name goes to their page
      expect(q('next-panel-person', panel)!.getAttribute('href')).toBe(`/people/${s.personId}`);
      // the same card Drafts shows, with its draft open to edit
      const card = q('suggestion-schedule_propose', panel)!;
      expect(card).not.toBeNull();
      await until(() => !!panel.querySelector('textarea'), 'the draft, open');
      expect(card.textContent).toContain('Reason for schedule_propose');
      // framed by the panel, not by a border of its own, and with nothing to fold the draft back into
      expect(card.className).not.toMatch(/\bborder\b/);
      expect(panel.querySelector('[aria-label="Close the draft"]')).toBeNull();
      expect(q('next-panel-open-drafts')!.getAttribute('href')).toBe(`/inbox?card=${s.id}`);
      expect(q('next-panel-open-drafts')!.textContent).toBe('Open in Drafts');
      // focus moved into the panel
      expect(panel.contains(document.activeElement)).toBe(true);
      // the board was not thrown away and drawn from scratch: its pill is the same element
      expect(pill('schedule_propose')).toBe(p);
      expect(p.getAttribute('aria-expanded')).toBe('true');
    } finally {
      unmount();
    }
  });

  it('names a first message as one, and a kind without a draft still shows its card', async () => {
    const b = await account(['new_outreach', 'confirm_stage']);
    const { pill, unmount } = await mount(b.user);
    try {
      const first = of(b, 'new_outreach');
      await click(pill('new_outreach')!);
      await until(() => !!q('next-panel'), 'the panel');
      await until(
        () => q('next-panel-title')!.textContent === `First message to ${firstNameOf(b, first)}`,
        'the first message title',
      );
      expect(q('suggestion-new_outreach', q('next-panel')!)).not.toBeNull();
      await click(q('next-panel-close')!);
      await until(() => !q('next-panel'), 'the panel to close');
      const stage = of(b, 'confirm_stage');
      await click(pill('confirm_stage')!);
      await until(() => !!q('suggestion-confirm_stage'), 'the stage question');
      await until(
        () => q('next-panel-title')!.textContent === `Did this change for ${firstNameOf(b, stage)}?`,
        'the stage title',
      );
    } finally {
      unmount();
    }
  });

  it('closes on Escape, and focus returns to the pill', async () => {
    const b = await account(['schedule_propose']);
    const { pill, unmount } = await mount(b.user);
    try {
      const p = pill('schedule_propose')!;
      await click(p);
      await until(() => !!q('next-panel'), 'the panel');
      expect(document.activeElement).not.toBe(p);
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      await until(() => !q('next-panel'), 'the panel to close');
      expect(where.path).toBe('/people?view=board');
      expect(document.activeElement).toBe(p);
      // nothing was done to the step: its pill is still there
      expect(pill('schedule_propose')).toBe(p);
    } finally {
      unmount();
    }
  });

  it('closes on a click on the dimmed page, and with the close button', async () => {
    const b = await account(['follow_up_bump']);
    const { pill, unmount } = await mount(b.user);
    try {
      await click(pill('follow_up_bump')!);
      await until(() => !!q('next-panel'), 'the panel');
      await click(q('next-panel-backdrop')!);
      await until(() => !q('next-panel'), 'the panel to close');
      expect(where.path).toBe('/people?view=board');
      await click(pill('follow_up_bump')!);
      await until(() => !!q('next-panel'), 'the panel again');
      await click(q('next-panel-close')!);
      await until(() => !q('next-panel'), 'the panel to close');
      expect(where.path).toBe('/people?view=board');
      expect(document.activeElement).toBe(pill('follow_up_bump'));
    } finally {
      unmount();
    }
  });

  it('says so for a moment and closes when the step stops waiting for another reason', async () => {
    const b = await account(['thank_you']);
    const s = of(b, 'thank_you');
    const { pill, unmount } = await mount(b.user);
    try {
      await click(pill('thank_you')!);
      await until(() => !!q('suggestion-thank_you'), 'the card');
      const lines = doneLines();
      // Orbit saw the message go out some other way
      await act(async () => {
        await db.suggestions.update(s.id, { status: 'sent' });
      });
      await until(() => !q('next-panel'), 'the panel to close', 2000);
      lines.stop();
      // nothing else said so, so the panel did, once, before it went
      expect(lines.seen).toEqual([`Sent to ${firstNameOf(b, s)}.`]);
      expect(where.path).toBe('/people?view=board');
      // the board reads the same data: the pill is gone
      expect(pill('thank_you')).toBeNull();
    } finally {
      unmount();
    }
  });

  it('closes when the step is deleted while it is open', async () => {
    const b = await account(['reconnect']);
    const s = of(b, 'reconnect');
    const { pill, unmount } = await mount(b.user);
    try {
      await click(pill('reconnect')!);
      await until(() => !!q('next-panel'), 'the panel');
      const lines = doneLines();
      await act(async () => {
        await db.suggestions.delete(s.id);
      });
      await until(() => !q('next-panel'), 'the panel to close', 2000);
      lines.stop();
      expect(lines.seen).toEqual(['This step is no longer needed.']);
      expect(where.path).toBe('/people?view=board');
    } finally {
      unmount();
    }
  });

  // the toast and the change it reports are a beat apart; a stalled machine can stretch that beat, hence the retries
  it('closes at once when the card itself said what happened (Dismiss, with its toast)', {
    retry: 2,
  }, async () => {
    const b = await account(['schedule_propose']);
    const s = of(b, 'schedule_propose');
    const { pill, unmount } = await mount(b.user);
    try {
      await click(pill('schedule_propose')!);
      await until(() => !!q('suggestion-schedule_propose'), 'the card');
      const panel = q('next-panel')!;
      const button = (text: string) =>
        [...panel.querySelectorAll<HTMLElement>('button')].find((x) => x.textContent?.trim() === text);
      const lines = doneLines();
      await click(button('Dismiss')!);
      await click(button('Not now')!);
      await until(() => !q('next-panel'), 'the panel to close');
      lines.stop();
      // the card's own toast said it; the panel did not say it again
      expect(lines.seen).toEqual([]);
      expect(q('toasts')!.textContent).toContain('Card removed.');
      expect((await db.suggestions.get(s.id))!.status).toBe('dismissed');
      expect(where.path).toBe('/people?view=board');
      expect(pill('schedule_propose')).toBeNull();
    } finally {
      unmount();
    }
  });

  it('closes when the message is approved and on its way', async () => {
    const b = await account(['schedule_propose']);
    const s = of(b, 'schedule_propose');
    const { pill, unmount } = await mount(b.user);
    try {
      await click(pill('schedule_propose')!);
      await until(() => !!q('next-panel')?.querySelector('textarea'), 'the draft');
      // approved: queued behind its undo window, the card still waiting
      await act(async () => {
        await db.outbound.update(s.outboundMessageId!, {
          status: 'queued',
          sendAt: new Date(Date.now() + 10_000).toISOString(),
        });
      });
      await until(() => !q('next-panel'), 'the panel to close');
      expect(where.path).toBe('/people?view=board');
      // opened again during the undo window, it stays open (the card shows the countdown and Undo)
      await click(pill('schedule_propose')!);
      await until(() => !!q('next-panel'), 'the panel again');
      await settle(40);
      expect(q('next-panel')).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it("closes with the draft's own Close button, keeping what was typed", async () => {
    const b = await account(['schedule_propose']);
    const s = of(b, 'schedule_propose');
    const { pill, unmount } = await mount(b.user);
    try {
      await click(pill('schedule_propose')!);
      await until(() => !!q('next-panel')?.querySelector('textarea'), 'the draft');
      const box = q('next-panel')!.querySelector('textarea')!;
      await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        set.call(box, 'Hi,\n\nTuesday at 3 works for me.\n\nSam');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await click(q('draft-cancel')!);
      await until(() => !q('next-panel'), 'the panel to close');
      expect(where.path).toBe('/people?view=board');
      await settle(20);
      const saved = await db.outbound.get(s.outboundMessageId!);
      expect(saved!.bodyFinal ?? saved!.bodyDraft).toContain('Tuesday at 3 works for me.');
      // the step still waits: closing is not deciding
      expect((await db.suggestions.get(s.id))!.status).toBe('pending');
    } finally {
      unmount();
    }
  });

  it('opens from the address (a reload, a link) and leaves it clean when closed', async () => {
    const b = await account(['schedule_propose']);
    const s = of(b, 'schedule_propose');
    const { unmount } = await mount(b.user, `/people?view=list&${NEXT_PARAM}=${s.id}`);
    try {
      await until(() => !!q('suggestion-schedule_propose'), 'the card');
      await click(q('next-panel-close')!);
      await until(() => !q('next-panel'), 'the panel to close');
      expect(where.path).toBe('/people?view=list');
    } finally {
      unmount();
    }
  });

  it('opens nothing for a step that is already done, or is not there, and drops it from the address', async () => {
    const b = await account(['schedule_propose']);
    const s = of(b, 'schedule_propose');
    await db.suggestions.update(s.id, { status: 'dismissed' });
    const done = await mount(b.user, `/people?${NEXT_PARAM}=${s.id}`);
    try {
      await until(() => where.path === '/people', 'the address to be cleaned');
      expect(q('next-panel')).toBeNull();
    } finally {
      done.unmount();
    }
    const missing = await mount(b.user, `/people?view=board&${NEXT_PARAM}=nope`);
    try {
      await until(() => where.path === '/people?view=board', 'the address to be cleaned');
      expect(q('next-panel')).toBeNull();
    } finally {
      missing.unmount();
    }
  });
});
