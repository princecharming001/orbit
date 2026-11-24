import type { Person, User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentUserId } from '../db/repo';
import { db, wipeDatabase } from '../db/schema';
import { draftTypedMessage } from '../engine/brief';
import { refreshSyncStatus, serverIdOf } from '../engine/serverSync';
import { SessionProvider, useSession } from '../state/session';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import type { FakeOrbitApi } from '../test/fakeOrbitApi';
import { ToastProvider, useToast } from '../ui';
import { runApproval } from './approve';
import { DraftEditor } from './DraftEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The founder's screen: a first message to a LinkedIn connection, written in Orbit by a student signed in to an Orbit
 * account with LinkedIn linked. Send has to send it, in the app, on that tap. LinkedIn opens only when the student
 * picks the paste route, which is offered second, beside the reason and the fix, when Orbit cannot send it itself.
 */

const PERSON_ID = 'p_9b1d4f6a-0c2e-4a7b-8d35-6e2f1a9c4b70';
const TEXT = 'hey kelly, hope things are good.';
let api: FakeOrbitApi;
let user: User;
let draftId: string;
let opened: ReturnType<typeof vi.fn>;

const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};
const until = async (fn: () => boolean, what: string) => {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await settle(1);
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** The editor as a page holds it: the draft read live, approval through the same helper every screen uses. */
function Harness({ id }: { id: string }) {
  const { user: me } = useSession();
  const toast = useToast();
  const draft = useLiveQuery(() => db.outbound.get(id), [id]);
  if (!me || !draft) return null;
  return (
    <DraftEditor
      draft={draft}
      onApprove={(body, subject) => runApproval(me, draft, body, subject, toast, 'Kelly')}
    />
  );
}

async function mount() {
  await setCurrentUserId(user.id);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/people/kelly']}>
        <SessionProvider>
          <ToastProvider>
            <Harness id={draftId} />
          </ToastProvider>
        </SessionProvider>
      </MemoryRouter>,
    ),
  );
  await until(() => !!host.querySelector('textarea'), 'the editor');
  await settle();
  return {
    host,
    q: (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`),
    button: (label: RegExp) =>
      [...host.querySelectorAll<HTMLElement>('button, a')].find((b) => label.test(b.textContent ?? '')),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const click = async (el: HTMLElement | undefined | null) => {
  if (!el) throw new Error('nothing to click');
  await act(async () => el.click());
  await settle();
};
const approvals = () => api.calls.filter((c) => c.route === '/drafts/approve');

beforeEach(async () => {
  await wipeDatabase();
  ({ api, user } = (await signInToFakeApi()) as unknown as { api: FakeOrbitApi; user: User });
  const at = '2026-11-20T12:00:00.000Z';
  await db.people.put({
    id: PERSON_ID,
    userId: user.id,
    displayName: 'Kelly Gieryn',
    firstName: 'Kelly',
    lastName: 'Gieryn',
    nameNormalized: 'kelly gieryn',
    emails: [],
    linkedinSlug: 'kellygieryn',
    linkedinUrl: 'https://www.linkedin.com/in/kellygieryn',
    linkedinConnectedOn: '2025-03-02',
    tieScore: 40,
    relationshipType: 'unknown',
    strength: 0.4,
    interactionCount: 0,
    sources: ['manual'],
    isHuman: true,
    tags: [],
    createdAt: at,
    updatedAt: at,
  } as Person);
  draftId = (await draftTypedMessage(user, PERSON_ID, 'linkedin', TEXT))!.id;
  opened = vi.fn(() => ({ opener: null }));
  vi.stubGlobal('open', opened);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  await leaveFakeApi();
});

describe('a LinkedIn message written in Orbit, on an Orbit account', () => {
  it('the box says where the message goes with a small sign: LinkedIn here, the Gmail logo on an email', async () => {
    const ui = await mount();
    // a card has no To line, so the sign stands by the buttons; it is named for a screen reader and on hover
    const mark = ui.q('draft-channel');
    expect(mark?.dataset.channel).toBe('linkedin');
    expect(mark?.getAttribute('aria-label')).toBe('LinkedIn message');
    expect(mark?.getAttribute('title')).toBe('LinkedIn message');
    ui.unmount();
    // the same draft as an email shows the Gmail logo instead
    await db.outbound.update(draftId, { channel: 'gmail', subject: 'Hello' });
    const mail = await mount();
    const sign = mail.q('draft-channel');
    expect(sign?.dataset.channel).toBe('gmail');
    expect(sign?.getAttribute('aria-label')).toBe('Email');
    expect(sign?.querySelector('svg')).toBeTruthy();
    mail.unmount();
    // a message with no inbox of its own (copied to the clipboard) shows no sign rather than a wrong one
    await db.outbound.update(draftId, { channel: 'clipboard' });
    const copy = await mount();
    expect(copy.q('draft-channel')).toBeNull();
    copy.unmount();
  });

  it('LinkedIn linked: Send sends it from Orbit on that one tap, and LinkedIn is never opened', async () => {
    api.state.linkedin.status = 'active';
    await refreshSyncStatus();
    const ui = await mount();
    const send = ui.button(/^Send to Kelly$/);
    expect(send, 'the Send button').toBeTruthy();
    expect(ui.q('draft-linkedin-blocked')).toBeNull();
    expect(ui.q('draft-linkedin-paste')).toBeNull();

    await click(send);
    await until(() => !!ui.q('outbox-sent'), 'the sent state');
    expect(approvals()).toHaveLength(1);
    expect(approvals()[0]!.body).toMatchObject({
      draftId: serverIdOf(draftId),
      body: TEXT,
      confirm: true,
      write: { kind: 'reply', channel: 'linkedin' },
    });
    expect(opened).not.toHaveBeenCalled();
    expect(ui.host.textContent).not.toMatch(/Paste it into LinkedIn/);
    expect(ui.q('outbox-handed_off')).toBeNull();
    expect((await db.outbound.get(draftId))?.status).toBe('sent');
    ui.unmount();
  });

  it('a link made a minute ago counts: the button says Send without a reload', async () => {
    // what this browser last heard: not connected. Then LinkedIn is linked in Settings.
    await refreshSyncStatus();
    api.state.linkedin.status = 'active';
    const ui = await mount();
    await until(() => !!ui.button(/^Send to Kelly$/), 'Send after the fresh look');
    expect(ui.q('draft-linkedin-blocked')).toBeNull();
    ui.unmount();
  });

  it('not connected: the reason and Reconnect come first, pasting it second, and nothing opens until asked', async () => {
    await refreshSyncStatus();
    const ui = await mount();
    await until(() => !!ui.q('draft-linkedin-blocked'), 'the reason');
    expect(ui.q('draft-linkedin-blocked')!.textContent).toBe(
      'LinkedIn is not connected. Reconnect it to send from Orbit.',
    );
    // the fix is the main action, a link to Settings, Integrations
    const fix = ui.q('draft-linkedin-fix') as HTMLAnchorElement;
    expect(fix.textContent).toBe('Reconnect LinkedIn');
    expect(fix.getAttribute('href')).toBe('/settings/integrations');
    expect(fix.className).toMatch(/bg-accent/);
    // Send is not offered as if it would work, and pasting is the second button, not the main one
    expect(ui.button(/^Send to Kelly$/)).toBeUndefined();
    const paste = ui.q('draft-linkedin-paste')!;
    expect(paste.textContent).toBe('Copy & open LinkedIn');
    expect(paste.className).not.toMatch(/bg-accent/);
    expect(opened).not.toHaveBeenCalled();
    expect((await db.outbound.get(draftId))?.status).toBe('draft');
    for (const el of [ui.q('draft-linkedin-blocked')!, fix, paste])
      expect(el.textContent).not.toMatch(/[—–!]/);

    // the student picks the paste route: only now does LinkedIn open, and the message waits for "I sent it"
    await click(paste);
    await until(() => !!ui.q('outbox-handed_off'), 'the hand-off');
    expect(opened).toHaveBeenCalledTimes(1);
    expect(String(opened.mock.calls[0]![0])).toMatch(/linkedin\.com/);
    expect(approvals()).toHaveLength(0);
    ui.unmount();
  });

  it('a send LinkedIn refused: the error shows, the words stay, and pasting is offered beside Send', async () => {
    api.state.linkedin.status = 'active';
    api.state.linkedin.sendError = 'unipile_422';
    await refreshSyncStatus();
    const ui = await mount();
    await click(ui.button(/^Send to Kelly$/));
    await until(
      () => /Not sent: LinkedIn would not take this message/.test(ui.host.textContent ?? ''),
      'the error',
    );
    expect(ui.host.querySelector('textarea')!.value).toBe(TEXT);
    expect(ui.q('outbox-handed_off')).toBeNull();
    expect(opened).not.toHaveBeenCalled();
    // Send is still the main action; the paste route is there as the other way
    expect(ui.button(/^Send to Kelly$/)).toBeTruthy();
    expect(ui.q('draft-linkedin-paste')!.textContent).toBe('Copy & open LinkedIn');
    expect((await db.outbound.get(draftId))?.status).toBe('failed');
    ui.unmount();
  });

  it('the link dropped since the page loaded: Send says so with Reconnect, instead of opening LinkedIn', async () => {
    api.state.linkedin.status = 'active';
    await refreshSyncStatus();
    const ui = await mount();
    const send = ui.button(/^Send to Kelly$/);
    // parked on the server while this page was open
    api.state.linkedin.status = 'parked';
    api.state.linkedin.sendError = 'linkedin_not_connected';
    await click(send);
    await until(() => !!ui.q('draft-linkedin-blocked'), 'the reason');
    expect(ui.q('draft-linkedin-blocked')!.textContent).toBe(
      'LinkedIn is paused because you were away. Reconnect it to send from Orbit.',
    );
    expect(ui.q('draft-linkedin-fix')!.textContent).toBe('Reconnect LinkedIn');
    expect(ui.q('draft-linkedin-paste')).toBeTruthy();
    // said once: the same sentence is not repeated as an error under it
    expect(ui.host.textContent!.match(/LinkedIn is paused/g)).toHaveLength(1);
    expect(opened).not.toHaveBeenCalled();
    expect(ui.q('outbox-handed_off')).toBeNull();
    ui.unmount();
  });
});
