import 'fake-indexeddb/auto';
import type { Suggestion } from '@orbit/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCurrentUserId } from '../db/repo';
import { db } from '../db/schema';
import { SessionProvider } from '../state/session';
import { type Built, build, TUESDAY } from '../test/morningAccounts';
import { ToastProvider } from '../ui';
import { SuggestionCard } from './SuggestionCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.setConfig({ testTimeout: 30_000 });

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};
const until = async (fn: () => boolean, what: string) => {
  for (let i = 0; i < 600; i++) {
    if (fn()) return;
    await settle(1);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const q = (id: string, within: ParentNode = document) =>
  within.querySelector<HTMLElement>(`[data-testid="${id}"]`);

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

let seed = 7100;
/** An account with a first message, from a recommendation, to someone at a target company, with its draft. */
async function firstMessage(): Promise<{ b: Built; s: Suggestion }> {
  const b = await build({ name: 'card', seed: seed++, now: TUESDAY, people: 3, kinds: ['follow_up_bump'] });
  const p = b.people[2]!;
  await db.people.update(p.id, {
    displayName: 'Ravi Fischer',
    firstName: 'Ravi',
    currentTitle: 'Product Manager',
    currentOrganizationRaw: 'Linear',
    currentOrganizationId: undefined,
    // an address on record: someone to write to now, not a LinkedIn-only stranger who gets a warm-up first
    primaryEmail: 'ravi@linear.app',
    emails: ['ravi@linear.app'],
  });
  await db.targetCompanies.put({
    id: 'tc-linear',
    userId: b.user.id,
    nameRaw: 'Linear',
    priority: 1,
    status: 'researching',
  } as never);
  await db.recommendations.put({
    id: 'rec-ravi',
    userId: b.user.id,
    personId: p.id,
    score: 0.8,
    fitScore: 0.8,
    reachScore: 0.4,
    responsePrior: 0.3,
    reasons: [{ code: 'target_company', text: 'Linear is on your target list' }],
    status: 'new',
    batchDate: '2026-10-06',
  });
  const s: Suggestion = {
    id: 'sug-ravi',
    userId: b.user.id,
    kind: 'new_outreach',
    personId: p.id,
    priorityScore: 0.9,
    reasonText: 'Linear is on your target list',
    signals: {},
    payload: { recommendationId: 'rec-ravi' },
    status: 'pending',
    dedupeKey: 'new:ravi',
    carriedOver: 0,
    expiresAt: '2026-10-09T09:30:00.000Z',
    createdAt: '2026-10-06T08:00:00.000Z',
    outboundMessageId: 'out-ravi',
  };
  await db.outbound.put({
    id: 'out-ravi',
    userId: b.user.id,
    personId: p.id,
    suggestionId: s.id,
    channel: 'gmail',
    kind: 'outreach',
    bodyDraft:
      "Hi Ravi,\n\nI'm a junior at Cornell and saw you moved into product at Linear. I'm applying for product internships this cycle and would love to hear how you got started.\n\nWould you have 15 minutes in the next couple of weeks?\n\nSam",
    status: 'draft',
    generatedBy: 'template',
    createdAt: TUESDAY.toISOString(),
  });
  await db.suggestions.put(s);
  return { b, s };
}

async function mount(b: Built, s: Suggestion) {
  await setCurrentUserId(b.user.id);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <MemoryRouter>
        <SessionProvider>
          <ToastProvider>
            <SuggestionCard s={s} />
          </ToastProvider>
        </SessionProvider>
      </MemoryRouter>,
    ),
  );
  await until(() => !!q(`suggestion-${s.kind}`) && !!q('draft-preview'), 'the card and its draft');
  return q(`suggestion-${s.kind}`)!;
}

describe('a card in Drafts', () => {
  it('names the person in a header row, with the kind as a quiet label on it', async () => {
    const { b, s } = await firstMessage();
    const card = await mount(b, s);
    const head = q('card-head', card)!;
    const name = q('card-person', head) as HTMLAnchorElement;
    expect(name.textContent).toBe('Ravi Fischer');
    expect(name.getAttribute('href')).toBe(`/people/${s.personId}`);
    expect(head.querySelector('img, [aria-hidden]')).not.toBeNull();
    expect(head.textContent).toContain('Product Manager');
    // the kind is quiet text on the same row, not a chip on a line of its own
    const kind = q('card-kind', head)!;
    expect(kind.textContent).toBe('First message');
    expect(kind.className).not.toMatch(/rounded|bg-/);
  });

  it('says why in the same sentence and reasons as the Discover card', async () => {
    const { b, s } = await firstMessage();
    const card = await mount(b, s);
    await until(() => !!q('why-summary', card), 'the why');
    expect(q('why-summary', card)!.textContent).toMatch(
      /^Worth writing to because Ravi works at Linear, one of your top target companies[,.]/,
    );
    expect(q('card-reason', card)).toBeNull();
  });

  it('quotes the draft with a thin rule, three lines, and opens it on a click', async () => {
    const { b, s } = await firstMessage();
    const card = await mount(b, s);
    const preview = q('draft-preview', card)!;
    expect(preview.className).toContain('border-l-2');
    expect(preview.className).not.toMatch(/\bbg-canvas-2\b|rounded-lg/);
    expect(preview.querySelector('.line-clamp-3')?.textContent).toContain('Hi Ravi');
    await act(async () => preview.click());
    await settle();
    expect(q('draft-preview', card)).toBeNull();
    expect(card.querySelector('textarea')).not.toBeNull();
  });

  it('has one row of actions: Review draft, with Dismiss as quiet text beside it', async () => {
    const { b, s } = await firstMessage();
    const card = await mount(b, s);
    const row = q('card-actions', card)!;
    const buttons = [...row.querySelectorAll('button')].map((x) => x.textContent?.trim());
    expect(buttons).toEqual(['Review draft', 'Dismiss']);
    // Dismiss is nowhere else on the card: no row of its own
    const all = [...card.querySelectorAll('button')].filter((x) => x.textContent?.trim() === 'Dismiss');
    expect(all).toHaveLength(1);
    // asking why keeps the reasons in the same row
    await act(async () => q('card-dismiss', row)!.click());
    await settle();
    expect(q('card-dismiss-why', q('card-actions', card)!)?.textContent).toContain('Not now');
  });

  it('a card about a reply keeps its own reason and the same one row of actions', async () => {
    const { b } = await firstMessage();
    const bump = (await db.suggestions.where('userId').equals(b.user.id).toArray()).find(
      (x) => x.kind === 'follow_up_bump',
    )!;
    if (!bump.outboundMessageId) {
      await db.outbound.put({
        id: 'out-bump',
        userId: b.user.id,
        personId: bump.personId!,
        chatId: bump.chatId,
        suggestionId: bump.id,
        channel: 'gmail',
        kind: 'bump',
        bodyDraft: 'Hi,\n\nFollowing up on my note.\n\nSam',
        status: 'draft',
        generatedBy: 'template',
        createdAt: TUESDAY.toISOString(),
      });
      await db.suggestions.update(bump.id, { outboundMessageId: 'out-bump', status: 'pending' });
    }
    const card = await mount(b, (await db.suggestions.get(bump.id))!);
    expect(q('card-reason', card)!.textContent).toBe('Reason for follow_up_bump');
    expect(q('card-kind', card)!.textContent).toBe('Follow-up');
    const row = q('card-actions', card)!;
    expect([...row.querySelectorAll('button')].map((x) => x.textContent?.trim())).toEqual([
      'Review draft',
      'Dismiss',
    ]);
  });
});
