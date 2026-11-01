import type { User } from '@orbit/core';
import { newId } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../../db/schema';
import { createLocalUser } from '../../engine/account';
import { setOrbitApiBaseForTests } from '../../integrations/orbitApi';
import { leaveFakeApi, signInToFakeApi } from '../../test/account';
import type { FakeOrbitApi } from '../../test/fakeOrbitApi';
import { execute, modelResult } from '../registry';
import { makeCtx, nextToolUseId } from './helpers';

/**
 * The voice tools (plan 29 §B5): what Orbit learned about how the student writes, read from the server for an account
 * and from this browser otherwise, and a note forgotten by its words, never learned again. Plain sentences: no dash,
 * no exclamation mark.
 */

const DASH_OR_BANG = /[—–!]/;
const NOTES = [
  { id: 'vn_thanks', text: "You cut 'Thanks either way' every time", evidence: ['e1', 'e4', 'e9'] },
  { id: 'vn_name', text: 'You sign with your first name only', evidence: ['e3', 'e5'] },
].map((n) => ({ ...n, createdAt: '2026-10-05T03:10:00.000Z', keptAt: null, forgottenAt: null }));

describe('voice tools against the fake orbit-api', () => {
  let api: FakeOrbitApi;
  let user: User;
  const ctx = () => makeCtx(user, { toolUseId: nextToolUseId() });
  beforeEach(async () => {
    await wipeDatabase();
    ({ api, user } = await signInToFakeApi());
    api.state.voice = {
      cardProse: [
        'You greet with Hi and sign off with Thanks.',
        'You write short, with contractions and no exclamation marks.',
      ],
      notes: NOTES.map((n) => ({ ...n })),
      soundsLikeYou: 2.6,
      relearnedAt: null,
      relearnRequests: 0,
    };
  });
  afterEach(async () => {
    await leaveFakeApi();
  });

  it('list_voice_notes: the card in sentences, each note with its id, and the score', async () => {
    const env = await execute('list_voice_notes', {}, ctx());
    expect(env.kind).toBe('text');
    expect(env.summary).toMatch(/^You greet with Hi and sign off with Thanks\./);
    expect(env.summary).toContain("1) You cut 'Thanks either way' every time");
    expect(env.summary).toContain('sound like you 2.6 of 3');
    expect(env.summary).not.toMatch(DASH_OR_BANG);
    const m = modelResult('list_voice_notes', env) as { data: { notes: { id: string; edits: number }[] } };
    expect(m.data.notes).toEqual([
      { id: 'vn_thanks', text: "You cut 'Thanks either way' every time", kept: false, edits: 3 },
      { id: 'vn_name', text: 'You sign with your first name only', kept: false, edits: 2 },
    ]);
  });

  it('forget_voice_note: by the student’s words, through /voice/notes, and gone from the next list', async () => {
    const env = await execute('forget_voice_note', { note: 'the one about Thanks either way' }, ctx());
    expect(env.summary).toBe(
      `Forgotten: "You cut 'Thanks either way' every time". Orbit will not learn it again, and your drafts stop following it.`,
    );
    expect(api.state.voice.notes.find((n) => n.id === 'vn_thanks')!.forgottenAt).toBeTruthy();
    const after = await execute('list_voice_notes', {}, ctx());
    expect(after.summary).not.toContain('Thanks either way');
    // nothing named: it asks which, listing them
    const which = await execute('forget_voice_note', {}, ctx());
    expect(which.kind).toBe('text');
    expect(which.summary).toMatch(
      /^Which one should I forget\? The notes: 1\) You sign with your first name only/,
    );
  });
});

describe('voice tools in local mode', () => {
  let user: User;
  beforeEach(async () => {
    await wipeDatabase();
    setOrbitApiBaseForTests(null);
    user = await createLocalUser({ fullName: 'Alex Rivera', firstName: 'Alex' });
  });
  afterEach(() => setOrbitApiBaseForTests(undefined));

  it('says nothing is learned yet, then lists and forgets this browser’s own notes', async () => {
    const empty = await execute('list_voice_notes', {}, makeCtx(user, { toolUseId: nextToolUseId() }));
    expect(empty.summary).toMatch(/Nothing learned from your edits yet/);
    await db.settings.update(user.id, {
      voiceNotes: [{ ...NOTES[0]!, id: newId('vn') }],
    });
    const env = await execute(
      'forget_voice_note',
      { note: 'thanks either way' },
      makeCtx(user, { toolUseId: nextToolUseId() }),
    );
    expect(env.summary).toMatch(/^Forgotten:/);
    expect((await db.settings.get(user.id))!.voiceNotes![0]!.forgottenAt).toBeTruthy();
    const none = await execute(
      'forget_voice_note',
      { note: 'emoji' },
      makeCtx(user, { toolUseId: nextToolUseId() }),
    );
    expect(none.summary).toMatch(/^No note of mine matches "emoji"/);
    expect(none.summary).not.toMatch(DASH_OR_BANG);
  });
});
