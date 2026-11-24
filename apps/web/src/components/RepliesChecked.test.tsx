/**
 * The quiet line under Drafts and the board: when Orbit last looked for replies, a way to look again, and (in
 * Drafts) last week's review. Drafts used to carry a Refresh button and a "Last week's review" button beside its
 * title as well, which said the same thing twice: "Check now" now also rebuilds the day's cards.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const replies = vi.hoisted(() => ({
  sources: { gmail: true, linkedin: false, demo: false } as Record<string, boolean>,
  checkReplies: vi.fn(),
}));
vi.mock('../engine/checkReplies', async (orig) => ({
  ...(await orig<typeof import('../engine/checkReplies')>()),
  replySources: async () => replies.sources,
  checkReplies: replies.checkReplies,
  checkingReplies: () => false,
  watchReplyCheck: () => () => {},
}));
vi.mock('../state/session', () => ({ useSession: () => ({ user: { id: 'u1' }, userId: 'u1' }) }));

import { RepliesChecked } from './RepliesChecked';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  replies.sources = { gmail: true, linkedin: false, demo: false };
  replies.checkReplies.mockResolvedValue(undefined);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});
const $ = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const settle = async () => {
  for (let i = 0; i < 6; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};
async function show(el: React.ReactElement) {
  await act(async () => root.render(<MemoryRouter>{el}</MemoryRouter>));
  await settle();
}

describe('the line that says when Orbit last looked', () => {
  it('Check now reads for replies, then does the page’s own work, and says it is checking until both are done', async () => {
    let done: () => void = () => {};
    const rebuilt = vi.fn(() => new Promise<void>((r) => (done = r)));
    await show(<RepliesChecked onChecked={rebuilt} />);
    await act(async () => $('replies-check-now')!.click());
    await settle();
    expect(replies.checkReplies).toHaveBeenCalledWith({ id: 'u1' }, { reason: 'manual' });
    expect(rebuilt).toHaveBeenCalledTimes(1);
    // the page is still rebuilding: no second tap is offered
    expect($('replies-checking')).not.toBeNull();
    expect($('replies-check-now')).toBeNull();
    await act(async () => done());
    await settle();
    expect($('replies-check-now')).not.toBeNull();
  });

  it('the page’s work still runs when reading for replies failed', async () => {
    replies.checkReplies.mockRejectedValue(new Error('offline'));
    const rebuilt = vi.fn(async () => {});
    await show(<RepliesChecked onChecked={rebuilt} />);
    await act(async () => $('replies-check-now')!.click());
    await settle();
    expect(rebuilt).toHaveBeenCalledTimes(1);
  });

  it('a link of the page’s own sits on the same line, after a dot', async () => {
    await show(
      <RepliesChecked
        more={
          <button type="button" data-testid="drafts-last-review">
            Last week's review
          </button>
        }
      />,
    );
    const line = $('replies-checked')!;
    expect(line.textContent).toMatch(/Check now·Last week's review$/);
    expect(line.querySelector('[data-testid="drafts-last-review"]')).not.toBeNull();
  });

  it('with nothing connected: no reply check, but the page can still update itself and keeps its link', async () => {
    replies.sources = { gmail: false, linkedin: false, demo: false };
    const rebuilt = vi.fn(async () => {});
    await show(
      <RepliesChecked onChecked={rebuilt} more={<span data-testid="more">Last week's review</span>} />,
    );
    expect($('replies-checked')).toBeNull();
    expect($('replies-check-now')!.textContent).toBe('Update');
    await act(async () => $('replies-check-now')!.click());
    await settle();
    expect(rebuilt).toHaveBeenCalledTimes(1);
    expect(replies.checkReplies).not.toHaveBeenCalled();
    expect($('more')).not.toBeNull();
  });

  it('with nothing connected and nothing of the page’s own, the line is the fallback or nothing', async () => {
    replies.sources = { gmail: false, linkedin: false, demo: false };
    await show(<RepliesChecked />);
    expect(host.textContent).toBe('');
    await show(<RepliesChecked fallback="Orbit cannot see your inbox." />);
    expect(host.textContent).toBe('Orbit cannot see your inbox.');
  });
});
