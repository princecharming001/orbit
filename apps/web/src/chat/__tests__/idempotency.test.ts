import type { User } from '@orbit/core';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/schema';
import { loadDemo } from '../../engine/demo';
import * as factsEngine from '../../engine/facts';
import * as send from '../../engine/send';
import { execute } from '../registry';
import { makeCtx, NOW } from './helpers';

let user: User;
beforeAll(async () => {
  user = await loadDemo({ reset: true, now: NOW });
}, 90_000);

describe('idempotency on the tool_use id', () => {
  it('the same toolUseId run twice executes once and returns the stored envelope', async () => {
    const person = (await db.people.where('userId').equals(user.id).toArray()).find(
      (p) => p.isHuman && !p.hiddenAt,
    )!;
    const spy = vi.spyOn(factsEngine, 'addFact');
    const key = 'toolu_same_key';
    const input = { personId: person.id, action: 'add', type: 'personal', text: 'Grew up in Houston' };
    const first = await execute('manage_fact', input, makeCtx(user, { toolUseId: key }));
    expect(first.kind).toBe('facts');
    const second = await execute('manage_fact', input, makeCtx(user, { toolUseId: key }));
    expect(second).toEqual(first);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    const stored = await db.chatActions.get(key);
    expect(stored?.status).toBe('done');
    expect(stored?.envelope).toEqual(first);
    const facts = await db.facts
      .where('personId')
      .equals(person.id)
      .filter((f) => f.text === 'Grew up in Houston')
      .toArray();
    expect(facts).toHaveLength(1);
  });

  it('two concurrent calls with the same key run the write once; different keys run twice', async () => {
    const person = (await db.people.where('userId').equals(user.id).toArray()).find(
      (p) => p.isHuman && !p.hiddenAt,
    )!;
    const spy = vi.spyOn(factsEngine, 'addFact');
    const input = {
      personId: person.id,
      action: 'add',
      type: 'hook',
      text: 'Runs a newsletter about payments',
    };
    const [a, b] = await Promise.all([
      execute('manage_fact', input, makeCtx(user, { toolUseId: 'toolu_race' })),
      execute('manage_fact', input, makeCtx(user, { toolUseId: 'toolu_race' })),
    ]);
    expect(a).toEqual(b);
    expect(spy).toHaveBeenCalledTimes(1);
    await execute('manage_fact', input, makeCtx(user, { toolUseId: 'toolu_other' }));
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('a retried risky call with the same tool_use id gets the same confirmation back, not a second token', async () => {
    const draft = (
      await db.outbound
        .where('userId')
        .equals(user.id)
        .filter((o) => o.status === 'draft')
        .toArray()
    )[0]!;
    const a = await execute(
      'discard_draft',
      { draftId: draft.id },
      makeCtx(user, { toolUseId: 'toolu_retry' }),
    );
    const b = await execute(
      'discard_draft',
      { draftId: draft.id },
      makeCtx(user, { toolUseId: 'toolu_retry' }),
    );
    expect(a.kind).toBe('needs_confirmation');
    expect(b.confirmationId).toBe(a.confirmationId);
    const pending = await db.chatActions
      .where('conversationId')
      .equals('conv_test')
      .filter((r) => r.toolName === 'discard_draft' && r.status === 'pending')
      .toArray();
    expect(pending).toHaveLength(1);
  });

  it('a send approved twice sends once', async () => {
    const draft = (
      await db.outbound
        .where('userId')
        .equals(user.id)
        .filter((o) => o.status === 'draft' && !!o.suggestionId)
        .toArray()
    )[0]!;
    const spy = vi.spyOn(send, 'approveAndSend');
    const ask = await execute('send_draft', { draftId: draft.id }, makeCtx(user));
    expect(ask.kind).toBe('needs_confirmation');
    const token = ask.confirmationId!;
    const approve = () =>
      execute(
        'send_draft',
        { draftId: draft.id },
        makeCtx(user, {
          confirmation: token,
          toolUseId: token,
          edited: { body: draft.bodyDraft, subject: draft.subject },
        }),
      );
    const [first, second] = await Promise.all([approve(), approve()]);
    expect(first.kind, first.summary).toBe('draft');
    expect(second).toEqual(first);
    const third = await approve();
    expect(third).toEqual(first);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    const after = (await db.outbound.get(draft.id))!;
    // no Google in the tests: the message is handed off, waiting for "I sent it", and the audit trail has one approval
    expect(after.status).toBe('handed_off');
    const audits = await db.audit
      .where('userId')
      .equals(user.id)
      .filter((a) => a.objectId === draft.id && a.action === 'message.handed_off')
      .toArray();
    expect(audits).toHaveLength(1);
    const chatAudits = await db.audit
      .where('userId')
      .equals(user.id)
      .filter((a) => a.action === 'chat.send_draft')
      .toArray();
    expect(chatAudits).toHaveLength(1);
  });

  it('writes in one conversation run one at a time', async () => {
    const person = (await db.people.where('userId').equals(user.id).toArray()).find(
      (p) => p.isHuman && !p.hiddenAt,
    )!;
    let running = 0;
    let overlap = 0;
    const spy = vi
      .spyOn(factsEngine, 'addFact')
      .mockImplementation(async (userId, personId, type, text, now) => {
        running++;
        if (running > 1) overlap++;
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return {
          id: `f_${text}`,
          userId,
          personId,
          type,
          text,
          sourceTable: 'manual',
          sourceId: 'manual',
          confidence: 1,
          createdAt: (now ?? new Date()).toISOString(),
        };
      });
    await Promise.all(
      ['one', 'two', 'three'].map((t, i) =>
        execute(
          'manage_fact',
          { personId: person.id, action: 'add', type: 'hook', text: t },
          makeCtx(user, { toolUseId: `toolu_seq_${i}` }),
        ),
      ),
    );
    expect(overlap).toBe(0);
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });
});
