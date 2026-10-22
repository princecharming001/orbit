import type { User } from '@orbit/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db/schema';
import { loadDemo } from '../../engine/demo';
import { styleTuningLog } from '../../engine/style';
import { ToastProvider } from '../../ui';
import { OutreachCoach } from './OutreachCoach';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let user: User;

beforeAll(async () => {
  user = await loadDemo({ reset: true });
}, 90_000);

const settle = async () => {
  for (let i = 0; i < 20; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};
const q = (host: HTMLElement, id: string) =>
  host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (el: Element | null) => {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
  await settle();
};

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ToastProvider>
          <OutreachCoach user={user} />
        </ToastProvider>
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

describe('the outreach coach', () => {
  it('shows a sample per kind, tunes it from a chip, logs it and undoes it', async () => {
    const { host, unmount } = await mount();
    expect(q(host, 'coach-sample-body')?.textContent).toMatch(/^(Hi|Hey|Hello|Dear) Sarah,|^Sarah,/);
    expect(q(host, 'coach-sample-subject')?.textContent).toBeTruthy();
    expect(q(host, 'coach-review')).toBeTruthy();

    const before = q(host, 'coach-sample-body')!.textContent!.split('\n')[0];
    await click(q(host, 'coach-chip-different-greeting'));
    const after = q(host, 'coach-sample-body')!.textContent!.split('\n')[0];
    expect(after).not.toBe(before);
    const log = await styleTuningLog(user.id);
    expect(log[0]).toMatchObject({ by: 'you', said: 'Different greeting', type: 'cold_email' });
    expect(host.querySelectorAll('[data-testid="coach-log-entry"]').length).toBe(1);

    await click(q(host, 'coach-log-undo'));
    expect(q(host, 'coach-sample-body')!.textContent!.split('\n')[0]).toBe(before);
    expect((await styleTuningLog(user.id))[0]!.undoneAt).toBeTruthy();

    // a LinkedIn note counts characters against LinkedIn's limit
    const tab = [...host.querySelectorAll('[role="tab"]')].find((t) =>
      t.textContent?.startsWith('LinkedIn note'),
    );
    await click(tab!);
    expect(q(host, 'coach-sample-size')?.textContent).toMatch(/\/ 200 characters/);
    expect(q(host, 'coach-sample-subject')).toBeNull();
    unmount();
  }, 30_000);

  it('applies typed feedback and a fix from the review', async () => {
    const { host, unmount } = await mount();
    const input = q(host, 'coach-feedback-input') as HTMLTextAreaElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(input, 'never say "circle back"');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(q(host, 'coach-apply'));
    expect((await db.styles.get(user.id))!.card.avoid).toContain('circle back');
    expect(q(host, 'coach-log')?.textContent).toMatch(/never say "circle back"/);

    const fix = host.querySelector('[data-testid^="coach-fix-"]');
    if (fix) {
      const n = (await styleTuningLog(user.id)).length;
      await click(fix);
      const log = await styleTuningLog(user.id);
      expect(log.length).toBe(n + 1);
      expect(log[0]!.by).toBe('coach');
    }
    unmount();
  }, 30_000);
});
