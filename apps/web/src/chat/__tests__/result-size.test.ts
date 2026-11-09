/**
 * How much of a tool result the model reads (plan 35 A3): the person view keeps the latest messages short, a note
 * is read to 1,200 characters, a network search hands over ten rows (the card shows them all), the inbox fifteen.
 * Offline, on the demo account.
 */
import type { EmailMessage, User } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db/schema';
import { loadDemo } from '../../engine/demo';
import { clearPrefs } from '../../integrations/prefs';
import { execute, registry } from '../registry';
import { INBOX_ROWS } from '../tools/inbox';
import { NOTE_CHARS, PERSON_MESSAGE_CHARS, PERSON_MESSAGES, PERSON_TIMELINE } from '../tools/read';
import { forModel, SEARCH_MODEL_ROWS } from '../tools/search';
import { makeCtx, NOW } from './helpers';

let user: User;
// the bare text, so lengths are the tool's own caps and not the wrapper's
const ctx = () => makeCtx(user, { caller: 'llm', wrap: (_source, text) => text });

beforeAll(async () => {
  await clearPrefs();
  user = await loadDemo({ reset: true, now: NOW });
}, 60_000);

describe('tool results stay small (plan 35 A3)', () => {
  it('keeps the caps where the plan sets them', () => {
    expect([PERSON_MESSAGES, PERSON_MESSAGE_CHARS, PERSON_TIMELINE]).toEqual([6, 400, 15]);
    expect(NOTE_CHARS).toBe(1_200);
    expect(INBOX_ROWS).toBe(15);
    expect(SEARCH_MODEL_ROWS).toBe(10);
  });

  it('get_person: at most six messages of at most 400 characters, and fifteen timeline rows', async () => {
    // a demo person with an email thread, given nine more long messages so every cap is reached
    const threads = await db.threads.where('userId').equals(user.id).toArray();
    let target: string | undefined;
    let first: EmailMessage | undefined;
    for (const t of threads) {
      const m = (await db.messages.where('threadId').equals(t.id).toArray()).find(
        (x) => x.direction === 'inbound' && x.fromPersonId && t.participantPersonIds.includes(x.fromPersonId),
      );
      if (m && t.channel !== 'linkedin') {
        target = m.fromPersonId!;
        first = m;
        break;
      }
    }
    expect(target).toBeDefined();
    for (let i = 0; i < 9; i++)
      await db.messages.add({
        ...first!,
        id: `msg_size_${i}`,
        externalMessageId: `ext_size_${i}`,
        bodyText: 'x'.repeat(2_000),
        isAutomated: false,
        sentAt: new Date(NOW.getTime() - (i + 1) * 3_600_000).toISOString(),
      });
    const people = await db.people.where('userId').equals(user.id).toArray();
    const busiest = [
      target!,
      ...people
        .map((p) => p.id)
        .filter((id) => id !== target)
        .slice(0, 7),
    ];
    let sawConversation = 0;
    for (const id of busiest) {
      const env = await execute(
        'get_person',
        { personId: id, include: ['conversation', 'timeline', 'facts'] },
        ctx(),
      );
      // what the model reads: the tool's projection of the envelope
      const data = registry.get('get_person')!.toModel!(env.data as never) as {
        conversation?: { text?: string }[];
        timeline?: unknown[];
      };
      expect(data.conversation?.length ?? 0).toBeLessThanOrEqual(PERSON_MESSAGES);
      expect(data.timeline?.length ?? 0).toBeLessThanOrEqual(PERSON_TIMELINE);
      for (const m of data.conversation ?? [])
        expect((m.text ?? '').length).toBeLessThanOrEqual(PERSON_MESSAGE_CHARS + 1);
      sawConversation = Math.max(sawConversation, data.conversation?.length ?? 0);
    }
    expect(sawConversation).toBe(PERSON_MESSAGES);
  });

  it('list_notes: one note is read to 1,200 characters', async () => {
    const any = await db.notes.where('userId').equals(user.id).first();
    expect(any).toBeDefined();
    await db.notes.put({ ...any!, id: 'note_size', rawText: 'y'.repeat(5_000) });
    const env = await execute('list_notes', { noteId: 'note_size' }, ctx());
    const text = JSON.stringify(env.data);
    expect(text).toContain('y'.repeat(NOTE_CHARS));
    expect(text).not.toContain('y'.repeat(NOTE_CHARS + 1));
  });

  it('search_network: the model reads ten rows and how many the card shows', () => {
    const row = (i: number) => ({
      person: {
        id: `p_${i}`,
        displayName: `Person ${i}`,
        currentTitle: 'PM',
        currentOrganizationRaw: 'Acme',
      },
      band: 'strong',
      evidence: [],
      missing: [],
      warmth: 'warm',
      lastTalk: undefined,
    });
    const d = {
      setId: 'set_1',
      counts: { strong: 25, likely: 0, unknown: 0 },
      notes: [],
      unknownBy: [],
      remaining: 0,
      rows: Array.from({ length: 25 }, (_, i) => row(i)),
    } as unknown as Parameters<typeof forModel>[0];
    const out = forModel(d);
    expect(out.rows).toHaveLength(SEARCH_MODEL_ROWS);
    expect(out.shownToStudent).toBe(25);
  });
});
