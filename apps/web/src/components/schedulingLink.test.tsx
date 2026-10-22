import type { User } from '@orbit/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { connectCalcom, disconnectCalcom } from '../engine/calcom';
import { loadDemo } from '../engine/demo';
import { SchedulingLinkField } from './SchedulingLinkField';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let user: User;

beforeAll(async () => {
  user = await loadDemo({ reset: true });
}, 90_000);

const settle = async () => {
  for (let i = 0; i < 15; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};

/** Renders the field, keeping the value in a variable like the Limits page keeps it in settings. */
async function mount(initial: string | undefined) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let value = initial;
  const render = () =>
    root.render(
      <MemoryRouter>
        <SchedulingLinkField
          user={user}
          value={value}
          onChange={(v) => {
            value = v;
            render();
          }}
        />
      </MemoryRouter>,
    );
  await act(async () => render());
  await settle();
  return {
    host,
    get value() {
      return value;
    },
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const choose = async (select: HTMLSelectElement, v: string) => {
  await act(async () => {
    select.value = v;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
};

describe('the scheduling link', () => {
  it('without Cal.com: a text field (Cal.com connects in the row just above it)', async () => {
    await disconnectCalcom(user);
    const f = await mount('https://calendly.com/me');
    expect((f.host.querySelector('#lim-sched') as HTMLInputElement).value).toBe('https://calendly.com/me');
    expect(f.host.querySelector('[data-testid="scheduling-link-select"]')).toBeNull();
    f.unmount();
  });

  it('with Cal.com: picks from the event types, and Other link… opens the text field', async () => {
    await db.settings.update(user.id, { schedulingLink: undefined });
    await connectCalcom(user, '');
    const chosen = (await db.settings.get(user.id))!.schedulingLink!;
    const f = await mount(chosen);
    const select = f.host.querySelector('[data-testid="scheduling-link-select"]') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'None',
      expect.stringMatching(/^15 min chat · cal\.com\//),
      expect.stringMatching(/^30 min coffee chat · cal\.com\//),
      'Other link…',
    ]);
    expect(f.host.querySelector('#lim-sched')).toBeNull();
    // picking another event type saves its link
    const thirty = [...select.options].find((o) => o.textContent?.startsWith('30 min'))!.value;
    await choose(select, thirty);
    expect(f.value).toBe(thirty);
    // Other link… shows the text field, and what is typed is saved
    await choose(select, '__other');
    const input = f.host.querySelector('#lim-sched') as HTMLInputElement;
    expect(input).not.toBeNull();
    f.unmount();
  });
});
