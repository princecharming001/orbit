import type { User } from '@orbit/core';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/schema';
import * as account from '../../engine/account';
import { loadDemo } from '../../engine/demo';
import * as facts from '../../engine/facts';
import * as people from '../../engine/people';
import * as send from '../../engine/send';
import { bindingKey, CONFIRMATION_TTL_MS, cancelConfirmation, canonicalJson } from '../confirm';
import { execute, tools } from '../registry';
import { makeCtx, NOW, nextToolUseId } from './helpers';

let user: User;
beforeAll(async () => {
  user = await loadDemo({ reset: true, now: NOW });
}, 90_000);

/** A small deterministic generator, so the property runs are repeatable. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const WORDS = [
  'priya',
  'omar',
  'stripe',
  'thank you',
  'not_now',
  'x',
  '',
  'a b c',
  '🙂',
  '<script>',
  'conf_1',
];

/** Random values that satisfy each primitive shape the tool schemas use. */
function arbitraryFor(schema: Record<string, unknown>, rand: () => number): unknown {
  const t = schema.type;
  if (schema.enum) {
    const e = schema.enum as unknown[];
    return e[Math.floor(rand() * e.length)];
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.anyOf) {
    const opts = schema.anyOf as Record<string, unknown>[];
    return arbitraryFor(opts[Math.floor(rand() * opts.length)]!, rand);
  }
  if (t === 'string')
    return WORDS[Math.floor(rand() * WORDS.length)]!.padEnd(
      (schema.minLength as number | undefined) ?? 0,
      'z',
    );
  if (t === 'integer' || t === 'number') {
    const lo = (schema.minimum as number | undefined) ?? 0;
    const hi = (schema.maximum as number | undefined) ?? lo + 50;
    return Math.floor(lo + rand() * (hi - lo + 1));
  }
  if (t === 'boolean') return rand() < 0.5;
  if (t === 'array')
    return Array.from({ length: Math.floor(rand() * 3) }, () =>
      arbitraryFor(schema.items as Record<string, unknown>, rand),
    );
  if (t === 'object') {
    const out: Record<string, unknown> = {};
    const req = new Set((schema.required as string[] | undefined) ?? []);
    for (const [k, v] of Object.entries((schema.properties as Record<string, Record<string, unknown>>) ?? {}))
      if (req.has(k) || rand() < 0.5) out[k] = arbitraryFor(v, rand);
    return out;
  }
  return undefined;
}

describe('canonical binding', () => {
  it('sorts keys and drops undefined, so the same input always binds to the same text', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined }] })).toBe('{"a":[{"d":2}],"b":1}');
    expect(bindingKey('send_draft', { draftId: 'out_1', body: 'x' })).toBe(
      bindingKey('send_draft', { body: 'y', draftId: 'out_1' }),
    );
    expect(bindingKey('hide_person', { personId: 'p1' })).not.toBe(
      bindingKey('hide_person', { personId: 'p2' }),
    );
  });
});

describe('risky tools never run without a valid token (property style)', () => {
  it('over many random inputs: no token gives needs_confirmation, a bad token gives an error, and no engine call happens', async () => {
    const { z } = await import('zod/v4');
    const spies = [
      vi.spyOn(send, 'approveAndSend'),
      vi.spyOn(send, 'confirmHandoff'),
      vi.spyOn(send, 'undoQueued'),
      vi.spyOn(send, 'dismissSuggestion'),
      vi.spyOn(people, 'mergePeople'),
      vi.spyOn(people, 'hidePerson'),
      vi.spyOn(facts, 'deleteFact'),
      vi.spyOn(account, 'deleteAllData'),
      vi.spyOn(account, 'exportAllData'),
    ];
    const rand = rng(7);
    const risky = tools.filter((t) => t.kind === 'risky');
    let runs = 0;
    for (let round = 0; round < 8; round++) {
      for (const t of risky) {
        const schema = z.toJSONSchema(t.input) as Record<string, unknown>;
        const input = arbitraryFor(schema, rand);
        if (!t.input.safeParse(input).success) continue;
        runs++;
        const base = { conversationId: `conv_${round % 3}` };
        const noToken = await execute(t.name, input, makeCtx(user, { ...base, toolUseId: nextToolUseId() }));
        expect(['needs_confirmation', 'error'], `${t.name} without a token: ${noToken.summary}`).toContain(
          noToken.kind,
        );
        if (noToken.kind === 'needs_confirmation') expect(noToken.confirmationId).toMatch(/^conf_/);
        const garbage = await execute(
          t.name,
          input,
          makeCtx(user, {
            ...base,
            confirmation: `conf_${Math.floor(rand() * 1e9)}`,
            toolUseId: nextToolUseId(),
          }),
        );
        expect(garbage.kind, `${t.name} with a made-up token`).toBe('error');
        if (noToken.confirmationId) {
          // the right token in another conversation
          const elsewhere = await execute(
            t.name,
            input,
            makeCtx(user, {
              conversationId: 'conv_other',
              confirmation: noToken.confirmationId,
              toolUseId: nextToolUseId(),
            }),
          );
          expect(elsewhere.kind).toBe('error');
          expect(elsewhere.summary).toMatch(/another conversation/);
          // the right token for another tool
          const other = risky.find((x) => x.name !== t.name)!;
          const wrongTool = await execute(
            other.name,
            {},
            makeCtx(user, { ...base, confirmation: noToken.confirmationId, toolUseId: nextToolUseId() }),
          );
          expect(wrongTool.kind).toBe('error');
          // the right token with different input (for send_draft: a different draft id)
          const changed = {
            ...(input as Record<string, unknown>),
            [Object.keys(schema.properties as object)[0] ?? 'extra']: 'changed-value-zzz',
          };
          const changedParsed = t.input.safeParse(changed);
          // only a real change counts: an unknown key is stripped by the schema and binds the same
          if (
            Object.keys(schema.properties as object).length &&
            changedParsed.success &&
            bindingKey(t.name, changedParsed.data) !== bindingKey(t.name, t.input.parse(input))
          ) {
            const mismatch = await execute(
              t.name,
              changed,
              makeCtx(user, { ...base, confirmation: noToken.confirmationId, toolUseId: nextToolUseId() }),
            );
            expect(mismatch.kind, `${t.name} with changed input`).toBe('error');
            expect(mismatch.summary).toMatch(/not what is being run now/);
          }
          // an expired token
          const late = makeCtx(user, {
            ...base,
            confirmation: noToken.confirmationId,
            now: new Date(NOW.getTime() + CONFIRMATION_TTL_MS + 1),
            toolUseId: nextToolUseId(),
          });
          const expired = await execute(t.name, input, late);
          expect(expired.kind, `${t.name} expired`).toBe('error');
          expect(expired.summary).toMatch(/expired/);
          // and once expired it stays refused even within the window
          const again = await execute(
            t.name,
            input,
            makeCtx(user, { ...base, confirmation: noToken.confirmationId, toolUseId: nextToolUseId() }),
          );
          expect(again.kind).toBe('error');
        }
      }
    }
    expect(runs).toBeGreaterThan(50);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    for (const s of spies) s.mockRestore();
  }, 120_000);

  it('a token is single use: the second presentation returns the stored result and the engine runs once', async () => {
    const uid = user.id;
    const fact = (
      await db.facts
        .where('userId')
        .equals(uid)
        .filter((f) => !f.deletedAt)
        .toArray()
    )[0]!;
    const spy = vi.spyOn(facts, 'deleteFact');
    const ask = await execute('delete_fact', { factId: fact.id }, makeCtx(user));
    expect(ask.kind).toBe('needs_confirmation');
    const token = ask.confirmationId!;
    const first = await execute(
      'delete_fact',
      { factId: fact.id },
      makeCtx(user, { confirmation: token, toolUseId: token }),
    );
    expect(first.kind).toBe('facts');
    const second = await execute(
      'delete_fact',
      { factId: fact.id },
      makeCtx(user, { confirmation: token, toolUseId: token }),
    );
    expect(second).toEqual(first);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    const row = await db.chatActions.get(token);
    expect(row?.status).toBe('done');
    expect((await db.facts.get(fact.id))?.deletedAt).toBeTruthy();
  });

  it('a cancelled token is refused, and a blocked send says the engine reason on the card', async () => {
    const uid = user.id;
    const target = (await db.targetCompanies.where('userId').equals(uid).toArray())[0]!;
    const ask = await execute('delete_target_company', { targetId: target.id }, makeCtx(user));
    expect(ask.kind).toBe('needs_confirmation');
    expect(await cancelConfirmation(ask.confirmationId!, NOW)).toBe(true);
    const r = await execute(
      'delete_target_company',
      { targetId: target.id },
      makeCtx(user, { confirmation: ask.confirmationId }),
    );
    expect(r.kind).toBe('error');
    expect(r.summary).toMatch(/cancelled/);
    expect(await db.targetCompanies.get(target.id)).toBeTruthy();
    // a send to a hidden person is blocked up front, with checkSendAllowed's own words
    const draft = (
      await db.outbound
        .where('userId')
        .equals(uid)
        .filter((o) => o.status === 'draft')
        .toArray()
    )[0]!;
    await db.people.update(draft.personId, { hiddenAt: NOW.toISOString() });
    const blocked = await execute('send_draft', { draftId: draft.id }, makeCtx(user));
    expect(blocked.kind).toBe('needs_confirmation');
    expect((blocked.data as { blockedReason?: string }).blockedReason).toBe('This person is hidden.');
    await db.people.update(draft.personId, { hiddenAt: undefined });
  });
});
