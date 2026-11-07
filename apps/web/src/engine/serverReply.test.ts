import type { Person, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { GMAIL_SEND_SCOPE } from '../integrations/google';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import type { FakeOrbitApi } from '../test/fakeOrbitApi';
import { approveAndSend, draftEnvelope, reviewDraft } from './send';
import { refreshSyncStatus, writeFromServer } from './serverSync';

/**
 * A reply the server holds for an account goes from the server into the thread it answers, under that thread's
 * subject. The server's copy reaches this browser without a subject or a thread id, and the thread itself may not
 * have synced yet: the browser still asks for no subject, shows no subject field, and approving it goes to the server
 * rather than stopping at "Add a subject line".
 */

const DRAFT_ID = '3c9e2b71-4a0d-4f6e-9b2c-7e5d1a0f8c43';
let api: FakeOrbitApi;
let user: User;

beforeEach(async () => {
  await wipeDatabase();
  const signedIn = await signInToFakeApi();
  api = signedIn.api;
  user = signedIn.user as unknown as User;
  const at = '2026-10-06T12:00:00.000Z';
  await db.people.put({
    id: 'p_dan',
    userId: user.id,
    displayName: 'Daniel Okafor',
    firstName: 'Daniel',
    lastName: 'Okafor',
    nameNormalized: 'daniel okafor',
    emails: ['dan@example.com'],
    primaryEmail: 'dan@example.com',
    tieScore: 60,
    relationshipType: 'unknown',
    strength: 0.6,
    interactionCount: 1,
    sources: ['manual'],
    isHuman: true,
    tags: [],
    createdAt: at,
    updatedAt: at,
  } as Person);
  const draft = {
    id: DRAFT_ID,
    personId: 'p_dan',
    chatId: null,
    goalId: null,
    channel: 'gmail' as const,
    kind: 'reply' as const,
    subject: null,
    body: 'Hi Daniel,\n\nThanks for getting back to me. Yes, I applied on Monday.\n\nBest,\nMaya',
    status: 'draft' as const,
    sendAt: null,
    sentAt: null,
    validator: { ok: true, issues: [], words: 14, grade: 7 },
    generatedBy: 'template' as const,
    hooks: [],
    needsInput: [],
    createdAt: at,
    updatedAt: at,
  };
  api.state.drafts.set(DRAFT_ID, { ...draft });
  await writeFromServer('drafts', [draft], user.id);
});
afterEach(async () => {
  await leaveFakeApi();
});

describe('a reply the server holds, before its thread has synced here', () => {
  it('asks for no subject and shows no subject field', async () => {
    const local = (await db.outbound.get(DRAFT_ID))!;
    expect(local.externalThreadId).toBeFalsy();
    expect(await db.threads.count()).toBe(0);
    const issues = await reviewDraft(user, local, local.bodyDraft, undefined);
    expect(issues.map((i) => i.code)).not.toContain('no_subject');
    expect(await draftEnvelope(local)).toMatchObject({ threaded: true });
  });

  it('is approved on the server, which threads it, rather than stopping at Add a subject line', async () => {
    api.state.status.google.scopes = [GMAIL_SEND_SCOPE];
    await refreshSyncStatus();
    const local = (await db.outbound.get(DRAFT_ID))!;
    const r = await approveAndSend(user, DRAFT_ID, local.bodyDraft, undefined);
    expect(r).toMatchObject({ ok: true, status: 'scheduled' });
    expect(api.routes()).toContain('/drafts/approve');
  });
});
