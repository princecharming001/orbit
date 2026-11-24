/**
 * Invite by email, under the invite link. Two things went wrong here: a second tap (or Enter and a click) made a
 * second invite to the same address, and an invite whose email never went out said nothing different from one that
 * did. One tap sends once, and the words say what happened: sent and from where, already invited, or not sent and
 * what to do.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../ui';
import { InviteBox, type InviteOutcome, inviteSaid } from './InviteBox';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});
const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function type(value: string) {
  const input = q('friends-invite-email') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const LINK = 'https://tryorbit.today/friends/join/abc';
async function show(onInvite: (email?: string) => Promise<InviteOutcome | undefined>) {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ToastProvider>
          <InviteBox onInvite={onInvite} />
        </ToastProvider>
      </MemoryRouter>,
    ),
  );
}

describe('Invite by email', () => {
  it('a second tap while the first is out, and Enter with a click, send one invite', async () => {
    let done: (r: InviteOutcome) => void = () => {};
    const onInvite = vi.fn(() => new Promise<InviteOutcome>((r) => (done = r)));
    await show(onInvite);
    await type('noah@example.org');
    const form = host.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      q('friends-invite-send')!.click();
    });
    expect(onInvite).toHaveBeenCalledTimes(1);
    expect(onInvite).toHaveBeenCalledWith('noah@example.org');
    // the button waits with it
    expect((q('friends-invite-send') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => done({ link: LINK, status: 'sent', via: 'gmail' }));
    expect((q('friends-invite-email') as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).toContain('Invite sent to noah@example.org from your Gmail.');
    // sent: no link to pass on
    expect(q('friends-invite-link-text')).toBeNull();
    // and the next address can go
    await type('lee@example.org');
    await act(async () => q('friends-invite-send')!.click());
    expect(onInvite).toHaveBeenCalledTimes(2);
  });

  it('no email went out: says so, and shows the link to send by hand', async () => {
    await show(async () => ({ link: LINK, status: 'link', notSent: 'failed' }));
    await type('noah@example.org');
    await act(async () => q('friends-invite-send')!.click());
    expect(document.body.textContent).toContain('The email to noah@example.org did not go out.');
    expect(q('friends-invite-link-text')!.textContent).toBe(LINK);
  });

  it('a failed invite keeps the address typed, so the student can try again', async () => {
    await show(async () => undefined);
    await type('noah@example.org');
    await act(async () => q('friends-invite-send')!.click());
    expect((q('friends-invite-email') as HTMLInputElement).value).toBe('noah@example.org');
    expect((q('friends-invite-send') as HTMLButtonElement).disabled).toBe(false);
  });

  it('the words for each outcome', () => {
    const said = (r: Partial<InviteOutcome>) =>
      inviteSaid({ link: LINK, status: 'sent', ...r }, 'noah@example.org');
    expect(said({ via: 'gmail' })).toMatchObject({
      text: 'Invite sent to noah@example.org from your Gmail.',
      tone: 'good',
    });
    expect(said({ via: 'orbit' }).text).toBe('Invite sent to noah@example.org.');
    expect(said({ already: true })).toMatchObject({
      text: 'You already invited noah@example.org. The invite is waiting on them, so nothing was sent again.',
      tone: 'neutral',
    });
    expect(said({ status: 'requested' }).text).toBe(
      'They are on Orbit already: the request is waiting on them.',
    );
    expect(said({ status: 'requested', already: true }).text).toBe(
      'You already asked them. The request is waiting on them.',
    );
    expect(said({ status: 'link', notSent: 'failed' }).tone).toBe('bad');
    expect(said({ status: 'link', notSent: 'none' }).text).toBe(
      'Orbit could not email noah@example.org: connect Gmail in Settings, or copy the link below and send it yourself.',
    );
    // nothing here ends a sentence with an exclamation mark or uses a long dash
    for (const r of [
      { via: 'gmail' as const },
      { already: true },
      { status: 'link' as const, notSent: 'failed' as const },
    ])
      expect(said(r).text).not.toMatch(/[!—]/);
  });
});
