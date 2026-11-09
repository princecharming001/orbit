import type { Person, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import type { FakeOrbitApi } from '../test/fakeOrbitApi';
import { linkedInSendActive } from './linkedinLive';
import { approveAndSend } from './send';
import { refreshSyncStatus, writeFromServer } from './serverSync';

/**
 * An account's LinkedIn message is sent from Orbit, never copied into LinkedIn by hand: the tap on Send goes to
 * /drafts/approve with `confirm: true`, the server sends it through the LinkedIn the student connected, and what
 * stopped it (a note too long for a connection request) comes back in words.
 */

const DRAFT_ID = '4b2e8a10-6c3d-4f7e-9a21-5d8c0e1f2a33';
let api: FakeOrbitApi;
let user: User;
const BODY =
  'hey Soham, hope the STASIS launch went well. would love to hear how you think about product there. down for 15 min sometime in the next couple weeks?\n\nAnish';

beforeEach(async () => {
  await wipeDatabase();
  const signedIn = await signInToFakeApi();
  api = signedIn.api;
  user = signedIn.user as unknown as User;
  const at = '2026-11-08T12:00:00.000Z';
  await db.people.put({
    id: 'p_soham',
    userId: user.id,
    displayName: 'Soham Chakraborty',
    firstName: 'Soham',
    lastName: 'Chakraborty',
    nameNormalized: 'soham chakraborty',
    emails: [],
    linkedinSlug: 'sohamc',
    linkedinUrl: 'https://www.linkedin.com/in/sohamc',
    linkedinConnectedOn: '2025-01-10',
    tieScore: 50,
    relationshipType: 'unknown',
    strength: 0.5,
    interactionCount: 5,
    sources: ['manual'],
    isHuman: true,
    tags: [],
    createdAt: at,
    updatedAt: at,
  } as Person);
  const draft = {
    id: DRAFT_ID,
    personId: 'p_soham',
    chatId: null,
    goalId: null,
    channel: 'linkedin' as const,
    kind: 'bump' as const,
    subject: null,
    body: BODY,
    status: 'draft' as const,
    sendAt: null,
    sentAt: null,
    validator: { ok: true, issues: [], words: 30, grade: 6 },
    generatedBy: 'llm' as const,
    hooks: [],
    needsInput: [],
    createdAt: at,
    updatedAt: at,
  };
  api.state.drafts.set(DRAFT_ID, { ...draft });
  await writeFromServer('drafts', [{ ...draft }], user.id);
});
afterEach(async () => {
  await leaveFakeApi();
});

describe('an account sends LinkedIn from Orbit', () => {
  it('Send goes to the server with the tap as confirmation, and nothing opens LinkedIn', async () => {
    api.state.linkedin.status = 'active';
    await refreshSyncStatus();
    const person = (await db.people.get('p_soham'))!;
    expect(await linkedInSendActive(user, person, DRAFT_ID)).toBe(true);
    const r = await approveAndSend(user, DRAFT_ID, BODY, undefined);
    expect(r).toMatchObject({ ok: true, status: 'sent' });
    const call = api.calls.find((c) => c.route === '/drafts/approve')!;
    expect(call.body).toMatchObject({ draftId: DRAFT_ID, confirm: true });
    expect((await db.outbound.get(DRAFT_ID))?.status).toBe('sent');
    expect((await db.outbound.get(DRAFT_ID))?.handoffVia).toBeUndefined();
  });

  it('what stopped the send comes back in words', async () => {
    api.state.linkedin.status = 'active';
    api.state.linkedin.sendError = 'linkedin_note_too_long';
    await refreshSyncStatus();
    const r = await approveAndSend(user, DRAFT_ID, BODY, undefined);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/connection request.*300 characters/);
  });

  it('without LinkedIn connected on the server, Orbit does not offer to send it itself', async () => {
    await refreshSyncStatus();
    const person = (await db.people.get('p_soham'))!;
    expect(await linkedInSendActive(user, person, DRAFT_ID)).toBe(false);
  });
});
