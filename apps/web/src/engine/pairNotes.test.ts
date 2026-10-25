/**
 * Plan 21 §3.5: the student's word on a pair — kept here, one kind at a time, and in account mode told to the server,
 * which ranks routes for the chat too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wipeDatabase } from '../db/schema';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import type { FakeOrbitApi } from '../test/fakeOrbitApi';
import { clearPairNote, pairNoteOf, pairNotesFor, setPairNote, subscribePairNotes } from './pairNotes';

describe('pair notes', () => {
  beforeEach(async () => {
    await wipeDatabase();
  });

  it('keeps one kind per pair, in either order of the two people, and tells listeners', async () => {
    const heard = vi.fn();
    const off = subscribePairNotes(heard);
    await setPairNote('u1', 'p_b', 'p_a', 'blocked');
    expect(await pairNoteOf('u1', 'p_a', 'p_b')).toBe('blocked');
    expect((await pairNotesFor('u1')).blocked).toEqual(new Set(['p_a|p_b']));
    await setPairNote('u1', 'p_a', 'p_b', 'close');
    expect(await pairNoteOf('u1', 'p_b', 'p_a')).toBe('close');
    expect((await pairNotesFor('u1')).blocked.size).toBe(0);
    await clearPairNote('u1', 'p_b', 'p_a', 'close');
    expect(await pairNoteOf('u1', 'p_a', 'p_b')).toBeUndefined();
    expect(heard).toHaveBeenCalledTimes(3);
    off();
    // a person is never paired with themself
    await setPairNote('u1', 'p_a', 'p_a', 'blocked');
    expect((await pairNotesFor('u1')).blocked.size).toBe(0);
  });

  describe('in account mode', () => {
    let api: FakeOrbitApi;
    let userId: string;
    beforeEach(async () => {
      const s = await signInToFakeApi();
      api = s.api;
      userId = s.user.id;
    });
    afterEach(async () => {
      await leaveFakeApi();
    });

    it('sends each change to /pairs/*, the pair in order', async () => {
      await setPairNote(userId, 'p_b', 'p_a', 'blocked');
      await clearPairNote(userId, 'p_a', 'p_b', 'blocked');
      await setPairNote(userId, 'p_a', 'p_b', 'close');
      await clearPairNote(userId, 'p_a', 'p_b', 'close');
      await vi.waitFor(() =>
        expect(api.calls.filter((c) => c.route.startsWith('/pairs/')).map((c) => [c.route, c.body])).toEqual([
          ['/pairs/block', { aPersonId: 'p_a', bPersonId: 'p_b' }],
          ['/pairs/unblock', { aPersonId: 'p_a', bPersonId: 'p_b' }],
          ['/pairs/close', { aPersonId: 'p_a', bPersonId: 'p_b' }],
          ['/pairs/unclose', { aPersonId: 'p_a', bPersonId: 'p_b' }],
        ]),
      );
    });
  });
});
