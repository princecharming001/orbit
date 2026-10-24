import type { Person, User } from '@orbit/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../db/schema';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import { sendLinkedInMessage, setUnipileUrlForTests } from '../integrations/unipile';
import { startWarmUpOrOutreach } from './brief';
import { loadDemo } from './demo';
import { connectLinkedInLive, disconnectLinkedInLive, linkedInSendActive } from './linkedinLive';
import { approveAndSend, sendDueQueued, UNDO_WINDOW_MS } from './send';

let user: User;

beforeAll(async () => {
  user = await loadDemo({ reset: true });
}, 90_000);

afterEach(() => {
  vi.restoreAllMocks();
  setUnipileUrlForTests(undefined);
  setConnectorsMockForTests(undefined);
});

/** Someone on LinkedIn the student has no chat with yet, and a first LinkedIn message drafted for them. */
async function freshLinkedInDraft(connected: boolean) {
  const chats = new Set((await db.chats.where('userId').equals(user.id).toArray()).map((c) => c.personId));
  const drafted = new Set(
    (await db.outbound.where('userId').equals(user.id).toArray()).map((o) => o.personId),
  );
  const person = (await db.people.where('userId').equals(user.id).toArray()).find(
    (p: Person) =>
      !!p.linkedinSlug &&
      !p.hiddenAt &&
      !chats.has(p.id) &&
      !drafted.has(p.id) &&
      !!p.linkedinConnectedOn === connected,
  )!;
  expect(person).toBeDefined();
  const { draft } = await startWarmUpOrOutreach(user, person.id, 'linkedin', 'manual', { skipWarmUp: true });
  expect(draft?.channel).toBe('linkedin');
  return { person, draft: draft! };
}

describe('sending LinkedIn messages from Orbit', () => {
  it('hands off to LinkedIn until LinkedIn is connected live', async () => {
    expect(await linkedInSendActive(user)).toBe(false);
    const { draft } = await freshLinkedInDraft(true);
    const r = await approveAndSend(user, draft.id, draft.bodyDraft);
    expect(r).toMatchObject({ ok: true, status: 'handed_off', via: 'linkedin_compose' });
  });

  it('once connected, queues an approved message behind the undo window, then sends it from the account', async () => {
    const c = await connectLinkedInLive(user);
    expect(c.ok).toBe(true);
    expect(await linkedInSendActive(user)).toBe(true);
    const { draft } = await freshLinkedInDraft(true);
    const now = new Date();
    const r = await approveAndSend(user, draft.id, draft.bodyDraft, undefined, now);
    expect(r).toMatchObject({ ok: true, status: 'queued' });
    // nothing goes out inside the window
    expect(await sendDueQueued(user, new Date(now.getTime() + 1000))).toEqual([]);
    const done = await sendDueQueued(user, new Date(now.getTime() + UNDO_WINDOW_MS + 1000));
    expect(done).toEqual([{ id: draft.id, ok: true }]);
    const sent = await db.outbound.get(draft.id);
    expect(sent).toMatchObject({ status: 'sent', channel: 'linkedin' });
    expect(sent?.providerMessageId).toMatch(/^demo-li-/);
    // connecting runs the sample student's whole LinkedIn sync (83 connections): seconds of work on a busy machine
  }, 20_000);

  it('can still be opened in LinkedIn instead, and goes back to hand-off after a disconnect', async () => {
    const { draft } = await freshLinkedInDraft(true);
    const r = await approveAndSend(user, draft.id, draft.bodyDraft, undefined, new Date(), {
      via: 'handoff',
    });
    expect(r).toMatchObject({ ok: true, status: 'handed_off' });
    await disconnectLinkedInLive(user);
    expect(await linkedInSendActive(user)).toBe(false);
  });
});

describe('the browser side of a LinkedIn send', () => {
  it('carries the account token and maps the answer, a request as invited', async () => {
    setUnipileUrlForTests('https://proxy.test/functions/v1/orbit-connectors');
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ ok: true, invited: true, messageId: 'inv1', memberId: 'ACo1' }));
    }) as unknown as typeof fetch;
    const r = await sendLinkedInMessage('acc_1', { slug: 'dana-lee' }, 'Hi Dana', true, {
      fetch: fake,
      token: 'tok',
    });
    expect(r).toEqual({
      ok: true,
      value: { invited: true, messageId: 'inv1', chatId: undefined, memberId: 'ACo1' },
    });
    expect(calls[0]).toEqual({
      url: 'https://proxy.test/functions/v1/orbit-connectors/send',
      body: { accountId: 'acc_1', token: 'tok', slug: 'dana-lee', text: 'Hi Dana', invite: true },
    });
    const refused = (async () =>
      new Response(
        JSON.stringify({ ok: false, message: 'Recipient cannot be reached' }),
      )) as unknown as typeof fetch;
    expect(
      await sendLinkedInMessage('acc_1', { memberId: 'm' }, 'Hi', false, { fetch: refused }),
    ).toMatchObject({
      ok: false,
      message: 'Recipient cannot be reached',
    });
  });
});
