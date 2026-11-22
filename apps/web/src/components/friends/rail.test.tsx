import type { Friend, FriendInvite } from '@orbit/core';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../ui';
import { friendStatus } from './FriendRow';
import {
  FriendsListSection,
  InviteLinkSection,
  RAIL_FOLDED,
  RequestedSection,
  RequestsSection,
  requestedLine,
} from './Rail';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LINK = 'https://tryorbit.today/friends/join/standinglink0000000001';
const DASH_OR_BANG = /[—–!]/;

let unmount: (() => void) | undefined;
let written: string[];
beforeEach(() => {
  written = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn(async (t: string) => {
        written.push(t);
      }),
    },
  });
});
afterEach(() => {
  unmount?.();
  unmount = undefined;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const q = (id: string, within: ParentNode = document.body) =>
  within.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const all = (id: string, within: ParentNode = document.body) =>
  [...within.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
const tap = (el: HTMLElement | null) => act(async () => el!.click());

async function mount(ui: ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  unmount = () => act(() => root.unmount());
  const render = (node: ReactNode) =>
    act(async () =>
      root.render(
        <MemoryRouter>
          <ToastProvider>{node}</ToastProvider>
        </MemoryRouter>,
      ),
    );
  await render(ui);
  return render;
}

const friend = (n: number, over: Partial<Friend> = {}): Friend => ({
  friendshipId: `fr_${n}`,
  userId: `u_${n}`,
  name: `Friend Number${n}`,
  school: null,
  gradYear: null,
  avatarUrl: null,
  shares: 12,
  atTargets: 0,
  knowsAt: [],
  myMode: 'all',
  myCompanyDomains: [],
  since: '2026-10-01T00:00:00.000Z',
  network: 'ready',
  ...over,
});

const invite = (id: string, over: Partial<FriendInvite> = {}): FriendInvite => ({
  id,
  direction: 'out',
  email: null,
  name: null,
  status: 'pending',
  createdAt: '2026-10-06T08:00:00.000Z',
  ...over,
});

describe('the invite link', () => {
  it('shows the link in one field without its scheme, and Copy puts the whole link on the clipboard', async () => {
    await mount(<InviteLinkSection link={LINK} onReset={() => undefined} />);
    const section = q('friends-invite-link')!;
    expect(section.querySelector('h2')!.textContent).toBe('Invite link');
    expect(section.textContent).toContain('Share it in a group chat to add friends.');
    const text = q('friends-link-text')!;
    expect(text.textContent).toBe('tryorbit.today/friends/join/standinglink0000000001');
    // one line, cut with an ellipsis when the column is narrow; the whole link is still there to read
    expect(text.className).toContain('truncate');
    expect(text.getAttribute('title')).toBe(LINK);
    const copy = q('friends-invite-copy')!;
    expect(copy.textContent).toBe('Copy');
    expect(copy.querySelector('svg')).not.toBeNull();
    // the button sits inside the field, to the right of the link
    expect(copy.parentElement).toBe(text.parentElement);
    await tap(copy);
    expect(written).toEqual([LINK]);
    expect(q('friends-invite-copy')!.textContent).toBe('Copied');
    expect(q('toasts')!.textContent).toContain('Link copied');
  });

  it('a clipboard that refuses still gets the student the link, in a toast', async () => {
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('denied'));
    await mount(<InviteLinkSection link={LINK} onReset={() => undefined} />);
    await tap(q('friends-invite-copy'));
    expect(q('toasts')!.textContent).toContain(LINK);
    expect(q('friends-invite-copy')!.textContent).toBe('Copy');
  });

  it('before the link has loaded there is a placeholder, nothing to copy and nothing to reset', async () => {
    await mount(<InviteLinkSection onReset={() => undefined} />);
    expect(q('friends-link-text')).toBeNull();
    expect(q('friends-invite-copy')).toBeNull();
    expect((q('friends-invite-reset') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Reset link asks first, in the page: Cancel and Escape leave the link alone', async () => {
    const onReset = vi.fn();
    const native = vi.spyOn(window, 'confirm');
    await mount(<InviteLinkSection link={LINK} onReset={onReset} />);
    const reset = q('friends-invite-reset')!;
    expect(reset.textContent).toBe('Reset link');
    // beside the heading, on its right
    expect(reset.parentElement).toBe(q('friends-invite-link')!.querySelector('h2')!.parentElement);
    await tap(reset);
    expect(onReset).not.toHaveBeenCalled();
    const ask = q('friends-invite-reset-ask')!;
    expect(ask.textContent).toBe('Reset? The old link stops working.ResetCancel');
    expect(ask.textContent).not.toMatch(DASH_OR_BANG);
    // the question stands in for the Reset link button, and the keyboard is on the safe answer
    expect(q('friends-invite-reset')).toBeNull();
    expect(document.activeElement).toBe(q('friends-invite-reset-cancel'));
    await tap(q('friends-invite-reset-cancel'));
    expect(q('friends-invite-reset-ask')).toBeNull();
    expect(onReset).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(q('friends-invite-reset'));
    expect(q('friends-invite-link')!.textContent).toContain('Share it in a group chat to add friends.');
    await tap(q('friends-invite-reset'));
    await act(async () => {
      q('friends-invite-reset-ask')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(q('friends-invite-reset-ask')).toBeNull();
    expect(onReset).not.toHaveBeenCalled();
    // never the browser's own dialog
    expect(native).not.toHaveBeenCalled();
  });

  it('Reset runs once on the second tap, holds the question while it works, and shows the new link', async () => {
    let done!: () => void;
    const onReset = vi.fn(
      () =>
        new Promise<void>((r) => {
          done = r;
        }),
    );
    const render = await mount(<InviteLinkSection link={LINK} onReset={onReset} />);
    await tap(q('friends-invite-reset'));
    await tap(q('friends-invite-reset-confirm'));
    expect(onReset).toHaveBeenCalledTimes(1);
    // still working: a second tap does nothing and there is no backing out half way
    const confirm = q('friends-invite-reset-confirm') as HTMLButtonElement;
    expect(confirm.getAttribute('aria-busy')).toBe('true');
    expect(confirm.disabled).toBe(true);
    expect((q('friends-invite-reset-cancel') as HTMLButtonElement).disabled).toBe(true);
    await tap(confirm);
    expect(onReset).toHaveBeenCalledTimes(1);
    await act(async () => done());
    await render(
      <InviteLinkSection
        link="https://tryorbit.today/friends/join/newlink00000000000002"
        onReset={onReset}
      />,
    );
    expect(q('friends-invite-reset-ask')).toBeNull();
    expect(q('friends-invite-reset')).not.toBeNull();
    expect(q('friends-link-text')!.textContent).toBe('tryorbit.today/friends/join/newlink00000000000002');
  });

  it('a reset that fails closes the question and keeps the old link', async () => {
    const onReset = vi.fn(async () => {
      throw new Error('offline');
    });
    await mount(<InviteLinkSection link={LINK} onReset={onReset} />);
    await tap(q('friends-invite-reset'));
    await tap(q('friends-invite-reset-confirm'));
    expect(q('friends-invite-reset-ask')).toBeNull();
    expect(q('toasts')!.textContent).toContain('The link was not reset. Try again.');
    expect(q('friends-link-text')!.textContent).toContain('standinglink0000000001');
  });

  it('keeps the invite by email under the link', async () => {
    await mount(
      <InviteLinkSection link={LINK} onReset={() => undefined}>
        <div data-testid="email-box" />
      </InviteLinkSection>,
    );
    const field = q('friends-link-text')!.parentElement!;
    expect(field.compareDocumentPosition(q('email-box')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('Requested', () => {
  const PHOTO = 'https://example.com/jordan.jpg';
  const pending: FriendInvite[] = [
    invite('fs_jordan', { name: 'Jordan Ellis', avatarUrl: PHOTO, personId: 'p_jordan' }),
    invite('fs_marcus', { name: 'Marcus Wei', linkedinUrl: 'https://www.linkedin.com/in/marcus-wei' }),
    invite('inv_noah', { email: 'noah.patel@cornell.edu' }),
    // waiting on the student, not sent by them: it belongs under Requests
    invite('fs_priya', { direction: 'in', name: 'Priya Shah' }),
    // answered already: not waiting on anyone
    invite('inv_old', { email: 'old@example.org', status: 'declined' }),
  ];

  it('lists what the student sent and nobody answered: the count, a square photo, the name, a grey line', async () => {
    await mount(<RequestedSection pending={pending} />);
    const section = q('friends-requested')!;
    expect(section.querySelector('h2')!.textContent).toBe('Requested3');
    expect(q('friends-requested-count')!.textContent).toBe('3');
    const rows = all('friends-requested-row');
    expect(rows.map((r) => q('friends-requested-row-name', r)!.textContent)).toEqual([
      'Jordan Ellis',
      'Marcus Wei',
      'noah.patel@cornell.edu',
    ]);
    expect(rows.map((r) => q('friends-requested-row-line', r)!.textContent)).toEqual([
      'Request sent',
      'Request sent',
      'Invited, not on Orbit yet',
    ]);
    expect(section.textContent).not.toContain('Priya Shah');
    expect(section.textContent).not.toMatch(DASH_OR_BANG);
    // a photo when they have one, their initials on a colour when not; square with rounded corners either way
    const [jordan, marcus] = rows;
    expect(jordan!.querySelector('img')!.getAttribute('src')).toBe(PHOTO);
    expect(marcus!.querySelector('img')).toBeNull();
    expect(marcus!.querySelector('[data-shape="square"]')!.textContent).toBe('MW');
    for (const r of rows) {
      const box = r.querySelector('[data-shape="square"]') as HTMLElement;
      expect(box.style.width).toBe('56px');
      expect(box.style.height).toBe('56px');
    }
    // the name opens their page in Orbit, else their LinkedIn in a new tab, else it is plain text
    expect(q('friends-requested-row-name', jordan!)!.getAttribute('href')).toBe('/people/p_jordan');
    const li = q('friends-requested-row-name', marcus!)!;
    expect(li.getAttribute('href')).toBe('https://www.linkedin.com/in/marcus-wei');
    expect(li.getAttribute('target')).toBe('_blank');
    expect(q('friends-requested-row-name', rows[2]!)!.tagName).toBe('DIV');
  });

  it('is not there at all when nothing is waiting', async () => {
    await mount(<RequestedSection pending={pending.filter((p) => p.direction === 'in')} />);
    expect(q('friends-requested')).toBeNull();
  });

  it('folds a long list to five, with See more', async () => {
    const many = Array.from({ length: 8 }, (_, i) => invite(`fs_${i}`, { name: `Pat Number${i}` }));
    await mount(<RequestedSection pending={many} />);
    expect(all('friends-requested-row')).toHaveLength(RAIL_FOLDED);
    expect(q('friends-requested-count')!.textContent).toBe('8');
    await tap(q('friends-requested-more'));
    expect(all('friends-requested-row')).toHaveLength(8);
  });

  it('says only what is known of each one', () => {
    expect(requestedLine(invite('a', { name: 'Jordan Ellis' }))).toBe('Request sent');
    expect(requestedLine(invite('b', { email: 'noah@example.org' }))).toBe('Invited, not on Orbit yet');
  });
});

describe('Requests waiting on the student', () => {
  it('shows who asked with Accept and Decline, and nothing they sent themselves', async () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    const priya = invite('fs_priya', { direction: 'in', name: 'Priya Shah' });
    await mount(
      <RequestsSection
        pending={[priya, invite('fs_jordan', { name: 'Jordan Ellis' })]}
        onAccept={onAccept}
        onDecline={onDecline}
      />,
    );
    const section = q('friends-requests')!;
    expect(section.querySelector('h2')!.textContent).toBe('Requests1');
    expect(all('friend-request')).toHaveLength(1);
    expect(section.textContent).toContain('Priya Shah');
    expect(section.textContent).not.toContain('Jordan Ellis');
    await tap(q('friend-request-accept'));
    expect(onAccept).toHaveBeenCalledWith(priya);
    await tap(q('friend-request-decline'));
    expect(onDecline).toHaveBeenCalledWith(priya);
  });
});

describe('Your friends', () => {
  it('each row: a square photo, the name, and where their network stands', async () => {
    const onOpen = vi.fn();
    const friends = [
      friend(1, { name: 'Ana Okafor', personId: 'p_ana', avatarUrl: 'https://example.com/ana.jpg' }),
      friend(2, { name: 'Ben Ito', network: 'syncing', linkedinUrl: 'https://www.linkedin.com/in/ben-ito' }),
      friend(3, { name: 'Cara Diaz', network: 'not_sharing', shares: 0 }),
      friend(4, { name: 'Dev Rao', network: 'empty', shares: 0 }),
    ];
    await mount(<FriendsListSection friends={friends} loading={false} onOpen={onOpen} />);
    const section = q('friends-yours')!;
    expect(section.querySelector('h2')!.textContent).toBe('Your friends4');
    expect(q('friends-yours-count')!.textContent).toBe('4');
    const rows = all('friends-yours-row');
    expect(rows.map((r) => q('friends-yours-row-name', r)!.textContent)).toEqual([
      'Ana Okafor',
      'Ben Ito',
      'Cara Diaz',
      'Dev Rao',
    ]);
    expect(rows.map((r) => q('friends-yours-row-line', r)!.textContent)).toEqual([
      'Ready to search',
      'Still syncing',
      'Not sharing their network',
      'Nothing to search yet',
    ]);
    expect(section.textContent).not.toMatch(DASH_OR_BANG);
    expect(rows[0]!.querySelector('img')!.getAttribute('src')).toBe('https://example.com/ana.jpg');
    expect(rows[1]!.querySelector('[data-shape="square"]')!.textContent).toBe('BI');
    // names lead to the person where there is somewhere to go
    expect(q('friends-yours-row-name', rows[0]!)!.getAttribute('href')).toBe('/people/p_ana');
    expect(q('friends-yours-row-name', rows[1]!)!.getAttribute('href')).toBe(
      'https://www.linkedin.com/in/ben-ito',
    );
    expect(q('friends-yours-row-name', rows[2]!)!.tagName).toBe('DIV');
    // the photo jumps to the friend's full row further down the page
    await tap(q('friends-yours-row-photo', rows[1]!));
    expect(onOpen).toHaveBeenCalledWith(friends[1]);
    // four friends: nothing more to show, so no button
    expect(q('friends-yours-more')).toBeNull();
    expect(q('friends-yours-fewer')).toBeNull();
  });

  it('five by default; See more shows everyone and turns to See fewer', async () => {
    const friends = Array.from({ length: 7 }, (_, i) => friend(i + 1));
    const render = await mount(<FriendsListSection friends={friends} loading={false} onOpen={() => {}} />);
    expect(all('friends-yours-row')).toHaveLength(5);
    expect(q('friends-yours-count')!.textContent).toBe('7');
    const more = q('friends-yours-more')!;
    expect(more.textContent).toBe('See more');
    // on the right of the heading
    expect(more.parentElement).toBe(q('friends-yours')!.querySelector('h2')!.parentElement);
    await tap(more);
    expect(all('friends-yours-row')).toHaveLength(7);
    expect(q('friends-yours-more')).toBeNull();
    expect(q('friends-yours-fewer')!.textContent).toBe('See fewer');
    await tap(q('friends-yours-fewer'));
    expect(all('friends-yours-row')).toHaveLength(5);
    // exactly five: all of them show and the button is gone
    await render(<FriendsListSection friends={friends.slice(0, 5)} loading={false} onOpen={() => {}} />);
    expect(all('friends-yours-row')).toHaveLength(5);
    expect(q('friends-yours-more')).toBeNull();
    expect(q('friends-yours-fewer')).toBeNull();
  });

  it('nobody yet says so; while the list loads there are placeholders and no made-up count', async () => {
    const render = await mount(<FriendsListSection friends={[]} loading onOpen={() => {}} />);
    expect(q('friends-empty')).toBeNull();
    expect(q('friends-yours-count')).toBeNull();
    expect(q('friends-yours')!.querySelector('[aria-busy]')).not.toBeNull();
    await render(<FriendsListSection friends={[]} loading={false} onOpen={() => {}} />);
    expect(q('friends-yours-count')!.textContent).toBe('0');
    expect(q('friends-empty')!.textContent).toBe('None yet. People who accept show up here.');
    expect(q('friends-yours-more')).toBeNull();
  });

  it('the status line never says more than the server did', () => {
    expect(friendStatus(friend(1, { network: 'ready' }))).toBe('Ready to search');
    expect(friendStatus(friend(1, { network: 'syncing' }))).toBe('Still syncing');
    expect(friendStatus(friend(1, { network: 'empty' }))).toBe('Nothing to search yet');
    expect(friendStatus(friend(1, { network: 'not_sharing' }))).toBe('Not sharing their network');
    // a row kept from before the server said: what it shares, which it always knew
    expect(friendStatus(friend(1, { network: undefined, shares: 1 }))).toBe('shares 1 person');
    expect(friendStatus(friend(1, { network: undefined, shares: 120, atTargets: 6 }))).toBe(
      'shares 120 people · 6 at your targets',
    );
  });
});
