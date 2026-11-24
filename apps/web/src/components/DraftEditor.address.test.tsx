import type { Person, User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setCurrentUserId } from '../db/repo';
import { db, wipeDatabase } from '../db/schema';
import { draftTypedMessage } from '../engine/brief';
import { SessionProvider, useSession } from '../state/session';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import { ToastProvider } from '../ui';
import { DraftEditor } from './DraftEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * An email to someone Orbit found an address for (plan 35 C3). Where the recipient is shown before the send, an
 * address Orbit built or guessed says so; an address from the student's own mail, or a verified one, says nothing.
 */

const PERSON_ID = 'p_3c7e1a52-9b0d-4f6e-8a14-2d5b7c9e0f31';
let user: User;
let draftId: string;

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

function Harness({ id }: { id: string }) {
  const { user: me } = useSession();
  const draft = useLiveQuery(() => db.outbound.get(id), [id]);
  if (!me || !draft) return null;
  return <DraftEditor draft={draft} thread onApprove={async () => undefined} />;
}

async function mount() {
  await setCurrentUserId(user.id);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/people/jo']}>
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
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

beforeEach(async () => {
  await wipeDatabase();
  ({ user } = (await signInToFakeApi()) as unknown as { user: User });
  const at = '2026-11-20T12:00:00.000Z';
  await db.people.put({
    id: PERSON_ID,
    userId: user.id,
    displayName: 'Jo Park',
    firstName: 'Jo',
    lastName: 'Park',
    nameNormalized: 'jo park',
    primaryEmail: 'jo.park@beta.io',
    emailConfidence: 'guess',
    emails: ['jo.park@beta.io'],
    relationshipType: 'unknown',
    strength: 0,
    interactionCount: 0,
    sources: ['manual'],
    isHuman: true,
    tags: [],
    createdAt: at,
    updatedAt: at,
  } as Person);
  draftId = (await draftTypedMessage(user, PERSON_ID, 'gmail', 'Hi Jo, a question about your team.'))!.id;
});
afterEach(async () => {
  document.body.innerHTML = '';
  await leaveFakeApi();
});

describe('the To line of an email to a sourced person', () => {
  it('a guessed address is shown with a quiet note that it is not confirmed', async () => {
    const ui = await mount();
    expect(ui.q('draft-to')?.textContent).toBe('jo.park@beta.io');
    const note = ui.q('draft-to-note');
    expect(note?.textContent).toBe('Guessed address, not confirmed');
    expect(note?.className).toMatch(/text-ink-3/);
    ui.unmount();
  });

  it('an address built from the company pattern gets the same note; a verified one gets none', async () => {
    await db.people.update(PERSON_ID, { emailConfidence: 'pattern' });
    const built = await mount();
    expect(built.q('draft-to-note')?.textContent).toBe('Guessed address, not confirmed');
    built.unmount();
    await db.people.update(PERSON_ID, { emailConfidence: 'verified' });
    const sure = await mount();
    expect(sure.q('draft-to')?.textContent).toBe('jo.park@beta.io');
    expect(sure.q('draft-to-note')).toBeNull();
    sure.unmount();
  });

  it('an address from the student’s own mail (nothing kept about how it was found) gets no note', async () => {
    await db.people.update(PERSON_ID, { emailConfidence: undefined });
    const ui = await mount();
    expect(ui.q('draft-to-note')).toBeNull();
    ui.unmount();
  });
});
