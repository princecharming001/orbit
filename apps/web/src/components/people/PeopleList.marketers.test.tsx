/**
 * People, Hidden: someone Orbit set aside as a marketer says so on their row, and anyone hidden comes back in one tap.
 */
import type { Person } from '@orbit/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../../db/schema';

vi.mock('../CompanyLogo', () => ({ LogoText: ({ text }: { text?: string }) => <span>{text}</span> }));

import { PeopleList } from './PeopleList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const at = '2026-11-24T12:00:00.000Z';
const person = (id: string, name: string, over: Partial<Person> = {}): Person =>
  ({
    id,
    userId: 'u1',
    displayName: name,
    firstName: name.split(' ')[0],
    nameNormalized: name.toLowerCase(),
    emails: [],
    tags: [],
    relationshipType: 'unknown',
    sources: ['linkedin'],
    isHuman: true,
    strength: 0.1,
    interactionCount: 1,
    createdAt: at,
    updatedAt: at,
    ...over,
  }) as Person;

beforeEach(async () => {
  await wipeDatabase();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function show(people: Person[]) {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <PeopleList people={people} chatFor={() => undefined} nextFor={() => undefined} move={() => {}} />
      </MemoryRouter>,
    ),
  );
}

describe('hidden people in the list', () => {
  it('a marketer says so; someone hidden by hand, and someone not hidden, do not', async () => {
    await show([
      person('m', 'Grow Fast', { hiddenAt: at, hiddenReason: 'marketer' }),
      person('h', 'Hidden By Hand', { hiddenAt: at }),
      person('k', 'Brought Back', { hiddenReason: 'kept' }),
    ]);
    const rows = [...host.querySelectorAll('table tbody tr')];
    expect(rows.map((r) => r.textContent?.includes('Marketer'))).toEqual([true, false, false]);
    // hidden rows offer the way back, the others offer a chat
    expect(rows.map((r) => !!r.querySelector('[data-testid="list-bring-back"]'))).toEqual([
      true,
      true,
      false,
    ]);
    expect(rows.map((r) => !!r.querySelector('[data-testid="list-start-chat"]'))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('Bring back unhides them', async () => {
    const p = person('m', 'Grow Fast', { hiddenAt: at, hiddenReason: 'marketer' });
    await db.people.add(p);
    await show([p]);
    await act(async () =>
      (host.querySelector('table [data-testid="list-bring-back"]') as HTMLButtonElement).click(),
    );
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect((await db.people.get('m'))!.hiddenAt).toBeUndefined();
  });
});
