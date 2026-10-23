/**
 * The chat remembers the student in this browser (plan 17 §G): remember, recall and forget work without an Orbit
 * account, a statement in chat is kept after the turn (router mode, Orbit's own rules) and reaches the goals, and the
 * snapshot carries what is remembered and what the resume says that the profile does not.
 */
import type { User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../../db/schema';
import { createLocalUser } from '../../engine/account';
import { localMemories } from '../../engine/memoryLocal';
import { saveResume } from '../../engine/resume';
import { setOrbitApiBaseForTests } from '../../integrations/orbitApi';
import { clearPrefs } from '../../integrations/prefs';
import { setSharedClaudeUrlForTests } from '../../integrations/shared-claude';
import { createChatEngine } from '../agent';
import { buildSnapshot } from '../agent/snapshot';
import { ChatStore } from '../agent/store';
import { execute, modelResult, registry } from '../registry';
import type { TurnEvent } from '../types';
import { makeCtx, nextToolUseId } from './helpers';

let user: User;

beforeEach(async () => {
  await wipeDatabase();
  await clearPrefs();
  setOrbitApiBaseForTests(null);
  setSharedClaudeUrlForTests(null);
  user = await createLocalUser({ fullName: 'Alex Rivera', firstName: 'Alex', lastName: 'Rivera' });
});
afterEach(() => {
  setOrbitApiBaseForTests(undefined);
  setSharedClaudeUrlForTests(undefined);
});

const ctx = () => makeCtx(user, { toolUseId: nextToolUseId() });

describe('memory tools without an account', () => {
  it('remember saves, recall finds it, forget asks first and then deletes it', async () => {
    const saved = await execute('remember', { text: 'Prefers morning calls', kind: 'preference' }, ctx());
    expect(saved.kind).toBe('text');
    expect(saved.summary).toBe('Saved to memory.');
    const again = await execute('remember', { text: 'prefers morning calls', kind: 'preference' }, ctx());
    expect(again.summary).toBe('Already in memory; refreshed it.');
    const found = await execute('recall', { query: 'calls' }, ctx());
    expect(found.kind).toBe('list');
    const recalled = modelResult('recall', found).data as { memories: { text: string }[] };
    expect(recalled.memories.map((i) => i.text)).toEqual(['Prefers morning calls']);
    const nothing = await execute('recall', { query: 'GPA' }, ctx());
    expect(nothing.summary).toBe('Nothing in memory about that.');
    const id = (await localMemories(user.id))[0]!.id;
    const ask = await execute('forget', { memoryId: id }, ctx());
    expect(ask.kind).toBe('needs_confirmation');
    expect((ask.data as { blockedReason?: string }).blockedReason).toBeUndefined();
    const done = await execute('forget', { memoryId: id }, { ...ctx(), confirmation: ask.confirmationId });
    expect(done.summary).toBe('Deleted 1 memory.');
    expect(await localMemories(user.id)).toEqual([]);
  });
});

describe('after a turn, in this browser', () => {
  it('keeps a statement from the chat, adds its targets to the goals and says so under the reply', async () => {
    const engine = createChatEngine({ registry, execute, user: () => user, store: new ChatStore() });
    const c = await engine.startConversation({ temporary: false });
    const events: TurnEvent[] = [];
    await engine.send(
      c.id,
      "I'm targeting product manager internships at fintech startups in New York",
      (e) => events.push(e),
    );
    await vi.waitFor(async () => expect(await localMemories(user.id)).toHaveLength(1));
    const [m] = await localMemories(user.id);
    expect(m).toMatchObject({
      text: 'Targeting product manager internships at fintech startups in New York',
      source: 'rules',
      sourceTurn: { conversationId: c.id },
    });
    await vi.waitFor(() =>
      expect(
        events
          .filter((e): e is Extract<TurnEvent, { type: 'text' }> => e.type === 'text')
          .map((e) => e.delta)
          .join(''),
      ).toContain('Noted for later: Targeting product manager internships at fintech startups in New York.'),
    );
    expect((await db.goals.get(user.id))?.targetFunctions).toContain('pm');
    // a temporary chat keeps nothing
    const temp = await engine.startConversation({ temporary: true });
    await engine.send(temp.id, 'I prefer morning calls', () => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(await localMemories(user.id)).toHaveLength(1);
  });
});

describe('the snapshot in this browser', () => {
  it('carries the remembered lines closest to the message, and the resume offer', async () => {
    await execute('remember', { text: 'Targeting PM internships in New York', kind: 'goal_detail' }, ctx());
    const snap = await buildSnapshot(user.id, new Date(), {
      lastUserText: 'who should I meet for PM internships?',
    });
    expect(snap.text).toMatch(/Remembered \(ids\): mem_\S+ Targeting PM internships in New York\./);
    const file = new File(
      [
        'Alex Rivera\nalex@cornell.edu\n\nEDUCATION   Cornell University   May 2027\nB.S. Computer Science\n\nEXPERIENCE   Amma Health Inc.   Remote\nSoftware Engineering Intern   Jun 2025 – Aug 2025\n• Built a pipeline\n',
      ],
      'resume.txt',
      { type: 'text/plain' },
    );
    const { proposal } = await saveResume((await db.users.get(user.id))!, file);
    expect(proposal).toEqual({
      school: 'Cornell University',
      degree: 'B.S.',
      majors: ['Computer Science'],
      graduationYear: 2027,
    });
    const after = await buildSnapshot(user.id, new Date(), { lastUserText: 'hi' });
    expect(after.text).toContain(
      'Their resume says school Cornell University, degree B.S., major Computer Science, class of 2027, which their profile does not.',
    );
  });
});
